use super::*;
use serde_json::json;

/// A registry small enough to read, exported the way the TypeScript script
/// writes it. The live registry changes with every new operation; these tests
/// must not.
const FIXTURE: &str = r#"{
  "protocolVersion": 1,
  "schemaVersion": 1,
  "projectFile": ".bureau/project.json",
  "maxFrameBytes": 1024,
  "envKeys": {},
  "errorCodes": ["VALIDATION"],
  "eventTypes": [],
  "artifactPayloadSchemas": {},
  "operations": [
    {
      "name": "artifact.read", "toolName": "artifact_read",
      "description": "Read one artifact", "capability": "both", "mutating": false,
      "agentVisible": true, "agentAllowed": true, "agentTool": true,
      "tier": "core", "pack": "core", "summary": "Read one artifact by id.",
      "example": { "artifactId": "11111111-1111-4111-8111-111111111111" },
      "compactSchema": null,
      "inputSchema": {
        "type": "object",
        "properties": {
          "artifactId": { "type": "string", "format": "uuid" },
          "revisionId": { "type": "string", "format": "uuid" }
        },
        "required": ["artifactId"],
        "additionalProperties": false,
        "$schema": "http://json-schema.org/draft-07/schema#"
      }
    },
    {
      "name": "artifact.list", "toolName": "artifact_list",
      "description": "List artifacts", "capability": "both", "mutating": false,
      "agentVisible": true, "agentAllowed": true, "agentTool": true,
      "tier": "core", "pack": "core", "summary": "Find artifacts by type.",
      "example": {},
      "inputSchema": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": ["requirement", "component", "mechanical", "wiring", "note"]
          },
          "includeArchived": { "type": "boolean", "default": false },
          "limit": { "type": "integer", "exclusiveMinimum": 0, "maximum": 500, "default": 200 },
          "offset": { "type": "integer", "minimum": 0, "default": 0 }
        },
        "additionalProperties": false
      }
    },
    {
      "name": "cad.check", "toolName": "cad_check",
      "description": "Verify a part", "capability": "both", "mutating": true,
      "agentVisible": true, "agentAllowed": true, "agentTool": true,
      "tier": "core", "pack": "cad", "summary": "Verify a part against dimensions.",
      "example": {
        "artifactId": "11111111-1111-4111-8111-111111111111",
        "expect": { "bbox": { "min": [0, 0, 0], "max": [40, 30, 5] } }
      },
      "compactSchema": {
        "type": "object",
        "properties": { "artifactId": { "type": "string" }, "expect": { "type": "object" } },
        "required": ["artifactId", "expect"]
      },
      "inputSchema": {
        "type": "object",
        "properties": {
          "artifactId": { "type": "string", "format": "uuid" },
          "expect": {
            "type": "object",
            "properties": {
              "bbox": {
                "type": "object",
                "properties": {
                  "min": {
                    "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3
                  },
                  "max": {
                    "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3
                  },
                  "tol": { "type": "number" }
                },
                "required": ["min", "max"],
                "additionalProperties": false
              },
              "sections": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "axis": { "type": "string", "enum": ["x", "y", "z"] },
                    "at": { "type": "number" },
                    "holes": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": { "d": { "type": "number", "exclusiveMinimum": 0 } },
                        "required": ["d"],
                        "additionalProperties": false
                      }
                    }
                  },
                  "required": ["axis", "at"],
                  "additionalProperties": false
                }
              }
            },
            "additionalProperties": false
          },
          "exploratory": { "type": "boolean", "default": false }
        },
        "required": ["artifactId", "expect"],
        "additionalProperties": false
      }
    },
    {
      "name": "component.add_candidate", "toolName": "component_add_candidate",
      "description": "Add a candidate component", "capability": "both", "mutating": true,
      "agentVisible": true, "agentAllowed": true, "agentTool": true,
      "tier": "standard", "pack": "parts", "summary": "Record a candidate part.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": { "type": "string", "minLength": 1 },
          "properties": {
            "type": "object",
            "additionalProperties": {
              "type": "object",
              "properties": {
                "quantity": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "value": { "type": "number" },
                        "unit": { "type": "string", "minLength": 1 },
                        "min": { "type": "number" },
                        "max": { "type": "number" }
                      },
                      "required": ["value", "unit"],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "unknown": { "type": "boolean", "const": true },
                        "reason": { "type": "string" }
                      },
                      "required": ["unknown", "reason"],
                      "additionalProperties": false
                    }
                  ]
                },
                "sourceId": { "type": "string", "format": "uuid" }
              },
              "required": ["quantity"],
              "additionalProperties": false
            },
            "default": {}
          },
          "price": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "amount": { "type": "string", "pattern": "^-?\\d+(\\.\\d{1,4})?$" },
                  "currency": { "type": "string", "minLength": 3, "maxLength": 3 }
                },
                "required": ["amount", "currency"],
                "additionalProperties": false
              },
              { "type": "null" }
            ],
            "default": null
          },
          "quantityBasis": { "type": "number", "exclusiveMinimum": 0, "default": 1 },
          "idempotencyKey": { "type": "string" }
        },
        "required": ["title"],
        "additionalProperties": false
      }
    },
    {
      "name": "graph.neighbors", "toolName": "graph_neighbors",
      "description": "Neighbours of an artifact", "capability": "both", "mutating": false,
      "agentVisible": true, "agentAllowed": true, "agentTool": true,
      "tier": "standard", "pack": "graph", "summary": "List linked artifacts.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "artifactId": { "type": "string", "format": "uuid" },
          "direction": {
            "type": "string", "enum": ["upstream", "downstream", "both"], "default": "both"
          },
          "depth": { "type": "integer", "exclusiveMinimum": 0, "maximum": 10, "default": 1 }
        },
        "required": ["artifactId"],
        "additionalProperties": false
      }
    },
    {
      "name": "cad.set_param", "toolName": "cad_set_param",
      "description": "Set one parameter", "capability": "both", "mutating": true,
      "agentVisible": true, "agentAllowed": true, "agentTool": true,
      "tier": "standard", "pack": "cad", "summary": "Change one parameter.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "name": { "type": "string", "minLength": 1 },
          "value": { "type": ["number", "string", "boolean"] }
        },
        "required": ["name", "value"],
        "additionalProperties": false
      }
    },
    {
      "name": "tool.doctor", "toolName": "tool_doctor",
      "description": "Run diagnostics", "capability": "both", "mutating": false,
      "agentVisible": true, "agentAllowed": true, "agentTool": true,
      "tier": "full", "pack": "system", "summary": "Check external tools.",
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
    },
    {
      "name": "tool.call", "toolName": "tool_call",
      "description": "Call any tool by name", "capability": "both", "mutating": true,
      "agentVisible": true, "agentAllowed": true, "agentTool": true,
      "tier": "core", "pack": "core", "summary": "Call a tool that is not listed.",
      "example": { "tool": "graph_neighbors", "input": {} },
      "inputSchema": {
        "type": "object",
        "properties": {
          "tool": { "type": "string", "minLength": 1 },
          "input": { "type": "object", "additionalProperties": {} }
        },
        "required": ["tool"],
        "additionalProperties": false
      }
    },
    {
      "name": "cad.render", "toolName": "cad_render",
      "description": "Render a revision", "capability": "both", "mutating": true,
      "agentVisible": false, "agentAllowed": true, "agentTool": false,
      "tier": "core", "pack": "cad", "summary": "Render a revision.",
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
    },
    {
      "name": "proposal.approve", "toolName": "proposal_approve",
      "description": "Approve a proposal", "capability": "user", "mutating": true,
      "agentVisible": true, "agentAllowed": false, "agentTool": false,
      "tier": null, "pack": null, "summary": null, "example": null, "compactSchema": null,
      "inputSchema": {
        "type": "object",
        "properties": { "proposalId": { "type": "string", "format": "uuid" } },
        "required": ["proposalId"],
        "additionalProperties": false
      }
    },
    {
      "name": "legacy.ping", "toolName": "legacy_ping",
      "description": "Exported before tiers existed", "capability": "both", "mutating": false,
      "agentVisible": true, "agentAllowed": true, "agentTool": true,
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
    }
  ]
}"#;

fn fixture() -> ContractRegistry {
    ContractRegistry::from_json(FIXTURE).unwrap()
}

const ARTIFACT: &str = "11111111-1111-4111-8111-111111111111";
const REVISION: &str = "22222222-2222-4222-8222-222222222222";

fn issue(path: &str, kind: IssueKind, message: &str) -> ValidationIssue {
    ValidationIssue {
        path: path.to_owned(),
        kind,
        message: message.to_owned(),
        expected: None,
        received: None,
        nearest: None,
    }
}

fn mismatch(path: &str, kind: IssueKind, expected: &str, received: &str) -> ValidationIssue {
    ValidationIssue {
        expected: Some(expected.to_owned()),
        received: Some(received.to_owned()),
        ..issue(
            path,
            kind,
            &format!("expected {expected}, received {received}"),
        )
    }
}

fn keys(value: &Value) -> Vec<&str> {
    let fields = value.as_object().unwrap();
    fields.keys().map(String::as_str).collect()
}

fn tools(registry: &ContractRegistry, profile: Profile) -> Vec<&str> {
    let listed = registry.tools_for(profile);
    listed.map(|op| op.tool_name.as_str()).collect()
}

// ---- The live registry: invariants only, whatever it contains today. ----

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
fn live_registry_only_grows_and_every_name_resolves() {
    let contracts = registry();
    // v0.1 shipped 100 operations and names are never removed.
    assert!(contracts.operations.len() >= 100);
    for op in &contracts.operations {
        assert_eq!(op.tool_name, op.name.replace('.', "_"));
        for name in [&op.name, &op.tool_name] {
            assert_eq!(contracts.resolve(name).unwrap().name, op.name);
        }
        assert!(op.compiled().is_ok(), "{} schema must compile", op.name);
        if op.agent_tool {
            assert!(op.agent_allowed, "{} is listed but not callable", op.name);
            assert!(Profile::Full.lists(op));
        }
    }
    for kind in contracts.artifact_payload_schemas.keys() {
        assert!(
            contracts.payload(kind).is_ok(),
            "{kind} payload schema must compile"
        );
    }
}

#[test]
fn live_examples_are_valid_input_and_compact_schemas_add_no_fields() {
    for op in &registry().operations {
        if let Some(example) = &op.example {
            // `details.example` is offered to agents as a minimal valid input.
            let parsed = parse_agent_input(op, example.clone())
                .unwrap_or_else(|error| panic!("{} example: {}", op.name, error.message));
            assert_eq!(parsed.notes, Vec::<String>::new(), "{} example", op.name);
        }
        if let Some(compact) = &op.compact_schema {
            let real = &op.input_schema["properties"];
            for key in compact["properties"].as_object().into_iter().flatten() {
                assert!(
                    real.get(key.0).is_some(),
                    "{} compact field {} is not an input field",
                    op.name,
                    key.0
                );
            }
        }
    }
}

#[test]
fn input_defaults_and_unknown_keys_match_zod_object_behavior() {
    let op = registry().operation("artifact.list").unwrap();
    let input = parse_input(op, json!({ "garbage": 3 })).unwrap();
    // Every declared default, in schema order, and nothing the schema does
    // not declare.
    let declared = op.input_schema["properties"].as_object().unwrap();
    let defaults = declared
        .iter()
        .filter_map(|(key, property)| Some((key.clone(), property.get("default")?.clone())))
        .collect::<Map<String, Value>>();
    assert!(!defaults.is_empty());
    assert_eq!(keys(&input), defaults.keys().collect::<Vec<_>>());
    assert_eq!(input, Value::Object(defaults));
}

#[test]
fn every_artifact_payload_retains_authored_content() {
    let examples: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/artifact-payloads.json"
    ))
    .unwrap();
    assert_eq!(
        examples.as_object().unwrap().len(),
        registry().artifact_payload_schemas.len()
    );
    for (kind, payload) in examples.as_object().unwrap() {
        let parsed = parse_artifact_payload(kind, payload.clone()).unwrap();
        for (key, value) in payload.as_object().unwrap() {
            // Defaults may be added within nested records; supplied values must remain.
            fn contains(actual: &Value, expected: &Value) -> bool {
                match expected {
                    Value::Object(fields) => {
                        fields.iter().all(|(key, v)| contains(&actual[key], v))
                    }
                    Value::Array(items) => actual.as_array().is_some_and(|a| {
                        a.len() == items.len() && a.iter().zip(items).all(|(a, b)| contains(a, b))
                    }),
                    _ => actual == expected,
                }
            }
            assert!(contains(&parsed[key], value), "{kind}.{key} content lost");
        }
        // Authored payloads need no repair and lose nothing on the agent path.
        let agent = parse_agent_artifact_payload(kind, payload.clone()).unwrap();
        assert_eq!(agent.notes, Vec::<String>::new(), "{kind}");
        assert_eq!(agent.value, parsed, "{kind}");
    }
}

#[test]
fn unrecognized_artifact_content_is_not_silently_discarded() {
    for kind in ["wiring", "software", "assembly", "test", "subsystem"] {
        assert!(parse_artifact_payload(kind, json!({"content":"must not disappear"})).is_err());
        assert!(parse_artifact_payload(kind, json!({})).is_ok());
    }
}

#[test]
fn agent_payload_keys_the_schema_does_not_declare_are_errors() {
    let payload = json!({ "markdown": "# Mount", "rationale": "must not disappear" });
    // The UI path keeps Zod's behaviour and drops the key.
    assert_eq!(
        parse_artifact_payload("note", payload.clone()).unwrap(),
        json!({ "markdown": "# Mount" })
    );
    let error = parse_agent_artifact_payload("note", payload).unwrap_err();
    assert_eq!(error.code, "VALIDATION");
    assert_eq!(
        error.message,
        "Invalid note payload: rationale: unknown key, allowed keys are markdown"
    );
    assert_eq!(
        error.repair.as_deref(),
        Some("Remove each unknown key or rename it to an allowed key. Call tool_describe with artifactType \"note\" to see the payload schema.")
    );
    assert_eq!(error.details.unwrap()["artifactType"], "note");

    let missing = parse_artifact_payload("note", json!({ "markdown": 5 })).unwrap_err();
    assert_eq!(
        missing.message,
        "Invalid note payload: markdown: expected string, received number 5"
    );
    assert_eq!(
        parse_agent_artifact_payload("part", json!({}))
            .unwrap_err()
            .message,
        "Unknown artifact type: part"
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

// ---- Registry metadata, profiles and name resolution. ----

#[test]
fn operation_metadata_defaults_when_absent_or_null() {
    let registry = fixture();
    for name in ["legacy.ping", "proposal.approve"] {
        let op = registry.operation(name).unwrap();
        assert_eq!(op.tier, Tier::Full, "{name}");
        assert_eq!(op.pack, "", "{name}");
        assert_eq!(op.summary, "", "{name}");
        assert_eq!(op.example, None, "{name}");
        assert_eq!(op.compact_schema, None, "{name}");
    }
    let read = registry.operation("artifact.read").unwrap();
    assert_eq!(read.tier, Tier::Core);
    assert_eq!(read.pack, "core");
    assert_eq!(read.summary, "Read one artifact by id.");
    assert_eq!(read.example, Some(json!({ "artifactId": ARTIFACT })));
    assert_eq!(read.compact_schema, None);
    // An empty object is a real example, not a missing one.
    let list = registry.operation("artifact.list").unwrap();
    assert_eq!(list.example, Some(json!({})));
}

#[test]
fn profiles_list_tiers_cumulatively_in_registry_order() {
    let registry = fixture();
    // Registry order, not tier order: `tool_call` is declared after the
    // standard tools and stays there.
    let core = ["artifact_read", "artifact_list", "cad_check", "tool_call"];
    let standard = [
        "artifact_read",
        "artifact_list",
        "cad_check",
        "component_add_candidate",
        "graph_neighbors",
        "cad_set_param",
        "tool_call",
    ];
    let full = [
        "artifact_read",
        "artifact_list",
        "cad_check",
        "component_add_candidate",
        "graph_neighbors",
        "cad_set_param",
        "tool_doctor",
        "tool_call",
        "legacy_ping",
    ];
    assert_eq!(tools(&registry, Profile::Compact), core);
    assert_eq!(tools(&registry, Profile::Standard), standard);
    assert_eq!(tools(&registry, Profile::Full), full);
    // `full` is exactly the agent tools; a core-tier operation that is not an
    // agent tool is listed nowhere, yet stays callable.
    let agent_tools = registry.agent_tools().map(|op| op.tool_name.as_str());
    assert_eq!(agent_tools.collect::<Vec<_>>(), full);
    let render = registry.operation("cad.render").unwrap();
    assert_eq!(render.tier, Tier::Core);
    assert!(render.agent_allowed);
    for profile in Profile::ALL {
        assert!(!profile.lists(render));
        assert!(!profile.lists(registry.operation("proposal.approve").unwrap()));
    }
    let doctor = registry.operation("tool.doctor").unwrap();
    assert!(!Profile::Compact.lists(doctor));
    assert!(!Profile::Standard.lists(doctor));
    assert!(Profile::Full.lists(doctor));
}

#[test]
fn compact_schema_is_shown_only_to_the_compact_profile() {
    let registry = fixture();
    let check = registry.operation("cad.check").unwrap();
    assert_eq!(
        check.schema_for(Profile::Compact),
        check.compact_schema.as_ref().unwrap()
    );
    assert_eq!(check.schema_for(Profile::Standard), &check.input_schema);
    assert_eq!(check.schema_for(Profile::Full), &check.input_schema);
    let read = registry.operation("artifact.read").unwrap();
    assert_eq!(read.schema_for(Profile::Compact), &read.input_schema);
}

#[test]
fn profile_parses_displays_and_serialises_in_lowercase() {
    assert_eq!("compact".parse::<Profile>().unwrap(), Profile::Compact);
    assert_eq!(" Full\n".parse::<Profile>().unwrap(), Profile::Full);
    assert_eq!("STANDARD".parse::<Profile>().unwrap(), Profile::Standard);
    assert_eq!(Profile::default(), Profile::Standard);
    for profile in Profile::ALL {
        assert_eq!(profile.to_string(), profile.as_str());
        assert_eq!(profile.to_string().parse::<Profile>().unwrap(), profile);
        assert_eq!(serde_json::to_value(profile).unwrap(), profile.as_str());
    }
    assert_eq!(
        serde_json::from_value::<Profile>(json!("compact")).unwrap(),
        Profile::Compact
    );
    // `auto` is a setting the host resolves, not a profile.
    let error = "auto".parse::<Profile>().unwrap_err();
    assert_eq!(error.code, "VALIDATION");
    assert_eq!(error.message, "Unknown profile: auto");
    assert_eq!(
        error.repair.as_deref(),
        Some("Use compact, standard, or full.")
    );
    assert_eq!(
        serde_json::from_value::<Tier>(json!("standard")).unwrap(),
        Tier::Standard
    );
    assert!(Tier::Core < Tier::Standard && Tier::Standard < Tier::Full);
}

#[test]
fn resolve_accepts_dotted_tool_and_prefixed_names_in_any_case() {
    let registry = fixture();
    for name in [
        "component.add_candidate",
        "component_add_candidate",
        "Component.Add_Candidate",
        "COMPONENT_ADD_CANDIDATE",
        "  component_add_candidate ",
        "mcp__bureau__component_add_candidate",
        "bureau__component.add_candidate",
    ] {
        let op = registry.resolve(name);
        assert_eq!(
            op.map(|op| op.name.as_str()),
            Some("component.add_candidate"),
            "{name}"
        );
    }
    for name in ["component.add", "component add candidate", "", "__"] {
        assert!(registry.resolve(name).is_none(), "{name:?}");
    }
    // `operation` stays the exact dotted lookup.
    assert!(registry.operation("component_add_candidate").is_none());
    assert!(registry.operation("component.add_candidate").is_some());
}

#[test]
fn nearest_suggests_a_close_operation() {
    let registry = fixture();
    let nearest = |name: &str| registry.nearest(name).map(|op| op.name.as_str());
    assert_eq!(nearest("cad_chek"), Some("cad.check"));
    assert_eq!(nearest("artifact.reed"), Some("artifact.read"));
    assert_eq!(nearest("add_candidate"), Some("component.add_candidate"));
    assert_eq!(
        nearest("mcp__bureau__graph_neighbours"),
        Some("graph.neighbors")
    );
    assert_eq!(nearest("proposal_aprove"), Some("proposal.approve"));
    assert_eq!(nearest("wiring_validate"), None);
    // An agent is never pointed at an operation it may not call.
    let agent = |name: &str| registry.nearest_agent(name).map(|op| op.name.as_str());
    assert_eq!(agent("proposal_aprove"), None);
    assert_eq!(agent("cad_rendr"), Some("cad.render"));
}

#[test]
fn unknown_operation_names_the_nearest_tool_and_the_catalogue() {
    let registry = fixture();
    let error = registry.unknown_operation("cad.chek");
    assert_eq!(error.code, "NOT_FOUND");
    assert_eq!(error.message, "Unknown operation: cad.chek");
    assert_eq!(
        error.repair.as_deref(),
        Some("Did you mean cad_check? Call tool_describe with no arguments to list every tool.")
    );
    assert_eq!(
        *error.details.unwrap(),
        json!({ "name": "cad.chek", "nearest": "cad_check", "listingTool": "tool_describe" })
    );

    let error = registry.unknown_operation("teleport");
    assert_eq!(
        error.repair.as_deref(),
        Some("Call tool_describe with no arguments to list every tool.")
    );
    assert_eq!(error.details.unwrap()["nearest"], Value::Null);
}

#[test]
fn from_json_rejects_a_registry_that_declares_an_operation_twice() {
    let mut document: Value = serde_json::from_str(FIXTURE).unwrap();
    let operations = document["operations"].as_array_mut().unwrap();
    operations.push(operations[0].clone());
    let error = ContractRegistry::from_json(&document.to_string()).unwrap_err();
    assert_eq!(
        error.to_string(),
        "operation artifact.read is declared twice"
    );
    assert!(ContractRegistry::from_json("{}").is_err());
}

#[test]
fn validators_are_compiled_once_per_operation() {
    let registry = fixture();
    let op = registry.operation("component.add_candidate").unwrap();
    let first: *const _ = op.compiled().unwrap();
    parse_input(op, json!({ "title": "Motor" })).unwrap();
    parse_agent_input(op, json!({ "title": "Motor" })).unwrap();
    assert!(std::ptr::eq(first, op.compiled().unwrap()));
}

// ---- parse_input: Zod-parity normalisation, structured failures. ----

#[test]
fn defaults_are_applied_and_unknown_keys_dropped_in_schema_order() {
    let registry = fixture();
    let list = registry.operation("artifact.list").unwrap();
    let expected = json!({ "includeArchived": false, "limit": 200, "offset": 0 });
    for payload in [json!({ "garbage": 3 }), json!({}), Value::Null] {
        let input = parse_input(list, payload).unwrap();
        assert_eq!(input, expected);
        assert_eq!(keys(&input), ["includeArchived", "limit", "offset"]);
    }
    // Keys come back in schema order however they were sent.
    let input = parse_input(
        list,
        json!({ "offset": 5, "type": "note", "includeArchived": true }),
    )
    .unwrap();
    assert_eq!(keys(&input), ["type", "includeArchived", "limit", "offset"]);
    // A null is not an absent key: no default replaces it.
    let read = registry.operation("artifact.read").unwrap();
    assert!(parse_input(read, json!({ "artifactId": ARTIFACT, "revisionId": null })).is_err());
}

#[test]
fn integer_valued_floats_become_integers() {
    let registry = fixture();
    let list = registry.operation("artifact.list").unwrap();
    let input = parse_input(list, json!({ "limit": 12.0, "offset": 3.0 })).unwrap();
    assert_eq!(input["limit"].as_u64(), Some(12));
    assert_eq!(input["offset"].as_u64(), Some(3));
    assert_eq!(
        input.to_string(),
        r#"{"includeArchived":false,"limit":12,"offset":3}"#
    );
    // A `number` field keeps the form it was sent in.
    let candidate = registry.operation("component.add_candidate").unwrap();
    let input = parse_input(candidate, json!({ "title": "Motor", "quantityBasis": 2.0 })).unwrap();
    assert!(input["quantityBasis"].is_f64());
    let error = parse_input(list, json!({ "limit": 12.5 })).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: limit: expected integer, received number 12.5"
    );
}

#[test]
fn missing_nested_required_field_is_named_by_path() {
    let registry = fixture();
    let check = registry.operation("cad.check").unwrap();
    let error = parse_input(
        check,
        json!({ "artifactId": ARTIFACT, "expect": { "sections": [{ "at": 5 }] } }),
    )
    .unwrap_err();
    assert_eq!(error.code, "VALIDATION");
    assert_eq!(
        error.message,
        "Invalid input: expect.sections[0].axis: required, expected one of \"x\", \"y\", \"z\""
    );
    assert_eq!(
        error.repair.as_deref(),
        Some("Add each missing required field.")
    );
    assert_eq!(
        error.issues(),
        [ValidationIssue {
            expected: Some("one of \"x\", \"y\", \"z\"".to_owned()),
            ..issue(
                "expect.sections[0].axis",
                IssueKind::Required,
                "required, expected one of \"x\", \"y\", \"z\"",
            )
        }]
    );
    assert_eq!(
        *error.details.unwrap(),
        json!({
            "op": "cad.check",
            "issues": [{
                "path": "expect.sections[0].axis",
                "kind": "required",
                "message": "required, expected one of \"x\", \"y\", \"z\"",
                "expected": "one of \"x\", \"y\", \"z\""
            }]
        })
    );
}

#[test]
fn every_issue_is_reported_and_the_message_names_the_first_three() {
    let registry = fixture();
    let check = registry.operation("cad.check").unwrap();
    let error = parse_input(
        check,
        json!({
            "expect": {
                "bbox": { "min": [0, 0], "max": ["1", 1, 1] },
                "sections": [{ "axis": "Z", "at": "5", "holes": [{ "d": 0 }, {}] }]
            }
        }),
    )
    .unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: artifactId: required, expected string (uuid); expect.bbox.min: expected exactly 3 items, received 2 items; expect.bbox.max[0]: expected number, received string \"1\" (+4 more)"
    );
    assert_eq!(
        error.repair.as_deref(),
        Some("Add each missing required field. Use an allowed value exactly as listed. Send each value with the expected JSON type. Keep each value within the stated format and limits.")
    );
    // Missing keys first, then members in schema order, depth first.
    assert_eq!(
        error.issues(),
        [
            ValidationIssue {
                expected: Some("string (uuid)".to_owned()),
                ..issue(
                    "artifactId",
                    IssueKind::Required,
                    "required, expected string (uuid)"
                )
            },
            mismatch(
                "expect.bbox.min",
                IssueKind::Size,
                "exactly 3 items",
                "2 items"
            ),
            mismatch(
                "expect.bbox.max[0]",
                IssueKind::Type,
                "number",
                "string \"1\""
            ),
            ValidationIssue {
                message: "expected one of \"x\", \"y\", \"z\", received \"Z\" (nearest: \"z\")"
                    .to_owned(),
                nearest: Some("z".to_owned()),
                ..mismatch(
                    "expect.sections[0].axis",
                    IssueKind::Enum,
                    "one of \"x\", \"y\", \"z\"",
                    "\"Z\""
                )
            },
            mismatch(
                "expect.sections[0].at",
                IssueKind::Type,
                "number",
                "string \"5\""
            ),
            mismatch(
                "expect.sections[0].holes[0].d",
                IssueKind::Range,
                "a number greater than 0",
                "0"
            ),
            ValidationIssue {
                expected: Some("number".to_owned()),
                ..issue(
                    "expect.sections[0].holes[1].d",
                    IssueKind::Required,
                    "required, expected number"
                )
            },
        ]
    );
}

#[test]
fn issues_follow_the_schema_however_the_input_was_ordered() {
    let registry = fixture();
    let list = registry.operation("artifact.list").unwrap();
    let paths = |payload: Value| {
        let issues = parse_agent_input(list, payload).unwrap_err().issues();
        issues
            .into_iter()
            .map(|issue| issue.path)
            .collect::<Vec<_>>()
    };
    let expected = [
        "zeta",
        "alpha",
        "type",
        "includeArchived",
        "limit",
        "offset",
    ];
    assert_eq!(
        paths(json!({
            "offset": -1, "zeta": 1, "limit": 0, "includeArchived": 1, "alpha": 2, "type": "x"
        })),
        expected
    );
    assert_eq!(
        paths(json!({
            "zeta": 1, "alpha": 2, "type": "x", "includeArchived": 1, "limit": 0, "offset": -1
        })),
        expected
    );
}

#[test]
fn wrong_type_reports_expected_and_received() {
    let registry = fixture();
    let list = registry.operation("artifact.list").unwrap();
    let error = parse_input(list, json!({ "limit": "12", "includeArchived": "true" })).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: includeArchived: expected boolean, received string \"true\"; limit: expected integer, received string \"12\""
    );
    assert_eq!(
        error.repair.as_deref(),
        Some("Send each value with the expected JSON type.")
    );
    assert_eq!(
        error.issues(),
        [
            mismatch(
                "includeArchived",
                IssueKind::Type,
                "boolean",
                "string \"true\""
            ),
            mismatch("limit", IssueKind::Type, "integer", "string \"12\""),
        ]
    );

    let param = registry.operation("cad.set_param").unwrap();
    let error = parse_input(param, json!({ "name": 5, "value": [1] })).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: name: expected string, received number 5; value: expected number or string or boolean, received array of 1 item"
    );
}

#[test]
fn null_and_json_in_a_string_get_a_specific_hint() {
    let registry = fixture();
    let read = registry.operation("artifact.read").unwrap();
    let error =
        parse_input(read, json!({ "artifactId": ARTIFACT, "revisionId": null })).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: revisionId: expected string (uuid), received null, omit the key when there is no value"
    );
    // A required key cannot be omitted, so the hint would be wrong there.
    let error = parse_input(read, json!({ "artifactId": null })).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: artifactId: expected string (uuid), received null"
    );
    // The same for a required union, and for an array element, which has no
    // key to omit.
    let candidate = registry.operation("component.add_candidate").unwrap();
    let error = parse_input(
        candidate,
        json!({ "title": "Motor", "properties": { "mass": { "quantity": null } } }),
    )
    .unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: properties.mass.quantity: expected { value: number, unit: string, min?: number, max?: number } or { unknown: true, reason: string }, received null"
    );
    let check = registry.operation("cad.check").unwrap();
    let error = parse_input(
        check,
        json!({ "artifactId": ARTIFACT, "expect": { "sections": [null], "bbox": null } }),
    )
    .unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: expect.bbox: expected { min: array of number (exactly 3 items), max: array of number (exactly 3 items), tol?: number }, received null, omit the key when there is no value; expect.sections[0]: expected { axis: one of \"x\", \"y\", \"z\", at: number, holes?: array of object }, received null"
    );

    let encoded = json!({ "artifactId": ARTIFACT }).to_string();
    let error = parse_input(read, Value::String(encoded)).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: expected { artifactId: string (uuid), revisionId?: string (uuid) }, received string \"{\\\"artifactId\\\":\\\"11111111-1111-4111-8111-111111111111\\\"}\", send the JSON value itself rather than a string"
    );
    assert_eq!(error.issues()[0].path, "");
    let error = parse_input(read, json!([])).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: expected { artifactId: string (uuid), revisionId?: string (uuid) }, received array of 0 items"
    );
}

#[test]
fn invalid_enum_lists_every_option_and_the_nearest() {
    let registry = fixture();
    let list = registry.operation("artifact.list").unwrap();
    let options = "one of \"requirement\", \"component\", \"mechanical\", \"wiring\", \"note\"";
    let error = parse_input(list, json!({ "type": "part" })).unwrap_err();
    assert_eq!(
        error.message,
        format!("Invalid input: type: expected {options}, received \"part\"")
    );
    assert_eq!(
        error.repair.as_deref(),
        Some("Use an allowed value exactly as listed.")
    );
    assert_eq!(
        error.issues(),
        [mismatch("type", IssueKind::Enum, options, "\"part\"")]
    );

    let neighbors = registry.operation("graph.neighbors").unwrap();
    let payload = json!({ "artifactId": ARTIFACT, "direction": "up" });
    let error = parse_input(neighbors, payload.clone()).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: direction: expected one of \"upstream\", \"downstream\", \"both\", received \"up\" (nearest: \"upstream\")"
    );
    assert_eq!(error.issues()[0].nearest.as_deref(), Some("upstream"));
    // The nearest value is a suggestion. An agent's enum is never rewritten,
    // not even for letter case.
    let agent = parse_agent_input(neighbors, payload).unwrap_err();
    assert_eq!(agent.message, error.message);
    let agent = parse_agent_input(list, json!({ "type": "Mechanical" })).unwrap_err();
    assert_eq!(
        agent.message,
        format!("Invalid input: type: expected {options}, received \"Mechanical\" (nearest: \"mechanical\")")
    );
}

#[test]
fn uuid_format_is_enforced() {
    let registry = fixture();
    let read = registry.operation("artifact.read").unwrap();
    let error = parse_input(read, json!({ "artifactId": "motor-mount" })).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: artifactId: expected string (uuid), received \"motor-mount\""
    );
    assert_eq!(
        error.repair.as_deref(),
        Some("Copy each id exactly from an earlier result; a title is not an id.")
    );
    assert_eq!(
        error.issues(),
        [mismatch(
            "artifactId",
            IssueKind::Format,
            "string (uuid)",
            "\"motor-mount\""
        )]
    );
    // Ids are never repaired: a near miss is still an error for an agent.
    let padded = format!(" {ARTIFACT}");
    assert!(parse_agent_input(read, json!({ "artifactId": padded })).is_err());
    assert!(parse_agent_input(read, json!({ "artifactId": &ARTIFACT[..8] })).is_err());
    let upper = ARTIFACT.to_uppercase();
    assert!(parse_input(read, json!({ "artifactId": upper })).is_ok());
    // Nested ids are checked too.
    let candidate = registry.operation("component.add_candidate").unwrap();
    let error = parse_input(
        candidate,
        json!({
            "title": "Motor",
            "properties": {
                "mass": { "quantity": { "value": 3, "unit": "g" }, "sourceId": "datasheet" }
            }
        }),
    )
    .unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: properties.mass.sourceId: expected string (uuid), received \"datasheet\""
    );
}

#[test]
fn limits_are_reported_with_the_bound() {
    let registry = fixture();
    let list = registry.operation("artifact.list").unwrap();
    let error = parse_input(list, json!({ "limit": 900, "offset": -1 })).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: limit: expected at most 500, received 900; offset: expected at least 0, received -1"
    );
    assert_eq!(
        error.repair.as_deref(),
        Some("Keep each value within the stated format and limits.")
    );
    let candidate = registry.operation("component.add_candidate").unwrap();
    let error = parse_input(
        candidate,
        json!({ "title": "", "price": { "amount": "$12.50", "currency": "DOLLARS" } }),
    )
    .unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: title: expected at least 1 character, received \"\"; price.amount: expected string matching ^-?\\d+(\\.\\d{1,4})?$, received \"$12.50\"; price.currency: expected at most 3 characters, received 7 characters"
    );
}

#[test]
fn issues_beyond_the_cap_are_counted_not_listed() {
    let registry = fixture();
    let check = registry.operation("cad.check").unwrap();
    let sections = vec![json!({}); 40];
    let error = parse_input(
        check,
        json!({ "artifactId": ARTIFACT, "expect": { "sections": sections } }),
    )
    .unwrap_err();
    assert!(error.message.ends_with(" (+77 more)"), "{}", error.message);
    assert_eq!(error.issues().len(), 50);
    assert_eq!(error.details.unwrap()["omittedIssues"], 30);
}

// ---- Unknown keys: the UI path strips, the agent path rejects. ----

#[test]
fn unknown_keys_are_stripped_for_the_ui_and_rejected_for_agents() {
    let registry = fixture();
    let read = registry.operation("artifact.read").unwrap();
    let payload = json!({ "artifactId": ARTIFACT, "revision": REVISION, "foo": 1 });
    assert_eq!(
        parse_input(read, payload.clone()).unwrap(),
        json!({ "artifactId": ARTIFACT })
    );

    let error = parse_agent_input(read, payload).unwrap_err();
    assert_eq!(error.code, "VALIDATION");
    assert_eq!(
        error.message,
        "Invalid input: revision: unknown key, allowed keys are artifactId, revisionId (nearest: revisionId); foo: unknown key, allowed keys are artifactId, revisionId"
    );
    assert_eq!(
        error.repair.as_deref(),
        Some("Remove each unknown key or rename it to an allowed key. Then call artifact_read again. details.example is a minimal valid input.")
    );
    assert_eq!(
        error.issues(),
        [
            ValidationIssue {
                expected: Some("one of artifactId, revisionId".to_owned()),
                nearest: Some("revisionId".to_owned()),
                ..issue(
                    "revision",
                    IssueKind::UnknownKey,
                    "unknown key, allowed keys are artifactId, revisionId (nearest: revisionId)"
                )
            },
            ValidationIssue {
                expected: Some("one of artifactId, revisionId".to_owned()),
                ..issue(
                    "foo",
                    IssueKind::UnknownKey,
                    "unknown key, allowed keys are artifactId, revisionId"
                )
            },
        ]
    );
    let details = error.details.unwrap();
    assert_eq!(details["op"], "artifact.read");
    assert_eq!(details["tool"], "artifact_read");
    assert_eq!(details["example"], json!({ "artifactId": ARTIFACT }));
    assert_eq!(details.get("notes"), None);
}

#[test]
fn nested_unknown_keys_are_not_dropped_assertions() {
    let registry = fixture();
    let check = registry.operation("cad.check").unwrap();
    let payload = json!({
        "artifactId": ARTIFACT,
        "expect": {
            "bbox": { "min": [0, 0, 0], "max": [40, 30, 5], "tolerance": 0.5 },
            "holes": [{ "d": 3 }]
        }
    });
    assert_eq!(
        parse_input(check, payload.clone()).unwrap(),
        json!({
            "artifactId": ARTIFACT,
            "expect": { "bbox": { "min": [0, 0, 0], "max": [40, 30, 5] } },
            "exploratory": false
        })
    );
    let error = parse_agent_input(check, payload).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: expect.holes: unknown key, allowed keys are bbox, sections; expect.bbox.tolerance: unknown key, allowed keys are min, max, tol (nearest: tol)"
    );
    let nearest = error.issues().into_iter().map(|issue| issue.nearest);
    assert_eq!(nearest.collect::<Vec<_>>(), [None, Some("tol".to_owned())]);

    // An object that takes no keys says so.
    let doctor = registry.operation("tool.doctor").unwrap();
    assert_eq!(parse_input(doctor, json!({ "x": 1 })).unwrap(), json!({}));
    let error = parse_agent_input(doctor, json!({ "x": 1 })).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: x: unknown key, this object takes no keys"
    );
    assert_eq!(
        error.repair.as_deref(),
        Some("Remove each unknown key or rename it to an allowed key. Then call tool_doctor again. Call tool_describe for tool_doctor to see its schema.")
    );
    assert_eq!(error.details.unwrap().get("example"), None);
}

#[test]
fn record_values_are_normalised_like_any_other_object() {
    let registry = fixture();
    let candidate = registry.operation("component.add_candidate").unwrap();
    let payload = json!({
        "title": "Motor",
        "properties": {
            "stall torque": {
                "sourceId": REVISION,
                "quantity": { "unit": "N*m", "value": 0.4, "approx": true },
                "note": "from the datasheet"
            }
        }
    });
    // Zod strips unknown keys inside record values and orders the declared
    // ones; so does the UI path.
    let input = parse_input(candidate, payload.clone()).unwrap();
    assert_eq!(
        input.to_string(),
        r#"{"title":"Motor","properties":{"stall torque":{"quantity":{"value":0.4,"unit":"N*m"},"sourceId":"22222222-2222-4222-8222-222222222222"}},"price":null,"quantityBasis":1}"#
    );

    let error = parse_agent_input(candidate, payload).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: properties[\"stall torque\"].note: unknown key, allowed keys are quantity, sourceId; properties[\"stall torque\"].quantity.approx: unknown key, allowed keys are value, unit, min, max"
    );
    assert_eq!(
        error.repair.as_deref(),
        Some("Remove each unknown key or rename it to an allowed key. Then call component_add_candidate again. Call tool_describe for component_add_candidate to see its schema.")
    );
    // Record keys themselves are free-form and never renamed or rejected.
    let named = parse_agent_input(
        candidate,
        json!({ "title": "Motor", "properties": { "Mass_g": { "quantity": "300 g" } } }),
    )
    .unwrap();
    assert_eq!(keys(&named.value["properties"]), ["Mass_g"]);
}

#[test]
fn an_untyped_object_passes_through_untouched() {
    let registry = fixture();
    let call = registry.operation("tool.call").unwrap();
    // `input` belongs to the target tool and is parsed against that tool's
    // schema by whoever dispatches it; nothing is repaired or rejected here.
    let payload = json!({
        "tool": "artifact_list",
        "input": { "include_archived": "true", "limit": "5", "zeta": null }
    });
    let parsed = parse_agent_input(call, payload.clone()).unwrap();
    assert_eq!(parsed.value.to_string(), payload.to_string());
    assert_eq!(parsed.notes, Vec::<String>::new());
    assert_eq!(
        parse_input(call, payload.clone()).unwrap().to_string(),
        payload.to_string()
    );
    let inner = parse_agent_input(
        registry.resolve("artifact_list").unwrap(),
        parsed.value["input"].clone(),
    )
    .unwrap_err();
    assert_eq!(
        inner.message,
        "Invalid input: zeta: unknown key, allowed keys are type, includeArchived, limit, offset"
    );
    assert_eq!(
        inner.details.unwrap()["notes"],
        json!([
            "renamed include_archived → includeArchived",
            "read includeArchived \"true\" as boolean true",
            "read limit \"5\" as integer 5"
        ])
    );
}

// ---- parse_agent_input: each repair is lossless and reported. ----

#[test]
fn numeric_strings_are_read_where_a_number_is_required() {
    let registry = fixture();
    let list = registry.operation("artifact.list").unwrap();
    let parsed = parse_agent_input(list, json!({ "limit": "12", "offset": "3.0" })).unwrap();
    assert_eq!(
        parsed.value,
        json!({ "includeArchived": false, "limit": 12, "offset": 3 })
    );
    assert_eq!(parsed.value["limit"].as_u64(), Some(12));
    assert_eq!(parsed.value["offset"].as_u64(), Some(3));
    assert_eq!(
        parsed.notes,
        [
            "read limit \"12\" as integer 12",
            "read offset \"3.0\" as integer 3"
        ]
    );

    let candidate = registry.operation("component.add_candidate").unwrap();
    let parsed = parse_agent_input(
        candidate,
        json!({ "title": "Motor", "quantityBasis": "2.5" }),
    )
    .unwrap();
    assert_eq!(parsed.value["quantityBasis"], json!(2.5));
    assert_eq!(parsed.notes, ["read quantityBasis \"2.5\" as number 2.5"]);

    // Not a whole number, or not a number at all: left for the caller.
    let error = parse_agent_input(list, json!({ "limit": "12.5", "offset": "ten" })).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: limit: expected integer, received string \"12.5\"; offset: expected integer, received string \"ten\""
    );
    // A repaired value is still held to the schema.
    let error = parse_agent_input(list, json!({ "limit": "900" })).unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: limit: expected at most 500, received 900"
    );
    assert_eq!(
        error.details.unwrap()["notes"],
        json!(["read limit \"900\" as integer 900"])
    );
    // Where a string is valid, a numeric string is a string.
    let param = registry.operation("cad.set_param").unwrap();
    let parsed = parse_agent_input(param, json!({ "name": "hole_d", "value": "5" })).unwrap();
    assert_eq!(parsed.value, json!({ "name": "hole_d", "value": "5" }));
    assert_eq!(parsed.notes, Vec::<String>::new());
}

#[test]
fn true_and_false_strings_are_read_where_a_boolean_is_required() {
    let registry = fixture();
    let list = registry.operation("artifact.list").unwrap();
    let parsed = parse_agent_input(list, json!({ "includeArchived": "true" })).unwrap();
    assert_eq!(parsed.value["includeArchived"], json!(true));
    assert_eq!(
        parsed.notes,
        ["read includeArchived \"true\" as boolean true"]
    );
    let parsed = parse_agent_input(list, json!({ "includeArchived": "false" })).unwrap();
    assert_eq!(parsed.value["includeArchived"], json!(false));
    assert_eq!(
        parsed.notes,
        ["read includeArchived \"false\" as boolean false"]
    );
    for loose in ["yes", "True", "1", ""] {
        let error = parse_agent_input(list, json!({ "includeArchived": loose })).unwrap_err();
        assert_eq!(
            error.message,
            format!(
                "Invalid input: includeArchived: expected boolean, received string \"{loose}\""
            )
        );
    }
}

#[test]
fn keys_differing_only_by_case_or_underscores_are_renamed() {
    let registry = fixture();
    let read = registry.operation("artifact.read").unwrap();
    let parsed = parse_agent_input(
        read,
        json!({ "revision_ID": REVISION, "artifact_id": ARTIFACT }),
    )
    .unwrap();
    assert_eq!(
        parsed.value.to_string(),
        format!(r#"{{"artifactId":"{ARTIFACT}","revisionId":"{REVISION}"}}"#)
    );
    assert_eq!(
        parsed.notes,
        [
            "renamed revision_ID → revisionId",
            "renamed artifact_id → artifactId"
        ]
    );

    // Nested keys are renamed with their full path, and repairs compose.
    let check = registry.operation("cad.check").unwrap();
    let parsed = parse_agent_input(
        check,
        json!({
            "ArtifactId": ARTIFACT,
            "expect": { "Sections": [{ "AXIS": "z", "At": "5" }] },
            "Exploratory": "true"
        }),
    )
    .unwrap();
    assert_eq!(
        parsed.value,
        json!({
            "artifactId": ARTIFACT,
            "expect": { "sections": [{ "axis": "z", "at": 5 }] },
            "exploratory": true
        })
    );
    assert_eq!(
        parsed.notes,
        [
            "renamed ArtifactId → artifactId",
            "renamed Exploratory → exploratory",
            "renamed expect.Sections → expect.sections",
            "renamed expect.sections[0].AXIS → expect.sections[0].axis",
            "renamed expect.sections[0].At → expect.sections[0].at",
            "read expect.sections[0].at \"5\" as number 5",
            "read exploratory \"true\" as boolean true",
        ]
    );

    // Two spellings of one key cannot both be meant: the first is renamed,
    // the second reported with the key it collides with.
    let error = parse_agent_input(
        read,
        json!({ "artifact_id": ARTIFACT, "ArtifactId": REVISION }),
    )
    .unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: ArtifactId: unknown key, allowed keys are artifactId, revisionId (nearest: artifactId)"
    );
    assert_eq!(
        error.details.unwrap()["notes"],
        json!(["renamed artifact_id → artifactId"])
    );
    // A declared key that is already set is never overwritten by a near miss.
    let error = parse_agent_input(
        read,
        json!({ "artifactId": ARTIFACT, "artifact_id": REVISION }),
    )
    .unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: artifact_id: unknown key, allowed keys are artifactId, revisionId (nearest: artifactId)"
    );
    // Hyphens and other spellings are not the same key.
    assert!(parse_agent_input(read, json!({ "artifact-id": ARTIFACT })).is_err());
}

#[test]
fn quantity_strings_are_read_where_the_schema_is_a_quantity() {
    let registry = fixture();
    let candidate = registry.operation("component.add_candidate").unwrap();
    let parsed = parse_agent_input(
        candidate,
        json!({
            "title": "Motor",
            "properties": {
                "mass": { "quantity": "300 g" },
                "payload": { "quantity": "0.5kg" },
                "supply": { "quantity": "12 Volts" }
            }
        }),
    )
    .unwrap();
    assert_eq!(
        parsed.value["properties"],
        json!({
            "mass": { "quantity": { "value": 300, "unit": "g" } },
            "payload": { "quantity": { "value": 0.5, "unit": "kg" } },
            // The unit is the caller's: never canonicalised or corrected.
            "supply": { "quantity": { "value": 12, "unit": "Volts" } }
        })
    );
    assert_eq!(
        parsed.notes,
        [
            "read properties.mass.quantity \"300 g\" as quantity {\"value\":300,\"unit\":\"g\"}",
            "read properties.payload.quantity \"0.5kg\" as quantity {\"value\":0.5,\"unit\":\"kg\"}",
            "read properties.supply.quantity \"12 Volts\" as quantity {\"value\":12,\"unit\":\"Volts\"}",
        ]
    );

    // No unit, or prose: nothing is guessed, and the repair shows the shape.
    for loose in ["300", "heavy", "about 300 g"] {
        let error = parse_agent_input(
            candidate,
            json!({ "title": "Motor", "properties": { "mass": { "quantity": loose } } }),
        )
        .unwrap_err();
        assert_eq!(
            error.message,
            format!("Invalid input: properties.mass.quantity: expected {{ value: number, unit: string, min?: number, max?: number }} or {{ unknown: true, reason: string }}, received string \"{loose}\"")
        );
        assert_eq!(
            error.repair.as_deref(),
            Some("Write a quantity as {\"value\": 300, \"unit\": \"g\"}, or {\"unknown\": true, \"reason\": \"…\"} when it is not known. Then call component_add_candidate again. Call tool_describe for component_add_candidate to see its schema.")
        );
    }
    // Money is not a quantity; a price string is not split.
    let error = parse_agent_input(candidate, json!({ "title": "Motor", "price": "12.50 USD" }))
        .unwrap_err();
    assert_eq!(
        error.message,
        "Invalid input: price: expected { amount: string matching ^-?\\d+(\\.\\d{1,4})?$, currency: string } or null, received string \"12.50 USD\""
    );
}

#[test]
fn a_union_is_repaired_against_the_branch_that_then_validates() {
    let registry = fixture();
    let candidate = registry.operation("component.add_candidate").unwrap();
    let quantity = |quantity: Value| {
        parse_agent_input(
            candidate,
            json!({ "title": "Motor", "properties": { "mass": { "quantity": quantity } } }),
        )
        .map(|parsed| {
            (
                parsed.value["properties"]["mass"]["quantity"].clone(),
                parsed.notes,
            )
        })
        .map_err(|error| error.message)
    };
    // Either branch as sent: untouched, nothing to report.
    assert_eq!(
        quantity(json!({ "value": 3, "unit": "g", "max": 4 })),
        Ok((json!({ "value": 3, "unit": "g", "max": 4 }), vec![]))
    );
    assert_eq!(
        quantity(json!({ "unknown": true, "reason": "not published" })),
        Ok((
            json!({ "unknown": true, "reason": "not published" }),
            vec![]
        ))
    );
    // Repaired against the first branch.
    assert_eq!(
        quantity(json!({ "unit": "g", "value": "300" })),
        Ok((
            json!({ "value": 300, "unit": "g" }),
            vec!["read properties.mass.quantity.value \"300\" as number 300".to_owned()]
        ))
    );
    // Repaired against the second: `unknown` is its boolean, and the first
    // branch has no such key.
    assert_eq!(
        quantity(json!({ "Unknown": "true", "reason": "not published" })),
        Ok((
            json!({ "unknown": true, "reason": "not published" }),
            vec![
                "renamed properties.mass.quantity.Unknown → properties.mass.quantity.unknown"
                    .to_owned(),
                "read properties.mass.quantity.unknown \"true\" as boolean true".to_owned(),
            ]
        ))
    );
    // No branch fits: the failure is about the closest one, not a dump of
    // the value.
    assert_eq!(
        quantity(json!({ "value": 5 })),
        Err("Invalid input: properties.mass.quantity.unit: required, expected string".to_owned())
    );
    assert_eq!(
        quantity(json!({ "unknown": true })),
        Err("Invalid input: properties.mass.quantity.reason: required, expected string".to_owned())
    );
    assert_eq!(
        quantity(json!({ "value": 5, "units": "g" })),
        Err("Invalid input: properties.mass.quantity.units: unknown key, allowed keys are value, unit, min, max (nearest: unit); properties.mass.quantity.unit: required, expected string".to_owned())
    );
    assert_eq!(
        quantity(json!(300)),
        Err("Invalid input: properties.mass.quantity: expected { value: number, unit: string, min?: number, max?: number } or { unknown: true, reason: string }, received number 300".to_owned())
    );

    // The same summary on the UI path, where nothing is repaired.
    let price = |price: Value| {
        parse_input(candidate, json!({ "title": "Motor", "price": price }))
            .map(|input| input["price"].clone())
            .map_err(|error| error.message)
    };
    assert_eq!(price(Value::Null), Ok(Value::Null));
    assert_eq!(
        price(json!({ "currency": "USD", "amount": "12.50", "note": "list price" })),
        Ok(json!({ "amount": "12.50", "currency": "USD" }))
    );
    assert_eq!(
        price(json!({ "amount": 12.5, "currency": "USD" })),
        Err("Invalid input: price.amount: expected string matching ^-?\\d+(\\.\\d{1,4})?$, received number 12.5".to_owned())
    );
}

#[test]
fn repaired_input_is_canonical() {
    let registry = fixture();
    let check = registry.operation("cad.check").unwrap();
    let parsed = parse_agent_input(
        check,
        json!({
            "expect": { "bbox": { "max": ["40", 30, 5], "min": [0, 0, 0] } },
            "artifact_id": ARTIFACT
        }),
    )
    .unwrap();
    // The strict parser accepts it unchanged, so the request hash core
    // computes is over what the agent-facing parser returned.
    let strict = parse_input(check, parsed.value.clone()).unwrap();
    assert_eq!(strict.to_string(), parsed.value.to_string());
    assert_eq!(
        parsed.value.to_string(),
        format!(
            r#"{{"artifactId":"{ARTIFACT}","expect":{{"bbox":{{"min":[0,0,0],"max":[40,30,5]}}}},"exploratory":false}}"#
        )
    );
    // Valid input costs nothing: no notes, same value as the strict parser.
    let payload = json!({ "artifactId": ARTIFACT, "expect": {} });
    let parsed = parse_agent_input(check, payload.clone()).unwrap();
    assert_eq!(parsed.notes, Vec::<String>::new());
    assert_eq!(parsed.value, parse_input(check, payload).unwrap());
    assert_eq!(
        parse_agent_input(registry.operation("tool.doctor").unwrap(), Value::Null).unwrap(),
        AgentInput {
            value: json!({}),
            notes: vec![]
        }
    );
}

// ---- ContractError builders. ----

#[test]
fn builders_attach_repair_and_details_and_serialise_only_what_is_set() {
    let plain = ContractError::new("BUSY", "Render in progress");
    assert_eq!(
        serde_json::to_value(&plain).unwrap(),
        json!({ "code": "BUSY", "message": "Render in progress" })
    );
    assert_eq!(plain.to_string(), "BUSY: Render in progress");
    assert_eq!(plain.issues(), []);

    let built = ContractError::validation("Source needs a url or filePath")
        .with_repair("Pass url for a web page or filePath for a local file.")
        .with_details(json!({ "missing": ["url", "filePath"] }));
    assert_eq!(
        serde_json::to_value(&built).unwrap(),
        json!({
            "code": "VALIDATION",
            "message": "Source needs a url or filePath",
            "repair": "Pass url for a web page or filePath for a local file.",
            "details": { "missing": ["url", "filePath"] }
        })
    );
    let round_trip: ContractError =
        serde_json::from_value(serde_json::to_value(&built).unwrap()).unwrap();
    assert_eq!(round_trip.repair, built.repair);
    assert_eq!(round_trip.details, built.details);
}

#[test]
fn purpose_built_errors_say_how_to_recover() {
    let error = ContractError::not_found("artifact", ARTIFACT, "artifact_list");
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        json!({
            "code": "NOT_FOUND",
            "message": format!("Artifact not found: {ARTIFACT}"),
            "repair": "Call artifact_list to see valid artifact ids, then retry with one of them.",
            "details": { "kind": "artifact", "id": ARTIFACT, "listingTool": "artifact_list" }
        })
    );

    let error = ContractError::revision_conflict("Base revision is no longer selected", REVISION);
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        json!({
            "code": "REVISION_CONFLICT",
            "message": "Base revision is no longer selected",
            "repair": format!("Read the artifact again and retry against revision {REVISION}."),
            "details": { "currentRevisionId": REVISION }
        })
    );

    let error = ContractError::capability_denied(
        "proposal.approve",
        "Submit the change with proposal_submit, then stop and let the human decide.",
    );
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        json!({
            "code": "CAPABILITY_DENIED",
            "message": "Agents cannot call proposal.approve; only the human can do this",
            "repair": "Submit the change with proposal_submit, then stop and let the human decide.",
            "details": { "op": "proposal.approve" }
        })
    );

    let error = ContractError::tool_missing("OpenSCAD");
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        json!({
            "code": "TOOL_MISSING",
            "message": "OpenSCAD not found",
            "repair": "Install OpenSCAD or set its executable path in Settings, then retry. An agent cannot change Settings; ask the human.",
            "details": { "tool": "OpenSCAD" }
        })
    );

    // Every code a constructor emits is one the contract declares.
    for code in [
        "NOT_FOUND",
        "REVISION_CONFLICT",
        "CAPABILITY_DENIED",
        "TOOL_MISSING",
        "VALIDATION",
        "INTERNAL",
    ] {
        assert!(
            registry().error_codes.iter().any(|known| known == code),
            "{code}"
        );
    }
}
