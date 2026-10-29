use crate::error::AppError;
use crate::plist_util;
use crate::types::PlistConfig;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

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
pub fn path(path: &str, must_exist: bool) -> Result<PathBuf, AppError> {
    path_in(
        &plist_util::get_user_agents_dir(),
        Path::new(path),
        must_exist,
    )
}

fn load_in(
    root: &Path,
    path: &Path,
    label: Option<&str>,
) -> Result<(String, PlistConfig), AppError> {
    let path = path_in(root, path, true)?;
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != root.metadata()?.uid() {
        return Err(rejected());
    }
    let mut bytes = Vec::new();
    file.by_ref()
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
    Ok((path.to_str().ok_or_else(rejected)?.to_string(), config))
}

/// Load a validated user agent and bind any caller-supplied label to its plist.
pub fn load(path: &str, label: Option<&str>) -> Result<(String, PlistConfig), AppError> {
    load_in(&plist_util::get_user_agents_dir(), Path::new(path), label)
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
