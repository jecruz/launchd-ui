use crate::error::AppError;
use crate::types::{CalendarInterval, JobSource, LaunchControlMetadata, PlistConfig};
use plist::Value;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};

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
            .map(|v| v as u32),
        hour: d
            .get("Hour")
            .and_then(|v| v.as_unsigned_integer())
            .map(|v| v as u32),
        day: d
            .get("Day")
            .and_then(|v| v.as_unsigned_integer())
            .map(|v| v as u32),
        weekday: d
            .get("Weekday")
            .and_then(|v| v.as_unsigned_integer())
            .map(|v| v as u32),
        month: d
            .get("Month")
            .and_then(|v| v.as_unsigned_integer())
            .map(|v| v as u32),
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
                .filter_map(|v| v.as_unsigned_integer().map(|n| n as u16))
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

pub fn parse_plist(path: &str) -> Result<PlistConfig, AppError> {
    let value = Value::from_file(path).map_err(|e| AppError::Plist(format!("{path}: {e}")))?;
    let dict = value
        .as_dictionary()
        .ok_or_else(|| AppError::Plist(format!("{path}: not a dictionary")))?;

    let label = extract_string(dict, "Label").unwrap_or_else(|| {
        Path::new(path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    let raw_xml = read_raw_plist(path).unwrap_or_default();

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

pub fn read_raw_plist(path: &str) -> Result<String, AppError> {
    // Try to read as XML first, fall back to converting binary plist
    let data = std::fs::read(path)?;

    // Check if it's already XML
    if data.starts_with(b"<?xml") || data.starts_with(b"<") {
        return Ok(String::from_utf8_lossy(&data).to_string());
    }

    // Binary plist: parse and re-serialize to XML
    let value = Value::from_reader(Cursor::new(&data))
        .map_err(|e| AppError::Plist(format!("failed to parse plist: {e}")))?;
    let mut buf = Vec::new();
    value
        .to_writer_xml(&mut buf)
        .map_err(|e| AppError::Plist(format!("failed to serialize plist to XML: {e}")))?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

pub fn write_plist(path: &str, config: &PlistConfig) -> Result<(), AppError> {
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
    value
        .to_file_xml(path)
        .map_err(|e| AppError::Plist(format!("failed to write plist: {e}")))?;

    Ok(())
}

pub fn write_raw_plist(path: &str, xml: &str) -> Result<(), AppError> {
    // Validate by parsing
    Value::from_reader(Cursor::new(xml.as_bytes()))
        .map_err(|e| AppError::Plist(format!("invalid plist XML: {e}")))?;
    std::fs::write(path, xml)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn create_temp_plist(xml: &str) -> NamedTempFile {
        let mut file = NamedTempFile::with_suffix(".plist").unwrap();
        file.write_all(xml.as_bytes()).unwrap();
        file.flush().unwrap();
        file
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
