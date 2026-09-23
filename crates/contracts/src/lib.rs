//! Stable external contracts for the Rust implementation of Omen Flow.
//! `registry.json` is a frozen export of the TypeScript v0.1 operation registry.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractRegistry {
    pub protocol_version: u64,
    pub schema_version: u64,
    pub project_file: String,
    pub max_frame_bytes: usize,
    pub env_keys: HashMap<String, String>,
    pub error_codes: Vec<String>,
    pub event_types: Vec<String>,
    pub artifact_payload_schemas: HashMap<String, Value>,
    pub operations: Vec<Operation>,
    #[serde(skip)]
    by_name: HashMap<String, usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub name: String,
    pub tool_name: String,
    pub description: String,
    pub capability: String,
    pub mutating: bool,
    pub agent_visible: bool,
    pub agent_allowed: bool,
    pub agent_tool: bool,
    pub input_schema: Value,
}

static REGISTRY: OnceLock<ContractRegistry> = OnceLock::new();

pub fn registry() -> &'static ContractRegistry {
    REGISTRY.get_or_init(|| {
        let mut registry: ContractRegistry =
            serde_json::from_str(include_str!("../registry.json")).expect("valid registry.json");
        registry.by_name = registry
            .operations
            .iter()
            .enumerate()
            .map(|(index, op)| (op.name.clone(), index))
            .collect();
        assert_eq!(
            registry.operations.len(),
            100,
            "v0.1 operation count changed"
        );
        registry
    })
}

impl ContractRegistry {
    pub fn operation(&self, name: &str) -> Option<&Operation> {
        self.by_name.get(name).map(|index| &self.operations[*index])
    }

    pub fn agent_operations(&self) -> impl Iterator<Item = &Operation> {
        self.operations.iter().filter(|op| op.agent_allowed)
    }

    pub fn agent_tools(&self) -> impl Iterator<Item = &Operation> {
        self.operations.iter().filter(|op| op.agent_tool)
    }
}

/// Match Zod object parsing: unknown object keys are discarded and declared
/// defaults are applied before the handler sees the value. More complex Zod
/// transforms, if introduced, need explicit parity fixtures before release.
pub fn parse_input(op: &Operation, input: Value) -> Result<Value, ContractError> {
    // CoreApp and project dispatch both pass `payload ?? {}` to Zod.
    let mut value = if input.is_null() {
        empty_object()
    } else {
        input
    };
    normalize(&op.input_schema, &mut value);
    let validator = jsonschema::draft7::new(&op.input_schema)
        .map_err(|error| ContractError::validation(error.to_string()))?;
    if let Err(error) = validator.validate(&value) {
        return Err(ContractError::validation(format!("Invalid input: {error}")));
    }
    Ok(value)
}

pub fn parse_artifact_payload(type_name: &str, input: Value) -> Result<Value, ContractError> {
    let schema = registry()
        .artifact_payload_schemas
        .get(type_name)
        .ok_or_else(|| ContractError::validation(format!("Unknown artifact type: {type_name}")))?;
    let mut value = input;
    normalize(schema, &mut value);
    let validator = jsonschema::draft7::new(schema)
        .map_err(|error| ContractError::validation(error.to_string()))?;
    if let Err(error) = validator.validate(&value) {
        return Err(ContractError::validation(format!(
            "Invalid {type_name} payload: {error}"
        )));
    }
    Ok(value)
}

fn normalize(schema: &Value, value: &mut Value) {
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        if let Some(object) = value.as_object_mut() {
            let additional = schema.get("additionalProperties");
            if additional == Some(&Value::Bool(false)) {
                object.retain(|key, _| properties.contains_key(key));
            }
            for (key, property_schema) in properties {
                if !object.contains_key(key) {
                    if let Some(default) = property_schema.get("default") {
                        object.insert(key.clone(), default.clone());
                    }
                }
                if let Some(member) = object.get_mut(key) {
                    normalize(property_schema, member);
                }
            }
            if let Some(additional_schema) = additional.filter(|s| s.is_object()) {
                for (key, member) in object.iter_mut() {
                    if !properties.contains_key(key) {
                        normalize(additional_schema, member);
                    }
                }
            }
            // Zod's object parser emits declared fields in schema order.
            // Keep that order for JSON.stringify request hashes shared with
            // the existing TypeScript idempotency store.
            let mut ordered = Map::new();
            for key in properties.keys() {
                if let Some(member) = object.remove(key) {
                    ordered.insert(key.clone(), member);
                }
            }
            for (key, member) in std::mem::take(object) {
                ordered.insert(key, member);
            }
            *object = ordered;
        }
    }
    if let (Some(item_schema), Some(items)) = (schema.get("items"), value.as_array_mut()) {
        for item in items {
            normalize(item_schema, item);
        }
    }
    if let Some(branches) = schema.get("anyOf").and_then(Value::as_array) {
        for branch in branches {
            let mut candidate = value.clone();
            normalize(branch, &mut candidate);
            if jsonschema::draft7::is_valid(branch, &candidate) {
                *value = candidate;
                break;
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub op: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ContractError>,
}

impl ResponseEnvelope {
    pub fn success(request_id: impl Into<String>, result: Value) -> Self {
        Self {
            request_id: request_id.into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(request_id: impl Into<String>, error: ContractError) -> Self {
        Self {
            request_id: request_id.into(),
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repair: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Box<Value>>,
}

impl std::fmt::Display for ContractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ContractError {}

impl ContractError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            repair: None,
            details: None,
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new("VALIDATION", message)
    }
}

pub fn write_frame(writer: &mut impl Write, message: &impl Serialize) -> io::Result<()> {
    let body = serde_json::to_vec(message).map_err(io::Error::other)?;
    let maximum = registry().max_frame_bytes;
    if body.len() > maximum {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Bridge frame exceeds {maximum} bytes"),
        ));
    }
    writer.write_all(&(body.len() as u32).to_le_bytes())?;
    writer.write_all(&body)
}

pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Value>> {
    let mut header = [0_u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(header) as usize;
    if length > registry().max_frame_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Bridge frame exceeds maximum length",
        ));
    }
    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(io::Error::other)
}

pub fn empty_object() -> Value {
    Value::Object(Map::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_retains_protocol_and_capability_split() {
        let contracts = registry();
        assert_eq!(contracts.protocol_version, 1);
        assert_eq!(contracts.schema_version, 1);
        assert_eq!(contracts.max_frame_bytes, 8 * 1024 * 1024);
        assert!(
            !contracts
                .operation("proposal.approve")
                .unwrap()
                .agent_allowed
        );
        assert!(contracts.operation("cad.write_source").unwrap().agent_tool);
        assert!(!contracts.operation("cad.render").unwrap().agent_tool);
        assert!(!contracts.operation("browser.open").unwrap().agent_allowed);
    }

    #[test]
    fn input_defaults_and_unknown_keys_match_zod_object_behavior() {
        let op = registry().operation("artifact.list").unwrap();
        let input = parse_input(op, json!({ "garbage": 3 })).unwrap();
        assert_eq!(
            input,
            json!({ "includeArchived": false, "limit": 200, "offset": 0 })
        );
    }

    #[test]
    fn framing_is_little_endian_json() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &json!({ "type": "hello" })).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize,
            bytes.len() - 4
        );
        assert_eq!(
            read_frame(&mut bytes.as_slice()).unwrap(),
            Some(json!({ "type": "hello" }))
        );
    }
}
