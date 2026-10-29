use crate::error::AppError;
use std::process::Command;

fn get_uid() -> u32 {
    // Use the process UID directly; action targets must not depend on PATH lookup.
    unsafe { libc::getuid() }
}

pub(crate) fn gui_target() -> String {
    format!("gui/{}", get_uid())
}

pub(crate) fn service_target(label: &str) -> String {
    format!("{}/{}", gui_target(), label)
}

#[derive(Debug)]
pub struct LoadedService {
    pub label: String,
    pub pid: Option<u32>,
    pub last_exit_code: Option<i32>,
}

pub fn parse_list_output(output: &str) -> Vec<LoadedService> {
    let mut services = Vec::new();
    for line in output.lines().skip(1) {
        // skip header
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let pid = parts[0].trim().parse::<u32>().ok();
        let exit_code = parts[1].trim().parse::<i32>().ok();
        let label = parts[2].trim().to_string();
        if label.is_empty() {
            continue;
        }
        services.push(LoadedService {
            label,
            pid,
            last_exit_code: exit_code,
        });
    }
    services
}

pub fn list_loaded() -> Result<Vec<LoadedService>, AppError> {
    #[cfg(test)]
    if crate::test_support::paths().is_some() {
        return Ok(Vec::new());
    }
    let output = Command::new("/bin/launchctl")
        .arg("list")
        .output()
        .map_err(|e| AppError::Launchctl(format!("failed to run launchctl list: {e}")))?;

    if !output.status.success() {
        return Err(AppError::Launchctl(format!(
            "launchctl list failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_list_output(&stdout))
}

pub fn bootstrap(plist_path: &str) -> Result<(), AppError> {
    let output = Command::new("/bin/launchctl")
        .args(["bootstrap", &gui_target(), plist_path])
        .output()
        .map_err(|e| AppError::Launchctl(format!("failed to run launchctl bootstrap: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        // "service already loaded" is not a fatal error
        if stderr.contains("already loaded") || stderr.contains("service already loaded") {
            return Ok(());
        }
        let hint = if stderr.contains("Input/output error") {
            " Try re-running the command as root for richer errors."
        } else {
            ""
        };
        return Err(AppError::Launchctl(format!(
            "Bootstrap failed for {plist_path}: {stderr}{hint}"
        )));
    }
    Ok(())
}

pub fn bootout(plist_path: &str) -> Result<(), AppError> {
    let output = Command::new("/bin/launchctl")
        .args(["bootout", &gui_target(), plist_path])
        .output()
        .map_err(|e| AppError::Launchctl(format!("failed to run launchctl bootout: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "not loaded" is not a fatal error
        if stderr.contains("not loaded")
            || stderr.contains("No such process")
            || stderr.contains("Could not find specified service")
        {
            return Ok(());
        }
        return Err(AppError::Launchctl(format!(
            "launchctl bootout failed: {stderr}"
        )));
    }
    Ok(())
}

/// Start a loaded service without terminating an already-running instance.
pub fn start_loaded(label: &str) -> Result<(), AppError> {
    let output = Command::new("/bin/launchctl")
        .args(["kickstart", &service_target(label)])
        .output()
        .map_err(|e| AppError::Launchctl(format!("failed to start loaded service: {e}")))?;
    if !output.status.success() {
        return Err(AppError::Launchctl(format!(
            "failed to start loaded service: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}

pub fn kickstart(label: &str) -> Result<(), AppError> {
    let output = Command::new("/bin/launchctl")
        .args(["kickstart", "-k", &service_target(label)])
        .output()
        .map_err(|e| AppError::Launchctl(format!("failed to run launchctl kickstart: {e}")))?;

    if !output.status.success() {
        return Err(AppError::Launchctl(format!(
            "launchctl kickstart failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}

pub fn enable(label: &str) -> Result<(), AppError> {
    let output = Command::new("/bin/launchctl")
        .args(["enable", &service_target(label)])
        .output()
        .map_err(|e| AppError::Launchctl(format!("failed to run launchctl enable: {e}")))?;

    if !output.status.success() {
        return Err(AppError::Launchctl(format!(
            "launchctl enable failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}

pub fn disable(label: &str) -> Result<(), AppError> {
    let output = Command::new("/bin/launchctl")
        .args(["disable", &service_target(label)])
        .output()
        .map_err(|e| AppError::Launchctl(format!("failed to run launchctl disable: {e}")))?;

    if !output.status.success() {
        return Err(AppError::Launchctl(format!(
            "launchctl disable failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_list_output_basic() {
        let output = "PID\tStatus\tLabel\n\
                       1234\t0\tcom.example.running\n\
                       -\t78\tcom.example.stopped\n";
        let result = parse_list_output(output);
        assert_eq!(result.len(), 2);

        assert_eq!(result[0].label, "com.example.running");
        assert_eq!(result[0].pid, Some(1234));
        assert_eq!(result[0].last_exit_code, Some(0));

        assert_eq!(result[1].label, "com.example.stopped");
        assert_eq!(result[1].pid, None);
        assert_eq!(result[1].last_exit_code, Some(78));
    }

    #[test]
    fn test_parse_list_output_empty() {
        let output = "PID\tStatus\tLabel\n";
        let result = parse_list_output(output);
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_parse_list_output_malformed_lines() {
        let output = "PID\tStatus\tLabel\n\
                       bad line\n\
                       1234\t0\tcom.example.test\n";
        let result = parse_list_output(output);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].label, "com.example.test");
    }
}
