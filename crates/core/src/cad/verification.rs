//! Immutable request-bound CAD evidence. This intentionally has a distinct
//! checker version from the TypeScript implementation: old evidence remains
//! readable, but a new checker cannot silently claim equivalence to it.
use super::*;

const CHECKER: &str = "omenflow-rust-mesh-checks-v1";
const LEGACY_CHECKER: &str = "omenflow-mesh-checks-v4";

fn accepted_scope(handle: &ProjectHandle, artifact_id: &str) -> CoreResult<Value> {
    Ok(handle
        .db
        .query_row(
            "SELECT value FROM meta WHERE key=?1",
            [format!("cad.scope.accepted.{artifact_id}")],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(internal)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null))
}

fn spec_hash(expect: &Value) -> String {
    hash_text(&normalized(expect).to_string())
}

fn normalized(expect: &Value) -> Value {
    let mut value = expect.clone();
    if value["watertight"].is_null() {
        value["watertight"] = json!(true);
    }
    if value["minRoundness"].is_null() {
        value["minRoundness"] = json!(0.97);
    }
    if value["bbox"].is_object() && value["bbox"]["tol"].is_null() {
        value["bbox"]["tol"] = json!(0.1);
    }
    if value["volume"].is_object() && value["volume"]["tolPct"].is_null() {
        value["volume"]["tolPct"] = json!(1.5);
    }
    if let Some(sections) = value["sections"].as_array_mut() {
        for section in sections {
            for kind in ["holes", "slots", "polygons"] {
                if let Some(shapes) = section[kind].as_array_mut() {
                    for shape in shapes {
                        if shape["tol"].is_null() {
                            shape["tol"] = json!(0.1);
                        }
                    }
                }
            }
            if section["outer"].is_object() && section["outer"]["tol"].is_null() {
                section["outer"]["tol"] = json!(0.1);
            }
            if section["materialArea"].is_object() && section["materialArea"]["tolPct"].is_null() {
                section["materialArea"]["tolPct"] = json!(1.5);
            }
        }
    }
    value
}

fn covers(before: &Value, after: &Value, key: &str) -> bool {
    if before == after {
        return true;
    }
    if let (Some(a), Some(b)) = (before.as_f64(), after.as_f64()) {
        return match key {
            "tol" | "tolPct" | "maxSelfIntersections" => b <= a,
            "minRoundness" => b >= a,
            _ => false,
        };
    }
    if let Some(values) = before.as_array() {
        let Some(next) = after.as_array() else {
            return false;
        };
        if values.iter().all(Value::is_number) {
            return values == next;
        }
        return values
            .iter()
            .all(|old| next.iter().any(|new| covers(old, new, key)));
    }
    if let Some(values) = before.as_object() {
        return after.as_object().is_some_and(|next| {
            values
                .iter()
                .all(|(k, v)| next.get(k).is_some_and(|n| covers(v, n, k)))
        });
    }
    false
}

fn scope_changes(before: &Value, after: &Value) -> Vec<String> {
    let b = normalized(before);
    let a = normalized(after);
    b.as_object()
        .into_iter()
        .flat_map(|m| m.iter())
        .filter(|(key, old)| !covers(old, &a[*key], key))
        .map(|(key, _)| key.clone())
        .collect()
}

fn explicit(expect: &Value) -> bool {
    expect.as_object().is_some_and(|map| {
        map.iter().any(|(key, value)| {
            key != "watertight"
                && key != "minRoundness"
                && !value.is_null()
                && !value.as_array().is_some_and(Vec::is_empty)
        })
    })
}

fn job_history(
    handle: &ProjectHandle,
    artifact_id: &str,
) -> CoreResult<Vec<(Value, Value, String)>> {
    let mut stmt=handle.db.prepare("SELECT inputs,output_hashes,log FROM job WHERE kind='cad_check' ORDER BY created_at DESC LIMIT 200").map_err(internal)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(internal)?;
    let mut out = Vec::new();
    for row in rows {
        let (inputs, outputs, log) = row.map_err(internal)?;
        let inputs: Value = serde_json::from_str(&inputs).unwrap_or(Value::Null);
        if inputs["artifactId"] == artifact_id {
            out.push((
                inputs,
                serde_json::from_str(&outputs).unwrap_or(Value::Null),
                log,
            ));
        }
    }
    Ok(out)
}

pub(crate) fn latest_verification(handle: &ProjectHandle, revision: &Value) -> CoreResult<Value> {
    if !render_matches(revision) {
        return Ok(json!({"status":"unverified"}));
    }
    let artifact_id = required_str(revision, "artifactId")?;
    let identity = &revision["payload"]["renderIdentity"];
    for (inputs, outputs, _) in job_history(handle, artifact_id)? {
        let Some(hash) = outputs["verification"].as_str() else {
            continue;
        };
        let Ok(bytes) = handle.object_store().map_err(storage_error)?.read(hash) else {
            continue;
        };
        let Ok(evidence) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if evidence["version"] != 1
            || evidence["exploratory"] == true
            || evidence["revisionId"] != revision["id"]
            || evidence["inputFingerprint"] != identity["inputFingerprint"]
            || evidence["outputHash"] != identity["outputHash"]
            || !matches!(
                evidence["checkerVersion"].as_str(),
                Some(CHECKER | LEGACY_CHECKER)
            )
            || inputs["revisionId"] != revision["id"]
        {
            continue;
        }
        let mut stale: bool = handle
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM stale WHERE artifact_id=?1)",
                [artifact_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(internal)?
            != 0;
        for input in revision["inputs"].as_array().into_iter().flatten() {
            let upstream = input["artifactId"]
                .as_str()
                .and_then(|id| require_artifact(handle, id).ok());
            if upstream.is_none_or(|a| {
                a["archived"] == true || a["selectedRevisionId"] != input["revisionId"]
            }) {
                stale = true;
                break;
            }
        }
        let accepted = accepted_scope(handle, artifact_id)?;
        let differs = accepted["expect"].is_object()
            && !scope_changes(&accepted["expect"], &evidence["expect"]).is_empty();
        let status = if stale {
            "unverified"
        } else if evidence["status"] == "failed" {
            "failed"
        } else if differs {
            "scope_changed"
        } else if evidence["status"] == "scope_changed"
            && evidence["pass"] == true
            && evidence["integrity"]["pass"] == true
            && explicit(&evidence["expect"])
            && accepted["specHash"] == evidence["specHash"]
        {
            "passed"
        } else {
            evidence["status"].as_str().unwrap_or("unverified")
        };
        return Ok(json!({"status":status,
            "evidenceHash":hash,"evidence":evidence}));
    }
    Ok(json!({"status":"unverified"}))
}

pub(crate) fn validate_scope_accept(
    handle: &ProjectHandle,
    revision: &Value,
    evidence_hash: &str,
) -> CoreResult<Value> {
    let current = latest_verification(handle, revision)?;
    if current["evidenceHash"] != evidence_hash || !current["evidence"].is_object() {
        return Err(ContractError::new(
            "REVISION_CONFLICT",
            "Verification evidence changed or does not match this revision",
        ));
    }
    let evidence = &current["evidence"];
    if current["status"] == "unverified"
        || evidence["pass"] != true
        || evidence["integrity"]["pass"] != true
        || !explicit(&evidence["expect"])
    {
        return Err(ContractError::validation(
            "Failed, stale or generic-only checks cannot establish verified scope",
        ));
    }
    Ok(
        json!({"evidenceHash":evidence_hash,"specHash":evidence["specHash"],
        "expect":evidence["expect"],"revisionId":revision["id"],"scopeChanges":evidence["scopeChanges"]}),
    )
}

pub(crate) fn check(handle: &ProjectHandle, input: &Value, origin: &Origin) -> CoreResult<Value> {
    let artifact = require_mechanical(handle, required_str(input, "artifactId")?)?;
    let revision = pick_revision(handle, &artifact, input["revisionId"].as_str())?;
    let (_, source) = source_of(handle, &revision)?;
    let overrides = override_params(&input["params"], &parameters(&source))?;
    let render = load_render(handle, &artifact, &revision, &source, &overrides, origin)?;
    if !render.ok {
        return Err(ContractError::validation(format!(
            "Cannot check: {}",
            render
                .errors
                .first()
                .map(String::as_str)
                .unwrap_or("render failed")
        )));
    }
    let mesh = render
        .mesh
        .as_ref()
        .ok_or_else(|| ContractError::validation("Cannot check: no mesh"))?;
    let expect = &input["expect"];
    let mut lines = checks::run(mesh, expect)?;
    let mut preservation = Value::Null;
    if let Some(regions) = expect["preserve"]["changeRegions"].as_array() {
        let mut parent_id = revision["parentId"].as_str().map(str::to_owned);
        let mut seen = std::collections::HashSet::new();
        let mut reference = None;
        while let Some(id) = parent_id {
            if !seen.insert(id.clone()) {
                return Err(ContractError::validation(
                    "Revision ancestry contains a cycle",
                ));
            }
            let ancestor = require_revision(handle, &id)?;
            let stop = ancestor["id"] == artifact["selectedRevisionId"]
                || matches!(
                    ancestor["reviewState"].as_str(),
                    Some("approved" | "superseded")
                )
                || ancestor["parentId"].is_null();
            if stop {
                reference = Some(ancestor);
                break;
            }
            parent_id = ancestor["parentId"].as_str().map(str::to_owned);
        }
        if let Some(reference) = reference {
            let hash = reference["payload"]["stl"]["sha256"].as_str();
            if let Some(hash) = hash {
                match handle.object_store().map_err(storage_error)?.read(hash).ok().and_then(|bytes|mesh::Mesh::read(&bytes).ok()) {
                    Some(reference_mesh)=>{
                        let result=checks::preservation(&reference_mesh,mesh,&json!(regions))?;
                        lines.push(result);
                        preservation=json!({"revisionId":reference["id"],
                            "inputFingerprint":reference["payload"]["renderIdentity"]["inputFingerprint"],"outputHash":hash});
                    }
                    None=>lines.push(json!({"name":"unrelated geometry preserved","pass":false,
                        "detail":"Reference revision has no readable mesh; preservation cannot be established."})),
                }
            } else {
                lines.push(json!({"name":"unrelated geometry preserved","pass":false,
                "detail":"Reference revision has no STL mesh; preservation cannot be established."}));
            }
        } else {
            lines.push(json!({"name":"unrelated geometry preserved","pass":false,
            "detail":"No prior baseline/reference revision exists; preservation cannot be established for a new part."}));
        }
    }
    if mesh.inverted {
        lines.push(json!({"name":"source winding","pass":false,"detail":"OpenSCAD source produces an inside-out mesh; repair source winding before verification."}));
    }
    let passed = lines.iter().filter(|c| c["pass"] == true).count();
    let pass = !lines.is_empty() && passed == lines.len();
    let integrity =
        mesh.watertight && !mesh.inverted && mesh.volume > 0.0 && !mesh.triangles.is_empty();
    let exploratory = input["exploratory"] == true
        || !overrides.as_object().is_none_or(serde_json::Map::is_empty);
    let mut changes = std::collections::BTreeSet::<String>::new();
    let history = job_history(handle, required_str(&artifact, "id")?)?;
    let mut prior_hashes = Vec::<String>::new();
    let mut prior_failures = std::collections::BTreeSet::<String>::new();
    let accepted = accepted_scope(handle, required_str(&artifact, "id")?)?;
    if accepted["expect"].is_object() {
        if let Some(hash) = accepted["specHash"].as_str() {
            prior_hashes.push(hash.to_owned());
        }
        for key in scope_changes(&accepted["expect"], expect) {
            changes.insert(key);
        }
    }
    for (recorded, outputs, log) in &history {
        if accepted["evidenceHash"].is_string()
            && outputs["verification"] == accepted["evidenceHash"]
        {
            break;
        }
        if recorded["exploratory"] == true {
            continue;
        }
        if let Some(previous) = recorded.get("expect") {
            let hash = spec_hash(previous);
            if !prior_hashes.contains(&hash) {
                prior_hashes.push(hash);
            }
            for key in scope_changes(previous, expect) {
                changes.insert(key);
            }
        }
        if recorded["revisionId"] == revision["id"] && recorded["params"] == input["params"] {
            for line in log.lines() {
                if let Some(name) = line
                    .strip_prefix("FAIL ")
                    .and_then(|l| l.split_once(" — ").map(|v| v.0))
                {
                    prior_failures.insert(name.to_owned());
                }
            }
        }
        let _ = outputs;
    }
    let names = lines
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect::<std::collections::HashSet<_>>();
    let dropped = prior_failures
        .into_iter()
        .filter(|n| !names.contains(n.as_str()))
        .collect::<Vec<_>>();
    if !dropped.is_empty() {
        changes.insert("dropped previously failing assertions".into());
    }
    let identity = render
        .identity
        .as_ref()
        .ok_or_else(|| ContractError::validation("Missing render identity"))?;
    let matching = render_matches(&revision)
        && overrides.as_object().is_none_or(serde_json::Map::is_empty)
        && revision["payload"]["renderIdentity"]["inputFingerprint"]
            == identity["inputFingerprint"]
        && revision["payload"]["renderIdentity"]["outputHash"] == identity["outputHash"];
    let status = if !pass || !integrity {
        "failed"
    } else if !matching {
        "unverified"
    } else if !changes.is_empty() {
        "scope_changed"
    } else if !explicit(expect) {
        "partial"
    } else {
        "passed"
    };
    let current_spec_hash = spec_hash(expect);
    let scope_changes = changes.into_iter().collect::<Vec<_>>();
    let evidence = json!({"version":1,"artifactId":artifact["id"],"revisionId":revision["id"],
        "inputFingerprint":identity["inputFingerprint"],"outputHash":identity["outputHash"],
        "specHash":current_spec_hash,"checkerVersion":CHECKER,"expect":expect,"checks":lines,"preservation":preservation,
        "integrity":{"pass":integrity,"detail":"Mandatory finite, nonempty, closed, positive-volume mesh with outward source winding."},
        "status":status,"pass":pass,"scopeChanges":scope_changes,"priorSpecHashes":prior_hashes,
        "exploratory":exploratory,"coverage":{"units":"mm","frame":"right-handed-z-up",
        "assertions":lines.iter().map(|c|c["name"].clone()).collect::<Vec<_>>(),
        "requirementAuthority":"agent_or_user_declared",
        "limitations":["Checks cover only declared assertions, not the complete engineering request.",
            "Mesh and sampled sections can miss unsampled defects.","Material, strength, fit and manufacturability are not assessed."]}});
    let bytes = serde_json::to_vec(&evidence).map_err(internal)?;
    let evidence_hash = handle
        .object_store()
        .map_err(storage_error)?
        .put(&bytes)
        .map_err(storage_error)?;
    let job_id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    let log = lines
        .iter()
        .map(|c| {
            format!(
                "{} {} — {}",
                if c["pass"] == true { "PASS" } else { "FAIL" },
                c["name"].as_str().unwrap_or("check"),
                c["detail"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    handle.db.execute("INSERT INTO job(id,kind,tool,tool_version,inputs,input_hashes,command,status,log,output_hashes,error,session_id,created_at,started_at,finished_at) VALUES(?1,'cad_check','omenflow-geometry',?2,?3,?4,NULL,?5,?6,?7,?8,?9,?10,?10,?10)",params![job_id,CHECKER,
        json!({"artifactId":artifact["id"],"revisionId":revision["id"],"params":input["params"].as_object().map(|_|input["params"].clone()).unwrap_or(json!({})),"expect":expect,"exploratory":exploratory,
            "results":lines.iter().map(|c|json!({"name":c["name"],"pass":c["pass"],"tightness":c["tightness"]})).collect::<Vec<_>>()}).to_string(),
        json!({"stl":identity["outputHash"]}).to_string(),if pass {"succeeded"}else{"failed"},log,
        json!({"verification":evidence_hash}).to_string(),if pass {None}else{Some(json!({"code":"VALIDATION","message":format!("{} of {} checks failed",lines.len()-passed,lines.len())}).to_string())},origin.session_id(),timestamp]).map_err(internal)?;
    let next_action = match status {
        "failed" => "repair_geometry",
        "unverified" => "commit_matching_render",
        "scope_changed" => "restore_assertions",
        "partial" => "commit_assertions",
        "passed" => "request_review",
        _ => "none",
    };
    let prior_work: Value = handle
        .db
        .query_row(
            "SELECT value FROM meta WHERE key='work.active'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(internal)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null);
    let bound = if prior_work["artifactId"] == artifact["id"]
        && prior_work["expect"].is_object()
        && !scope_changes.is_empty()
    {
        prior_work["expect"].clone()
    } else {
        expect.clone()
    };
    let work = json!({"version":1,"artifactId":artifact["id"],"baselineRevisionId":artifact["selectedRevisionId"],
        "candidateRevisionId":revision["id"],"requestRevisionId":prior_work["requestRevisionId"],
        "specHash":spec_hash(&bound),"expect":bound,"nextAction":if exploratory {"commit_assertions"} else {next_action},"updatedAt":timestamp});
    handle.db.execute("INSERT INTO meta(key,value) VALUES('work.active',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[work.to_string()]).map_err(internal)?;
    Ok(
        json!({"artifactId":artifact["id"],"revisionId":revision["id"],"pass":pass,"passed":passed,"total":lines.len(),
        "ready":!exploratory&&status=="passed","verificationStatus":status,"evidenceHash":evidence_hash,"specHash":current_spec_hash,
        "scopeChanges":scope_changes,"checks":lines,"droppedFailingAssertions":dropped,"exploratory":exploratory,
        "work":{"artifactId":artifact["id"],"candidateRevisionId":revision["id"],"specHash":work["specHash"],"nextAction":work["nextAction"]},
        "next":if exploratory {"Exploratory diagnostic only. Commit full request assertions without a parameter variant."}else if status=="passed" {"Declared assertions and mandatory integrity pass for this exact revision. Human approval remains separate."}else{"NOT VERIFIED: repair geometry or restore the committed assertion scope before claiming completion."}}),
    )
}
