//! Parsing a caller's input into the canonical value a handler sees.

use crate::empty_object;
use crate::error::ContractError;
use crate::issue::{self, IssueKind, ValidationIssue};
use crate::registry::{registry, Operation};
use crate::schema::{Compiled, Mode, Pass};
use serde_json::{json, Value};

/// Issues named in the message; the rest are counted there and listed in
/// `details.issues`.
const SUMMARISED: usize = 3;
/// Issues carried in `details.issues` before the remainder is only counted.
const REPORTED: usize = 50;

/// Canonical input for an agent call, and what was repaired to get there.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentInput {
    pub value: Value,
    /// One line per repair, in the order applied: `renamed revisionID →
    /// revisionId`, `read limit "5" as integer 5`.
    pub notes: Vec<String>,
}

/// Match Zod object parsing: unknown object keys are discarded and declared
/// defaults are applied before the handler sees the value. More complex Zod
/// transforms, if introduced, need explicit parity fixtures before release.
pub fn parse_input(op: &Operation, input: Value) -> Result<Value, ContractError> {
    let input = or_empty_object(input);
    let (value, _, issues) = parse(op.compiled()?, &op.input_schema, input, Mode::Ui);
    if issues.is_empty() {
        return Ok(value);
    }
    Err(invalid("input", issues, json!({ "op": op.name }), None))
}

/// Input from an agent. Besides what `parse_input` does, this applies the
/// lossless repairs models commonly need and reports each one in `notes`:
/// a numeric string where a number is required, `"true"`/`"false"` where a
/// boolean is, a key that differs from a declared one only by case or
/// snake/camel form, and a quantity string (`"300 g"`) where the schema is a
/// quantity object. Unknown keys are rejected with the allowed keys rather
/// than dropped. Enum values, ids and units are never rewritten.
pub fn parse_agent_input(op: &Operation, payload: Value) -> Result<AgentInput, ContractError> {
    let payload = or_empty_object(payload);
    let (value, notes, issues) = parse(op.compiled()?, &op.input_schema, payload, Mode::Agent);
    if issues.is_empty() {
        return Ok(AgentInput { value, notes });
    }
    let mut details = json!({ "op": op.name, "tool": op.tool_name });
    let mut hint = format!("Then call {} again.", op.tool_name);
    match &op.example {
        Some(example) => {
            details["example"] = example.clone();
            hint.push_str(" details.example is a minimal valid input.");
        }
        None => hint.push_str(&format!(
            " Call tool_describe for {} to see its schema.",
            op.tool_name
        )),
    }
    if !notes.is_empty() {
        details["notes"] = json!(notes);
    }
    Err(invalid("input", issues, details, Some(&hint)))
}

pub fn parse_artifact_payload(type_name: &str, input: Value) -> Result<Value, ContractError> {
    let (schema, compiled) = registry().payload(type_name)?;
    if let (Some(fields), Some(properties)) = (input.as_object(), schema["properties"].as_object())
    {
        if !fields.is_empty() && !fields.keys().any(|key| properties.contains_key(key)) {
            return Err(ContractError::validation(format!(
                "No recognized {type_name} fields. Use tool.describe with artifactType=\"{type_name}\" for the payload schema. Expected: {}",
                properties.keys().cloned().collect::<Vec<_>>().join(", ")
            )));
        }
    }
    let (value, _, issues) = parse(compiled, schema, input, Mode::Ui);
    if issues.is_empty() {
        return Ok(value);
    }
    Err(invalid(
        &format!("{type_name} payload"),
        issues,
        json!({ "artifactType": type_name }),
        None,
    ))
}

/// `parse_artifact_payload` for content an agent authored: the same repairs
/// as `parse_agent_input`, and a key the payload schema does not declare is an
/// error instead of prose that silently disappears.
pub fn parse_agent_artifact_payload(
    type_name: &str,
    payload: Value,
) -> Result<AgentInput, ContractError> {
    let (schema, compiled) = registry().payload(type_name)?;
    let (value, notes, issues) = parse(compiled, schema, payload, Mode::Agent);
    if issues.is_empty() {
        return Ok(AgentInput { value, notes });
    }
    let mut details = json!({ "artifactType": type_name });
    if !notes.is_empty() {
        details["notes"] = json!(notes);
    }
    let hint =
        format!("Call tool_describe with artifactType \"{type_name}\" to see the payload schema.");
    Err(invalid(
        &format!("{type_name} payload"),
        issues,
        details,
        Some(&hint),
    ))
}

/// CoreApp and project dispatch both pass `payload ?? {}` to Zod.
fn or_empty_object(input: Value) -> Value {
    if input.is_null() {
        empty_object()
    } else {
        input
    }
}

fn parse(
    compiled: &Compiled,
    schema: &Value,
    mut value: Value,
    mode: Mode,
) -> (Value, Vec<String>, Vec<ValidationIssue>) {
    let mut pass = Pass::new(compiled, mode);
    pass.run(schema, &mut value);
    let Pass {
        notes,
        issues: mut found,
        ..
    } = pass;
    found.extend(compiled.issues(schema, &value));
    let issues = issue::ordered(&value, found);
    (value, notes, issues)
}

/// `VALIDATION` naming the first few paths, with a repair sentence and every
/// issue in `details.issues`.
fn invalid(
    subject: &str,
    mut issues: Vec<ValidationIssue>,
    mut details: Value,
    hint: Option<&str>,
) -> ContractError {
    let mut message = issues
        .iter()
        .take(SUMMARISED)
        .map(|issue| match issue.path.as_str() {
            "" => issue.message.clone(),
            path => format!("{path}: {}", issue.message),
        })
        .collect::<Vec<_>>()
        .join("; ");
    if issues.len() > SUMMARISED {
        message.push_str(&format!(" (+{} more)", issues.len() - SUMMARISED));
    }
    let mut repair = repair(&issues);
    if let Some(hint) = hint {
        repair.push(' ');
        repair.push_str(hint);
    }
    if issues.len() > REPORTED {
        details["omittedIssues"] = json!(issues.len() - REPORTED);
        issues.truncate(REPORTED);
    }
    details["issues"] = json!(issues);
    ContractError::validation(format!("Invalid {subject}: {message}"))
        .with_repair(repair)
        .with_details(details)
}

/// One instruction per kind of problem present, in a fixed order.
fn repair(issues: &[ValidationIssue]) -> String {
    let has = |kind: IssueKind| issues.iter().any(|issue| issue.kind == kind);
    let expects = |kind: IssueKind, fragment: &str| {
        issues.iter().any(|issue| {
            issue.kind == kind
                && issue
                    .expected
                    .as_deref()
                    .is_some_and(|expected| expected.contains(fragment))
        })
    };
    let mut steps = Vec::new();
    if has(IssueKind::UnknownKey) {
        steps.push("Remove each unknown key or rename it to an allowed key.");
    }
    if has(IssueKind::Required) {
        steps.push("Add each missing required field.");
    }
    if has(IssueKind::Enum) {
        steps.push("Use an allowed value exactly as listed.");
    }
    if expects(IssueKind::Format, "(uuid)") {
        steps.push("Copy each id exactly from an earlier result; a title is not an id.");
    }
    if expects(IssueKind::Type, "{ value: number, unit: string") {
        steps.push(if expects(IssueKind::Type, "{ unknown: true") {
            "Write a quantity as {\"value\": 300, \"unit\": \"g\"}, or {\"unknown\": true, \"reason\": \"…\"} when it is not known."
        } else {
            "Write a quantity as {\"value\": 300, \"unit\": \"g\"}."
        });
    } else if has(IssueKind::Type) {
        steps.push("Send each value with the expected JSON type.");
    }
    let bounded = issues.iter().any(|issue| match issue.kind {
        IssueKind::Pattern
        | IssueKind::Size
        | IssueKind::Range
        | IssueKind::Const
        | IssueKind::Other => true,
        IssueKind::Format => !issue
            .expected
            .as_deref()
            .is_some_and(|expected| expected.contains("(uuid)")),
        _ => false,
    });
    if bounded {
        steps.push("Keep each value within the stated format and limits.");
    }
    steps.join(" ")
}
