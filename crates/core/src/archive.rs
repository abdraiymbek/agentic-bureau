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
/// Prefix of the temporary file an atomic working-file write leaves behind
/// when it is interrupted.
const WRITE_LEFTOVER: &str = ".omenflow-write-";

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
        if name.starts_with(WRITE_LEFTOVER) {
            // An interrupted file write; the file it was replacing is intact.
            continue;
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
    db: &rusqlite::Connection,
    sql: &str,
    mapper: fn(&rusqlite::Row<'_>) -> rusqlite::Result<Value>,
) -> CoreResult<Vec<Value>> {
    let mut stmt = db.prepare(sql).map_err(internal)?;
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
            txn::atomically(handle, || {
                handle.db.execute("INSERT INTO meta(key,value) VALUES('terminal.exportConsent','true') ON CONFLICT(key) DO UPDATE SET value='true'", []).map_err(internal)?;
                emit(
                    handle,
                    "project.export_consent",
                    &Origin::User,
                    json!({"kind":"terminal_history","granted":true}),
                )?;
                Ok(())
            })?;
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
    let mut notes = Vec::new();
    let mut files = BTreeMap::new();
    for name in ["omenflow.project.json", "README.md"] {
        let path =
            omenflow_storage::resolve_project_path(&handle.root, name).map_err(storage_error)?;
        if path.is_file() {
            files.insert(name.to_owned(), fs::read(path).map_err(internal)?);
        }
    }
    walk(&handle.root, "artifacts", &mut files)?;
    let skipped = collect_objects(&handle.root, &mut files)?;
    if skipped > 0 {
        notes.push(format!(
            "{skipped} file(s) in the object store are not valid objects and were left out."
        ));
    }

    // Everything read from the database below comes from a private copy that
    // has already been cleared of this machine's paths.
    let staging = tempfile::tempdir().map_err(internal)?;
    let state_path = staging.path().join("state.sqlite");
    fs::write(
        &state_path,
        handle
            .archive_snapshot(include_terminal)
            .map_err(storage_error)?,
    )
    .map_err(internal)?;
    let state = rusqlite::Connection::open(&state_path).map_err(internal)?;
    Redactor::for_project(&handle.root).scrub(&state)?;
    let recorded_tool_paths: i64 = state
        .query_row(
            "SELECT COUNT(*) FROM revision WHERE payload LIKE '%\"renderIdentity\"%' AND payload LIKE '%exe=%'",
            [],
            |row| row.get(0),
        )
        .map_err(internal)?;
    if recorded_tool_paths > 0 {
        notes.push(format!(
            "{recorded_tool_paths} rendered revision(s) record the path of the OpenSCAD program that produced them. It is part of their render identity and is exported unchanged."
        ));
    }
    let terminal_rows: i64 = state
        .query_row(
            "SELECT COUNT(*) FROM event WHERE type='session.data'",
            [],
            |row| row.get(0),
        )
        .map_err(internal)?;
    let artifacts = table_rows(
        &state,
        "SELECT * FROM artifact ORDER BY created_at",
        artifact_from_row,
    )?;
    let revisions = table_rows(
        &state,
        "SELECT * FROM revision ORDER BY artifact_id,seq",
        revision_from_row,
    )?;
    let edges = table_rows(
        &state,
        "SELECT * FROM edge ORDER BY created_at",
        models::edge_from_row,
    )?;
    let proposals = table_rows(
        &state,
        "SELECT * FROM proposal ORDER BY created_at",
        models::proposal_from_row,
    )?;
    let jobs = table_rows(
        &state,
        "SELECT * FROM job ORDER BY created_at",
        models::job_from_row,
    )?;
    let events = table_rows(
        &state,
        "SELECT * FROM event ORDER BY seq",
        models::event_from_row,
    )?;
    let decisions = table_rows(
        &state,
        "SELECT * FROM decision ORDER BY ts DESC",
        decision_row,
    )?;
    let bom_lines = table_rows(
        &state,
        "SELECT * FROM bom_line ORDER BY subsystem,id",
        bom_row,
    )?;
    assert_objects_present(&revisions, &files)?;
    drop(state);
    files.insert(
        ".omenflow/state.sqlite".to_owned(),
        fs::read(&state_path).map_err(internal)?,
    );
    let snapshot = json!({"format":"omenflow-project-snapshot","version":1,"project":project,
        "artifacts":artifacts,"revisions":revisions,"edges":edges,"proposals":proposals,
        "decisions":decisions,"bomLines":bom_lines,"jobs":jobs,"events":events});
    files.insert(
        "snapshot.json".into(),
        serde_json::to_vec_pretty(&snapshot).map_err(internal)?,
    );
    // Terminal history is only "included" when there is some: this build
    // records none, and saying otherwise would describe an archive it is not.
    let terminal_history = match (include_terminal, terminal_rows > 0) {
        (true, true) => "included-with-consent",
        (true, false) => "none-recorded",
        (false, _) => "excluded",
    };
    let manifest = json!({"format":"omenflow-project-archive","version":1,"projectId":project["id"],
        "name":project["name"],"exportedAt":now(),
        "excludes": if include_terminal { json!(["credentials","machine settings","machine paths","cache","work"]) } else { json!(["credentials","machine settings","machine paths","cache","work","terminal logs"]) },
        "terminalHistory": terminal_history});
    files.insert(
        "archive-manifest.json".into(),
        serde_json::to_vec_pretty(&manifest).map_err(internal)?,
    );
    assert_importable(&files)?;
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
        if fs::metadata(&temp).map_err(internal)?.len() > MAX_ZIP {
            return Err(too_large("The compressed archive"));
        }
        fs::rename(&temp, &dest).map_err(internal)?;
        Ok(())
    })();
    if write.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write?;
    let mut result = json!({"path": dest, "files": files.len()});
    if !notes.is_empty() {
        result["notes"] = json!(notes);
    }
    Ok(result)
}

fn too_large(what: &str) -> ContractError {
    bad(format!(
        "{what} is larger than an archive may be, so it could not be imported again"
    ))
    .with_repair("Remove unneeded large files from the project, or copy the project folder instead of exporting an archive.")
}

/// Whether `name` is the file name of an object: its lowercase SHA-256 inside
/// the two-character directory `prefix`.
fn object_name(prefix: &str, name: &str) -> bool {
    prefix.len() == 2
        && name.len() == 64
        && name.starts_with(prefix)
        && name
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// Adds every intact object to `files` and returns how many other files were
/// found in the store: interrupted writes, files another program left there,
/// and objects whose bytes no longer match their name. Import refuses all of
/// those, so they are never written into an archive.
fn collect_objects(root: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> CoreResult<usize> {
    let store =
        omenflow_storage::resolve_project_path(root, ".omenflow/objects").map_err(storage_error)?;
    if !store.is_dir() {
        return Ok(0);
    }
    let mut skipped = 0;
    for shard in fs::read_dir(&store).map_err(internal)? {
        let shard = shard.map_err(internal)?;
        let prefix = shard.file_name().to_string_lossy().to_string();
        if !shard.file_type().map_err(internal)?.is_dir() {
            skipped += 1;
            continue;
        }
        for entry in fs::read_dir(shard.path()).map_err(internal)? {
            let entry = entry.map_err(internal)?;
            let name = entry.file_name().to_string_lossy().to_string();
            let intact = entry.file_type().map_err(internal)?.is_file()
                && object_name(&prefix, &name)
                && fs::read(entry.path())
                    .ok()
                    .filter(|bytes| omenflow_storage::sha256_hex(bytes) == name)
                    .map(|bytes| files.insert(format!(".omenflow/objects/{prefix}/{name}"), bytes))
                    .is_some();
            if !intact {
                skipped += 1;
            }
        }
    }
    Ok(skipped)
}

/// Import resolves every object a revision refers to. An archive missing one
/// would be refused, so the export stops here and says which record is hurt.
fn assert_objects_present(
    revisions: &[Value],
    files: &BTreeMap<String, Vec<u8>>,
) -> CoreResult<()> {
    fn referenced(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Array(items) => items.iter().for_each(|item| referenced(item, out)),
            Value::Object(map) => {
                for (key, entry) in map {
                    match entry.as_str() {
                        Some(hash) if key == "sha256" || key == "fileHash" => {
                            out.push(hash.to_owned())
                        }
                        _ => referenced(entry, out),
                    }
                }
            }
            _ => {}
        }
    }
    for revision in revisions {
        let mut hashes = Vec::new();
        referenced(&revision["files"], &mut hashes);
        referenced(&revision["payload"], &mut hashes);
        for hash in hashes {
            let present = hash.len() == 64
                && files.contains_key(&format!(".omenflow/objects/{}/{hash}", &hash[..2]));
            if !present {
                return Err(bad(format!(
                    "Revision {} of artifact {} refers to stored content that is missing or damaged ({hash})",
                    revision["seq"], revision["artifactId"]
                ))
                .with_repair("The project cannot be archived completely. Restore the missing content from a backup, or revert the artifact to a revision whose files are intact, then export again."));
            }
        }
    }
    Ok(())
}

/// The checks import applies to archive members, applied before anything is
/// written, so an export never produces a file that import turns away.
fn assert_importable(files: &BTreeMap<String, Vec<u8>>) -> CoreResult<()> {
    if files.len() > MAX_ENTRIES {
        return Err(too_large("The project has more files"));
    }
    let mut seen = HashSet::new();
    let mut total = 0u64;
    for (name, bytes) in files {
        safe_name(name, &mut seen).map_err(|error| {
            bad(format!("Cannot archive this project: {}", error.message)).with_repair(
                "Rename or remove that file in the project folder (file names must be unique without regard to letter case), then export again.",
            )
        })?;
        if bytes.len() as u64 > MAX_ENTRY {
            return Err(too_large(name));
        }
        total += bytes.len() as u64;
    }
    if total > MAX_TOTAL {
        return Err(too_large("The project"));
    }
    Ok(())
}

/// Removes this machine's paths from a private copy of the project database:
/// where the project, the home directory and temporary files live, and where
/// programs are installed. None of it is engineering content, and all of it
/// describes the computer the archive came from.
struct Redactor {
    project: String,
    /// Longest first, so a project inside the home directory is named as the
    /// project.
    prefixes: Vec<(String, &'static str)>,
}

/// Event fields that hold a path on this machine.
const PATH_FIELDS: [&str; 6] = [
    "executablePath",
    "destPath",
    "archivePath",
    "sourcePath",
    "path",
    "root",
];

impl Redactor {
    fn for_project(root: &Path) -> Self {
        let project = root.to_string_lossy().into_owned();
        let mut prefixes = vec![(project.clone(), "<project>")];
        for (path, label) in [
            (std::env::var_os("HOME").map(PathBuf::from), "~"),
            (std::env::var_os("USERPROFILE").map(PathBuf::from), "~"),
            (Some(std::env::temp_dir()), "<tmp>"),
        ] {
            let Some(path) = path else { continue };
            let canonical = omenflow_storage::canonicalize(&path).ok();
            for form in [Some(path), canonical].into_iter().flatten() {
                let form = form
                    .to_string_lossy()
                    .trim_end_matches(['/', '\\'])
                    .to_owned();
                if form.len() > 1 && !prefixes.iter().any(|(known, _)| *known == form) {
                    prefixes.push((form, label));
                }
            }
        }
        prefixes.sort_by_key(|(prefix, _)| std::cmp::Reverse(prefix.len()));
        Self { project, prefixes }
    }

    fn text(&self, text: &str) -> String {
        self.prefixes
            .iter()
            .fold(text.to_owned(), |text, (prefix, label)| {
                text.replace(prefix, label)
            })
    }

    /// A path on this machine: relative to the project when it is inside it,
    /// otherwise only its last component.
    fn path(&self, path: &str) -> String {
        if !is_absolute(path) {
            return self.text(path);
        }
        match path.strip_prefix(self.project.as_str()) {
            Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
                format!("<project>{rest}")
            }
            _ => file_name(path).to_owned(),
        }
    }

    /// A recorded command line: the program is named, not located.
    fn command(&self, command: &str) -> String {
        if !is_absolute(command) {
            return self.text(command);
        }
        let (program, arguments) = match command.find(" -") {
            Some(split) => command.split_at(split),
            None => (command, ""),
        };
        format!("{}{}", file_name(program), self.text(arguments))
    }

    fn value(&self, value: &mut Value) {
        match value {
            Value::String(text) => *text = self.text(text),
            Value::Array(items) => items.iter_mut().for_each(|item| self.value(item)),
            Value::Object(map) => {
                for (key, entry) in map.iter_mut() {
                    match entry {
                        Value::String(path) if PATH_FIELDS.contains(&key.as_str()) => {
                            *path = self.path(path)
                        }
                        _ => self.value(entry),
                    }
                }
            }
            _ => {}
        }
    }

    fn json(&self, raw: &str) -> String {
        match serde_json::from_str::<Value>(raw) {
            Ok(mut value) => {
                self.value(&mut value);
                value.to_string()
            }
            Err(_) => self.text(raw),
        }
    }

    /// Rewrites the columns that hold machine paths and compacts the copy so
    /// the previous bytes do not stay behind in free pages.
    fn scrub(&self, db: &rusqlite::Connection) -> CoreResult<()> {
        db.pragma_update(None, "secure_delete", "ON")
            .map_err(internal)?;
        self.rewrite(db, "session", "id", "executable_path", |text| {
            self.path(text)
        })?;
        self.rewrite(db, "session", "id", "last_error", |text| self.text(text))?;
        self.rewrite(db, "job", "id", "command", |text| self.command(text))?;
        self.rewrite(db, "job", "id", "log", |text| self.text(text))?;
        self.rewrite(db, "job", "id", "error", |text| self.json(text))?;
        self.rewrite(db, "event", "seq", "data", |text| self.json(text))?;
        db.execute_batch("VACUUM").map_err(internal)
    }

    fn rewrite(
        &self,
        db: &rusqlite::Connection,
        table: &str,
        key: &str,
        column: &str,
        redact: impl Fn(&str) -> String,
    ) -> CoreResult<()> {
        let mut stmt = db
            .prepare(&format!(
                "SELECT {key},{column} FROM {table} WHERE {column} IS NOT NULL"
            ))
            .map_err(internal)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, rusqlite::types::Value>(0)?,
                    row.get::<_, String>(1)?,
                ))
            })
            .map_err(internal)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal)?;
        for (id, text) in rows {
            let redacted = redact(&text);
            if redacted != text {
                db.execute(
                    &format!("UPDATE {table} SET {column}=?1 WHERE {key}=?2"),
                    params![redacted, id],
                )
                .map_err(internal)?;
            }
        }
        Ok(())
    }
}

fn is_absolute(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with('\\')
        || (path.as_bytes().get(1) == Some(&b':')
            && matches!(path.as_bytes().get(2), Some(b'/' | b'\\')))
}

fn file_name(path: &str) -> &str {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
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
        if parts.len() != 4 || parts[1] != "objects" || !object_name(parts[2], parts[3]) {
            return Err(bad(format!("Reserved archive member: {name}")));
        }
    }
    Ok(())
}

pub(super) fn import_archive(
    archive_path: &str,
    dest_dir: &str,
    new_identity: bool,
    open_ids: &[String],
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
    if !new_identity && open_ids.iter().any(|id| marker["id"].as_str() == Some(id)) {
        return Err(ContractError::new(
            "REVISION_CONFLICT",
            "Another folder with this project identity is already open",
        ));
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

    fn project_with_a_file() -> (tempfile::TempDir, ProjectHandle, Value) {
        let temp = tempfile::tempdir().unwrap();
        let mut handle =
            ProjectHandle::create(temp.path().join("original"), "Archive", "test").unwrap();
        let created = create_draft(
            &mut handle,
            &json!({
                "type":"note", "title":"Evidence", "payload":{"markdown":"Known sample"},
                "files":[{"path":"artifacts/research/sample.txt","contentBase64":"c2FtcGxl"}],
                "inputs":[], "rationale":"test"
            }),
            &Origin::User,
        )
        .unwrap();
        (temp, handle, created)
    }

    fn members(archive: &Path) -> BTreeMap<String, Vec<u8>> {
        let mut zip = zip::ZipArchive::new(fs::File::open(archive).unwrap()).unwrap();
        (0..zip.len())
            .map(|index| {
                let mut member = zip.by_index(index).unwrap();
                let mut bytes = Vec::new();
                member.read_to_end(&mut bytes).unwrap();
                (member.name().to_owned(), bytes)
            })
            .collect()
    }

    fn contains(haystack: &[u8], needle: &str) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle.as_bytes())
    }

    #[test]
    fn archive_round_trip_preserves_schema_and_blocks_corrupt_objects() {
        let (temp, original, created) = project_with_a_file();
        let archive_path = temp.path().join("saved.zip");
        export_archive(&original, &json!({"destPath":archive_path})).unwrap();
        let imported = import_archive(
            archive_path.to_str().unwrap(),
            temp.path().join("restored").to_str().unwrap(),
            false,
            &[],
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
            &[],
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
                false,
                &[],
            )
            .err()
            .unwrap()
            .code,
            "ARCHIVE_INVALID"
        );
    }

    #[test]
    fn export_leaves_out_everything_import_would_refuse() {
        let (temp, original, created) = project_with_a_file();
        let hash = created["revision"]["files"][0]["sha256"].as_str().unwrap();
        let store = original.root.join(".omenflow/objects");
        // What crashes and other programs leave in a project folder.
        fs::write(store.join(".DS_Store"), b"finder").unwrap();
        fs::write(
            store
                .join(&hash[..2])
                .join(format!("{hash}.tmp-interrupted")),
            b"half an object",
        )
        .unwrap();
        fs::create_dir_all(store.join("zz")).unwrap();
        fs::write(store.join("zz/not-an-object"), b"stray").unwrap();
        fs::write(
            original
                .root
                .join("artifacts/research/.omenflow-write-interrupted"),
            b"half a file",
        )
        .unwrap();

        let archive_path = temp.path().join("saved.zip");
        let exported = export_archive(&original, &json!({"destPath":archive_path})).unwrap();
        assert_eq!(
            exported["notes"],
            json!(["3 file(s) in the object store are not valid objects and were left out."])
        );
        let names = members(&archive_path);
        assert!(names.keys().all(|name| !name.contains("interrupted")
            && !name.contains("DS_Store")
            && !name.contains("not-an-object")));
        assert_eq!(exported["files"], names.len());
        let imported = import_archive(
            archive_path.to_str().unwrap(),
            temp.path().join("restored").to_str().unwrap(),
            false,
            &[],
        )
        .unwrap();
        assert_eq!(
            imported.object_store().unwrap().read(hash).unwrap(),
            b"sample"
        );
    }

    #[test]
    fn export_refuses_to_write_an_archive_whose_content_is_damaged() {
        let (temp, original, created) = project_with_a_file();
        let hash = created["revision"]["files"][0]["sha256"].as_str().unwrap();
        let object = original
            .root
            .join(".omenflow/objects")
            .join(&hash[..2])
            .join(hash);
        // Objects are stored read-only; replace the file to damage it.
        fs::remove_file(&object).unwrap();
        fs::write(&object, b"damaged").unwrap();

        let archive_path = temp.path().join("saved.zip");
        let error = export_archive(&original, &json!({"destPath":archive_path})).unwrap_err();
        assert_eq!(error.code, "ARCHIVE_INVALID");
        assert!(error.message.contains(hash), "{}", error.message);
        assert!(error.repair.is_some());
        assert!(!archive_path.exists());
        assert!(fs::read_dir(temp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp")));
    }

    #[test]
    fn members_import_would_reject_stop_the_export_with_a_reason() {
        let ok = BTreeMap::from([("artifacts/research/Notes.txt".to_owned(), vec![1u8])]);
        assert!(assert_importable(&ok).is_ok());
        // Two names that differ only by letter case collide on most filesystems.
        let clash = BTreeMap::from([
            ("artifacts/research/Notes.txt".to_owned(), vec![1u8]),
            ("artifacts/research/notes.txt".to_owned(), vec![2u8]),
        ]);
        let error = assert_importable(&clash).unwrap_err();
        assert_eq!(error.code, "ARCHIVE_INVALID");
        assert!(error.message.contains("artifacts/research/notes.txt"));
        assert!(error.repair.unwrap().contains("letter case"));
        let many = (0..=MAX_ENTRIES)
            .map(|index| (format!("artifacts/research/{index}.txt"), Vec::new()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            assert_importable(&many).unwrap_err().code,
            "ARCHIVE_INVALID"
        );
    }

    #[test]
    fn an_archive_does_not_carry_the_paths_of_the_machine_it_came_from() {
        let (temp, original, _) = project_with_a_file();
        let root = original.root.to_string_lossy().into_owned();
        original
            .db
            .execute(
                "INSERT INTO session(id,adapter_id,executable_path,state,last_error) VALUES('s-1','custom','/opt/agents/bin/agent-cli','exited',?1)",
                [format!("could not read {root}/AGENTS.md")],
            )
            .unwrap();
        original
            .db
            .execute(
                "INSERT INTO job(id,kind,tool,inputs,command,status,log,error,created_at) VALUES('j-1','cad_render','openscad','{}','/opt/tools/OpenSCAD -o output.stl input.scad','failed',?1,?2,?3)",
                params![
                    format!("ERROR: {root}/artifacts/mechanical/part.scad, line 3"),
                    json!({"code": "VALIDATION", "message": format!("Parser error in {root}/artifacts/mechanical/part.scad")}).to_string(),
                    now()
                ],
            )
            .unwrap();
        emit(
            &original,
            "session.state",
            &Origin::System,
            json!({"id": "s-1", "executablePath": "/opt/agents/bin/agent-cli", "state": "exited"}),
        )
        .unwrap();
        emit(
            &original,
            "build.exported",
            &Origin::User,
            json!({"destPath": format!("{root}/exports/build.zip"), "files": 3}),
        )
        .unwrap();
        emit(
            &original,
            "build.exported",
            &Origin::User,
            json!({"destPath": "/Volumes/usb-stick/build.zip", "files": 3}),
        )
        .unwrap();

        let archive_path = temp.path().join("saved.zip");
        export_archive(&original, &json!({"destPath":archive_path})).unwrap();
        let names = members(&archive_path);
        for member in [".omenflow/state.sqlite", "snapshot.json"] {
            let bytes = &names[member];
            for leaked in [
                root.as_str(),
                "/opt/agents",
                "/opt/tools",
                "/Volumes/usb-stick",
            ] {
                assert!(!contains(bytes, leaked), "{member} still contains {leaked}");
            }
        }
        let snapshot: Value = serde_json::from_slice(&names["snapshot.json"]).unwrap();
        let job = &snapshot["jobs"][0];
        assert_eq!(job["command"], "OpenSCAD -o output.stl input.scad");
        assert_eq!(
            job["log"],
            "ERROR: <project>/artifacts/mechanical/part.scad, line 3"
        );
        assert_eq!(
            job["error"]["message"],
            "Parser error in <project>/artifacts/mechanical/part.scad"
        );
        let exported = snapshot["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["type"] == "build.exported")
            .map(|event| event["data"]["destPath"].clone())
            .collect::<Vec<_>>();
        assert_eq!(
            exported,
            vec![json!("<project>/exports/build.zip"), json!("build.zip")]
        );

        let imported = import_archive(
            archive_path.to_str().unwrap(),
            temp.path().join("restored").to_str().unwrap(),
            false,
            &[],
        )
        .unwrap();
        let (program, last_error): (String, String) = imported
            .db
            .query_row(
                "SELECT executable_path,last_error FROM session",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(program, "agent-cli");
        assert_eq!(last_error, "could not read <project>/AGENTS.md");
        // The project being exported keeps its own record as it was.
        let kept: String = original
            .db
            .query_row("SELECT executable_path FROM session", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kept, "/opt/agents/bin/agent-cli");
    }

    #[test]
    fn terminal_history_is_only_called_included_when_some_was_recorded() {
        let (temp, original, _) = project_with_a_file();
        let manifest = |name: &str, input: Value| -> Value {
            let path = temp.path().join(name);
            let mut input = input;
            input["destPath"] = json!(path);
            export_archive(&original, &input).unwrap();
            serde_json::from_slice(&members(&path)["archive-manifest.json"]).unwrap()
        };
        assert_eq!(
            manifest("plain.zip", json!({}))["terminalHistory"],
            "excluded"
        );
        let consented = json!({"includeTerminalHistory": true, "grantTerminalExportConsent": true});
        assert_eq!(
            manifest("empty.zip", consented.clone())["terminalHistory"],
            "none-recorded"
        );
        emit(
            &original,
            "session.data",
            &Origin::System,
            json!({"text": "$ ls"}),
        )
        .unwrap();
        assert_eq!(
            manifest("history.zip", consented)["terminalHistory"],
            "included-with-consent"
        );
        assert_eq!(
            manifest("after.zip", json!({}))["terminalHistory"],
            "excluded"
        );
    }
}
