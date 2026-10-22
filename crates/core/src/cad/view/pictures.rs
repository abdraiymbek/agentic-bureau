//! Where the pictures drawn for an agent are kept, how large they may be,
//! and how a host reads one back to send it.
//!
//! A picture is a regenerable PNG file named by the SHA-256 of its bytes
//! under `.omenflow/cache/views-v1/`. It is never read back as a cache: every call
//! draws its picture again. The folder is pruned to the newest files.
use super::*;
use std::io::Read;
use std::time::SystemTime;

/// Project-relative folder of the pictures.
pub const DIR: &str = ".omenflow/cache/views-v1";
/// Largest picture, in bytes. Larger drawings are drawn again smaller.
pub const PICTURE_BYTES: usize = 1024 * 1024;
/// Largest total of the pictures sent with one reply.
pub const REPLY_BYTES: usize = 2 * 1024 * 1024;
/// Pictures sent with one reply.
pub const PER_REPLY: usize = 1;
/// Every picture is a PNG.
pub const MIME_TYPE: &str = "image/png";
const EXTENSION: &str = ".png";

/// How much the folder keeps.
#[derive(Clone, Copy)]
pub(crate) struct Keep {
    pub files: usize,
    pub bytes: u64,
}

pub(crate) const KEEP: Keep = Keep {
    files: 256,
    bytes: 128 * 1024 * 1024,
};

/// A picture as written, named in a result.
pub(crate) struct Stored {
    pub path: String,
    pub sha256: String,
    pub bytes: usize,
}

/// The hash in a picture file name, if it is one.
fn parse_name(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(EXTENSION)?;
    let hex = stem.len() == 64
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    hex.then_some(stem)
}

/// The SHA-256 of a file of at most `limit` bytes, or none when it is
/// unreadable or larger.
fn hash_file(path: &Path, limit: usize) -> Option<String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= limit).then(|| omenflow_storage::sha256_hex(&bytes))
}

/// Write `bytes` as `<sha256>.png` and prune the folder. A file already
/// there with the same bytes is kept and marked as just used.
pub(crate) fn store(root: &Path, bytes: &[u8]) -> CoreResult<Stored> {
    store_keeping(root, bytes, KEEP)
}

pub(crate) fn store_keeping(root: &Path, bytes: &[u8], keep: Keep) -> CoreResult<Stored> {
    let dir = omenflow_storage::resolve_project_path(root, DIR).map_err(storage_error)?;
    fs::create_dir_all(&dir).map_err(internal)?;
    // The folder must still be inside the project once it exists.
    omenflow_storage::resolve_project_path(root, DIR).map_err(storage_error)?;
    let sha256 = omenflow_storage::sha256_hex(bytes);
    let name = format!("{sha256}{EXTENSION}");
    let path = dir.join(&name);
    let same = || {
        fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file())
            && hash_file(&path, bytes.len()).as_deref() == Some(sha256.as_str())
    };
    if same() {
        // Marked as used now, so pruning oldest first does not take it.
        let _ = fs::File::options()
            .write(true)
            .open(&path)
            .and_then(|file| file.set_modified(SystemTime::now()));
    } else {
        // A name of its own per writer: two calls may store the same picture
        // at once.
        let temp = dir.join(format!(".tmp-{}", uuid::Uuid::new_v4()));
        let written = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            std::io::Write::write_all(&mut file, bytes)?;
            fs::rename(&temp, &path)
        })();
        let _ = fs::remove_file(&temp);
        // A rename that lost to another writer of the same bytes succeeded.
        if let Err(error) = written {
            if !same() {
                return Err(internal(error));
            }
        }
    }
    prune(&dir, &name, keep);
    Ok(Stored {
        path: format!("{DIR}/{name}"),
        sha256,
        bytes: bytes.len(),
    })
}

/// Remove the oldest pictures until the folder is within `keep`, never
/// `kept`. Only picture names are considered, so another writer's
/// temporary file is left alone. Pruning is housekeeping: nothing it meets
/// fails the call.
fn prune(dir: &Path, kept: &str, keep: Keep) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut kept_bytes = 0;
    let mut others = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if parse_name(&name).is_none() {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if name == kept {
            kept_bytes = meta.len();
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        others.push((modified, name, meta.len()));
    }
    others.sort();
    let mut files = others.len() + 1;
    let mut bytes = kept_bytes + others.iter().map(|(_, _, len)| len).sum::<u64>();
    for (_, name, len) in others {
        if files <= keep.files && bytes <= keep.bytes {
            break;
        }
        // Already gone (another call pruned it) is as good as removed.
        let _ = fs::remove_file(dir.join(&name));
        files -= 1;
        bytes = bytes.saturating_sub(len);
    }
}

/// A picture read back to be sent.
pub struct Picture {
    pub mime_type: &'static str,
    pub bytes: Vec<u8>,
}

/// Read back the picture a result names in `entry`
/// (`{"path", "sha256", "mimeType"}`), only if it is a picture file in the
/// views folder of `root`, within the byte cap, with the bytes it was
/// recorded with. The error says why it is not sent.
pub fn read_back(root: &Path, entry: &Value) -> Result<Picture, &'static str> {
    let path = entry["path"].as_str().ok_or("no path")?;
    let name = path
        .strip_prefix(DIR)
        .and_then(|rest| rest.strip_prefix('/'))
        .ok_or("not in the pictures folder")?;
    let stem = parse_name(name).ok_or("not a picture file name")?;
    if entry["sha256"].as_str() != Some(stem) || entry["mimeType"].as_str() != Some(MIME_TYPE) {
        return Err("its name does not match its record");
    }
    let file = root.join(DIR).join(name);
    let meta = fs::symlink_metadata(&file).map_err(|_| "the file is gone")?;
    if !meta.is_file() {
        return Err("not a regular file");
    }
    let folder = root
        .join(DIR)
        .canonicalize()
        .map_err(|_| "the file is gone")?;
    let canonical = file.canonicalize().map_err(|_| "the file is gone")?;
    if !canonical.starts_with(&folder) {
        return Err("not in the pictures folder");
    }
    if meta.len() > PICTURE_BYTES as u64 {
        return Err("it is larger than a picture may be");
    }
    let mut bytes = Vec::new();
    fs::File::open(&canonical)
        .and_then(|file| file.take(PICTURE_BYTES as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| "the file is gone")?;
    if bytes.len() > PICTURE_BYTES {
        return Err("it is larger than a picture may be");
    }
    if omenflow_storage::sha256_hex(&bytes) != stem {
        return Err("it changed on disk");
    }
    Ok(Picture {
        mime_type: MIME_TYPE,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut names = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    fn age(path: &Path, seconds: u64) {
        let when = SystemTime::now() - std::time::Duration::from_secs(seconds);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    #[test]
    fn the_folder_is_pruned_oldest_first_and_keeps_the_new_file() {
        let root = tempfile::tempdir().unwrap();
        let keep = Keep {
            files: 2,
            bytes: 1 << 20,
        };
        let first = store_keeping(root.path(), b"first", keep).unwrap();
        let second = store_keeping(root.path(), b"second", keep).unwrap();
        age(&root.path().join(&first.path), 300);
        age(&root.path().join(&second.path), 200);
        // Another writer's temporary file and an unrelated name are not pictures.
        let dir = root.path().join(DIR);
        fs::write(dir.join(".tmp-other"), b"partial").unwrap();
        fs::write(dir.join("notes.txt"), b"keep me").unwrap();
        let third = store_keeping(root.path(), b"third", keep).unwrap();
        assert_eq!(third.path, format!("{DIR}/{}.png", third.sha256));
        let left = names(&dir);
        assert!(!left.contains(&format!("{}.png", first.sha256)), "{left:?}");
        assert!(left.contains(&format!("{}.png", second.sha256)));
        assert!(left.contains(&format!("{}.png", third.sha256)));
        assert!(left.contains(&".tmp-other".to_owned()) && left.contains(&"notes.txt".to_owned()));
        // A byte limit prunes too, but never the file just stored.
        let tight = Keep {
            files: 10,
            bytes: 1,
        };
        let fourth = store_keeping(root.path(), b"fourth", tight).unwrap();
        let left = names(&dir);
        assert!(left.contains(&format!("{}.png", fourth.sha256)));
        assert!(!left.contains(&format!("{}.png", second.sha256)));
    }

    #[test]
    fn a_picture_stored_again_is_kept_and_not_pruned_as_old() {
        let root = tempfile::tempdir().unwrap();
        let keep = Keep {
            files: 2,
            bytes: 1 << 20,
        };
        let old = store_keeping(root.path(), b"old", keep).unwrap();
        let reused = store_keeping(root.path(), b"reused", keep).unwrap();
        age(&root.path().join(&reused.path), 900);
        age(&root.path().join(&old.path), 300);
        // Stored again: the existing file is reused and counts as new.
        let again = store_keeping(root.path(), b"reused", keep).unwrap();
        assert_eq!(again.path, reused.path);
        store_keeping(root.path(), b"newest", keep).unwrap();
        let left = names(&root.path().join(DIR));
        assert!(left.contains(&format!("{}.png", reused.sha256)), "{left:?}");
        assert!(!left.contains(&format!("{}.png", old.sha256)), "{left:?}");
    }

    #[test]
    fn a_damaged_file_under_the_same_name_is_written_again() {
        let root = tempfile::tempdir().unwrap();
        let stored = store(root.path(), b"picture bytes").unwrap();
        let file = root.path().join(&stored.path);
        fs::write(&file, b"picture byteZ").unwrap();
        store(root.path(), b"picture bytes").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"picture bytes");
    }

    #[test]
    fn two_calls_storing_the_same_picture_at_once_both_succeed() {
        let root = tempfile::tempdir().unwrap();
        let bytes = vec![7u8; 200_000];
        let results = std::thread::scope(|scope| {
            let workers = (0..4)
                .map(|_| scope.spawn(|| store(root.path(), &bytes)))
                .collect::<Vec<_>>();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        let paths = results
            .into_iter()
            .map(|result| result.unwrap().path)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(paths.len(), 1);
        let path = paths.into_iter().next().unwrap();
        assert_eq!(fs::read(root.path().join(&path)).unwrap(), bytes);
        assert_eq!(
            names(&root.path().join(DIR)).len(),
            1,
            "no temporary file is left"
        );
    }

    #[test]
    fn only_a_recorded_picture_in_the_folder_is_read_back() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let stored = store(root, b"\x89PNG picture").unwrap();
        let entry = |path: &str, sha: &str, mime: &str| json!({"path": path, "sha256": sha, "mimeType": mime});
        let good = entry(&stored.path, &stored.sha256, "image/png");
        let picture = read_back(root, &good).unwrap();
        assert_eq!(
            (picture.mime_type, picture.bytes.as_slice()),
            ("image/png", &b"\x89PNG picture"[..])
        );
        assert_eq!(
            read_back(root, &entry(&stored.path, &stored.sha256, "image/jpeg")).err(),
            Some("its name does not match its record")
        );
        let elsewhere = format!("inputs/{}.png", stored.sha256);
        assert_eq!(
            read_back(root, &entry(&elsewhere, &stored.sha256, "image/png")).err(),
            Some("not in the pictures folder")
        );
        let escape = format!("{DIR}/../{}.png", stored.sha256);
        assert!(read_back(root, &entry(&escape, &stored.sha256, "image/png")).is_err());
        let other = "0".repeat(64);
        assert_eq!(
            read_back(
                root,
                &entry(&format!("{DIR}/{other}.png"), &other, "image/png")
            )
            .err(),
            Some("the file is gone")
        );
        fs::write(root.join(&stored.path), b"\x89PNG changed!").unwrap();
        assert_eq!(read_back(root, &good).err(), Some("it changed on disk"));
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            let target = outside.path().join("secret.png");
            fs::write(&target, b"secret").unwrap();
            let sha = omenflow_storage::sha256_hex(b"secret");
            std::os::unix::fs::symlink(&target, root.join(DIR).join(format!("{sha}.png"))).unwrap();
            assert_eq!(
                read_back(root, &entry(&format!("{DIR}/{sha}.png"), &sha, "image/png")).err(),
                Some("not a regular file")
            );
        }
    }
}
