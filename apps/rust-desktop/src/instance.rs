//! One running app per data directory.
//!
//! The default data directory is guarded by the single-instance plugin, which
//! also brings the running window forward. A directory named by
//! `BUREAU_APP_DATA_DIR` is an isolated run (development, smoke tests) and
//! must neither collide with the installed app nor be shared by two
//! processes, so it is guarded by a lock file inside that directory instead.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};

/// The data directory override, when the environment names one.
pub fn data_dir_override() -> Option<PathBuf> {
    std::env::var_os("BUREAU_APP_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub enum Claim {
    /// This process owns the directory for as long as the file stays open.
    Held(File),
    /// Another process already runs on this directory.
    Taken,
    /// The directory cannot be locked (it may not be creatable); starting the
    /// host will report why.
    Unavailable,
}

pub fn claim(app_data_dir: &Path) -> Claim {
    let run = app_data_dir.join("run");
    let lock = fs::create_dir_all(&run).and_then(|()| {
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(run.join("instance.lock"))
    });
    match lock {
        Ok(file) => match file.try_lock() {
            Ok(()) => Claim::Held(file),
            Err(TryLockError::WouldBlock) => Claim::Taken,
            Err(TryLockError::Error(_)) => Claim::Unavailable,
        },
        Err(_) => Claim::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_data_directory_is_claimed_by_one_process_at_a_time() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("isolated");
        let Claim::Held(first) = claim(&dir) else {
            panic!("the first claim holds the directory");
        };
        assert!(matches!(claim(&dir), Claim::Taken));
        assert!(
            matches!(claim(&temp.path().join("other")), Claim::Held(_)),
            "another directory is independent"
        );
        drop(first);
        // Other tests fork child processes; a child forked while the lock was
        // open shares its descriptor until it execs, so the release can take
        // a moment to become visible.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !matches!(claim(&dir), Claim::Held(_)) {
            assert!(std::time::Instant::now() < deadline, "released on exit");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn a_directory_that_cannot_exist_is_left_for_startup_to_report() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("not-a-directory");
        fs::write(&file, "x").unwrap();
        assert!(matches!(claim(&file), Claim::Unavailable));
    }
}
