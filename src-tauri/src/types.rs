use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum JobSource {
    UserAgent,
    SystemAgent,
    SystemDaemon,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum JobStatus {
    Running,
    Loaded,
    Unloaded,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobListEntry {
    pub label: String,
    pub pid: Option<u32>,
    pub last_exit_code: Option<i32>,
    pub plist_path: String,
    pub source: JobSource,
    pub status: JobStatus,
    pub last_run_at: Option<String>,
    pub metadata: LaunchControlMetadata,
    pub log_paths: LogPaths,
    /// Presentation heuristic for the Home filter; never a mutation authority.
    pub is_home_agent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CalendarInterval {
    pub minute: Option<u32>,
    pub hour: Option<u32>,
    pub day: Option<u32>,
    pub weekday: Option<u32>,
    pub month: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlistConfig {
    pub label: String,
    pub program: Option<String>,
    pub program_arguments: Option<Vec<String>>,
    pub run_at_load: Option<bool>,
    pub keep_alive: Option<bool>,
    pub start_interval: Option<u64>,
    pub start_calendar_interval: Option<Vec<CalendarInterval>>,
    pub standard_out_path: Option<String>,
    pub standard_error_path: Option<String>,
    pub working_directory: Option<String>,
    pub environment_variables: Option<HashMap<String, String>>,
    pub disabled: Option<bool>,
    pub wake_system: Option<bool>,
    #[serde(default)]
    pub metadata: LaunchControlMetadata,
    pub raw_xml: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct LaunchControlMetadata {
    pub group: Option<String>,
    pub tags: Vec<String>,
    pub managed_by: Option<String>,
    pub description: Option<String>,
    pub environment: Option<String>,
    pub health_check_url: Option<String>,
    pub health_check_command: Option<String>,
    pub ports: Vec<u16>,
    pub template: Option<String>,
    pub migration_hint: Option<String>,
    pub health_status: Option<String>,
    pub health_detail: Option<String>,
    pub last_health_check_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct LogPaths {
    pub stdout: Option<String>,
    pub stderr: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchdJob {
    pub label: String,
    pub plist_path: String,
    pub source: JobSource,
    pub status: JobStatus,
    pub pid: Option<u32>,
    pub last_exit_code: Option<i32>,
    pub plist: PlistConfig,
    pub last_run_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServiceRepairSuggestion {
    pub title: String,
    pub detail: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServiceDiagnosis {
    pub summary: String,
    pub likely_causes: Vec<String>,
    pub suggestions: Vec<ServiceRepairSuggestion>,
    pub stderr_excerpt: Option<String>,
    pub stdout_excerpt: Option<String>,
    pub health_status: Option<String>,
    pub health_detail: Option<String>,
    pub suggested_metadata: Option<LaunchControlMetadata>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_job_source_serialization() {
        let source = JobSource::UserAgent;
        let json = serde_json::to_string(&source).unwrap();
        assert_eq!(json, "\"UserAgent\"");

        let deserialized: JobSource = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, JobSource::UserAgent);
    }

    #[test]
    fn test_job_status_serialization() {
        let status = JobStatus::Running;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"Running\"");
    }

    #[test]
    fn test_job_list_entry_roundtrip() {
        let entry = JobListEntry {
            label: "com.example.test".to_string(),
            pid: Some(1234),
            last_exit_code: Some(0),
            plist_path: "/Users/test/Library/LaunchAgents/com.example.test.plist".to_string(),
            source: JobSource::UserAgent,
            status: JobStatus::Running,
            last_run_at: None,
            metadata: LaunchControlMetadata::default(),
            log_paths: LogPaths::default(),
            is_home_agent: false,
        };
        let json = serde_json::to_string(&entry).unwrap();
        let deserialized: JobListEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.label, "com.example.test");
        assert_eq!(deserialized.pid, Some(1234));
    }
}
