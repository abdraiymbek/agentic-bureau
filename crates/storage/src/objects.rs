use crate::{resolve_project_path, StorageError};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub struct ObjectStore {
    root: PathBuf,
    read_only: bool,
}

impl ObjectStore {
    pub fn new(root: impl AsRef<Path>, read_only: bool) -> Result<Self, StorageError> {
        let root = root.as_ref().to_path_buf();
        if !read_only {
            fs::create_dir_all(&root)?;
        }
        Ok(Self { root, read_only })
    }

    fn path(&self, hash: &str) -> Result<PathBuf, StorageError> {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(StorageError::domain(
                "VALIDATION",
                "Invalid SHA-256 object identifier",
            ));
        }
        resolve_project_path(&self.root, &format!("{}/{hash}", &hash[..2]))
    }

    pub fn read(&self, hash: &str) -> Result<Vec<u8>, StorageError> {
        let path = self.path(hash)?;
        let mut file = fs::File::open(path)?;
        if file.metadata()?.len() > MAX_FILE_BYTES {
            return Err(StorageError::domain(
                "VALIDATION",
                "Object exceeds 67108864 byte limit",
            ));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        if sha256_hex(&bytes) != hash {
            return Err(StorageError::domain(
                "VALIDATION",
                format!("Corrupt object: {hash}"),
            ));
        }
        Ok(bytes)
    }

    pub fn put(&self, bytes: &[u8]) -> Result<String, StorageError> {
        if self.read_only {
            return Err(StorageError::domain(
                "READ_ONLY",
                "Object store is read-only",
            ));
        }
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(StorageError::domain(
                "VALIDATION",
                "File exceeds 67108864 byte limit",
            ));
        }
        let hash = sha256_hex(bytes);
        let path = self.path(&hash)?;
        if path.exists() {
            self.read(&hash)?;
            return Ok(hash);
        }
        fs::create_dir_all(path.parent().expect("object has parent"))?;
        let temp = path.with_file_name(format!("{hash}.tmp-{}", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(&temp, &path)?;
            if let Some(parent) = path.parent() {
                if let Ok(dir) = fs::File::open(parent) {
                    let _ = dir.sync_all();
                }
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o444))?;
            }
            Ok::<(), StorageError>(())
        })();
        let _ = fs::remove_file(&temp);
        result?;
        Ok(hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn immutable_objects_round_trip_and_detect_corruption() {
        let root = tempfile::tempdir().unwrap();
        let store = ObjectStore::new(root.path(), false).unwrap();
        let hash = store.put(b"OpenSCAD source").unwrap();
        assert_eq!(store.read(&hash).unwrap(), b"OpenSCAD source");
        assert_eq!(store.put(b"OpenSCAD source").unwrap(), hash);
    }
}
