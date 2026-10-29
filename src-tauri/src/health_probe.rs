use crate::error::AppError;
use reqwest::{Url, blocking::Client, redirect::Policy};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

const MAX_RESPONSE_BYTES: u64 = 64 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

fn validated_url(value: &str) -> Result<Url, AppError> {
    let reject = || {
        AppError::AgentRuntime(
            "Health probes require a credential-free HTTP(S) loopback URL without a fragment."
                .into(),
        )
    };
    if value.len() > 4096 {
        return Err(reject());
    }
    let url = Url::parse(value).map_err(|_| reject())?;
    let host = url.host_str().ok_or_else(reject)?;
    let loopback = host == "localhost"
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !matches!(url.scheme(), "http" | "https")
        || !loopback
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() == Some(0)
    {
        return Err(reject());
    }
    Ok(url)
}

fn probe_with_limits(
    value: &str,
    timeout: Duration,
    limit: u64,
) -> Result<(bool, String), AppError> {
    let url = validated_url(value)?;
    // Pin localhost rather than trusting DNS, hosts-file entries, or proxy settings.
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(timeout)
        .connect_timeout(timeout.min(Duration::from_secs(2)))
        .resolve(
            "localhost",
            SocketAddr::new(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                url.port_or_known_default().unwrap_or(80),
            ),
        )
        .build()
        .map_err(|_| AppError::AgentRuntime("Could not initialize health probe client.".into()))?;
    let response = match client.get(url).send() {
        Ok(response) => response,
        Err(_) => {
            return Ok((
                false,
                "Health probe failed or exceeded its deadline.".into(),
            ));
        }
    };
    let status = response.status();
    if response.content_length().is_some_and(|size| size > limit) {
        return Ok((false, "Health response exceeds the size limit.".into()));
    }
    let mut body = Vec::new();
    if response.take(limit + 1).read_to_end(&mut body).is_err() {
        return Ok((
            false,
            "Health response failed or exceeded its deadline.".into(),
        ));
    }
    if body.len() as u64 > limit {
        return Ok((false, "Health response exceeds the size limit.".into()));
    }
    // Health bodies can contain credentials; persist only the HTTP result.
    Ok((
        status.is_success(),
        format!("Health probe returned HTTP {status}."),
    ))
}

/// Probe an HTTP(S) loopback endpoint without redirects, proxies, or unbounded output.
pub fn probe_before(value: &str, deadline: Instant) -> Result<(bool, String), AppError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Ok((false, "Health check exceeded its deadline.".into()));
    }
    probe_with_limits(value, remaining.min(PROBE_TIMEOUT), MAX_RESPONSE_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    fn probe(value: &str) -> Result<(bool, String), AppError> {
        probe_before(value, Instant::now() + PROBE_TIMEOUT)
    }

    fn serve(response: Vec<u8>, delay: Duration) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/health", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut request = [0; 1024];
            let _ = stream.read(&mut request);
            std::thread::sleep(delay);
            let _ = stream.write_all(&response);
        });
        (url, handle)
    }

    #[test]
    fn rejects_options_schemes_credentials_and_nonlocal_destinations() {
        for value in [
            "--config=/tmp/probe",
            "file:///etc/passwd",
            "ftp://127.0.0.1/file",
            "http://example.com/",
            "http://192.168.1.1/",
            "http://169.254.169.254/",
            "http://127.0.0.1.evil.example/",
            "http://127.0.0.1@evil.example/",
            "http://127.0.0.1:0/",
            "http://127.0.0.1/#fragment",
        ] {
            assert!(validated_url(value).is_err(), "accepted {value}");
        }
        let mut credentials = Url::parse("http://127.0.0.1/").unwrap();
        credentials.set_username("user").unwrap();
        credentials.set_password(Some("test-password")).unwrap();
        assert!(validated_url(credentials.as_str()).is_err());
        for value in [
            "http://localhost/health",
            "https://127.0.0.1/",
            "http://[::1]/",
        ] {
            assert!(validated_url(value).is_ok());
        }
    }

    #[test]
    fn successful_probe_does_not_persist_the_response_body() {
        let (url, server) = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\nprivate-body".to_vec(),
            Duration::ZERO,
        );
        let (healthy, detail) = probe(&url).unwrap();
        server.join().unwrap();
        assert!(healthy);
        assert!(!detail.contains("private-body"));
    }

    #[test]
    fn rejects_redirect_without_contacting_the_destination() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: http://{}/\r\nContent-Length: 0\r\n\r\n",
            destination.local_addr().unwrap()
        );
        let (url, server) = serve(response.into_bytes(), Duration::ZERO);
        assert!(!probe(&url).unwrap().0);
        server.join().unwrap();
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn bounds_known_and_streamed_response_sizes() {
        for headers in ["Content-Length: 100\r\n", "Connection: close\r\n"] {
            let response = format!("HTTP/1.1 200 OK\r\n{headers}\r\n{}", "x".repeat(100));
            let (url, server) = serve(response.into_bytes(), Duration::ZERO);
            let result = probe_with_limits(&url, Duration::from_secs(1), 16).unwrap();
            server.join().unwrap();
            assert!(!result.0);
            assert!(result.1.contains("size limit"));
        }
    }

    #[test]
    fn bounds_response_time() {
        let (url, server) = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec(),
            Duration::from_millis(150),
        );
        let start = std::time::Instant::now();
        assert!(
            !probe_with_limits(&url, Duration::from_millis(40), 16)
                .unwrap()
                .0
        );
        assert!(start.elapsed() < Duration::from_secs(1));
        server.join().unwrap();
    }
}
