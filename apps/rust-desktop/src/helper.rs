//! The `omenflow` helper an agent CLI runs for every Omen Flow tool call.
//!
//! A bundle downloaded without notarization keeps macOS's quarantine flag on
//! every file inside it. Once the person has opened the app (Open Anyway), the
//! app itself runs, but the system kills a quarantined helper that an agent
//! CLI starts. The app therefore hands agents a byte-for-byte copy it writes
//! into its own data folder. Signed and notarized bundles, development builds
//! and other platforms use the bundled helper directly.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The helper agents should run: the bundled one, or a copy in the data
/// folder when the bundled one is quarantined. A copy that cannot be written
/// leaves the bundled helper in place; the connection test then reports it.
pub fn usable(bundled: &Path, app_data_dir: &Path) -> PathBuf {
    if !quarantined(bundled) {
        return bundled.to_path_buf();
    }
    refresh_copy(bundled, &app_data_dir.join("bin")).unwrap_or_else(|error| {
        eprintln!("omenflow: could not prepare the agent helper: {error}");
        bundled.to_path_buf()
    })
}

/// Writes the helper's bytes, never its extended attributes, into `dir`. An
/// earlier copy is replaced only when the bundled helper changed.
fn refresh_copy(bundled: &Path, dir: &Path) -> io::Result<PathBuf> {
    let bytes = fs::read(bundled)?;
    let copy = dir.join(bundled.file_name().unwrap_or("omenflow".as_ref()));
    if fs::read(&copy).is_ok_and(|current| current == bytes) && !quarantined(&copy) {
        return Ok(copy);
    }
    fs::create_dir_all(dir)?;
    let temp = dir.join(format!(".omenflow-{}.partial", std::process::id()));
    fs::write(&temp, &bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o755))?;
    }
    fs::rename(&temp, &copy)?;
    Ok(copy)
}

#[cfg(target_os = "macos")]
const QUARANTINE: &std::ffi::CStr = c"com.apple.quarantine";

#[cfg(target_os = "macos")]
fn quarantined(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: both strings are NUL-terminated and outlive the call; a null
    // buffer of size 0 asks only whether the attribute exists.
    unsafe {
        libc::getxattr(
            path.as_ptr(),
            QUARANTINE.as_ptr(),
            std::ptr::null_mut(),
            0,
            0,
            0,
        ) >= 0
    }
}

#[cfg(not(target_os = "macos"))]
fn quarantined(_: &Path) -> bool {
    false
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;

    fn quarantine(path: &Path) {
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        let value = b"0083;6ad02c38;Safari;";
        // SAFETY: NUL-terminated strings and a buffer of the stated length.
        let status = unsafe {
            libc::setxattr(
                path.as_ptr(),
                QUARANTINE.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        assert_eq!(status, 0, "{}", io::Error::last_os_error());
    }

    #[test]
    fn a_helper_without_quarantine_is_used_where_it_is() {
        let temp = tempfile::tempdir().unwrap();
        let bundled = temp.path().join("omenflow");
        fs::write(&bundled, b"helper").unwrap();
        assert_eq!(usable(&bundled, &temp.path().join("data")), bundled);
        assert!(!temp.path().join("data").exists());
    }

    #[test]
    fn a_quarantined_helper_is_handed_out_as_a_clean_executable_copy() {
        let temp = tempfile::tempdir().unwrap();
        let bundled = temp.path().join("omenflow");
        fs::write(&bundled, b"helper v1").unwrap();
        quarantine(&bundled);
        let data = temp.path().join("data");

        let copy = usable(&bundled, &data);
        assert_eq!(copy, data.join("bin/omenflow"));
        assert_eq!(fs::read(&copy).unwrap(), b"helper v1");
        assert!(!quarantined(&copy), "the copy carries no quarantine");
        assert!(quarantined(&bundled), "the bundle is left untouched");
        assert_eq!(
            fs::metadata(&copy).unwrap().permissions().mode() & 0o777,
            0o755
        );

        // An unchanged helper keeps its copy; an updated bundle replaces it.
        let first = fs::metadata(&copy).unwrap().modified().unwrap();
        assert_eq!(usable(&bundled, &data), copy);
        assert_eq!(fs::metadata(&copy).unwrap().modified().unwrap(), first);
        fs::write(&bundled, b"helper v2").unwrap();
        quarantine(&bundled);
        assert_eq!(usable(&bundled, &data), copy);
        assert_eq!(fs::read(&copy).unwrap(), b"helper v2");
        assert_eq!(fs::read_dir(data.join("bin")).unwrap().count(), 1);
    }
}
