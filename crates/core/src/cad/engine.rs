//! OpenSCAD as an external engine: finding it, running it under a time limit
//! with cancellation, and reading what it said.
use super::*;
use regex::Regex;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_RENDER_TIMEOUT: Duration = Duration::from_secs(30);
const SHELL_LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
const LOG_HEAD_BYTES: u64 = 16 * 1024;
const LOG_TAIL_BYTES: u64 = 48 * 1024;
const MAX_DIAGNOSTIC_LINES: usize = 12;

pub(crate) struct Engine {
    pub exe: PathBuf,
    pub version: String,
}

pub(crate) struct Run {
    pub ok: bool,
    pub log: String,
    pub timed_out: bool,
    pub cancelled: bool,
}

pub(super) fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

/// Ask a login shell where a program is. Apps started from the desktop do
/// not inherit the PATH a terminal has.
pub(super) fn which_via_shell(shell: &Path, program: &str) -> Option<PathBuf> {
    let temp = tempfile::tempdir().ok()?;
    let run = run(
        shell,
        &["-lic".into(), format!("command -v {program}")],
        SHELL_LOOKUP_TIMEOUT,
        temp.path(),
        &|| false,
    )
    .ok()?;
    run.ok
        .then(|| run.log.lines().rev().find(|line| !line.trim().is_empty()))
        .flatten()
        .map(|line| PathBuf::from(line.trim()))
        .filter(|path| is_executable(path))
}

/// The user's login shell, for `which_via_shell`.
pub(super) fn login_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|shell| is_executable(shell))
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"))
}

fn login_shell_openscad() -> Option<PathBuf> {
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND
        .get_or_init(|| which_via_shell(&login_shell(), "openscad"))
        .clone()
}

fn discover() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("OPENSCAD_PATH").map(PathBuf::from) {
        if is_executable(&path) {
            return Some(path);
        }
    }
    let on_path = || {
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|dir| {
                dir.join(if cfg!(target_os = "windows") {
                    "openscad.exe"
                } else {
                    "openscad"
                })
            })
            .find(|path| is_executable(path))
    };
    let installed: Vec<PathBuf> = if cfg!(target_os = "macos") {
        vec![
            "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD".into(),
            "/opt/homebrew/bin/openscad".into(),
            "/usr/local/bin/openscad".into(),
        ]
    } else if cfg!(target_os = "windows") {
        let mut places = vec![PathBuf::from(r"C:\Program Files\OpenSCAD\openscad.exe")];
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            places.push(PathBuf::from(local).join(r"Programs\OpenSCAD\openscad.exe"));
        }
        places.push(r"C:\Program Files (x86)\OpenSCAD\openscad.exe".into());
        places
    } else {
        vec![
            "/usr/bin/openscad".into(),
            "/usr/local/bin/openscad".into(),
            "/snap/bin/openscad".into(),
        ]
    };
    installed
        .into_iter()
        .find(|path| is_executable(path))
        .or_else(on_path)
        .or_else(|| {
            cfg!(target_os = "macos")
                .then(login_shell_openscad)
                .flatten()
        })
}

/// The executable to use, and a note when the configured one was unusable.
pub(crate) fn locate(configured: Option<&Path>) -> (Option<PathBuf>, Option<String>) {
    match configured {
        Some(path) if is_executable(path) => (Some(path.to_path_buf()), None),
        Some(path) => {
            let found = discover();
            let note = format!(
                "The configured OpenSCAD path {} is not an executable file; {}.",
                path.display(),
                match &found {
                    Some(found) => format!("using {} instead", found.display()),
                    None => "no other installation was found".to_owned(),
                }
            );
            (found, Some(note))
        }
        None => (discover(), None),
    }
}

fn missing(note: Option<String>) -> ContractError {
    let mut error = ContractError::tool_missing("OpenSCAD");
    if let Some(note) = note {
        error.message = format!("{} — {note}", error.message);
    }
    error
}

fn parse_version(log: &str) -> Option<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            Regex::new(r"(?i)OpenSCAD version\s+([0-9][\w.\-]*)").expect("static pattern")
        })
        .captures(log)
        .map(|found| found[1].to_owned())
}

pub(super) type Stamp = (Option<SystemTime>, u64);

pub(super) fn stamp(path: &Path) -> Stamp {
    fs::metadata(path)
        .map(|metadata| (metadata.modified().ok(), metadata.len()))
        .unwrap_or((None, 0))
}

/// The engine and its version. The version is probed once per executable
/// file and again only when that file changes.
pub(crate) fn engine(configured: Option<&Path>) -> CoreResult<Engine> {
    static VERSIONS: OnceLock<Mutex<HashMap<PathBuf, (Stamp, String)>>> = OnceLock::new();
    let (exe, note) = locate(configured);
    let exe = exe.ok_or_else(|| missing(note))?;
    let versions = VERSIONS.get_or_init(Default::default);
    let current = stamp(&exe);
    if let Some((seen, version)) = versions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&exe)
    {
        if *seen == current {
            return Ok(Engine {
                exe,
                version: version.clone(),
            });
        }
    }
    let temp = tempfile::tempdir().map_err(internal)?;
    let probe = run(
        &exe,
        &["--version".into()],
        VERSION_TIMEOUT,
        temp.path(),
        &|| false,
    )?;
    let version = parse_version(&probe.log).filter(|_| probe.ok).ok_or_else(|| {
        ContractError::new(
            "TOOL_MISSING",
            format!(
                "{} did not answer as OpenSCAD: {}",
                exe.display(),
                first_line(&probe.log).unwrap_or("no version output")
            ),
        )
        .with_repair("Set the OpenSCAD executable path in Settings, then retry. An agent cannot change Settings; ask the human.")
        .with_details(json!({"tool": "OpenSCAD", "executablePath": exe}))
    })?;
    versions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(exe.clone(), (current, version.clone()));
    Ok(Engine { exe, version })
}

fn first_line(log: &str) -> Option<&str> {
    log.lines().map(str::trim).find(|line| !line.is_empty())
}

/// Availability as the settings sheet shows it: found, answers with a
/// version, and renders a unit cube.
pub(crate) fn probe(configured: Option<&Path>) -> CoreResult<Value> {
    let (exe, note) = locate(configured);
    let with_note = |mut result: Value| {
        if let Some(note) = &note {
            result["note"] = json!(note);
        }
        result
    };
    let Some(exe) = exe else {
        return Ok(with_note(
            json!({"available":false,"executablePath":null,"version":null,"error":"OpenSCAD not found"}),
        ));
    };
    let temp = tempfile::tempdir().map_err(internal)?;
    let answer = match run(
        &exe,
        &["--version".into()],
        VERSION_TIMEOUT,
        temp.path(),
        &|| false,
    ) {
        Ok(answer) => answer,
        Err(error) => {
            return Ok(with_note(
                json!({"available":false,"executablePath":exe,"version":null,"error":error.message}),
            ))
        }
    };
    let version = parse_version(&answer.log);
    if !answer.ok || answer.timed_out || version.is_none() {
        return Ok(with_note(
            json!({"available":false,"executablePath":exe,"version":version,
            "error":format!("Unrecognized --version output: {}",answer.log.trim())}),
        ));
    }
    let source = temp.path().join("probe.scad");
    let stl = temp.path().join("probe.stl");
    fs::write(&source, "cube(1);\n").map_err(internal)?;
    let render = run(
        &exe,
        &[
            "-o".into(),
            stl.to_string_lossy().into(),
            source.to_string_lossy().into(),
        ],
        PROBE_RENDER_TIMEOUT,
        temp.path(),
        &|| false,
    )?;
    let available = render.ok && stl.metadata().is_ok_and(|m| m.len() > 84);
    Ok(with_note(
        json!({"available":available,"executablePath":exe,"version":version,
        "error": if available { Value::Null } else { json!(format!("probe render failed: {}",render.log.trim())) }}),
    ))
}

/// Running engine processes and the directory each works in.
fn live_engines() -> &'static Mutex<HashMap<u32, PathBuf>> {
    static LIVE: OnceLock<Mutex<HashMap<u32, PathBuf>>> = OnceLock::new();
    LIVE.get_or_init(Default::default)
}

fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn terminate(child: &mut Child) {
    kill_tree(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

/// Kill every engine process this application started. Each runs in its own
/// process group so it does not die with the app unless the app says so.
pub(crate) fn stop_all() {
    stop_where(|_| true);
}

fn stop_where(matches: impl Fn(&Path) -> bool) {
    let live = live_engines()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    for (pid, _) in live.into_iter().filter(|(_, cwd)| matches(cwd)) {
        kill_tree(pid);
    }
}

/// The start and the end of a log, with the middle left out when it is long:
/// an `echo` loop cannot fill memory, and trailing errors are kept.
fn read_log(path: &Path) -> String {
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let length = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut take = |from: u64, bytes: u64| {
        let mut buffer = Vec::new();
        if file.seek(SeekFrom::Start(from)).is_ok() {
            let _ = (&mut file).take(bytes).read_to_end(&mut buffer);
        }
        String::from_utf8_lossy(&buffer).into_owned()
    };
    if length <= LOG_HEAD_BYTES + LOG_TAIL_BYTES {
        return take(0, length);
    }
    let head = take(0, LOG_HEAD_BYTES);
    let tail = take(length - LOG_TAIL_BYTES, LOG_TAIL_BYTES);
    format!(
        "{head}\n… {} bytes of output omitted …\n{tail}",
        length - LOG_HEAD_BYTES - LOG_TAIL_BYTES
    )
}

/// Run a program to completion, to its time limit, or until `cancelled`
/// says stop. Output goes to a file, never a pipe that could fill and block.
pub(crate) fn run(
    exe: &Path,
    args: &[String],
    timeout: Duration,
    cwd: &Path,
    cancelled: &dyn Fn() -> bool,
) -> CoreResult<Run> {
    let log_path = cwd.join(format!("tool-{}.log", uuid::Uuid::new_v4()));
    let output = fs::File::create(&log_path).map_err(internal)?;
    let mut command = Command::new(exe);
    crate::child_env::apply(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(output.try_clone().map_err(internal)?))
        .stderr(Stdio::from(output))
        .spawn()
        .map_err(|error| {
            ContractError::new(
                "TOOL_MISSING",
                format!("Could not start {}: {error}", exe.display()),
            )
            .with_repair("Check the executable path in Settings, then retry. An agent cannot change Settings; ask the human.")
            .with_details(json!({"executablePath": exe}))
        })?;
    let pid = child.id();
    let track = |alive: bool| {
        let mut live = live_engines()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if alive {
            live.insert(pid, cwd.to_path_buf());
        } else {
            live.remove(&pid);
        }
    };
    track(true);
    let start = Instant::now();
    let mut last_cancel_check = Instant::now();
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok((status.success(), false, false)),
            Ok(None) => {}
            Err(error) => {
                terminate(&mut child);
                break Err(internal(error));
            }
        }
        if last_cancel_check.elapsed() >= Duration::from_millis(40) {
            last_cancel_check = Instant::now();
            if cancelled() {
                terminate(&mut child);
                break Ok((false, false, true));
            }
        }
        if start.elapsed() > timeout {
            terminate(&mut child);
            break Ok((false, true, false));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    track(false);
    let log = read_log(&log_path);
    let _ = fs::remove_file(log_path);
    let (ok, timed_out, cancelled) = outcome?;
    Ok(Run {
        ok,
        log,
        timed_out,
        cancelled,
    })
}

/// Warning and error lines of an OpenSCAD log, each once, first twelve.
pub(crate) fn classify(log: &str) -> (Vec<String>, Vec<String>) {
    let mut warnings = Vec::<String>::new();
    let mut errors = Vec::<String>::new();
    for line in log.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let lower = line.to_ascii_lowercase();
        let list = if lower.starts_with("error:")
            || lower.starts_with("execution aborted")
            || lower.starts_with("can't")
            || lower.starts_with("parser error")
            || lower.contains("top level object is empty")
        {
            &mut errors
        } else if lower.starts_with("warning:") || lower.starts_with("deprecated:") {
            &mut warnings
        } else {
            continue;
        };
        if list.len() < MAX_DIAGNOSTIC_LINES && !list.iter().any(|seen| seen == line) {
            list.push(line.to_owned());
        }
    }
    (warnings, errors)
}

fn quoted(line: &str) -> Option<&str> {
    let start = line.find(['\'', '"'])?;
    let quote = line[start..].chars().next()?;
    let rest = &line[start + 1..];
    rest.find(quote).map(|end| &rest[..end])
}

fn line_number(line: &str) -> Option<usize> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"line (\d+)\s*$").expect("static pattern"))
        .captures(line)
        .and_then(|found| found[1].parse().ok())
}

/// What an OpenSCAD message usually means and what to change. `source` is
/// the text that was rendered, so line numbers can be shown with their code.
pub(crate) fn hints(warnings: &[String], errors: &[String], source: &str) -> Vec<String> {
    let lines = source.lines().collect::<Vec<_>>();
    let at = |message: &str| {
        line_number(message)
            .map(|number| {
                let code = lines
                    .get(number.saturating_sub(1))
                    .map(|text| text.trim())
                    .filter(|text| !text.is_empty())
                    .map(|text| format!(": `{}`", text.chars().take(80).collect::<String>()))
                    .unwrap_or_default();
                format!(" (line {number}{code})")
            })
            .unwrap_or_default()
    };
    let mut out = Vec::<String>::new();
    for message in errors.iter().chain(warnings) {
        let lower = message.to_ascii_lowercase();
        let name = quoted(message).unwrap_or("?");
        let hint = if lower.contains("parser error") {
            format!("Syntax error at or just before the reported line{}: look for a missing `;`, `)`, `]` or `}}` on that line or the one above.", at(message))
        } else if lower.contains("top level object is empty") {
            "Nothing was rendered: a difference() removed everything, the only object is an unknown module, or no geometry is instantiated at file scope.".to_owned()
        } else if lower.contains("assertion") && lower.contains("failed") {
            format!("An assert() in the source failed{}: the values violate a constraint the source states.", at(message))
        } else if lower.contains("recursion detected") {
            format!("Module or function {name} calls itself without a stopping condition.")
        } else if lower.contains("unknown variable") {
            format!("Unknown variable {name}{}: a typo, or it is used outside the scope that assigns it. OpenSCAD used undef, so the geometry is not what the source says.", at(message))
        } else if lower.contains("unknown module") {
            format!("Unknown module {name}{}: check the spelling; modules must be defined in this file because include and use are not available.", at(message))
        } else if lower.contains("unknown function") {
            format!(
                "Unknown function {name}{}: check the spelling; it evaluated to undef.",
                at(message)
            )
        } else if lower.contains("unable to convert") {
            format!("An argument is undef or not numeric{}; OpenSCAD fell back to a default shape, so fix it before trusting any measurement.", at(message))
        } else if lower.contains("undefined operation") {
            format!(
                "Arithmetic on an undefined value{}; this usually follows an unknown variable.",
                at(message)
            )
        } else if lower.contains("but was overwritten") {
            format!("{name} is assigned twice{}; OpenSCAD uses the last assignment everywhere in the scope, including above it.", at(message))
        } else if lower.contains("not specified as parameter") {
            format!("{name} is not a parameter of that module{}; check the argument name (for example d, r, h, center).", at(message))
        } else if lower.contains("too many unnamed arguments") {
            format!(
                "Too many positional arguments{}; name the arguments.",
                at(message)
            )
        } else if lower.contains("does not support child modules") {
            format!("A `;` is missing{}: the next object was read as a child of a primitive and dropped.", at(message))
        } else if lower.contains("2-manifold") {
            "The result is not a closed solid: faces that only touch along an edge or a zero-thickness wall. Overlap parts slightly and let cutters pass fully through.".to_owned()
        } else if lower.starts_with("deprecated:") {
            "Deprecated syntax: use the replacement the message names.".to_owned()
        } else {
            continue;
        };
        if !out.contains(&hint) && out.len() < 6 {
            out.push(hint);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_cancelled_run_leaves_no_child_behind() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("child-survived");
        let script = format!("(sleep 1; touch '{}') & wait", marker.display());
        let start = Instant::now();
        let result = run(
            Path::new("/bin/sh"),
            &["-c".into(), script],
            Duration::from_secs(5),
            temp.path(),
            &|| start.elapsed() > Duration::from_millis(100),
        )
        .unwrap();
        assert!(result.cancelled && !result.ok && !result.timed_out);
        std::thread::sleep(Duration::from_millis(1200));
        assert!(!marker.exists(), "engine subprocess survived cancellation");
    }

    #[cfg(unix)]
    #[test]
    fn running_engines_can_be_stopped_from_outside_the_call() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().to_path_buf();
        let stopper = std::thread::spawn({
            let cwd = cwd.clone();
            move || {
                let deadline = Instant::now() + Duration::from_secs(10);
                while Instant::now() < deadline {
                    let running = live_engines()
                        .lock()
                        .unwrap()
                        .values()
                        .any(|dir| *dir == cwd);
                    if running {
                        stop_where(|dir| dir == cwd);
                        return true;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                false
            }
        });
        let start = Instant::now();
        let result = run(
            Path::new("/bin/sh"),
            &["-c".into(), "sleep 30".into()],
            Duration::from_secs(60),
            &cwd,
            &|| false,
        )
        .unwrap();
        assert!(stopper.join().unwrap(), "engine was never registered");
        assert!(!result.ok && !result.timed_out && !result.cancelled);
        assert!(start.elapsed() < Duration::from_secs(20));
        assert!(!live_engines()
            .lock()
            .unwrap()
            .values()
            .any(|dir| *dir == cwd));
    }

    #[cfg(unix)]
    #[test]
    fn a_run_past_its_limit_is_killed_and_reported_as_timed_out() {
        let temp = tempfile::tempdir().unwrap();
        let start = Instant::now();
        let result = run(
            Path::new("/bin/sh"),
            &["-c".into(), "echo started; sleep 30".into()],
            Duration::from_millis(150),
            temp.path(),
            &|| false,
        )
        .unwrap();
        assert!(result.timed_out && !result.ok && !result.cancelled);
        assert!(start.elapsed() < Duration::from_secs(10));
        assert_eq!(result.log.trim(), "started");
    }

    #[cfg(unix)]
    #[test]
    fn long_output_keeps_its_start_and_its_end() {
        let temp = tempfile::tempdir().unwrap();
        let script = "echo FIRST; i=0; while [ $i -lt 4000 ]; do echo 'ECHO: filler line of output for the log reader'; i=$((i+1)); done; echo 'ERROR: last line'";
        let result = run(
            Path::new("/bin/sh"),
            &["-c".into(), script.into()],
            Duration::from_secs(30),
            temp.path(),
            &|| false,
        )
        .unwrap();
        assert!(result.ok);
        assert!(result.log.starts_with("FIRST\n"));
        assert!(result.log.trim_end().ends_with("ERROR: last line"));
        assert!(result.log.contains("bytes of output omitted"));
        assert!(result.log.len() < 70_000);
        assert_eq!(classify(&result.log).1, vec!["ERROR: last line"]);
    }

    #[test]
    fn a_program_that_cannot_start_is_a_missing_tool_with_a_repair() {
        let temp = tempfile::tempdir().unwrap();
        let error = run(
            &temp.path().join("no-such-engine"),
            &[],
            Duration::from_secs(1),
            temp.path(),
            &|| false,
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "TOOL_MISSING");
        assert!(error.repair.unwrap().contains("Settings"));
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_configured_path_falls_back_to_discovery_and_says_so() {
        let temp = tempfile::tempdir().unwrap();
        let stale = temp.path().join("moved-away");
        let (found, note) = locate(Some(&stale));
        let note = note.unwrap();
        assert!(note.contains("is not an executable file"), "{note}");
        assert_eq!(found, discover());
        let (kept, note) = locate(Some(Path::new("/bin/sh")));
        assert_eq!(kept.as_deref(), Some(Path::new("/bin/sh")));
        assert!(note.is_none());
        let unusable = engine(Some(Path::new("/usr/bin/false"))).err().unwrap();
        assert_eq!(unusable.code, "TOOL_MISSING");
        assert!(unusable.message.contains("did not answer as OpenSCAD"));
    }

    #[cfg(unix)]
    #[test]
    fn a_login_shell_can_be_asked_where_a_program_is() {
        let found = which_via_shell(Path::new("/bin/sh"), "sh").unwrap();
        assert!(is_executable(&found));
        assert!(which_via_shell(Path::new("/bin/sh"), "bureau-no-such-program").is_none());
    }

    #[test]
    fn log_lines_are_classified_once_each() {
        let log = "WARNING: Ignoring unknown variable \"w\" in file input.scad, line 1\nWARNING: Ignoring unknown variable \"w\" in file input.scad, line 1\nGeometries in cache: 1\nERROR: Parser error: syntax error in file input.scad, line 3\nCan't parse file 'input.scad'!\n\nCurrent top level object is empty.\nDEPRECATED: child() will be removed\nTRACE: called by 'a'\n";
        let (warnings, errors) = classify(log);
        assert_eq!(warnings.len(), 2);
        assert_eq!(
            errors,
            vec![
                "ERROR: Parser error: syntax error in file input.scad, line 3",
                "Can't parse file 'input.scad'!",
                "Current top level object is empty.",
            ]
        );
    }

    #[test]
    fn messages_are_explained_with_the_source_line_they_point_at() {
        let source = "$fn = 64;\nw = 20;\ncube([width, 10, 2])\nsphere(2);\n";
        let found = hints(
            &[
                "WARNING: Ignoring unknown variable \"width\" in file input.scad, line 3".into(),
                "WARNING: module cube() does not support child modules in file input.scad, line 3".into(),
                "WARNING: \"w\" was assigned on line 1 but was overwritten in file input.scad, line 2".into(),
                "WARNING: something new".into(),
            ],
            &["ERROR: Parser error: syntax error in file input.scad, line 4".into()],
            source,
        );
        assert_eq!(found.len(), 4, "{found:?}");
        assert!(found[0].starts_with(
            "Syntax error at or just before the reported line (line 4: `sphere(2);`)"
        ));
        assert!(found[1].starts_with("Unknown variable width (line 3: `cube([width, 10, 2])`)"));
        assert!(found[2].starts_with("A `;` is missing (line 3"));
        assert!(found[3].starts_with("w is assigned twice (line 2: `w = 20;`)"));
        assert_eq!(
            hints(&[], &["Current top level object is empty.".into()], ""),
            vec!["Nothing was rendered: a difference() removed everything, the only object is an unknown module, or no geometry is instantiated at file scope."]
        );
        assert!(hints(
            &["WARNING: Ignoring unknown module 'plate' in file input.scad, line 9".into()],
            &[],
            ""
        )[0]
        .starts_with("Unknown module plate (line 9)"));
    }
}
