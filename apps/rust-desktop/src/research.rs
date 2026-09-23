//! Isolated native-webview research surface. Only app-owned extraction scripts
//! run here; no Node integration, preload script, or app IPC is exposed.
use base64::Engine;
use omenflow_contracts::ContractError;
use omenflow_core::{CoreApp, Origin};
use serde_json::{json, Value};
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone)]
pub struct ResearchBrowser {
    app: tauri::AppHandle,
    core: Arc<Mutex<CoreApp>>,
}

fn invalid(message: impl Into<String>) -> ContractError {
    ContractError::new("VALIDATION", message.into())
}
fn internal(message: impl Into<String>) -> ContractError {
    ContractError::new("INTERNAL", message.into())
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(o[0] == 0
                || o[0] == 10
                || o[0] == 127
                || o[0] >= 224
                || (o[0] == 169 && o[1] == 254)
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] == 192 && o[1] == 0)
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19)))
        }
        IpAddr::V6(v) => {
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_unique_local()
                || v.is_unicast_link_local()
                || v.to_ipv4_mapped()
                    .is_some_and(|mapped| !public_ip(IpAddr::V4(mapped))))
        }
    }
}

fn public_url(url: &Url) -> bool {
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".local")
        || host.ends_with(".localhost")
    {
        return false;
    }
    if let Ok(ip) = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        return public_ip(ip);
    }
    let port = url.port_or_known_default().unwrap_or(443);
    (host, port).to_socket_addrs().is_ok_and(|mut addresses| {
        let first = addresses.next();
        first.is_some()
            && first.is_some_and(|a| public_ip(a.ip()))
            && addresses.all(|a| public_ip(a.ip()))
    })
}

fn parse_public(url: &str) -> Result<Url, ContractError> {
    let url = Url::parse(url).map_err(|_| invalid(format!("Bad research URL: {url}")))?;
    if !public_url(&url) {
        return Err(ContractError::new(
            "CONNECTION_DENIED",
            format!("Private or non-HTTP research destination blocked: {url}"),
        ));
    }
    Ok(url)
}

impl ResearchBrowser {
    pub fn new(app: tauri::AppHandle, core: Arc<Mutex<CoreApp>>) -> Self {
        Self { app, core }
    }

    fn window(&self, url: Url) -> Result<tauri::WebviewWindow, ContractError> {
        if let Some(window) = self.app.get_webview_window("research") {
            window.navigate(url).map_err(|e| internal(e.to_string()))?;
            window.show().map_err(|e| internal(e.to_string()))?;
            return Ok(window);
        }
        WebviewWindowBuilder::new(&self.app, "research", WebviewUrl::External(url))
            .title("Research · Omen Flow")
            .inner_size(560.0, 800.0)
            .incognito(true)
            .on_navigation(public_url)
            .build()
            .map_err(|e| internal(e.to_string()))
    }

    fn read(&self) -> Result<Value, ContractError> {
        let window = self
            .app
            .get_webview_window("research")
            .ok_or_else(|| invalid("No research page loaded"))?;
        let script = r#"(() => ({ url: location.href, title: document.title,
          text: (document.body?.innerText ?? '').slice(0, 204800),
          links: [...document.querySelectorAll('a[href]')].slice(0,300).map(a => ({
            text: (a.innerText || '').slice(0,140), url: a.href })) }))()"#;
        let (sender, receiver) = mpsc::channel();
        window
            .eval_with_callback(script, move |result| {
                let _ = sender.send(result);
            })
            .map_err(|e| internal(e.to_string()))?;
        let raw = receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| internal("Research page extraction timed out"))?;
        let page: Value = serde_json::from_str(&raw)
            .map_err(|e| internal(format!("Research extraction failed: {e}")))?;
        if !page.is_object() {
            return Err(internal("Research page extraction returned no document"));
        }
        Ok(page)
    }

    fn open(&self, url: &str) -> Result<Value, ContractError> {
        let url = parse_public(url)?;
        let previous = self
            .app
            .get_webview_window("research")
            .and_then(|window| window.url().ok());
        let window = self.window(url.clone())?;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(12) {
            if let Ok(current) = window.url() {
                // A public redirect is legitimate. Wait until the old page has
                // actually navigated, then require the extracted document to
                // match the webview's current URL.
                if public_url(&current)
                    && (previous.as_ref() != Some(&current) || current == url)
                    && self
                        .read()
                        .is_ok_and(|page| page["url"].as_str() == Some(current.as_str()))
                {
                    return Ok(json!({"url":current}));
                }
            }
            std::thread::sleep(Duration::from_millis(80));
        }
        Err(internal(
            "Research page did not finish loading in 12 seconds",
        ))
    }

    fn screenshot(&self) -> Result<Value, ContractError> {
        let window = self
            .app
            .get_webview_window("research")
            .ok_or_else(|| invalid("No research page loaded"))?;
        let title = window.title().map_err(|e| internal(e.to_string()))?;
        let pid = std::process::id();
        let candidate = xcap::Window::all()
            .map_err(|e| internal(e.to_string()))?
            .into_iter()
            .find(|item| {
                item.pid().ok() == Some(pid) && item.title().ok().as_deref() == Some(title.as_str())
            })
            .ok_or_else(|| internal("Research window was not available for capture"))?;
        let frame = candidate
            .capture_image()
            .map_err(|e| internal(format!("Research capture failed: {e}")))?;
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(frame)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .map_err(|e| internal(e.to_string()))?;
        Ok(
            json!({"pngBase64":base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())}),
        )
    }

    pub fn toggle(&self) -> Result<Value, ContractError> {
        if let Some(window) = self.app.get_webview_window("research") {
            let visible = window.is_visible().map_err(|e| internal(e.to_string()))?;
            if visible {
                window.hide()
            } else {
                window.show()
            }
            .map_err(|e| internal(e.to_string()))?;
            Ok(json!({"visible":!visible}))
        } else {
            self.window(parse_public("https://duckduckgo.com/")?)?;
            Ok(json!({"visible":true}))
        }
    }

    pub fn dispatch(
        &self,
        op: &str,
        payload: Value,
        origin: Origin,
        project_id: &str,
        idempotency_key: Option<&str>,
    ) -> Result<Value, ContractError> {
        match op {
            "research.search" => {
                let query = payload["query"]
                    .as_str()
                    .ok_or_else(|| invalid("Search query is required"))?;
                let engine = match payload["engine"].as_str().unwrap_or("duckduckgo") {
                    "google" => "https://www.google.com/search",
                    "bing" => "https://www.bing.com/search",
                    _ => "https://duckduckgo.com/",
                };
                let mut url = Url::parse(engine).map_err(|e| internal(e.to_string()))?;
                url.query_pairs_mut().append_pair("q", query);
                self.open(url.as_str())
            }
            "research.read_page" => {
                self.open(
                    payload["url"]
                        .as_str()
                        .ok_or_else(|| invalid("Research URL is required"))?,
                )?;
                self.read()
            }
            "browser.open" => self.open(
                payload["url"]
                    .as_str()
                    .ok_or_else(|| invalid("Research URL is required"))?,
            ),
            "browser.read" => self.read(),
            "browser.follow_link" => {
                let url = if let Some(url) = payload["url"].as_str() {
                    url.to_owned()
                } else if let Some(selector) = payload["selector"].as_str() {
                    let window = self
                        .app
                        .get_webview_window("research")
                        .ok_or_else(|| invalid("No research page loaded"))?;
                    let script = format!(
                        "(() => document.querySelector({})?.href ?? null)()",
                        json!(selector)
                    );
                    let (sender, receiver) = mpsc::channel();
                    window
                        .eval_with_callback(script, move |result| {
                            let _ = sender.send(result);
                        })
                        .map_err(|e| internal(e.to_string()))?;
                    let result = receiver
                        .recv_timeout(Duration::from_secs(10))
                        .map_err(|_| internal("Link lookup timed out"))?;
                    serde_json::from_str::<Option<String>>(&result)
                        .map_err(|e| internal(e.to_string()))?
                        .ok_or_else(|| invalid("selector not found"))?
                } else {
                    return Err(invalid("Need selector or URL"));
                };
                self.open(&url)?;
                Ok(json!({"ok":true}))
            }
            "browser.capture" => {
                let page = self.read()?;
                let url = page["url"]
                    .as_str()
                    .ok_or_else(|| invalid("No research page loaded"))?;
                parse_public(url)?;
                let title = payload["title"]
                    .as_str()
                    .or(page["title"].as_str())
                    .unwrap_or(url);
                let excerpt = payload["excerpt"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        page["text"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(4000)
                            .collect()
                    });
                let mut core = self
                    .core
                    .lock()
                    .map_err(|_| internal("Application state is unavailable"))?;
                let before = core.latest_event_seq(project_id).ok();
                let result = core.dispatch_idempotent(
                    "source.capture",
                    json!({"url":url,"title":title,"excerpt":excerpt,"sourceKind":"article"}),
                    origin,
                    Some(project_id),
                    idempotency_key,
                );
                if let Some(before) = before {
                    if let Ok(events) = core.events_since(project_id, before) {
                        for event in events {
                            let _ = self.app.emit("omenflow:event", event);
                        }
                    }
                }
                result
            }
            "browser.screenshot" => self.screenshot(),
            _ => Err(invalid(format!("Unknown research operation: {op}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn research_urls_block_local_and_non_http() {
        for url in [
            "file:///etc/passwd",
            "http://localhost:3000",
            "http://127.0.0.1/",
            "http://10.0.0.1/",
            "http://[::1]/",
            "http://169.254.169.254/",
        ] {
            assert!(parse_public(url).is_err(), "{url}");
        }
    }
}
