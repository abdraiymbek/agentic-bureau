//! A deliberately plain HTTP client: every byte the host sees is written here,
//! so the tests control headers a real client library would add or hide.
#![allow(dead_code)]

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub struct Response {
    pub status: u16,
    pub head: String,
    pub body: Value,
}

pub struct Call<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub host: Option<String>,
    pub token: Option<&'a str>,
    pub headers: Vec<(&'a str, &'a str)>,
    pub body: Option<String>,
}

impl<'a> Call<'a> {
    pub fn get(path: &'a str) -> Self {
        Self {
            method: "GET",
            path,
            host: None,
            token: None,
            headers: Vec::new(),
            body: None,
        }
    }

    pub fn post(path: &'a str, body: Value) -> Self {
        Self {
            method: "POST",
            body: Some(body.to_string()),
            headers: vec![("Content-Type", "application/json")],
            ..Self::get(path)
        }
    }

    pub fn token(mut self, token: &'a str) -> Self {
        self.token = Some(token);
        self
    }

    pub fn header(mut self, name: &'a str, value: &'a str) -> Self {
        self.headers
            .retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
        self.headers.push((name, value));
        self
    }

    pub fn host(mut self, host: &str) -> Self {
        self.host = Some(host.to_owned());
        self
    }

    fn write(&self, port: u16, stream: &mut TcpStream) {
        let host = self
            .host
            .clone()
            .unwrap_or_else(|| format!("127.0.0.1:{port}"));
        let mut text = format!(
            "{} {} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n",
            self.method, self.path
        );
        if let Some(token) = self.token {
            text.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        for (name, value) in &self.headers {
            text.push_str(&format!("{name}: {value}\r\n"));
        }
        if let Some(body) = &self.body {
            text.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        text.push_str("\r\n");
        stream.write_all(text.as_bytes()).unwrap();
        if let Some(body) = &self.body {
            stream.write_all(body.as_bytes()).unwrap();
        }
    }

    pub fn send(&self, port: u16) -> Response {
        let mut stream = connect(port);
        self.write(port, &mut stream);
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let text = String::from_utf8(raw).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").expect("a complete response");
        Response {
            status: status_of(head),
            head: head.to_owned(),
            body: serde_json::from_str(body).unwrap_or(Value::Null),
        }
    }

    /// Open the request as an event stream and hand back the reader.
    pub fn stream(&self, port: u16) -> Result<EventStream, Response> {
        let mut stream = connect(port);
        self.write(port, &mut stream);
        let mut reader = BufReader::new(stream);
        let mut head = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" || line.is_empty() {
                break;
            }
            head.push_str(&line);
        }
        if status_of(&head) != 200 || !head.contains("text/event-stream") {
            let mut body = String::new();
            reader.read_to_string(&mut body).unwrap();
            return Err(Response {
                status: status_of(&head),
                head,
                body: serde_json::from_str(&body).unwrap_or(Value::Null),
            });
        }
        Ok(EventStream { reader })
    }
}

fn connect(port: u16) -> TcpStream {
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    stream
}

fn status_of(head: &str) -> u16 {
    head.split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("a status line")
}

pub struct Event {
    pub id: Option<String>,
    pub name: String,
    pub data: Value,
}

pub struct EventStream {
    reader: BufReader<TcpStream>,
}

impl EventStream {
    /// The next event, skipping comments. `None` when the stream ends or
    /// stays silent past the read timeout.
    pub fn next(&mut self) -> Option<Event> {
        let (mut id, mut name, mut data) = (None, None, None);
        loop {
            let mut line = String::new();
            if self.reader.read_line(&mut line).ok()? == 0 {
                return None;
            }
            let line = line.trim_end_matches('\n');
            if let Some(value) = line.strip_prefix("id: ") {
                id = Some(value.to_owned());
            } else if let Some(value) = line.strip_prefix("event: ") {
                name = Some(value.to_owned());
            } else if let Some(value) = line.strip_prefix("data: ") {
                data = Some(serde_json::from_str(value).expect("event data is JSON"));
            } else if line.is_empty() {
                if let (Some(name), Some(data)) = (name.take(), data.take()) {
                    return Some(Event { id, name, data });
                }
            }
        }
    }

    /// Read until an event satisfies `wanted`.
    pub fn find(&mut self, wanted: impl Fn(&Event) -> bool) -> Option<Event> {
        loop {
            let event = self.next()?;
            if wanted(&event) {
                return Some(event);
            }
        }
    }
}
