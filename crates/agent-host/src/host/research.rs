//! Research operations (`research.*`, `browser.*`) over whatever page reader
//! the host has. The desktop app implements [`ResearchSurface`] with an
//! isolated webview; a host without one answers with a typed error.

use super::CoreGate;
use omenflow_contracts::ContractError;
use omenflow_core::Origin;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, PoisonError};

/// Characters of page text kept as the excerpt when a capture names none.
const CAPTURE_EXCERPT_CHARS: usize = 4000;

pub trait ResearchSurface: Send + Sync + 'static {
    /// Load a public web page, wait until it can be read, and return what
    /// [`ResearchSurface::read`] would return for it. Refuses private,
    /// local and non-HTTP destinations.
    fn load(&self, url: &str) -> Result<Value, ContractError>;
    /// The page that is loaded now: `url`, `title`, `text`, `links`,
    /// `images`, `metadata`, `structuredData`.
    fn read(&self) -> Result<Value, ContractError>;
    /// Address of the first link on the loaded page that matches a CSS
    /// selector, if any.
    fn link(&self, selector: &str) -> Result<Option<String>, ContractError>;
    /// The loaded page as an image: `{ pngBase64 }`.
    fn screenshot(&self) -> Result<Value, ContractError>;
    /// Show or hide the surface for the person: `{ visible }`.
    fn toggle(&self) -> Result<Value, ContractError>;
}

pub(super) fn handles(op: &str) -> bool {
    op.starts_with("research.") || op.starts_with("browser.")
}

pub(super) struct Research {
    surface: Arc<dyn ResearchSurface>,
    gate: Arc<CoreGate>,
    /// One caller drives the page at a time, so what an agent reads is the
    /// page it asked for even while the person or another session browses.
    turn: Mutex<()>,
}

impl Research {
    pub(super) fn new(surface: Arc<dyn ResearchSurface>, gate: Arc<CoreGate>) -> Self {
        Self {
            surface,
            gate,
            turn: Mutex::new(()),
        }
    }

    pub(super) fn toggle(&self) -> Result<Value, ContractError> {
        self.surface.toggle()
    }

    pub(super) fn dispatch(
        &self,
        op: &str,
        payload: Value,
        origin: Origin,
        project_id: &str,
        idempotency_key: Option<&str>,
    ) -> Result<Value, ContractError> {
        let _turn = self.turn.lock().unwrap_or_else(PoisonError::into_inner);
        match op {
            "research.search" => {
                let query = text(&payload, "query", "Search query is required")?;
                let engine = payload["engine"].as_str().unwrap_or("duckduckgo");
                let page = self.surface.load(&search_url(engine, query))?;
                Ok(json!({ "url": page["url"] }))
            }
            "research.read_page" => {
                self.surface
                    .load(text(&payload, "url", "Research URL is required")?)
            }
            "browser.open" => {
                let page = self
                    .surface
                    .load(text(&payload, "url", "Research URL is required")?)?;
                Ok(json!({ "url": page["url"] }))
            }
            "browser.read" => self.surface.read(),
            "browser.follow_link" => {
                let url = if let Some(url) = payload["url"].as_str() {
                    url.to_owned()
                } else if let Some(selector) = payload["selector"].as_str() {
                    self.surface
                        .link(selector)?
                        .ok_or_else(|| ContractError::validation("selector not found"))?
                } else {
                    return Err(ContractError::validation("Need selector or URL"));
                };
                self.surface.load(&url)?;
                Ok(json!({ "ok": true }))
            }
            "browser.capture" => {
                let page = self.surface.read()?;
                let url = page["url"]
                    .as_str()
                    .ok_or_else(|| ContractError::validation("No research page loaded"))?;
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
                            .take(CAPTURE_EXCERPT_CHARS)
                            .collect()
                    });
                self.gate.call(
                    "source.capture",
                    json!({ "url": url, "title": title, "excerpt": excerpt, "sourceKind": "article" }),
                    origin,
                    Some(project_id),
                    idempotency_key,
                )
            }
            "browser.screenshot" => self.surface.screenshot(),
            _ => Err(ContractError::validation(format!(
                "Unknown research operation: {op}"
            ))),
        }
    }
}

fn text<'a>(payload: &'a Value, key: &str, missing: &str) -> Result<&'a str, ContractError> {
    payload[key]
        .as_str()
        .ok_or_else(|| ContractError::validation(missing))
}

fn search_url(engine: &str, query: &str) -> String {
    let base = match engine {
        "google" => "https://www.google.com/search",
        "bing" => "https://www.bing.com/search",
        _ => "https://duckduckgo.com/",
    };
    format!("{base}?q={}", form_encode(query))
}

/// `application/x-www-form-urlencoded` value encoding.
fn form_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                encoded.push(byte as char)
            }
            b' ' => encoded.push('+'),
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_addresses_encode_the_query_for_each_engine() {
        assert_eq!(
            search_url("duckduckgo", "M3 × 8 screw & nut"),
            "https://duckduckgo.com/?q=M3+%C3%97+8+screw+%26+nut"
        );
        assert_eq!(
            search_url("google", "a+b=c?"),
            "https://www.google.com/search?q=a%2Bb%3Dc%3F"
        );
        assert_eq!(
            search_url("bing", "tray_width-2.5*"),
            "https://www.bing.com/search?q=tray_width-2.5*"
        );
        assert_eq!(
            search_url("unknown engine", "x"),
            "https://duckduckgo.com/?q=x"
        );
    }
}
