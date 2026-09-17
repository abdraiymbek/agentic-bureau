use serde_json::{Map, Value};

fn region(source: &str) -> Option<(usize, usize, usize)> {
    let opener_len = if source.starts_with("---\r\n") {
        5
    } else if source.starts_with("---\n") {
        4
    } else {
        return None;
    };
    let bytes = source.as_bytes();
    let mut line_start = opener_len;
    while line_start <= bytes.len() {
        let line_end = bytes[line_start..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| line_start + i)
            .unwrap_or(bytes.len());
        let line = source[line_start..line_end]
            .strip_suffix('\r')
            .unwrap_or(&source[line_start..line_end]);
        if line == "---" {
            let body_offset = if line_end < bytes.len() {
                line_end + 1
            } else {
                bytes.len()
            };
            return Some((opener_len, line_start, body_offset));
        }
        if line_end == bytes.len() {
            return None;
        }
        line_start = line_end + 1;
    }
    None
}

fn key_of(line: &str) -> Option<&str> {
    if line.is_empty() || line.starts_with(|c: char| c.is_whitespace()) {
        return None;
    }
    let colon = line.find(':')?;
    let key = line[..colon].trim_end();
    if key.is_empty() || key.starts_with('-') || key.starts_with('#') {
        return None;
    }
    Some(key)
}

fn scalar_yaml(value: &Value) -> String {
    match value {
        Value::String(s) => {
            let safe = !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ' '))
                && s.chars().any(|c| c.is_ascii_alphabetic())
                && !matches!(
                    s.to_ascii_lowercase().as_str(),
                    "true" | "false" | "null" | "yes" | "no" | "on" | "off" | "~"
                );
            if safe {
                s.clone()
            } else {
                serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
            }
        }
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_string()),
    }
}

pub(crate) fn patch_source(source: &str, patch: &Map<String, Value>) -> String {
    let newline = if source.starts_with("---\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let writes: Vec<(&String, String)> = patch
        .iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| (k, format!("{k}: {}", scalar_yaml(v))))
        .collect();
    let removals: Vec<&String> = patch
        .iter()
        .filter(|(_, v)| v.is_null())
        .map(|(k, _)| k)
        .collect();

    let Some((yaml_start, closer_start, body_offset)) = region(source) else {
        if writes.is_empty() {
            return source.to_string();
        }
        let body = writes
            .iter()
            .map(|(_, line)| line.as_str())
            .collect::<Vec<_>>()
            .join(newline);
        return format!("---{newline}{body}{newline}---{newline}{newline}{source}");
    };

    let yaml = &source[yaml_start..closer_start];
    let mut lines: Vec<String> = yaml
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();
    if lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }

    for (key, rendered) in &writes {
        match lines.iter().position(|l| key_of(l) == Some(key.as_str())) {
            Some(i) => {
                lines[i] = rendered.clone();
                while lines
                    .get(i + 1)
                    .is_some_and(|l| l.starts_with(|c: char| c == ' ' || c == '\t'))
                {
                    lines.remove(i + 1);
                }
            }
            None => lines.push(rendered.clone()),
        }
    }
    for key in &removals {
        if let Some(i) = lines.iter().position(|l| key_of(l) == Some(key.as_str())) {
            lines.remove(i);
            while lines.get(i).is_some_and(|l| l.starts_with(|c: char| c == ' ' || c == '\t')) {
                lines.remove(i);
            }
        }
    }

    format!(
        "---{newline}{}{newline}---{newline}{}",
        lines.join(newline),
        &source[body_offset..]
    )
}

pub(crate) fn valid_iso_date(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |i: usize| b[i].is_ascii_digit();
    if !(0..10).filter(|&i| i != 4 && i != 7).all(digits) {
        return false;
    }
    let month = (b[5] - b'0') as u32 * 10 + (b[6] - b'0') as u32;
    let day = (b[8] - b'0') as u32 * 10 + (b[9] - b'0') as u32;
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

pub(crate) fn valid_time(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 5 || b[2] != b':' {
        return false;
    }
    if !b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit()) {
        return false;
    }
    let hour = (b[0] - b'0') as u32 * 10 + (b[1] - b'0') as u32;
    let minute = (b[3] - b'0') as u32 * 10 + (b[4] - b'0') as u32;
    hour <= 23 && minute <= 59
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(entries: &[(&str, Value)]) -> Map<String, Value> {
        entries.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn patch_on_plain_source_prepends_a_block() {
        let out = patch_source("# Note\nbody\n", &patch(&[("status", json!("active"))]));
        assert_eq!(out, "---\nstatus: active\n---\n\n# Note\nbody\n");
    }

    #[test]
    fn patch_rewrites_an_existing_key_in_place() {
        let src = "---\ntype: project\nstatus: active\n---\n\n# P\n";
        let out = patch_source(src, &patch(&[("status", json!("done"))]));
        assert_eq!(out, "---\ntype: project\nstatus: done\n---\n\n# P\n");
    }

    #[test]
    fn patch_appends_a_missing_key_before_the_closer() {
        let src = "---\nstatus: active\n---\nbody";
        let out = patch_source(src, &patch(&[("deadline", json!("2026-03-01"))]));
        assert_eq!(out, "---\nstatus: active\ndeadline: \"2026-03-01\"\n---\nbody");
    }

    #[test]
    fn a_null_value_removes_the_key_and_its_nested_block() {
        let src = "---\nstatus: active\nmeta:\n  a: 1\n  b: 2\ntitle: x\n---\nb";
        let out = patch_source(src, &patch(&[("meta", Value::Null)]));
        assert_eq!(out, "---\nstatus: active\ntitle: x\n---\nb");
    }

    #[test]
    fn replacing_a_scalar_key_drops_its_nested_children() {
        let src = "---\nproject:\n  name: k\nstatus: active\n---\nb";
        let out = patch_source(src, &patch(&[("project", json!("Kineon"))]));
        assert_eq!(out, "---\nproject: Kineon\nstatus: active\n---\nb");
    }

    #[test]
    fn strings_with_special_characters_are_quoted() {
        let out = patch_source("", &patch(&[("title", json!("a: b #c"))]));
        assert_eq!(out, "---\ntitle: \"a: b #c\"\n---\n\n");
    }

    #[test]
    fn patched_source_still_parses() {
        let src = "---\ntype: project\nstatus: active\n---\n\n# P\n";
        let out = patch_source(
            src,
            &patch(&[
                ("status", json!("paused")),
                ("deadline", json!("2026-03-01")),
                ("description", json!("two words: here")),
            ]),
        );
        let fm = simple_directory_ast::parse_frontmatter(&out).expect("parses");
        assert_eq!(fm.get_string("status"), Some("paused"));
        assert_eq!(fm.get_string("deadline"), Some("2026-03-01"));
        assert_eq!(fm.get_string("description"), Some("two words: here"));
        assert_eq!(fm.get_string("type"), Some("project"));
    }

    #[test]
    fn crlf_blocks_stay_crlf() {
        let src = "---\r\nstatus: active\r\n---\r\nbody\r\n";
        let out = patch_source(src, &patch(&[("status", json!("done"))]));
        assert_eq!(out, "---\r\nstatus: done\r\n---\r\nbody\r\n");
    }

    #[test]
    fn dates_and_times_are_validated() {
        assert!(valid_iso_date("2026-02-01"));
        assert!(!valid_iso_date("2026-13-01"));
        assert!(!valid_iso_date("2026-02-32"));
        assert!(!valid_iso_date("02-01-2026"));
        assert!(!valid_iso_date("2026-2-1"));
        assert!(valid_time("09:30"));
        assert!(valid_time("23:59"));
        assert!(!valid_time("24:00"));
        assert!(!valid_time("9:30"));
        assert!(!valid_time("09:60"));
    }
}
