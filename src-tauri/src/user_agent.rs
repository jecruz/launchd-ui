use crate::error::AppError;
use crate::plist_util;
use crate::types::PlistConfig;
use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

fn rejected() -> AppError {
    AppError::Plist(
        "Only regular, owned, non-symlink user-agent plists with matching labels may be mutated."
            .into(),
    )
}

/// Reject labels that could become paths, options, or ambiguous action targets.
pub fn validate_label(label: &str) -> Result<(), AppError> {
    if label.is_empty()
        || label.len() > 240
        || matches!(label, "." | "..")
        || label.starts_with('-')
        || !label
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        return Err(rejected());
    }
    Ok(())
}

fn path_in(root: &Path, path: &Path, must_exist: bool) -> Result<PathBuf, AppError> {
    if !path.is_absolute()
        || path.components().any(|c| matches!(c, Component::ParentDir))
        || path.extension().and_then(|s| s.to_str()) != Some("plist")
    {
        return Err(rejected());
    }
    let root_metadata = std::fs::symlink_metadata(root)?;
    if !root_metadata.is_dir()
        || root_metadata.file_type().is_symlink()
        || root_metadata.uid() != unsafe { libc::geteuid() }
        || std::fs::symlink_metadata(root.parent().ok_or_else(rejected)?)?
            .file_type()
            .is_symlink()
    {
        return Err(rejected());
    }
    let canonical_root = root.canonicalize()?;
    let parent = path.parent().ok_or_else(rejected)?;
    if (parent != root && parent != canonical_root) || parent.canonicalize()? != canonical_root {
        return Err(rejected());
    }
    validate_label(
        path.file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(rejected)?,
    )?;
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.uid() != root_metadata.uid()
                || metadata.nlink() != 1
                || path.canonicalize()?.parent() != Some(canonical_root.as_path())
            {
                return Err(rejected());
            }
        }
        Err(err) if !must_exist && err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    Ok(canonical_root.join(path.file_name().ok_or_else(rejected)?))
}

/// Validate a direct child of the user's LaunchAgents directory before mutation.
#[cfg(test)]
pub fn path(path: &str, must_exist: bool) -> Result<PathBuf, AppError> {
    path_in(
        &plist_util::get_user_agents_dir(),
        Path::new(path),
        must_exist,
    )
}

fn open_at(directory: &File, name: &CString, flags: i32) -> Result<File, AppError> {
    // SAFETY: the directory and NUL-terminated name live for the call; the returned
    // descriptor is uniquely owned by File, and never follows a final symlink.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600 as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn system_path(path: &Path) -> Result<PathBuf, AppError> {
    // macOS exposes these root-owned platform aliases; other symlink components
    // remain forbidden. Never canonicalize an arbitrary caller-selected path.
    for (alias, destination) in [("/var", "/private/var"), ("/tmp", "/private/tmp")] {
        if let Ok(tail) = path.strip_prefix(alias) {
            let metadata = std::fs::symlink_metadata(alias)?;
            if metadata.file_type().is_symlink() {
                let target = std::fs::read_link(alias)?;
                let target = if target.is_absolute() {
                    target
                } else {
                    Path::new("/").join(target)
                };
                if metadata.uid() != 0 || target != Path::new(destination) {
                    return Err(rejected());
                }
                return Ok(Path::new(destination).join(tail));
            }
        }
    }
    Ok(path.to_path_buf())
}

fn open_directory(path: &Path) -> Result<File, AppError> {
    let path = system_path(path)?;
    if !path.is_absolute() {
        return Err(rejected());
    }
    let mut directory = File::open("/")?;
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                let name = CString::new(name.as_bytes()).map_err(|_| rejected())?;
                directory = open_at(&directory, &name, libc::O_RDONLY | libc::O_DIRECTORY)?;
            }
            _ => return Err(rejected()),
        }
    }
    Ok(directory)
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn same_moved_file(a: &Metadata, b: &Metadata) -> bool {
    // Rename can update ctime; inode identity, size and mtime still bind the snapshot.
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && b.is_file()
        && b.nlink() == 1
        && a.uid() == b.uid()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
}

fn atomic_publish(
    directory: &File,
    target: &CString,
    bytes: &[u8],
    expected: Option<&Metadata>,
    validate: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    let name = CString::new(format!(
        ".daemonic-{}-{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
    .map_err(|_| rejected())?;
    let mut file = open_at(
        directory,
        &name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
    )?;
    let candidate = file.metadata()?;
    let mut cleanup = Some(candidate.clone());
    let swap = || {
        // SAFETY: both single-component names belong to this retained directory.
        if unsafe {
            libc::renameatx_np(
                directory.as_raw_fd(),
                name.as_ptr(),
                directory.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_SWAP,
            )
        } != 0
        {
            return Err(AppError::Io(std::io::Error::last_os_error()));
        }
        Ok(())
    };
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        cleanup = Some(file.metadata()?);
        validate()?;
        if let Some(expected) = expected {
            swap()?;
            // Never unlink an unvalidated displaced entry, including a competing edit.
            cleanup = None;
            let displaced = open_at(directory, &name, libc::O_RDONLY)
                .and_then(|file| file.metadata().map_err(Into::into));
            if !displaced
                .as_ref()
                .is_ok_and(|actual| same_moved_file(expected, actual))
            {
                // Restore the competing entry. If a third writer changed the new target,
                // its displaced entry is retained for operator recovery, never deleted.
                swap()?;
                if let Ok(actual) = open_at(directory, &name, libc::O_RDONLY)
                    .and_then(|file| file.metadata().map_err(Into::into))
                {
                    if actual.dev() == candidate.dev() && actual.ino() == candidate.ino() {
                        cleanup = Some(actual);
                    }
                }
                directory.sync_all()?;
                return Err(AppError::Plist("Concurrent plist replacement rejected; any conflicting temporary entry is retained for operator review.".into()));
            }
            let published = open_at(directory, target, libc::O_RDONLY)?.metadata()?;
            if published.dev() != candidate.dev() || published.ino() != candidate.ino() {
                return Err(AppError::Plist("Concurrent publication conflict; displaced original retained for operator review.".into()));
            }
            cleanup = displaced.ok();
        } else {
            // SAFETY: exclusive rename cannot replace a concurrently created job.
            if unsafe {
                libc::renameatx_np(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    directory.as_raw_fd(),
                    target.as_ptr(),
                    libc::RENAME_EXCL,
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        directory.sync_all()?;
        Ok(())
    })();
    if let Some(identity) = cleanup {
        if let Ok(current) = open_at(directory, &name, libc::O_RDONLY)
            .and_then(|file| file.metadata().map_err(Into::into))
        {
            if same_moved_file(&identity, &current) {
                // SAFETY: only the validated private temporary entry is removed.
                unsafe {
                    libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0);
                }
            }
        }
    }
    result
}

fn same_file(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && b.is_file()
        && b.nlink() == 1
        && a.uid() == b.uid()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

/// A validated plist bound to an open directory and its original file identity.
pub struct CheckedAgent {
    path: PathBuf,
    directory: File,
    name: CString,
    identity: Metadata,
    // Keep the validated inode alive so it cannot be recycled after replacement.
    _file: File,
    /// Configuration read from the validated file descriptor.
    pub config: PlistConfig,
}

impl CheckedAgent {
    /// Return the canonical pathname required by launchctl and sidecar keys.
    pub fn path(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    /// Reject replacement or edits immediately before a pathname-based operation.
    pub fn ensure_current(&self) -> Result<(), AppError> {
        let parent = open_directory(self.path.parent().ok_or_else(rejected)?)?.metadata()?;
        let directory = self.directory.metadata()?;
        if parent.file_type().is_symlink()
            || parent.dev() != directory.dev()
            || parent.ino() != directory.ino()
        {
            return Err(rejected());
        }
        let current = open_at(&self.directory, &self.name, libc::O_RDONLY)?;
        if !same_file(&self.identity, &current.metadata()?) {
            return Err(rejected());
        }
        Ok(())
    }

    /// Replace bytes through a descriptor matching the originally validated inode.
    pub fn write(&self, bytes: &[u8]) -> Result<(), AppError> {
        atomic_publish(
            &self.directory,
            &self.name,
            bytes,
            Some(&self.identity),
            || self.ensure_current(),
        )
    }

    /// Read the original bounded snapshot through its retained descriptor.
    pub fn original_bytes(&self) -> Result<Vec<u8>, AppError> {
        self.ensure_current()?;
        let mut file = self._file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 1024 * 1024 {
            return Err(rejected());
        }
        self.ensure_current()?;
        Ok(bytes)
    }

    /// Atomically capture a deletion target, validate its inode, and sync the removal.
    pub fn remove(&self) -> Result<(), AppError> {
        self.remove_after_check(|| Ok(()))
    }

    fn remove_after_check(
        &self,
        after_check: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        self.ensure_current()?;
        after_check()?;
        let tombstone = CString::new(format!(
            ".daemonic-{}-{}.delete",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
        .map_err(|_| rejected())?;
        let rename = |from: &CString, to: &CString| {
            // SAFETY: exclusive rename stays within the retained user-agent directory.
            if unsafe {
                libc::renameatx_np(
                    self.directory.as_raw_fd(),
                    from.as_ptr(),
                    self.directory.as_raw_fd(),
                    to.as_ptr(),
                    libc::RENAME_EXCL,
                )
            } != 0
            {
                return Err(AppError::Io(std::io::Error::last_os_error()));
            }
            Ok(())
        };
        rename(&self.name, &tombstone)?;
        let captured = open_at(&self.directory, &tombstone, libc::O_RDONLY)
            .and_then(|file| file.metadata().map_err(Into::into));
        if !captured
            .as_ref()
            .is_ok_and(|actual| same_moved_file(&self.identity, actual))
        {
            rename(&tombstone, &self.name).map_err(|_| {
                AppError::Plist(
                    "Deletion conflict; captured entry retained for operator review.".into(),
                )
            })?;
            self.directory.sync_all()?;
            return Err(rejected());
        }
        // SAFETY: unlink only the validated captured entry, never a new target entry.
        if unsafe { libc::unlinkat(self.directory.as_raw_fd(), tombstone.as_ptr(), 0) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        self.directory.sync_all()?;
        Ok(())
    }
}

/// Load from an explicitly trusted root, including isolated transaction fixtures.
pub(crate) fn load_in(
    root: &Path,
    path: &Path,
    label: Option<&str>,
) -> Result<CheckedAgent, AppError> {
    let path = path_in(root, path, true)?;
    let directory = open_directory(path.parent().ok_or_else(rejected)?)?;
    let name =
        CString::new(path.file_name().ok_or_else(rejected)?.as_bytes()).map_err(|_| rejected())?;
    let mut file = open_at(&directory, &name, libc::O_RDONLY)?;
    let identity = file.metadata()?;
    if !identity.is_file() || identity.nlink() != 1 || identity.uid() != directory.metadata()?.uid()
    {
        return Err(rejected());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(rejected());
    }
    let config = plist_util::parse_plist_bytes(&bytes)?;
    validate_label(&config.label)?;
    if path.file_stem().and_then(|s| s.to_str()) != Some(config.label.as_str())
        || label.is_some_and(|label| label != config.label)
    {
        return Err(rejected());
    }
    let agent = CheckedAgent {
        path,
        directory,
        name,
        identity,
        _file: file,
        config,
    };
    agent.ensure_current()?;
    Ok(agent)
}

/// Load a user agent and retain its descriptor-bound identity until mutation.
pub fn load(path: &str, label: Option<&str>) -> Result<CheckedAgent, AppError> {
    load_in(&plist_util::get_user_agents_dir(), Path::new(path), label)
}

/// Create within an explicitly trusted root using atomic exclusive publication.
pub(crate) fn create_in(root: &Path, label: &str, bytes: &[u8]) -> Result<String, AppError> {
    validate_label(label)?;
    if plist_util::parse_plist_bytes(bytes)?.label != label {
        return Err(rejected());
    }
    let parent = open_directory(root.parent().ok_or_else(rejected)?)?;
    let root_name =
        CString::new(root.file_name().ok_or_else(rejected)?.as_bytes()).map_err(|_| rejected())?;
    // SAFETY: a single-component name creates only an entry in the already-open
    // Library directory; no caller-controlled symlink can redirect mkdirat.
    if unsafe { libc::mkdirat(parent.as_raw_fd(), root_name.as_ptr(), 0o700) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error.into());
        }
    }
    let path = path_in(root, &root.join(format!("{label}.plist")), false)?;
    let directory = open_directory(path.parent().ok_or_else(rejected)?)?;
    let name =
        CString::new(path.file_name().ok_or_else(rejected)?.as_bytes()).map_err(|_| rejected())?;
    atomic_publish(&directory, &name, bytes, None, || Ok(()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Prepare the app-owned private log directory before the first interactive draft.
pub fn prepare_log_directory() -> Result<(), AppError> {
    let home =
        dirs::home_dir().ok_or_else(|| AppError::Plist("Home directory unavailable.".into()))?;
    let library = open_directory(&home.join("Library"))?;
    let logs = CString::new("Logs").map_err(|_| rejected())?;
    // SAFETY: the constant name is relative to the trusted open Library directory.
    if unsafe { libc::mkdirat(library.as_raw_fd(), logs.as_ptr(), 0o700) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error.into());
        }
    }
    let logs = open_at(&library, &logs, libc::O_RDONLY | libc::O_DIRECTORY)?;
    let metadata = logs.metadata()?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
        return Err(rejected());
    }
    let name = CString::new("Daemonic").map_err(|_| rejected())?;
    if unsafe { libc::mkdirat(logs.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error.into());
        }
    }
    let directory = open_at(&logs, &name, libc::O_RDONLY | libc::O_DIRECTORY)?;
    if directory.metadata()?.uid() != unsafe { libc::geteuid() } {
        return Err(rejected());
    }
    use std::os::unix::fs::PermissionsExt;
    directory.set_permissions(std::fs::Permissions::from_mode(0o700))?;
    logs.sync_all()?;
    Ok(())
}

/// Require log destinations to have an existing real directory parent.
pub fn validate_log_parents(config: &PlistConfig) -> Result<(), AppError> {
    for path in [&config.standard_out_path, &config.standard_error_path]
        .into_iter()
        .flatten()
    {
        let path = Path::new(path);
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(rejected());
        }
        let parent = system_path(path.parent().ok_or_else(rejected)?)?;
        // canonical equality rejects non-platform symlinks in any parent component.
        if !parent.is_dir() || parent.canonicalize()? != parent {
            return Err(rejected());
        }
        let metadata = parent.metadata()?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
            return Err(rejected());
        }
        for ancestor in parent.ancestors().skip(1) {
            let metadata = ancestor.metadata()?;
            if metadata.mode() & 0o022 != 0
                && !(metadata.uid() == 0 && metadata.mode() & 0o1000 != 0)
            {
                return Err(rejected());
            }
        }
        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.nlink() != 1 {
                return Err(rejected());
            }
        }
    }
    Ok(())
}

/// Open only a declared owned regular log through non-symlink directory descriptors.
pub fn open_log_for_clear(path: &str, config: &PlistConfig) -> Result<File, AppError> {
    if ![&config.standard_out_path, &config.standard_error_path]
        .iter()
        .any(|candidate| candidate.as_deref() == Some(path))
    {
        return Err(rejected());
    }
    let path = Path::new(path);
    let directory = open_directory(path.parent().ok_or_else(rejected)?)?;
    let name =
        CString::new(path.file_name().ok_or_else(rejected)?.as_bytes()).map_err(|_| rejected())?;
    let file = open_at(&directory, &name, libc::O_WRONLY)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(rejected());
    }
    Ok(file)
}

/// Require raw XML edits to retain the existing plist's explicit label.
pub fn validate_xml_label(xml: &str, label: &str) -> Result<(), AppError> {
    let config = plist_util::parse_plist_bytes(xml.as_bytes())?;
    if config.label != label {
        return Err(rejected());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn fixture(root: &Path, filename: &str, label: &str) -> PathBuf {
        let path = root.join(filename);
        std::fs::write(&path, format!("<plist version=\"1.0\"><dict><key>Label</key><string>{label}</string></dict></plist>")).unwrap();
        path
    }

    #[test]
    fn creation_is_exclusive_and_rejects_a_linked_parent_before_mkdir() {
        let base = tempfile::tempdir().unwrap();
        let library = base.path().join("Library");
        std::fs::create_dir(&library).unwrap();
        let root = library.join("LaunchAgents");
        let bytes = b"<plist><dict><key>Label</key><string>safe</string></dict></plist>";
        let path = create_in(&root, "safe", bytes).unwrap();
        assert!(create_in(&root, "safe", bytes).is_err());
        assert!(create_in(&root, "other", bytes).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let outside = base.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::rename(&library, base.path().join("saved-library")).unwrap();
        symlink(&outside, &library).unwrap();
        assert!(create_in(&root, "safe", bytes).is_err());
        assert!(!outside.join("LaunchAgents").exists());
    }

    #[test]
    fn rejects_replaced_files_before_writing_or_removing() {
        let root = tempfile::tempdir().unwrap();
        let path = fixture(root.path(), "safe.plist", "safe");
        let agent = load_in(root.path(), &path, None).unwrap();
        let replacement = fixture(root.path(), "replacement.plist", "safe");
        std::fs::rename(replacement, &path).unwrap();
        assert!(agent.ensure_current().is_err());
        assert!(agent.write(b"wrong").is_err());
        assert!(agent.remove().is_err());
        assert_eq!(
            load_in(root.path(), &path, None).unwrap().config.label,
            "safe"
        );
    }

    #[test]
    fn requires_existing_nonlinked_log_parents() {
        let root = tempfile::tempdir().unwrap();
        let path = fixture(root.path(), "safe.plist", "safe");
        let mut config = load_in(root.path(), &path, None).unwrap().config;
        config.standard_out_path = Some(
            root.path()
                .join("missing/out.log")
                .to_string_lossy()
                .into_owned(),
        );
        assert!(validate_log_parents(&config).is_err());
        symlink(root.path(), root.path().join("alias")).unwrap();
        config.standard_out_path = Some(
            root.path()
                .join("alias/out.log")
                .to_string_lossy()
                .into_owned(),
        );
        assert!(validate_log_parents(&config).is_err());
        config.standard_out_path = Some(
            root.path()
                .canonicalize()
                .unwrap()
                .join("out.log")
                .to_string_lossy()
                .into_owned(),
        );
        assert!(validate_log_parents(&config).is_ok());
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(validate_log_parents(&config).is_err());
    }

    #[test]
    fn deletion_preserves_a_replacement_after_the_final_check() {
        let root = tempfile::tempdir().unwrap();
        let path = fixture(root.path(), "safe.plist", "safe");
        let agent = load_in(root.path(), &path, None).unwrap();
        let other = root.path().join("other");
        let external = b"<plist><dict><key>Label</key><string>safe</string><key>Comment</key><string>external</string></dict></plist>";
        std::fs::write(&other, external).unwrap();
        assert!(
            agent
                .remove_after_check(|| {
                    std::fs::rename(&other, &path)?;
                    Ok(())
                })
                .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), external);
        load_in(root.path(), &path, None).unwrap().remove().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn atomic_exchange_rejects_a_replacement_after_the_final_precheck() {
        let root = tempfile::tempdir().unwrap();
        let path = fixture(root.path(), "safe.plist", "safe");
        let agent = load_in(root.path(), &path, None).unwrap();
        let external = root.path().join("external");
        let external_bytes = b"<plist><dict><key>Label</key><string>safe</string><key>Comment</key><string>external</string></dict></plist>";
        std::fs::write(&external, external_bytes).unwrap();
        let replacement = agent.original_bytes().unwrap();
        let result = atomic_publish(
            &agent.directory,
            &agent.name,
            &replacement,
            Some(&agent.identity),
            || {
                agent.ensure_current()?;
                std::fs::rename(&external, &path)?;
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), external_bytes);
        assert!(!std::fs::read_dir(root.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".daemonic-")
        }));
    }

    #[test]
    fn binds_filename_plist_label_and_request_label() {
        let root = tempfile::tempdir().unwrap();
        let path = fixture(root.path(), "com.example.safe.plist", "com.example.safe");
        assert!(load_in(root.path(), &path, Some("com.example.safe")).is_ok());
        assert!(load_in(root.path(), &path, Some("com.example.other")).is_err());
        let mismatch = fixture(root.path(), "other.plist", "com.example.safe");
        assert!(load_in(root.path(), &mismatch, None).is_err());
        assert!(
            validate_xml_label(
                "<plist><dict><key>Label</key><string>other</string></dict></plist>",
                "com.example.safe"
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_traversal_siblings_symlinks_hardlinks_and_non_plists() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("LaunchAgents");
        let sibling = parent.path().join("LaunchAgents-other");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        let outside = fixture(&sibling, "outside.plist", "outside");
        assert!(path_in(&root, &outside, true).is_err());
        assert!(
            path_in(
                &root,
                &root.join("../LaunchAgents-other/outside.plist"),
                true
            )
            .is_err()
        );
        symlink(&outside, root.join("linked.plist")).unwrap();
        assert!(path_in(&root, &root.join("linked.plist"), true).is_err());
        std::fs::hard_link(&outside, root.join("hard.plist")).unwrap();
        assert!(path_in(&root, &root.join("hard.plist"), true).is_err());
        assert!(path_in(&root, &root.join("job.txt"), false).is_err());
        symlink(&root, parent.path().join("alias")).unwrap();
        assert!(path_in(&parent.path().join("alias"), &root.join("new.plist"), false).is_err());
        for label in [
            "../outside",
            "/absolute",
            "-option",
            "bad label",
            "a/b",
            "..",
            "",
        ] {
            assert!(validate_label(label).is_err());
        }
    }
}
