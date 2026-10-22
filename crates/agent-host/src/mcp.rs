//! The MCP server an agent CLI talks to through `omenflow mcp`: one JSON-RPC
//! message per bridge frame. What it lists and how it words results follows
//! the session's capability profile; what it runs goes through
//! `dispatch_agent` like every other agent call.

use super::images::{structured_content_hides_images, Image};
use super::{current_grant, dispatch_agent, guide, present, AgentCall, Shared, Via};
use base64::Engine;
use interprocess::local_socket::Stream;
use omenflow_contracts::{read_frame, write_frame};
use serde_json::{json, Value};

/// Protocol revisions this server implements, newest first. A client that
/// asks for one of them gets it; any other request is answered with the
/// newest, and the client decides whether it can continue.
const SUPPORTED_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const SERVER_ERROR: i64 = -32000;

pub(super) fn serve(stream: &mut Stream, shared: &Shared, token: &str) {
    while let Ok(Some(message)) = read_frame(stream) {
        let Some(response) = respond(shared, token, &message) else {
            continue;
        };
        if write_frame(stream, &response).is_ok() {
            continue;
        }
        // A reply too large for one frame must not end the session: the
        // agent would lose every tool. Say so instead.
        let oversized = reply(
            &message["id"],
            Err((
                SERVER_ERROR,
                "The result is too large to send. Ask for less at once.".to_owned(),
            )),
        );
        if write_frame(stream, &oversized).is_err() {
            return;
        }
    }
}

/// The reply to one incoming message, or `None` when it needs none:
/// notifications are accepted silently, and a response to a request this
/// server never sent is ignored.
fn respond(shared: &Shared, token: &str, message: &Value) -> Option<Value> {
    let id = message.get("id").filter(|id| !id.is_null());
    let method = message.get("method").and_then(Value::as_str);
    match (id, method) {
        (Some(id), Some(method)) => {
            Some(reply(id, handle(shared, token, method, &message["params"])))
        }
        (Some(id), None) if message.get("result").is_none() && message.get("error").is_none() => {
            Some(reply(
                id,
                Err((INVALID_REQUEST, "A request needs a method".to_owned())),
            ))
        }
        _ => None,
    }
}

fn reply(id: &Value, outcome: Result<Value, (i64, String)>) -> Value {
    match outcome {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => {
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
        }
    }
}

fn handle(
    shared: &Shared,
    token: &str,
    method: &str,
    params: &Value,
) -> Result<Value, (i64, String)> {
    let Some(grant) = current_grant(shared, token) else {
        return Err((SERVER_ERROR, "Agent session grant was revoked".into()));
    };
    match method {
        "initialize" => {
            let requested = params["protocolVersion"].as_str().unwrap_or_default();
            let version = SUPPORTED_VERSIONS
                .into_iter()
                .find(|version| *version == requested)
                .unwrap_or(SUPPORTED_VERSIONS[0]);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": false}, "resources": {"listChanged": false}},
                "serverInfo": {"name": "omenflow", "title": "Omen Flow", "version": env!("CARGO_PKG_VERSION")},
                "instructions": guide::instructions(grant.profile),
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": present::tool_listing(grant.profile)})),
        "tools/call" => {
            let name = params["name"]
                .as_str()
                .filter(|name| !name.trim().is_empty())
                .ok_or((INVALID_PARAMS, "Missing tool name".to_owned()))?;
            let call = AgentCall {
                name,
                payload: params.get("arguments").cloned().unwrap_or(json!({})),
                idempotency_key: None,
                via: Via::Mcp,
            };
            // Everything past this point is a tool result, never a protocol
            // error: a model can read and act on a result.
            let reply = dispatch_agent(shared, token, call)
                .map_err(|error| (SERVER_ERROR, error.message))?;
            let structured =
                reply.images.is_empty() || !structured_content_hides_images(&grant.adapter_id);
            Ok(match reply.result {
                Ok(value) => tool_result(value, false, &reply.images, structured),
                Err(error) => {
                    tool_result(present::error_body(&error, reply.profile), true, &[], true)
                }
            })
        }
        "resources/list" => Ok(
            json!({"resources":[{"name":"project_summary", "uri":SUMMARY_URI, "description":"Bounded structured project summary", "mimeType":"application/json"}]}),
        ),
        "resources/read" => {
            let uri = params["uri"]
                .as_str()
                .ok_or((INVALID_PARAMS, "Missing URI".to_owned()))?;
            if uri != SUMMARY_URI {
                return Err((INVALID_PARAMS, format!("Unknown resource: {uri}")));
            }
            let call = AgentCall {
                name: "project_summary",
                payload: json!({}),
                idempotency_key: None,
                via: Via::Mcp,
            };
            let body = dispatch_agent(shared, token, call)
                .and_then(|reply| reply.result)
                .map_err(|error| (SERVER_ERROR, error.message))?;
            Ok(
                json!({"contents":[{"uri":uri,"mimeType":"application/json","text":compact(&body)}]}),
            )
        }
        "resources/templates/list" => Ok(json!({"resourceTemplates":[]})),
        method => Err((METHOD_NOT_FOUND, format!("Method not found: {method}"))),
    }
}

const SUMMARY_URI: &str = "omenflow://project/summary";

/// A tool result: the body as compact JSON text for the model, any pictures
/// as image blocks after it, and the same body as structured content for
/// clients that prefer it, unless `structured` is false. Structured content
/// never holds picture bytes.
fn tool_result(body: Value, is_error: bool, images: &[Image], structured: bool) -> Value {
    // Structured content must be an object.
    let body = if body.is_object() {
        body
    } else {
        json!({"result": body})
    };
    let mut content = vec![json!({"type": "text", "text": compact(&body)})];
    content.extend(images.iter().map(|image| {
        json!({
            "type": "image",
            "data": base64::engine::general_purpose::STANDARD.encode(&image.bytes),
            "mimeType": image.mime_type,
        })
    }));
    let mut result = json!({"content": content, "isError": is_error});
    if structured {
        result["structuredContent"] = body;
    }
    result
}

fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use omenflow_contracts::registry;

    #[test]
    fn results_are_compact_text_and_structured_content() {
        let result = tool_result(
            json!({"ready": true, "summary": "Nothing outstanding."}),
            false,
            &[],
            true,
        );
        assert_eq!(
            result,
            json!({
                "content": [{"type": "text", "text": "{\"ready\":true,\"summary\":\"Nothing outstanding.\"}"}],
                "structuredContent": {"ready": true, "summary": "Nothing outstanding."},
                "isError": false
            })
        );
        let wrapped = tool_result(json!([1, 2]), true, &[], true);
        assert_eq!(wrapped["structuredContent"], json!({"result": [1, 2]}));
        assert_eq!(wrapped["content"][0]["text"], "{\"result\":[1,2]}");
        assert_eq!(wrapped["isError"], true);
    }

    #[test]
    fn images_follow_the_text_block_and_stay_out_of_structured_content() {
        let body =
            json!({"images": [{"path": ".omenflow/cache/views-v1/x.png", "attached": true}]});
        let picture = Image {
            mime_type: "image/png",
            bytes: b"\x89PNG picture".to_vec(),
        };
        let result = tool_result(body.clone(), false, std::slice::from_ref(&picture), true);
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["text"], compact(&body));
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["mimeType"], "image/png");
        let data = content[1]["data"].as_str().unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .unwrap(),
            picture.bytes
        );
        assert_eq!(result["structuredContent"], body);
        // For Codex the structured content is left out, so the image is seen.
        let codex = tool_result(body.clone(), false, std::slice::from_ref(&picture), false);
        assert!(codex.get("structuredContent").is_none());
        assert_eq!(codex["content"][0]["text"], compact(&body));
        assert_eq!(codex["content"][1], content[1]);
    }

    #[test]
    fn the_summary_resource_reads_a_tool_agents_may_call() {
        assert!(registry()
            .resolve("project_summary")
            .is_some_and(|op| op.agent_allowed));
    }
}
