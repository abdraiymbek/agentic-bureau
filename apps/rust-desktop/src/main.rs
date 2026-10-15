//! The desktop shell: a window, native dialogs and a research webview around
//! the shared [`Host`]. Command routing lives in `omenflow-agent-host`; this
//! binary only says where events go and what the desktop can do.

mod capture;
mod helper;
mod instance;
mod research;
#[cfg(unix)]
mod signals;
mod smoke;
mod window;

use omenflow_agent_host::{EventSink, Host, HostEvent, HostPaths, Shell};
use omenflow_contracts::{ContractError, ResponseEnvelope};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

struct DesktopEvents(AppHandle);

impl EventSink for DesktopEvents {
    fn emit(&self, event: HostEvent) {
        let _ = self.0.emit(event.channel(), event.payload());
    }
}

struct DesktopShell(AppHandle);

impl Shell for DesktopShell {
    fn reveal_path(&self, path: &Path) -> Result<(), ContractError> {
        self.0
            .opener()
            .reveal_item_in_dir(path)
            .map_err(|error| ContractError::new("INTERNAL", error.to_string()))
    }

    fn open_external(&self, url: &str) -> Result<(), ContractError> {
        #[cfg(target_os = "linux")]
        if omenflow_agent_host::child_env::appimage_dir().is_some() && open_outside_appimage(url) {
            return Ok(());
        }
        self.0
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|error| ContractError::new("INTERNAL", error.to_string()))
    }
}

/// Open a link with the session's `xdg-open` and environment. From an
/// AppImage the opener would start the image's own `xdg-open`, and the
/// browser would inherit the image's libraries and GTK paths. False when
/// there is no `xdg-open` to start, so the opener is tried instead.
#[cfg(target_os = "linux")]
fn open_outside_appimage(url: &str) -> bool {
    use std::process::{Command, Stdio};
    let mut command = Command::new("xdg-open");
    omenflow_agent_host::child_env::apply(&mut command);
    match command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
            true
        }
        Err(_) => false,
    }
}

/// True while a "stop the agent?" question is on screen, so a second close
/// or quit does not stack another one.
struct Asking(AtomicBool);

#[tauri::command(async)]
fn omenflow_command(
    host: State<'_, Arc<Host>>,
    op: String,
    payload: Value,
    project_id: Option<String>,
    idempotency_key: Option<String>,
) -> ResponseEnvelope {
    host.command(
        &op,
        payload,
        project_id.as_deref(),
        idempotency_key.as_deref(),
    )
}

#[tauri::command(async)]
fn toggle_research(host: State<'_, Arc<Host>>) -> Result<Value, String> {
    host.toggle_research().map_err(|error| match error.repair {
        Some(repair) => format!("{} — {repair}", error.message),
        None => error.message,
    })
}

fn cli_path(app: &AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(if cfg!(windows) {
            "omenflow.exe"
        } else {
            "omenflow"
        });
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../native/omenflow-bridge/target/release/omenflow")
}

/// Earlier homes of the app's own files under the platform data folder, newest
/// first: builds before 1.0 used the identifier `com.electron.omen-flow`, and
/// the Electron app kept its settings in `@omenflow/desktop`.
const LEGACY_HOMES: [(&str, &[&str]); 2] = [
    (
        "com.electron.omen-flow",
        &["settings.json", "reservations.json", "window-state.json"],
    ),
    ("@omenflow/desktop", &["settings.json", "reservations.json"]),
];

/// Carry settings over from the earlier app's folders the first time this one
/// starts. A file is taken from the newest home that has it and never
/// overwrites one this app already wrote. The old files stay where they are,
/// so a copy that fails is simply tried again on the next launch.
fn migrate_legacy_settings(data_dir: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for (home, names) in LEGACY_HOMES {
        let legacy = data_dir.join(home);
        if legacy == target {
            continue;
        }
        for name in names {
            let source = legacy.join(name);
            let destination = target.join(name);
            if source.is_file() && !destination.exists() {
                if let Err(error) = fs::copy(&source, &destination) {
                    eprintln!(
                        "omenflow: could not carry over {}: {error}",
                        source.display()
                    );
                }
            }
        }
    }
    Ok(())
}

/// Open the application state, start the host and create the main window.
/// The error is a sentence a person can act on.
fn start(app: &AppHandle, data_override: Option<PathBuf>) -> Result<(), String> {
    let isolated = data_override.is_some();
    let app_data_dir = match data_override {
        Some(path) => path,
        None => {
            let path = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("The application data folder is unavailable: {error}"))?;
            if let Ok(data_dir) = app.path().data_dir() {
                migrate_legacy_settings(&data_dir, &path)
                    .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
            }
            path
        }
    };
    let cli_path = helper::usable(&cli_path(app), &app_data_dir);
    let host = Host::start(
        HostPaths {
            app_data_dir: app_data_dir.clone(),
            cli_path: cli_path.clone(),
        },
        Arc::new(DesktopEvents(app.clone())),
        Arc::new(DesktopShell(app.clone())),
        Arc::new(research::WebviewSurface::new(app.clone())),
    )
    .map_err(|error| match error.repair {
        Some(repair) => format!("{} {repair}", error.message),
        None => error.message,
    })?;
    let host = Arc::new(host);
    let placement = Arc::new(window::Placement::load(&app_data_dir));
    app.manage(Arc::clone(&host));
    app.manage(Arc::clone(&placement));
    app.manage(Asking(AtomicBool::new(false)));
    if let Some(project) = smoke::requested_project().filter(|_| isolated) {
        let agent = smoke::requested_agent();
        smoke::write_grant(&host, &app_data_dir, &project, &cli_path, agent.as_deref())
            .map_err(|error| format!("Could not write the smoke grant: {error}"))?;
    }
    let window = window::create_main(app, host, placement)
        .map_err(|error| format!("The main window could not be created: {error}"))?;
    if isolated && smoke::snapshot_requested() {
        smoke::snapshot_on_request(window, &app_data_dir);
    }
    Ok(())
}

/// Quit through the normal exit path (`RunEvent::Exit` below) when the
/// process is asked to end; see `signals`.
#[cfg(unix)]
fn quit_on_termination_signals(app: &AppHandle) {
    let app = app.clone();
    if let Err(error) = signals::on_termination(move |signal| {
        eprintln!("omenflow: {} received, quitting", signals::name(signal));
        app.exit(0);
    }) {
        eprintln!("omenflow: termination signals will end the app without its exit path: {error}");
    }
}

/// Tell the person why the app cannot run, then exit. Without this a failed
/// start is an invisible crash.
fn report_startup_failure(app: &AppHandle, message: String) {
    eprintln!("omenflow: {message}");
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("Omen Flow could not start")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("Quit".into()))
        .show(move |_| handle.exit(1));
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(window::MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Run `proceed` now, or after the person agrees to stop a running agent
/// session. Decided off the interface thread: asking the host may wait for
/// work in progress.
fn after_agent_consent(
    app: &AppHandle,
    question: &'static str,
    agree: &'static str,
    proceed: impl FnOnce(&AppHandle) + Send + 'static,
) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(host) = app
            .try_state::<Arc<Host>>()
            .map(|host| host.inner().clone())
        else {
            return proceed(&app);
        };
        if !host.agent_running() {
            return proceed(&app);
        }
        if app.state::<Asking>().0.swap(true, Ordering::SeqCst) {
            return;
        }
        let handle = app.clone();
        let mut dialog = app
            .dialog()
            .message(format!(
                "{question} The agent session that is running will be stopped. Drafts it has already saved are kept."
            ))
            .title("An agent is still working")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                agree.into(),
                "Keep working".into(),
            ));
        if let Some(window) = app.get_webview_window(window::MAIN) {
            dialog = dialog.parent(&window);
        }
        dialog.show(move |agreed| {
            handle.state::<Asking>().0.store(false, Ordering::SeqCst);
            if agreed {
                host.shutdown();
                proceed(&handle);
            }
        });
    });
}

#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "omenflow-quit";

/// The standard macOS menu, with a Quit item the app can answer itself so a
/// running agent session is not killed without a word.
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let package = app.package_info();
    let config = app.config();
    let name = config
        .product_name
        .clone()
        .unwrap_or_else(|| package.name.clone());
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                &name,
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(
                        app,
                        QUIT_MENU_ID,
                        format!("Quit {name}"),
                        true,
                        Some("CmdOrCtrl+Q"),
                    )?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
        ],
    )
}

fn main() {
    let data_override = instance::data_dir_override();
    let mut builder = tauri::Builder::default();
    // Held until the process exits; see `instance`.
    let mut _claim = None;
    match &data_override {
        None => {
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
                focus_main(app)
            }));
        }
        Some(dir) => match instance::claim(dir) {
            instance::Claim::Held(lock) => _claim = Some(lock),
            instance::Claim::Unavailable => {}
            instance::Claim::Taken => {
                eprintln!(
                    "omenflow: another Omen Flow is already running on {}",
                    dir.display()
                );
                return;
            }
        },
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(app_menu).on_menu_event(|app, event| {
            if event.id().as_ref() == QUIT_MENU_ID {
                after_agent_consent(app, "Quit Omen Flow?", "Stop agent and quit", |app| {
                    app.exit(0)
                });
            }
        });
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            #[cfg(unix)]
            quit_on_termination_signals(app.handle());
            if let Err(message) = start(app.handle(), data_override) {
                report_startup_failure(app.handle(), message);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![omenflow_command, toggle_research])
        .build(tauri::generate_context!())
        .expect("Omen Flow Rust desktop shell failed")
        .run(|app, event| match event {
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } if label == window::MAIN => {
                api.prevent_close();
                after_agent_consent(app, "Close this window?", "Stop agent and close", |app| {
                    if let Some(window) = app.get_webview_window(window::MAIN) {
                        let _ = window.destroy();
                    }
                });
            }
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } if label == window::MAIN => {
                // The research window alone must not keep the app and its
                // agent sessions alive with no workspace on screen.
                if let Some(research) = app.get_webview_window(research::LABEL) {
                    let _ = research.destroy();
                }
            }
            // Tauri exits the process after RunEvent::Exit; managed-state Drop is not a quit hook.
            // Quitting from the menu, closing the last window and a termination signal all
            // arrive here.
            RunEvent::Exit => {
                if let Some(placement) = app.try_state::<Arc<window::Placement>>() {
                    placement.save();
                }
                if let Some(host) = app.try_state::<Arc<Host>>() {
                    host.shutdown();
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_settings_are_copied_once_and_never_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path();
        let (legacy, target) = (
            data_dir.join("@omenflow/desktop"),
            data_dir.join("app.omenflow.desktop"),
        );
        fs::create_dir_all(&legacy).unwrap();
        fs::write(
            legacy.join("settings.json"),
            r#"{"prefs":{"theme":"light"}}"#,
        )
        .unwrap();
        fs::write(legacy.join("unrelated.json"), "{}").unwrap();

        migrate_legacy_settings(data_dir, &target).unwrap();
        assert_eq!(
            fs::read_to_string(target.join("settings.json")).unwrap(),
            r#"{"prefs":{"theme":"light"}}"#
        );
        assert!(!target.join("reservations.json").exists());
        assert!(!target.join("unrelated.json").exists());

        fs::write(
            target.join("settings.json"),
            r#"{"prefs":{"theme":"dark"}}"#,
        )
        .unwrap();
        migrate_legacy_settings(data_dir, &target).unwrap();
        assert_eq!(
            fs::read_to_string(target.join("settings.json")).unwrap(),
            r#"{"prefs":{"theme":"dark"}}"#,
            "settings changed in this app are kept"
        );
        assert!(legacy.join("settings.json").exists(), "the old file stays");
    }

    #[test]
    fn a_missing_legacy_folder_still_creates_the_data_folder() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("app");
        migrate_legacy_settings(&temp.path().join("absent"), &target).unwrap();
        assert!(target.is_dir());
    }

    #[test]
    fn the_pre_1_0_identifier_folder_wins_over_the_electron_one() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path();
        let (tauri, electron) = (
            data_dir.join("com.electron.omen-flow"),
            data_dir.join("@omenflow/desktop"),
        );
        let target = data_dir.join("app.omenflow.desktop");
        fs::create_dir_all(&tauri).unwrap();
        fs::create_dir_all(&electron).unwrap();
        fs::write(tauri.join("settings.json"), r#"{"from":"tauri"}"#).unwrap();
        fs::write(tauri.join("window-state.json"), r#"{"width":1200}"#).unwrap();
        fs::write(electron.join("settings.json"), r#"{"from":"electron"}"#).unwrap();
        fs::write(electron.join("reservations.json"), "[]").unwrap();

        migrate_legacy_settings(data_dir, &target).unwrap();
        assert_eq!(
            fs::read_to_string(target.join("settings.json")).unwrap(),
            r#"{"from":"tauri"}"#
        );
        assert_eq!(
            fs::read_to_string(target.join("window-state.json")).unwrap(),
            r#"{"width":1200}"#
        );
        assert_eq!(
            fs::read_to_string(target.join("reservations.json")).unwrap(),
            "[]",
            "a file only the older home has is still carried over"
        );
    }
}
