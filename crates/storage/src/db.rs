use crate::{canonicalize, ObjectStore, StorageError};
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, MAIN_DB};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tempfile::{tempdir, TempDir};

const SCHEMA_VERSION: i64 = 1;
const PROJECT_FILE: &str = "omenflow.project.json";
const SCHEMA_V1: &str = include_str!("schema_v1.sql");
const ARTIFACT_DIRS: &[&str] = &[
    "requirements",
    "research",
    "concepts",
    "components",
    "mechanical",
    "electronics",
    "calculations",
    "software",
    "assembly",
    "tests",
];
const OMENFLOW_DIRS: &[&str] = &["objects", "work", "recovery", "cache"];

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProjectFile {
    pub format: String,
    pub version: i64,
    pub id: String,
    pub name: String,
}

/// The connection is the one project writer in writable mode. A read-only
/// newer project is opened from a private snapshot so even SQLite WAL recovery
/// cannot touch the source project.
pub struct ProjectHandle {
    pub root: PathBuf,
    pub file: ProjectFile,
    pub db: Connection,
    pub read_only: bool,
    _snapshot: Option<TempDir>,
}

impl ProjectHandle {
    /// Open another connection to a schema-1 project already owned by this
    /// process. A render worker must read the live WAL through SQLite rather
    /// than copy its database and WAL files while the UI is writing them.
    pub fn open_worker(root: impl AsRef<Path>) -> Result<Self, StorageError> {
        let root = canonicalize(root)?;
        let file: ProjectFile = serde_json::from_slice(&fs::read(root.join(PROJECT_FILE))?)?;
        if file.format != "omenflow-project" || file.id.is_empty() {
            return Err(StorageError::domain("VALIDATION", "Invalid project marker"));
        }
        if file.version != SCHEMA_VERSION {
            return Err(StorageError::domain(
                "UNSUPPORTED_SCHEMA",
                format!("Unsupported project marker version {}", file.version),
            ));
        }
        let db = Connection::open_with_flags(
            root.join(".omenflow/state.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        )?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        db.busy_timeout(Duration::from_millis(5_000))?;
        let db_version = current_schema_version(&db)?;
        if db_version != SCHEMA_VERSION {
            return Err(StorageError::domain(
                "UNSUPPORTED_SCHEMA",
                format!("Unsupported project schema version {db_version}"),
            ));
        }
        Ok(Self {
            root,
            file,
            db,
            read_only: false,
            _snapshot: None,
        })
    }

    pub fn open(root: impl AsRef<Path>) -> Result<Self, StorageError> {
        let root = canonicalize(root)?;
        let file: ProjectFile = serde_json::from_slice(&fs::read(root.join(PROJECT_FILE))?)?;
        if file.format != "omenflow-project" || file.id.is_empty() {
            return Err(StorageError::domain("VALIDATION", "Invalid project marker"));
        }
        let db_path = root.join(".omenflow/state.sqlite");
        if !db_path.is_file() {
            return Err(StorageError::domain(
                "NOT_FOUND",
                format!("No project database at {}", db_path.display()),
            ));
        }
        let snapshot = tempdir()?;
        let copied_db = snapshot.path().join("state.sqlite");
        fs::copy(&db_path, &copied_db)?;
        let wal = db_path.with_file_name("state.sqlite-wal");
        if wal.exists() {
            fs::copy(wal, snapshot.path().join("state.sqlite-wal"))?;
        }
        let copied = Connection::open(&copied_db)?;
        copied.pragma_update(None, "foreign_keys", "ON")?;
        let db_version = current_schema_version(&copied)?;
        if file.version > SCHEMA_VERSION || db_version > SCHEMA_VERSION {
            return Ok(Self {
                root,
                file,
                db: copied,
                read_only: true,
                _snapshot: Some(snapshot),
            });
        }
        drop(copied);
        drop(snapshot);
        let db = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        db.busy_timeout(Duration::from_millis(5_000))?;
        if db_version != SCHEMA_VERSION {
            return Err(StorageError::domain(
                "UNSUPPORTED_SCHEMA",
                format!("Unsupported project schema version {db_version}"),
            ));
        }
        let mut handle = Self {
            root,
            file,
            db,
            read_only: false,
            _snapshot: None,
        };
        handle.recover_rename()?;
        Ok(handle)
    }

    pub fn create(root: impl AsRef<Path>, name: &str, intent: &str) -> Result<Self, StorageError> {
        let root = canonicalize(root)?;
        if root.join(PROJECT_FILE).exists() {
            return Err(StorageError::domain("VALIDATION", "Project already exists"));
        }
        fs::create_dir_all(&root)?;
        if fs::read_dir(&root)?.any(|entry| {
            entry
                .ok()
                .map(|entry| entry.file_name() != ".DS_Store")
                .unwrap_or(true)
        }) {
            return Err(StorageError::domain(
                "VALIDATION",
                format!("Folder is not empty: {}", root.display()),
            ));
        }
        for dir in ARTIFACT_DIRS {
            fs::create_dir_all(root.join("artifacts").join(dir))?;
        }
        fs::create_dir_all(root.join("exports"))?;
        for dir in OMENFLOW_DIRS {
            fs::create_dir_all(root.join(".omenflow").join(dir))?;
        }
        let file = ProjectFile {
            format: "omenflow-project".into(),
            version: SCHEMA_VERSION,
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
        };
        atomic_json_write(&root.join(PROJECT_FILE), &file)?;
        let readme = format!(
            "# {name}\n\nOmen Flow engineering project. State lives in `.omenflow/state.sqlite`; readable views live under `artifacts/`.\n\n{intent}\n"
        );
        fs::write(root.join("README.md"), readme)?;
        let db = Connection::open(root.join(".omenflow/state.sqlite"))?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        db.busy_timeout(Duration::from_millis(5_000))?;
        db.execute_batch(SCHEMA_V1)?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let tx = db.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO meta(key,value) VALUES('schema_version', '1')",
            [],
        )?;
        tx.execute(
            "INSERT INTO project(id,name,intent,units_pref,currency_pref,schema_version,created_at) VALUES(?1,?2,?3,'si','USD',1,?4)",
            params![file.id, name, intent, now],
        )?;
        tx.execute(
            "INSERT INTO event(id,type,origin,ts,data) VALUES(?1,'project.created','user',?2,?3)",
            params![
                uuid::Uuid::new_v4().to_string(),
                now,
                json!({ "name": name }).to_string()
            ],
        )?;
        tx.commit()?;
        Ok(Self {
            root,
            file,
            db,
            read_only: false,
            _snapshot: None,
        })
    }

    pub fn assert_writable(&self) -> Result<(), StorageError> {
        if self.read_only {
            Err(StorageError::domain("READ_ONLY", "Project is read-only"))
        } else {
            Ok(())
        }
    }

    pub fn rename(&mut self, name: &str) -> Result<(), StorageError> {
        self.assert_writable()?;
        let journal = self.root.join(".omenflow/recovery/rename.json");
        fs::create_dir_all(journal.parent().expect("rename journal has parent"))?;
        atomic_json_write(
            &journal,
            &json!({
                "version": 1,
                "name": name,
                "startedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            }),
        )?;
        self.apply_rename(name, false)?;
        fs::remove_file(journal)?;
        Ok(())
    }

    fn recover_rename(&mut self) -> Result<(), StorageError> {
        if self.read_only {
            return Ok(());
        }
        let journal = self.root.join(".omenflow/recovery/rename.json");
        if !journal.is_file() {
            return Ok(());
        }
        let record: Value = serde_json::from_slice(&fs::read(&journal)?)?;
        if record["version"] != 1 {
            return Ok(());
        }
        let Some(name) = record["name"].as_str() else {
            return Ok(());
        };
        let name = name.to_owned();
        self.apply_rename(&name, true)?;
        fs::remove_file(journal)?;
        Ok(())
    }

    fn apply_rename(&mut self, name: &str, recovered: bool) -> Result<(), StorageError> {
        let current = self.project()?;
        if current.as_ref().and_then(|p| p["name"].as_str()) != Some(name) {
            let tx = self.db.unchecked_transaction()?;
            tx.execute("UPDATE project SET name=?1", [name])?;
            tx.execute(
                "INSERT INTO event(id,type,origin,ts,data) VALUES(?1,'project.renamed',?2,?3,?4)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    if recovered { "system" } else { "user" },
                    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                    json!({"name": name, "recovered": recovered}).to_string()
                ],
            )?;
            tx.commit()?;
        }
        if self.file.name != name {
            self.file.name = name.to_owned();
            atomic_json_write(&self.root.join(PROJECT_FILE), &self.file)?;
        }
        Ok(())
    }

    pub fn object_store(&self) -> Result<ObjectStore, StorageError> {
        ObjectStore::new(self.root.join(".omenflow/objects"), self.read_only)
    }

    pub fn project(&self) -> Result<Option<Value>, StorageError> {
        self.db
            .query_row(
                "SELECT id,name,intent,units_pref,currency_pref,schema_version,created_at FROM project LIMIT 1",
                [],
                |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "name": row.get::<_, String>(1)?,
                        "intent": row.get::<_, String>(2)?,
                        "unitsPref": row.get::<_, String>(3)?,
                        "currencyPref": row.get::<_, String>(4)?,
                        "schemaVersion": row.get::<_, i64>(5)?,
                        "createdAt": row.get::<_, String>(6)?,
                    }))
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn artifact_count(&self) -> Result<i64, StorageError> {
        Ok(self
            .db
            .query_row("SELECT COUNT(*) FROM artifact", [], |row| row.get(0))?)
    }

    pub fn fts_available(&self) -> Result<bool, StorageError> {
        Ok(self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_fts')",
            [],
            |row| row.get::<_, i64>(0),
        )? == 1)
    }

    /// A SQLite online backup includes committed WAL pages. The private copy
    /// can be scrubbed without changing live terminal history or retry rows.
    pub fn archive_snapshot(&self, include_session_data: bool) -> Result<Vec<u8>, StorageError> {
        let temp = tempdir()?;
        let dest = temp.path().join("archive.sqlite");
        self.db.backup(MAIN_DB, &dest, None)?;
        let copy = Connection::open(&dest)?;
        copy.pragma_update(None, "secure_delete", "ON")?;
        if !include_session_data {
            copy.execute("DELETE FROM event WHERE type='session.data'", [])?;
        }
        copy.execute("DELETE FROM idempotency", [])?;
        copy.execute_batch("VACUUM")?;
        drop(copy);
        Ok(fs::read(dest)?)
    }
}

fn current_schema_version(db: &Connection) -> Result<i64, StorageError> {
    match db.query_row(
        "SELECT value FROM meta WHERE key='schema_version'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        Ok(value) => Ok(value.parse().unwrap_or(0)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
        Err(rusqlite::Error::SqliteFailure(_, Some(message)))
            if message.contains("no such table") =>
        {
            Ok(0)
        }
        Err(error) => Err(error.into()),
    }
}

fn atomic_json_write(path: &Path, value: &impl Serialize) -> Result<(), StorageError> {
    let temp = path.with_file_name(format!(".omenflow-write-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        Ok::<(), StorageError>(())
    })();
    let _ = fs::remove_file(temp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_project_keeps_schema_one_and_fts5() {
        let temp = tempdir().unwrap();
        let project = ProjectHandle::create(temp.path().join("project"), "Test", "Intent").unwrap();
        assert_eq!(project.project().unwrap().unwrap()["name"], "Test");
        assert_eq!(project.artifact_count().unwrap(), 0);
        assert!(project.fts_available().unwrap());
        drop(project);
        let reopened = ProjectHandle::open(temp.path().join("project")).unwrap();
        assert!(!reopened.read_only);
        assert_eq!(reopened.file.version, 1);
    }

    #[test]
    fn worker_reads_live_wal_and_rejects_newer_marker() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let project = ProjectHandle::create(&root, "Test", "Intent").unwrap();
        project
            .db
            .execute("UPDATE project SET name='Changed'", [])
            .unwrap();
        let worker = ProjectHandle::open_worker(&root).unwrap();
        assert_eq!(worker.project().unwrap().unwrap()["name"], "Changed");
        drop(worker);
        drop(project);
        let marker = root.join(PROJECT_FILE);
        let mut value: Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
        value["version"] = json!(2);
        fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            ProjectHandle::open_worker(&root),
            Err(StorageError::Domain {
                code: "UNSUPPORTED_SCHEMA",
                ..
            })
        ));
    }

    #[test]
    fn newer_marker_opens_without_writing_source_bytes() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        drop(ProjectHandle::create(&root, "Test", "Intent").unwrap());
        let marker = root.join(PROJECT_FILE);
        let mut value: Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
        value["version"] = json!(2);
        fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
        let db_path = root.join(".omenflow/state.sqlite");
        let before = fs::read(&db_path).unwrap();
        let project = ProjectHandle::open(&root).unwrap();
        assert!(project.read_only);
        assert_eq!(project.artifact_count().unwrap(), 0);
        assert_eq!(fs::read(&db_path).unwrap(), before);
    }

    #[test]
    fn opens_existing_typescript_fixture_without_mutating_it() {
        let Ok(root) = std::env::var("OMENFLOW_COMPAT_FIXTURE") else {
            return;
        };
        let root = PathBuf::from(root);
        let db_path = root.join(".omenflow/state.sqlite");
        let before = fs::read(&db_path).unwrap();
        let project = ProjectHandle::open(&root).unwrap();
        assert_eq!(project.artifact_count().unwrap(), 500);
        assert!(project.fts_available().unwrap());
        assert_eq!(project.project().unwrap().unwrap()["schemaVersion"], 1);
        let object: String = project.db.query_row(
            "SELECT json_extract(files, '$[0].sha256') FROM revision WHERE files != '[]' LIMIT 1",
            [],
            |row| row.get(0),
        ).unwrap();
        assert!(!project
            .object_store()
            .unwrap()
            .read(&object)
            .unwrap()
            .is_empty());
        drop(project);
        assert_eq!(fs::read(&db_path).unwrap(), before);
    }

    #[test]
    fn rename_recovery_keeps_database_and_marker_in_sync() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let mut project = ProjectHandle::create(&root, "Original", "").unwrap();
        project.rename("New name").unwrap();
        assert_eq!(project.project().unwrap().unwrap()["name"], "New name");
        let journal = root.join(".omenflow/recovery/rename.json");
        atomic_json_write(&journal, &json!({"version": 1, "name": "Recovered name"})).unwrap();
        drop(project);
        let reopened = ProjectHandle::open(&root).unwrap();
        assert_eq!(
            reopened.project().unwrap().unwrap()["name"],
            "Recovered name"
        );
        assert_eq!(reopened.file.name, "Recovered name");
        assert!(!journal.exists());
    }
}
