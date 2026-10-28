//! The main window: where it may navigate, and where it was last left.

use bureau_agent_host::Host;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use tauri::{
    LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize, Position, Size, Url,
    WebviewWindow, WebviewWindowBuilder,
};

pub const MAIN: &str = "main";
const STATE_FILE: &str = "window-state.json";

/// The coordinates the window system places windows in. On macOS that is
/// points: displays of different pixel density share one space of points,
/// while their pixels do not line up. Elsewhere it is the pixels the window
/// system reports. A place is remembered, compared with the displays and
/// restored in this one space.
const SPACE: &str = if cfg!(target_os = "macos") {
    "points"
} else {
    "pixels"
};

/// Whether `url` is the app itself. Everything else is kept out of the main
/// window: a link in agent-authored text must never replace the workspace.
pub fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => true,
        ("http" | "https", Some("tauri.localhost")) => {
            cfg!(any(windows, target_os = "android"))
        }
        ("about", None) => url.path() == "blank",
        _ => dev_url.is_some_and(|dev| {
            url.scheme() == dev.scheme()
                && url.host_str() == dev.host_str()
                && url.port_or_known_default() == dev.port_or_known_default()
        }),
    }
}

/// Outer position and inner size in `SPACE`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Bounds {
    /// Bounds from what the window system reports in pixels and the scale
    /// those pixels were measured at: a display's own scale for a display,
    /// the window's current one for a window.
    pub fn from_pixels(
        position: PhysicalPosition<i32>,
        size: PhysicalSize<u32>,
        scale: f64,
    ) -> Self {
        if SPACE == "pixels" {
            return Self {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            };
        }
        let position = position.to_logical::<f64>(scale);
        let size = size.to_logical::<f64>(scale);
        Self {
            x: position.x.round() as i32,
            y: position.y.round() as i32,
            width: size.width.round().max(1.0) as u32,
            height: size.height.round().max(1.0) as u32,
        }
    }

    fn position(self) -> Position {
        if SPACE == "pixels" {
            PhysicalPosition::new(self.x, self.y).into()
        } else {
            LogicalPosition::new(f64::from(self.x), f64::from(self.y)).into()
        }
    }

    fn size(self) -> Size {
        if SPACE == "pixels" {
            PhysicalSize::new(self.width, self.height).into()
        } else {
            LogicalSize::new(f64::from(self.width), f64::from(self.height)).into()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowState {
    /// Where the window sits when it is not maximised.
    pub normal: Bounds,
    pub maximized: bool,
}

impl WindowState {
    fn to_json(self) -> Value {
        json!({
            "x": self.normal.x, "y": self.normal.y,
            "width": self.normal.width, "height": self.normal.height,
            "maximized": self.maximized, "space": SPACE,
        })
    }

    /// A place written in another space (an earlier build wrote pixels on
    /// every system) is not read: the default placement is better than a
    /// window on the wrong display at the wrong size.
    fn from_json(value: &Value) -> Option<Self> {
        if value["space"] != SPACE {
            return None;
        }
        let int = |key: &str| value[key].as_i64().and_then(|n| i32::try_from(n).ok());
        let size = |key: &str| {
            value[key]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| *n > 0)
        };
        Some(Self {
            normal: Bounds {
                x: int("x")?,
                y: int("y")?,
                width: size("width")?,
                height: size("height")?,
            },
            maximized: value["maximized"].as_bool()?,
        })
    }
}

/// Fit a remembered window onto the displays that exist now. `None` when the
/// place it was left is no longer on any display, so the default placement
/// is used instead of opening a window nobody can reach.
pub fn fit(saved: WindowState, displays: &[Bounds]) -> Option<WindowState> {
    // The strip a person grabs to move the window must be on a display.
    let (grab_x, grab_y) = (
        saved.normal.x.saturating_add(120),
        saved.normal.y.saturating_add(16),
    );
    let display = displays.iter().find(|display| {
        let right = display.x.saturating_add_unsigned(display.width);
        let bottom = display.y.saturating_add_unsigned(display.height);
        (display.x..right).contains(&grab_x) && (display.y..bottom).contains(&grab_y)
    })?;
    Some(WindowState {
        normal: Bounds {
            width: saved.normal.width.min(display.width),
            height: saved.normal.height.min(display.height),
            ..saved.normal
        },
        maximized: saved.maximized,
    })
}

/// Remembers the window's place while it moves and writes it when asked.
pub struct Placement {
    file: PathBuf,
    state: Mutex<Option<WindowState>>,
}

impl Placement {
    pub fn load(app_data_dir: &Path) -> Self {
        let file = app_data_dir.join(STATE_FILE);
        let state = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| WindowState::from_json(&value));
        Self {
            file,
            state: Mutex::new(state),
        }
    }

    fn get(&self) -> Option<WindowState> {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Note where the window is now. A minimised or full-screen window keeps
    /// the place it had before.
    fn observe(&self, window: &WebviewWindow) {
        if window.is_minimized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
            return;
        }
        let maximized = window.is_maximized().unwrap_or(false);
        let measured = match (
            window.outer_position(),
            window.inner_size(),
            window.scale_factor(),
        ) {
            (Ok(position), Ok(size), Ok(scale)) if size.width > 0 && size.height > 0 => {
                Some(Bounds::from_pixels(position, size, scale))
            }
            _ => None,
        };
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        *state = match (maximized, *state, measured) {
            (true, Some(previous), _) => Some(WindowState {
                maximized: true,
                ..previous
            }),
            (maximized, _, Some(normal)) => Some(WindowState { normal, maximized }),
            (_, previous, None) => previous,
        };
    }

    /// Write the remembered place. Losing it only costs the default
    /// placement next launch, so a failed write is not an error.
    pub fn save(&self) {
        if let Some(state) = self.get() {
            let _ = fs::write(&self.file, state.to_json().to_string());
        }
    }
}

/// Create the main window from its configuration with the navigation guard,
/// at the place it was last left.
pub fn create_main(
    app: &tauri::AppHandle,
    host: Arc<Host>,
    placement: Arc<Placement>,
) -> tauri::Result<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN)
        .cloned()
        .ok_or(tauri::Error::WindowNotFound)?;
    let dev_url = app
        .config()
        .build
        .dev_url
        .clone()
        .filter(|_| tauri::is_dev());
    let restored = placement.get().and_then(|saved| {
        let displays = app
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|monitor| {
                Bounds::from_pixels(*monitor.position(), *monitor.size(), monitor.scale_factor())
            })
            .collect::<Vec<_>>();
        fit(saved, &displays)
    });
    let window = WebviewWindowBuilder::from_config(app, &config)?
        // Shown once it is in place, so it does not jump after appearing.
        .visible(false)
        .on_navigation(move |url| {
            if is_app_url(url, dev_url.as_ref()) {
                return true;
            }
            let _ = host.open_external(url.as_str());
            false
        })
        .build()?;
    if let Some(state) = restored {
        let _ = window.set_size(state.normal.size());
        let _ = window.set_position(state.normal.position());
        if state.maximized {
            let _ = window.maximize();
        }
    }
    window.show()?;
    let observed = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
        ) {
            placement.observe(&observed);
        }
    });
    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn only_the_app_itself_may_load_in_the_main_window() {
        let dev = url("http://127.0.0.1:5174");
        assert!(is_app_url(&url("tauri://localhost/index.html"), None));
        assert!(is_app_url(&url("about:blank"), None));
        assert!(is_app_url(
            &url("http://127.0.0.1:5174/src/main.tsx"),
            Some(&dev)
        ));
        for outside in [
            "https://example.com/datasheet.pdf",
            "http://127.0.0.1:5174/",
            "http://localhost:5174/",
            "tauri://evil.example/index.html",
            "about:srcdoc",
            "file:///etc/passwd",
            "mailto:lab@example.com",
            "javascript:alert(1)",
        ] {
            assert!(!is_app_url(&url(outside), None), "{outside}");
        }
        assert!(!is_app_url(&url("http://127.0.0.1:5175/"), Some(&dev)));
        assert!(!is_app_url(&url("https://127.0.0.1:5174/"), Some(&dev)));
        assert_eq!(
            is_app_url(&url("http://tauri.localhost/index.html"), None),
            cfg!(any(windows, target_os = "android"))
        );
    }

    const LAPTOP: Bounds = Bounds {
        x: 0,
        y: 0,
        width: 3024,
        height: 1964,
    };
    const EXTERNAL: Bounds = Bounds {
        x: 3024,
        y: -400,
        width: 2560,
        height: 1440,
    };

    fn at(x: i32, y: i32, width: u32, height: u32, maximized: bool) -> WindowState {
        WindowState {
            normal: Bounds {
                x,
                y,
                width,
                height,
            },
            maximized,
        }
    }

    #[test]
    fn a_remembered_window_returns_to_its_display() {
        let saved = at(200, 120, 2400, 1500, false);
        assert_eq!(fit(saved, &[LAPTOP, EXTERNAL]), Some(saved));
        let on_external = at(3400, -200, 1800, 1000, true);
        assert_eq!(fit(on_external, &[LAPTOP, EXTERNAL]), Some(on_external));
    }

    #[test]
    fn a_window_left_on_a_missing_display_gets_the_default_place() {
        let on_external = at(3400, -200, 1800, 1000, false);
        assert_eq!(fit(on_external, &[LAPTOP]), None);
        assert_eq!(
            fit(at(-5000, 50, 1440, 900, false), &[LAPTOP, EXTERNAL]),
            None
        );
        assert_eq!(fit(at(100, 100, 1440, 900, false), &[]), None);
        assert_eq!(fit(at(i32::MAX, i32::MAX, 1, 1, false), &[LAPTOP]), None);
    }

    #[test]
    fn a_window_larger_than_its_display_is_shrunk_to_it() {
        let saved = at(3100, -300, 5000, 3000, false);
        assert_eq!(
            fit(saved, &[LAPTOP, EXTERNAL]),
            Some(at(3100, -300, 2560, 1440, false))
        );
    }

    #[test]
    fn window_state_survives_a_round_trip_and_rejects_nonsense() {
        let state = at(-1200, 40, 1440, 900, true);
        assert_eq!(WindowState::from_json(&state.to_json()), Some(state));
        for bad in [
            json!({}),
            json!({ "x": 0, "y": 0, "width": 0, "height": 900, "maximized": false, "space": SPACE }),
            json!({ "x": 0, "y": 0, "width": -5, "height": 900, "maximized": false, "space": SPACE }),
            json!({ "x": "0", "y": 0, "width": 1440, "height": 900, "maximized": false, "space": SPACE }),
            json!({ "x": 0, "y": 0, "width": 1440, "height": 900, "space": SPACE }),
            // Written by an earlier build, which kept no space.
            json!({ "x": 0, "y": 0, "width": 1440, "height": 900, "maximized": false }),
        ] {
            assert_eq!(WindowState::from_json(&bad), None, "{bad}");
        }
    }

    /// A 2x laptop with a 1x display to its right, both as the window system
    /// reports them in pixels (each display's points times its own scale):
    /// the window left on the external display returns there, at its size.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_window_returns_to_its_display_across_pixel_densities() {
        let display = |x: i32, y: i32, width: u32, height: u32, scale: f64| {
            Bounds::from_pixels(
                PhysicalPosition::new(x, y),
                PhysicalSize::new(width, height),
                scale,
            )
        };
        // Points: laptop (0, 0) 1512 × 982 at 2x; external (1512, 0) 2560 × 1440 at 1x.
        let laptop = display(0, 0, 3024, 1964, 2.0);
        let external = display(1512, 0, 2560, 1440, 1.0);
        assert_eq!(
            laptop,
            Bounds {
                x: 0,
                y: 0,
                width: 1512,
                height: 982
            }
        );
        // The window at points (1700, 100), 1440 × 900, measured on the 1x display.
        let left = Bounds::from_pixels(
            PhysicalPosition::new(1700, 100),
            PhysicalSize::new(1440, 900),
            1.0,
        );
        let saved = WindowState {
            normal: left,
            maximized: false,
        };
        let restored = fit(saved, &[laptop, external]).unwrap();
        assert_eq!(
            restored.normal,
            Bounds {
                x: 1700,
                y: 100,
                width: 1440,
                height: 900
            }
        );
        // The same place measured while the window sat on the 2x display.
        let on_laptop = Bounds::from_pixels(
            PhysicalPosition::new(3400, 200),
            PhysicalSize::new(2880, 1800),
            2.0,
        );
        assert_eq!(on_laptop, restored.normal);
    }

    #[test]
    fn a_saved_place_is_read_back_on_the_next_launch() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(Placement::load(temp.path()).get(), None);
        let placement = Placement::load(temp.path());
        *placement.state.lock().unwrap() = Some(at(10, 20, 1500, 950, false));
        placement.save();
        assert_eq!(
            Placement::load(temp.path()).get(),
            Some(at(10, 20, 1500, 950, false))
        );
        fs::write(temp.path().join(STATE_FILE), "not json").unwrap();
        assert_eq!(Placement::load(temp.path()).get(), None);
    }
}
