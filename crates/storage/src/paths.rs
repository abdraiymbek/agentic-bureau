use crate::StorageError;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Resolve existing ancestors before appending a missing tail, as the Node
/// implementation does for macOS /var -> /private/var and symlinked parents.
pub fn canonicalize(path: impl AsRef<Path>) -> Result<PathBuf, StorageError> {
    let path = path.as_ref();
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut missing = Vec::new();
    let mut ancestor = absolute.as_path();
    while !ancestor.exists() {
        let name = ancestor.file_name().ok_or_else(|| {
            StorageError::domain("PATH_OUTSIDE_PROJECT", "Path has no existing ancestor")
        })?;
        missing.push(name.to_os_string());
        ancestor = ancestor
            .parent()
            .ok_or_else(|| StorageError::domain("PATH_OUTSIDE_PROJECT", "Path has no parent"))?;
    }
    let mut resolved = ancestor.canonicalize()?;
    for name in missing.into_iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

pub fn resolve_project_path(
    root: impl AsRef<Path>,
    relative: &str,
) -> Result<PathBuf, StorageError> {
    if relative.is_empty()
        || relative.contains('\0')
        || relative.contains('\\')
        || relative.starts_with('/')
        || relative.as_bytes().get(1) == Some(&b':')
    {
        return Err(StorageError::domain(
            "PATH_OUTSIDE_PROJECT",
            format!("Absolute path not allowed: {relative}"),
        ));
    }
    let rel = Path::new(relative);
    if rel
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(StorageError::domain(
            "PATH_OUTSIDE_PROJECT",
            format!("Path escapes project: {relative}"),
        ));
    }
    let root = canonicalize(root)?;
    let path = root.join(rel);
    let resolved = canonicalize(&path)?;
    if !resolved.starts_with(&root) {
        return Err(StorageError::domain(
            "PATH_OUTSIDE_PROJECT",
            format!("Symlink escapes project: {relative}"),
        ));
    }
    Ok(path)
}

pub fn resolve_materialization_path(
    root: impl AsRef<Path>,
    relative: &str,
) -> Result<PathBuf, StorageError> {
    let root = canonicalize(root)?;
    let path = resolve_project_path(&root, relative)?;
    let rel = path
        .strip_prefix(&root)
        .map_err(|_| StorageError::domain("PATH_OUTSIDE_PROJECT", "Path escapes project"))?;
    let first = rel.components().next().and_then(|part| match part {
        Component::Normal(name) => name.to_str(),
        _ => None,
    });
    let actual = canonicalize(&path)?;
    let actual_first = actual
        .strip_prefix(&root)
        .ok()
        .and_then(|rel| rel.components().next())
        .and_then(|part| match part {
            Component::Normal(name) => name.to_str(),
            _ => None,
        });
    if [first, actual_first].into_iter().flatten().any(|name| {
        name.eq_ignore_ascii_case(".omenflow") || name.eq_ignore_ascii_case("omenflow.project.json")
    }) {
        return Err(StorageError::domain(
            "PATH_OUTSIDE_PROJECT",
            format!("Reserved project path: {relative}"),
        ));
    }
    Ok(path)
}

pub fn write_materialized_file(
    root: impl AsRef<Path>,
    relative: &str,
    bytes: &[u8],
) -> Result<(), StorageError> {
    let root = root.as_ref();
    let path = resolve_materialization_path(root, relative)?;
    fs::create_dir_all(path.parent().expect("resolved file has parent"))?;
    resolve_materialization_path(root, relative)?;
    let temp = path.with_file_name(format!(".omenflow-write-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        resolve_materialization_path(root, relative)?;
        fs::rename(&temp, &path)?;
        Ok(())
    })();
    let _ = fs::remove_file(&temp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guarded_paths_reject_escape_and_reserved_state() {
        let root = tempfile::tempdir().unwrap();
        assert!(resolve_project_path(root.path(), "artifacts/a.scad").is_ok());
        assert!(resolve_project_path(root.path(), "../outside").is_err());
        assert!(resolve_project_path(root.path(), "C:\\outside").is_err());
        assert!(resolve_materialization_path(root.path(), ".omenflow/state.sqlite").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn guarded_paths_reject_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        assert!(resolve_project_path(root.path(), "escape/part.scad").is_err());
    }
}
