//! Python with OCP, the OpenCASCADE bindings CadQuery uses: the optional
//! converter behind exact STEP export. Bureau never ships or downloads
//! OpenCASCADE; it looks for a Python the person installed, the way it looks
//! for OpenSCAD: the Settings path, `BUREAU_PYTHON`, the conventional
//! virtual environment `~/.bureau-step` (or `~/.omenflow-step` from before the
//! rename), `python3` and `python` on PATH,
//! the platform's usual places and, on macOS, a login shell. A Python is
//! usable when it imports OCP.
use super::*;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A cold `import OCP` was measured at 7 s.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// site-packages can change without the executable changing, so a failure is
/// trusted only briefly, and only by an export's own search.
const MISSING_TTL: Duration = Duration::from_secs(60);
const MAX_TRIED: usize = 8;
const CHECK_SCRIPT: &str = "import sys, OCP; print('BUREAU-OCP', getattr(OCP, '__version__', 'unknown'), sys.version.split()[0])";
pub(crate) const MISSING: &str = "No Python with OCP (OpenCASCADE) was found";

pub(crate) struct Python {
    pub exe: PathBuf,
    /// The interpreter's version, e.g. "3.12.14".
    pub version: String,
    /// OCP's version, e.g. "7.9.3.1".
    pub ocp: String,
}

pub(crate) struct Search {
    pub found: Option<Python>,
    /// Said when the configured (or `BUREAU_PYTHON`) Python was unusable.
    pub note: Option<String>,
    /// The first candidates that failed, with why.
    pub tried: Vec<(PathBuf, String)>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Os {
    Mac,
    Linux,
    Windows,
}

impl Os {
    fn current() -> Self {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

/// A leading `~/` (or `~\`) is the home folder.
fn expand_home(raw: &str, home: Option<&Path>) -> PathBuf {
    let raw = raw.trim();
    match (raw.strip_prefix("~/").or(raw.strip_prefix("~\\")), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(raw),
    }
}

/// Where to look, in order: the configured path and the environment's, then
/// the places a person usually has a Python, with how many of them were
/// named. Pure, so the order can be tested. macOS's `/usr/bin/python3` is
/// never a candidate unless named: it is the Command Line Tools stub, which
/// can open an install dialog, and too old for OCP anyway.
fn candidates(
    configured: Option<&Path>,
    env: Option<&OsStr>,
    home: Option<&Path>,
    path: Option<&OsStr>,
    os: Os,
) -> (Vec<PathBuf>, usize) {
    let mut out = Vec::new();
    if let Some(configured) = configured.filter(|p| !p.as_os_str().is_empty()) {
        out.push(expand_home(&configured.to_string_lossy(), home));
    }
    if let Some(env) = env.filter(|value| !value.is_empty()) {
        out.push(expand_home(&env.to_string_lossy(), home));
    }
    let automatic = out.len();
    if let Some(home) = home {
        // `~/.omenflow-step` is the same environment made before the rename;
        // a virtual environment cannot be moved, so it is looked for as is.
        for folder in [".bureau-step", ".omenflow-step"] {
            out.push(match os {
                Os::Windows => home.join(format!(r"{folder}\Scripts\python.exe")),
                _ => home.join(folder).join("bin/python3"),
            });
        }
    }
    let names: &[&str] = match os {
        Os::Windows => &["python3.exe", "python.exe"],
        _ => &["python3", "python"],
    };
    if let Some(path) = path {
        for name in names {
            for dir in std::env::split_paths(path) {
                // Windows' WindowsApps "python" opens the Store instead of running.
                if os == Os::Windows
                    && dir
                        .components()
                        .any(|part| part.as_os_str().eq_ignore_ascii_case("WindowsApps"))
                {
                    continue;
                }
                out.push(dir.join(name));
            }
        }
    }
    out.extend(
        match os {
            Os::Mac => vec!["/opt/homebrew/bin/python3", "/usr/local/bin/python3"],
            Os::Linux => vec!["/usr/bin/python3", "/usr/local/bin/python3"],
            Os::Windows => vec![],
        }
        .into_iter()
        .map(PathBuf::from),
    );
    let mut seen = HashSet::new();
    let mut named = 0;
    let listed = out
        .into_iter()
        .enumerate()
        .filter(|(index, candidate)| {
            *index < automatic || !(os == Os::Mac && candidate.starts_with("/usr/bin/"))
        })
        .filter(|(_, candidate)| seen.insert(candidate.clone()))
        .inspect(|(index, _)| named += usize::from(*index < automatic))
        .map(|(_, candidate)| candidate)
        .collect();
    (listed, named)
}

/// The machine's own candidates. Tests never look at this machine's Pythons:
/// they configure the one they mean.
fn machine_candidates(configured: Option<&Path>) -> (Vec<PathBuf>, usize) {
    if cfg!(test) {
        let listed = configured
            .map(Path::to_path_buf)
            .into_iter()
            .collect::<Vec<_>>();
        let named = listed.len();
        return (listed, named);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    candidates(
        configured,
        std::env::var_os("BUREAU_PYTHON").as_deref(),
        home.as_deref(),
        std::env::var_os("PATH").as_deref(),
        Os::current(),
    )
}

/// A login shell's `python3`, asked once: apps started from the desktop do
/// not inherit the PATH a terminal has.
fn login_shell_python() -> Option<PathBuf> {
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND
        .get_or_init(|| engine::which_via_shell(&engine::login_shell(), "python3"))
        .clone()
        .filter(|path| !path.starts_with("/usr/bin/"))
}

enum Checked {
    Usable { ocp: String, python: String },
    Unusable(String),
    Cancelled,
}

type Remembered = (engine::Stamp, Instant, Result<(String, String), String>);

fn checks() -> &'static Mutex<HashMap<PathBuf, Remembered>> {
    static CHECKS: OnceLock<Mutex<HashMap<PathBuf, Remembered>>> = OnceLock::new();
    CHECKS.get_or_init(Default::default)
}

fn answer_line(log: &str) -> Option<(String, String)> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern =
        PATTERN.get_or_init(|| Regex::new(r"^BUREAU-OCP (\S+) (\S+)$").expect("static pattern"));
    log.lines().find_map(|line| {
        pattern
            .captures(line.trim())
            .map(|found| (found[1].to_owned(), found[2].to_owned()))
    })
}

fn last_line(log: &str) -> Option<&str> {
    log.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
}

/// Can `exe` import OCP? An export's search remembers a success until the
/// executable file changes, and a failure for `ttl`. An explicit check
/// (Settings, `tool_doctor`) always asks again: pip changes site-packages,
/// not the interpreter a virtual environment links to. A cancelled or
/// timed-out check is never remembered: it says nothing about the Python.
fn check_with(
    exe: &Path,
    cancelled: &dyn Fn() -> bool,
    timeout: Duration,
    explicit: bool,
    ttl: Duration,
) -> Checked {
    let current = engine::stamp(exe);
    if let Some((stamp, at, result)) = checks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(exe)
    {
        if *stamp == current && !explicit {
            match result {
                Ok((ocp, python)) => {
                    return Checked::Usable {
                        ocp: ocp.clone(),
                        python: python.clone(),
                    }
                }
                Err(error) if at.elapsed() < ttl => return Checked::Unusable(error.clone()),
                Err(_) => {}
            }
        }
    }
    let remember = |result: Result<(String, String), String>| {
        checks()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(exe.to_path_buf(), (current, Instant::now(), result));
    };
    if !engine::is_executable(exe) {
        let error = "not an executable file".to_owned();
        remember(Err(error.clone()));
        return Checked::Unusable(error);
    }
    let Ok(temp) = tempfile::tempdir() else {
        return Checked::Unusable("no temporary folder to run it in".into());
    };
    // -E ignores PYTHON* variables; -I is not used, because it would also
    // hide the user site-packages where `pip install --user` puts OCP.
    let run = match engine::run(
        exe,
        &["-E".into(), "-c".into(), CHECK_SCRIPT.into()],
        timeout,
        temp.path(),
        cancelled,
    ) {
        Ok(run) => run,
        Err(error) => {
            remember(Err(error.message.clone()));
            return Checked::Unusable(error.message);
        }
    };
    if run.cancelled {
        return Checked::Cancelled;
    }
    if run.timed_out {
        return Checked::Unusable(format!(
            "it did not answer within {} s",
            timeout.as_secs_f64().ceil()
        ));
    }
    match answer_line(&run.log).filter(|_| run.ok) {
        Some((ocp, python)) => {
            remember(Ok((ocp.clone(), python.clone())));
            Checked::Usable { ocp, python }
        }
        None => {
            let error = last_line(&run.log)
                .unwrap_or("it exited without importing OCP")
                .chars()
                .take(300)
                .collect::<String>();
            remember(Err(error.clone()));
            Checked::Unusable(error)
        }
    }
}

fn check(exe: &Path, cancelled: &dyn Fn() -> bool, timeout: Duration, explicit: bool) -> Checked {
    check_with(exe, cancelled, timeout, explicit, MISSING_TTL)
}

/// Forget what was remembered about `exe`: the converter found it cannot
/// import OCP after all.
pub(crate) fn forget(exe: &Path) {
    checks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(exe);
}

/// The first candidate that imports OCP. `deadline` bounds the whole search;
/// `explicit` asks every Python again, whatever was remembered. Fails only
/// when cancelled.
pub(crate) fn find(
    configured: Option<&Path>,
    cancelled: &dyn Fn() -> bool,
    deadline: Option<Instant>,
    explicit: bool,
) -> CoreResult<Search> {
    let configured = configured.filter(|p| !p.as_os_str().is_empty());
    let (listed, named) = machine_candidates(configured);
    find_in(listed, named, cancelled, deadline, explicit)
}

/// `named` leading candidates were named by the person (Settings, the
/// environment); a missing one of those is reported, other missing places are
/// skipped.
fn find_in(
    listed: Vec<PathBuf>,
    named: usize,
    cancelled: &dyn Fn() -> bool,
    deadline: Option<Instant>,
    explicit: bool,
) -> CoreResult<Search> {
    let mut tried = Vec::<(PathBuf, String)>::new();
    let mut seen = HashSet::new();
    let login = !cfg!(test) && Os::current() == Os::Mac;
    let mut queue = listed.into_iter().map(Some).collect::<Vec<_>>();
    if login {
        queue.push(None);
    }
    let mut found = None;
    for (index, entry) in queue.into_iter().enumerate() {
        let Some(candidate) = entry.or_else(|| login.then(login_shell_python).flatten()) else {
            continue;
        };
        // A path listed twice is asked once. Paths are not resolved first: a virtual
        // environment's python links to its base interpreter but runs with the environment's
        // own site-packages, where OCP may be.
        if !seen.insert(candidate.clone()) {
            continue;
        }
        if index >= named && !engine::is_executable(&candidate) {
            continue;
        }
        let timeout = match deadline {
            Some(deadline) => CHECK_TIMEOUT.min(deadline.saturating_duration_since(Instant::now())),
            None => CHECK_TIMEOUT,
        };
        if timeout.is_zero() {
            tried.push((
                candidate,
                "the export's time limit was reached first".into(),
            ));
            break;
        }
        match check(&candidate, cancelled, timeout, explicit) {
            Checked::Usable { ocp, python } => {
                found = Some(Python {
                    exe: candidate,
                    version: python,
                    ocp,
                });
                break;
            }
            Checked::Unusable(error) => tried.push((candidate, error)),
            Checked::Cancelled => {
                return Err(ContractError::new(
                    "CANCELLED",
                    "STEP export was cancelled; nothing was written.",
                ))
            }
        }
    }
    let note = tried.first().filter(|_| named > 0).map(|(path, error)| {
        format!(
            "The configured Python {} cannot import OCP ({error}); {}.",
            path.display(),
            match &found {
                Some(found) => format!("using {} instead", found.exe.display()),
                None => "no other Python with OCP was found".to_owned(),
            }
        )
    });
    tried.truncate(MAX_TRIED);
    Ok(Search { found, note, tried })
}

/// Availability as Settings and `tool_doctor` show it. Always asks again.
pub(crate) fn probe(configured: Option<&Path>) -> Value {
    let search = match find(configured, &|| false, None, true) {
        Ok(search) => search,
        Err(error) => return json!({"available": false, "error": error.message}),
    };
    let tried = search
        .tried
        .iter()
        .map(|(path, error)| json!({"path": path, "error": error}))
        .collect::<Vec<_>>();
    let mut result = match &search.found {
        Some(python) => json!({"available": true, "executablePath": python.exe,
            "version": python.version, "ocp": python.ocp, "error": null, "tried": tried}),
        None => json!({"available": false, "executablePath": null, "version": null,
            "ocp": null, "error": MISSING, "tried": tried}),
    };
    if let Some(note) = search.note {
        result["note"] = json!(note);
    }
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in Python: a shell script that answers like `import OCP` would,
    /// and counts how often it was asked.
    fn fake(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        let count = dir.join(format!("{name}.calls"));
        fs::write(
            &path,
            format!("#!/bin/sh\necho x >> '{}'\n{body}\n", count.display()),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn calls(path: &Path) -> usize {
        fs::read_to_string(format!("{}.calls", path.display()))
            .map(|text| text.lines().count())
            .unwrap_or(0)
    }

    const WITH_OCP: &str = "[ \"$1\" = \"-E\" ] || exit 3\necho 'BUREAU-OCP 7.9.3.1 3.12.14'";
    const WITHOUT_OCP: &str = "echo 'Traceback (most recent call last):' >&2\necho \"ModuleNotFoundError: No module named 'OCP'\" >&2\nexit 1";

    #[test]
    fn candidates_follow_settings_environment_convention_path_and_platform() {
        let home = Path::new("/Users/me");
        let path =
            std::env::join_paths(["/opt/homebrew/bin", "/usr/bin", "/opt/homebrew/bin"]).unwrap();
        let (mac, named) = candidates(
            Some(Path::new("~/venvs/ocp/bin/python")),
            Some(OsStr::new("~/other/python3")),
            Some(home),
            Some(&path),
            Os::Mac,
        );
        assert_eq!(
            mac,
            [
                "/Users/me/venvs/ocp/bin/python",
                "/Users/me/other/python3",
                "/Users/me/.bureau-step/bin/python3",
                "/Users/me/.omenflow-step/bin/python3",
                "/opt/homebrew/bin/python3",
                "/opt/homebrew/bin/python",
                "/usr/local/bin/python3",
            ]
            .map(PathBuf::from)
        );
        assert_eq!(named, 2);
        // The Command Line Tools stub is used on macOS only when someone names it.
        let (named, _) = candidates(
            Some(Path::new("/usr/bin/python3")),
            None,
            None,
            Some(&path),
            Os::Mac,
        );
        assert_eq!(named[0], PathBuf::from("/usr/bin/python3"));
        assert_eq!(
            named.iter().filter(|p| p.starts_with("/usr/bin/")).count(),
            1
        );
        let (linux, none) = candidates(None, None, Some(home), Some(&path), Os::Linux);
        assert_eq!(none, 0);
        assert_eq!(
            linux[0],
            PathBuf::from("/Users/me/.bureau-step/bin/python3")
        );
        assert!(linux.contains(&PathBuf::from("/usr/bin/python3")));
        assert_eq!(
            linux.len(),
            linux.iter().collect::<HashSet<_>>().len(),
            "no candidate is listed twice"
        );
        let (windows, _) = candidates(
            None,
            None,
            Some(Path::new(r"C:\Users\me")),
            // PATH as this test's platform splits it.
            Some(OsStr::new(
                "/c/Users/me/AppData/Local/Microsoft/WindowsApps",
            )),
            Os::Windows,
        );
        assert_eq!(windows.len(), 2, "{windows:?}");
        assert!(windows[0]
            .to_string_lossy()
            .ends_with(r".bureau-step\Scripts\python.exe"));
        assert!(windows[1]
            .to_string_lossy()
            .ends_with(r".omenflow-step\Scripts\python.exe"));
        assert_eq!(
            expand_home(" ~/x/python3 ", Some(home)),
            PathBuf::from("/Users/me/x/python3")
        );
        assert_eq!(expand_home("~/x", None), PathBuf::from("~/x"));
    }

    #[test]
    fn a_python_that_imports_ocp_is_found_with_its_versions() {
        let dir = tempfile::tempdir().unwrap();
        let python = fake(dir.path(), "python3", WITH_OCP);
        let search = find(Some(&python), &|| false, None, false).unwrap();
        let found = search.found.unwrap();
        assert_eq!(found.exe, python);
        assert_eq!(
            (found.ocp.as_str(), found.version.as_str()),
            ("7.9.3.1", "3.12.14")
        );
        assert!(search.note.is_none() && search.tried.is_empty());
    }

    #[test]
    fn a_python_without_ocp_is_named_and_the_search_goes_on() {
        let dir = tempfile::tempdir().unwrap();
        let bare = fake(dir.path(), "bare", WITHOUT_OCP);
        let good = fake(dir.path(), "good", WITH_OCP);
        let search = find_in(vec![bare.clone(), good.clone()], 1, &|| false, None, false).unwrap();
        assert_eq!(search.found.unwrap().exe, good);
        assert_eq!(search.tried[0].0, bare);
        assert_eq!(
            search.tried[0].1,
            "ModuleNotFoundError: No module named 'OCP'"
        );
        let note = search.note.unwrap();
        assert!(
            note.starts_with(&format!(
                "The configured Python {} cannot import OCP (ModuleNotFoundError",
                bare.display()
            )),
            "{note}"
        );
        assert!(
            note.ends_with(&format!("using {} instead.", good.display())),
            "{note}"
        );
        let alone = find_in(vec![bare.clone()], 1, &|| false, None, false).unwrap();
        assert!(alone.found.is_none());
        assert!(alone
            .note
            .unwrap()
            .ends_with("no other Python with OCP was found."));
        // An unnamed candidate that fails is listed, not announced.
        assert!(find_in(vec![bare], 0, &|| false, None, false)
            .unwrap()
            .note
            .is_none());
    }

    #[test]
    fn a_virtual_environment_is_asked_even_after_the_interpreter_it_links_to() {
        // A venv's python is a link to its base interpreter, which runs with the venv's own
        // site-packages when started by that name. The stand-in answers by the name it was
        // started as, as Python finds its pyvenv.cfg.
        let dir = tempfile::tempdir().unwrap();
        let base = fake(
            dir.path(),
            "python3",
            &format!("case \"$0\" in\n*/venv/bin/*) {WITH_OCP} ;;\n*) {WITHOUT_OCP} ;;\nesac"),
        );
        let venv = dir.path().join("venv/bin/python3");
        fs::create_dir_all(venv.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&base, &venv).unwrap();
        assert_eq!(
            bureau_storage::canonicalize(&venv).unwrap(),
            bureau_storage::canonicalize(&base).unwrap()
        );
        let search = find_in(
            vec![base.clone(), base.clone(), venv.clone()],
            0,
            &|| false,
            None,
            true,
        )
        .unwrap();
        assert_eq!(search.found.unwrap().exe, venv);
        // The base was asked once, though listed twice.
        assert_eq!(search.tried.len(), 1);
        assert_eq!(search.tried[0].0, base);
        assert_eq!(calls(&base), 2);
    }

    #[test]
    fn answers_are_remembered_until_the_executable_changes() {
        let dir = tempfile::tempdir().unwrap();
        let python = fake(dir.path(), "python3", WITH_OCP);
        for _ in 0..3 {
            assert!(matches!(
                check(&python, &|| false, CHECK_TIMEOUT, false),
                Checked::Usable { .. }
            ));
        }
        assert_eq!(calls(&python), 1, "a success is remembered");
        // A rewritten executable is asked again.
        fs::write(
            &python,
            format!(
                "#!/bin/sh\necho x >> '{}.calls'\n{WITHOUT_OCP}\n",
                python.display()
            ),
        )
        .unwrap();
        assert!(matches!(
            check(&python, &|| false, CHECK_TIMEOUT, false),
            Checked::Unusable(_)
        ));
        assert_eq!(calls(&python), 2);
        // A failure is trusted for a while by an export's search ...
        assert!(matches!(
            check_with(
                &python,
                &|| false,
                CHECK_TIMEOUT,
                false,
                Duration::from_secs(60)
            ),
            Checked::Unusable(_)
        ));
        assert_eq!(calls(&python), 2);
        // ... not once it is older than that, and never by an explicit check.
        let _ = check_with(&python, &|| false, CHECK_TIMEOUT, false, Duration::ZERO);
        assert_eq!(calls(&python), 3);
        let _ = check(&python, &|| false, CHECK_TIMEOUT, true);
        assert_eq!(calls(&python), 4);
    }

    #[test]
    fn an_explicit_check_asks_again_after_a_success() {
        // pip changes site-packages, not the interpreter a virtual environment links to:
        // here OCP is a file beside the stand-in, which never changes.
        let dir = tempfile::tempdir().unwrap();
        let site = dir.path().join("site-packages-OCP");
        fs::write(&site, "").unwrap();
        let python = fake(
            dir.path(),
            "python3",
            &format!(
                "if [ -f '{}' ]; then\n{WITH_OCP}\nelse\n{WITHOUT_OCP}\nfi",
                site.display()
            ),
        );
        assert!(matches!(
            check(&python, &|| false, CHECK_TIMEOUT, false),
            Checked::Usable { .. }
        ));
        fs::remove_file(&site).unwrap();
        // An export's search still trusts the success; Settings and tool_doctor ask again.
        assert!(matches!(
            check(&python, &|| false, CHECK_TIMEOUT, false),
            Checked::Usable { .. }
        ));
        assert_eq!(calls(&python), 1);
        assert!(matches!(
            check(&python, &|| false, CHECK_TIMEOUT, true),
            Checked::Unusable(error) if error.contains("No module named 'OCP'")
        ));
        assert_eq!(calls(&python), 2);
        // Installed again, it is found again at once.
        fs::write(&site, "").unwrap();
        assert!(matches!(
            check(&python, &|| false, CHECK_TIMEOUT, true),
            Checked::Usable { .. }
        ));
        // What the converter finds at import is forgotten, so the next search asks too.
        forget(&python);
        assert!(checks().lock().unwrap().get(&python).is_none());
    }

    #[test]
    fn a_cancelled_or_slow_check_is_not_remembered() {
        let dir = tempfile::tempdir().unwrap();
        let slow = fake(dir.path(), "slow", &format!("sleep 5\n{WITH_OCP}"));
        let start = Instant::now();
        assert!(matches!(
            check(
                &slow,
                &|| start.elapsed() > Duration::from_millis(100),
                CHECK_TIMEOUT,
                false
            ),
            Checked::Cancelled
        ));
        assert!(matches!(
            check(&slow, &|| false, Duration::from_millis(200), false),
            Checked::Unusable(error) if error.contains("did not answer")
        ));
        assert!(checks().lock().unwrap().get(&slow).is_none());
        let error = find_in(vec![slow], 1, &|| true, None, false).err().unwrap();
        assert_eq!(error.code, "CANCELLED");
    }

    #[test]
    fn the_probe_reports_what_tool_doctor_shows() {
        let dir = tempfile::tempdir().unwrap();
        let python = fake(dir.path(), "python3", WITH_OCP);
        let probe = probe(Some(&python));
        assert_eq!(probe["available"], true, "{probe}");
        assert_eq!(probe["ocp"], "7.9.3.1");
        assert_eq!(probe["version"], "3.12.14");
        assert_eq!(probe["executablePath"], json!(python));
        let missing = super::probe(Some(&dir.path().join("nowhere")));
        assert_eq!(missing["available"], false);
        assert_eq!(missing["error"], MISSING);
        assert_eq!(missing["tried"][0]["error"], "not an executable file");
        assert!(missing["note"]
            .as_str()
            .unwrap()
            .contains("cannot import OCP (not an executable file)"));
    }
}
