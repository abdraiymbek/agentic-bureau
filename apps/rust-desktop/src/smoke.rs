//! A bridge grant for the packaged smoke test.
//!
//! Only an isolated run can ask for it: `OMENFLOW_SMOKE_PROJECT` is honoured
//! when `OMENFLOW_APP_DATA_DIR` also names a data directory, never on a
//! normal launch. The app then creates that project and writes the agent
//! credentials a terminal session would receive to
//! `<data>/run/smoke-grant.json` (owner-only), so the smoke can drive the
//! bundled `omenflow` helper through the real agent path. The grant names
//! the helper the app resolved (`cliPath`), the one an agent session would
//! get on its PATH, so the smoke also proves where the package keeps it.
//!
//! Two more requests are honoured on the same terms:
//!
//! - `OMENFLOW_SMOKE_AGENT` names an executable that is started in the smoke
//!   project's Agent tab as a Custom CLI: a stand-in agent with a real PTY,
//!   its own process group and the session's bridge credentials. Its pid
//!   (the group's id) is in the grant as `agentPid`, so the smoke can check
//!   that quitting the app ends the group.
//! - `OMENFLOW_SMOKE_SNAPSHOT` asks for a picture of the main window, taken
//!   the way the research screenshot is (`capture`), when the smoke creates
//!   `<data>/run/smoke-snapshot.request` (so it shows the same moment as the
//!   smoke's own screen capture): `<data>/run/smoke-snapshot.png`, or the
//!   reason in `<data>/run/smoke-snapshot.txt`.

use crate::capture;
use omenflow_agent_host::Host;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn path_from(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn requested_project() -> Option<PathBuf> {
    path_from("OMENFLOW_SMOKE_PROJECT")
}

pub fn requested_agent() -> Option<PathBuf> {
    path_from("OMENFLOW_SMOKE_AGENT")
}

pub fn snapshot_requested() -> bool {
    std::env::var_os("OMENFLOW_SMOKE_SNAPSHOT").is_some_and(|value| !value.is_empty())
}

/// Write `contents` to `file` so a reader never sees half of it.
fn publish(file: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut partial = file.as_os_str().to_owned();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    fs::write(&partial, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&partial, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&partial, file)
}

/// Picture the main window when the smoke asks for it, on a thread of its
/// own (capturing waits on the interface thread). A picture that is still
/// only the background colour is taken again for a few seconds.
pub fn snapshot_on_request(window: tauri::WebviewWindow, app_data_dir: &Path) {
    let run = app_data_dir.join("run");
    std::thread::spawn(move || {
        let request = run.join("smoke-snapshot.request");
        let asked_by = Instant::now() + Duration::from_secs(180);
        while !request.exists() {
            if Instant::now() > asked_by {
                let _ = publish(
                    &run.join("smoke-snapshot.txt"),
                    b"no snapshot was requested within 180 seconds",
                );
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let until = Instant::now() + Duration::from_secs(10);
        let outcome = loop {
            let attempt = capture::window_image(&window);
            let drawn = matches!(&attempt, Ok(image) if image.pixels().any(|pixel| pixel != image.get_pixel(0, 0)));
            if drawn || Instant::now() > until {
                break attempt;
            }
            std::thread::sleep(Duration::from_millis(500));
        };
        let written = match outcome {
            Ok(image) => {
                let mut png = std::io::Cursor::new(Vec::new());
                image::DynamicImage::ImageRgba8(image)
                    .write_to(&mut png, image::ImageFormat::Png)
                    .map_err(|error| error.to_string())
                    .and_then(|()| {
                        publish(&run.join("smoke-snapshot.png"), &png.into_inner())
                            .map_err(|error| error.to_string())
                    })
            }
            Err(failure) => Err(format!("{failure:?}")),
        };
        if let Err(reason) = written {
            let _ = publish(&run.join("smoke-snapshot.txt"), reason.as_bytes());
        }
    });
}

/// Create the project and write the grant, or the reason there is none.
/// Returns the file written.
pub fn write_grant(
    host: &Host,
    app_data_dir: &Path,
    project_dir: &Path,
    cli_path: &Path,
    agent: Option<&Path>,
) -> std::io::Result<PathBuf> {
    let grant = match grant(host, project_dir, cli_path, agent) {
        Ok(grant) => grant,
        Err(message) => json!({ "error": message }),
    };
    let run = app_data_dir.join("run");
    fs::create_dir_all(&run)?;
    let file = run.join("smoke-grant.json");
    publish(&file, grant.to_string().as_bytes())?;
    Ok(file)
}

fn failed(op: &str, response: omenflow_contracts::ResponseEnvelope) -> String {
    match response.error {
        Some(error) => format!("{op}: {}: {}", error.code, error.message),
        None => format!("{op} failed without an error"),
    }
}

fn grant(
    host: &Host,
    project_dir: &Path,
    cli_path: &Path,
    agent: Option<&Path>,
) -> Result<Value, String> {
    let created = host.command(
        "project.create",
        json!({ "path": project_dir, "name": "Packaged smoke", "intent": "Packaged smoke test" }),
        None,
        None,
    );
    let project_id = match (created.ok, created.result, created.error) {
        (true, Some(result), _) => result["projectId"]
            .as_str()
            .map(str::to_owned)
            .ok_or("project.create returned no projectId")?,
        (_, _, Some(error)) => return Err(format!("{}: {}", error.code, error.message)),
        _ => return Err("project.create failed without an error".into()),
    };
    let session_id = uuid::Uuid::new_v4().to_string();
    let token = host.bridge().issue_token(&project_id, &session_id);
    let mut grant = json!({
        "projectId": project_id,
        "sessionId": session_id,
        "token": token,
        "socketPath": host.bridge().socket_path(),
        "cliPath": cli_path,
    });
    if let Some(agent) = agent {
        let started = host.command(
            "terminal.start",
            json!({ "adapterId": "custom", "executablePath": agent }),
            Some(&project_id),
            None,
        );
        if !started.ok {
            return Err(failed("terminal.start", started));
        }
        let session = started.result.unwrap_or_default();
        grant["agentPid"] = session["pid"].clone();
        grant["agentSessionId"] = session["id"].clone();
    }
    Ok(grant)
}

#[cfg(test)]
mod tests {
    use super::*;
    use omenflow_agent_host::{EventSink, HostEvent, HostPaths, ResearchSurface, Shell};
    use omenflow_contracts::ContractError;
    use std::sync::Arc;

    struct Nothing;
    impl Shell for Nothing {
        fn reveal_path(&self, _: &Path) -> Result<(), ContractError> {
            Ok(())
        }
        fn open_external(&self, _: &str) -> Result<(), ContractError> {
            Ok(())
        }
    }
    impl ResearchSurface for Nothing {
        fn load(&self, _: &str) -> Result<Value, ContractError> {
            Ok(Value::Null)
        }
        fn read(&self) -> Result<Value, ContractError> {
            Ok(Value::Null)
        }
        fn link(&self, _: &str) -> Result<Option<String>, ContractError> {
            Ok(None)
        }
        fn screenshot(&self) -> Result<Value, ContractError> {
            Ok(Value::Null)
        }
        fn toggle(&self) -> Result<Value, ContractError> {
            Ok(Value::Null)
        }
    }
    impl EventSink for Nothing {
        fn emit(&self, _: HostEvent) {}
    }

    fn host(app_data_dir: &Path) -> Host {
        Host::start(
            HostPaths {
                app_data_dir: app_data_dir.to_owned(),
                cli_path: PathBuf::from("/bin/echo"),
            },
            Arc::new(Nothing),
            Arc::new(Nothing),
            Arc::new(Nothing),
        )
        .unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn the_grant_is_a_live_agent_session_on_a_new_project() {
        use omenflow_contracts::{read_frame, write_frame};
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixStream;

        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app");
        let host = host(&app_data);
        let file = write_grant(
            &host,
            &app_data,
            &temp.path().join("project"),
            Path::new("/usr/lib/Omen Flow/omenflow"),
            None,
        )
        .unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let grant: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(grant["cliPath"], "/usr/lib/Omen Flow/omenflow");
        let mut bridge = UnixStream::connect(grant["socketPath"].as_str().unwrap()).unwrap();
        write_frame(
            &mut bridge,
            &json!({ "type": "hello", "protocolVersion": 1, "mode": "call", "token": grant["token"] }),
        )
        .unwrap();
        assert_eq!(read_frame(&mut bridge).unwrap().unwrap()["type"], "welcome");
        write_frame(
            &mut bridge,
            &json!({ "requestId": "1", "op": "project.summary", "payload": {} }),
        )
        .unwrap();
        let summary = read_frame(&mut bridge).unwrap().unwrap();
        assert_eq!(summary["result"]["project"]["name"], "Packaged smoke");
        assert_eq!(
            summary["result"]["project"]["id"], grant["projectId"],
            "the session is bound to the project it was issued for"
        );
    }

    #[test]
    fn a_grant_that_cannot_be_made_says_why() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app");
        let host = host(&app_data);
        let occupied = temp.path().join("occupied");
        fs::create_dir_all(&occupied).unwrap();
        fs::write(occupied.join("notes.txt"), "not empty").unwrap();
        let file = write_grant(&host, &app_data, &occupied, Path::new("/bin/echo"), None).unwrap();
        let grant: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert!(grant["error"]
            .as_str()
            .unwrap()
            .starts_with("VALIDATION: Folder is not empty"));
        assert!(grant.get("token").is_none());
    }

    /// The stand-in agent is a real terminal session in its own process
    /// group, and stopping the host (what quitting the app does) ends it.
    #[cfg(unix)]
    #[test]
    fn the_stand_in_agent_runs_in_a_pty_until_the_host_stops() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app");
        let host = host(&app_data);
        let file = write_grant(
            &host,
            &app_data,
            &temp.path().join("project"),
            Path::new("/bin/echo"),
            Some(Path::new("/bin/cat")),
        )
        .unwrap();
        let grant: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert!(grant.get("error").is_none(), "{grant}");
        let pid = grant["agentPid"].as_i64().unwrap() as i32;
        assert!(grant["agentSessionId"].is_string());
        // SAFETY: kill(2) with signal 0 and getpgid(2) only ask about the process.
        let group_alive = || unsafe { libc::kill(-pid, 0) } == 0;
        assert!(group_alive());
        assert_eq!(unsafe { libc::getpgid(pid) }, pid, "its own process group");
        assert!(host.agent_running());
        host.shutdown();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while group_alive() && std::time::Instant::now() < until {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            !group_alive(),
            "the agent's process group outlived the host"
        );
    }

    #[test]
    fn a_stand_in_agent_that_cannot_start_says_why() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app");
        let host = host(&app_data);
        let file = write_grant(
            &host,
            &app_data,
            &temp.path().join("project"),
            Path::new("/bin/echo"),
            Some(&temp.path().join("no-such-agent")),
        )
        .unwrap();
        let grant: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert!(
            grant["error"]
                .as_str()
                .unwrap()
                .starts_with("terminal.start: "),
            "{grant}"
        );
    }
}
