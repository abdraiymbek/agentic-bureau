//! Commit hook for mechanical revisions written through the generic artifact
//! operations (draft, direct edit, revert). A mesh, its bounds and its render
//! identity describe one exact source and parameter set. When either changes
//! the derived outputs are removed, so the revision reads as needing a render
//! instead of showing geometry that no longer matches what is recorded.
//!
//! A render identity is kept only when this core produced it: the render job
//! it names succeeded on exactly that source and those parameters and wrote
//! that mesh. Whoever writes the payload cannot supply one, however
//! consistent its hashes are with the files it attaches.

use crate::{internal, storage_error, CoreResult};
use bureau_storage::ProjectHandle;
use regex::Regex;
use rusqlite::OptionalExtension;
use serde_json::{Map, Value};
use std::collections::HashMap;

const DERIVED: [&str; 4] = ["stl", "bounds", "renderJobId", "renderIdentity"];

/// The revision's OpenSCAD source: the attached file the payload names, else
/// the first attached `.scad`, else the payload's own reference. Attached
/// files are authoritative; the payload reference is a mirror.
fn source_ref(payload: &Value, files: &[Value]) -> Option<Value> {
    let named = payload["scad"]["path"].as_str();
    files
        .iter()
        .find(|file| named.is_some() && file["path"].as_str() == named)
        .or_else(|| {
            files
                .iter()
                .find(|file| file["path"].as_str().is_some_and(|p| p.ends_with(".scad")))
        })
        .or_else(|| payload.get("scad").filter(|mirror| mirror.is_object()))
        .cloned()
}

/// Numbers compare by value, so `20` written by the interface equals `20.0`
/// recorded by a render.
fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Object(x), Value::Object(y)) => same_params(x, y),
        _ => a == b,
    }
}

fn same_params(a: &Map<String, Value>, b: &Map<String, Value>) -> bool {
    a.len() == b.len()
        && a.iter()
            .all(|(name, value)| b.get(name).is_some_and(|other| same_value(value, other)))
}

fn params_of(payload: &Value) -> Map<String, Value> {
    payload["params"].as_object().cloned().unwrap_or_default()
}

fn model_unit(payload: &Value) -> &str {
    payload["modelUnit"].as_str().unwrap_or("mm")
}

/// Whether the recorded render was produced from exactly this source,
/// parameter set and unit, and its mesh is the one attached.
fn render_matches(payload: &Value, files: &[Value], source: Option<&Value>) -> bool {
    let identity = &payload["renderIdentity"];
    let stl_path = payload["stl"]["path"].as_str();
    let output = files
        .iter()
        .find(|file| stl_path.is_some() && file["path"].as_str() == stl_path)
        .unwrap_or(&payload["stl"]);
    identity["version"] == 1
        && identity["sourceHash"].is_string()
        && source.is_some_and(|source| identity["sourceHash"] == source["sha256"])
        && identity["outputHash"].is_string()
        && identity["outputHash"] == output["sha256"]
        && identity["modelUnit"].as_str() == Some(model_unit(payload))
        && same_params(
            &identity["params"].as_object().cloned().unwrap_or_default(),
            &params_of(payload),
        )
}

/// Whether the render the payload claims was produced here: its job is a
/// succeeded `cad_render` of the identity's source and parameters, and it
/// wrote the identity's mesh.
fn rendered_here(handle: &ProjectHandle, payload: &Value) -> CoreResult<bool> {
    let identity = &payload["renderIdentity"];
    let Some(job_id) = payload["renderJobId"].as_str() else {
        return Ok(false);
    };
    let job = handle
        .db
        .query_row(
            "SELECT inputs, input_hashes, output_hashes FROM job \
             WHERE id=?1 AND kind='cad_render' AND status='succeeded'",
            [job_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(internal)?;
    let Some((inputs, input_hashes, output_hashes)) = job else {
        return Ok(false);
    };
    let parse = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    let (inputs, input_hashes, output_hashes) =
        (parse(&inputs), parse(&input_hashes), parse(&output_hashes));
    Ok(identity["sourceHash"].is_string()
        && input_hashes["source"] == identity["sourceHash"]
        && identity["outputHash"].is_string()
        && output_hashes["stl"] == identity["outputHash"]
        && same_params(
            &inputs["params"].as_object().cloned().unwrap_or_default(),
            &identity["params"].as_object().cloned().unwrap_or_default(),
        ))
}

/// File-scope `name = expression;` statements of an OpenSCAD source, keyed by
/// name. Used only to tell whether a declaration changed between two sources,
/// so both sides are read the same way.
fn declarations(source: &str) -> HashMap<String, String> {
    let comments = Regex::new(r"(?s)/\*.*?\*/|//[^\n]*").expect("comment pattern");
    let assignment =
        Regex::new(r"(?s)^\s*([A-Za-z_$][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$").expect("assignment");
    let code = comments.replace_all(source, " ");
    let mut found = HashMap::new();
    let mut statement = String::new();
    let mut depth = 0usize;
    for ch in code.chars() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    statement.clear();
                }
            }
            ';' if depth == 0 => {
                if let Some(captures) = assignment.captures(&statement) {
                    let expression = captures[2].split_whitespace().collect::<Vec<_>>().join(" ");
                    found.insert(captures[1].to_owned(), expression);
                }
                statement.clear();
            }
            _ if depth == 0 => statement.push(ch),
            _ => {}
        }
    }
    found
}

fn read_source(handle: &ProjectHandle, hash: &str) -> CoreResult<String> {
    let bytes = handle
        .object_store()
        .map_err(storage_error)?
        .read(hash)
        .map_err(storage_error)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// An override inherited from the parent revision stays only while the source
/// still declares that parameter the same way. A declaration the author
/// rewrote, or removed, is the author's decision and must not be overridden
/// by a value recorded for the previous source.
fn drop_superseded_overrides(
    handle: &ProjectHandle,
    payload: &mut Value,
    parent_payload: &Value,
    source_hash: &str,
    parent_source_hash: &str,
) -> CoreResult<()> {
    let inherited = params_of(parent_payload);
    if inherited.is_empty() {
        return Ok(());
    }
    let current = declarations(&read_source(handle, source_hash)?);
    let previous = declarations(&read_source(handle, parent_source_hash)?);
    let Some(params) = payload["params"].as_object_mut() else {
        return Ok(());
    };
    for (name, value) in &inherited {
        let still_applies = current
            .get(name)
            .is_some_and(|now| previous.get(name).is_none_or(|before| before == now));
        if !still_applies && params.get(name).is_some_and(|kept| same_value(kept, value)) {
            params.shift_remove(name);
        }
    }
    Ok(())
}

/// Brings a mechanical payload and its files in line with each other before
/// the revision is stored. `payload` has already passed the mechanical schema.
pub(crate) fn normalize(
    handle: &ProjectHandle,
    mut payload: Value,
    mut files: Vec<Value>,
    parent: Option<&Value>,
) -> CoreResult<(Value, Vec<Value>)> {
    let source = source_ref(&payload, &files);
    let source_hash = source.as_ref().and_then(|s| s["sha256"].as_str());
    let mirror_outdated = payload
        .get("scad")
        .is_some_and(|mirror| mirror["sha256"].as_str() != source_hash);
    let parent_source = parent.and_then(|parent| {
        source_ref(
            &parent["payload"],
            parent["files"].as_array().map(Vec::as_slice).unwrap_or(&[]),
        )
    });
    let parent_source_hash = parent_source.as_ref().and_then(|s| s["sha256"].as_str());
    if let (Some(parent), Some(hash), Some(parent_hash)) = (parent, source_hash, parent_source_hash)
    {
        if hash != parent_hash && !render_matches(&payload, &files, source.as_ref()) {
            drop_superseded_overrides(handle, &mut payload, &parent["payload"], hash, parent_hash)?;
        }
    }
    let input_changed = parent.is_some_and(|parent| {
        parent_source_hash != source_hash
            || !same_params(&params_of(&parent["payload"]), &params_of(&payload))
            || model_unit(&parent["payload"]) != model_unit(&payload)
    });
    let outdated = mirror_outdated
        || if payload.get("renderIdentity").is_some() {
            !render_matches(&payload, &files, source.as_ref()) || !rendered_here(handle, &payload)?
        } else {
            input_changed
        };
    if let (Some(source), Some(fields)) = (source, payload.as_object_mut()) {
        fields.insert("scad".into(), source);
    }
    if outdated {
        if let Some(fields) = payload.as_object_mut() {
            for key in DERIVED {
                fields.shift_remove(key);
            }
        }
        files.retain(|file| {
            file["role"] != "output" && !file["path"].as_str().is_some_and(|p| p.ends_with(".stl"))
        });
    }
    Ok((payload, files))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project() -> (tempfile::TempDir, ProjectHandle) {
        let temp = tempfile::tempdir().unwrap();
        let handle = ProjectHandle::create(temp.path().join("project"), "Parts", "test").unwrap();
        (temp, handle)
    }

    fn put(handle: &ProjectHandle, text: &str) -> String {
        handle.object_store().unwrap().put(text.as_bytes()).unwrap()
    }

    /// The job a render of this core records: succeeded, on this source and
    /// these parameters, with this mesh.
    fn render_job(
        handle: &ProjectHandle,
        source_hash: &str,
        params: &Value,
        mesh_hash: &str,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        handle
            .db
            .execute(
                "INSERT INTO job(id,kind,tool,inputs,input_hashes,status,output_hashes,created_at) \
                 VALUES(?1,'cad_render','openscad',?2,?3,'succeeded',?4,'2026-10-01T10:00:00.000Z')",
                rusqlite::params![
                    id,
                    json!({"params": params}).to_string(),
                    json!({"source": source_hash}).to_string(),
                    json!({"stl": mesh_hash}).to_string()
                ],
            )
            .unwrap();
        id
    }

    /// A rendered revision: source, mesh, bounds and a matching identity.
    fn rendered(handle: &ProjectHandle, source: &str, params: Value) -> Value {
        let source_hash = put(handle, source);
        let mesh_hash = put(handle, &format!("mesh of {source} {params}"));
        let job = render_job(handle, &source_hash, &params, &mesh_hash);
        json!({
            "payload": {
                "scad": {"path": "artifacts/mechanical/plate.scad", "sha256": source_hash, "role": "source"},
                "stl": {"path": "artifacts/mechanical/plate.stl", "sha256": mesh_hash, "role": "output"},
                "params": params, "paramManifest": [], "modelUnit": "mm",
                "bounds": {"min": [0, 0, 0], "max": [20, 10, 2]},
                "renderJobId": job,
                "renderIdentity": {"version": 1, "sourceHash": source_hash, "params": params,
                    "modelUnit": "mm", "frame": "right-handed-z-up", "engine": "openscad",
                    "engineVersion": "2021.01", "options": "stl", "inputFingerprint": "f",
                    "outputHash": mesh_hash},
            },
            "files": [
                {"path": "artifacts/mechanical/plate.scad", "sha256": source_hash, "role": "source"},
                {"path": "artifacts/mechanical/plate.stl", "sha256": mesh_hash, "role": "output"},
            ],
        })
    }

    fn files_of(revision: &Value) -> Vec<Value> {
        revision["files"].as_array().unwrap().clone()
    }

    #[test]
    fn an_unchanged_rendered_revision_keeps_its_geometry() {
        let (_temp, handle) = project();
        let parent = rendered(
            &handle,
            "width = 20;\ncube([width, 10, 2]);",
            json!({"width": 20.0}),
        );
        // The interface writes whole numbers without a fraction.
        let mut payload = parent["payload"].clone();
        payload["params"] = json!({"width": 20});
        let (body, files) = normalize(&handle, payload, files_of(&parent), Some(&parent)).unwrap();
        assert!(body["renderIdentity"].is_object());
        assert_eq!(body["stl"], parent["payload"]["stl"]);
        assert_eq!(files.len(), 2);
    }

    #[test]
    fn changed_parameters_remove_every_derived_output() {
        let (_temp, handle) = project();
        let parent = rendered(
            &handle,
            "width = 20;\ncube([width, 10, 2]);",
            json!({"width": 20}),
        );
        let mut payload = parent["payload"].clone();
        payload["params"] = json!({"width": 30});
        let (body, files) = normalize(&handle, payload, files_of(&parent), Some(&parent)).unwrap();
        for key in DERIVED {
            assert!(body.get(key).is_none(), "{key} survived");
        }
        assert_eq!(body["params"], json!({"width": 30}));
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "artifacts/mechanical/plate.scad");
    }

    #[test]
    fn a_new_source_refreshes_the_mirror_and_drops_only_overrides_it_redeclares() {
        let (_temp, handle) = project();
        let parent = rendered(
            &handle,
            "width = 20;\ndepth = 10;\nlegacy = 1;\ncube([width, depth, 2]);",
            json!({"width": 25, "depth": 12, "legacy": 3}),
        );
        let edited = "width = 40; // widened by hand\ndepth = 10;\ncube([width, depth, 2]);";
        let edited_hash = put(&handle, edited);
        let mut files = files_of(&parent);
        files[0]["sha256"] = json!(edited_hash);
        let (body, files) =
            normalize(&handle, parent["payload"].clone(), files, Some(&parent)).unwrap();
        assert_eq!(body["scad"]["sha256"], edited_hash);
        assert_eq!(body["params"], json!({"depth": 12}));
        assert!(body.get("renderIdentity").is_none() && body.get("stl").is_none());
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn an_override_changed_in_the_same_edit_is_kept_as_written() {
        let (_temp, handle) = project();
        let parent = rendered(
            &handle,
            "width = 20;\ncube([width, 10, 2]);",
            json!({"width": 25}),
        );
        let edited_hash = put(&handle, "width = 40;\ncube([width, 10, 2]);");
        let mut files = files_of(&parent);
        files[0]["sha256"] = json!(edited_hash);
        let mut payload = parent["payload"].clone();
        payload["params"] = json!({"width": 50});
        let (body, _) = normalize(&handle, payload, files, Some(&parent)).unwrap();
        assert_eq!(body["params"], json!({"width": 50}));
    }

    #[test]
    fn a_revision_without_a_render_identity_follows_its_parent_inputs() {
        let (_temp, handle) = project();
        let mut parent = rendered(&handle, "cube(5);", json!({}));
        parent["payload"]
            .as_object_mut()
            .unwrap()
            .shift_remove("renderIdentity");
        let (same, same_files) = normalize(
            &handle,
            parent["payload"].clone(),
            files_of(&parent),
            Some(&parent),
        )
        .unwrap();
        assert!(same["stl"].is_object());
        assert_eq!(same_files.len(), 2);
        let mut payload = parent["payload"].clone();
        payload["modelUnit"] = json!("cm");
        let (changed, changed_files) =
            normalize(&handle, payload, files_of(&parent), Some(&parent)).unwrap();
        assert!(changed.get("stl").is_none() && changed.get("bounds").is_none());
        assert_eq!(changed_files.len(), 1);
    }

    #[test]
    fn a_render_identity_this_core_did_not_produce_is_removed() {
        let (_temp, handle) = project();
        let genuine = rendered(&handle, "cube(5);", json!({}));
        let (kept, kept_files) = normalize(
            &handle,
            genuine["payload"].clone(),
            files_of(&genuine),
            None,
        )
        .unwrap();
        assert!(kept["renderIdentity"].is_object());
        assert_eq!(kept_files.len(), 2);

        // Self-consistent hashes, attached files and a job id are not enough:
        // the job must have rendered this source into this mesh.
        let forged_mesh = put(&handle, "a 40 x 30 x 4 box");
        let mut forged = genuine["payload"].clone();
        forged["stl"]["sha256"] = json!(forged_mesh);
        forged["renderIdentity"]["outputHash"] = json!(forged_mesh);
        let mut files = files_of(&genuine);
        files[1]["sha256"] = json!(forged_mesh);
        let without_job = {
            let mut payload = forged.clone();
            payload["renderJobId"] = json!(uuid::Uuid::new_v4().to_string());
            payload
        };
        let other_params = {
            let mut payload = genuine["payload"].clone();
            payload["params"] = json!({"size": 40});
            payload["renderIdentity"]["params"] = json!({"size": 40});
            payload
        };
        for (payload, files) in [
            (forged, files.clone()),
            (without_job, files),
            (other_params, files_of(&genuine)),
        ] {
            let (body, files) = normalize(&handle, payload, files, None).unwrap();
            for key in DERIVED {
                assert!(body.get(key).is_none(), "{key} survived");
            }
            assert_eq!(files.len(), 1);
            assert_eq!(files[0]["role"], "source");
        }
    }

    #[test]
    fn declarations_ignore_comments_modules_and_layout() {
        let found = declarations(
            "/* width = 1; */\nwidth   =  20 ; // mm\nmodule m() { inner = 3; }\n\
             function f(x) = x * 2;\nsize = [width,\n  10];\n",
        );
        assert_eq!(found.get("width").map(String::as_str), Some("20"));
        assert_eq!(found.get("size").map(String::as_str), Some("[width, 10]"));
        assert_eq!(found.len(), 2);
    }
}
