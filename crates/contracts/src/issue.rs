//! One problem in a caller's input, and the translation from `jsonschema`
//! errors (which print the offending instance and no path) to that shape.

use crate::nearest::nearest_match;
use jsonschema::error::{ValidationError, ValidationErrorKind};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fmt::Write;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueKind {
    Required,
    Type,
    Enum,
    UnknownKey,
    Format,
    Pattern,
    Size,
    Range,
    Const,
    Other,
}

/// `path` is the dotted instance path (`expect.sections[0].axis`), empty for
/// the input as a whole. `message` reads on its own after the path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationIssue {
    pub path: String,
    pub kind: IssueKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub received: Option<String>,
    /// Closest allowed value or key, when one is close enough to suggest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nearest: Option<String>,
}

impl ValidationIssue {
    fn mismatch(path: String, kind: IssueKind, expected: String, received: String) -> Self {
        Self {
            message: format!("expected {expected}, received {received}"),
            path,
            kind,
            expected: Some(expected),
            received: Some(received),
            nearest: None,
        }
    }

    /// A key the object does not declare. `suggestion` overrides the edit-
    /// distance match when the caller already knows which key was meant.
    pub(crate) fn unknown_key(
        path: String,
        key: &str,
        allowed: &Map<String, Value>,
        suggestion: Option<&str>,
    ) -> Self {
        let nearest = suggestion
            .or_else(|| nearest_match(key, allowed.keys().map(String::as_str)))
            .map(str::to_owned);
        let keys = allowed.keys().map(String::as_str).collect::<Vec<_>>();
        let mut message = if keys.is_empty() {
            "unknown key, this object takes no keys".to_owned()
        } else {
            format!("unknown key, allowed keys are {}", keys.join(", "))
        };
        if let Some(nearest) = &nearest {
            let _ = write!(message, " (nearest: {nearest})");
        }
        Self {
            path,
            kind: IssueKind::UnknownKey,
            message,
            expected: (!keys.is_empty()).then(|| format!("one of {}", keys.join(", "))),
            received: None,
            nearest,
        }
    }
}

/// An issue and the JSON pointer of the value it is about, kept until the
/// issues are put in order.
pub(crate) struct Located {
    pub(crate) pointer: String,
    pub(crate) issue: ValidationIssue,
}

/// Every failure `validator` finds in `instance`. `schema` is the document
/// the validator was compiled from.
pub(crate) fn collect(
    validator: &jsonschema::Validator,
    schema: &Value,
    instance: &Value,
) -> Vec<Located> {
    let mut found = Vec::new();
    for error in validator.iter_errors(instance) {
        convert(schema, instance, &error, &mut found);
    }
    found
}

/// Issues in the order a reader meets them, independent of the validator's
/// keyword order: at each object, keys that are not there (unknown, then
/// missing), then each member as the canonical value lists it.
pub(crate) fn ordered(root: &Value, mut found: Vec<Located>) -> Vec<ValidationIssue> {
    // Two keywords can say the same thing about one value.
    let mut seen = HashSet::new();
    found
        .retain(|located| seen.insert((located.issue.path.clone(), located.issue.message.clone())));
    found.sort_by_cached_key(|located| position(root, &located.pointer));
    found.into_iter().map(|located| located.issue).collect()
}

fn position(root: &Value, pointer: &str) -> Vec<(bool, usize)> {
    let mut current = Some(root);
    let mut position = Vec::new();
    for segment in pointer.split('/').skip(1) {
        let segment = unescape(segment);
        let (index, next) = match current {
            Some(Value::Array(items)) => {
                let index = segment.parse::<usize>().ok();
                (index, index.and_then(|index| items.get(index)))
            }
            Some(Value::Object(fields)) => (
                fields.keys().position(|key| *key == segment),
                fields.get(&segment),
            ),
            _ => (None, None),
        };
        position.push((next.is_some(), index.unwrap_or_default()));
        current = next;
    }
    position
}

fn convert(schema: &Value, root: &Value, error: &ValidationError<'_>, found: &mut Vec<Located>) {
    let schema_path = error.schema_path().as_str();
    // The schema object that owns the failed keyword.
    let node = schema_path
        .rsplit_once('/')
        .and_then(|(owner, _)| schema.pointer(owner));
    let here = error.instance_path().as_str();
    let path = dotted(root, here);
    let instance: &Value = error.instance();
    let described = || node.map_or_else(|| "a different value".to_owned(), describe);
    let mismatch = |kind: IssueKind, expected: String, received: String| {
        ValidationIssue::mismatch(path.clone(), kind, expected, received)
    };
    let wrong_type = || {
        let mut issue = mismatch(IssueKind::Type, described(), describe_value(instance));
        if let Some(hint) = type_hint(schema, schema_path, node, instance) {
            issue.message.push_str(hint);
        }
        issue
    };
    let bound = |relation: &str, limit: &Value| {
        mismatch(
            IssueKind::Range,
            format!("{relation} {limit}"),
            brief(instance),
        )
    };
    let issue = match error.kind() {
        ValidationErrorKind::Required { property } => {
            let key = property.as_str().unwrap_or_default();
            let expected = node
                .and_then(|node| node.get("properties")?.get(key))
                .map(describe);
            let issue = ValidationIssue {
                path: joined(&path, key),
                kind: IssueKind::Required,
                message: match &expected {
                    Some(expected) => format!("required, expected {expected}"),
                    None => "required".to_owned(),
                },
                expected,
                received: None,
                nearest: None,
            };
            return found.push(Located {
                pointer: member(here, key),
                issue,
            });
        }
        ValidationErrorKind::AdditionalProperties { unexpected } => {
            let empty = Map::new();
            let allowed = node
                .and_then(|node| node.get("properties")?.as_object())
                .unwrap_or(&empty);
            return found.extend(unexpected.iter().map(|key| Located {
                pointer: member(here, key),
                issue: ValidationIssue::unknown_key(joined(&path, key), key, allowed, None),
            }));
        }
        ValidationErrorKind::Type { .. } => wrong_type(),
        ValidationErrorKind::Enum { options } => {
            let nearest = instance.as_str().and_then(|text| {
                nearest_match(text, options.as_array()?.iter().filter_map(Value::as_str))
            });
            let mut issue = mismatch(IssueKind::Enum, described(), brief(instance));
            if let Some(nearest) = nearest {
                let _ = write!(issue.message, " (nearest: {})", Value::from(nearest));
                issue.nearest = Some(nearest.to_owned());
            }
            issue
        }
        ValidationErrorKind::Constant { expected_value } => {
            mismatch(IssueKind::Const, brief(expected_value), brief(instance))
        }
        ValidationErrorKind::Format { .. } => {
            mismatch(IssueKind::Format, described(), brief(instance))
        }
        ValidationErrorKind::Pattern { pattern } => mismatch(
            IssueKind::Pattern,
            format!("string matching {pattern}"),
            brief(instance),
        ),
        ValidationErrorKind::MinLength { limit } => mismatch(
            IssueKind::Size,
            format!("at least {}", count(*limit, "character")),
            brief(instance),
        ),
        ValidationErrorKind::MaxLength { limit } => mismatch(
            IssueKind::Size,
            format!("at most {}", count(*limit, "character")),
            count(
                instance.as_str().map_or(0, |text| text.chars().count()) as u64,
                "character",
            ),
        ),
        ValidationErrorKind::MinItems { limit } | ValidationErrorKind::MaxItems { limit } => {
            let at_least = matches!(error.kind(), ValidationErrorKind::MinItems { .. });
            let expected = node.and_then(item_count).unwrap_or_else(|| {
                let bound = if at_least { "at least" } else { "at most" };
                format!("{bound} {}", count(*limit, "item"))
            });
            mismatch(
                IssueKind::Size,
                expected,
                count(instance.as_array().map_or(0, Vec::len) as u64, "item"),
            )
        }
        ValidationErrorKind::Minimum { limit } => bound("at least", limit),
        ValidationErrorKind::Maximum { limit } => bound("at most", limit),
        ValidationErrorKind::ExclusiveMinimum { limit } => bound("a number greater than", limit),
        ValidationErrorKind::ExclusiveMaximum { limit } => bound("a number less than", limit),
        ValidationErrorKind::AnyOf { context } | ValidationErrorKind::OneOfNotValid { context } => {
            // Report the branch the caller was closest to: one whose type fits
            // the value, then the one with the fewest problems.
            let closest = context
                .iter()
                .map(|branch| {
                    let wrong_type = branch.iter().any(|inner| {
                        matches!(inner.kind(), ValidationErrorKind::Type { .. })
                            && inner.instance_path().as_str() == here
                    });
                    (wrong_type, branch)
                })
                .min_by_key(|(wrong_type, branch)| (*wrong_type, branch.len()));
            if let Some((false, branch)) = closest {
                for inner in branch {
                    convert(schema, root, inner, found);
                }
                return;
            }
            wrong_type()
        }
        _ => ValidationIssue {
            path,
            kind: IssueKind::Other,
            // The masked form names the rule without echoing the instance.
            message: error.masked().to_string(),
            expected: None,
            received: None,
            nearest: None,
        },
    };
    found.push(Located {
        pointer: here.to_owned(),
        issue,
    });
}

/// JSON pointer of `key` under the object at `pointer`.
pub(crate) fn member(pointer: &str, key: &str) -> String {
    format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1"))
}

/// The two wrong-type mistakes worth a sentence of their own: `null` for an
/// optional key, and a JSON document sent as a string.
fn type_hint(
    schema: &Value,
    schema_path: &str,
    node: Option<&Value>,
    instance: &Value,
) -> Option<&'static str> {
    match instance {
        Value::Null => {
            let (owner, _) = schema_path.rsplit_once('/')?;
            let (object, key) = owner
                .rsplit_once("/properties/")
                .filter(|(_, key)| !key.contains('/'))?;
            let required = schema.pointer(object)?.get("required");
            let key = unescape(key);
            (!required
                .and_then(Value::as_array)
                .is_some_and(|keys| keys.iter().any(|name| name.as_str() == Some(&key))))
            .then_some(", omit the key when there is no value")
        }
        Value::String(text) => {
            let container = node.and_then(|node| node.get("type")).is_some_and(|kind| {
                let is = |name: &Value| name == "object" || name == "array";
                is(kind) || kind.as_array().is_some_and(|names| names.iter().any(is))
            });
            (container && text.trim_start().starts_with(['{', '[']))
                .then_some(", send the JSON value itself rather than a string")
        }
        _ => None,
    }
}

/// What a schema accepts, short enough to put in an error message. Objects
/// are spelled out one level deep.
pub(crate) fn describe(schema: &Value) -> String {
    shape(schema, 0)
}

/// Enum options spelled out for a field nested in a described object.
const NESTED_OPTIONS: usize = 4;

fn shape(schema: &Value, depth: usize) -> String {
    if let Some(options) = schema.get("enum").and_then(Value::as_array) {
        // Inside an object's shape a long list would bury the other fields.
        if depth > 0 && options.len() > NESTED_OPTIONS {
            return format!("one of {} values", options.len());
        }
        let options = options.iter().map(Value::to_string).collect::<Vec<_>>();
        return format!("one of {}", options.join(", "));
    }
    if let Some(constant) = schema.get("const") {
        return constant.to_string();
    }
    for keyword in ["anyOf", "oneOf"] {
        if let Some(branches) = schema.get(keyword).and_then(Value::as_array) {
            let mut shapes = Vec::<String>::new();
            for branch in branches {
                let shape = shape(branch, depth);
                if !shapes.contains(&shape) {
                    shapes.push(shape);
                }
            }
            return shapes.join(" or ");
        }
    }
    match schema.get("type") {
        Some(Value::String(name)) => typed(schema, name, depth),
        Some(Value::Array(names)) => names
            .iter()
            .filter_map(Value::as_str)
            .map(|name| typed(schema, name, depth))
            .collect::<Vec<_>>()
            .join(" or "),
        _ => "any value".to_owned(),
    }
}

fn typed(schema: &Value, name: &str, depth: usize) -> String {
    let text = |keyword: &str| schema.get(keyword).and_then(Value::as_str);
    match name {
        "string" => match (text("format"), text("pattern")) {
            (Some(format), _) => format!("string ({format})"),
            (None, Some(pattern)) => format!("string matching {pattern}"),
            (None, None) => "string".to_owned(),
        },
        "array" => {
            let mut described = "array".to_owned();
            if let Some(items) = schema.get("items").filter(|items| items.is_object()) {
                let _ = write!(described, " of {}", shape(items, depth + 1));
            }
            if let Some(size) = item_count(schema) {
                let _ = write!(described, " ({size})");
            }
            described
        }
        "object" => object_shape(schema, depth),
        other => other.to_owned(),
    }
}

fn object_shape(schema: &Value, depth: usize) -> String {
    const SHOWN: usize = 8;
    let properties = schema.get("properties").and_then(Value::as_object);
    let additional = schema.get("additionalProperties");
    match properties.filter(|properties| !properties.is_empty()) {
        Some(properties) if depth == 0 => {
            let required = schema.get("required").and_then(Value::as_array);
            let mut fields = properties
                .iter()
                .take(SHOWN)
                .map(|(key, property)| {
                    let optional = !required
                        .is_some_and(|keys| keys.iter().any(|name| name.as_str() == Some(key)));
                    let mark = if optional { "?" } else { "" };
                    format!("{key}{mark}: {}", shape(property, depth + 1))
                })
                .collect::<Vec<_>>();
            if properties.len() > SHOWN {
                fields.push("…".to_owned());
            }
            format!("{{ {} }}", fields.join(", "))
        }
        Some(_) => "object".to_owned(),
        None => match additional {
            Some(Value::Bool(false)) => "empty object".to_owned(),
            Some(values) if values.is_object() && depth == 0 => {
                format!("object mapping names to {}", shape(values, depth + 1))
            }
            _ => "object".to_owned(),
        },
    }
}

fn item_count(schema: &Value) -> Option<String> {
    let bound = |keyword: &str| schema.get(keyword).and_then(Value::as_u64);
    match (bound("minItems"), bound("maxItems")) {
        (Some(min), Some(max)) if min == max => Some(format!("exactly {}", count(min, "item"))),
        (Some(min), Some(max)) => Some(format!("{min} to {}", count(max, "item"))),
        (Some(min), None) => Some(format!("at least {}", count(min, "item"))),
        (None, Some(max)) => Some(format!("at most {}", count(max, "item"))),
        (None, None) => None,
    }
}

fn count(number: u64, noun: &str) -> String {
    let plural = if number == 1 { "" } else { "s" };
    format!("{number} {noun}{plural}")
}

/// A received value by type, with scalars echoed and containers summarised.
pub(crate) fn describe_value(value: &Value) -> String {
    const SHOWN: usize = 6;
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => format!("boolean {flag}"),
        Value::Number(number) => format!("number {number}"),
        Value::String(_) => format!("string {}", brief(value)),
        Value::Array(items) => format!("array of {}", count(items.len() as u64, "item")),
        Value::Object(fields) if fields.is_empty() => "empty object".to_owned(),
        Value::Object(fields) => {
            let mut keys = fields
                .keys()
                .take(SHOWN)
                .map(String::as_str)
                .collect::<Vec<_>>();
            if fields.len() > SHOWN {
                keys.push("…");
            }
            format!("object with keys {}", keys.join(", "))
        }
    }
}

/// Compact JSON, cut so an echoed value cannot flood an error.
pub(crate) fn brief(value: &Value) -> String {
    const LIMIT: usize = 60;
    let text = value.to_string();
    if text.chars().count() <= LIMIT {
        return text;
    }
    let mut cut = text.chars().take(LIMIT - 1).collect::<String>();
    cut.push('…');
    cut
}

/// Append an object key to a dotted path: `a.b`, or `a["not an identifier"]`.
pub(crate) fn push_key(path: &mut String, key: &str) {
    let bare = key
        .chars()
        .next()
        .is_some_and(|first| first.is_alphabetic() || first == '_')
        && key
            .chars()
            .all(|character| character.is_alphanumeric() || character == '_');
    if !bare {
        let _ = write!(path, "[{}]", Value::from(key));
    } else if path.is_empty() {
        path.push_str(key);
    } else {
        let _ = write!(path, ".{key}");
    }
}

pub(crate) fn push_index(path: &mut String, index: usize) {
    let _ = write!(path, "[{index}]");
}

pub(crate) fn joined(path: &str, key: &str) -> String {
    let mut path = path.to_owned();
    push_key(&mut path, key);
    path
}

/// Dotted form of a JSON pointer into `root`. The instance decides whether a
/// numeric segment is an array index or an object key.
fn dotted(root: &Value, pointer: &str) -> String {
    let mut path = String::new();
    let mut current = Some(root);
    for segment in pointer.split('/').skip(1) {
        let segment = unescape(segment);
        match (current, segment.parse::<usize>()) {
            (Some(Value::Array(items)), Ok(index)) => {
                push_index(&mut path, index);
                current = items.get(index);
            }
            _ => {
                push_key(&mut path, &segment);
                current = current.and_then(|value| value.get(segment.as_str()));
            }
        }
    }
    path
}

fn unescape(segment: &str) -> String {
    segment.replace("~1", "/").replace("~0", "~")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn paths_use_dots_brackets_and_quote_unusual_keys() {
        let instance = json!({
            "expect": { "sections": [{ "holes": [{}, {}] }] },
            "properties": { "stall torque": {}, "0": { "a/b": 1 } }
        });
        assert_eq!(
            dotted(&instance, "/expect/sections/0/holes/1"),
            "expect.sections[0].holes[1]"
        );
        assert_eq!(
            dotted(&instance, "/properties/stall torque"),
            "properties[\"stall torque\"]"
        );
        // A numeric key of an object is a key, not an index.
        assert_eq!(
            dotted(&instance, "/properties/0/a~1b"),
            "properties[\"0\"][\"a/b\"]"
        );
        assert_eq!(dotted(&instance, ""), "");
    }

    #[test]
    fn schemas_are_described_one_level_deep() {
        assert_eq!(
            describe(&json!({ "type": "string", "format": "uuid" })),
            "string (uuid)"
        );
        assert_eq!(
            describe(&json!({ "type": "string", "pattern": "^https?:" })),
            "string matching ^https?:"
        );
        assert_eq!(
            describe(&json!({ "type": "string", "enum": ["x", "y", "z"] })),
            "one of \"x\", \"y\", \"z\""
        );
        assert_eq!(
            describe(&json!({ "type": ["string", "null"] })),
            "string or null"
        );
        assert_eq!(
            describe(&json!({
                "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3
            })),
            "array of number (exactly 3 items)"
        );
        assert_eq!(
            describe(&json!({
                "type": "array",
                "items": { "type": "object", "properties": { "at": { "type": "number" } } },
                "minItems": 1
            })),
            "array of object (at least 1 item)"
        );
        assert_eq!(
            describe(&json!({ "anyOf": [
                {
                    "type": "object",
                    "properties": {
                        "value": { "type": "number" },
                        "unit": { "type": "string" },
                        "min": { "type": "number" }
                    },
                    "required": ["value", "unit"]
                },
                {
                    "type": "object",
                    "properties": {
                        "unknown": { "type": "boolean", "const": true },
                        "reason": { "type": "string" }
                    },
                    "required": ["unknown", "reason"]
                }
            ] })),
            "{ value: number, unit: string, min?: number } or { unknown: true, reason: string }"
        );
        assert_eq!(
            describe(&json!({
                "type": "object",
                "additionalProperties": { "type": "object", "properties": { "value": {} } }
            })),
            "object mapping names to object"
        );
        assert_eq!(describe(&json!({})), "any value");
    }

    #[test]
    fn received_values_are_named_by_type_and_kept_short() {
        assert_eq!(describe_value(&json!(null)), "null");
        assert_eq!(describe_value(&json!("12")), "string \"12\"");
        assert_eq!(describe_value(&json!(12.5)), "number 12.5");
        assert_eq!(describe_value(&json!(true)), "boolean true");
        assert_eq!(describe_value(&json!([0, 0])), "array of 2 items");
        assert_eq!(describe_value(&json!({})), "empty object");
        assert_eq!(
            describe_value(&json!({ "value": 5, "unit": "g" })),
            "object with keys value, unit"
        );
        let long = brief(&json!("x".repeat(200)));
        assert_eq!(long.chars().count(), 60);
        assert!(long.ends_with('…'));
    }
}
