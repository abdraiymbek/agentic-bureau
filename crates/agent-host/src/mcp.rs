use super::{current_grant, dispatch_agent, Shared};
use interprocess::local_socket::Stream;
use omenflow_contracts::{read_frame, registry, write_frame};
use serde_json::{json, Value};

pub(super) fn serve(stream: &mut Stream, shared: &Shared, token: &str) {
    while let Ok(Some(message)) = read_frame(stream) {
        let Some(id) = message.get("id").cloned() else {
            continue; // JSON-RPC notification
        };
        let result = handle_message(shared, token, &message);
        let response = match result {
            Ok(value) => json!({"jsonrpc":"2.0", "id":id, "result":value}),
            Err((code, text)) => {
                json!({"jsonrpc":"2.0", "id":id, "error":{"code":code, "message":text}})
            }
        };
        if write_frame(stream, &response).is_err() {
            return;
        }
    }
}

fn handle_message(shared: &Shared, token: &str, message: &Value) -> Result<Value, (i64, String)> {
    if current_grant(shared, token).is_none() {
        return Err((-32000, "Agent session grant was revoked".into()));
    }
    let params = &message["params"];
    match message["method"].as_str().unwrap_or("") {
        "initialize" => Ok(json!({
            "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2024-11-05"),
            "capabilities": {"tools": {"listChanged": false}, "resources": {"listChanged": false}},
            "serverInfo": {"name":"omenflow", "version": env!("CARGO_PKG_VERSION")}
        })),
        "ping" => Ok(json!({})),
        "tools/list" => {
            let tools = registry().agent_tools().map(|op| json!({
                "name": op.tool_name,
                "description": format!("{}{}", op.description, if op.mutating { " (mutating)" } else { "" }),
                "inputSchema": op.input_schema,
                "annotations": {"readOnlyHint": !op.mutating, "destructiveHint": false, "idempotentHint": !op.mutating, "openWorldHint": false}
            })).collect::<Vec<_>>();
            Ok(json!({"tools": tools}))
        }
        "tools/call" => {
            let name = params["name"]
                .as_str()
                .ok_or((-32602, "Missing tool name".into()))?;
            let op = registry()
                .agent_tools()
                .find(|op| op.tool_name == name)
                .ok_or((-32602, format!("Unknown tool: {name}")))?;
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            let idempotency_key = arguments["idempotencyKey"].as_str().map(str::to_owned);
            let (body, is_error) = match dispatch_agent(
                shared,
                token,
                &op.name,
                arguments,
                idempotency_key.as_deref(),
            ) {
                Ok(value) => (value, false),
                Err(error) => (
                    serde_json::to_value(error).unwrap_or(json!({"code":"INTERNAL"})),
                    true,
                ),
            };
            let text = serde_json::to_string_pretty(&body).unwrap_or_else(|_| "null".into());
            Ok(json!({"content":[{"type":"text", "text":text}], "isError":is_error}))
        }
        "resources/list" => Ok(
            json!({"resources":[{"name":"project_summary", "uri":"omenflow://project/summary", "description":"Bounded structured project summary", "mimeType":"application/json"}]}),
        ),
        "resources/read" => {
            let uri = params["uri"]
                .as_str()
                .ok_or((-32602, "Missing URI".into()))?;
            if uri != "omenflow://project/summary" {
                return Err((-32602, format!("Unknown resource: {uri}")));
            }
            let body = dispatch_agent(shared, token, "project.summary", json!({}), None)
                .map_err(|error| (-32000, error.message))?;
            Ok(
                json!({"contents":[{"uri":uri,"mimeType":"application/json","text":serde_json::to_string_pretty(&body).unwrap_or_default()}]}),
            )
        }
        "resources/templates/list" => Ok(json!({"resourceTemplates":[]})),
        method => Err((-32601, format!("Method not found: {method}"))),
    }
}
