//! Read-only release preview. Every unresolved condition is carried into an
//! exported package; a package is never silently labeled as production ready.
//! Each condition names what is missing and how to repair it.
use super::*;
use std::collections::BTreeMap;
use std::io::Write;
use zip::write::SimpleFileOptions;

/// One thing that keeps an artifact out of a baseline package.
struct Issue {
    code: &'static str,
    /// The condition, in the wording the package manifest has always used.
    message: String,
    /// What the package lacks because of it.
    missing: String,
    repair: String,
}

impl Issue {
    fn new(
        code: &'static str,
        message: impl Into<String>,
        missing: impl Into<String>,
        repair: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            missing: missing.into(),
            repair: repair.into(),
        }
    }

    fn detail(&self) -> Value {
        json!({"code": self.code, "message": self.message, "missing": self.missing, "repair": self.repair})
    }
}

fn file_issues(
    handle: &ProjectHandle,
    title: &str,
    revision: &Value,
    issues: &mut Vec<Issue>,
) -> CoreResult<()> {
    let objects = handle.object_store().map_err(storage_error)?;
    for file in revision["files"].as_array().into_iter().flatten() {
        let path = file["path"].as_str().unwrap_or("");
        let safe = resolve_materialization_path(&handle.root, path).is_ok();
        match file["sha256"].as_str() {
            None if safe => issues.push(Issue::new(
                "file_identity_missing",
                format!("missing immutable content identity: {path}"),
                format!("a content hash for {path}"),
                format!("Attach {path} to {title} again (artifact_import_file) so that it is stored with its hash."),
            )),
            Some(hash) if safe && objects.read(hash).is_ok() => {}
            _ => issues.push(Issue::new(
                "file_missing",
                format!("missing, corrupt or unsafe file {path}"),
                format!("the stored content of {path}"),
                format!("Attach {path} to {title} again (artifact_import_file); the stored copy is missing or damaged."),
            )),
        }
    }
    if revision["payload"]["fileHash"]
        .as_str()
        .is_some_and(|hash| objects.read(hash).is_err())
    {
        issues.push(Issue::new(
            "file_missing",
            "missing or corrupt source attachment",
            "the stored copy of the captured source file",
            format!("Capture the source file of {title} again (source_capture with filePath)."),
        ));
    }
    Ok(())
}

pub(super) fn preview(handle: &ProjectHandle, include_drafts: bool) -> CoreResult<Value> {
    let mut stmt = handle
        .db
        .prepare("SELECT * FROM artifact WHERE archived=0 ORDER BY created_at")
        .map_err(internal)?;
    let artifacts = stmt
        .query_map([], artifact_from_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    let mut items = Vec::new();
    let mut no_baseline = 0;
    for artifact in artifacts {
        let id = required_str(&artifact, "id")?;
        let title = artifact["title"].as_str().unwrap_or(id);
        let selected = artifact["selectedRevisionId"].as_str();
        let revision = if let Some(id) = selected {
            get_revision(handle, id)?
        } else if include_drafts {
            handle.db.query_row("SELECT * FROM revision WHERE artifact_id=?1 AND review_state NOT IN ('rejected','superseded') ORDER BY seq DESC LIMIT 1", [id], revision_from_row).optional().map_err(internal)?
        } else {
            None
        };
        let mut issues = Vec::<Issue>::new();
        if selected.is_none() {
            no_baseline += 1;
            issues.push(Issue::new(
                "no_baseline",
                "no baseline revision",
                "an approved revision",
                format!("Have a revision of {title} approved (proposal_submit, then the human approves it), or export with includeDrafts for a package labelled DRAFT."),
            ));
        }
        let view = artifact_view(handle, &artifact)?;
        if view["freshness"] != "current" {
            let reasons = view["staleReasons"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item["reason"].as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let freshness = view["freshness"].as_str().unwrap_or("stale");
            issues.push(if freshness == "missing_input" {
                Issue::new(
                    "missing_input",
                    format!("{freshness}: {reasons}"),
                    "an input that still exists with an approved revision",
                    format!("An input of {title} was archived or lost its approved revision: restore it or point {title} at its replacement, then have that revision approved."),
                )
            } else {
                Issue::new(
                    "stale",
                    format!("{freshness}: {reasons}"),
                    "a revision made for the current approved inputs",
                    format!("Update {title} for its changed inputs (graph_neighbors lists them) and have the new revision approved."),
                )
            });
        }
        let mut verification = Value::Null;
        let mut notices = Vec::<String>::new();
        if let Some(revision) = &revision {
            file_issues(handle, title, revision, &mut issues)?;
            if artifact["type"] == "mechanical" {
                // Evidence that cannot be read is an issue of this part, not
                // a reason to fail the whole preview.
                match cad::latest_verification(handle, revision) {
                    Ok(found) => {
                        if found["status"] != "passed" {
                            let status = found["status"].as_str().unwrap_or("unverified");
                            issues.push(Issue::new(
                                "cad_unverified",
                                format!("CAD verification: {status}"),
                                "a committed CAD verification that passed for this revision",
                                format!("Run cad_check on {title} with its expectations until it passes and is committed."),
                            ));
                        }
                        // Requirements linked or changed after the committed
                        // check are named; they do not hold the export.
                        let since = found["spec"]["linkedSince"]
                            .as_array()
                            .map(Vec::as_slice)
                            .unwrap_or(&[]);
                        if !since.is_empty() {
                            notices.push(format!(
                                "The committed check of {title} does not show {} as {} now.",
                                cad::requirements(since),
                                if since.len() == 1 {
                                    "it stands"
                                } else {
                                    "they stand"
                                }
                            ));
                        }
                        verification = found;
                    }
                    Err(_) => {
                        verification = json!({"status": "unverified"});
                        issues.push(Issue::new(
                            "cad_evidence_invalid",
                            "CAD render or verification evidence is invalid",
                            "readable render and verification evidence",
                            format!("Render and check {title} again (cad_check)."),
                        ));
                    }
                }
            }
            if artifact["type"] == "assumption" && revision["payload"]["needsValidation"] == true {
                issues.push(Issue::new(
                    "assumption_unresolved",
                    "unresolved assumption",
                    "validation of the assumption",
                    format!("Validate {title}, record it with needsValidation false and have that revision approved."),
                ));
            }
        }
        if view["pendingProposal"] == true {
            issues.push(Issue::new(
                "pending_proposal",
                "pending proposal",
                "a decision on its pending proposal",
                format!("Approve, reject or request changes on the pending proposal for {title}."),
            ));
        }
        let mut item = json!({
            "artifactId": id, "title": artifact["title"], "type": artifact["type"],
            "revisionId": revision.as_ref().map(|r| r["id"].clone()),
            "state": revision.as_ref().map(|r| r["reviewState"].clone()).unwrap_or(json!("none")),
            "verification": verification,
            "issues": issues.iter().map(|issue| issue.message.clone()).collect::<Vec<_>>(),
            "issueDetails": issues.iter().map(Issue::detail).collect::<Vec<_>>(),
        });
        if !notices.is_empty() {
            item["notices"] = json!(notices);
        }
        items.push(item);
    }
    let with_issues = items.iter().filter(|item| has_issues(item)).count();
    Ok(
        json!({"items": items, "ready": with_issues == 0, "counts": {"artifacts": items.len(), "ready": items.len()-with_issues, "withIssues": with_issues, "noBaseline": no_baseline}}),
    )
}

fn has_issues(item: &Value) -> bool {
    item["issues"]
        .as_array()
        .is_some_and(|issues| !issues.is_empty())
}

/// Versions of the tools that produced recorded outputs, oldest first.
fn tool_versions(handle: &ProjectHandle) -> CoreResult<Vec<Value>> {
    let mut stmt = handle
        .db
        .prepare("SELECT tool,tool_version FROM job WHERE tool_version IS NOT NULL GROUP BY tool,tool_version ORDER BY MIN(created_at),tool,tool_version")
        .map_err(internal)?;
    let versions = stmt
        .query_map([], |row| {
            Ok(json!({"tool": row.get::<_, String>(0)?, "version": row.get::<_, String>(1)?}))
        })
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(versions)
}

fn document_identity(artifact: &Value) -> String {
    format!(
        "Artifact: `{}` · Revision: `{}` · State: **{}** · {}",
        artifact["artifactId"].as_str().unwrap_or(""),
        artifact["revisionId"].as_str().unwrap_or(""),
        artifact["state"].as_str().unwrap_or("unknown"),
        if artifact["selected"] == true {
            "Selected baseline"
        } else {
            "**DRAFT — not selected as baseline**"
        }
    )
}

/// Generated documents describe the same immutable revisions as the manifest.
fn documents(manifest: &Value, files: &mut BTreeMap<String, Vec<u8>>) -> CoreResult<()> {
    let package_note = if manifest["status"] == "draft" {
        "> DRAFT package — unresolved issues are recorded in manifest.json.\n\n"
    } else {
        "> BASELINE package — approval and engineering validity are separate.\n\n"
    };
    let mut assemblies = Vec::new();
    let mut assumptions = Vec::new();
    let mut wirings = Vec::new();
    for artifact in manifest["artifacts"].as_array().into_iter().flatten() {
        let title = artifact["title"].as_str().unwrap_or("Untitled");
        let identity = document_identity(artifact);
        let payload = &artifact["payload"];
        match artifact["type"].as_str() {
            Some("assembly") => {
                let mut text = format!("## {title}\n\n{identity}\n\n");
                for step in payload["steps"].as_array().into_iter().flatten() {
                    text.push_str(&format!(
                        "{}. {}\n",
                        step["order"],
                        step["instruction"]
                            .as_str()
                            .unwrap_or("")
                            .replace('\n', "\n   ")
                    ));
                    let names = |field: &str| {
                        step[field]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    };
                    for (label, field) in [("Components", "componentRefs"), ("Tools", "tools")] {
                        let values = names(field);
                        if !values.is_empty() {
                            text.push_str(&format!("\n   {label}: {values}\n"));
                        }
                    }
                    if let Some(calibration) = step["calibration"].as_str() {
                        text.push_str(&format!(
                            "\n   Calibration: {}\n",
                            calibration.replace('\n', "\n   ")
                        ));
                    }
                    text.push('\n');
                }
                assemblies.push(text);
            }
            Some("assumption") => {
                let validation = payload["needsValidation"]
                    .as_bool()
                    .map(|needed| if needed { "yes" } else { "no" })
                    .unwrap_or("not recorded");
                assumptions.push(format!("## {title}\n\n{identity}\n\n{}\n\nReason: {}\n\nOwner: {}\n\nValidation required: {validation}\n",
                    payload["statement"].as_str().unwrap_or(""),
                    payload["reason"].as_str().unwrap_or("not recorded"),
                    payload["owner"].as_str().unwrap_or("not recorded")));
            }
            Some("wiring") => {
                let id = required_str(artifact, "artifactId")?;
                let path = format!("docs/wiring/{id}.json");
                files.insert(path, serde_json::to_vec_pretty(artifact).map_err(internal)?);
                wirings.push(format!(
                    "## {title}\n\n{identity}\n\n[Recorded wiring](wiring/{id}.json)\n"
                ));
                // Preserve the original single-wiring payload entry point. The index names
                // every wiring artifact and each separate file carries its revision/state.
                if !files.contains_key("docs/wiring.json") {
                    files.insert(
                        "docs/wiring.json".into(),
                        serde_json::to_vec_pretty(payload).map_err(internal)?,
                    );
                }
            }
            _ => {}
        }
    }
    for (heading, path, sections) in [
        ("Assembly", "docs/ASSEMBLY.md", assemblies),
        ("Wiring", "docs/WIRING.md", wirings),
        ("Assumptions", "docs/ASSUMPTIONS.md", assumptions),
    ] {
        if heading != "Assumptions" && sections.is_empty() {
            continue;
        }
        files.insert(
            path.into(),
            format!("# {heading}\n\n{package_note}{}\n", sections.join("\n")).into_bytes(),
        );
    }
    Ok(())
}

pub(super) fn export(handle: &ProjectHandle, input: &Value, origin: &Origin) -> CoreResult<Value> {
    let destination = required_str(input, "destPath")?;
    let dest = match components::export_target(handle, destination, origin, "exports/build.zip")? {
        Some(relative) => {
            resolve_materialization_path(&handle.root, &relative).map_err(storage_error)?
        }
        None => PathBuf::from(destination),
    };
    let include_drafts = input["includeDrafts"].as_bool().unwrap_or(false);
    let preview = preview(handle, include_drafts)?;
    let items = preview["items"]
        .as_array()
        .ok_or_else(|| ContractError::new("INTERNAL", "Invalid build preview"))?;
    let unresolved = items
        .iter()
        .filter(|item| has_issues(item))
        .collect::<Vec<_>>();
    let issue_count: usize = unresolved
        .iter()
        .map(|item| item["issues"].as_array().map(Vec::len).unwrap_or(0))
        .sum();
    let status = if issue_count == 0 {
        "baseline"
    } else {
        "draft"
    };
    if status == "draft" && !include_drafts {
        let artifacts = unresolved
            .iter()
            .map(|item| json!({"artifactId": item["artifactId"], "title": item["title"], "type": item["type"], "revisionId": item["revisionId"], "issues": item["issueDetails"]}))
            .collect::<Vec<_>>();
        return Err(ContractError::validation(format!(
            "Build has {issue_count} unresolved issue(s) in {} artifact(s)",
            unresolved.len()
        ))
        .with_repair("Resolve each issue (details.artifacts lists what is missing and the repair for each), or export with includeDrafts true for a package labelled DRAFT.")
        .with_details(json!({"artifacts": artifacts, "counts": preview["counts"]})));
    }
    let project = handle
        .project()
        .map_err(storage_error)?
        .ok_or_else(|| ContractError::new("NOT_FOUND", "Project metadata missing"))?;
    let mut manifest = json!({
        "format": "omenflow-build-package", "schemaVersion": 1,
        "project": {"id": project["id"], "name": project["name"], "intent": project["intent"]},
        "status": status,
        "verificationScope": "Checks establish only their declared geometric assertions. Human approval and physical/manufacturing validity are separate.",
        "label": input["label"].as_str().unwrap_or(if status == "baseline" { "BASELINE" } else { "DRAFT" }),
        "exportedAt": now(), "exportedBy": origin.kind(),
        "artifacts": [], "sources": [], "toolVersions": tool_versions(handle)?,
        "issues": unresolved,
    });
    let objects = handle.object_store().map_err(storage_error)?;
    let mut files = BTreeMap::<String, Vec<u8>>::new();
    for item in items {
        let Some(revision_id) = item["revisionId"].as_str() else {
            continue;
        };
        let artifact = require_artifact(handle, required_str(item, "artifactId")?)?;
        let revision = require_revision(handle, revision_id)?;
        manifest["artifacts"].as_array_mut().unwrap().push(json!({
            "artifactId": artifact["id"], "revisionId": revision["id"],
            "type": artifact["type"], "title": artifact["title"],
            "contentHash": revision["contentHash"], "state": revision["reviewState"],
            "selected": artifact["selectedRevisionId"] == revision["id"],
            "payload": revision["payload"], "files": revision["files"],
            "inputs": revision["inputs"], "verification": item["verification"],
            "issues": item["issues"],
        }));
        // A file that cannot be read is already listed as an issue of its
        // artifact, so a draft package states the gap instead of failing.
        for file in revision["files"].as_array().into_iter().flatten() {
            let (Some(path), Some(hash)) = (file["path"].as_str(), file["sha256"].as_str()) else {
                continue;
            };
            if resolve_materialization_path(&handle.root, path).is_err() {
                continue;
            }
            if let Ok(bytes) = objects.read(hash) {
                files.insert(format!("files/{path}"), bytes);
            }
        }
        if artifact["type"] == "source" {
            let source = &revision["payload"];
            if let Some(hash) = source["fileHash"].as_str() {
                if let Ok(bytes) = objects.read(hash) {
                    files.insert(format!("attachments/{hash}"), bytes);
                }
            }
            manifest["sources"].as_array_mut().unwrap().push(json!({
                "url": source["url"], "retrievedAt": source["retrievedAt"],
                "title": source["title"], "fileHash": source["fileHash"],
            }));
        }
    }
    files.insert(
        "docs/BOM.md".into(),
        components::bom_text(handle, "markdown")?.into_bytes(),
    );
    files.insert(
        "docs/BOM.csv".into(),
        components::bom_text(handle, "csv")?.into_bytes(),
    );
    documents(&manifest, &mut files)?;
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec_pretty(&manifest).map_err(internal)?,
    );
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(internal)?;
    }
    let temp = dest.with_extension(format!("bureau-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> CoreResult<()> {
        let output = fs::File::create(&temp).map_err(internal)?;
        let mut zip = zip::ZipWriter::new(output);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (path, bytes) in &files {
            zip.start_file(path, options).map_err(internal)?;
            zip.write_all(bytes).map_err(internal)?;
        }
        zip.finish().map_err(internal)?;
        fs::rename(&temp, &dest).map_err(internal)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    emit(
        handle,
        "build.exported",
        origin,
        json!({"destPath": dest, "status": status, "files": files.len()}),
    )?;
    Ok(json!({"path": dest, "files": files.len(), "status": status, "issues": issue_count}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Bench;
    use std::io::Read;

    fn draft(bench: &mut Bench, kind: &str, title: &str, payload: Value) -> Value {
        bench
            .user(
                "artifact.create_draft",
                json!({"type": kind, "title": title, "payload": payload}),
            )
            .unwrap()
    }

    fn approved(bench: &mut Bench, kind: &str, title: &str, payload: Value) -> Value {
        let created = draft(bench, kind, title, payload);
        bench.accept(&created);
        created
    }

    fn manifest(path: &Path) -> (Value, Vec<String>) {
        let mut archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        let names = archive.file_names().map(str::to_owned).collect::<Vec<_>>();
        let mut text = String::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        (serde_json::from_str(&text).unwrap(), names)
    }

    fn document(path: &Path, name: &str) -> String {
        let mut archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        let mut text = String::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text
    }

    #[test]
    fn generated_documents_include_every_exported_revision_and_all_assembly_fields() {
        let mut bench = Bench::new();
        let part = approved(
            &mut bench,
            "note",
            "Part record",
            json!({"markdown":"part reference"}),
        );
        let first = approved(
            &mut bench,
            "assembly",
            "Chassis assembly",
            json!({"steps":[{
                "order":1,"instruction":"Install the axle.","componentRefs":[part["artifact"]["id"]],
                "tools":["2 mm hex key"],"calibration":"Set the gap to 0.2 mm."
            }]}),
        );
        bench
            .user(
                "artifact.update_draft",
                json!({"artifactId": first["artifact"]["id"],
            "payload":{"steps":[{"order":1,"instruction":"Unselected newer instructions."}]}}),
            )
            .unwrap();
        let second = draft(
            &mut bench,
            "assembly",
            "Sensor assembly",
            json!({"steps":[{
                "order":1,"instruction":"Align the sensor.","tools":["Square"],"calibration":"Zero the sensor."
            }]}),
        );
        let first_wiring = approved(
            &mut bench,
            "wiring",
            "Power harness",
            json!({"coverageNote":"Power wiring only"}),
        );
        let second_wiring = draft(
            &mut bench,
            "wiring",
            "Signal harness",
            json!({"coverageNote":"Signal wiring is a draft"}),
        );
        let assumption = draft(
            &mut bench,
            "assumption",
            "Surface friction",
            json!({
                "statement":"The floor is dry.","reason":"Indoor operation","owner":"Test team","needsValidation":true
            }),
        );
        let destination = bench.root().join("exports/documents.zip");
        bench
            .user(
                "build.export",
                json!({"destPath":destination,"includeDrafts":true}),
            )
            .unwrap();
        let (manifest, _) = manifest(&destination);
        let assembly = document(&destination, "docs/ASSEMBLY.md");
        for expected in [
            "DRAFT package",
            "Chassis assembly",
            "Install the axle.",
            "Sensor assembly",
            "Align the sensor.",
            "2 mm hex key",
            "Set the gap to 0.2 mm.",
            "Zero the sensor.",
            first["revision"]["id"].as_str().unwrap(),
            second["revision"]["id"].as_str().unwrap(),
            part["artifact"]["id"].as_str().unwrap(),
            "DRAFT — not selected as baseline",
        ] {
            assert!(
                assembly.contains(expected),
                "{expected} missing from {assembly}"
            );
        }
        assert!(!assembly.contains("Unselected newer instructions."));
        let assumptions = document(&destination, "docs/ASSUMPTIONS.md");
        for expected in [
            "The floor is dry.",
            "Indoor operation",
            "Test team",
            "Validation required: yes",
            assumption["revision"]["id"].as_str().unwrap(),
            "DRAFT — not selected as baseline",
        ] {
            assert!(
                assumptions.contains(expected),
                "{expected} missing from {assumptions}"
            );
        }
        let wiring = document(&destination, "docs/WIRING.md");
        assert!(wiring.contains("Power harness") && wiring.contains("Signal harness"));
        for source in [&first_wiring, &second_wiring] {
            let id = source["artifact"]["id"].as_str().unwrap();
            let recorded: Value =
                serde_json::from_str(&document(&destination, &format!("docs/wiring/{id}.json")))
                    .unwrap();
            let exported = manifest["artifacts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|artifact| artifact["artifactId"] == id)
                .unwrap();
            assert_eq!(&recorded, exported);
            assert!(wiring.contains(recorded["revisionId"].as_str().unwrap()));
        }
        let legacy: Value =
            serde_json::from_str(&document(&destination, "docs/wiring.json")).unwrap();
        assert_eq!(legacy, first_wiring["revision"]["payload"]);
    }

    /// A project with one of each thing that holds a build back.
    fn unfinished(bench: &mut Bench) {
        approved(bench, "note", "Design notes", json!({"markdown": "ready"}));
        draft(
            bench,
            "requirement",
            "Payload capacity",
            json!({"statement": "Carries 0.3 kg", "acceptanceCriterion": "Drives 5 m"}),
        );
        approved(
            bench,
            "assumption",
            "Floor friction",
            json!({"statement": "mu is 0.6", "reason": "typical rubber on wood", "owner": "team"}),
        );
        approved(
            bench,
            "mechanical",
            "Camera tray",
            json!({"modelUnit": "mm"}),
        );
        let endurance = approved(
            bench,
            "requirement",
            "Endurance",
            json!({"statement": "Runs 30 min", "acceptanceCriterion": "30 min on one charge"}),
        );
        let energy = bench
            .user(
                "calculation.run",
                json!({"title": "Usable pack energy", "templateId": "battery_energy", "submitForReview": false, "inputs": [
                    {"name": "voltage", "quantity": {"value": 7.4, "unit": "V"}, "sourceRef": {"artifactId": endurance["artifact"]["id"], "revisionId": endurance["revision"]["id"]}},
                    {"name": "capacity", "quantity": {"value": 450, "unit": "mAh"}},
                    {"name": "usable_fraction", "quantity": {"value": 0.8, "unit": "1"}},
                ]}),
            )
            .unwrap();
        bench
            .user(
                "artifact.accept_draft",
                json!({"artifactId": energy["artifactId"], "draftRevisionId": energy["revision"]["id"]}),
            )
            .unwrap();
        // The requirement the calculation cites changes.
        bench
            .user(
                "artifact.apply_edit",
                json!({"artifactId": endurance["artifact"]["id"], "baseRevisionId": endurance["revision"]["id"], "payloadPatch": {"statement": "Runs 45 min"}, "rationale": "longer runs"}),
            )
            .unwrap();
        let datasheet = bench
            .user(
                "artifact.create_draft",
                json!({"type": "note", "title": "Datasheet copy", "payload": {"markdown": "see file"}, "files": [{"path": "docs/datasheet.txt", "contentBase64": "ZGF0YXNoZWV0"}]}),
            )
            .unwrap();
        bench.accept(&datasheet);
        let hash = datasheet["revision"]["files"][0]["sha256"]
            .as_str()
            .unwrap();
        fs::remove_file(
            bench
                .root()
                .join(".bureau/objects")
                .join(&hash[..2])
                .join(hash),
        )
        .unwrap();
        // A change to an approved artifact waits for a decision.
        let plan = approved(bench, "note", "Test plan", json!({"markdown": "v1"}));
        let revised = bench
            .agent(
                "artifact.update_draft",
                json!({"artifactId": plan["artifact"]["id"], "payload": {"markdown": "v2"}}),
            )
            .unwrap();
        bench
            .agent(
                "proposal.submit",
                json!({"changes": [{"artifactId": plan["artifact"]["id"], "baseRevisionId": plan["revision"]["id"], "newRevisionId": revised["revision"]["id"], "kind": "baseline_update"}], "reason": "clearer plan"}),
            )
            .unwrap();
    }

    #[test]
    fn a_refused_export_lists_every_issue_with_what_is_missing_and_its_repair() {
        let mut bench = Bench::new();
        unfinished(&mut bench);
        let destination = bench.root().join("exports/build.zip");
        let refused = bench
            .user("build.export", json!({"destPath": destination}))
            .unwrap_err();
        assert_eq!(refused.code, "VALIDATION");
        assert_eq!(
            refused.message,
            "Build has 6 unresolved issue(s) in 6 artifact(s)"
        );
        assert!(refused
            .repair
            .as_deref()
            .unwrap()
            .contains("includeDrafts true"));
        assert!(!destination.exists());
        let details = refused.details.unwrap();
        let listed = details["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|artifact| {
                let issue = &artifact["issues"][0];
                assert_eq!(artifact["issues"].as_array().unwrap().len(), 1);
                assert!(artifact["artifactId"].is_string());
                (
                    artifact["title"].as_str().unwrap().to_owned(),
                    issue["code"].as_str().unwrap().to_owned(),
                    issue["message"].as_str().unwrap().to_owned(),
                    issue["missing"].as_str().unwrap().to_owned(),
                    issue["repair"].as_str().unwrap().to_owned(),
                )
            })
            .collect::<Vec<_>>();
        let expected = [
            ("Payload capacity", "no_baseline", "no baseline revision", "an approved revision", "Have a revision of Payload capacity approved (proposal_submit, then the human approves it), or export with includeDrafts for a package labelled DRAFT."),
            ("Floor friction", "assumption_unresolved", "unresolved assumption", "validation of the assumption", "Validate Floor friction, record it with needsValidation false and have that revision approved."),
            ("Camera tray", "cad_unverified", "CAD verification: unverified", "a committed CAD verification that passed for this revision", "Run cad_check on Camera tray with its expectations until it passes and is committed."),
            ("Usable pack energy", "stale", "stale: input_changed", "a revision made for the current approved inputs", "Update Usable pack energy for its changed inputs (graph_neighbors lists them) and have the new revision approved."),
            ("Datasheet copy", "file_missing", "missing, corrupt or unsafe file docs/datasheet.txt", "the stored content of docs/datasheet.txt", "Attach docs/datasheet.txt to Datasheet copy again (artifact_import_file); the stored copy is missing or damaged."),
            ("Test plan", "pending_proposal", "pending proposal", "a decision on its pending proposal", "Approve, reject or request changes on the pending proposal for Test plan."),
        ]
        .map(|(title, code, message, missing, repair)| {
            (title.to_owned(), code.to_owned(), message.to_owned(), missing.to_owned(), repair.to_owned())
        });
        assert_eq!(listed, expected);
        assert_eq!(
            details["counts"],
            json!({"artifacts": 8, "ready": 2, "withIssues": 6, "noBaseline": 1})
        );
        // The preview says the same before anyone picks a destination.
        let preview = bench.user("build.preview", json!({})).unwrap();
        assert_eq!(preview["ready"], false);
        assert_eq!(preview["counts"], details["counts"]);
        assert_eq!(preview["items"][0]["issues"], json!([]));
        assert_eq!(
            preview["items"][1]["issues"],
            json!(["no baseline revision"])
        );
        assert_eq!(
            preview["items"][1]["issueDetails"][0]["code"],
            "no_baseline"
        );
    }

    #[test]
    fn a_draft_package_is_labelled_and_records_its_issues_and_tool_versions() {
        let mut bench = Bench::new();
        unfinished(&mut bench);
        let destination = bench.root().join("exports/build.zip");
        let exported = bench
            .user(
                "build.export",
                json!({"destPath": destination, "includeDrafts": true}),
            )
            .unwrap();
        assert_eq!(exported["status"], "draft");
        assert_eq!(exported["issues"], 6);
        let (manifest, names) = manifest(&destination);
        assert_eq!(manifest["status"], "draft");
        assert_eq!(manifest["label"], "DRAFT");
        assert_eq!(manifest["issues"].as_array().unwrap().len(), 6);
        assert_eq!(
            manifest["issues"][0]["issueDetails"][0]["code"],
            "no_baseline"
        );
        // The calculation engine that produced the recorded result is named with its version.
        assert_eq!(
            manifest["toolVersions"],
            json!([{"tool": "calc", "version": "bureau-calc/2"}])
        );
        // Drafts are included and marked as not selected.
        let payload = manifest["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|artifact| artifact["title"] == "Payload capacity")
            .unwrap();
        assert_eq!(payload["selected"], false);
        assert_eq!(payload["state"], "draft");
        // The unreadable file is stated as an issue and left out, not a reason to fail.
        assert!(!names.iter().any(|name| name == "files/docs/datasheet.txt"));
        for name in [
            "manifest.json",
            "docs/BOM.md",
            "docs/BOM.csv",
            "docs/ASSUMPTIONS.md",
        ] {
            assert!(
                names.iter().any(|known| known == name),
                "{name} missing from {names:?}"
            );
        }
        assert_eq!(exported["files"], names.len());
        let events = bench.events("build.exported");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["data"]["status"], "draft");
    }

    #[test]
    fn a_project_with_nothing_unresolved_exports_a_baseline_package() {
        let mut bench = Bench::new();
        approved(
            &mut bench,
            "note",
            "Design notes",
            json!({"markdown": "ready"}),
        );
        let with_file = bench
            .user(
                "artifact.create_draft",
                json!({"type": "note", "title": "Datasheet copy", "payload": {"markdown": "see file"}, "files": [{"path": "docs/datasheet.txt", "contentBase64": "ZGF0YXNoZWV0"}]}),
            )
            .unwrap();
        bench.accept(&with_file);
        let preview = bench.user("build.preview", json!({})).unwrap();
        assert_eq!(preview["ready"], true);
        assert_eq!(
            preview["counts"],
            json!({"artifacts": 2, "ready": 2, "withIssues": 0, "noBaseline": 0})
        );
        let exported = bench
            .agent(
                "build.export",
                json!({"destPath": "exports/build.zip", "label": "Rev A"}),
            )
            .unwrap();
        assert_eq!(exported["status"], "baseline");
        assert_eq!(exported["issues"], 0);
        let (manifest, names) = manifest(&bench.root().join("exports/build.zip"));
        assert_eq!(manifest["status"], "baseline");
        assert_eq!(manifest["label"], "Rev A");
        assert_eq!(manifest["exportedBy"], "agent");
        assert_eq!(manifest["issues"], json!([]));
        assert_eq!(manifest["toolVersions"], json!([]));
        assert!(names.iter().any(|name| name == "files/docs/datasheet.txt"));
    }

    /// An agent writes a package inside the project only, as a BOM export
    /// does; a person may choose any path.
    #[test]
    fn an_agent_cannot_export_a_package_outside_the_project() {
        let mut bench = Bench::new();
        approved(&mut bench, "note", "Notes", json!({"markdown": "ready"}));
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("important.txt");
        fs::write(&victim, "user data").unwrap();
        for (op, input) in [
            (
                "build.export",
                json!({"destPath": victim, "includeDrafts": true}),
            ),
            ("bom.export", json!({"destPath": victim, "format": "csv"})),
        ] {
            let refused = bench.agent(op, input).unwrap_err();
            assert_eq!(refused.code, "PATH_OUTSIDE_PROJECT", "{op}");
        }
        assert_eq!(fs::read_to_string(&victim).unwrap(), "user data");
        assert!(bench.events("build.exported").is_empty());

        // Inside the project an absolute path is accepted.
        let inside = bench.root().join("exports/package.zip");
        bench
            .agent("build.export", json!({"destPath": inside}))
            .unwrap();
        assert!(inside.exists());
        let chosen = outside.path().join("package.zip");
        let by_hand = bench
            .user("build.export", json!({"destPath": chosen}))
            .unwrap();
        assert_eq!(by_hand["path"], json!(chosen));
        assert!(chosen.exists());
    }
}
