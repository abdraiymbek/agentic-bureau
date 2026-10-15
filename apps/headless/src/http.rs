//! The small part of HTTP/1.1 this host speaks: one request line, headers,
//! an optional `Content-Length` body, and JSON or event-stream responses.
//! Everything else is refused with a status that says why.

use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};

/// Request line and headers together.
pub(crate) const MAX_HEAD_BYTES: usize = 16 * 1024;
/// Largest accepted body. Matches two bridge frames, enough for a file write
/// carried as base64 inside a command.
pub(crate) const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct Request {
    pub method: String,
    pub path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    /// The single value of a header, by lowercase name. A header sent twice
    /// is treated as absent so no check can be satisfied by one copy while
    /// another is used.
    pub fn header(&self, name: &str) -> Option<&str> {
        let mut values = self
            .headers
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.as_str());
        let first = values.next()?;
        values.next().is_none().then_some(first)
    }

    pub fn has_header(&self, name: &str) -> bool {
        self.headers.iter().any(|(key, _)| key == name)
    }

    pub fn query(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn wants_close(&self) -> bool {
        self.header("connection")
            .is_some_and(|value| value.eq_ignore_ascii_case("close"))
    }
}

/// Why a request could not be read.
#[derive(Debug)]
pub(crate) enum Rejected {
    /// The peer went away or stayed silent; there is nobody to answer.
    Closed,
    /// The bytes on the wire were not a request this host accepts.
    Status(u16, &'static str),
}

impl From<io::Error> for Rejected {
    fn from(_: io::Error) -> Self {
        Self::Closed
    }
}

/// Read one request. `stream` is both the buffered reader and the writer,
/// because `Expect: 100-continue` is answered before the body arrives.
pub(crate) fn read_request<S: BufRead + Write>(stream: &mut S) -> Result<Request, Rejected> {
    let head = read_head(stream)?;
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Rejected::Status(400, "Malformed request line"));
    };
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(Rejected::Status(400, "Unsupported HTTP version"));
    }
    if !target.starts_with('/') {
        return Err(Rejected::Status(400, "Request target must be a path"));
    }
    let mut headers = Vec::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return Err(Rejected::Status(400, "Malformed header"));
        };
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.!#$%&'*+^`|~".contains(&byte))
        {
            return Err(Rejected::Status(400, "Malformed header name"));
        }
        headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut request = Request {
        method: method.to_owned(),
        path: path.to_owned(),
        query: parse_query(query),
        headers,
        body: Vec::new(),
    };
    if request.has_header("transfer-encoding") {
        return Err(Rejected::Status(
            411,
            "Send a Content-Length; chunked bodies are not accepted",
        ));
    }
    let length = match (
        request.has_header("content-length"),
        request.header("content-length"),
    ) {
        (false, _) => 0,
        (true, Some(value)) if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
            value
                .parse::<usize>()
                .map_err(|_| Rejected::Status(413, "Request body is too large"))?
        }
        _ => return Err(Rejected::Status(400, "Malformed Content-Length")),
    };
    if length > MAX_BODY_BYTES {
        return Err(Rejected::Status(413, "Request body is too large"));
    }
    if length > 0 {
        if request
            .header("expect")
            .is_some_and(|value| value.eq_ignore_ascii_case("100-continue"))
        {
            stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
            stream.flush()?;
        }
        request.body = vec![0; length];
        stream.read_exact(&mut request.body)?;
    }
    Ok(request)
}

fn read_head(stream: &mut impl BufRead) -> Result<String, Rejected> {
    let mut head = Vec::new();
    let mut leading_blank_lines = 0;
    loop {
        let before = head.len();
        let budget = (MAX_HEAD_BYTES + 1 - before) as u64;
        let read = stream.by_ref().take(budget).read_until(b'\n', &mut head)?;
        if read == 0 {
            return Err(Rejected::Closed);
        }
        if head.len() > MAX_HEAD_BYTES {
            return Err(Rejected::Status(431, "Request headers are too large"));
        }
        if !head.ends_with(b"\r\n") {
            return Err(if head.ends_with(b"\n") {
                Rejected::Status(400, "Header lines must end with CRLF")
            } else {
                Rejected::Closed
            });
        }
        if &head[before..] == b"\r\n" {
            if before > 0 {
                break;
            }
            // A blank line or two is tolerated between keep-alive requests.
            leading_blank_lines += 1;
            if leading_blank_lines > 2 {
                return Err(Rejected::Status(400, "Malformed request line"));
            }
            head.clear();
        }
    }
    String::from_utf8(head).map_err(|_| Rejected::Status(400, "Headers must be UTF-8"))
}

fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect()
}

fn percent_decode(text: &str) -> String {
    let hex = |byte: Option<&u8>| byte.and_then(|byte| (*byte as char).to_digit(16));
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escaped = match bytes[index] {
            b'%' => hex(bytes.get(index + 1)).zip(hex(bytes.get(index + 2))),
            _ => None,
        };
        if let Some((high, low)) = escaped {
            decoded.push((high * 16 + low) as u8);
            index += 3;
        } else {
            decoded.push(if bytes[index] == b'+' {
                b' '
            } else {
                bytes[index]
            });
            index += 1;
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Content Too Large",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

/// Write a JSON response. Responses are never cacheable and never carry
/// cross-origin permissions.
pub(crate) fn respond_json(
    stream: &mut impl Write,
    status: u16,
    body: &Value,
    keep_alive: bool,
) -> io::Result<()> {
    let body = serde_json::to_vec(body).map_err(io::Error::other)?;
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: {}\r\n",
        reason(status),
        body.len(),
        if keep_alive { "keep-alive" } else { "close" },
    );
    if status == 401 {
        head.push_str("WWW-Authenticate: Bearer\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&body)?;
    stream.flush()
}

/// The body every refusal carries, in the contract's error shape.
pub(crate) fn refusal(code: &str, message: &str) -> Value {
    json!({ "ok": false, "error": { "code": code, "message": message } })
}

pub(crate) fn begin_event_stream(stream: &mut impl Write) -> io::Result<()> {
    stream.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Accel-Buffering: no\r\nConnection: close\r\n\r\n",
    )?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// A reader and a writer glued together, standing in for a socket.
    struct Wire {
        input: Cursor<Vec<u8>>,
        output: Vec<u8>,
    }

    impl Wire {
        fn new(input: &[u8]) -> Self {
            Self {
                input: Cursor::new(input.to_vec()),
                output: Vec::new(),
            }
        }
    }

    impl Read for Wire {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.input.read(buffer)
        }
    }

    impl BufRead for Wire {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            self.input.fill_buf()
        }
        fn consume(&mut self, amount: usize) {
            self.input.consume(amount)
        }
    }

    impl Write for Wire {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.output.write(bytes)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn status(input: &[u8]) -> u16 {
        match read_request(&mut Wire::new(input)) {
            Err(Rejected::Status(status, _)) => status,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_request_with_a_body_and_query_is_parsed() {
        let mut wire = Wire::new(
            b"POST /api/command?token=a%2Bb+c&flag HTTP/1.1\r\nHost: 127.0.0.1:9\r\nContent-Length: 2\r\nX-Note:  spaced \r\n\r\n{}",
        );
        let request = read_request(&mut wire).unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/api/command");
        assert_eq!(request.query("token"), Some("a+b c"));
        assert_eq!(request.query("flag"), Some(""));
        assert_eq!(request.header("host"), Some("127.0.0.1:9"));
        assert_eq!(request.header("x-note"), Some("spaced"));
        assert_eq!(request.body, b"{}");
        assert!(!request.wants_close());
    }

    #[test]
    fn two_requests_on_one_connection_are_read_in_turn() {
        let mut wire = Wire::new(
            b"GET /a HTTP/1.1\r\nHost: x\r\n\r\n\r\nGET /b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        );
        assert_eq!(read_request(&mut wire).unwrap().path, "/a");
        let second = read_request(&mut wire).unwrap();
        assert_eq!(second.path, "/b");
        assert!(second.wants_close());
        assert!(matches!(read_request(&mut wire), Err(Rejected::Closed)));
    }

    #[test]
    fn a_repeated_header_never_counts_as_present_once() {
        let mut wire =
            Wire::new(b"GET / HTTP/1.1\r\nHost: 127.0.0.1:1\r\nHost: evil.example\r\n\r\n");
        let request = read_request(&mut wire).unwrap();
        assert!(request.has_header("host"));
        assert_eq!(request.header("host"), None);
    }

    #[test]
    fn expect_continue_is_answered_before_the_body_is_read() {
        let mut wire = Wire::new(
            b"POST / HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 4\r\n\r\nbody",
        );
        let request = read_request(&mut wire).unwrap();
        assert_eq!(request.body, b"body");
        assert_eq!(wire.output, b"HTTP/1.1 100 Continue\r\n\r\n");
    }

    #[test]
    fn malformed_and_oversized_requests_are_refused_with_a_reason() {
        assert_eq!(status(b"GET /\r\n\r\n"), 400);
        assert_eq!(status(b"GET / HTTP/2\r\n\r\n"), 400);
        assert_eq!(status(b"GET http://127.0.0.1/ HTTP/1.1\r\n\r\n"), 400);
        assert_eq!(status(b"GET / HTTP/1.1\r\nNo colon\r\n\r\n"), 400);
        assert_eq!(status(b"GET / HTTP/1.1\r\nBad name: x\r\n\r\n"), 400);
        assert_eq!(status(b"GET / HTTP/1.1\nHost: x\n\n"), 400);
        assert_eq!(
            status(b"POST / HTTP/1.1\r\nContent-Length: -1\r\n\r\n"),
            400
        );
        assert_eq!(
            status(b"POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx"),
            400
        );
        assert_eq!(
            status(b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"),
            411
        );
        let too_large = format!(
            "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY_BYTES + 1
        );
        assert_eq!(status(too_large.as_bytes()), 413);
        assert_eq!(
            status(b"POST / HTTP/1.1\r\nContent-Length: 99999999999999999999999999\r\n\r\n"),
            413
        );
        let long_head = format!(
            "GET / HTTP/1.1\r\nX-Pad: {}\r\n\r\n",
            "a".repeat(MAX_HEAD_BYTES)
        );
        assert_eq!(status(long_head.as_bytes()), 431);
    }

    #[test]
    fn a_silent_or_truncated_peer_is_not_answered() {
        assert!(matches!(
            read_request(&mut Wire::new(b"")),
            Err(Rejected::Closed)
        ));
        assert!(matches!(
            read_request(&mut Wire::new(b"GET / HTTP/1.1\r\nHost: x")),
            Err(Rejected::Closed)
        ));
        assert!(matches!(
            read_request(&mut Wire::new(
                b"POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\nshort"
            )),
            Err(Rejected::Closed)
        ));
    }

    #[test]
    fn json_responses_are_uncacheable_and_carry_no_cross_origin_headers() {
        let mut out = Vec::new();
        respond_json(&mut out, 401, &refusal("CONNECTION_DENIED", "no"), false).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with("HTTP/1.1 401 Unauthorized\r\n"));
        assert!(text.contains("Cache-Control: no-store\r\n"));
        assert!(text.contains("WWW-Authenticate: Bearer\r\n"));
        assert!(text.contains("Connection: close\r\n"));
        assert!(!text.to_ascii_lowercase().contains("access-control"));
        assert!(
            text.ends_with(r#"{"ok":false,"error":{"code":"CONNECTION_DENIED","message":"no"}}"#)
        );
    }

    #[test]
    fn percent_decoding_keeps_malformed_escapes_literal() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%4"), "%4");
    }
}
