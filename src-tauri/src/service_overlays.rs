use crate::error::AppError;
use crate::types::LaunchControlMetadata;
use crate::{plist_util, state_io, user_agent};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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

fn legacy_overrides_file() -> Result<PathBuf, AppError> {
    Ok(legacy_app_settings_dir()?.join(SERVICE_OVERRIDES_FILE_NAME))
}

/// Complete records support explicit clears; old records retain inheritance semantics.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ServiceOverride {
    #[serde(default)]
    pub complete: bool,
    #[serde(flatten)]
    pub metadata: LaunchControlMetadata,
}

type Overrides = HashMap<String, ServiceOverride>;
const JOURNAL: &str = "pending-plist-transaction.json";

#[derive(Serialize, Deserialize)]
struct Journal {
    path: String,
    label: String,
    #[serde(with = "snapshot")]
    before: Option<Vec<u8>>,
    #[serde(with = "snapshot")]
    after: Option<Vec<u8>>,
    overrides: Overrides,
}

// Compact binary-safe snapshots avoid JSON byte-array expansion at the plist limit.
mod snapshot {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    /// Serialize an optional binary plist as compact base64.
    pub fn serialize<S: Serializer>(
        value: &Option<Vec<u8>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        value
            .as_ref()
            .map(|bytes| STANDARD.encode(bytes))
            .serialize(serializer)
    }
    /// Decode a journal snapshot without interpreting its plist format.
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Vec<u8>>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|text| STANDARD.decode(text).map_err(serde::de::Error::custom))
            .transpose()
    }
}

fn load_at(directory: &Path, legacy: Option<&Path>) -> Result<Overrides, AppError> {
    if let Some(value) = state_io::read(&directory.join(SERVICE_OVERRIDES_FILE_NAME))? {
        return Ok(value);
    }
    match legacy {
        Some(path) => Ok(state_io::read(path)?.unwrap_or_default()),
        None => Ok(HashMap::new()),
    }
}

fn validate_target(root: &Path, path: &str, label: &str) -> Result<(), AppError> {
    user_agent::validate_label(label)?;
    let name = format!("{label}.plist");
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if Path::new(path) != root.join(&name) && Path::new(path) != canonical.join(&name) {
        return Err(AppError::Plist(
            "Transaction target does not match its user-agent label.".into(),
        ));
    }
    Ok(())
}

fn remove_journal(directory: &Path) -> Result<(), AppError> {
    std::fs::remove_file(directory.join(JOURNAL))?;
    std::fs::File::open(directory)?.sync_all()?;
    Ok(())
}

fn recover_at(root: &Path, directory: &Path) -> Result<(), AppError> {
    let Some(journal): Option<Journal> = state_io::read(&directory.join(JOURNAL))? else {
        return Ok(());
    };
    validate_target(root, &journal.path, &journal.label)?;
    for bytes in [&journal.before, &journal.after].into_iter().flatten() {
        if plist_util::parse_plist_bytes(bytes)?.label != journal.label {
            return Err(AppError::Plist("Invalid transaction label.".into()));
        }
    }
    match std::fs::symlink_metadata(&journal.path) {
        Ok(_) => {
            let current =
                user_agent::load_in(root, Path::new(&journal.path), Some(&journal.label))?;
            let bytes = current.original_bytes()?;
            if Some(&bytes) != journal.before.as_ref() && Some(&bytes) != journal.after.as_ref() {
                return Err(AppError::Plist("Pending transaction conflicts with an external edit; recovery requires operator review.".into()));
            }
            match journal.before.as_ref() {
                Some(before) if *before != bytes => current.write(before)?,
                None => current.remove()?,
                _ => {}
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(before) = journal.before.as_ref() {
                user_agent::create_in(root, &journal.label, before)?;
            }
        }
        Err(error) => return Err(error.into()),
    }
    state_io::write(
        &directory.join(SERVICE_OVERRIDES_FILE_NAME),
        &journal.overrides,
    )?;
    remove_journal(directory)
}

struct Change<'a> {
    path: &'a str,
    label: &'a str,
    after: Option<&'a [u8]>,
    metadata: Option<&'a LaunchControlMetadata>,
    create: bool,
    expected: Option<&'a user_agent::CheckedAgent>,
}

fn transact_at(
    root: &Path,
    directory: &Path,
    legacy: Option<&Path>,
    change: Change<'_>,
    persist: impl FnOnce(&Path, &Overrides) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let Change {
        path,
        label,
        after,
        metadata,
        create,
        expected,
    } = change;
    validate_target(root, path, label)?;
    state_io::locked(directory, || {
        recover_at(root, directory)?;
        if let Some(expected) = expected {
            if expected.path() != path || expected.config.label != label {
                return Err(AppError::Plist("Transaction identity mismatch.".into()));
            }
            expected.ensure_current()?;
        }
        let observed = if create {
            None
        } else {
            Some(user_agent::load_in(root, Path::new(path), Some(label))?)
        };
        let current = expected.or(observed.as_ref());
        let before = if create {
            match std::fs::symlink_metadata(path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
                Ok(_) => return Err(AppError::Plist("A job already exists at this path.".into())),
            }
        } else {
            Some(
                current
                    .ok_or_else(|| AppError::Plist("Missing original identity.".into()))?
                    .original_bytes()?,
            )
        };
        if let Some(after) = after {
            if plist_util::parse_plist_bytes(after)?.label != label {
                return Err(AppError::Plist(
                    "Replacement label must match its target.".into(),
                ));
            }
        }
        let overrides = load_at(directory, legacy)?;
        let journal = Journal {
            path: path.into(),
            label: label.into(),
            before,
            after: after.map(Vec::from),
            overrides: overrides.clone(),
        };
        state_io::write(&directory.join(JOURNAL), &journal)?;
        let result = (|| {
            match after {
                Some(bytes) if create => {
                    user_agent::create_in(root, label, bytes)?;
                }
                Some(bytes) => current
                    .ok_or_else(|| AppError::Plist("Missing original identity.".into()))?
                    .write(bytes)?,
                None => current
                    .ok_or_else(|| AppError::Plist("Missing original identity.".into()))?
                    .remove()?,
            }
            let mut updated = overrides;
            match metadata {
                Some(metadata) => {
                    updated.insert(
                        path.into(),
                        ServiceOverride {
                            complete: true,
                            metadata: metadata.clone(),
                        },
                    );
                }
                None => {
                    updated.remove(path);
                }
            }
            persist(&directory.join(SERVICE_OVERRIDES_FILE_NAME), &updated)?;
            remove_journal(directory)
        })();
        if let Err(error) = result {
            if recover_at(root, directory).is_err() {
                return Err(AppError::Plist("Update failed and recovery remains pending; further writes are blocked until recovery succeeds.".into()));
            }
            return Err(error);
        }
        Ok(())
    })
}

/// Recover interrupted file/overlay updates before displaying or modifying jobs.
pub fn recover_pending() -> Result<(), AppError> {
    let directory = app_settings_dir()?;
    state_io::locked(&directory, || {
        recover_at(&plist_util::get_user_agents_dir(), &directory)
    })
}

/// Atomically publish a plist and recover its paired overlay on failure or restart.
pub fn transact_plist(
    path: &str,
    label: &str,
    after: Option<&[u8]>,
    metadata: Option<&LaunchControlMetadata>,
    create: bool,
    expected: Option<&user_agent::CheckedAgent>,
) -> Result<(), AppError> {
    transact_at(
        &plist_util::get_user_agents_dir(),
        &app_settings_dir()?,
        Some(&legacy_overrides_file()?),
        Change {
            path,
            label,
            after,
            metadata,
            create,
            expected,
        },
        state_io::write,
    )
}

/// Load metadata snapshots after recovering any interrupted transaction.
pub fn load_service_overrides() -> Result<Overrides, AppError> {
    let directory = app_settings_dir()?;
    state_io::locked(&directory, || {
        recover_at(&plist_util::get_user_agents_dir(), &directory)?;
        load_at(&directory, Some(&legacy_overrides_file()?))
    })
}

/// Update only probe result fields while retaining any concurrently edited metadata.
pub fn record_health(
    path: &str,
    status: &str,
    detail: &str,
    checked_at: &str,
) -> Result<(), AppError> {
    let directory = app_settings_dir()?;
    state_io::locked(&directory, || {
        recover_at(&plist_util::get_user_agents_dir(), &directory)?;
        let mut overrides = load_at(&directory, Some(&legacy_overrides_file()?))?;
        let _ = plist_util::parse_plist(path)?;
        let updated = health_observation(overrides.get(path), status, detail, checked_at);
        overrides.insert(path.into(), updated);
        state_io::write(&directory.join(SERVICE_OVERRIDES_FILE_NAME), &overrides)
    })
}

fn health_observation(
    existing: Option<&ServiceOverride>,
    status: &str,
    detail: &str,
    checked_at: &str,
) -> ServiceOverride {
    let mut updated = existing.cloned().unwrap_or_default();
    updated.metadata.health_status = Some(status.into());
    updated.metadata.health_detail = Some(detail.into());
    updated.metadata.last_health_check_at = Some(checked_at.into());
    updated
}

fn merge_option<T: Clone>(base: Option<T>, overlay: Option<T>) -> Option<T> {
    overlay.or(base)
}

/// Merge legacy partial records while honoring explicit clears in new snapshots.
pub fn merge_metadata(
    base: &LaunchControlMetadata,
    overlay: Option<&ServiceOverride>,
) -> LaunchControlMetadata {
    let Some(overlay) = overlay else {
        return base.clone();
    };

    if overlay.complete {
        return overlay.metadata.clone();
    }
    let overlay = &overlay.metadata;

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

/// Merge metadata for one plist from the recovered application snapshot.
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

    fn fixture(root: &Path, label: &str, group: &str) -> (String, Vec<u8>) {
        std::fs::create_dir_all(root).unwrap();
        let config = serde_json::from_value(
            serde_json::json!({"label": label, "raw_xml": "", "metadata": {"group": group}}),
        )
        .unwrap();
        let bytes = plist_util::serialize_plist(&config).unwrap();
        let path = root.join(format!("{label}.plist"));
        std::fs::write(&path, &bytes).unwrap();
        (path.to_string_lossy().into_owned(), bytes)
    }

    #[test]
    fn health_only_updates_do_not_freeze_external_plist_metadata() {
        let observation = health_observation(None, "healthy", "HTTP 200", "123");
        assert!(!observation.complete);
        assert!(observation.metadata.group.is_none());
        let base = LaunchControlMetadata {
            group: Some("externally edited".into()),
            ports: vec![8001, 8002],
            ..Default::default()
        };
        let merged = merge_metadata(&base, Some(&observation));
        assert_eq!(merged.group, base.group);
        assert_eq!(merged.ports, base.ports);
        assert_eq!(merged.health_status.as_deref(), Some("healthy"));
        let complete = ServiceOverride {
            complete: true,
            metadata: base,
        };
        assert!(health_observation(Some(&complete), "unknown", "none", "456").complete);
    }

    #[test]
    fn rejects_a_replacement_between_command_validation_and_transaction_lock() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("LaunchAgents");
        let directory = temp.path().join("state");
        let (path, before) = fixture(&root, "safe", "before");
        let expected = user_agent::load_in(&root, Path::new(&path), None).unwrap();
        let path = expected.path();
        assert!(expected.ensure_current().is_ok());
        let mut config = plist_util::parse_plist_bytes(&before).unwrap();
        config.metadata.group = Some("external".into());
        let external = plist_util::serialize_plist(&config).unwrap();
        let other = root.join("other");
        std::fs::write(&other, &external).unwrap();
        std::fs::rename(other, &path).unwrap();
        assert!(
            transact_at(
                &root,
                &directory,
                None,
                Change {
                    path: &path,
                    label: "safe",
                    after: Some(&before),
                    metadata: None,
                    create: false,
                    expected: Some(&expected)
                },
                state_io::write
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), external);
        assert!(!directory.join(JOURNAL).exists());
    }

    #[test]
    fn journals_maximum_size_before_and_after_snapshots_without_expansion_failure() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("LaunchAgents");
        std::fs::create_dir(&root).unwrap();
        let directory = temp.path().join("state");
        let prefix = "<plist><dict><key>Label</key><string>safe</string><key>Payload</key><string>";
        let suffix = "</string></dict></plist>";
        let before = format!(
            "{prefix}{}{suffix}",
            "x".repeat(1024 * 1024 - prefix.len() - suffix.len())
        )
        .into_bytes();
        let mut after = before.clone();
        after[prefix.len()] = b'y';
        let path = root.join("safe.plist").to_string_lossy().into_owned();
        std::fs::write(&path, &before).unwrap();
        transact_at(
            &root,
            &directory,
            None,
            Change {
                path: &path,
                label: "safe",
                after: Some(&after),
                metadata: Some(&LaunchControlMetadata::default()),
                create: false,
                expected: None,
            },
            state_io::write,
        )
        .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), after);
        assert!(!directory.join(JOURNAL).exists());
    }

    #[test]
    fn complete_records_clear_fields_while_legacy_records_inherit() {
        let base = LaunchControlMetadata {
            group: Some("base".into()),
            ports: vec![42],
            ..Default::default()
        };
        let legacy: ServiceOverride =
            serde_json::from_value(serde_json::json!({"tags": []})).unwrap();
        assert_eq!(merge_metadata(&base, Some(&legacy)), base);
        let complete = ServiceOverride {
            complete: true,
            metadata: Default::default(),
        };
        assert_eq!(
            merge_metadata(&base, Some(&complete)),
            LaunchControlMetadata::default()
        );
    }

    #[test]
    fn rolls_back_replace_create_and_delete_when_overlay_persistence_fails() {
        for operation in ["replace", "create", "delete"] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("LaunchAgents");
            let directory = temp.path().join("state");
            let (path, before) = fixture(&root, "safe", "before");
            let mut config = plist_util::parse_plist_bytes(&before).unwrap();
            config.metadata.group = Some("after".into());
            let after = plist_util::serialize_plist(&config).unwrap();
            let creating = operation == "create";
            if creating {
                std::fs::remove_file(&path).unwrap();
            }
            let result = transact_at(
                &root,
                &directory,
                None,
                Change {
                    path: &path,
                    label: "safe",
                    after: if operation == "delete" {
                        None
                    } else {
                        Some(&after)
                    },
                    metadata: Some(&config.metadata),
                    create: creating,
                    expected: None,
                },
                |_, _| Err(AppError::AgentRuntime("Injected overlay failure".into())),
            );
            assert!(result.is_err());
            if creating {
                assert!(!Path::new(&path).exists());
            } else {
                assert_eq!(std::fs::read(path).unwrap(), before);
            }
            assert!(!directory.join(JOURNAL).exists());
            assert!(load_at(&directory, None).unwrap().is_empty());
        }
    }

    #[test]
    fn recovers_an_interrupted_transaction_and_preserves_external_edits() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("LaunchAgents");
        let directory = temp.path().join("state");
        let (path, before) = fixture(&root, "safe", "before");
        let mut config = plist_util::parse_plist_bytes(&before).unwrap();
        config.metadata.group = Some("after".into());
        let after = plist_util::serialize_plist(&config).unwrap();
        let journal = Journal {
            path: path.clone(),
            label: "safe".into(),
            before: Some(before.clone()),
            after: Some(after.clone()),
            overrides: HashMap::new(),
        };
        state_io::save(&directory.join(JOURNAL), &journal).unwrap();
        user_agent::load_in(&root, Path::new(&path), None)
            .unwrap()
            .write(&after)
            .unwrap();
        state_io::locked(&directory, || recover_at(&root, &directory)).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        state_io::save(&directory.join(JOURNAL), &journal).unwrap();
        config.metadata.group = Some("external".into());
        let external = plist_util::serialize_plist(&config).unwrap();
        std::fs::write(&path, &external).unwrap();
        assert!(state_io::locked(&directory, || recover_at(&root, &directory)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), external);
        assert!(directory.join(JOURNAL).exists());
    }

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

        let merged = merge_metadata(
            &base,
            Some(&ServiceOverride {
                complete: false,
                metadata: overlay,
            }),
        );

        assert_eq!(merged.group, Some("CAISS System".to_string()));
        assert_eq!(merged.tags, vec!["caiss".to_string(), "api".to_string()]);
        assert_eq!(merged.managed_by, Some("base".to_string()));
        assert_eq!(merged.environment, Some("local".to_string()));
        assert_eq!(merged.ports, vec![8001]);
        assert_eq!(merged.health_status, Some("unhealthy".to_string()));
        assert_eq!(merged.last_health_check_at, Some("2".to_string()));
    }
}
