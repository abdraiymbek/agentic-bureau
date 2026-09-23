//! Read-only release preview. Every unresolved condition is carried into an
//! exported package; a package is never silently labeled as production ready.
use super::*;
use std::collections::BTreeMap;
use std::io::Write;
use zip::write::SimpleFileOptions;

pub(super) fn preview(handle: &ProjectHandle, include_drafts: bool) -> CoreResult<Value> {
    let objects = handle.object_store().map_err(storage_error)?;
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
        let selected = artifact["selectedRevisionId"].as_str();
        if selected.is_none() {
            no_baseline += 1;
        }
        let revision = if let Some(id) = selected {
            get_revision(handle, id)?
        } else if include_drafts {
            handle.db.query_row("SELECT * FROM revision WHERE artifact_id=?1 AND review_state NOT IN ('rejected','superseded') ORDER BY seq DESC LIMIT 1", [id], revision_from_row).optional().map_err(internal)?
        } else {
            None
        };
        let mut issues = Vec::<String>::new();
        if selected.is_none() {
            issues.push("no baseline revision".into());
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
            issues.push(format!(
                "{}: {}",
                view["freshness"].as_str().unwrap_or("stale"),
                reasons
            ));
        }
        let mut verification = Value::Null;
        if let Some(revision) = &revision {
            for file in revision["files"].as_array().into_iter().flatten() {
                let path = file["path"].as_str().unwrap_or("");
                let valid = resolve_materialization_path(&handle.root, path).is_ok()
                    && file["sha256"]
                        .as_str()
                        .is_some_and(|hash| objects.read(hash).is_ok());
                if !valid {
                    issues.push(format!("missing, corrupt or unsafe file {path}"));
                }
            }
            if artifact["type"] == "mechanical" {
                // The verification data is consumed only after validating its
                // render identity and checker version in the CAD module.
                verification = json!({"status": "unverified"});
                issues.push("CAD verification: unverified".into());
            }
            if artifact["type"] == "assumption" && revision["payload"]["needsValidation"] == true {
                issues.push("unresolved assumption".into());
            }
        }
        if view["pendingProposal"] == true {
            issues.push("pending proposal".into());
        }
        items.push(json!({
            "artifactId": id, "title": artifact["title"], "type": artifact["type"],
            "revisionId": revision.as_ref().map(|r| r["id"].clone()),
            "state": revision.as_ref().map(|r| r["reviewState"].clone()).unwrap_or(json!("none")),
            "verification": verification, "issues": issues,
        }));
    }
    let with_issues = items
        .iter()
        .filter(|item| {
            item["issues"]
                .as_array()
                .is_some_and(|issues| !issues.is_empty())
        })
        .count();
    Ok(
        json!({"items": items, "counts": {"artifacts": items.len(), "ready": items.len()-with_issues, "withIssues": with_issues, "noBaseline": no_baseline}}),
    )
}

pub(super) fn export(handle: &ProjectHandle, input: &Value, origin: &Origin) -> CoreResult<Value> {
    let include_drafts = input["includeDrafts"].as_bool().unwrap_or(false);
    let preview = preview(handle, include_drafts)?;
    let items = preview["items"]
        .as_array()
        .ok_or_else(|| ContractError::new("INTERNAL", "Invalid build preview"))?;
    let issue_count: usize = items
        .iter()
        .map(|item| item["issues"].as_array().map(Vec::len).unwrap_or(0))
        .sum();
    let status = if issue_count == 0 {
        "baseline"
    } else {
        "draft"
    };
    if status == "draft" && !include_drafts {
        return Err(ContractError::validation(format!(
            "Build has {issue_count} unresolved issue(s)"
        )));
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
        "artifacts": [], "sources": [], "toolVersions": [],
        "issues": items.iter().filter(|item| item["issues"].as_array().is_some_and(|issues| !issues.is_empty())).cloned().collect::<Vec<_>>(),
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
        for file in revision["files"].as_array().into_iter().flatten() {
            let Some(path) = file["path"].as_str() else {
                continue;
            };
            let Some(hash) = file["sha256"].as_str() else {
                continue;
            };
            resolve_materialization_path(&handle.root, path).map_err(storage_error)?;
            let bytes = objects.read(hash).map_err(storage_error)?;
            files.insert(format!("files/{path}"), bytes);
        }
        if artifact["type"] == "source" {
            let source = &revision["payload"];
            if let Some(hash) = source["fileHash"].as_str() {
                files.insert(
                    format!("attachments/{hash}"),
                    objects.read(hash).map_err(storage_error)?,
                );
            }
            manifest["sources"].as_array_mut().unwrap().push(json!({
                "url": source["url"], "retrievedAt": source["retrievedAt"],
                "title": source["title"], "fileHash": source["fileHash"],
            }));
        }
    }
    files.insert(
        "docs/BOM.md".into(),
        components::bom_export(handle, &json!({"format":"markdown"}))?["content"]
            .as_str()
            .unwrap_or("")
            .as_bytes()
            .to_vec(),
    );
    files.insert(
        "docs/BOM.csv".into(),
        components::bom_export(handle, &json!({"format":"csv"}))?["content"]
            .as_str()
            .unwrap_or("")
            .as_bytes()
            .to_vec(),
    );
    for (artifact_type, file_name) in [
        ("assembly", "docs/ASSEMBLY.md"),
        ("wiring", "docs/wiring.json"),
    ] {
        let maybe_id: Option<String> = handle.db.query_row("SELECT selected_revision_id FROM artifact WHERE type=?1 AND archived=0 AND selected_revision_id IS NOT NULL ORDER BY created_at LIMIT 1", [artifact_type], |row| row.get(0)).optional().map_err(internal)?;
        if let Some(id) = maybe_id {
            let rev = require_revision(handle, &id)?;
            let content = if artifact_type == "wiring" {
                serde_json::to_string_pretty(&rev["payload"]).map_err(internal)?
            } else {
                let steps = rev["payload"]["steps"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|step| {
                        format!(
                            "{}. {}",
                            step["order"],
                            step["instruction"].as_str().unwrap_or("")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("# Assembly\n\n{steps}\n")
            };
            files.insert(file_name.into(), content.into_bytes());
        }
    }
    let mut assumptions = Vec::new();
    let mut stmt = handle.db.prepare("SELECT title,selected_revision_id FROM artifact WHERE type='assumption' AND archived=0 ORDER BY created_at").map_err(internal)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(internal)?;
    for row in rows {
        let (title, id) = row.map_err(internal)?;
        let payload = id
            .as_deref()
            .map(|id| require_revision(handle, id))
            .transpose()?
            .map(|rev| rev["payload"].clone())
            .unwrap_or(json!({}));
        assumptions.push(format!(
            "- {title}: {} ({})",
            payload["statement"].as_str().unwrap_or(""),
            payload["reason"].as_str().unwrap_or("")
        ));
    }
    files.insert(
        "docs/ASSUMPTIONS.md".into(),
        format!("# Assumptions\n\n{}\n", assumptions.join("\n")).into_bytes(),
    );
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec_pretty(&manifest).map_err(internal)?,
    );
    let destination = required_str(input, "destPath")?;
    let dest = if Path::new(destination).is_absolute() {
        PathBuf::from(destination)
    } else {
        resolve_materialization_path(&handle.root, destination).map_err(storage_error)?
    };
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(internal)?;
    }
    let temp = dest.with_extension(format!("omenflow-{}.tmp", uuid::Uuid::new_v4()));
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
