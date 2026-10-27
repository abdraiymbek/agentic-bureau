//! The environment of processes this app starts for the person: agent CLIs
//! in a terminal, the login shell asked for its PATH, version probes and
//! OpenSCAD.
//!
//! An AppImage's launcher points this process at the libraries and data
//! inside the image: `LD_LIBRARY_PATH`, `PATH`, `PYTHONHOME`, `PYTHONPATH`,
//! `XDG_DATA_DIRS`, the GTK, GIO, GStreamer and Qt module paths, and it
//! forces `GDK_BACKEND=x11` and an Adwaita `GTK_THEME`. That is right for the
//! app's own GTK and WebKit, and wrong for anything else: a `python3` an
//! agent runs finds no standard library under `PYTHONHOME`, the person's
//! tools load the image's libraries, and every entry disappears when the app
//! quits. Children get the environment without those changes. Outside an
//! AppImage nothing is changed.

use std::path::{Path, PathBuf};

/// Variables the AppImage runtime itself sets, which describe this process
/// only.
const RUNTIME: [&str; 4] = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/// The folder the running AppImage is unpacked or mounted at, when this
/// process runs from one: `APPDIR` and `APPIMAGE` are both set, and `APPDIR`
/// is an absolute path that is not the root.
pub fn appimage_dir_in(vars: &[(String, String)]) -> Option<PathBuf> {
    let get = |name: &str| {
        vars.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
            .filter(|value| !value.is_empty())
    };
    get("APPIMAGE")?;
    let dir = Path::new(get("APPDIR")?.trim_end_matches('/'));
    (dir.is_absolute() && dir.parent().is_some()).then(|| dir.to_owned())
}

/// The AppImage folder of this process, if it runs from one.
pub fn appimage_dir() -> Option<PathBuf> {
    appimage_dir_in(&std::env::vars().collect::<Vec<_>>())
}

/// Whether `path` lies inside `dir` (or is it). Paths written with doubled
/// slashes, as AppImage launchers do, count.
pub fn is_inside(path: &Path, dir: &Path) -> bool {
    let normal = |path: &Path| path.components().collect::<PathBuf>();
    normal(path).starts_with(normal(dir))
}

/// What to change in `vars` for a child process: `(name, Some(value))` to
/// set, `(name, None)` to remove. Empty outside an AppImage.
pub fn edits_in(vars: &[(String, String)]) -> Vec<(String, Option<String>)> {
    let Some(dir) = appimage_dir_in(vars) else {
        return Vec::new();
    };
    let mut edits = Vec::new();
    for (key, value) in vars {
        if RUNTIME.contains(&key.as_str())
            // Set unconditionally by the GTK hook of the AppImage launcher;
            // whatever the person had is already lost.
            || (key == "GDK_BACKEND" && value == "x11")
            || (key == "GTK_THEME" && value.starts_with("Adwaita:"))
        {
            edits.push((key.clone(), None));
            continue;
        }
        // Every variable is treated as a list of paths: a single path is a
        // list of one, and a value that is not a path never lies inside.
        let entries: Vec<&str> = value.split(':').collect();
        if !entries
            .iter()
            .any(|entry| !entry.is_empty() && is_inside(Path::new(entry), &dir))
        {
            continue;
        }
        let kept: Vec<&str> = entries
            .into_iter()
            .filter(|entry| !entry.is_empty() && !is_inside(Path::new(entry), &dir))
            .collect();
        edits.push((key.clone(), (!kept.is_empty()).then(|| kept.join(":"))));
    }
    edits
}

/// Give a command the environment of the person's session (see the module
/// documentation). The launcher also changes into the image, so a child
/// that would start there starts in the person's home folder instead.
/// Variables and a working folder the caller sets afterwards still win.
pub fn apply(command: &mut std::process::Command) {
    let vars: Vec<(String, String)> = std::env::vars().collect();
    let Some(image) = appimage_dir_in(&vars) else {
        return;
    };
    for (key, value) in edits_in(&vars) {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
    if let Ok(current) = std::env::current_dir() {
        if let Some(dir) = working_dir_in(&vars, &current, &image) {
            command.current_dir(dir);
        }
    }
}

/// Where a child should start instead of `current`, when `current` is inside
/// the image: the home folder, else the root.
fn working_dir_in(vars: &[(String, String)], current: &Path, image: &Path) -> Option<PathBuf> {
    if !is_inside(current, image) {
        return None;
    }
    let home = vars
        .iter()
        .find(|(key, _)| key == "HOME")
        .map(|(_, value)| PathBuf::from(value))
        .filter(|home| home.is_absolute() && home.is_dir() && !is_inside(home, image));
    Some(home.unwrap_or_else(|| PathBuf::from("/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = "/tmp/appimage_extracted_6af0d8d9";

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn edit<'a>(edits: &'a [(String, Option<String>)], key: &str) -> Option<&'a Option<String>> {
        edits
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    /// Recorded from the packaged Bureau AppImage (linuxdeploy GTK hook
    /// and the AppImageKit launcher) on Ubuntu 24.04, unpacked to /tmp.
    fn appimage_session() -> Vec<(String, String)> {
        vars(&[
            ("APPDIR", DIR),
            ("APPIMAGE", "/home/ana/Apps/Bureau_1.0.0_aarch64.AppImage"),
            ("ARGV0", "/home/ana/Apps/Bureau_1.0.0_aarch64.AppImage"),
            ("GDK_BACKEND", "x11"),
            ("GTK_THEME", "Adwaita:light"),
            ("GDK_PIXBUF_MODULE_FILE", &format!("{DIR}//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache")),
            ("GIO_EXTRA_MODULES", &format!("{DIR}/usr/lib/aarch64-linux-gnu/gio/modules")),
            ("GST_PLUGIN_SYSTEM_PATH_1_0", &format!("{DIR}/usr/lib/gstreamer-1.0:")),
            ("LD_LIBRARY_PATH", &format!("{DIR}/usr/lib/:{DIR}/usr/lib/x86_64-linux-gnu/:{DIR}/lib64/:")),
            ("PATH", &format!("{DIR}/usr/bin/:{DIR}/usr/sbin/:/home/ana/.local/bin:/usr/local/bin:/usr/bin:/bin")),
            ("PYTHONHOME", &format!("{DIR}/usr/")),
            ("PYTHONPATH", &format!("{DIR}/usr/share/pyshared/:")),
            ("XDG_DATA_DIRS", &format!("{DIR}/usr/share/:{DIR}/usr/share:/usr/share:/usr/local/share")),
            ("HOME", "/home/ana"),
            ("SHELL", "/bin/bash"),
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("APPDIR_LIKE", "/tmp/appimage_extracted_6af0d8d9-other/usr"),
        ])
    }

    #[test]
    fn children_of_an_appimage_get_the_session_environment_back() {
        let edits = edits_in(&appimage_session());
        for removed in [
            "APPDIR",
            "APPIMAGE",
            "ARGV0",
            "GDK_BACKEND",
            "GTK_THEME",
            "GDK_PIXBUF_MODULE_FILE",
            "GIO_EXTRA_MODULES",
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            "LD_LIBRARY_PATH",
            "PYTHONHOME",
            "PYTHONPATH",
        ] {
            assert_eq!(edit(&edits, removed), Some(&None), "{removed}");
        }
        assert_eq!(
            edit(&edits, "PATH"),
            Some(&Some(
                "/home/ana/.local/bin:/usr/local/bin:/usr/bin:/bin".into()
            ))
        );
        assert_eq!(
            edit(&edits, "XDG_DATA_DIRS"),
            Some(&Some("/usr/share:/usr/local/share".into()))
        );
        for kept in ["HOME", "SHELL", "WAYLAND_DISPLAY", "APPDIR_LIKE"] {
            assert_eq!(edit(&edits, kept), None, "{kept} is the person's own");
        }
    }

    #[test]
    fn outside_an_appimage_nothing_changes() {
        let mut session = appimage_session();
        session.retain(|(key, _)| key != "APPIMAGE");
        assert!(
            edits_in(&session).is_empty(),
            "APPDIR alone is not an AppImage"
        );
        assert!(edits_in(&vars(&[("APPIMAGE", "/a.AppImage"), ("APPDIR", "/")])).is_empty());
        assert!(edits_in(&vars(&[
            ("APPIMAGE", "/a.AppImage"),
            ("APPDIR", "relative")
        ]))
        .is_empty());
        assert!(edits_in(&vars(&[("PATH", "/usr/bin"), ("GDK_BACKEND", "x11")])).is_empty());
    }

    #[test]
    fn a_choice_the_hook_did_not_make_is_kept() {
        let session = vars(&[
            ("APPDIR", DIR),
            ("APPIMAGE", "/a.AppImage"),
            ("GDK_BACKEND", "wayland"),
            ("GTK_THEME", "Yaru-dark"),
        ]);
        let edits = edits_in(&session);
        assert_eq!(edit(&edits, "GDK_BACKEND"), None);
        assert_eq!(edit(&edits, "GTK_THEME"), None);
    }

    #[test]
    fn a_child_never_starts_inside_the_image() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_string_lossy().into_owned();
        let image = Path::new(DIR);
        let inside = Path::new(DIR).join("usr");
        let session = vars(&[("HOME", &home)]);
        assert_eq!(
            working_dir_in(&session, &inside, image),
            Some(temp.path().to_owned())
        );
        assert_eq!(
            working_dir_in(&vars(&[("HOME", "/no/such/home")]), &inside, image),
            Some(PathBuf::from("/"))
        );
        assert_eq!(
            working_dir_in(&session, temp.path(), image),
            None,
            "a folder outside the image is kept"
        );
    }

    #[test]
    fn insideness_is_by_path_component() {
        let dir = Path::new("/tmp/.mount_BureauX");
        assert!(is_inside(Path::new("/tmp/.mount_BureauX//usr/lib"), dir));
        assert!(is_inside(Path::new("/tmp/.mount_BureauX/"), dir));
        assert!(!is_inside(Path::new("/tmp/.mount_BureauXy/usr"), dir));
        assert!(!is_inside(Path::new("usr/lib"), dir));
    }
}
