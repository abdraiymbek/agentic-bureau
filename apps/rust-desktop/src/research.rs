//! Isolated native-webview research surface. Only app-owned extraction scripts
//! run here; no Node integration, preload script, or app IPC is exposed.
//!
//! The window loads pages for agents without coming forward; the person
//! reveals it from the app. What is read from a page is bounded and says
//! where it was cut.

use base64::Engine;
use omenflow_agent_host::ResearchSurface;
use omenflow_contracts::ContractError;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "research";
const HOME: &str = "https://duckduckgo.com/";
const LOAD_TIMEOUT: Duration = Duration::from_secs(12);
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a verdict about a host name is trusted before it is looked up again.
const VERDICT_TTL: Duration = Duration::from_secs(60);
/// The longest the interface thread waits for a lookup it has not seen
/// before. Past this the navigation is refused and the lookup finishes in
/// the background, so a retry is answered at once.
const NAVIGATION_PATIENCE: Duration = Duration::from_millis(250);

/// Marks the document that was loaded before a navigation, so a reader can
/// tell the page it asked for from the one it replaced.
const MARK_STALE: &str = "window.__omenflowReplaced = true;";

/// Extracts a bounded description of the loaded document. Every list says
/// whether it was cut, and `textLength` is the size of the full text.
const EXTRACT: &str = r#"(() => {
  const cut = (value, max) => { const text = String(value ?? ''); return text.length > max ? text.slice(0, max) : text; };
  const text = document.body?.innerText ?? '';
  const images = [...document.images].filter(i => i.currentSrc || i.src);
  const metadata = [...document.querySelectorAll('meta[property], meta[name]')]
    .filter(m => /^(og:|product:|twitter:image)/.test(m.getAttribute('property') || m.name));
  const links = [...document.querySelectorAll('a[href]')];
  const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')];
  const structuredData = [];
  let budget = 24000;
  let structuredCut = false;
  for (const block of blocks) {
    const source = block.textContent ?? '';
    if (source.length > budget) { structuredCut = true; continue; }
    try { structuredData.push(JSON.parse(source)); budget -= source.length; } catch { structuredCut = true; }
  }
  return {
    url: location.href,
    title: cut(document.title, 300),
    text: cut(text, 40000),
    textLength: text.length,
    readyState: document.readyState,
    replaced: window.__omenflowReplaced === true,
    images: images.slice(0, 30).map(i => ({ url: cut(i.currentSrc || i.src, 600), alt: cut(i.alt, 160), width: i.naturalWidth, height: i.naturalHeight })),
    metadata: metadata.slice(0, 30).map(m => ({ name: cut(m.getAttribute('property') || m.name, 80), content: cut(m.content, 400) })),
    structuredData,
    links: links.slice(0, 100).map(a => ({ text: cut(a.innerText, 100), url: cut(a.href, 400) })),
    truncated: {
      text: text.length > 40000,
      images: images.length > 30,
      metadata: metadata.length > 30,
      structuredData: structuredCut,
      links: links.length > 100,
    },
  };
})()"#;

fn invalid(message: impl Into<String>) -> ContractError {
    ContractError::validation(message)
}

fn internal(message: impl std::fmt::Display) -> ContractError {
    ContractError::new("INTERNAL", message.to_string())
}

fn blocked(url: &Url) -> ContractError {
    ContractError::new(
        "CONNECTION_DENIED",
        format!("Private or non-HTTP research destination blocked: {url}"),
    )
    .with_repair("Research reads public http and https pages only.")
    .with_details(json!({ "reason": "private_destination", "url": url.as_str() }))
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

/// What can be decided about a destination from its text alone.
#[derive(Debug, PartialEq)]
enum Literal {
    /// Not http(s), carries credentials, or names a local or private address.
    Refused,
    /// A public IP address: nothing to look up.
    Public,
    /// A host name; whether it is public depends on what it resolves to.
    Named { host: String, port: u16 },
}

fn literal(url: &Url) -> Literal {
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Literal::Refused;
    }
    let Some(host) = url.host_str() else {
        return Literal::Refused;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".local") || host.ends_with(".localhost") {
        return Literal::Refused;
    }
    if let Ok(ip) = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        return if public_ip(ip) {
            Literal::Public
        } else {
            Literal::Refused
        };
    }
    Literal::Named {
        host,
        port: url.port_or_known_default().unwrap_or(443),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Verdict {
    Public,
    /// At least one address the name resolves to is local or private.
    Private,
    /// The name did not resolve.
    Unresolved,
}

fn lookup(host: &str, port: u16) -> Verdict {
    match (host, port).to_socket_addrs() {
        Ok(addresses) => {
            let addresses = addresses.collect::<Vec<_>>();
            if addresses.is_empty() {
                Verdict::Unresolved
            } else if addresses.iter().all(|address| public_ip(address.ip())) {
                Verdict::Public
            } else {
                Verdict::Private
            }
        }
        Err(_) => Verdict::Unresolved,
    }
}

/// Remembers what host names resolved to, so the navigation callback on the
/// interface thread almost never waits for the resolver.
type Lookup = dyn Fn(&str, u16) -> Verdict + Send + Sync;

struct Resolver {
    lookup: Box<Lookup>,
    verdicts: Mutex<HashMap<(String, u16), (Verdict, Instant)>>,
}

impl Resolver {
    fn new(lookup: impl Fn(&str, u16) -> Verdict + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            lookup: Box::new(lookup),
            verdicts: Mutex::new(HashMap::new()),
        })
    }

    fn remembered(&self, host: &str, port: u16) -> Option<Verdict> {
        let verdicts = self.verdicts.lock().unwrap_or_else(PoisonError::into_inner);
        verdicts
            .get(&(host.to_owned(), port))
            .filter(|(_, at)| at.elapsed() < VERDICT_TTL)
            .map(|(verdict, _)| *verdict)
    }

    /// Look the name up on the calling thread. Never call this from the
    /// interface thread.
    fn resolve(&self, host: &str, port: u16) -> Verdict {
        if let Some(verdict) = self.remembered(host, port) {
            return verdict;
        }
        let verdict = (self.lookup)(host, port);
        self.verdicts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert((host.to_owned(), port), (verdict, Instant::now()));
        verdict
    }

    /// Whether the webview may navigate to `url`. Safe on the interface
    /// thread: the lookup itself runs elsewhere and is waited for briefly.
    fn permits_navigation(self: &Arc<Self>, url: &Url) -> bool {
        match literal(url) {
            Literal::Refused => false,
            Literal::Public => true,
            Literal::Named { host, port } => {
                if let Some(verdict) = self.remembered(&host, port) {
                    return verdict == Verdict::Public;
                }
                let (sender, receiver) = mpsc::channel();
                let resolver = Arc::clone(self);
                std::thread::spawn(move || {
                    let _ = sender.send(resolver.resolve(&host, port));
                });
                receiver.recv_timeout(NAVIGATION_PATIENCE) == Ok(Verdict::Public)
            }
        }
    }

    /// Whether an agent or the person may be shown `url`, with the reason
    /// when not. Looks names up on the calling thread.
    fn check(&self, url: &Url) -> Result<(), ContractError> {
        match literal(url) {
            Literal::Refused => Err(blocked(url)),
            Literal::Public => Ok(()),
            Literal::Named { host, port } => match self.resolve(&host, port) {
                Verdict::Public => Ok(()),
                Verdict::Private => Err(blocked(url)),
                Verdict::Unresolved => Err(self.unresolved(&host)),
            },
        }
    }

    /// A name that does not resolve is either wrong or this computer has no
    /// working network. One more lookup of a name that always exists tells
    /// the two apart.
    fn unresolved(&self, host: &str) -> ContractError {
        let home = Url::parse(HOME).ok();
        let reference = home.as_ref().and_then(Url::host_str).unwrap_or_default();
        let offline = host != reference && (self.lookup)(reference, 443) == Verdict::Unresolved;
        if offline {
            ContractError::new(
                "NOT_FOUND",
                format!("Cannot look up {host}: this computer appears to be offline"),
            )
            .with_repair("Check the network connection, then try again.")
            .with_details(json!({ "reason": "offline", "host": host }))
        } else {
            ContractError::new("NOT_FOUND", format!("No such host: {host}"))
                .with_repair("Check the address for a typing mistake.")
                .with_details(json!({ "reason": "host_not_found", "host": host }))
        }
    }
}

fn parse(url: &str) -> Result<Url, ContractError> {
    Url::parse(url).map_err(|_| invalid(format!("Bad research URL: {url}")))
}

fn without_fragment(url: &Url) -> Url {
    let mut url = url.clone();
    url.set_fragment(None);
    url
}

pub struct WebviewSurface {
    app: tauri::AppHandle,
    resolver: Arc<Resolver>,
}

impl WebviewSurface {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            resolver: Resolver::new(lookup),
        }
    }

    fn window(&self) -> Option<tauri::WebviewWindow> {
        self.app.get_webview_window(LABEL)
    }

    fn loaded(&self) -> Result<tauri::WebviewWindow, ContractError> {
        self.window()
            .ok_or_else(|| invalid("No research page loaded"))
    }

    /// Point the window at `url`, creating it when needed. A window created
    /// here stays out of the way: hidden and unfocused unless `reveal`.
    fn navigate(&self, url: Url, reveal: bool) -> Result<tauri::WebviewWindow, ContractError> {
        if let Some(window) = self.window() {
            window.navigate(url).map_err(internal)?;
            return Ok(window);
        }
        let resolver = Arc::clone(&self.resolver);
        WebviewWindowBuilder::new(&self.app, LABEL, WebviewUrl::External(url))
            .title("Research · Omen Flow")
            .inner_size(560.0, 800.0)
            .incognito(true)
            .visible(reveal)
            .focused(reveal)
            .on_navigation(move |url| resolver.permits_navigation(url))
            .build()
            .map_err(internal)
    }

    fn eval(
        &self,
        window: &tauri::WebviewWindow,
        script: &str,
        timed_out: &str,
    ) -> Result<String, ContractError> {
        let (sender, receiver) = mpsc::channel();
        window
            .eval_with_callback(script, move |result| {
                let _ = sender.send(result);
            })
            .map_err(internal)?;
        receiver.recv_timeout(SCRIPT_TIMEOUT).map_err(|_| {
            ContractError::new("TIMEOUT", timed_out)
                .with_repair("Try again; the page may still be busy.")
        })
    }

    fn extract(&self, window: &tauri::WebviewWindow) -> Result<Value, ContractError> {
        let raw = self.eval(window, EXTRACT, "Research page extraction timed out")?;
        let page: Value = serde_json::from_str(&raw)
            .map_err(|e| internal(format!("Research extraction failed: {e}")))?;
        if !page.is_object() {
            return Err(internal("Research page extraction returned no document"));
        }
        Ok(page)
    }
}

/// Drop the fields the reader uses only to decide whether a page is ready.
fn published(mut page: Value) -> Value {
    if let Some(fields) = page.as_object_mut() {
        fields.remove("readyState");
        fields.remove("replaced");
    }
    page
}

impl ResearchSurface for WebviewSurface {
    fn load(&self, url: &str) -> Result<Value, ContractError> {
        let url = parse(url)?;
        self.resolver.check(&url)?;
        let previous = self.window().and_then(|window| window.url().ok());
        // Moving to a fragment of the document that is already loaded does
        // not replace it, so there is no new document to wait for.
        let same_document = previous.as_ref().is_some_and(|previous| {
            without_fragment(previous) == without_fragment(&url)
                && (previous != &url || url.fragment().is_some())
        });
        if let Some(window) = self.window().filter(|_| !same_document) {
            let _ = window.eval(MARK_STALE);
        }
        let window = self.navigate(url.clone(), false)?;
        let started = Instant::now();
        while started.elapsed() < LOAD_TIMEOUT {
            // A public redirect is legitimate. Wait until the old document
            // has been replaced, then require the extracted document to be
            // the one the webview shows.
            let current = window.url().ok();
            let page = current
                .as_ref()
                .filter(|current| self.resolver.check(current).is_ok())
                .and_then(|_| self.extract(&window).ok());
            if let (Some(current), Some(page)) = (current, page) {
                let ready = page["url"].as_str() == Some(current.as_str())
                    && page["readyState"] == "complete"
                    && page["replaced"] != true
                    && page["text"]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty());
                if ready {
                    return Ok(published(page));
                }
            }
            std::thread::sleep(Duration::from_millis(80));
        }
        Err(ContractError::new(
            "TIMEOUT",
            format!(
                "Research page did not finish loading in {} seconds",
                LOAD_TIMEOUT.as_secs()
            ),
        )
        .with_repair("The page may need interaction, be very slow, or hold no readable text (a PDF, for example). Try another address for the same information.")
        .with_details(json!({ "url": url.as_str() })))
    }

    fn read(&self) -> Result<Value, ContractError> {
        let window = self.loaded()?;
        let current = window.url().map_err(internal)?;
        self.resolver.check(&current)?;
        self.extract(&window).map(published)
    }

    fn link(&self, selector: &str) -> Result<Option<String>, ContractError> {
        let script = format!(
            "(() => document.querySelector({})?.href ?? null)()",
            json!(selector)
        );
        let raw = self.eval(&self.loaded()?, &script, "Link lookup timed out")?;
        serde_json::from_str(&raw).map_err(internal)
    }

    fn screenshot(&self) -> Result<Value, ContractError> {
        let window = self.loaded()?;
        let frame = crate::capture::window_image(&window).map_err(|failure| match failure {
            crate::capture::Failure::NotShown => {
                internal("Research window was not available for capture")
                    .with_repair("Show the Research window, then capture again.")
            }
            crate::capture::Failure::Failed(why) => {
                internal(format!("Research capture failed: {why}"))
            }
        })?;
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(frame)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .map_err(internal)?;
        Ok(
            json!({"pngBase64":base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())}),
        )
    }

    fn toggle(&self) -> Result<Value, ContractError> {
        if let Some(window) = self.window() {
            let visible = window.is_visible().map_err(internal)?;
            if visible {
                window.hide()
            } else {
                window.show().and_then(|()| window.set_focus())
            }
            .map_err(internal)?;
            Ok(json!({"visible":!visible}))
        } else {
            let home = parse(HOME)?;
            self.resolver.check(&home)?;
            self.navigate(home, true)?;
            Ok(json!({"visible":true}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    /// A resolver for a network where only `public.example` and the research
    /// home exist, `intranet.example` is on a private address, and
    /// `slow.example` takes longer than the interface thread will wait.
    /// Returns the resolver and how many lookups it has made.
    fn scripted() -> (Arc<Resolver>, Arc<AtomicUsize>) {
        let lookups = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&lookups);
        let resolver = Resolver::new(move |host, _port| {
            counter.fetch_add(1, Ordering::SeqCst);
            match host {
                "public.example" | "duckduckgo.com" => Verdict::Public,
                "intranet.example" => Verdict::Private,
                "slow.example" => {
                    std::thread::sleep(NAVIGATION_PATIENCE * 3);
                    Verdict::Public
                }
                _ => Verdict::Unresolved,
            }
        });
        (resolver, lookups)
    }

    #[test]
    fn research_urls_block_local_and_non_http() {
        for address in [
            "file:///etc/passwd",
            "http://localhost:3000",
            "http://LOCALHOST./",
            "http://printer.local/",
            "http://app.localhost/",
            "http://127.0.0.1/",
            "http://10.0.0.1/",
            "http://[::1]/",
            "http://[::ffff:192.168.1.1]/",
            "http://169.254.169.254/",
            "https://user:secret@public.example/",
            "tauri://localhost/index.html",
        ] {
            assert_eq!(literal(&url(address)), Literal::Refused, "{address}");
            let error = scripted().0.check(&url(address)).unwrap_err();
            assert_eq!(error.code, "CONNECTION_DENIED", "{address}");
            assert_eq!(error.details.unwrap()["reason"], "private_destination");
        }
        assert_eq!(literal(&url("https://93.184.216.34/")), Literal::Public);
        assert_eq!(
            literal(&url("https://Public.Example:8443/x")),
            Literal::Named {
                host: "public.example".into(),
                port: 8443
            }
        );
        assert!(parse("not a url").is_err());
    }

    #[test]
    fn names_are_judged_by_what_they_resolve_to() {
        let (resolver, lookups) = scripted();
        resolver.check(&url("https://public.example/part")).unwrap();
        resolver
            .check(&url("https://public.example/other"))
            .unwrap();
        assert_eq!(lookups.load(Ordering::SeqCst), 1, "one lookup per name");
        let private = resolver
            .check(&url("https://intranet.example/"))
            .unwrap_err();
        assert_eq!(private.code, "CONNECTION_DENIED");
        let missing = resolver.check(&url("https://typo.example/")).unwrap_err();
        assert_eq!(missing.code, "NOT_FOUND");
        assert_eq!(missing.message, "No such host: typo.example");
        assert_eq!(missing.details.unwrap()["reason"], "host_not_found");
    }

    #[test]
    fn no_network_is_reported_as_offline_not_as_a_blocked_address() {
        let error = Resolver::new(|_, _| Verdict::Unresolved)
            .check(&url("https://public.example/"))
            .unwrap_err();
        assert_eq!(error.code, "NOT_FOUND");
        assert_eq!(
            error.message,
            "Cannot look up public.example: this computer appears to be offline"
        );
        assert_eq!(error.details.unwrap()["reason"], "offline");
        assert!(error.repair.unwrap().contains("network connection"));
    }

    #[test]
    fn the_interface_thread_uses_remembered_verdicts_and_never_waits_long() {
        let (resolver, lookups) = scripted();
        assert!(resolver.permits_navigation(&url("https://93.184.216.34/")));
        assert!(!resolver.permits_navigation(&url("http://192.168.0.10/")));
        assert_eq!(
            lookups.load(Ordering::SeqCst),
            0,
            "addresses need no lookup"
        );
        assert!(resolver.permits_navigation(&url("https://public.example/")));
        assert!(!resolver.permits_navigation(&url("https://intranet.example/")));
        assert_eq!(lookups.load(Ordering::SeqCst), 2);

        let started = Instant::now();
        for _ in 0..50 {
            assert!(resolver.permits_navigation(&url("https://public.example/other")));
            assert!(!resolver.permits_navigation(&url("https://intranet.example/x")));
        }
        assert!(started.elapsed() < NAVIGATION_PATIENCE);
        assert_eq!(
            lookups.load(Ordering::SeqCst),
            2,
            "remembered, not looked up again"
        );

        let started = Instant::now();
        assert!(
            !resolver.permits_navigation(&url("https://slow.example/")),
            "an unanswered lookup refuses the navigation"
        );
        assert!(started.elapsed() < NAVIGATION_PATIENCE * 2);
        std::thread::sleep(NAVIGATION_PATIENCE * 3);
        assert!(
            resolver.permits_navigation(&url("https://slow.example/")),
            "the finished lookup answers the retry"
        );
    }

    #[test]
    fn fragments_do_not_make_a_different_document() {
        assert_eq!(
            without_fragment(&url("https://public.example/a?b=1#specs")),
            url("https://public.example/a?b=1")
        );
    }

    #[test]
    fn reader_bookkeeping_is_not_published() {
        let page = published(json!({
            "url": "https://public.example/", "text": "x", "readyState": "complete", "replaced": false
        }));
        assert_eq!(
            page,
            json!({ "url": "https://public.example/", "text": "x" })
        );
    }
}
