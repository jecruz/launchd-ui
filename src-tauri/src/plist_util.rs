use crate::error::AppError;
use crate::types::{CalendarInterval, JobSource, LaunchControlMetadata, PlistConfig};
use plist::Value;
use std::collections::HashMap;
use std::io::Cursor;
#[cfg(test)]
use std::io::Write;
#[cfg(test)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;

pub fn get_user_agents_dir() -> PathBuf {
    dirs::home_dir()
        .expect("could not find home directory")
        .join("Library/LaunchAgents")
}

fn plist_dirs() -> Vec<(PathBuf, JobSource)> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push((home.join("Library/LaunchAgents"), JobSource::UserAgent));
    }
    let system_agents = PathBuf::from("/Library/LaunchAgents");
    if system_agents.exists() {
        dirs.push((system_agents, JobSource::SystemAgent));
    }
    let system_daemons = PathBuf::from("/Library/LaunchDaemons");
    if system_daemons.exists() {
        dirs.push((system_daemons, JobSource::SystemDaemon));
    }
    dirs
}

pub fn scan_plist_files() -> Vec<(String, JobSource)> {
    let mut results = Vec::new();
    for (dir, source) in plist_dirs() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("plist") {
                    if let Some(path_str) = path.to_str() {
                        results.push((path_str.to_string(), source.clone()));
                    }
                }
            }
        }
    }
    results
}

fn extract_string(dict: &plist::Dictionary, key: &str) -> Option<String> {
    dict.get(key).and_then(|v| v.as_string()).map(String::from)
}

fn extract_bool(dict: &plist::Dictionary, key: &str) -> Option<bool> {
    dict.get(key).and_then(|v| v.as_boolean())
}

fn extract_u64(dict: &plist::Dictionary, key: &str) -> Option<u64> {
    dict.get(key).and_then(|v| v.as_unsigned_integer())
}

fn extract_string_array(dict: &plist::Dictionary, key: &str) -> Option<Vec<String>> {
    dict.get(key).and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_string().map(String::from))
            .collect()
    })
}

fn extract_calendar_intervals(dict: &plist::Dictionary) -> Option<Vec<CalendarInterval>> {
    let value = dict.get("StartCalendarInterval")?;

    let parse_interval = |d: &plist::Dictionary| CalendarInterval {
        minute: d
            .get("Minute")
            .and_then(|v| v.as_unsigned_integer())
            .and_then(|v| u32::try_from(v).ok()),
        hour: d
            .get("Hour")
            .and_then(|v| v.as_unsigned_integer())
            .and_then(|v| u32::try_from(v).ok()),
        day: d
            .get("Day")
            .and_then(|v| v.as_unsigned_integer())
            .and_then(|v| u32::try_from(v).ok()),
        weekday: d
            .get("Weekday")
            .and_then(|v| v.as_unsigned_integer())
            .and_then(|v| u32::try_from(v).ok()),
        month: d
            .get("Month")
            .and_then(|v| v.as_unsigned_integer())
            .and_then(|v| u32::try_from(v).ok()),
    };

    match value {
        Value::Dictionary(d) => Some(vec![parse_interval(d)]),
        Value::Array(arr) => {
            let intervals: Vec<CalendarInterval> = arr
                .iter()
                .filter_map(|v| v.as_dictionary().map(parse_interval))
                .collect();
            if intervals.is_empty() {
                None
            } else {
                Some(intervals)
            }
        }
        _ => None,
    }
}

fn extract_env_vars(dict: &plist::Dictionary) -> Option<HashMap<String, String>> {
    dict.get("EnvironmentVariables")
        .and_then(|v| v.as_dictionary())
        .map(|d| {
            d.iter()
                .filter_map(|(k, v)| v.as_string().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
}

fn extract_u16_array(dict: &plist::Dictionary, key: &str) -> Vec<u16> {
    dict.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    v.as_unsigned_integer()
                        .and_then(|n| u16::try_from(n).ok().filter(|port| *port > 0))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn extract_launch_control_metadata(dict: &plist::Dictionary) -> LaunchControlMetadata {
    let Some(metadata) = dict.get("LaunchControl").and_then(|v| v.as_dictionary()) else {
        return LaunchControlMetadata::default();
    };

    LaunchControlMetadata {
        group: extract_string(metadata, "Group"),
        tags: extract_string_array(metadata, "Tags").unwrap_or_default(),
        managed_by: extract_string(metadata, "ManagedBy"),
        description: extract_string(metadata, "Description"),
        environment: extract_string(metadata, "Environment"),
        health_check_url: extract_string(metadata, "HealthCheckURL"),
        health_check_command: extract_string(metadata, "HealthCheckCommand"),
        ports: extract_u16_array(metadata, "Ports"),
        template: extract_string(metadata, "Template"),
        migration_hint: extract_string(metadata, "MigrationHint"),
        health_status: extract_string(metadata, "HealthStatus"),
        health_detail: extract_string(metadata, "HealthDetail"),
        last_health_check_at: extract_string(metadata, "LastHealthCheckAt"),
    }
}

/// Parse an on-disk plist using the same explicit-label contract as IPC edits.
pub fn parse_plist(path: &str) -> Result<PlistConfig, AppError> {
    parse_plist_bytes(&std::fs::read(path)?)
}

/// Parse a bounded caller-owned plist buffer without reopening its filesystem path.
pub fn parse_plist_bytes(bytes: &[u8]) -> Result<PlistConfig, AppError> {
    validate_raw_schedule(bytes)?;
    let value = Value::from_reader(Cursor::new(bytes))
        .map_err(|e| AppError::Plist(format!("invalid plist: {e}")))?;
    let dict = value
        .as_dictionary()
        .ok_or_else(|| AppError::Plist("plist is not a dictionary".into()))?;

    let label = extract_string(dict, "Label")
        .ok_or_else(|| AppError::Plist("plist requires an explicit Label".into()))?;
    let mut raw_xml = Vec::new();
    value
        .to_writer_xml(&mut raw_xml)
        .map_err(|e| AppError::Plist(format!("invalid plist: {e}")))?;
    let raw_xml = std::str::from_utf8(bytes)
        .ok()
        .filter(|_| !bytes.starts_with(b"bplist"))
        .map(str::to_owned)
        .unwrap_or_else(|| String::from_utf8_lossy(&raw_xml).into_owned());

    Ok(PlistConfig {
        label,
        program: extract_string(dict, "Program"),
        program_arguments: extract_string_array(dict, "ProgramArguments"),
        run_at_load: extract_bool(dict, "RunAtLoad"),
        keep_alive: extract_bool(dict, "KeepAlive"),
        start_interval: extract_u64(dict, "StartInterval"),
        start_calendar_interval: extract_calendar_intervals(dict),
        standard_out_path: extract_string(dict, "StandardOutPath"),
        standard_error_path: extract_string(dict, "StandardErrorPath"),
        working_directory: extract_string(dict, "WorkingDirectory"),
        environment_variables: extract_env_vars(dict),
        disabled: extract_bool(dict, "Disabled"),
        wake_system: extract_bool(dict, "WakeSystem"),
        metadata: extract_launch_control_metadata(dict),
        raw_xml,
    })
}

fn calendar_valid(interval: &CalendarInterval) -> bool {
    [
        interval.minute,
        interval.hour,
        interval.day,
        interval.weekday,
        interval.month,
    ]
    .iter()
    .any(Option::is_some)
        && interval.minute.is_none_or(|v| v <= 59)
        && interval.hour.is_none_or(|v| v <= 23)
        && interval.day.is_none_or(|v| (1..=31).contains(&v))
        && interval.weekday.is_none_or(|v| v <= 7)
        && interval.month.is_none_or(|v| (1..=12).contains(&v))
}

/// Validate launchd schedule domains and nonzero TCP ports before any mutation.
pub fn validate_config(config: &PlistConfig) -> Result<(), AppError> {
    if config
        .start_interval
        .is_some_and(|v| v == 0 || v > i64::MAX as u64)
        || config
            .start_calendar_interval
            .as_ref()
            .is_some_and(|values| {
                values.is_empty() || values.iter().any(|value| !calendar_valid(value))
            })
        || config.metadata.ports.contains(&0)
    {
        return Err(AppError::Plist(
            "Schedule values or ports are outside their supported integer domains.".into(),
        ));
    }
    Ok(())
}

/// Validate raw schedule types before lossy extraction can hide malformed values.
pub fn validate_raw_schedule(bytes: &[u8]) -> Result<(), AppError> {
    let value = Value::from_reader(Cursor::new(bytes))
        .map_err(|_| AppError::Plist("Invalid raw plist.".into()))?;
    let dictionary = value
        .as_dictionary()
        .ok_or_else(|| AppError::Plist("Invalid raw plist.".into()))?;
    let invalid = || AppError::Plist("Invalid launchd schedule integer or domain.".into());
    if let Some(metadata) = dictionary.get("LaunchControl") {
        let metadata = metadata.as_dictionary().ok_or_else(invalid)?;
        if let Some(ports) = metadata.get("Ports") {
            for port in ports.as_array().ok_or_else(invalid)? {
                if !port
                    .as_unsigned_integer()
                    .is_some_and(|port| (1..=65535).contains(&port))
                {
                    return Err(invalid());
                }
            }
        }
    }
    if let Some(value) = dictionary.get("StartInterval") {
        if !value
            .as_unsigned_integer()
            .is_some_and(|v| v > 0 && v <= i64::MAX as u64)
        {
            return Err(invalid());
        }
    }
    if let Some(value) = dictionary.get("StartCalendarInterval") {
        let values = match value {
            Value::Array(values) => values.iter().collect::<Vec<_>>(),
            Value::Dictionary(_) => vec![value],
            _ => return Err(invalid()),
        };
        if values.is_empty() {
            return Err(invalid());
        }
        for value in values {
            let value = value.as_dictionary().ok_or_else(invalid)?;
            if value.is_empty()
                || value.keys().any(|key| {
                    !["Minute", "Hour", "Day", "Weekday", "Month"].contains(&key.as_str())
                })
            {
                return Err(invalid());
            }
            for (key, minimum, maximum) in [
                ("Minute", 0, 59),
                ("Hour", 0, 23),
                ("Day", 1, 31),
                ("Weekday", 0, 7),
                ("Month", 1, 12),
            ] {
                if let Some(value) = value.get(key) {
                    if !value
                        .as_unsigned_integer()
                        .is_some_and(|v| v >= minimum && v <= maximum)
                    {
                        return Err(invalid());
                    }
                }
            }
        }
    }
    Ok(())
}

/// Serialize a launchd configuration before creating or replacing any file.
pub fn serialize_plist(config: &PlistConfig) -> Result<Vec<u8>, AppError> {
    let mut dict = plist::Dictionary::new();

    dict.insert("Label".to_string(), Value::String(config.label.clone()));

    if let Some(ref program) = config.program {
        dict.insert("Program".to_string(), Value::String(program.clone()));
    }

    if let Some(ref args) = config.program_arguments {
        dict.insert(
            "ProgramArguments".to_string(),
            Value::Array(args.iter().map(|a| Value::String(a.clone())).collect()),
        );
    }

    if let Some(run_at_load) = config.run_at_load {
        dict.insert("RunAtLoad".to_string(), Value::Boolean(run_at_load));
    }

    if let Some(keep_alive) = config.keep_alive {
        dict.insert("KeepAlive".to_string(), Value::Boolean(keep_alive));
    }

    if let Some(interval) = config.start_interval {
        dict.insert("StartInterval".to_string(), Value::Integer(interval.into()));
    }

    if let Some(ref intervals) = config.start_calendar_interval {
        let arr: Vec<Value> = intervals
            .iter()
            .map(|ci| {
                let mut d = plist::Dictionary::new();
                if let Some(minute) = ci.minute {
                    d.insert("Minute".to_string(), Value::Integer((minute as u64).into()));
                }
                if let Some(hour) = ci.hour {
                    d.insert("Hour".to_string(), Value::Integer((hour as u64).into()));
                }
                if let Some(day) = ci.day {
                    d.insert("Day".to_string(), Value::Integer((day as u64).into()));
                }
                if let Some(weekday) = ci.weekday {
                    d.insert(
                        "Weekday".to_string(),
                        Value::Integer((weekday as u64).into()),
                    );
                }
                if let Some(month) = ci.month {
                    d.insert("Month".to_string(), Value::Integer((month as u64).into()));
                }
                Value::Dictionary(d)
            })
            .collect();
        dict.insert("StartCalendarInterval".to_string(), Value::Array(arr));
    }

    if let Some(ref path_val) = config.standard_out_path {
        dict.insert(
            "StandardOutPath".to_string(),
            Value::String(path_val.clone()),
        );
    }

    if let Some(ref path_val) = config.standard_error_path {
        dict.insert(
            "StandardErrorPath".to_string(),
            Value::String(path_val.clone()),
        );
    }

    if let Some(ref wd) = config.working_directory {
        dict.insert("WorkingDirectory".to_string(), Value::String(wd.clone()));
    }

    if let Some(ref env) = config.environment_variables {
        let mut d = plist::Dictionary::new();
        for (k, v) in env {
            d.insert(k.clone(), Value::String(v.clone()));
        }
        dict.insert("EnvironmentVariables".to_string(), Value::Dictionary(d));
    }

    if let Some(disabled) = config.disabled {
        dict.insert("Disabled".to_string(), Value::Boolean(disabled));
    }

    if let Some(wake_system) = config.wake_system {
        dict.insert("WakeSystem".to_string(), Value::Boolean(wake_system));
    }

    if config.metadata.group.is_some()
        || !config.metadata.tags.is_empty()
        || config.metadata.managed_by.is_some()
        || config.metadata.description.is_some()
        || config.metadata.environment.is_some()
        || config.metadata.health_check_url.is_some()
        || config.metadata.health_check_command.is_some()
        || !config.metadata.ports.is_empty()
        || config.metadata.template.is_some()
        || config.metadata.migration_hint.is_some()
        || config.metadata.health_status.is_some()
        || config.metadata.health_detail.is_some()
        || config.metadata.last_health_check_at.is_some()
    {
        let mut metadata = plist::Dictionary::new();
        if let Some(group) = config.metadata.group.as_ref() {
            metadata.insert("Group".to_string(), Value::String(group.clone()));
        }
        if !config.metadata.tags.is_empty() {
            metadata.insert(
                "Tags".to_string(),
                Value::Array(
                    config
                        .metadata
                        .tags
                        .iter()
                        .map(|tag| Value::String(tag.clone()))
                        .collect(),
                ),
            );
        }
        if let Some(managed_by) = config.metadata.managed_by.as_ref() {
            metadata.insert("ManagedBy".to_string(), Value::String(managed_by.clone()));
        }
        if let Some(description) = config.metadata.description.as_ref() {
            metadata.insert(
                "Description".to_string(),
                Value::String(description.clone()),
            );
        }
        if let Some(environment) = config.metadata.environment.as_ref() {
            metadata.insert(
                "Environment".to_string(),
                Value::String(environment.clone()),
            );
        }
        if let Some(url) = config.metadata.health_check_url.as_ref() {
            metadata.insert("HealthCheckURL".to_string(), Value::String(url.clone()));
        }
        if let Some(command) = config.metadata.health_check_command.as_ref() {
            metadata.insert(
                "HealthCheckCommand".to_string(),
                Value::String(command.clone()),
            );
        }
        if !config.metadata.ports.is_empty() {
            metadata.insert(
                "Ports".to_string(),
                Value::Array(
                    config
                        .metadata
                        .ports
                        .iter()
                        .map(|port| Value::Integer((*port as u64).into()))
                        .collect(),
                ),
            );
        }
        if let Some(template) = config.metadata.template.as_ref() {
            metadata.insert("Template".to_string(), Value::String(template.clone()));
        }
        if let Some(migration_hint) = config.metadata.migration_hint.as_ref() {
            metadata.insert(
                "MigrationHint".to_string(),
                Value::String(migration_hint.clone()),
            );
        }
        if let Some(health_status) = config.metadata.health_status.as_ref() {
            metadata.insert(
                "HealthStatus".to_string(),
                Value::String(health_status.clone()),
            );
        }
        if let Some(health_detail) = config.metadata.health_detail.as_ref() {
            metadata.insert(
                "HealthDetail".to_string(),
                Value::String(health_detail.clone()),
            );
        }
        if let Some(last_health_check_at) = config.metadata.last_health_check_at.as_ref() {
            metadata.insert(
                "LastHealthCheckAt".to_string(),
                Value::String(last_health_check_at.clone()),
            );
        }
        dict.insert("LaunchControl".to_string(), Value::Dictionary(metadata));
    }

    let value = Value::Dictionary(dict);
    let mut bytes = Vec::new();
    value
        .to_writer_xml(&mut bytes)
        .map_err(|e| AppError::Plist(format!("failed to serialize plist: {e}")))?;
    Ok(bytes)
}

/// Write a validated plist configuration to its destination.
#[cfg(test)]
pub fn write_plist(path: &str, config: &PlistConfig) -> Result<(), AppError> {
    write_existing_plist(path, &serialize_plist(config)?)?;
    Ok(())
}

#[cfg(test)]
fn write_existing_plist(path: &str, bytes: &[u8]) -> Result<(), AppError> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(AppError::Plist(
            "Only regular, non-linked plists may be replaced.".into(),
        ));
    }
    file.set_len(0)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
pub fn write_raw_plist(path: &str, xml: &str) -> Result<(), AppError> {
    // Validate by parsing
    Value::from_reader(Cursor::new(xml.as_bytes()))
        .map_err(|e| AppError::Plist(format!("invalid plist XML: {e}")))?;
    write_existing_plist(path, xml.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(test)]
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn create_temp_plist(xml: &str) -> NamedTempFile {
        let mut file = NamedTempFile::with_suffix(".plist").unwrap();
        file.write_all(xml.as_bytes()).unwrap();
        file.flush().unwrap();
        file
    }

    #[test]
    fn rejects_empty_unknown_and_misspelled_calendar_fields() {
        for value in [
            "<dict/>",
            "<array/>",
            "<dict><key>Minut</key><integer>5</integer></dict>",
            "<dict><key>Minute</key><integer>5</integer><key>Other</key><integer>1</integer></dict>",
        ] {
            let xml = format!(
                "<plist><dict><key>Label</key><string>safe</string><key>StartCalendarInterval</key>{value}</dict></plist>"
            );
            assert!(parse_plist_bytes(xml.as_bytes()).is_err());
        }
    }

    #[test]
    fn rejects_malformed_schedule_values_before_a_round_trip_and_preserves_xml() {
        for value in [
            "<integer>-1</integer>",
            "<integer>4294967296</integer>",
            "<integer>60</integer>",
            "<real>1.5</real>",
            "<string>5</string>",
        ] {
            let xml = format!(
                "<plist><dict><key>Label</key><string>safe</string><key>StartCalendarInterval</key><dict><key>Minute</key>{value}</dict></dict></plist>"
            );
            assert!(parse_plist_bytes(xml.as_bytes()).is_err());
        }
        let xml = "<plist><!-- preserve this comment --><dict><key>Label</key><string>safe</string><key>StartCalendarInterval</key><dict><key>Minute</key><integer>5</integer></dict></dict></plist>";
        let parsed = parse_plist_bytes(xml.as_bytes()).unwrap();
        assert_eq!(parsed.raw_xml, xml);
        let again = parse_plist_bytes(&serialize_plist(&parsed).unwrap()).unwrap();
        assert_eq!(again.start_calendar_interval.unwrap()[0].minute, Some(5));
    }

    #[test]
    fn validates_schedule_domains_and_preserves_result_only_metadata() {
        let config: PlistConfig = serde_json::from_value(serde_json::json!({"label": "safe", "raw_xml": "", "metadata": {"health_status": "healthy", "health_detail": "HTTP 200", "last_health_check_at": "123"}})).unwrap();
        let parsed = parse_plist_bytes(&serialize_plist(&config).unwrap()).unwrap();
        assert_eq!(parsed.metadata, config.metadata);
        for (key, value) in [
            ("Minute", "<integer>99</integer>"),
            ("Hour", "<real>1.5</real>"),
            ("Day", "<integer>0</integer>"),
            ("Weekday", "<integer>9</integer>"),
            ("Month", "<integer>13</integer>"),
        ] {
            let xml = format!(
                "<plist><dict><key>StartCalendarInterval</key><dict><key>{key}</key>{value}</dict></dict></plist>"
            );
            assert!(validate_raw_schedule(xml.as_bytes()).is_err());
        }
        let xml = b"<plist><dict><key>Label</key><string>safe</string><key>LaunchControl</key><dict><key>Ports</key><array><integer>65536</integer><integer>0</integer><integer>65535</integer></array></dict></dict></plist>";
        assert!(validate_raw_schedule(xml).is_err());
        for port in [
            "<integer>0</integer>",
            "<integer>65536</integer>",
            "<integer>-1</integer>",
            "<string>80</string>",
            "<real>80.5</real>",
        ] {
            let xml = format!(
                "<plist><dict><key>LaunchControl</key><dict><key>Ports</key><array>{port}</array></dict></dict></plist>"
            );
            assert!(validate_raw_schedule(xml.as_bytes()).is_err());
        }
    }

    #[test]
    fn test_parse_simple_plist() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.example.test</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/true</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>"#;
        let file = create_temp_plist(xml);
        let config = parse_plist(file.path().to_str().unwrap()).unwrap();
        assert_eq!(config.label, "com.example.test");
        assert_eq!(
            config.program_arguments,
            Some(vec!["/usr/bin/true".to_string()])
        );
        assert_eq!(config.run_at_load, Some(true));
        assert_eq!(config.keep_alive, None);
    }

    #[test]
    fn test_parse_plist_with_calendar_interval() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.example.cron</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/true</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>
</dict>
</plist>"#;
        let file = create_temp_plist(xml);
        let config = parse_plist(file.path().to_str().unwrap()).unwrap();
        let intervals = config.start_calendar_interval.unwrap();
        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].hour, Some(3));
        assert_eq!(intervals[0].minute, Some(30));
    }

    #[test]
    fn test_write_and_read_plist() {
        let config = PlistConfig {
            label: "com.example.roundtrip".to_string(),
            program: Some("/usr/bin/echo".to_string()),
            program_arguments: Some(vec!["/usr/bin/echo".to_string(), "hello".to_string()]),
            run_at_load: Some(true),
            keep_alive: Some(false),
            start_interval: Some(300),
            start_calendar_interval: None,
            standard_out_path: Some("/tmp/test.log".to_string()),
            standard_error_path: None,
            working_directory: Some("/tmp".to_string()),
            environment_variables: Some(HashMap::from([("FOO".to_string(), "bar".to_string())])),
            disabled: None,
            wake_system: None,
            metadata: LaunchControlMetadata {
                group: Some("CAISS System".to_string()),
                tags: vec!["caiss".to_string(), "roundtrip".to_string()],
                managed_by: Some("Daemonic".to_string()),
                description: Some("Roundtrip test service".to_string()),
                environment: Some("test".to_string()),
                health_check_url: Some("http://127.0.0.1:8001/health".to_string()),
                health_check_command: Some("curl -fsS http://127.0.0.1:8001/health".to_string()),
                ports: vec![8001, 8002],
                template: Some("api".to_string()),
                migration_hint: Some("docker-compose".to_string()),
                health_status: Some("healthy".to_string()),
                health_detail: Some("ok".to_string()),
                last_health_check_at: Some("1710000000000".to_string()),
            },
            raw_xml: String::new(),
        };

        let file = NamedTempFile::with_suffix(".plist").unwrap();
        let path = file.path().to_str().unwrap();

        write_plist(path, &config).unwrap();
        let parsed = parse_plist(path).unwrap();

        assert_eq!(parsed.label, "com.example.roundtrip");
        assert_eq!(parsed.program, Some("/usr/bin/echo".to_string()));
        assert_eq!(parsed.run_at_load, Some(true));
        assert_eq!(parsed.keep_alive, Some(false));
        assert_eq!(parsed.start_interval, Some(300));
        assert_eq!(parsed.standard_out_path, Some("/tmp/test.log".to_string()));
        assert_eq!(parsed.working_directory, Some("/tmp".to_string()));
        assert_eq!(parsed.metadata.group, Some("CAISS System".to_string()));
        assert_eq!(
            parsed.metadata.tags,
            vec!["caiss".to_string(), "roundtrip".to_string()]
        );
        assert_eq!(parsed.metadata.ports, vec![8001, 8002]);
        assert_eq!(
            parsed.environment_variables,
            Some(HashMap::from([("FOO".to_string(), "bar".to_string())]))
        );
    }

    #[test]
    fn test_write_plist_with_health_metadata_only() {
        let config = PlistConfig {
            label: "com.example.health".to_string(),
            program: Some("/usr/bin/echo".to_string()),
            program_arguments: Some(vec!["/usr/bin/echo".to_string(), "health".to_string()]),
            run_at_load: Some(true),
            keep_alive: Some(false),
            start_interval: None,
            start_calendar_interval: None,
            standard_out_path: None,
            standard_error_path: None,
            working_directory: None,
            environment_variables: None,
            disabled: None,
            wake_system: None,
            metadata: LaunchControlMetadata {
                group: None,
                tags: Vec::new(),
                managed_by: None,
                description: None,
                environment: None,
                health_check_url: Some("http://127.0.0.1:3002/".to_string()),
                health_check_command: None,
                ports: vec![3002],
                template: Some("web".to_string()),
                migration_hint: Some("docker-compose".to_string()),
                health_status: None,
                health_detail: None,
                last_health_check_at: None,
            },
            raw_xml: String::new(),
        };

        let file = NamedTempFile::with_suffix(".plist").unwrap();
        let path = file.path().to_str().unwrap();

        write_plist(path, &config).unwrap();
        let parsed = parse_plist(path).unwrap();

        assert_eq!(
            parsed.metadata.health_check_url,
            Some("http://127.0.0.1:3002/".to_string())
        );
        assert_eq!(parsed.metadata.ports, vec![3002]);
        assert_eq!(parsed.metadata.template, Some("web".to_string()));
        assert_eq!(
            parsed.metadata.migration_hint,
            Some("docker-compose".to_string())
        );
    }

    #[test]
    fn test_write_raw_plist_valid() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.example.raw</string>
</dict>
</plist>"#;
        let file = NamedTempFile::with_suffix(".plist").unwrap();
        let path = file.path().to_str().unwrap();
        write_raw_plist(path, xml).unwrap();
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.contains("com.example.raw"));
    }

    #[test]
    fn test_write_raw_plist_invalid() {
        let invalid = "this is not valid plist xml";
        let file = NamedTempFile::with_suffix(".plist").unwrap();
        let path = file.path().to_str().unwrap();
        let result = write_raw_plist(path, invalid);
        assert!(result.is_err());
    }
}
