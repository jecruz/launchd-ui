use crate::error::AppError;
use crate::types::LaunchControlMetadata;
use std::collections::HashMap;
use std::path::PathBuf;

const APP_DIR_NAME: &str = "Daemonic";
const LEGACY_APP_DIR_NAME: &str = "launchd-ui";
const SERVICE_OVERRIDES_FILE_NAME: &str = "service-overrides.json";

fn app_settings_dir() -> Result<PathBuf, AppError> {
    let dir = dirs::config_dir()
        .ok_or_else(|| AppError::AgentRuntime("could not determine config directory".to_string()))?
        .join(APP_DIR_NAME);
    Ok(dir)
}

fn legacy_app_settings_dir() -> Result<PathBuf, AppError> {
    let dir = dirs::config_dir()
        .ok_or_else(|| AppError::AgentRuntime("could not determine config directory".to_string()))?
        .join(LEGACY_APP_DIR_NAME);
    Ok(dir)
}

fn overrides_file() -> Result<PathBuf, AppError> {
    Ok(app_settings_dir()?.join(SERVICE_OVERRIDES_FILE_NAME))
}

fn legacy_overrides_file() -> Result<PathBuf, AppError> {
    Ok(legacy_app_settings_dir()?.join(SERVICE_OVERRIDES_FILE_NAME))
}

pub fn load_service_overrides() -> Result<HashMap<String, LaunchControlMetadata>, AppError> {
    let primary = overrides_file()?;
    let legacy = legacy_overrides_file()?;
    match std::fs::read_to_string(&primary) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|e| AppError::AgentRuntime(format!("failed to parse {primary:?}: {e}"))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::read_to_string(&legacy) {
                Ok(contents) => serde_json::from_str(&contents).map_err(|e| {
                    AppError::AgentRuntime(format!("failed to parse {legacy:?}: {e}"))
                }),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
                Err(err) => Err(AppError::AgentRuntime(format!(
                    "failed to read {legacy:?}: {err}"
                ))),
            }
        }
        Err(err) => Err(AppError::AgentRuntime(format!(
            "failed to read {primary:?}: {err}"
        ))),
    }
}

pub fn save_service_overrides(
    overrides: &HashMap<String, LaunchControlMetadata>,
) -> Result<(), AppError> {
    let path = overrides_file()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::AgentRuntime(format!(
                "failed to create overrides directory {parent:?}: {e}"
            ))
        })?;
    }
    let json = serde_json::to_string_pretty(overrides)
        .map_err(|e| AppError::AgentRuntime(format!("failed to serialize overrides: {e}")))?;
    std::fs::write(&path, json)
        .map_err(|e| AppError::AgentRuntime(format!("failed to write {path:?}: {e}")))
}

pub fn upsert_service_override(
    plist_path: &str,
    metadata: &LaunchControlMetadata,
) -> Result<(), AppError> {
    let mut overrides = load_service_overrides()?;
    overrides.insert(plist_path.to_string(), metadata.clone());
    save_service_overrides(&overrides)
}

pub fn remove_service_override(plist_path: &str) -> Result<(), AppError> {
    let mut overrides = load_service_overrides()?;
    if overrides.remove(plist_path).is_some() {
        save_service_overrides(&overrides)?;
    }
    Ok(())
}

fn merge_option<T: Clone>(base: Option<T>, overlay: Option<T>) -> Option<T> {
    overlay.or(base)
}

pub fn merge_metadata(
    base: &LaunchControlMetadata,
    overlay: Option<&LaunchControlMetadata>,
) -> LaunchControlMetadata {
    let Some(overlay) = overlay else {
        return base.clone();
    };

    let tags = if overlay.tags.is_empty() {
        base.tags.clone()
    } else {
        overlay.tags.clone()
    };
    let ports = if overlay.ports.is_empty() {
        base.ports.clone()
    } else {
        overlay.ports.clone()
    };

    LaunchControlMetadata {
        group: merge_option(base.group.clone(), overlay.group.clone()),
        tags,
        managed_by: merge_option(base.managed_by.clone(), overlay.managed_by.clone()),
        description: merge_option(base.description.clone(), overlay.description.clone()),
        environment: merge_option(base.environment.clone(), overlay.environment.clone()),
        health_check_url: merge_option(
            base.health_check_url.clone(),
            overlay.health_check_url.clone(),
        ),
        health_check_command: merge_option(
            base.health_check_command.clone(),
            overlay.health_check_command.clone(),
        ),
        ports,
        template: merge_option(base.template.clone(), overlay.template.clone()),
        migration_hint: merge_option(base.migration_hint.clone(), overlay.migration_hint.clone()),
        health_status: merge_option(base.health_status.clone(), overlay.health_status.clone()),
        health_detail: merge_option(base.health_detail.clone(), overlay.health_detail.clone()),
        last_health_check_at: merge_option(
            base.last_health_check_at.clone(),
            overlay.last_health_check_at.clone(),
        ),
    }
}

pub fn merge_metadata_by_path(
    plist_path: &str,
    base: &LaunchControlMetadata,
) -> Result<LaunchControlMetadata, AppError> {
    let overrides = load_service_overrides()?;
    Ok(merge_metadata(base, overrides.get(plist_path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_metadata_prefers_overlay_fields() {
        let base = LaunchControlMetadata {
            group: Some("Base Group".to_string()),
            tags: vec!["base".to_string()],
            managed_by: Some("base".to_string()),
            description: Some("base".to_string()),
            environment: Some("base".to_string()),
            health_check_url: Some("http://127.0.0.1:1111/health".to_string()),
            health_check_command: Some("echo base".to_string()),
            ports: vec![1111],
            template: Some("base".to_string()),
            migration_hint: Some("base".to_string()),
            health_status: Some("healthy".to_string()),
            health_detail: Some("base".to_string()),
            last_health_check_at: Some("1".to_string()),
        };
        let overlay = LaunchControlMetadata {
            group: Some("CAISS System".to_string()),
            tags: vec!["caiss".to_string(), "api".to_string()],
            managed_by: None,
            description: None,
            environment: Some("local".to_string()),
            health_check_url: Some("http://127.0.0.1:8001/health".to_string()),
            health_check_command: None,
            ports: vec![8001],
            template: Some("api".to_string()),
            migration_hint: Some("docker-compose".to_string()),
            health_status: Some("unhealthy".to_string()),
            health_detail: Some("connection refused".to_string()),
            last_health_check_at: Some("2".to_string()),
        };

        let merged = merge_metadata(&base, Some(&overlay));

        assert_eq!(merged.group, Some("CAISS System".to_string()));
        assert_eq!(merged.tags, vec!["caiss".to_string(), "api".to_string()]);
        assert_eq!(merged.managed_by, Some("base".to_string()));
        assert_eq!(merged.environment, Some("local".to_string()));
        assert_eq!(merged.ports, vec![8001]);
        assert_eq!(merged.health_status, Some("unhealthy".to_string()));
        assert_eq!(merged.last_health_check_at, Some("2".to_string()));
    }
}
