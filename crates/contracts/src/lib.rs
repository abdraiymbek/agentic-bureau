//! Stable external contracts for the Rust implementation of Bureau.
//! `registry.json` is the export of the TypeScript operation registry
//! (`scripts/export-rust-contracts.ts`).

mod error;
mod input;
mod issue;
mod nearest;
mod registry;
mod schema;

pub use error::ContractError;
pub use input::{
    parse_agent_artifact_payload, parse_agent_input, parse_artifact_payload, parse_input,
    AgentInput,
};
pub use issue::{IssueKind, ValidationIssue};
pub use nearest::nearest_match;
pub use registry::{registry, ContractRegistry, Operation, Profile, Tier};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::io::{self, Read, Write};

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
mod tests;
