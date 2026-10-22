//! Guidance an agent receives: the playbooks served by `guide.read`, the
//! short always-on instructions returned by MCP `initialize`, the text passed
//! to a CLI through its system-prompt channel, and the bounded block written
//! to a project's `AGENTS.md` for CLIs that have no other channel.

use omenflow_contracts::{nearest_match, registry, ContractError, Profile};
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::ops::Range;
use std::path::Path;

pub struct Topic {
    pub id: &'static str,
    /// When an agent should read it; shown in the topic list.
    pub when: &'static str,
    text: &'static str,
}

impl Topic {
    /// The playbook's heading.
    pub fn title(&self) -> &'static str {
        self.text
            .lines()
            .next()
            .unwrap_or_default()
            .trim_start_matches('#')
            .trim()
    }

    pub fn text(&self) -> &'static str {
        self.text.trim()
    }
}

macro_rules! topic {
    ($id:literal, $when:literal) => {
        Topic {
            id: $id,
            when: $when,
            text: include_str!(concat!("../guides/", $id, ".md")),
        }
    };
}

/// Every playbook, in the order an agent would meet them.
pub const TOPICS: [Topic; 10] = [
    topic!(
        "start",
        "First, in every session, or when unsure what to do next."
    ),
    topic!(
        "requirements",
        "Before recording what the design must do or assumes."
    ),
    topic!(
        "parts",
        "Before researching, recording or selecting bought components."
    ),
    topic!("cad", "Before creating or changing a mechanical part."),
    topic!(
        "cad-verify",
        "After a part renders, before saying it is correct."
    ),
    topic!("wiring", "Before recording pins and connections."),
    topic!("calculation", "Before running or recording a calculation."),
    topic!(
        "tests",
        "Before writing a test plan or recording an observation."
    ),
    topic!(
        "review",
        "When the person asks for review, or a reviewer sent changes back."
    ),
    topic!("finish", "Before your final answer."),
];

/// The playbook for a topic id as an agent might type it: any letter case,
/// `cad_verify` or `cad verify` for `cad-verify`.
pub fn topic(id: &str) -> Option<&'static Topic> {
    let wanted = id.trim().to_lowercase().replace(['_', ' '], "-");
    TOPICS.iter().find(|topic| topic.id == wanted)
}

/// `guide.read`: `{ topic, title, text, topics: [{ id, title, when }] }`. No
/// topic returns `start`.
pub fn read(input: &Value) -> Result<Value, ContractError> {
    let requested = input["topic"].as_str().map(str::trim).unwrap_or_default();
    let found = if requested.is_empty() {
        &TOPICS[0]
    } else {
        topic(requested).ok_or_else(|| unknown_topic(requested))?
    };
    Ok(json!({
        "topic": found.id,
        "title": found.title(),
        "text": found.text(),
        "topics": TOPICS
            .iter()
            .map(|topic| json!({"id": topic.id, "title": topic.title(), "when": topic.when}))
            .collect::<Vec<_>>(),
    }))
}

fn unknown_topic(requested: &str) -> ContractError {
    let ids = TOPICS.iter().map(|topic| topic.id).collect::<Vec<_>>();
    let nearest = nearest_match(requested, ids.iter().copied());
    let suggestion = nearest.map_or_else(String::new, |id| format!("Did you mean {id}? "));
    ContractError::new("NOT_FOUND", format!("Unknown guide topic: {requested}"))
        .with_repair(format!(
            "{suggestion}Call guide_read with one of: {}.",
            ids.join(", ")
        ))
        .with_details(json!({
            "tool": "guide_read",
            "topics": ids,
            "nearest": nearest,
            "example": {"topic": nearest.unwrap_or("start")},
        }))
}

/// Number of tools a profile lists.
pub fn tool_count(profile: Profile) -> usize {
    registry().tools_for(profile).count()
}

/// The scope rule every profile carries.
const ONLY_WHAT_WAS_ASKED: &str =
    "Do only what was asked. Do not export, propose or request review unless the person asked.";

/// The always-on instructions for a session: what the server is, the loop to
/// follow, where the playbooks are and the completion gate. Returned by MCP
/// `initialize` and repeated at the top of the launch guidance, because no
/// single channel reaches every CLI.
pub fn instructions(profile: Profile) -> String {
    let mut lines = vec![
        "Omen Flow is the engineering workspace for this project. These tools are the only way to read and change it: files under artifacts/ are read-only mirrors. You author drafts; only the human approves them."
            .to_owned(),
        String::new(),
        "1. Call project_summary first.".to_owned(),
        "2. Before each kind of work, call guide_read for a playbook (topics: requirements, parts, cad, cad-verify, wiring, calculation, tests, review, finish) and follow its steps."
            .to_owned(),
        "3. Copy ids exactly from earlier results. Keep units with numbers, written as unit symbols (g, kg, mm, s, h, V, A, mAh, Wh), never as words. Write a value that is not known as {\"unknown\": true, \"reason\": \"...\"}; never invent data."
            .to_owned(),
        "4. When a call fails, read issues, repair and example in the reply and correct the same call."
            .to_owned(),
    ];
    match profile {
        Profile::Compact => {
            lines.push(
                "5. Tools that are not listed: tool_describe lists every tool and shows its arguments; tool_call runs it."
                    .to_owned(),
            );
            lines.push(format!("6. {ONLY_WHAT_WAS_ASKED}"));
        }
        Profile::Standard | Profile::Full => {
            lines.push(
                "5. Parts: cad_write_source returns a measured report; compare it with the request, then cad_check with exploratory true, then the identical expect with exploratory false. Only verificationStatus \"passed\" with ready true is verified."
                    .to_owned(),
            );
            lines.push(
                "6. Bought parts count only when recorded: research_read_page, source_capture, component_add_candidate, then component_compare to read back."
                    .to_owned(),
            );
            lines.push(if profile == Profile::Standard {
                "7. Tools that are not listed: tool_describe lists every tool and shows its arguments; tool_call runs it."
                    .to_owned()
            } else {
                "7. tool_describe returns any tool's schema with an example, and the payload fields of an artifact type."
                    .to_owned()
            });
            lines.push(format!("8. {ONLY_WHAT_WAS_ASKED}"));
        }
    }
    let last = lines.len() - 1;
    lines.push(format!(
        "{last}. Call work_status before you finish. Say the work is done only when ready is true; otherwise name every blocker."
    ));
    lines.join("\n")
}

/// The text handed to a CLI through its own instruction channel (a system
/// prompt file, developer instructions). Larger profiles also get the
/// playbooks most sessions need, so a capable model does not spend a call on
/// them; a compact session reads them on demand.
pub fn launch_guidance(profile: Profile, project_name: &str, project_root: &Path) -> String {
    let mut text = format!(
        "# Omen Flow session\n\nProject: {project_name}\nFolder: {}\nProfile: {profile} ({} tools listed)\n\n{}\n\nIf the omenflow tools are missing from your tool list, use the shell instead: `omenflow guide [topic]`, `omenflow status`, `omenflow call <tool> --input <file|->` and `omenflow call <tool> --help`.",
        project_root.display(),
        tool_count(profile),
        instructions(profile),
    );
    let included: &[&str] = match profile {
        Profile::Compact => &[],
        Profile::Standard => &["start"],
        Profile::Full => &["start", "cad", "cad-verify"],
    };
    for id in included {
        let playbook = topic(id).expect("embedded playbook");
        text.push_str("\n\n---\n\n");
        text.push_str(playbook.text());
    }
    text.push('\n');
    text
}

/// Marker the unbounded guide of earlier builds started with.
const LEGACY_MARKER: &str = "<!-- omenflow:agent-guide -->";
/// First heading of every version of that guide.
const LEGACY_HEADING: &str = "# Working in this Omen Flow project";
/// Last section and last sentence of every version of that guide.
const LEGACY_LAST_SECTION: &str = "## Efficiency";
const LEGACY_LAST_SENTENCE: &str = "request review unless asked.";

const BLOCK_BEGIN: &str = "<!-- omenflow:guide:begin";
const BLOCK_END: &str = "<!-- omenflow:guide:end -->";

/// The block for a CLI whose only guidance channel is the project's
/// `AGENTS.md`. It scopes itself to an Omen Flow session, because the file is
/// also read by agents started outside one.
pub fn agents_block() -> String {
    format!(
        "{BLOCK_BEGIN} (maintained by Omen Flow; text between the markers is replaced) -->\n\
## Omen Flow agent session\n\
\n\
This section applies only inside an Omen Flow agent session, where the environment variable OMENFLOW_SESSION_ID is set. Outside one, ignore it.\n\
\n\
- This folder is an Omen Flow engineering project. Read and change it only through the `omenflow` command or its MCP tools (`omenflow mcp`). Files under `artifacts/` are read-only mirrors.\n\
- Start with `omenflow guide`, then `omenflow call project_summary`.\n\
- Call a tool with `omenflow call <tool> --input <file|->`; `omenflow call <tool> --help` prints its arguments.\n\
- You author drafts. Only the human approves them.\n\
- Before you say the work is done, run `omenflow status` and resolve or name every blocker.\n\
{BLOCK_END}"
    )
}

/// The next content of a project's `AGENTS.md`, or `None` when the file is
/// already right. With `wanted` the bounded block is present exactly once;
/// without it the block is absent. The unbounded guide earlier builds wrote
/// is removed either way. Text the person wrote is never touched: when the
/// extent of Omen Flow's own text cannot be established, it is left alone.
pub fn agents_md_next(existing: &str, wanted: bool) -> Option<String> {
    let mut text = existing.to_owned();
    if let Some(span) = legacy_guide_span(&text) {
        text = without(&text, span);
    }
    let begin = text.find(BLOCK_BEGIN);
    let block = begin.and_then(|begin| {
        text[begin..]
            .find(BLOCK_END)
            .map(|end| begin..begin + end + BLOCK_END.len())
    });
    match (begin, block, wanted) {
        // A begin marker whose end marker is gone bounds nothing.
        (Some(_), None, _) => {}
        (_, Some(span), true) => text.replace_range(span, &agents_block()),
        (_, Some(span), false) => text = without(&text, span),
        (None, None, true) => {
            let head = text.trim_end();
            text = if head.is_empty() {
                format!("{}\n", agents_block())
            } else {
                format!("{head}\n\n{}\n", agents_block())
            };
        }
        (None, None, false) => {}
    }
    (text != existing).then_some(text)
}

/// The byte range of the unbounded guide, from its marker through its last
/// sentence. Every version started with the same heading and ended with the
/// same sentence, so the range is exact whatever version the project holds
/// and whatever the person added below it.
fn legacy_guide_span(text: &str) -> Option<Range<usize>> {
    let start = text.find(LEGACY_MARKER)?;
    let body = &text[start + LEGACY_MARKER.len()..];
    if !body.trim_start().starts_with(LEGACY_HEADING) {
        return None;
    }
    let section = body.find(LEGACY_LAST_SECTION)?;
    let sentence = body[section..].find(LEGACY_LAST_SENTENCE)?;
    let end = start + LEGACY_MARKER.len() + section + sentence + LEGACY_LAST_SENTENCE.len();
    Some(start..end)
}

/// `text` with `span` cut out and the two sides joined by one blank line.
fn without(text: &str, span: Range<usize>) -> String {
    let head = text[..span.start].trim_end();
    let tail = text[span.end..].trim_start();
    match (head.is_empty(), tail.is_empty()) {
        (true, true) => String::new(),
        (true, false) => tail.to_owned(),
        (false, true) => format!("{head}\n"),
        (false, false) => format!("{head}\n\n{tail}"),
    }
}

/// Bring `<project>/AGENTS.md` in line with what the session's adapter needs.
/// A file that cannot be read as text is left untouched; a file that held
/// only Omen Flow's text and now holds nothing is removed.
pub fn sync_agents_md(project_root: &Path, wanted: bool) -> io::Result<()> {
    let path = project_root.join("AGENTS.md");
    let existing = match fs::read(&path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => return Ok(()),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(_) => return Ok(()),
    };
    match agents_md_next(&existing, wanted) {
        None => Ok(()),
        Some(next) if next.is_empty() => fs::remove_file(&path),
        Some(next) => fs::write(&path, next),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Longest playbook, in characters.
    const PLAYBOOK_LIMIT: usize = 2_400;
    /// Longest MCP `initialize.instructions`, in characters. Claude Code
    /// cuts server instructions at 2,048.
    const INSTRUCTIONS_LIMIT: usize = 1_800;
    /// The guide as the last build before bounded blocks wrote it.
    const LEGACY_GUIDE: &str = include_str!("testdata/legacy-agents-guide.md");

    #[test]
    fn every_playbook_meets_the_contract() {
        let ids = TOPICS.iter().map(|topic| topic.id).collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                "start",
                "requirements",
                "parts",
                "cad",
                "cad-verify",
                "wiring",
                "calculation",
                "tests",
                "review",
                "finish"
            ]
        );
        for topic in &TOPICS {
            let text = topic.text();
            let length = text.chars().count();
            assert!(
                length <= PLAYBOOK_LIMIT,
                "{} is {length} characters",
                topic.id
            );
            assert!(text.starts_with("# "), "{} has no heading", topic.id);
            assert!(!topic.title().is_empty());
            assert!(
                text.lines().any(|line| line.starts_with("1. "))
                    && text.lines().any(|line| line.starts_with("2. ")),
                "{} has no numbered steps",
                topic.id
            );
            assert!(
                text.trim_end_matches('.')
                    .ends_with("then call work_status"),
                "{} does not end with the completion gate",
                topic.id
            );
            assert!(topic.when.chars().count() <= 80);
        }
    }

    /// A playbook that names a tool the registry does not have, or names one
    /// by its dotted operation name, sends a model to a dead end.
    #[test]
    fn playbooks_and_instructions_name_real_tools_by_underscore_name() {
        let mut texts = TOPICS
            .iter()
            .map(|topic| (topic.id.to_owned(), topic.text().to_owned()))
            .collect::<Vec<_>>();
        for profile in Profile::ALL {
            texts.push((format!("instructions {profile}"), instructions(profile)));
        }
        texts.push(("AGENTS.md block".to_owned(), agents_block()));
        let namespaces = registry()
            .operations
            .iter()
            .filter_map(|op| op.name.split_once('.').map(|(namespace, _)| namespace))
            .collect::<std::collections::BTreeSet<_>>();
        for (name, text) in &texts {
            for op in &registry().operations {
                assert!(
                    !text.contains(&op.name),
                    "{name} uses the dotted name {}",
                    op.name
                );
            }
            for word in text
                .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
                .filter(|word| word.contains('_'))
            {
                let Some((namespace, _)) = word.split_once('_') else {
                    continue;
                };
                if !namespaces.contains(namespace) {
                    continue;
                }
                let op = registry().resolve(word);
                assert!(
                    op.is_some_and(|op| op.agent_allowed && op.tool_name == word),
                    "{name} names {word}, which is not an agent tool"
                );
            }
        }
    }

    #[test]
    fn read_returns_the_playbook_and_the_topic_list() {
        let start = read(&json!({})).unwrap();
        assert_eq!(start["topic"], "start");
        assert_eq!(start["title"], "Start a session");
        assert!(start["text"].as_str().unwrap().contains("project_summary"));
        let topics = start["topics"].as_array().unwrap();
        assert_eq!(topics.len(), 10);
        assert_eq!(
            topics[4],
            json!({"id": "cad-verify", "title": "Verify a part",
                   "when": "After a part renders, before saying it is correct."})
        );
        for spelling in ["cad-verify", "cad_verify", " CAD-Verify ", "cad verify"] {
            assert_eq!(
                read(&json!({"topic": spelling})).unwrap()["topic"],
                "cad-verify"
            );
        }
        assert_eq!(read(&json!({"topic": ""})).unwrap()["topic"], "start");
    }

    #[test]
    fn an_unknown_topic_says_which_topics_exist() {
        let error = read(&json!({"topic": "cad-verfy"})).unwrap_err();
        assert_eq!(error.code, "NOT_FOUND");
        assert_eq!(error.message, "Unknown guide topic: cad-verfy");
        assert_eq!(
            error.repair.as_deref(),
            Some("Did you mean cad-verify? Call guide_read with one of: start, requirements, parts, cad, cad-verify, wiring, calculation, tests, review, finish.")
        );
        let details = error.details.unwrap();
        assert_eq!(details["nearest"], "cad-verify");
        assert_eq!(details["example"], json!({"topic": "cad-verify"}));
        let far = read(&json!({"topic": "zzzz"})).unwrap_err();
        assert!(far
            .repair
            .unwrap()
            .starts_with("Call guide_read with one of"));
    }

    #[test]
    fn instructions_fit_and_carry_the_loop_for_every_profile() {
        for profile in Profile::ALL {
            let text = instructions(profile);
            let length = text.chars().count();
            assert!(length <= INSTRUCTIONS_LIMIT, "{profile}: {length}");
            for needle in [
                "project_summary",
                "guide_read for a playbook",
                "work_status before you finish",
                "only the human approves",
            ] {
                assert!(text.contains(needle), "{profile} lacks {needle:?}");
            }
        }
        let compact = instructions(Profile::Compact);
        assert!(compact.chars().count() <= 1_200);
        assert!(compact.contains("tool_call runs it"));
        assert!(compact.contains("\n6. Do only what was asked."));
        assert!(compact.contains("\n7. Call work_status"));
        assert!(instructions(Profile::Standard).contains("tool_call runs it"));
        let full = instructions(Profile::Full);
        assert!(!full.contains("not listed"));
        assert!(full.contains("\n9. Call work_status"));
    }

    #[test]
    fn launch_guidance_grows_with_the_profile() {
        let root = Path::new("/projects/rover");
        let compact = launch_guidance(Profile::Compact, "Sable rover", root);
        assert!(compact.starts_with(
            "# Omen Flow session\n\nProject: Sable rover\nFolder: /projects/rover\nProfile: compact (15 tools listed)\n\n"
        ));
        assert!(compact.contains(&instructions(Profile::Compact)));
        assert!(compact.contains("`omenflow status`"));
        assert!(!compact.contains("# Start a session"));
        let standard = launch_guidance(Profile::Standard, "Sable rover", root);
        assert!(standard.contains("# Start a session"));
        assert!(!standard.contains("# Verify a part"));
        let full = launch_guidance(Profile::Full, "Sable rover", root);
        for heading in [
            "# Start a session",
            "# Model a part in OpenSCAD",
            "# Verify a part",
        ] {
            assert!(full.contains(heading));
        }
        println!(
            "launch guidance chars (compact, standard, full): {:?}; instructions: {:?}",
            [&compact, &standard, &full].map(|text| text.chars().count()),
            Profile::ALL.map(|profile| instructions(profile).chars().count())
        );
        assert!(compact.len() < standard.len() && standard.len() < full.len());
        // Codex carries this as one -c value; the verified size was 6.1 KB.
        assert!(full.len() <= 9_000, "full guidance is {}", full.len());
        assert!(
            compact.len() <= 1_600,
            "compact guidance is {}",
            compact.len()
        );
    }

    #[test]
    fn the_block_is_added_once_and_removed_cleanly() {
        let block = agents_block();
        assert!(block.chars().count() <= 1_000);
        assert_eq!(agents_md_next("", false), None);
        let created = agents_md_next("", true).unwrap();
        assert_eq!(created, format!("{block}\n"));
        assert_eq!(agents_md_next(&created, true), None);
        assert_eq!(agents_md_next(&created, false).unwrap(), "");

        let mine = "# My rules\n\nUse metric fasteners.\n";
        let appended = agents_md_next(mine, true).unwrap();
        assert_eq!(
            appended,
            format!("# My rules\n\nUse metric fasteners.\n\n{block}\n")
        );
        assert_eq!(agents_md_next(&appended, true), None);
        assert_eq!(agents_md_next(&appended, false).unwrap(), mine);
        assert_eq!(agents_md_next(mine, false), None);
    }

    #[test]
    fn text_around_the_block_survives_a_refresh() {
        let stale = format!(
            "Above.\n\n{BLOCK_BEGIN} old -->\nold text\n{BLOCK_END}\n\nBelow, written by the person.\n"
        );
        let refreshed = agents_md_next(&stale, true).unwrap();
        assert_eq!(
            refreshed,
            format!(
                "Above.\n\n{}\n\nBelow, written by the person.\n",
                agents_block()
            )
        );
        assert_eq!(
            agents_md_next(&stale, false).unwrap(),
            "Above.\n\nBelow, written by the person.\n"
        );
    }

    #[test]
    fn a_begin_marker_without_an_end_marker_is_left_alone() {
        let broken = format!("Notes.\n\n{BLOCK_BEGIN} -->\nhalf a block\n\nMore notes.\n");
        assert_eq!(agents_md_next(&broken, true), None);
        assert_eq!(agents_md_next(&broken, false), None);
    }

    #[test]
    fn the_unbounded_guide_of_earlier_builds_is_removed_and_nothing_else() {
        // A file Omen Flow created: only the guide.
        assert_eq!(agents_md_next(LEGACY_GUIDE, false).unwrap(), "");
        assert_eq!(
            agents_md_next(LEGACY_GUIDE, true).unwrap(),
            format!("{}\n", agents_block())
        );

        // The person's text above, and text they added below afterwards.
        let above = "# House rules\n\nTorque values in N·m.";
        let below = "## Suppliers\n\nPrefer local stock.\n";
        let file = format!("{above}\n\n{}\n\n{below}", LEGACY_GUIDE.trim_end());
        assert_eq!(
            agents_md_next(&file, false).unwrap(),
            format!("{above}\n\n{below}")
        );
        let with_block = agents_md_next(&file, true).unwrap();
        assert_eq!(
            with_block,
            format!("{above}\n\n{below}\n{}\n", agents_block())
        );
        assert!(!with_block.contains("OpenSCAD conventions that matter"));
        assert_eq!(agents_md_next(&with_block, true), None);
    }

    #[test]
    fn older_versions_of_the_guide_are_recognised_by_their_frame() {
        let older = format!(
            "{LEGACY_MARKER}\n{LEGACY_HEADING}\n\nAn earlier, shorter guide.\n\n## Efficiency\n- One `cad_write_source` + one `cad_check` is the ideal path. Do not export, propose, or\n  request review unless asked.\n"
        );
        assert_eq!(agents_md_next(&older, false).unwrap(), "");
        let kept = format!("Mine.\n\n{older}\nAlso mine.\n");
        assert_eq!(
            agents_md_next(&kept, false).unwrap(),
            "Mine.\n\nAlso mine.\n"
        );
    }

    #[test]
    fn a_marker_that_does_not_frame_the_guide_is_not_treated_as_ours() {
        // The marker quoted in the person's own notes.
        let quoted = format!("I removed the {LEGACY_MARKER} section by hand.\n");
        assert_eq!(agents_md_next(&quoted, false), None);
        // The guide with its tail edited away: its extent is unknown.
        let edited = format!("{LEGACY_MARKER}\n{LEGACY_HEADING}\n\nMy own rewrite of it.\n");
        assert_eq!(agents_md_next(&edited, false), None);
        let appended = agents_md_next(&edited, true).unwrap();
        assert!(appended.starts_with(&edited));
        assert!(appended.ends_with(&format!("{}\n", agents_block())));
    }

    #[test]
    fn sync_writes_removes_and_respects_unreadable_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("AGENTS.md");
        sync_agents_md(temp.path(), false).unwrap();
        assert!(!path.exists());
        sync_agents_md(temp.path(), true).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!("{}\n", agents_block())
        );
        sync_agents_md(temp.path(), false).unwrap();
        assert!(!path.exists(), "a file holding only our block is removed");

        fs::write(&path, LEGACY_GUIDE).unwrap();
        sync_agents_md(temp.path(), false).unwrap();
        assert!(
            !path.exists(),
            "a file holding only the old guide is removed"
        );

        let binary = [0xff_u8, 0xfe, 0x00, 0x41];
        fs::write(&path, binary).unwrap();
        sync_agents_md(temp.path(), true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), binary);
    }
}
