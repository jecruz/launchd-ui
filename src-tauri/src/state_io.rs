//! Private, bounded, crash-safe state files with cross-process writer serialization.
use crate::error::AppError;
use serde::{Serialize, de::DeserializeOwned};
use std::fs::{File, OpenOptions, Permissions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

const MAX_STATE_BYTES: u64 = 8 * 1024 * 1024;

fn private_dir(path: &Path) -> Result<PathBuf, AppError> {
    std::fs::create_dir_all(path)?;
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(AppError::AgentRuntime(
            "State directory must be owned and nonlinked.".into(),
        ));
    }
    std::fs::set_permissions(path, Permissions::from_mode(0o700))?;
    Ok(path.canonicalize()?)
}

/// Serialize a state read/modify/write across threads and application processes.
pub fn locked<T>(
    directory: &Path,
    operation: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let directory = private_dir(directory)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join(".state.lock"))?;
    let metadata = lock.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(AppError::AgentRuntime("Invalid state lock.".into()));
    }
    lock.set_permissions(Permissions::from_mode(0o600))?;
    // SAFETY: the descriptor stays open until operation completes; closing it
    // releases flock on success, error, or unwind.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let result = operation();
    drop(lock);
    result
}

/// Read a bounded regular owned state file without following a final symlink.
pub fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, AppError> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(AppError::AgentRuntime("Invalid state file.".into()));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(AppError::AgentRuntime(
            "State file exceeds its size limit.".into(),
        ));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| AppError::AgentRuntime(format!("Invalid state JSON: {error}")))
}

/// Atomically replace one private state file; caller holds the directory lock.
pub fn write<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| AppError::AgentRuntime(format!("Cannot serialize state: {error}")))?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(AppError::AgentRuntime(
            "State exceeds its size limit.".into(),
        ));
    }
    let directory = private_dir(
        path.parent()
            .ok_or_else(|| AppError::AgentRuntime("State needs a directory.".into()))?,
    )?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
    temporary
        .as_file()
        .set_permissions(Permissions::from_mode(0o600))?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(
            directory.join(
                path.file_name()
                    .ok_or_else(|| AppError::AgentRuntime("Invalid state filename.".into()))?,
            ),
        )
        .map_err(|error| AppError::Io(error.error))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

/// Save a complete state snapshot after acquiring its writer lock.
pub fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    locked(
        path.parent()
            .ok_or_else(|| AppError::AgentRuntime("Invalid state path.".into()))?,
        || write(path, value),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serializes_concurrent_updates_and_creates_private_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        save(&path, &0usize).unwrap();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        locked(path.parent().unwrap(), || {
                            let value = read::<usize>(&path)?.unwrap();
                            write(&path, &(value + 1))
                        })
                        .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(read::<usize>(&path).unwrap(), Some(80));
        assert_eq!(std::fs::metadata(path).unwrap().mode() & 0o777, 0o600);
    }

    #[test]
    fn serialization_failure_preserves_the_previous_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        save(&path, &"original").unwrap();
        struct Invalid;
        impl Serialize for Invalid {
            fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                Err(serde::ser::Error::custom("injected serialization failure"))
            }
        }
        assert!(save(&path, &Invalid).is_err());
        assert_eq!(read::<String>(&path).unwrap().as_deref(), Some("original"));
    }
}
