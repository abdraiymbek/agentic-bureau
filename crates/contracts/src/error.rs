use crate::issue::ValidationIssue;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The one error shape every caller sees. `message` says what is wrong;
/// `repair` says what to do about it; `details` carries the machine-readable
/// part (`issues`, `example`, ids).
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

    /// One sentence telling the caller how to recover.
    pub fn with_repair(mut self, repair: impl Into<String>) -> Self {
        self.repair = Some(repair.into());
        self
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(Box::new(details));
        self
    }

    /// A record the caller named by id does not exist. `kind` is the lowercase
    /// noun (`artifact`, `proposal`); `listing_tool` is the underscore tool
    /// that returns valid ids.
    pub fn not_found(kind: &str, id: &str, listing_tool: &str) -> Self {
        let mut noun = kind.to_owned();
        if let Some(first) = noun.get_mut(..1) {
            first.make_ascii_uppercase();
        }
        Self::new("NOT_FOUND", format!("{noun} not found: {id}"))
            .with_repair(format!(
                "Call {listing_tool} to see valid {kind} ids, then retry with one of them."
            ))
            .with_details(json!({ "kind": kind, "id": id, "listingTool": listing_tool }))
    }

    /// The caller worked from a revision that is no longer current. `message`
    /// states which check failed; the current revision id travels with it.
    pub fn revision_conflict(message: impl Into<String>, current_revision_id: &str) -> Self {
        Self::new("REVISION_CONFLICT", message)
            .with_repair(format!(
                "Read the artifact again and retry against revision {current_revision_id}."
            ))
            .with_details(json!({ "currentRevisionId": current_revision_id }))
    }

    /// An agent asked for a human-only operation. `alternative` is what the
    /// agent should do instead, naming tools by their underscore names.
    pub fn capability_denied(op: &str, alternative: impl Into<String>) -> Self {
        Self::new(
            "CAPABILITY_DENIED",
            format!("Agents cannot call {op}; only the human can do this"),
        )
        .with_repair(alternative)
        .with_details(json!({ "op": op }))
    }

    /// An external program (`OpenSCAD`, an agent CLI) is not available.
    pub fn tool_missing(tool: &str) -> Self {
        Self::new("TOOL_MISSING", format!("{tool} not found"))
            .with_repair(format!(
                "Install {tool} or set its executable path in Settings, then retry. An agent cannot change Settings; ask the human."
            ))
            .with_details(json!({ "tool": tool }))
    }

    /// The validation issues carried in `details.issues`, empty for any other
    /// error.
    pub fn issues(&self) -> Vec<ValidationIssue> {
        self.details
            .as_deref()
            .and_then(|details| details.get("issues"))
            .and_then(|issues| serde_json::from_value(issues.clone()).ok())
            .unwrap_or_default()
    }
}
