//! A deterministic corpus of the mistakes weak models make, sent to the real
//! bridge over MCP JSON-RPC. Each case asserts two things: the reply gives
//! the model what it needs to recover (the path, what was expected, an
//! example, a did-you-mean), and the ledger recorded the call.

use crate::present::chars;
use crate::test_support::{McpClient, Workspace};
use bureau_contracts::{registry, Profile};
use serde_json::{json, Value};

const MISSING: &str = "00000000-0000-4000-8000-00000000dead";

fn note(workspace: &Workspace, title: &str, words: usize) -> Value {
    workspace.user(
        "artifact.create_draft",
        json!({"type": "note", "title": title, "payload": {"markdown": "lorem ".repeat(words)}}),
    )
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

#[test]
fn a_misspelled_tool_name_gets_a_suggestion_not_a_protocol_error() {
    let workspace = Workspace::new("Wrong name");
    let mut client = workspace.mcp(Profile::Compact);
    let reply = client.call("cad_chek", json!({"artifactId": MISSING}));
    assert!(reply.is_error);
    assert_eq!(reply.body["code"], "NOT_FOUND");
    assert_eq!(reply.body["message"], "Unknown operation: cad_chek");
    assert_eq!(reply.body["didYouMean"], "cad_check");
    assert_eq!(
        reply.body["repair"],
        "Did you mean cad_check? Call tool_describe with no arguments to list every tool."
    );
    let recorded = workspace.last_recorded();
    assert_eq!(recorded["tool"], "cad_chek");
    assert_eq!(recorded["ok"], false);
    assert_eq!(recorded["code"], "NOT_FOUND");
    assert_eq!(recorded["via"], "mcp");
    assert_eq!(recorded["sessionId"], json!(client.session_id));

    // A name with nothing near it still points at the catalogue.
    let far = client.call("launch_rocket", json!({}));
    assert!(far.is_error);
    assert!(far.body.get("didYouMean").is_none());
    assert!(far.body["repair"]
        .as_str()
        .unwrap()
        .contains("tool_describe"));

    // A tool reserved for the human says what to do instead.
    let denied = client.call("proposal_approve", json!({"proposalId": MISSING}));
    assert!(denied.is_error);
    assert_eq!(denied.body["code"], "CAPABILITY_DENIED");
    assert_eq!(
        denied.body["message"],
        "Agents cannot call proposal_approve; only the human can do this"
    );
    assert!(denied.body["repair"]
        .as_str()
        .unwrap()
        .contains("proposal_submit"));
    assert_eq!(workspace.last_recorded()["code"], "CAPABILITY_DENIED");
    assert_eq!(workspace.recorded().len(), 3);
}

#[test]
fn dotted_prefixed_and_miscased_names_are_accepted_and_reported() {
    let workspace = Workspace::new("Name forms");
    note(&workspace, "Plate", 3);
    let mut client = workspace.mcp(Profile::Compact);
    for (name, expected_note) in [
        (
            "artifact.list",
            Some("read tool name \"artifact.list\" as artifact_list"),
        ),
        (
            "mcp__bureau__artifact_list",
            Some("read tool name \"mcp__bureau__artifact_list\" as artifact_list"),
        ),
        (
            "Artifact_List",
            Some("read tool name \"Artifact_List\" as artifact_list"),
        ),
        ("artifact_list", None),
    ] {
        let reply = client.call(name, json!({}));
        assert!(!reply.is_error, "{name}: {}", reply.text);
        assert_eq!(reply.body["artifacts"].as_array().unwrap().len(), 1);
        match expected_note {
            Some(expected) => assert_eq!(strings(&reply.body["notes"]), [expected]),
            None => assert!(reply.body.get("notes").is_none()),
        }
        let recorded = workspace.last_recorded();
        assert_eq!(
            recorded["tool"], name,
            "the ledger keeps the name as called"
        );
        assert_eq!(recorded["op"], "artifact.list");
        assert_eq!(recorded["ok"], true);
        assert_eq!(
            strings(&recorded["notes"]),
            expected_note.into_iter().collect::<Vec<_>>()
        );
    }
}

#[test]
fn a_key_in_the_wrong_case_is_repaired_and_an_unknown_key_is_refused() {
    let workspace = Workspace::new("Keys");
    let created = note(&workspace, "Plate", 3);
    let artifact_id = created["artifact"]["id"].as_str().unwrap();
    let revision_id = created["revision"]["id"].as_str().unwrap();
    let mut client = workspace.mcp(Profile::Compact);

    let repaired = client.call(
        "artifact_read",
        json!({"artifact_id": artifact_id, "revisionID": revision_id}),
    );
    assert!(!repaired.is_error, "{}", repaired.text);
    assert_eq!(repaired.body["view"]["artifact"]["id"], artifact_id);
    assert_eq!(
        strings(&repaired.body["notes"]),
        [
            "renamed artifact_id → artifactId",
            "renamed revisionID → revisionId"
        ]
    );
    let recorded = workspace.last_recorded();
    assert_eq!(strings(&recorded["notes"]).len(), 2);
    assert_eq!(strings(&recorded["artifactIds"]), [artifact_id]);

    // A misspelled key is never dropped: dropping `revisonId` would read a
    // different revision than the one asked for.
    let refused = client.call(
        "artifact_read",
        json!({"artifactId": artifact_id, "revisonId": revision_id}),
    );
    assert!(refused.is_error);
    assert_eq!(refused.body["code"], "VALIDATION");
    assert_eq!(
        refused.body["message"],
        "Invalid input for artifact_read: 1 problem, listed in issues."
    );
    assert_eq!(
        refused.body["issues"],
        json!([{"path": "revisonId", "message": "unknown key, allowed keys are artifactId, revisionId, detail (nearest: revisionId)", "nearest": "revisionId"}])
    );
    assert_eq!(
        refused.body["example"],
        *registry()
            .operation("artifact.read")
            .unwrap()
            .example
            .as_ref()
            .unwrap()
    );
    let repair = refused.body["repair"].as_str().unwrap();
    assert!(repair.starts_with("Remove each unknown key or rename it to an allowed key."));
    assert!(repair.contains("Then call artifact_read again."));
    let recorded = workspace.last_recorded();
    assert_eq!(
        (&recorded["ok"], &recorded["code"]),
        (&json!(false), &json!("VALIDATION"))
    );
    assert_eq!(recorded["op"], "artifact.read");
    assert_eq!(recorded["mutating"], false);
}

#[test]
fn numbers_and_booleans_sent_as_strings_are_read_and_reported() {
    let workspace = Workspace::new("Strings");
    for index in 0..4 {
        note(&workspace, &format!("Note {index}"), 3);
    }
    let mut client = workspace.mcp(Profile::Compact);
    let reply = client.call(
        "artifact_list",
        json!({"limit": "2", "offset": "1", "includeArchived": "false"}),
    );
    assert!(!reply.is_error, "{}", reply.text);
    let titles = reply.body["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|view| view["artifact"]["title"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(titles, ["Note 1", "Note 2"]);
    assert_eq!(
        strings(&reply.body["notes"]),
        [
            "read includeArchived \"false\" as boolean false",
            "read limit \"2\" as integer 2",
            "read offset \"1\" as integer 1"
        ]
    );
    assert_eq!(strings(&workspace.last_recorded()["notes"]).len(), 3);

    // What cannot be read losslessly is refused with the path and the type.
    let refused = client.call("artifact_list", json!({"limit": "two"}));
    assert!(refused.is_error);
    assert_eq!(refused.body["issues"][0]["path"], "limit");
    assert_eq!(
        refused.body["issues"][0]["message"],
        "expected integer, received string \"two\""
    );
    assert_eq!(refused.body["example"], json!({"type": "requirement"}));
}

#[test]
fn a_quantity_written_as_text_is_read_and_a_vague_one_is_refused() {
    let workspace = Workspace::new("Quantities");
    let mut client = workspace.mcp(Profile::Standard);
    let run = client.call(
        "calculation_run",
        json!({
            "title": "Rover mass budget",
            "expression": "chassis + battery",
            "inputs": [
                {"name": "chassis", "quantity": "1.2 kg", "literal": "true"},
                {"name": "battery", "quantity": {"value": 0.4, "unit": "kg"}, "literal": true}
            ],
            "submitForReview": "false"
        }),
    );
    assert!(!run.is_error, "{}", run.text);
    let notes = strings(&run.body["notes"]);
    assert!(
        notes.contains(
            &"read inputs[0].quantity \"1.2 kg\" as quantity {\"value\":1.2,\"unit\":\"kg\"}"
        ),
        "{notes:?}"
    );
    assert!(
        notes.contains(&"read inputs[0].literal \"true\" as boolean true"),
        "{notes:?}"
    );
    assert!(
        notes.contains(&"read submitForReview \"false\" as boolean false"),
        "{notes:?}"
    );
    // The unit the model wrote is the unit that was computed with.
    assert!(run.text.contains("\"unit\":\"kg\""), "{}", run.text);
    let recorded = workspace.last_recorded();
    assert_eq!(recorded["op"], "calculation.run");
    assert_eq!(recorded["mutating"], true);
    assert_eq!(strings(&recorded["notes"]).len(), 3);
    assert_eq!(strings(&recorded["artifactIds"]).len(), 1, "{recorded}");

    // No unit, no guess.
    let vague = client.call(
        "calculation_run",
        json!({"title": "Mass", "expression": "m", "inputs": [{"name": "m", "quantity": "heavy"}]}),
    );
    assert!(vague.is_error);
    let issue = &vague.body["issues"][0];
    assert_eq!(issue["path"], "inputs[0].quantity");
    assert!(
        issue["expected"]
            .as_str()
            .unwrap()
            .contains("value: number, unit: string"),
        "{issue}"
    );
    assert!(vague.body["repair"]
        .as_str()
        .unwrap()
        .contains("Write a quantity as {\"value\": 300, \"unit\": \"g\"}"));
    assert!(vague.body["example"]["inputs"].is_array());
    assert_eq!(workspace.last_recorded()["code"], "VALIDATION");
}

#[test]
fn missing_required_fields_are_all_named_with_an_example() {
    let workspace = Workspace::new("Missing");
    let mut client = workspace.mcp(Profile::Compact);

    let check = client.call("cad_check", json!({}));
    assert!(check.is_error);
    assert_eq!(check.body["code"], "VALIDATION");
    let paths = check.body["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(paths.contains(&"artifactId"), "{paths:?}");
    assert!(check.body["issues"][0]["message"]
        .as_str()
        .unwrap()
        .starts_with("required"));
    assert_eq!(
        check.body["example"],
        *registry()
            .operation("cad.check")
            .unwrap()
            .example
            .as_ref()
            .unwrap()
    );
    assert!(check.body["repair"]
        .as_str()
        .unwrap()
        .contains("Add each missing required field. Then call cad_check again."));
    assert!(
        chars(&check.body) <= 1_200,
        "compact error is {} chars",
        chars(&check.body)
    );

    let draft = client.call(
        "artifact_create_draft",
        json!({"title": "Payload capacity"}),
    );
    assert!(draft.is_error);
    assert_eq!(
        draft.body["message"],
        "Invalid input for artifact_create_draft: 1 problem, listed in issues."
    );
    assert_eq!(draft.body["issues"][0]["path"], "type");
    assert_eq!(draft.body["example"]["type"], "requirement");

    // A nested path is exact, down to the index.
    let nested = client.call(
        "cad_check",
        json!({"artifactId": MISSING, "expect": {"sections": [{"axis": "z", "at": 1}, {"at": 5}]}}),
    );
    assert!(nested.is_error);
    assert_eq!(nested.body["issues"][0]["path"], "expect.sections[1].axis");
    assert_eq!(
        nested.body["issues"][0]["message"],
        "required, expected one of \"x\", \"y\", \"z\""
    );

    // Arguments sent as one JSON string are named for what they are.
    let stringified = client.call("artifact_read", json!("{\"artifactId\":\"x\"}"));
    assert!(stringified.is_error);
    assert!(
        stringified.body["issues"][0]["message"]
            .as_str()
            .unwrap()
            .contains("send the JSON value itself rather than a string"),
        "{}",
        stringified.text
    );

    let recorded = workspace.recorded();
    assert_eq!(recorded.len(), 4);
    assert!(recorded
        .iter()
        .all(|call| call["ok"] == false && call["code"] == "VALIDATION"));
    assert!(recorded.iter().all(|call| call["message"]
        .as_str()
        .unwrap()
        .starts_with("Invalid input")));
    // The standard profile keeps the full issue.
    let mut standard = workspace.mcp(Profile::Standard);
    let full = standard.call("cad_check", json!({}));
    assert_eq!(full.body["issues"][0]["kind"], "required");
    assert!(full.body["message"]
        .as_str()
        .unwrap()
        .starts_with("Invalid input: artifactId: required"));
}

#[test]
fn a_domain_error_names_the_id_and_how_to_find_a_valid_one() {
    let workspace = Workspace::new("Domain");
    let mut client = workspace.mcp(Profile::Compact);
    let reply = client.call("artifact_read", json!({"artifactId": MISSING}));
    assert!(reply.is_error);
    assert_eq!(reply.body["code"], "NOT_FOUND");
    assert!(reply.body["message"].as_str().unwrap().contains(MISSING));
    let recorded = workspace.last_recorded();
    assert_eq!(recorded["code"], "NOT_FOUND");
    assert_eq!(strings(&recorded["artifactIds"]), [MISSING]);
    assert!(recorded["durationMs"].is_u64());
    assert!(recorded["at"].as_str().unwrap().ends_with('Z'));
}

#[test]
fn an_oversized_result_is_cut_with_a_marker_and_the_rest_can_be_fetched() {
    let workspace = Workspace::new("Oversized");
    const NOTES: usize = 150;
    for index in 0..NOTES {
        note(&workspace, &format!("Note {index:03}"), 3);
    }
    let everything = workspace.user("artifact.list", json!({}));
    let all_ids = everything["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|view| view["artifact"]["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(all_ids.len(), NOTES);
    assert!(
        chars(&everything) > 32_000,
        "the fixture must exceed every cap"
    );

    for profile in Profile::ALL {
        let mut client = workspace.mcp(profile);
        let cap = crate::present::result_cap(profile);
        let first = client.call("artifact_list", json!({"type": "note"}));
        assert!(!first.is_error);
        assert!(
            first.text.chars().count() <= cap,
            "{profile}: {}",
            first.text.chars().count()
        );
        let shown = first.body["artifacts"].as_array().unwrap().len();
        assert!(shown > 0 && shown < NOTES, "{profile}: {shown}");
        let marker = &first.body["truncated"];
        assert_eq!(marker["limit"], cap);
        assert_eq!(
            marker["cut"][0],
            json!({"path": "artifacts", "shown": shown, "total": NOTES, "unit": "items"})
        );
        assert_eq!(marker["more"]["tool"], "artifact_list");
        assert_eq!(
            marker["more"]["args"],
            json!({"type": "note", "offset": shown, "limit": shown})
        );

        // Following the marker returns exactly the artifacts that were cut.
        let second = client.call("artifact_list", marker["more"]["args"].clone());
        assert!(!second.is_error, "{}", second.text);
        let page = second.body["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|view| view["artifact"]["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(!page.is_empty());
        assert_eq!(page[..], all_ids[shown..shown + page.len()]);
        assert_eq!(workspace.last_recorded()["ok"], true);
    }
    // Smaller profiles get shorter pages.
    let pages = Profile::ALL.map(|profile| {
        workspace.mcp(profile).call("artifact_list", json!({})).body["artifacts"]
            .as_array()
            .unwrap()
            .len()
    });
    assert!(pages[0] < pages[1] && pages[1] < pages[2], "{pages:?}");
}

#[test]
fn tool_call_reaches_every_allowed_tool_and_nothing_else() {
    let workspace = Workspace::new("Tool call");
    note(&workspace, "Plate", 3);
    let mut client = workspace.mcp(Profile::Compact);

    // bom_read is not listed for a compact session, and is still callable.
    let listed = client.request("tools/list", json!({}));
    assert!(!listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["name"] == "bom_read"));
    let bom = client.call("tool_call", json!({"tool": "bom_read"}));
    assert!(!bom.is_error, "{}", bom.text);
    assert!(bom.body["lines"].is_array(), "{}", bom.text);
    let recorded = workspace.last_recorded();
    assert_eq!(
        (&recorded["tool"], &recorded["op"]),
        (&json!("tool_call"), &json!("bom.read"))
    );
    assert_eq!(
        recorded["mutating"], false,
        "the ledger records what actually ran"
    );

    // The target's input is validated and repaired like a direct call.
    let list = client.call(
        "tool_call",
        json!({"tool": "artifact.list", "input": {"limit": "1"}}),
    );
    assert!(!list.is_error, "{}", list.text);
    assert_eq!(
        strings(&list.body["notes"]),
        [
            "read tool name \"artifact.list\" as artifact_list",
            "read limit \"1\" as integer 1"
        ]
    );
    let invalid = client.call(
        "tool_call",
        json!({"tool": "artifact_read", "input": {"id": "x"}}),
    );
    assert!(invalid.is_error);
    assert_eq!(
        invalid.body["message"],
        "Invalid input for artifact_read: 2 problems, listed in issues."
    );
    assert!(invalid.body["example"]["artifactId"].is_string());

    let denied = client.call(
        "tool_call",
        json!({"tool": "proposal_approve", "input": {}}),
    );
    assert_eq!(denied.body["code"], "CAPABILITY_DENIED");
    let recursive = client.call("tool_call", json!({"tool": "tool_call", "input": {}}));
    assert_eq!(recursive.body["message"], "tool_call cannot call itself");
    assert_eq!(recursive.body["example"]["tool"], "wiring_validate");
    let unknown = client.call("tool_call", json!({"tool": "artfact_list"}));
    assert_eq!(unknown.body["code"], "NOT_FOUND");
    assert_eq!(unknown.body["didYouMean"], "artifact_list");
    let empty = client.call("tool_call", json!({}));
    assert_eq!(empty.body["issues"][0]["path"], "tool");
    assert_eq!(empty.body["example"]["tool"], "wiring_validate");
    let extra = client.call("tool_call", json!({"tool": "bom_read", "args": {}}));
    assert_eq!(extra.body["issues"][0]["path"], "args");
    assert_eq!(extra.body["issues"][0]["nearest"], Value::Null);
    assert!(workspace
        .recorded()
        .iter()
        .skip(3)
        .all(|call| call["ok"] == false));
    assert_eq!(workspace.recorded().len(), 8);
}

#[test]
fn playbooks_are_served_through_the_same_funnel() {
    let workspace = Workspace::new("Guides");
    let mut client = workspace.mcp(Profile::Compact);
    let start = client.call("guide_read", json!({}));
    assert!(!start.is_error);
    assert_eq!(start.body["topic"], "start");
    assert!(start.body["text"]
        .as_str()
        .unwrap()
        .ends_with("then call work_status."));
    assert_eq!(start.body["topics"].as_array().unwrap().len(), 10);
    assert!(
        start.body.get("truncated").is_none(),
        "a playbook is never cut"
    );
    let verify = client.call("guide_read", json!({"topic": "cad_verify"}));
    assert_eq!(verify.body["topic"], "cad-verify");
    let unknown = client.call("guide_read", json!({"topic": "soldering"}));
    assert!(unknown.is_error);
    assert_eq!(unknown.body["code"], "NOT_FOUND");
    assert!(unknown.body["repair"]
        .as_str()
        .unwrap()
        .contains("start, requirements, components"));
    assert_eq!(unknown.body["example"], json!({"topic": "start"}));
    let recorded = workspace.recorded();
    assert_eq!(recorded.len(), 3);
    assert!(recorded.iter().all(|call| call["op"] == "guide.read"));
    assert_eq!(recorded[2]["code"], "NOT_FOUND");
}

#[test]
fn idempotency_keys_are_accepted_everywhere_and_listed_nowhere() {
    let workspace = Workspace::new("Keys accepted");
    let mut client = workspace.mcp(Profile::Full);
    let tools = client.request("tools/list", json!({}))["result"]["tools"].clone();
    assert!(!serde_json::to_string(&tools)
        .unwrap()
        .contains("idempotencyKey"));

    // A read tool does not declare the key; it is taken as transport data.
    let read = client.call("artifact_list", json!({"idempotencyKey": "k-1"}));
    assert!(!read.is_error, "{}", read.text);
    // A mutating tool replays its first result for the same key.
    let payload = json!({"type": "note", "title": "Once", "payload": {"markdown": "one"}, "idempotencyKey": "k-2"});
    let first = client.call("artifact_create_draft", payload.clone());
    assert!(!first.is_error, "{}", first.text);
    let again = client.call("artifact_create_draft", payload);
    assert_eq!(again.body["artifact"]["id"], first.body["artifact"]["id"]);
    assert_eq!(
        workspace.user("artifact.list", json!({}))["artifacts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn each_profile_gets_its_instructions_and_its_tool_list() {
    let workspace = Workspace::new("Profiles");
    let mut wire_sizes = Vec::new();
    for (profile, tool_count) in [
        (Profile::Compact, 15),
        (Profile::Standard, 45),
        (Profile::Full, 60),
    ] {
        let (token, _) = workspace.grant(profile);
        let mut client = McpClient::connect(&workspace.bridge, &token, "mcp");
        // A revision this server does not implement is answered with one it does.
        let initialized = client.request(
            "initialize",
            json!({"protocolVersion": "2026-07-28", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}),
        );
        let result = &initialized["result"];
        assert_eq!(result["protocolVersion"], "2025-06-18");
        assert_eq!(result["serverInfo"]["name"], "bureau");
        assert_eq!(result["serverInfo"]["title"], "Bureau");
        assert_eq!(result["capabilities"]["tools"]["listChanged"], false);
        let instructions = result["instructions"].as_str().unwrap();
        assert_eq!(instructions, crate::guide::instructions(profile));
        assert!(instructions.chars().count() <= 1_800);
        assert!(instructions.contains("guide_read for a playbook"));
        assert!(instructions.contains("Call work_status before you finish"));

        let tools = client.request("tools/list", json!({}))["result"]["tools"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(
            tools.len(),
            registry().tools_for(profile).count(),
            "{profile} lists what the registry says"
        );
        assert!(tools.len() >= tool_count, "{profile} lists {}", tools.len());
        assert_eq!(
            tools,
            client.request("tools/list", json!({}))["result"]["tools"]
                .as_array()
                .unwrap()
                .clone()
        );
        for name in ["work_status", "guide_read", "tool_describe", "tool_call"] {
            assert!(
                tools.iter().any(|tool| tool["name"] == name),
                "{profile} lacks {name}"
            );
        }
        assert!(tools
            .iter()
            .all(|tool| tool["title"].is_string() && tool["annotations"].is_object()));
        wire_sizes.push(chars(&Value::Array(tools)));
    }
    // What the model is sent for a compact session: name, description and
    // schema of each tool.
    let (token, _) = workspace.grant(Profile::Compact);
    let mut client = McpClient::connect(&workspace.bridge, &token, "mcp");
    let model_facing = client.request("tools/list", json!({}))["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| json!({"name": tool["name"], "description": tool["description"], "inputSchema": tool["inputSchema"]}))
        .collect::<Vec<_>>();
    let compact = chars(&Value::Array(model_facing));
    println!(
        "compact tools/list: {compact} chars to the model; on the wire by profile: {wire_sizes:?}"
    );
    // 0.2.4: raised from 7,500 to 8,500 for cad_view and image_view, cad_check spec items and write-and-check expect, measured 8,399 (recorded in audit/v0.2.4)
    assert!(compact <= 8_500, "compact tools/list is {compact} chars");
    assert!(wire_sizes[0] < wire_sizes[1] && wire_sizes[1] < wire_sizes[2]);

    // An older revision the server implements is honoured as asked.
    let (token, _) = workspace.grant(Profile::Standard);
    let mut old = McpClient::connect(&workspace.bridge, &token, "mcp");
    let reply = old.request("initialize", json!({"protocolVersion": "2024-11-05"}));
    assert_eq!(reply["result"]["protocolVersion"], "2024-11-05");
}

#[test]
fn the_protocol_edges_do_not_strand_a_client() {
    let workspace = Workspace::new("Protocol");
    let (token, session_id) = workspace.grant(Profile::Compact);
    let mut client = McpClient::connect(&workspace.bridge, &token, "mcp");

    // Notifications and stray responses get no reply; the next request does.
    client.notify("notifications/initialized");
    client.notify("notifications/cancelled");
    client.send(json!({"jsonrpc": "2.0", "id": 99, "result": {}}));
    assert_eq!(client.request("ping", json!({}))["result"], json!({}));

    let unknown = client.request("prompts/list", json!({}));
    assert_eq!(unknown["error"]["code"], -32601);
    let nameless = client.request("tools/call", json!({"arguments": {}}));
    assert_eq!(nameless["error"]["code"], -32602);
    client.send(json!({"jsonrpc": "2.0", "id": 100}));
    assert_eq!(client.receive()["error"]["code"], -32600);

    let resources = client.request("resources/list", json!({}));
    let uri = resources["result"]["resources"][0]["uri"]
        .as_str()
        .unwrap()
        .to_owned();
    let read = client.request("resources/read", json!({"uri": uri}));
    let text = read["result"]["contents"][0]["text"].as_str().unwrap();
    assert!(!text.contains('\n'));
    assert_eq!(
        serde_json::from_str::<Value>(text).unwrap()["project"]["name"],
        "Protocol"
    );
    // Only real tool calls reach the ledger, and nothing protocol-level does.
    assert_eq!(workspace.recorded().len(), 1);

    workspace.bridge.revoke(&session_id);
    let revoked = client.request("ping", json!({}));
    assert_eq!(revoked["error"]["code"], -32000);
    assert_eq!(
        revoked["error"]["message"],
        "Agent session grant was revoked"
    );
    assert_eq!(workspace.recorded().len(), 1);
}

#[test]
fn bureau_call_takes_either_name_form_and_returns_structured_errors() {
    let workspace = Workspace::new("Call mode");
    note(&workspace, "Plate", 3);
    let (token, _) = workspace.grant(Profile::Compact);
    let mut client = McpClient::connect(&workspace.bridge, &token, "call");
    for name in ["artifact.list", "artifact_list"] {
        let reply = client.call_op(name, json!({"limit": "1"}));
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(reply["result"]["artifacts"].as_array().unwrap().len(), 1);
        // Both forms are native to the command line; only the repair is noted.
        assert_eq!(
            strings(&reply["result"]["notes"]),
            ["read limit \"1\" as integer 1"]
        );
        let recorded = workspace.last_recorded();
        assert_eq!(
            (&recorded["tool"], &recorded["via"]),
            (&json!(name), &json!("call"))
        );
    }
    let invalid = client.call_op("cad.check", json!({"artifact": "x"}));
    assert_eq!(invalid["ok"], false);
    let error = &invalid["error"];
    assert_eq!(error["code"], "VALIDATION");
    assert!(error["repair"]
        .as_str()
        .unwrap()
        .contains("Then call cad_check again."));
    assert!(error["details"]["issues"].as_array().unwrap().len() >= 2);
    assert!(error["details"]["example"]["expect"].is_object());
    let unknown = client.call_op("cad.chek", json!({}));
    assert_eq!(unknown["error"]["code"], "NOT_FOUND");
    assert_eq!(unknown["error"]["details"]["nearest"], "cad_check");
    let guide = client.call_op("guide.read", json!({"topic": "finish"}));
    assert_eq!(guide["result"]["topic"], "finish");
    let via_wrapper = client.call_op("tool.call", json!({"tool": "guide_read", "input": {}}));
    assert_eq!(via_wrapper["result"]["topic"], "start");
    assert_eq!(workspace.last_recorded()["op"], "guide.read");
}

#[test]
fn live_calls_reach_the_host_hook_and_the_session_counters() {
    let workspace = Workspace::new("Live");
    let (sender, receiver) = std::sync::mpsc::channel();
    workspace
        .bridge
        .set_on_call(std::sync::Arc::new(move |record| {
            let _ = sender.send(record);
        }));
    let mut client = workspace.mcp(Profile::Compact);
    client.call("project_summary", json!({}));
    client.call("artifact_read", json!({}));
    let pushed = receiver.try_iter().collect::<Vec<_>>();
    assert_eq!(
        pushed,
        workspace.recorded(),
        "the hook receives exactly what is stored"
    );
    assert_eq!(pushed[0]["seq"], 1);
    assert_eq!(pushed[1]["seq"], 2);
    assert!(pushed[0].get("arguments").is_none() && pushed[0].get("input").is_none());
    let activity = workspace.bridge.session_activity(&client.session_id);
    assert_eq!((activity.calls, activity.errors), (2, 1));
    assert!(!activity.waiting_for_review);

    // The same records are on disk, one line each, without arguments.
    let file = workspace
        .root()
        .join(".bureau/work")
        .join(&client.session_id)
        .join("calls.jsonl");
    let lines = std::fs::read_to_string(file).unwrap();
    let stored = lines
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(stored, pushed);

    let summary = workspace
        .bridge
        .agent_activity(
            &workspace.project_id,
            &json!({"sessionId": client.session_id}),
        )
        .unwrap();
    assert_eq!(
        summary["sessions"],
        json!([{
            "sessionId": client.session_id, "adapterId": "codex", "model": "gpt-6-luna",
            "profile": "compact", "startedAt": summary["sessions"][0]["startedAt"],
            "endedAt": null, "calls": 2, "errors": 1
        }])
    );
    let error = workspace
        .bridge
        .agent_activity(&workspace.project_id, &json!({"limit": 0}))
        .unwrap_err();
    assert_eq!(error.code, "VALIDATION");
}

#[test]
fn a_wait_for_review_is_bounded_explicit_and_visible() {
    let workspace = Workspace::new("Wait");
    let draft = workspace.user(
        "artifact.create_draft",
        json!({"type": "requirement", "title": "Payload", "payload": {"statement": "Carry 0.3 kg", "acceptanceCriterion": "Lifts it"}}),
    );
    let proposal = workspace.user(
        "proposal.submit",
        json!({"changes": [{"artifactId": draft["artifact"]["id"], "baseRevisionId": null, "newRevisionId": draft["revision"]["id"], "kind": "new_artifact"}], "reason": "review"}),
    );
    let proposal_id = proposal["id"].as_str().unwrap();
    let mut client = workspace.mcp(Profile::Standard);

    let (sender, receiver) = std::sync::mpsc::channel();
    let bridge = std::sync::Arc::downgrade(&workspace.bridge);
    workspace
        .bridge
        .watch_sessions(std::sync::Arc::new(move |_, session_id| {
            if let Some(bridge) = bridge.upgrade() {
                let _ = sender.send(bridge.session_activity(session_id).waiting_for_review);
            }
        }));
    let pending = client.call(
        "proposal_wait",
        json!({"proposalId": proposal_id, "timeoutMs": "150"}),
    );
    assert!(!pending.is_error, "{}", pending.text);
    assert_eq!(pending.body["state"], "pending");
    assert_eq!(pending.body["timedOut"], true);
    assert_eq!(pending.body["next"]["tool"], "proposal_wait");
    assert_eq!(
        pending.body["next"]["args"],
        json!({"proposalId": proposal_id})
    );
    // Waiting began, ended, and then the call was recorded.
    assert_eq!(
        receiver.try_iter().collect::<Vec<_>>(),
        [true, false, false]
    );
    assert!(
        !workspace
            .bridge
            .session_activity(&client.session_id)
            .waiting_for_review
    );

    workspace.user(
        "proposal.approve",
        json!({"proposalId": proposal_id, "rationale": "ok"}),
    );
    let resolved = client.call("proposal_wait", json!({"proposalId": proposal_id}));
    assert_eq!(resolved.body["state"], "accepted");
    assert_eq!(resolved.body["timedOut"], false);
    assert!(resolved.body.get("next").is_none());
}

/// A 64 × 48 PNG: white with a red block, written into the project.
fn drawing(workspace: &Workspace) -> Vec<u8> {
    let (width, height) = (64u32, 48u32);
    let mut data = vec![255u8; (width * height * 3) as usize];
    for pixel in data.chunks_mut(3).take((width * 10) as usize) {
        pixel.copy_from_slice(&[200, 0, 0]);
    }
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().unwrap();
    writer.write_image_data(&data).unwrap();
    writer.finish().unwrap();
    let inputs = workspace.root().join("inputs");
    std::fs::create_dir_all(&inputs).unwrap();
    std::fs::write(inputs.join("drawing.png"), &bytes).unwrap();
    bytes
}

const ROUTE: &str = "Open images[0].path (relative to the project folder) with your image viewer (Codex: view_image).";

#[test]
fn image_view_sends_a_picture_over_mcp_and_a_path_over_bureau_call() {
    let workspace = Workspace::new("Pictures");
    drawing(&workspace);
    // Claude Code shows the picture with structured content; Codex only
    // without it; a client not known to show pictures is told the path.
    for (adapter, structured, told) in [
        ("claude-code", true, false),
        ("codex", false, false),
        ("custom", true, true),
    ] {
        let mut client = workspace.mcp_for(Profile::Compact, adapter);
        let reply = client.call(
            "image_view",
            json!({"path": "inputs/drawing.png", "region": [0, 0, 0.5, 0.5]}),
        );
        assert!(!reply.is_error, "{}", reply.text);
        assert_eq!(reply.structured, structured, "{adapter}");
        assert_eq!(reply.images.len(), 1, "{adapter}");
        let (mime, bytes) = &reply.images[0];
        assert_eq!(mime, "image/png");
        let entry = &reply.body["images"][0];
        assert_eq!(entry["attached"], true);
        assert_eq!(entry["bytes"], bytes.len());
        let reader = png::Decoder::new(std::io::Cursor::new(bytes.as_slice()))
            .read_info()
            .unwrap();
        assert_eq!(
            [reader.info().width as u64, reader.info().height as u64],
            [
                entry["widthPx"].as_u64().unwrap(),
                entry["heightPx"].as_u64().unwrap()
            ]
        );
        assert_eq!(
            strings(&reply.body["notes"]).contains(&ROUTE),
            told,
            "{adapter}"
        );
        assert!(reply.text.len() < 4_000, "no picture bytes in the text");
        let recorded = workspace.last_recorded();
        assert_eq!(
            (&recorded["op"], &recorded["ok"]),
            (&json!("image.view"), &json!(true))
        );
        assert!(
            recorded.to_string().len() < 2_000,
            "no picture bytes in the ledger"
        );
    }
    let listed = workspace
        .mcp_for(Profile::Compact, "claude-code")
        .request("tools/list", json!({}));
    let annotations = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "image_view")
        .unwrap()["annotations"]
        .clone();
    assert_eq!(
        annotations["readOnlyHint"], true,
        "pictures can be looked at in plan mode"
    );

    // bureau call: the path and hash, never the bytes.
    let (token, _) = workspace.grant(Profile::Standard);
    let mut call = McpClient::connect(&workspace.bridge, &token, "call");
    let response = call.call_op("image_view", json!({"path": "inputs/drawing.png"}));
    assert_eq!(response["ok"], true, "{response}");
    let result = &response["result"];
    let entry = &result["images"][0];
    let path = entry["path"].as_str().unwrap();
    assert!(path.starts_with(".bureau/cache/views-v1/"));
    assert!(entry.get("attached").is_none());
    assert!(entry.get("data").is_none());
    assert!(workspace.root().join(path).is_file());
    assert!(strings(&result["notes"]).contains(&ROUTE));
    assert!(response.to_string().len() < 4_000);
}

#[test]
fn a_refused_picture_is_an_ordinary_tool_error() {
    let workspace = Workspace::new("Pictures");
    let mut client = workspace.mcp_for(Profile::Compact, "claude-code");
    let outside = client.call("image_view", json!({"path": "../drawing.png"}));
    assert!(outside.is_error);
    assert_eq!(outside.body["code"], "PATH_OUTSIDE_PROJECT");
    assert!(outside.images.is_empty() && outside.structured);
    // Pixel coordinates in region are read as pixels and said so.
    drawing(&workspace);
    let pixels = client.call(
        "image_view",
        json!({"path": "inputs/drawing.png", "region": [0, 0, 32, 24]}),
    );
    assert!(!pixels.is_error, "{}", pixels.text);
    assert_eq!(pixels.body["regionPx"], json!([0, 0, 32, 24]));
    assert!(strings(&pixels.body["notes"]).contains(&"region read as pixels"));
}
