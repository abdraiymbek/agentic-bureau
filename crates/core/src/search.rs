//! Search over artifact titles and the content of each artifact's newest
//! revision. A query is ordinary text: every word is matched literally, so
//! quotes, hyphens, units and part numbers cannot break it.
use super::*;
use reads::{clip, format_quantity, statement};

const MAX_TERMS: usize = 12;
const MAX_TERM_CHARS: usize = 64;
/// As much readable content of one revision as a search looks at.
const READABLE_CHARS: usize = 20_000;
const SNIPPET_CHARS: usize = 180;
const SNIPPET_LEAD_CHARS: usize = 48;

/// Payload keys that hold hashes and render bookkeeping, not content.
const BOOKKEEPING_KEYS: [&str; 6] = [
    "sha256",
    "fileHash",
    "renderIdentity",
    "renderJobId",
    "paramManifest",
    "toolVersion",
];

struct Hit {
    artifact_id: String,
    revision_id: String,
    title: String,
    kind: String,
    review_state: Option<String>,
    payload: Value,
}

pub(super) fn project_search(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let query = required_str(input, "query")?.trim();
    let limit = input["limit"].as_i64().unwrap_or(20).max(1);
    let terms = terms(query);
    let mut matched = "all_terms";
    let mut hits = Vec::new();
    // The index cannot answer a query made only of punctuation, and a failure
    // inside it must not fail the search: both fall through to the scan.
    if !terms.is_empty() {
        hits = indexed(handle, &terms, " ", limit).unwrap_or_default();
        if hits.is_empty() && terms.len() > 1 {
            matched = "any_term";
            hits = indexed(handle, &terms, " OR ", limit).unwrap_or_default();
        }
    }
    if hits.is_empty() {
        matched = "substring";
        hits = scanned(handle, query, &terms, limit as usize)?;
    }
    if hits.is_empty() {
        matched = "none";
    }
    let words = words(&terms);
    let results = hits
        .into_iter()
        .map(|hit| {
            let text = readable(&hit.payload);
            json!({
                "artifactId": hit.artifact_id,
                "revisionId": hit.revision_id,
                "title": hit.title,
                "snippet": snippet(&text, query, &words),
                "type": hit.kind,
                "reviewState": hit.review_state,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({"results": results, "matched": matched}))
}

/// The words of a query the index can match: whitespace-separated pieces that
/// contain a letter or digit, without quote characters, each once.
fn terms(query: &str) -> Vec<String> {
    let mut terms = Vec::<String>::new();
    for piece in query.split_whitespace() {
        let term = piece
            .chars()
            .filter(|character| *character != '"')
            .take(MAX_TERM_CHARS)
            .collect::<String>();
        if term.chars().any(char::is_alphanumeric)
            && !terms.iter().any(|seen| seen.eq_ignore_ascii_case(&term))
        {
            terms.push(term);
        }
        if terms.len() == MAX_TERMS {
            break;
        }
    }
    terms
}

/// The runs of letters and digits inside the terms, lowercase: what the
/// index treats as tokens, and what a snippet highlights.
fn words(terms: &[String]) -> Vec<Vec<char>> {
    let mut words = Vec::<Vec<char>>::new();
    for term in terms {
        for run in term.split(|character: char| !character.is_alphanumeric()) {
            let word = fold(run);
            if !word.is_empty() && !words.contains(&word) {
                words.push(word);
            }
        }
    }
    words
}

/// One lowercase character per character, so positions in the folded text are
/// positions in the original.
fn fold(text: &str) -> Vec<char> {
    text.chars()
        .map(|character| character.to_lowercase().next().unwrap_or(character))
        .collect()
}

/// Ask the full-text index. Each term is a quoted phrase, which the index
/// reads as plain words whatever punctuation it contains.
fn indexed(
    handle: &ProjectHandle,
    terms: &[String],
    joiner: &str,
    limit: i64,
) -> CoreResult<Vec<Hit>> {
    let phrases = terms
        .iter()
        .map(|term| format!("\"{term}\""))
        .collect::<Vec<_>>()
        .join(joiner);
    let mut stmt = statement(
        handle,
        "SELECT artifact_fts.artifact_id, artifact_fts.revision_id, artifact_fts.title, a.type, \
         r.review_state, r.payload FROM artifact_fts \
         JOIN artifact a ON a.id=artifact_fts.artifact_id \
         LEFT JOIN revision r ON r.id=artifact_fts.revision_id \
         WHERE artifact_fts MATCH ?1 AND a.archived=0 \
         ORDER BY bm25(artifact_fts, 0.0, 0.0, 5.0, 1.0) LIMIT ?2",
    )?;
    let hits = stmt
        .query_map(params![phrases, limit], hit_from_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(hits)
}

fn hit_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Hit> {
    let payload: Option<String> = row.get(5)?;
    Ok(Hit {
        artifact_id: row.get(0)?,
        revision_id: row.get(1)?,
        title: row.get(2)?,
        kind: row.get(3)?,
        review_state: row.get(4)?,
        payload: payload
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null),
    })
}

/// Read every artifact's newest revision and keep those whose title or
/// readable content contains the query, even inside a word, or failing that
/// some of its terms as whole words. Slower than the index; needs none.
fn scanned(
    handle: &ProjectHandle,
    query: &str,
    terms: &[String],
    limit: usize,
) -> CoreResult<Vec<Hit>> {
    let whole = fold(query);
    if whole.is_empty() {
        return Ok(Vec::new());
    }
    let parts = terms.iter().map(|term| fold(term)).collect::<Vec<_>>();
    let mut stmt = statement(
        handle,
        "SELECT a.id, r.id, a.title, a.type, r.review_state, r.payload FROM artifact a \
         JOIN revision r ON r.id=(SELECT l.id FROM revision l WHERE l.artifact_id=a.id \
         ORDER BY l.seq DESC LIMIT 1) WHERE a.archived=0 ORDER BY a.created_at, a.id",
    )?;
    let rows = stmt.query_map([], hit_from_row).map_err(internal)?;
    let mut ranked = Vec::new();
    for (order, row) in rows.enumerate() {
        let hit = row.map_err(internal)?;
        let title = fold(&hit.title);
        let text = fold(&readable(&hit.payload));
        let rank = if contains(&title, &whole) {
            0
        } else if contains(&text, &whole) {
            1
        } else {
            let found = parts
                .iter()
                .filter(|part| {
                    !occurrences(&title, part, true).is_empty()
                        || !occurrences(&text, part, true).is_empty()
                })
                .count();
            if found == 0 {
                continue;
            }
            2 + parts.len() - found
        };
        ranked.push((rank, order, hit));
    }
    ranked.sort_by_key(|(rank, order, _)| (*rank, *order));
    Ok(ranked
        .into_iter()
        .take(limit)
        .map(|(_, _, hit)| hit)
        .collect())
}

fn contains(text: &[char], needle: &[char]) -> bool {
    !needle.is_empty() && text.windows(needle.len()).any(|window| window == needle)
}

/// A payload as a person reads it: `label: value` pairs with quantities and
/// their units, without hashes, ids or render bookkeeping.
fn readable(payload: &Value) -> String {
    let mut parts = Vec::new();
    describe(payload, None, &mut parts);
    clip(&parts.join(" · "), READABLE_CHARS)
}

fn describe(value: &Value, label: Option<&str>, parts: &mut Vec<String>) {
    let mut say = |text: &str| {
        parts.push(match label {
            Some(label) => format!("{label}: {text}"),
            None => text.to_owned(),
        });
    };
    match value {
        Value::Null => {}
        Value::Bool(_) | Value::Number(_) => say(&value.to_string()),
        Value::String(text) => {
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if !text.is_empty() && !is_identifier(&text) {
                say(&text);
            }
        }
        Value::Array(items) => {
            for item in items {
                describe(item, label, parts);
            }
        }
        Value::Object(map) => {
            if let Some(quantity) = format_quantity(value) {
                say(&quantity);
                return;
            }
            for (key, item) in map {
                if !BOOKKEEPING_KEYS.contains(&key.as_str()) {
                    describe(item, Some(&spaced(key)), parts);
                }
            }
        }
    }
}

/// `acceptanceCriterion` → `acceptance criterion`.
fn spaced(key: &str) -> String {
    let mut label = String::with_capacity(key.len() + 4);
    for character in key.chars() {
        if character.is_uppercase() && !label.is_empty() {
            label.push(' ');
        }
        label.extend(character.to_lowercase());
    }
    label
}

/// A UUID or a content hash: an address, not something to read or search.
fn is_identifier(text: &str) -> bool {
    let hex = |part: &str| part.chars().all(|character| character.is_ascii_hexdigit());
    (text.len() == 64 && hex(text))
        || (text.len() == 36
            && text.split('-').map(str::len).eq([8, 4, 4, 4, 12])
            && text.split('-').all(hex))
}

/// Where `needle` occurs in `text`. A word must stand alone, as the index
/// matched it; the whole query may sit inside a word, as the scan matched it.
fn occurrences(text: &[char], needle: &[char], alone: bool) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    if needle.is_empty() || needle.len() > text.len() {
        return found;
    }
    for start in 0..=text.len() - needle.len() {
        let end = start + needle.len();
        if text[start..end] != *needle {
            continue;
        }
        let bounded = (start == 0 || !text[start - 1].is_alphanumeric())
            && (end == text.len() || !text[end].is_alphanumeric());
        if bounded || !alone {
            found.push((start, end));
        }
    }
    found
}

/// A window of the readable text around the first match, with every match
/// inside it marked «like this».
fn snippet(text: &str, query: &str, words: &[Vec<char>]) -> String {
    let original = text.chars().collect::<Vec<_>>();
    let folded = fold(text);
    let mut marks = words
        .iter()
        .flat_map(|word| occurrences(&folded, word, true))
        .collect::<Vec<_>>();
    if marks.is_empty() {
        marks = occurrences(&folded, &fold(query), false);
    }
    marks.sort_unstable();
    let first = marks.first().map_or(0, |mark| mark.0);
    let mut start = first.saturating_sub(SNIPPET_LEAD_CHARS);
    if start > 0 {
        // Begin on a word, not inside one.
        start = (start..first)
            .find(|index| original[*index].is_whitespace())
            .map_or(start, |space| space + 1);
    }
    let mut end = (start + SNIPPET_CHARS).min(original.len());
    if end < original.len() {
        let floor = marks.first().map_or(start, |mark| mark.1);
        end = (floor..end)
            .rev()
            .find(|index| original[*index].is_whitespace())
            .unwrap_or(end);
    }
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    let mut open_until = None;
    for (index, character) in original.iter().enumerate().take(end).skip(start) {
        if open_until == Some(index) {
            out.push('»');
            open_until = None;
        }
        if open_until.is_none() {
            if let Some(mark) = marks.iter().find(|mark| mark.0 == index && mark.1 <= end) {
                out.push('«');
                open_until = Some(mark.1);
            }
        }
        out.push(*character);
    }
    if open_until.is_some() {
        out.push('»');
    }
    if end < original.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{agent, requirement, TestProject};

    fn project() -> (TestProject, String, String) {
        let mut project = TestProject::new();
        let mut payload = requirement("Carry a 300 g camera payload over rough ground");
        payload["target"] = json!({"value": 0.3, "unit": "kg"});
        let (need, _) = project.draft(
            Origin::User,
            "requirement",
            "Payload capacity",
            payload,
            json!([]),
        );
        let (servo, _) = project.draft(
            agent("s1"),
            "component",
            "Steering servo",
            json!({
                "partNumber": "MG996R",
                "manufacturer": "TowerPro",
                "properties": {"stallTorque": {"quantity": {"value": 11, "unit": "kg*cm"}}},
                "attributes": {"gears": {"value": "metal"}}
            }),
            json!([]),
        );
        project.draft(
            Origin::User,
            "note",
            "Power notes",
            json!({"markdown": "Regulated 5 V rail (logic) fed from the 7.4 V pack through an M3-mounted BEC."}),
            json!([]),
        );
        (project, need, servo)
    }

    fn search(project: &mut TestProject, query: &str) -> Value {
        project.user("project.search", json!({"query": query}))
    }

    fn found(result: &Value) -> Vec<&str> {
        result["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|hit| hit["title"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn ordinary_text_never_fails_whatever_punctuation_it_carries() {
        let (mut project, _, _) = project();
        let long = "torque ".repeat(400);
        for query in [
            "\"",
            "\"\"",
            "\"unterminated",
            "say \"hi\"",
            "M3-bolt",
            "5 V",
            "5V rail (regulated)",
            "what's the mass",
            "a.b",
            "mass/torque",
            "NOT motor",
            "AND",
            "OR OR",
            "NEAR(a b)",
            "*",
            "^",
            "title:mass",
            "col:",
            "100%",
            "_",
            "\\",
            "-",
            "(",
            "°C",
            "7.4 V",
            "kg*cm",
            "电机 🚀",
            "' OR 1=1 --",
            long.as_str(),
        ] {
            let result = project
                .call(Origin::User, "project.search", json!({"query": query}))
                .unwrap_or_else(|error| panic!("search for {query:?} failed: {error:?}"));
            assert!(result["results"].is_array(), "{query:?}");
            assert!(result["matched"].is_string(), "{query:?}");
        }
    }

    #[test]
    fn units_part_numbers_and_hyphens_find_their_records() {
        let (mut project, need, servo) = project();

        let part = search(&mut project, "MG996R");
        assert_eq!(found(&part), ["Steering servo"]);
        assert_eq!(part["matched"], "all_terms");
        assert_eq!(part["results"][0]["artifactId"], servo.as_str());
        assert_eq!(part["results"][0]["type"], "component");
        assert_eq!(part["results"][0]["reviewState"], "draft");

        assert_eq!(found(&search(&mut project, "5 V")), ["Power notes"]);
        assert_eq!(
            found(&search(&mut project, "\"5 V\" rail (logic)")),
            ["Power notes"]
        );
        assert_eq!(found(&search(&mut project, "M3-mounted")), ["Power notes"]);
        assert_eq!(found(&search(&mut project, "kg*cm")), ["Steering servo"]);
        assert_eq!(found(&search(&mut project, "300 g")), ["Payload capacity"]);

        // A title match outranks a mention in the content.
        project.draft(
            Origin::User,
            "note",
            "Camera notes",
            json!({"markdown": "The payload capacity limits the lens."}),
            json!([]),
        );
        let ranked = search(&mut project, "payload capacity");
        assert_eq!(found(&ranked), ["Payload capacity", "Camera notes"]);
        assert_eq!(ranked["results"][0]["artifactId"], need.as_str());
    }

    #[test]
    fn a_question_falls_back_to_any_word_and_a_fragment_to_a_scan() {
        let (mut project, _, _) = project();

        let question = search(&mut project, "what's the payload of the rover");
        assert_eq!(question["matched"], "any_term");
        assert!(found(&question).contains(&"Payload capacity"));

        // The index holds whole words; a fragment of a part number needs the scan.
        let fragment = search(&mut project, "G996");
        assert_eq!(fragment["matched"], "substring");
        assert_eq!(found(&fragment), ["Steering servo"]);
        assert_eq!(
            fragment["results"][0]["snippet"],
            "manufacturer: TowerPro · part number: M«G996»R · quantity: 11 kg*cm · value: metal · status: candidate"
        );

        let nothing = search(&mut project, "gyroscope");
        assert_eq!(nothing["matched"], "none");
        assert_eq!(nothing["results"], json!([]));
        assert_eq!(search(&mut project, "°")["matched"], "none");
    }

    #[test]
    fn snippets_are_readable_text_with_the_matches_marked() {
        let (mut project, _, _) = project();

        let need = search(&mut project, "camera payload");
        assert_eq!(
            need["results"][0]["snippet"],
            "statement: Carry a 300 g «camera» «payload» over rough ground · target: 0.3 kg · acceptance criterion: Shown by test · priority: must"
        );
        let unit = search(&mut project, "5 V");
        let snippet = unit["results"][0]["snippet"].as_str().unwrap();
        assert!(snippet.contains("Regulated «5» «V» rail"), "{snippet}");
        // "V" inside a word is not a match; 7.4 V is.
        assert!(snippet.contains("7.4 «V» pack"), "{snippet}");
        for result in [&need, &unit] {
            let snippet = result["results"][0]["snippet"].as_str().unwrap();
            assert!(
                !snippet.contains('{') && !snippet.contains("\":"),
                "{snippet}"
            );
        }

        // A long record is cut around the match, on word boundaries.
        let filler = "Lorem ipsum dolor sit amet. ".repeat(30);
        project.draft(
            Origin::User,
            "note",
            "Long note",
            json!({"markdown": format!("{filler}The gearbox ratio is 48:1. {filler}")}),
            json!([]),
        );
        let long = search(&mut project, "gearbox");
        let snippet = long["results"][0]["snippet"].as_str().unwrap();
        assert!(
            snippet.starts_with('…') && snippet.ends_with('…'),
            "{snippet}"
        );
        assert!(
            snippet.contains("The «gearbox» ratio is 48:1."),
            "{snippet}"
        );
        assert!(snippet.chars().count() <= SNIPPET_CHARS + 6, "{snippet}");
    }

    #[test]
    fn a_failing_index_falls_back_to_the_scan() {
        let (mut project, _, servo) = project();
        project
            .handle()
            .db
            .execute_batch("DROP TABLE artifact_fts")
            .unwrap();
        let part = search(&mut project, "MG996R");
        assert_eq!(part["matched"], "substring");
        assert_eq!(part["results"][0]["artifactId"], servo.as_str());
        assert_eq!(found(&search(&mut project, "5 V rail")), ["Power notes"]);
    }

    #[test]
    fn archived_artifacts_are_not_found_and_the_limit_holds() {
        let (mut project, _, servo) = project();
        project.user(
            "artifact.archive",
            json!({"artifactId": servo, "archived": true}),
        );
        assert_eq!(search(&mut project, "MG996R")["matched"], "none");
        assert_eq!(search(&mut project, "G996")["matched"], "none");

        for index in 0..5 {
            project.draft(
                Origin::User,
                "note",
                &format!("Bracket {index}"),
                json!({"markdown": "bracket"}),
                json!([]),
            );
        }
        let limited = project.user("project.search", json!({"query": "bracket", "limit": 3}));
        assert_eq!(limited["results"].as_array().unwrap().len(), 3);
        let scanned = project.user("project.search", json!({"query": "racke", "limit": 2}));
        assert_eq!(scanned["matched"], "substring");
        assert_eq!(found(&scanned), ["Bracket 0", "Bracket 1"]);
    }
}
