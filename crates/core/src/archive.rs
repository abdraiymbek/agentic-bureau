//! Bounded ZIP project interchange. Imports stage and validate their SQLite
//! state and immutable objects before publishing the destination directory.
use super::*;
use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Write};
use zip::write::SimpleFileOptions;

const MAX_ZIP: u64 = 128 * 1024 * 1024;
const MAX_TOTAL: u64 = 512 * 1024 * 1024;
const MAX_ENTRY: u64 = 128 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;

fn bad(message: impl Into<String>) -> ContractError {
    ContractError::new("ARCHIVE_INVALID", message.into())
}

fn walk(root: &Path, relative: &str, files: &mut BTreeMap<String, Vec<u8>>) -> CoreResult<()> {
    let dir = omenflow_storage::resolve_project_path(root, relative).map_err(storage_error)?;
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(internal)? {
        let entry = entry.map_err(internal)?;
        let kind = entry.file_type().map_err(internal)?;
        let name = entry.file_name().to_string_lossy().to_string();
        let path = format!("{relative}/{name}");
        if kind.is_symlink() {
            return Err(bad(format!("Cannot archive symbolic link: {path}")));
        }
        if kind.is_dir() {
            walk(root, &path, files)?;
        } else if kind.is_file() {
            let absolute =
                omenflow_storage::resolve_project_path(root, &path).map_err(storage_error)?;
            files.insert(path, fs::read(absolute).map_err(internal)?);
        }
    }
    Ok(())
}

fn table_rows(
    handle: &ProjectHandle,
    sql: &str,
    mapper: fn(&rusqlite::Row<'_>) -> rusqlite::Result<Value>,
) -> CoreResult<Vec<Value>> {
    let mut stmt = handle.db.prepare(sql).map_err(internal)?;
    let result = stmt
        .query_map([], mapper)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(result)
}

fn decision_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let prior: String = row.get("prior_baseline")?;
    let next: String = row.get("new_baseline")?;
    Ok(
        json!({"id":row.get::<_,String>("id")?,"proposalId":row.get::<_,Option<String>>("proposal_id")?,
        "action":row.get::<_,String>("action")?,"actor":row.get::<_,String>("actor")?,
        "ts":row.get::<_,String>("ts")?,"rationale":row.get::<_,String>("rationale")?,
        "priorBaseline":serde_json::from_str::<Value>(&prior).unwrap_or(json!([])),
        "newBaseline":serde_json::from_str::<Value>(&next).unwrap_or(json!([])),
        "eventSeq":row.get::<_,i64>("event_seq")?}),
    )
}

fn bom_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({"id":row.get::<_,String>("id")?,
        "componentArtifactId":row.get::<_,String>("component_artifact_id")?,
        "componentRevisionId":row.get::<_,String>("component_revision_id")?,
        "subsystem":row.get::<_,Option<String>>("subsystem")?,
        "quantity":row.get::<_,f64>("quantity")?,"offerId":row.get::<_,Option<String>>("offer_id")?,
        "location":row.get::<_,Option<String>>("location")?,"notes":row.get::<_,String>("notes")?}))
}

pub(super) fn export_archive(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let include_terminal = input["includeTerminalHistory"].as_bool().unwrap_or(false);
    if include_terminal {
        if input["grantTerminalExportConsent"] == true {
            handle.assert_writable().map_err(storage_error)?;
            handle.db.execute("INSERT INTO meta(key,value) VALUES('terminal.exportConsent','true') ON CONFLICT(key) DO UPDATE SET value='true'", []).map_err(internal)?;
            emit(
                handle,
                "project.export_consent",
                &Origin::User,
                json!({"kind":"terminal_history","granted":true}),
            )?;
        }
        let consent: Option<String> = handle
            .db
            .query_row(
                "SELECT value FROM meta WHERE key='terminal.exportConsent'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(internal)?;
        if consent.as_deref() != Some("true") {
            return Err(ContractError::validation("Terminal history is excluded from ordinary archives until export consent is granted"));
        }
    }
    let project = handle
        .project()
        .map_err(storage_error)?
        .ok_or_else(|| bad("Project metadata missing"))?;
    let mut files = BTreeMap::new();
    files.insert(
        ".omenflow/state.sqlite".to_owned(),
        handle
            .archive_snapshot(include_terminal)
            .map_err(storage_error)?,
    );
    for name in ["omenflow.project.json", "README.md"] {
        let path =
            omenflow_storage::resolve_project_path(&handle.root, name).map_err(storage_error)?;
        if path.is_file() {
            files.insert(name.to_owned(), fs::read(path).map_err(internal)?);
        }
    }
    walk(&handle.root, "artifacts", &mut files)?;
    walk(&handle.root, ".omenflow/objects", &mut files)?;
    let artifacts = table_rows(
        handle,
        "SELECT * FROM artifact ORDER BY created_at",
        artifact_from_row,
    )?;
    let revisions = table_rows(
        handle,
        "SELECT * FROM revision ORDER BY artifact_id,seq",
        revision_from_row,
    )?;
    let edges = table_rows(
        handle,
        "SELECT * FROM edge ORDER BY created_at",
        models::edge_from_row,
    )?;
    let proposals = table_rows(
        handle,
        "SELECT * FROM proposal ORDER BY created_at",
        models::proposal_from_row,
    )?;
    let jobs = table_rows(
        handle,
        "SELECT * FROM job ORDER BY created_at",
        models::job_from_row,
    )?;
    let events = table_rows(
        handle,
        if include_terminal {
            "SELECT * FROM event ORDER BY seq"
        } else {
            "SELECT * FROM event WHERE type!='session.data' ORDER BY seq"
        },
        models::event_from_row,
    )?;
    let decisions = table_rows(
        handle,
        "SELECT * FROM decision ORDER BY ts DESC",
        decision_row,
    )?;
    let bom_lines = table_rows(
        handle,
        "SELECT * FROM bom_line ORDER BY subsystem,id",
        bom_row,
    )?;
    let snapshot = json!({"format":"omenflow-project-snapshot","version":1,"project":project,
        "artifacts":artifacts,"revisions":revisions,"edges":edges,"proposals":proposals,
        "decisions":decisions,"bomLines":bom_lines,"jobs":jobs,"events":events});
    files.insert(
        "snapshot.json".into(),
        serde_json::to_vec_pretty(&snapshot).map_err(internal)?,
    );
    let manifest = json!({"format":"omenflow-project-archive","version":1,"projectId":project["id"],
        "name":project["name"],"exportedAt":now(),
        "excludes": if include_terminal { json!(["credentials","machine settings","cache","work"]) } else { json!(["credentials","machine settings","cache","work","terminal logs"]) },
        "terminalHistory": if include_terminal { "included-with-consent" } else { "excluded" }});
    files.insert(
        "archive-manifest.json".into(),
        serde_json::to_vec_pretty(&manifest).map_err(internal)?,
    );
    let dest_str = required_str(input, "destPath")?;
    let dest = if Path::new(dest_str).is_absolute() {
        PathBuf::from(dest_str)
    } else {
        omenflow_storage::resolve_materialization_path(&handle.root, dest_str)
            .map_err(storage_error)?
    };
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(internal)?;
    }
    let temp = dest.with_extension(format!("omenflow-{}.tmp", uuid::Uuid::new_v4()));
    let write = (|| -> CoreResult<()> {
        let mut zip = zip::ZipWriter::new(fs::File::create(&temp).map_err(internal)?);
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in &files {
            zip.start_file(name, opts).map_err(internal)?;
            zip.write_all(bytes).map_err(internal)?;
        }
        zip.finish().map_err(internal)?;
        fs::rename(&temp, &dest).map_err(internal)?;
        Ok(())
    })();
    if write.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write?;
    Ok(json!({"path": dest, "files": files.len()}))
}

fn safe_name(name: &str, seen: &mut HashSet<String>) -> CoreResult<()> {
    if name.is_empty()
        || name.starts_with('/')
        || name.contains('\\')
        || name.contains('\0')
        || name.as_bytes().get(1) == Some(&b':')
        || name.split('/').any(|part| part == "." || part == "..")
        || !seen.insert(name.to_lowercase())
    {
        return Err(bad(format!("Unsafe or duplicate archive path: {name}")));
    }
    if name.starts_with(".omenflow/") && name != ".omenflow/state.sqlite" && !name.ends_with('/') {
        let parts = name.split('/').collect::<Vec<_>>();
        if parts.len() != 4
            || parts[1] != "objects"
            || parts[2].len() != 2
            || parts[3].len() != 64
            || !parts[3].starts_with(parts[2])
            || !parts[3]
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(bad(format!("Reserved archive member: {name}")));
        }
    }
    Ok(())
}

pub(super) fn import_archive(
    archive_path: &str,
    dest_dir: &str,
    new_identity: bool,
) -> CoreResult<ProjectHandle> {
    let archive_file = fs::File::open(archive_path).map_err(internal)?;
    if archive_file.metadata().map_err(internal)?.len() > MAX_ZIP {
        return Err(bad("Compressed archive exceeds the size limit"));
    }
    let mut zip =
        zip::ZipArchive::new(archive_file).map_err(|e| bad(format!("Invalid ZIP archive: {e}")))?;
    if zip.len() > MAX_ENTRIES {
        return Err(bad("Too many archive members"));
    }
    let mut entries = BTreeMap::<String, Vec<u8>>::new();
    let mut seen = HashSet::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut member = zip
            .by_index(index)
            .map_err(|e| bad(format!("Invalid ZIP member: {e}")))?;
        let name = member.name().to_owned();
        safe_name(&name, &mut seen)?;
        if member.is_dir() {
            continue;
        }
        if member.size() > MAX_ENTRY || member.compressed_size() > MAX_ZIP {
            return Err(bad(format!("Oversized archive member: {name}")));
        }
        if member
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(bad(format!("Archive link is not allowed: {name}")));
        }
        total = total
            .checked_add(member.size())
            .ok_or_else(|| bad("Archive expands beyond the size limit"))?;
        if total > MAX_TOTAL {
            return Err(bad("Archive expands beyond the size limit"));
        }
        let mut bytes = Vec::with_capacity(member.size() as usize);
        member
            .read_to_end(&mut bytes)
            .map_err(|e| bad(format!("Corrupt archive member {name}: {e}")))?;
        if bytes.len() as u64 != member.size() {
            return Err(bad(format!("Corrupt archive member: {name}")));
        }
        if name.starts_with(".omenflow/objects/")
            && omenflow_storage::sha256_hex(&bytes) != name.rsplit('/').next().unwrap_or("")
        {
            return Err(bad(format!("Corrupt object: {name}")));
        }
        entries.insert(name, bytes);
    }
    let manifest: Value = serde_json::from_slice(
        entries
            .get("archive-manifest.json")
            .ok_or_else(|| bad("Missing archive-manifest.json"))?,
    )
    .map_err(|e| bad(format!("Invalid archive manifest: {e}")))?;
    if manifest["format"] != "omenflow-project-archive"
        || manifest["version"] != 1
        || !manifest["projectId"].is_string()
        || !manifest["name"].is_string()
    {
        return Err(bad("Unsupported archive manifest"));
    }
    let marker: Value = serde_json::from_slice(
        entries
            .get("omenflow.project.json")
            .ok_or_else(|| bad("Missing project marker"))?,
    )
    .map_err(|e| bad(format!("Invalid project marker: {e}")))?;
    if marker["format"] != "omenflow-project"
        || marker["version"] != 1
        || marker["id"] != manifest["projectId"]
        || !entries.contains_key(".omenflow/state.sqlite")
    {
        return Err(bad("Unsupported or inconsistent project marker"));
    }
    let dest = PathBuf::from(dest_dir);
    if dest.exists() && (!dest.is_dir() || fs::read_dir(&dest).map_err(internal)?.next().is_some())
    {
        return Err(bad("Archive destination must be a new or empty directory"));
    }
    let parent = dest.parent().ok_or_else(|| bad("Invalid destination"))?;
    fs::create_dir_all(parent).map_err(internal)?;
    let staged = parent.join(format!(".omenflow-import-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staged).map_err(internal)?;
    let outcome = (|| -> CoreResult<ProjectHandle> {
        for (name, bytes) in &entries {
            let path =
                omenflow_storage::resolve_project_path(&staged, name).map_err(storage_error)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(internal)?;
            }
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(internal)?;
            output.write_all(bytes).map_err(internal)?;
        }
        validate_stage(&staged, &manifest)?;
        if new_identity {
            let mut marker = marker.clone();
            marker["id"] = json!(uuid::Uuid::new_v4().to_string());
            marker["name"] = json!(format!(
                "{} (copy)",
                marker["name"].as_str().unwrap_or("Project")
            ));
            let db = rusqlite::Connection::open(staged.join(".omenflow/state.sqlite"))
                .map_err(internal)?;
            db.execute(
                "UPDATE project SET id=?1,name=?2",
                params![marker["id"].as_str(), marker["name"].as_str()],
            )
            .map_err(internal)?;
            fs::write(
                staged.join("omenflow.project.json"),
                serde_json::to_vec_pretty(&marker).map_err(internal)?,
            )
            .map_err(internal)?;
        }
        if dest.exists() {
            if fs::read_dir(&dest).map_err(internal)?.next().is_some() {
                return Err(bad("Archive destination became occupied during import"));
            }
            fs::remove_dir(&dest).map_err(internal)?;
        }
        fs::rename(&staged, &dest).map_err(internal)?;
        let handle = ProjectHandle::open(&dest).map_err(storage_error)?;
        emit(
            &handle,
            "project.imported",
            &Origin::User,
            json!({"from":manifest["projectId"],"copy":new_identity}),
        )?;
        Ok(handle)
    })();
    if outcome.is_err() {
        let _ = fs::remove_dir_all(&staged);
    }
    outcome
}

fn validate_stage(root: &Path, manifest: &Value) -> CoreResult<()> {
    let db_path = root.join(".omenflow/state.sqlite");
    let db =
        rusqlite::Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| bad(format!("Invalid project database: {e}")))?;
    let schema: Option<String> = db
        .query_row(
            "SELECT value FROM meta WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| bad(format!("Invalid database schema: {e}")))?;
    if schema.as_deref() != Some("1") {
        return Err(bad("Unsupported database schema"));
    }
    let integrity: String = db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(internal)?;
    if integrity != "ok" {
        return Err(bad("Invalid project database"));
    }
    let project_id: String = db
        .query_row("SELECT id FROM project", [], |row| row.get(0))
        .map_err(internal)?;
    if manifest["projectId"] != project_id {
        return Err(bad("Project identity mismatch"));
    }
    let mut stmt = db
        .prepare("SELECT files,payload FROM revision")
        .map_err(internal)?;
    let revisions = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(internal)?;
    let objects = omenflow_storage::ObjectStore::new(root.join(".omenflow/objects"), true)
        .map_err(storage_error)?;
    for revision in revisions {
        let (files, payload) = revision.map_err(internal)?;
        for value in [files, payload] {
            let parsed: Value = serde_json::from_str(&value)
                .map_err(|e| bad(format!("Invalid revision JSON: {e}")))?;
            verify_hashes(&objects, &parsed)?;
        }
    }
    Ok(())
}

fn verify_hashes(objects: &omenflow_storage::ObjectStore, value: &Value) -> CoreResult<()> {
    match value {
        Value::Array(items) => {
            for item in items {
                verify_hashes(objects, item)?;
            }
        }
        Value::Object(map) => {
            for (key, entry) in map {
                if (key == "sha256" || key == "fileHash") && !entry.is_null() {
                    let hash = entry
                        .as_str()
                        .ok_or_else(|| bad("Invalid object reference"))?;
                    objects
                        .read(hash)
                        .map_err(|_| bad(format!("Missing or corrupt object: {hash}")))?;
                } else {
                    verify_hashes(objects, entry)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_round_trip_preserves_schema_and_blocks_corrupt_objects() {
        let temp = tempfile::tempdir().unwrap();
        let mut original =
            ProjectHandle::create(temp.path().join("original"), "Archive", "test").unwrap();
        let created = create_draft(
            &mut original,
            &json!({
                "type":"note", "title":"Evidence", "payload":{"markdown":"Known sample"},
                "files":[{"path":"artifacts/research/sample.txt","contentBase64":"c2FtcGxl"}],
                "inputs":[], "rationale":"test"
            }),
            &Origin::User,
        )
        .unwrap();
        let archive_path = temp.path().join("saved.zip");
        export_archive(&original, &json!({"destPath":archive_path})).unwrap();
        let imported = import_archive(
            archive_path.to_str().unwrap(),
            temp.path().join("restored").to_str().unwrap(),
            false,
        )
        .unwrap();
        assert_eq!(
            imported.project().unwrap().unwrap()["id"],
            original.project().unwrap().unwrap()["id"]
        );
        let revision =
            require_revision(&imported, created["revision"]["id"].as_str().unwrap()).unwrap();
        assert_eq!(revision["payload"]["markdown"], "Known sample");
        let hash = revision["files"][0]["sha256"].as_str().unwrap();
        assert_eq!(
            imported.object_store().unwrap().read(hash).unwrap(),
            b"sample"
        );
        drop(imported);
        let copy = import_archive(
            archive_path.to_str().unwrap(),
            temp.path().join("copy").to_str().unwrap(),
            true,
        )
        .unwrap();
        assert_ne!(
            copy.project().unwrap().unwrap()["id"],
            original.project().unwrap().unwrap()["id"]
        );
        let mut zip = zip::ZipWriter::new(fs::File::create(temp.path().join("bad.zip")).unwrap());
        zip.start_file("../escape", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"bad").unwrap();
        zip.finish().unwrap();
        assert_eq!(
            import_archive(
                temp.path().join("bad.zip").to_str().unwrap(),
                temp.path().join("bad-dest").to_str().unwrap(),
                false
            )
            .err()
            .unwrap()
            .code,
            "ARCHIVE_INVALID"
        );
    }
}
