//! Pictures an agent asked to see (cad_view, image_view). The core writes
//! them under `.omenflow/cache/views-v1/` and names them in the result; they
//! are read back here, checked against their recorded hash and sent as MCP
//! image blocks after the text block. Picture bytes never enter the JSON
//! body, the ledger or an `omenflow call` reply.

use omenflow_core::pictures;
use serde_json::{json, Value};
use std::path::Path;

/// A picture to send with a reply.
pub(crate) struct Image {
    pub mime_type: &'static str,
    pub bytes: Vec<u8>,
}

/// Operations whose results name pictures.
pub(crate) fn produces(op: &str) -> bool {
    matches!(op, "cad.view" | "image.view")
}

/// Hosted CLIs known to show an MCP image block to the model. Claude Code
/// puts every non-text block of a result before its text. Codex turns image
/// blocks into input images, as long as the result carries no structured
/// content (see [`structured_content_hides_images`]).
fn shows_images(adapter_id: &str) -> bool {
    matches!(adapter_id, "claude-code" | "codex")
}

/// Codex hands the model a result's structured content instead of its
/// content blocks whenever both are present, so its images would be dropped
/// (codex-rs `protocol/src/models.rs`, `CallToolResult::
/// as_function_call_output_payload`, rust-v0.156.1). A tool that declares no
/// output schema may leave structured content out, and for Codex a reply
/// with pictures does.
pub(crate) fn structured_content_hides_images(adapter_id: &str) -> bool {
    adapter_id == "codex"
}

/// What a session whose client may not show the picture is told.
const ROUTE: &str =
    "Open images[0].path (relative to the project folder) with your image viewer (Codex: view_image).";

fn add_note(result: &mut Value, note: String) {
    if let Some(fields) = result.as_object_mut() {
        let notes = fields.entry("notes").or_insert_with(|| json!([]));
        if let Some(list) = notes.as_array_mut() {
            list.push(json!(note));
        }
    }
}

/// Read the pictures `result["images"]` names, under `root`, and mark each
/// entry `attached: true` or `false`. A picture is attached only when it is a
/// picture file in the views folder with the bytes it was recorded with, and
/// within the per-reply count and byte caps; the result says why one is not.
pub(crate) fn attach(root: Option<&Path>, result: &mut Value) -> Vec<Image> {
    let mut images = Vec::new();
    let mut reasons = Vec::<&str>::new();
    let mut total = 0;
    let Some(entries) = result.get_mut("images").and_then(Value::as_array_mut) else {
        return images;
    };
    let count = entries.len();
    for entry in entries.iter_mut() {
        let read = match root {
            None => Err("the project folder is not known"),
            Some(_) if images.len() >= pictures::PER_REPLY => Err("one picture per reply"),
            Some(root) => pictures::read_back(root, entry).and_then(|picture| {
                if total + picture.bytes.len() > pictures::REPLY_BYTES {
                    Err("the reply's picture bytes are spent")
                } else {
                    Ok(picture)
                }
            }),
        };
        match read {
            Ok(picture) => {
                total += picture.bytes.len();
                entry["attached"] = json!(true);
                images.push(Image {
                    mime_type: picture.mime_type,
                    bytes: picture.bytes,
                });
            }
            Err(reason) => {
                entry["attached"] = json!(false);
                if !reasons.contains(&reason) {
                    reasons.push(reason);
                }
            }
        }
    }
    let missing = count - images.len();
    if missing > 0 {
        add_note(
            result,
            format!(
                "{missing} of {count} images were not attached ({}); call cad_view or image_view again, or open images[i].path.",
                reasons.join("; ")
            ),
        );
    }
    images
}

/// Tell a session that may not see the picture where to find it: an
/// `omenflow call` caller always, an MCP client unless it is known to show
/// pictures.
pub(crate) fn route(result: &mut Value, over_mcp: bool, adapter_id: &str) {
    if !(over_mcp && shows_images(adapter_id)) {
        add_note(result, ROUTE.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(root: &Path, bytes: &[u8]) -> Value {
        let sha = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(bytes));
        let dir = root.join(pictures::DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{sha}.png")), bytes).unwrap();
        json!({"path": format!("{}/{sha}.png", pictures::DIR), "sha256": sha, "mimeType": "image/png"})
    }

    #[test]
    fn only_files_in_the_views_folder_with_their_recorded_hash_are_attached() {
        let root = tempfile::tempdir().unwrap();
        let good = png(root.path(), b"picture");
        let mut result = json!({"images": [good.clone()]});
        let images = attach(Some(root.path()), &mut result);
        assert_eq!(images.len(), 1);
        assert_eq!(
            (images[0].mime_type, images[0].bytes.as_slice()),
            ("image/png", &b"picture"[..])
        );
        assert_eq!(result["images"][0]["attached"], true);
        assert!(result.get("notes").is_none());

        let mut forged = good.clone();
        forged["path"] = json!("inputs/drawing.png");
        let changed = good.clone();
        std::fs::write(root.path().join(good["path"].as_str().unwrap()), b"altered").unwrap();
        for entry in [forged, changed] {
            let mut result = json!({"images": [entry], "notes": ["kept"]});
            assert!(attach(Some(root.path()), &mut result).is_empty());
            assert_eq!(result["images"][0]["attached"], false);
            assert_eq!(result["notes"][0], "kept");
            assert!(result["notes"][1]
                .as_str()
                .unwrap()
                .starts_with("1 of 1 images were not attached ("));
        }
        let mut unknown = json!({"images": [good]});
        assert!(attach(None, &mut unknown).is_empty());
        assert!(unknown["notes"][0]
            .as_str()
            .unwrap()
            .contains("the project folder is not known"));
    }

    #[test]
    fn a_reply_carries_one_picture_within_the_byte_caps() {
        let root = tempfile::tempdir().unwrap();
        let first = png(root.path(), b"first");
        let second = png(root.path(), b"second");
        let mut result = json!({"images": [first, second]});
        let images = attach(Some(root.path()), &mut result);
        assert_eq!(images.len(), pictures::PER_REPLY);
        assert_eq!(result["images"][1]["attached"], false);
        assert!(result["notes"][0]
            .as_str()
            .unwrap()
            .contains("1 of 2 images were not attached (one picture per reply)"));
        // A picture over the cap is refused by name, whatever its hash.
        let big = png(root.path(), &vec![1u8; pictures::PICTURE_BYTES + 1]);
        let mut result = json!({"images": [big]});
        assert!(attach(Some(root.path()), &mut result).is_empty());
        assert_eq!(result["images"][0]["attached"], false);
        const { assert!(pictures::PICTURE_BYTES * pictures::PER_REPLY <= pictures::REPLY_BYTES) };
    }

    #[test]
    fn sessions_that_may_not_see_the_picture_are_told_where_it_is() {
        for (over_mcp, adapter, told) in [
            (true, "claude-code", false),
            (true, "codex", false),
            (true, "custom", true),
            (true, "gemini", true),
            (true, "direct", true),
            (false, "claude-code", true),
        ] {
            let mut result = json!({"images": []});
            route(&mut result, over_mcp, adapter);
            assert_eq!(
                result.get("notes").is_some(),
                told,
                "{adapter} over mcp {over_mcp}"
            );
        }
        assert!(structured_content_hides_images("codex"));
        assert!(!structured_content_hides_images("claude-code"));
    }
}
