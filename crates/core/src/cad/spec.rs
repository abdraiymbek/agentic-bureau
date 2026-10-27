//! Spec items: what a check of a part is asked to show, item by item. They
//! are the items the caller listed and the features of the requirements
//! linked to the part, each with the recorded check lines that show it.
//!
//! Without recorded requirements the list is the caller's own reading of the
//! request: a requested feature left out of it is not checked. Requirements a
//! person records or approves are what make the list independent of the
//! agent that checks the part.
use super::*;
use bureau_contracts::parse_agent_input;
use expect::{Derived, Feature, ITEM_ASSERTIONS, ITEM_CHARS};
use serde_json::Map;
use std::collections::{BTreeSet, HashMap, HashSet};

/// Relationships through which a requirement asks something of a part.
pub(crate) const RELATIONS: [&str; 3] = ["validates", "derived_from", "depends_on"];
/// Rows a list in a reply or a read carries; the counts give the rest.
pub(crate) const LISTED: usize = 10;
/// An id that parses, for validating assertions on their own.
const PROBE_ID: &str = "00000000-0000-4000-8000-000000000000";

/// What a linked requirement asks of a check.
#[derive(Clone)]
pub(crate) enum Kind {
    /// Features the part must show, one item each.
    Features(Vec<Feature>),
    /// No features, and a length, area, volume or angle target: one row,
    /// shown only by an item that names the requirement and asserts a
    /// dimension.
    Statement,
    /// No features and no geometric target: a row no check shows, with the
    /// reason. It never blocks and never passes.
    Advice(String),
}

impl Kind {
    fn name(&self) -> &'static str {
        match self {
            Kind::Features(_) => "features",
            Kind::Statement => "statement",
            Kind::Advice(_) => "advice",
        }
    }
}

/// A requirement linked to the part being checked.
#[derive(Clone)]
pub(crate) struct Linked {
    pub artifact_id: String,
    pub revision_id: String,
    pub title: String,
    pub priority: String,
    /// Review state of `revision_id`: approved, in_review or draft.
    pub review: &'static str,
    /// `input`, `edge`, `check` (requirementIds of this check or of a
    /// committed one that binds the revision) or `item` (an item's
    /// requirementId), in the order they were found.
    pub via: Vec<&'static str>,
    /// A person made at least one of the links.
    pub by_person: bool,
    /// When the earliest manual edge was drawn, if one links it.
    pub edge_at: Option<String>,
    /// No other mechanical part is linked to it, so its feature assertions
    /// are in this part's frame.
    pub single_part: bool,
    pub kind: Kind,
    /// Hash of what a check derives from it.
    pub hash: String,
    /// Its target in words (`25 mm`), when it states one.
    pub target: Option<String>,
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A label or title as an item's words: spaces collapsed, at most
/// `ITEM_CHARS` characters.
fn item_text(text: &str) -> String {
    let text = collapse(text);
    if text.chars().count() <= ITEM_CHARS {
        text
    } else {
        reads::clip(&text, ITEM_CHARS - 1)
    }
}

/// The title of a requirement as an item's words. A blank title would give
/// items no words, which no check takes back: its statement stands in, or
/// failing that its id.
fn title_text(artifact: &Value, payload: Option<&Value>) -> String {
    [
        artifact["title"].as_str(),
        payload.and_then(|payload| payload["statement"].as_str()),
    ]
    .into_iter()
    .flatten()
    .map(item_text)
    .find(|text| !text.is_empty())
    .unwrap_or_else(|| format!("requirement {}", artifact["id"].as_str().unwrap_or("")))
}

fn kind_of(payload: &Value) -> Kind {
    if let Some(features) = payload["features"]
        .as_array()
        .filter(|features| !features.is_empty())
    {
        return Kind::Features(
            features
                .iter()
                .enumerate()
                .map(|(index, feature)| Feature {
                    // Blank labels are refused on write; one stored before
                    // that is named by its place.
                    label: Some(item_text(feature["label"].as_str().unwrap_or("")))
                        .filter(|label| !label.is_empty())
                        .unwrap_or_else(|| format!("feature {}", index + 1)),
                    fragment: feature
                        .get("expect")
                        .filter(|fragment| fragment.as_object().is_some_and(|f| !f.is_empty()))
                        .cloned(),
                })
                .collect(),
        );
    }
    let target = &payload["target"];
    if target.is_null() {
        return Kind::Advice("it states no length, area, volume or angle target".to_owned());
    }
    if target["unknown"] == true {
        return Kind::Advice("its target is unknown".to_owned());
    }
    let geometric = ["length", "area", "volume", "angle"].map(units::dimension);
    match target["unit"].as_str().map(units::parse) {
        Some(Ok(unit)) if geometric.contains(&unit.dim) => Kind::Statement,
        Some(Ok(unit)) => Kind::Advice(format!(
            "it states a {} target ({}), which a geometry check cannot show",
            unit.measures(),
            reads::format_quantity(target).unwrap_or_default()
        )),
        _ => Kind::Advice("the unit of its target is not known".to_owned()),
    }
}

/// What a check derives from a requirement, hashed: its feature labels with
/// the assertions a check of this part takes from it, or its target.
fn hash_of(kind: &Kind, payload: &Value, single_part: bool) -> String {
    let basis = match kind {
        Kind::Features(features) => json!({"features": features
            .iter()
            .map(|feature| json!([
                feature.label.to_lowercase(),
                feature.fragment.as_ref().filter(|_| single_part)
            ]))
            .collect::<Vec<_>>()}),
        Kind::Statement => json!({"statement": payload["target"]}),
        Kind::Advice(_) => json!({"advice": true}),
    };
    hash_text(&basis.to_string())
}

fn review_of(artifact: &Value, revision: &Value) -> &'static str {
    if artifact["selectedRevisionId"] == revision["id"] {
        "approved"
    } else if revision["reviewState"] == "proposed" {
        "in_review"
    } else {
        "draft"
    }
}

/// The revision that says what a requirement currently states.
fn current_revision(handle: &ProjectHandle, artifact_id: &str) -> CoreResult<Option<Value>> {
    let id = handle
        .db
        .query_row(
            &format!(
                "SELECT {} FROM artifact a WHERE a.id=?1",
                reads::current_revision_sql()
            ),
            [artifact_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(internal)?
        .flatten();
    id.map(|id| get_revision(handle, &id))
        .transpose()
        .map(Option::flatten)
}

/// Add a requirement found through `via`, or record another way to it.
#[allow(clippy::too_many_arguments)]
fn add(
    out: &mut Vec<Linked>,
    handle: &ProjectHandle,
    part_id: &str,
    artifact: &Value,
    revision: &Value,
    via: &'static str,
    by_person: bool,
    edge_at: Option<String>,
) -> CoreResult<()> {
    let id = required_str(artifact, "id")?;
    if let Some(known) = out.iter_mut().find(|known| known.artifact_id == id) {
        if !known.via.contains(&via) {
            known.via.push(via);
        }
        known.by_person |= by_person;
        if edge_at.is_some() && known.edge_at.is_none() {
            known.edge_at = edge_at;
        }
        return Ok(());
    }
    let others: i64 = handle
        .db
        .query_row(
            "SELECT COUNT(DISTINCT e.downstream_artifact_id) FROM edge e JOIN artifact d ON d.id=e.downstream_artifact_id \
             WHERE e.upstream_artifact_id=?1 AND e.downstream_artifact_id<>?2 AND d.type='mechanical' AND d.archived=0 \
             AND e.relationship IN ('validates','derived_from','depends_on')",
            params![id, part_id],
            |row| row.get(0),
        )
        .map_err(internal)?;
    let payload = &revision["payload"];
    let kind = kind_of(payload);
    out.push(Linked {
        artifact_id: id.to_owned(),
        revision_id: required_str(revision, "id")?.to_owned(),
        title: title_text(artifact, Some(payload)),
        priority: payload["priority"].as_str().unwrap_or("should").to_owned(),
        review: review_of(artifact, revision),
        via: vec![via],
        by_person,
        edge_at,
        single_part: others == 0,
        hash: hash_of(&kind, payload, others == 0),
        target: reads::format_quantity(&payload["target"]),
        kind,
    });
    Ok(())
}

/// The requirements that stand linked to `revision`: its inputs, at their
/// pinned revisions, then manual edges, at the requirement's current
/// revision. Archived requirements are left out.
///
/// A draft requirement as an input still leaves the part unverified until a
/// person approves it (`stale_inputs`); an edge does not.
pub(crate) fn linked(handle: &ProjectHandle, revision: &Value) -> CoreResult<Vec<Linked>> {
    let part_id = required_str(revision, "artifactId")?;
    let mut out = Vec::new();
    let inputs_by_person = revision["origin"] != "agent";
    for input in revision["inputs"].as_array().into_iter().flatten() {
        let relationship = input["relationship"].as_str().unwrap_or("depends_on");
        let Some(id) = input["artifactId"]
            .as_str()
            .filter(|_| RELATIONS.contains(&relationship))
        else {
            continue;
        };
        let Ok(artifact) = require_artifact(handle, id) else {
            continue;
        };
        if artifact["type"] != "requirement" || artifact["archived"] == true {
            continue;
        }
        let pinned = match input["revisionId"].as_str() {
            Some(revision_id) => get_revision(handle, revision_id)?,
            None => None,
        };
        if let Some(pinned) = pinned {
            add(
                &mut out,
                handle,
                part_id,
                &artifact,
                &pinned,
                "input",
                inputs_by_person,
                None,
            )?;
        }
    }
    // Pinned edges mirror an approved revision's inputs; the manual ones
    // are read here.
    let mut statement = handle
        .db
        .prepare_cached(
            "SELECT e.upstream_artifact_id, MIN(e.created_at), MAX(e.created_by<>'agent') FROM edge e \
             JOIN artifact a ON a.id=e.upstream_artifact_id \
             WHERE e.downstream_artifact_id=?1 AND e.required_upstream_revision_id IS NULL \
             AND a.type='requirement' AND a.archived=0 \
             AND e.relationship IN ('validates','derived_from','depends_on') \
             GROUP BY e.upstream_artifact_id ORDER BY a.created_at, a.id",
        )
        .map_err(internal)?;
    let edges = statement
        .query_map([part_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    for (id, drawn_at, by_person) in edges {
        let artifact = require_artifact(handle, &id)?;
        if let Some(current) = current_revision(handle, &id)? {
            add(
                &mut out,
                handle,
                part_id,
                &artifact,
                &current,
                "edge",
                by_person,
                Some(drawn_at),
            )?;
        }
    }
    Ok(out)
}

fn archived_note(title: &str) -> String {
    format!("requirement \"{title}\" is archived; items naming it are checked as listed items")
}

/// Add to `out` the requirements committed checks named in
/// `requirementIds` (`carried`), linked by whoever named them: once a check
/// took a requirement into account, a later one cannot leave it out. The
/// notes say why one linked no other way is there, and which are archived
/// (they are left out, as `linked` leaves archived ones out).
fn carry(
    handle: &ProjectHandle,
    part_id: &str,
    carried: &[verification::Named],
    out: &mut Vec<Linked>,
    notes: &mut Vec<String>,
) -> CoreResult<()> {
    for named in carried {
        if let Some(known) = out.iter_mut().find(|known| known.artifact_id == named.id) {
            if !known.via.contains(&"check") {
                known.via.push("check");
            }
            known.by_person |= named.by_person;
            continue;
        }
        let Ok(artifact) = require_artifact(handle, &named.id) else {
            continue;
        };
        if artifact["type"] != "requirement" {
            continue;
        }
        if artifact["archived"] == true {
            let note = archived_note(&title_text(&artifact, None));
            if !notes.contains(&note) {
                notes.push(note);
            }
            continue;
        }
        if let Some(current) = current_revision(handle, &named.id)? {
            add(
                out,
                handle,
                part_id,
                &artifact,
                &current,
                "check",
                named.by_person,
                None,
            )?;
            notes.push(format!(
                "requirement \"{}\" stays in this check: a committed check of this part named it in requirementIds",
                out.last().map_or("", |known| known.title.as_str())
            ));
        }
    }
    Ok(())
}

/// The requirements that stand behind a check of `revision`: `linked`, and
/// those the committed checks that bind it named in `requirementIds`. A
/// check adds the ones it names itself (`for_check`); the readers of its
/// record (the gate's conflict, readiness, the next expect) read this set,
/// so they report on every requirement a check has to keep.
pub(crate) fn standing(handle: &ProjectHandle, revision: &Value) -> CoreResult<Vec<Linked>> {
    let part_id = required_str(revision, "artifactId")?;
    let mut out = linked(handle, revision)?;
    let carried = verification::committed_requirement_ids(handle, revision)?;
    carry(handle, part_id, &carried, &mut out, &mut Vec::new())?;
    Ok(out)
}

/// `linked`, plus the requirements a check names in `requirementIds` and in
/// its items' `requirementId`, and those a committed check that binds the
/// revision named in `requirementIds` (`standing`). A requirement archived
/// since the committed check named it is accepted, and its items are then
/// checked as listed items; the notes say so.
pub(crate) fn for_check(
    handle: &ProjectHandle,
    revision: &Value,
    input: &Value,
    expect: &Value,
    origin: &Origin,
) -> CoreResult<(Vec<Linked>, Vec<String>)> {
    let part_id = required_str(revision, "artifactId")?;
    let mut out = linked(handle, revision)?;
    let mut notes = Vec::new();
    let carried = verification::committed_requirement_ids(handle, revision)?;
    let named = input["requirementIds"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, id)| (format!("requirementIds[{index}]"), id, "check"))
        .chain(
            expect["spec"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .filter(|(_, item)| !item["requirementId"].is_null())
                .map(|(index, item)| {
                    (
                        format!("expect.spec[{index}].requirementId"),
                        &item["requirementId"],
                        "item",
                    )
                }),
        )
        .collect::<Vec<_>>();
    let mut committed: Option<HashSet<String>> = None;
    for (path, id, via) in named {
        let Some(id) = id.as_str() else {
            continue;
        };
        let by_person = !matches!(origin, Origin::Agent { .. });
        if let Some(known) = out.iter_mut().find(|known| known.artifact_id == id) {
            if !known.via.contains(&via) {
                known.via.push(via);
            }
            known.by_person |= by_person;
            continue;
        }
        let artifact = require_artifact(handle, id)
            .map_err(|_| ContractError::not_found("requirement", id, "artifact_list"))?;
        if artifact["type"] != "requirement" {
            return Err(spec_invalid(
                &path,
                &format!(
                    "{id} is a {} artifact, not a requirement",
                    artifact["type"].as_str().unwrap_or("different")
                ),
                "List requirements with artifact_list and type \"requirement\".",
            ));
        }
        let title = title_text(&artifact, None);
        if artifact["archived"] == true {
            if committed.is_none() {
                committed = Some(
                    verification::committed_expect(handle, revision)?["spec"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|item| item["requirementId"].as_str().map(str::to_owned))
                        .chain(carried.iter().map(|named| named.id.clone()))
                        .collect(),
                );
            }
            if !committed.as_ref().is_some_and(|ids| ids.contains(id)) {
                return Err(spec_invalid(
                    &path,
                    &format!("requirement \"{title}\" is archived"),
                    "Name a current requirement, or leave it out.",
                ));
            }
            let note = archived_note(&title);
            if !notes.contains(&note) {
                notes.push(note);
            }
            continue;
        }
        if let Some(current) = current_revision(handle, id)? {
            add(
                &mut out, handle, part_id, &artifact, &current, via, by_person, None,
            )?;
        }
    }
    carry(handle, part_id, &carried, &mut out, &mut notes)?;
    Ok((out, notes))
}

/// What a check planned with `linked` adds as it commits: the requirements
/// a check that committed while it ran named in `requirementIds`. Planning
/// read the record before that check was part of it, and a requirement a
/// committed check took into account stays in the checks that follow. A
/// statement or advice requirement only adds a row, which the commit
/// assesses; one with features adds items this check did not measure, so
/// the check is refused (`INPUT_CHANGED`) and asked again. Returns the
/// requirements and the notes to add.
pub(crate) fn carried_since(
    handle: &ProjectHandle,
    revision: &Value,
    linked: &[Linked],
) -> CoreResult<(Vec<Linked>, Vec<String>)> {
    let part_id = required_str(revision, "artifactId")?;
    let carried = verification::committed_requirement_ids(handle, revision)?;
    let mut out = linked.to_vec();
    let mut notes = Vec::new();
    carry(handle, part_id, &carried, &mut out, &mut notes)?;
    if let Some(requirement) = out[linked.len()..]
        .iter()
        .find(|requirement| matches!(requirement.kind, Kind::Features(_)))
    {
        return Err(ContractError::new(
            "INPUT_CHANGED",
            format!(
                "A check of this part committed while this one ran and named requirement \"{}\", whose features this check did not measure. Nothing was committed.",
                requirement.title
            ),
        )
        .with_repair("Repeat the same cad_check: it adds the requirement's items.")
        .with_details(json!({"artifactId": part_id, "requirementId": requirement.artifact_id})));
    }
    Ok((out, notes))
}

fn spec_invalid(path: &str, message: &str, repair: &str) -> ContractError {
    ContractError::validation(format!("Invalid input: {path}: {message}"))
        .with_repair(repair)
        .with_details(json!({"issues": [{"path": path, "kind": "other", "message": message}]}))
}

/// The features each linked requirement adds to a check. Feature assertions
/// are taken only from a requirement linked to this one part; for one linked
/// to several, its features are items the check has to assert itself.
pub(crate) fn derived(linked: &[Linked]) -> Vec<Derived> {
    linked
        .iter()
        .filter_map(|requirement| match &requirement.kind {
            Kind::Features(features) => Some(Derived {
                requirement_id: requirement.artifact_id.clone(),
                title: requirement.title.clone(),
                features: features
                    .iter()
                    .map(|feature| Feature {
                        label: feature.label.clone(),
                        fragment: feature.fragment.clone().filter(|_| requirement.single_part),
                    })
                    .collect(),
            }),
            _ => None,
        })
        .collect()
}

/// Validate `groups` as the assertions of `expect`, with every issue named
/// under `prefix` instead of `expect.`; the repaired groups and the repairs.
fn checked_groups(
    groups: Map<String, Value>,
    prefix: &str,
) -> CoreResult<(Map<String, Value>, Vec<String>)> {
    let op = registry()
        .operation("cad.check")
        .ok_or_else(|| ContractError::new("INTERNAL", "cad.check is not in the registry"))?;
    let rename = |text: &str| text.replace("expect.", prefix);
    match parse_agent_input(op, json!({"artifactId": PROBE_ID, "expect": groups})) {
        Ok(checked) => Ok((
            checked.value["expect"]
                .as_object()
                .cloned()
                .unwrap_or_default(),
            checked.notes.iter().map(|note| rename(note)).collect(),
        )),
        Err(error) => {
            let issues = error
                .issues()
                .into_iter()
                .map(|mut issue| {
                    issue.path = rename(&issue.path);
                    issue.message = rename(&issue.message);
                    issue
                })
                .collect::<Vec<_>>();
            Err(ContractError::validation(rename(&error.message))
                .with_repair(format!(
                    "{prefix}… takes the assertions of expect (size, holes, bodies, shells, bbox, volume, solid, empty, sections), each in the form cad_check takes at the top level. {}",
                    error.repair.as_deref().unwrap_or("")
                ).trim_end().to_owned())
                .with_details(json!({"issues": issues})))
        }
    }
}

/// `expect` with each spec item's assertions validated strictly, whoever
/// sends them: the listing declares them by their outer type only, and a
/// lenient read would drop a misspelled key and verify less. Returns the
/// repaired expectation and the repairs, named by item.
pub(crate) fn checked_items(expect: &Value) -> CoreResult<(Value, Vec<String>)> {
    let mut expect = expect.clone();
    let mut notes = Vec::new();
    let Some(items) = expect.get_mut("spec").and_then(Value::as_array_mut) else {
        return Ok((expect, notes));
    };
    for (index, item) in items.iter_mut().enumerate() {
        let Some(fields) = item.as_object_mut() else {
            continue;
        };
        let groups = fields
            .iter()
            .filter(|(key, _)| ITEM_ASSERTIONS.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Map<_, _>>();
        if groups.is_empty() {
            continue;
        }
        let (repaired, repairs) = checked_groups(groups, &format!("expect.spec[{index}]."))?;
        fields.extend(repaired);
        notes.extend(repairs);
    }
    Ok((expect, notes))
}

/// Requirement features as they are written: labels unique, each `expect`
/// a valid set of cad_check assertions (repaired in place, as an agent's
/// input is). Nothing for other artifact types.
pub(crate) fn check_features(type_name: &str, payload: &mut Value) -> CoreResult<()> {
    if type_name != "requirement" {
        return Ok(());
    }
    let Some(features) = payload.get_mut("features").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let mut labels = Vec::<String>::new();
    for (index, feature) in features.iter_mut().enumerate() {
        let path = format!("payload.features[{index}]");
        let label = collapse(feature["label"].as_str().unwrap_or("")).to_lowercase();
        if label.is_empty() {
            return Err(spec_invalid(
                &format!("{path}.label"),
                "is blank",
                "Name the feature in the requirement's words, e.g. \"Groove bottom Ø50 mm\".",
            ));
        }
        if let Some(first) = labels.iter().position(|seen| *seen == label) {
            return Err(spec_invalid(
                &format!("{path}.label"),
                &format!("repeats payload.features[{first}].label"),
                "List each feature once; put all its assertions in that one entry.",
            ));
        }
        labels.push(label);
        let Some(fragment) = feature.get_mut("expect").filter(|value| !value.is_null()) else {
            continue;
        };
        let groups = fragment.as_object().cloned().unwrap_or_default();
        if let Some(key) = groups
            .keys()
            .find(|key| !ITEM_ASSERTIONS.contains(&key.as_str()))
        {
            return Err(spec_invalid(
                &format!("{path}.expect.{key}"),
                "not a feature assertion",
                "A feature asserts with size, holes, bodies, shells, bbox, volume, solid, empty and sections, in the form cad_check takes them.",
            ));
        }
        let (repaired, _) = checked_groups(groups, &format!("{path}.expect."))?;
        let repaired = Value::Object(repaired);
        expect::check_assertions(&repaired, &format!("{path}.expect"))?;
        *fragment = repaired;
    }
    Ok(())
}

fn names(lines: &[&Value]) -> Vec<Value> {
    lines.iter().map(|line| line["name"].clone()).collect()
}

/// Each item of the canonical expectation and each featureless linked
/// requirement, with the lines that show it. `None` when the check has no
/// items and the part no linked requirement: it is reported as before.
///
/// A row of a requirement feature says whose assertions show it
/// (`assertedBy`): the requirement's own, or ones listed for it. A listed
/// item in the words of a statement requirement's title is that
/// requirement's row, not a second one.
pub(crate) fn assess(
    expect: &Value,
    linked: &[Linked],
    lines: &[Value],
    listed_by: &str,
) -> CoreResult<Option<Value>> {
    let items = expect["spec"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if items.is_empty() && linked.is_empty() {
        return Ok(None);
    }
    // Feature keys, with the assertions a check takes from the requirement.
    let features = derived(linked)
        .into_iter()
        .flat_map(|requirement| {
            requirement.features.into_iter().map(move |feature| {
                (
                    (
                        requirement.requirement_id.clone(),
                        collapse(&feature.label).to_lowercase(),
                    ),
                    feature
                        .fragment
                        .map(|fragment| expect::fragment_groups(&fragment)),
                )
            })
        })
        .collect::<HashMap<_, _>>();
    let statements = linked
        .iter()
        .filter(|requirement| matches!(requirement.kind, Kind::Statement))
        .map(|requirement| {
            (
                requirement.artifact_id.clone(),
                collapse(&requirement.title).to_lowercase(),
            )
        })
        .collect::<HashSet<_>>();
    let mut rows = Vec::new();
    // Per item: the requirement it names, whether it asserts a dimension,
    // its state and its lines.
    let mut shown = Vec::<(Option<&str>, bool, &'static str, Vec<&Value>)>::new();
    for item in items {
        let groups = expect::item_groups(item);
        let wanted = checks::assertion_names(&groups)?;
        let measured = lines
            .iter()
            .filter(|line| {
                line["name"]
                    .as_str()
                    .is_some_and(|name| wanted.contains(name))
            })
            .collect::<Vec<_>>();
        let asserted = groups.as_object().is_some_and(|groups| !groups.is_empty());
        let state = if !asserted {
            "unasserted"
        } else if measured.is_empty() || measured.iter().any(|line| line["pass"] != true) {
            "failed"
        } else {
            "passed"
        };
        let key = expect::item_key(item);
        let dimensional = expect::DIMENSIONAL
            .iter()
            .any(|key| !groups[*key].is_null());
        shown.push((
            item["requirementId"].as_str(),
            dimensional,
            state,
            measured.clone(),
        ));
        if statements.contains(&key) {
            continue;
        }
        let mut row = json!({"item": item["item"],
            "from": if features.contains_key(&key) { "requirement" } else { "listed" },
            "state": state, "checks": names(&measured)});
        if asserted {
            if let Some(fragment) = features.get(&key) {
                // The requirement's assertions, or ones listed for its
                // feature when the check does not take them from it.
                let own = fragment.as_ref().is_some_and(|fragment| {
                    fragment.as_object().is_some_and(|f| !f.is_empty()) && *fragment == groups
                });
                row["assertedBy"] = json!(if own { "requirement" } else { "listed" });
            }
        }
        if let Some(id) = item["requirementId"].as_str() {
            row["requirementId"] = json!(id);
        }
        rows.push(row);
    }
    for requirement in linked {
        let mut row = json!({"item": requirement.title, "requirementId": requirement.artifact_id,
            "from": "requirement", "statement": true});
        match &requirement.kind {
            Kind::Features(_) => continue,
            Kind::Statement => {
                // Only an item that names the requirement and asserts a
                // dimension of the part shows it; the assertions are listed
                // for it, never the requirement's own.
                let by = shown
                    .iter()
                    .filter(|(id, dimensional, _, _)| {
                        *id == Some(requirement.artifact_id.as_str()) && *dimensional
                    })
                    .collect::<Vec<_>>();
                row["state"] = json!(if by.is_empty() {
                    "unasserted"
                } else if by.iter().any(|(_, _, state, _)| *state != "passed") {
                    "failed"
                } else {
                    "passed"
                });
                if !by.is_empty() {
                    row["assertedBy"] = json!("listed");
                }
                let mut measured = Vec::<&Value>::new();
                for line in by.iter().flat_map(|(_, _, _, lines)| lines) {
                    if !measured.iter().any(|known| known["name"] == line["name"]) {
                        measured.push(line);
                    }
                }
                row["checks"] = json!(names(&measured));
            }
            Kind::Advice(reason) => {
                row["state"] = json!("not_shown");
                row["checks"] = json!([]);
                row["reason"] = json!(format!("No check shows this requirement: {reason}."));
            }
        }
        rows.push(row);
    }
    let count = |state: &str| rows.iter().filter(|row| row["state"] == state).count();
    let unasserted = count("unasserted");
    let counts = json!({"items": rows.len(), "passed": count("passed"), "failed": count("failed"),
        "unasserted": unasserted, "notShown": count("not_shown"), "blocking": unasserted});
    let report = json!({
        "listedBy": listed_by,
        "items": rows,
        "requirements": linked.iter().map(|requirement| json!({
            "artifactId": requirement.artifact_id, "revisionId": requirement.revision_id,
            "title": requirement.title, "priority": requirement.priority, "review": requirement.review,
            "via": requirement.via,
            "linkedBy": if requirement.by_person { "person" } else { "agent" },
            "kind": requirement.kind.name(), "derivedHash": requirement.hash,
        })).collect::<Vec<_>>(),
        "counts": counts,
    });
    Ok(Some(report))
}

/// The scope changes of a check, by cause.
pub(crate) struct Attribution {
    /// Committed assertions that linked requirements state differently
    /// now, in words: only a person accepts them.
    pub replaced: Vec<String>,
    /// Changes the check made itself, which repeating the committed scope
    /// restores.
    pub own: Vec<String>,
}

/// The derived hashes a committed check recorded, by requirement id.
fn recorded_hashes(handle: &ProjectHandle, evidence_hash: Option<&str>) -> HashMap<String, String> {
    let evidence = evidence_hash
        .and_then(|hash| handle.object_store().ok()?.read(hash).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null);
    evidence["spec"]["requirements"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|requirement| {
            Some((
                requirement["artifactId"].as_str()?.to_owned(),
                requirement["derivedHash"].as_str()?.to_owned(),
            ))
        })
        .collect()
}

/// Split the scope changes of `expect` against each earlier scope (`priors`)
/// into what linked requirements now state differently (changed since, or
/// linked since with other values) and what the check changed itself. Each earlier scope is read as it would be with the requirements
/// as they stand (`expect::rederive`); what still differs is the check's
/// own. Items naming a statement requirement whose target changed since an
/// earlier check may be restated; one that is not kept is the
/// requirement's change too. A previously failing line the check no
/// longer has is its own change unless it measured a replaced assertion.
pub(crate) fn attribute(
    handle: &ProjectHandle,
    priors: &[verification::Prior],
    expect: &Value,
    linked: &[Linked],
    dropped: &[String],
) -> Attribution {
    let derive = derived(linked);
    let (mut replaced, mut superseded) = (Vec::<String>::new(), Vec::<Value>::new());
    let mut own = BTreeSet::<String>::new();
    for prior in priors {
        let recorded = recorded_hashes(handle, prior.evidence.as_deref());
        let revised = linked
            .iter()
            .filter(|requirement| {
                matches!(requirement.kind, Kind::Statement)
                    && recorded
                        .get(&requirement.artifact_id)
                        .is_some_and(|hash| *hash != requirement.hash)
            })
            .collect::<Vec<_>>();
        let mut base = expect::request_form(&prior.expect);
        if !revised.is_empty() {
            let kept = expect::kept_items(&prior.expect, expect);
            if let Some(items) = base.get_mut("spec").and_then(Value::as_array_mut) {
                let mut index = 0;
                items.retain(|item| {
                    let restated = revised
                        .iter()
                        .find(|requirement| item["requirementId"] == requirement.artifact_id);
                    let keep = match restated {
                        Some(requirement) if !kept.get(index).copied().unwrap_or(true) => {
                            replaced.push(format!(
                                "\"{}\" (requirement \"{}\" changed)",
                                item["item"].as_str().unwrap_or(""),
                                requirement.title
                            ));
                            superseded.push(expect::item_groups(item));
                            false
                        }
                        _ => true,
                    };
                    index += 1;
                    keep
                });
            }
        }
        match expect::rederive(&base, &derive) {
            Ok(restated) => {
                own.extend(expect::scope_changes(&restated.expect, expect));
                replaced.extend(restated.replaced);
                superseded.extend(restated.superseded);
            }
            Err(_) => own.extend(expect::scope_changes(&prior.expect, expect)),
        }
    }
    if !dropped.is_empty() {
        let measured = superseded
            .iter()
            .filter_map(|groups| checks::assertion_names(groups).ok())
            .flatten()
            .collect::<HashSet<_>>();
        if dropped.iter().any(|name| !measured.contains(name)) {
            own.insert("dropped previously failing assertions".to_owned());
        }
    }
    let mut seen = HashSet::new();
    replaced.retain(|entry| seen.insert(entry.clone()));
    Attribution {
        replaced,
        own: own.into_iter().collect(),
    }
}

/// A committed scope as it reads with the linked requirements as they
/// stand; itself when it cannot be restated.
fn restated(committed: &Value, linked: &[Linked]) -> Value {
    if !committed.is_object() {
        return committed.clone();
    }
    expect::rederive(&expect::request_form(committed), &derived(linked))
        .map(|restated| restated.expect)
        .unwrap_or_else(|_| committed.clone())
}

/// The scope a check repeats to keep every earlier one (`priors`), each
/// read as the linked requirements state it now, so that an assertion a
/// requirement replaced does not hide one the check dropped itself.
pub(crate) fn restore(priors: &[verification::Prior], linked: &[Linked]) -> Value {
    let restated = priors
        .iter()
        .map(|prior| verification::Prior {
            expect: restated(&prior.expect, linked),
            ..prior.clone()
        })
        .collect::<Vec<_>>();
    verification::covering(&restated)
}

/// `standing`, with the requirements the items of `expects` name.
pub(crate) fn linked_naming<'a>(
    handle: &ProjectHandle,
    revision: &Value,
    expects: impl Iterator<Item = &'a Value>,
) -> CoreResult<Vec<Linked>> {
    let mut out = standing(handle, revision)?;
    for expect in expects {
        named_by_items(handle, revision, expect, &mut out)?;
    }
    Ok(out)
}

/// Why no check can run, when linked requirements state one assertion of
/// the part differently.
pub(crate) fn conflict(linked: &[Linked]) -> Option<String> {
    let error = expect::normalize_with(&Value::Null, &derived(linked)).err()?;
    Some(match error.issues().first() {
        Some(issue) if issue.message.starts_with("requirement") => issue.message.clone(),
        Some(issue) => format!("{}: {}", issue.path, issue.message),
        None => error.message,
    })
}

/// `conflict`, for the requirements that stand behind a check of
/// `revision` (`standing`): those a committed check named included, since
/// every check takes them.
pub(crate) fn requirement_conflict(
    handle: &ProjectHandle,
    revision: &Value,
) -> CoreResult<Option<String>> {
    Ok(conflict(&standing(handle, revision)?))
}

/// Who listed a check's own items, in the words the report uses.
pub(crate) fn listed_by(origin: &Origin) -> &'static str {
    match origin {
        Origin::Agent { .. } => "agent",
        _ => "person",
    }
}

/// Linked requirements the committed check (`evidence`, committed at
/// `checked_at`) does not show as they stand now: not taken into account,
/// linked after it, or changed since. Requirements no check shows are left
/// out; they never block.
pub(crate) fn since(linked: &[Linked], evidence: &Value, checked_at: &str) -> Vec<Value> {
    let recorded = evidence["spec"]["requirements"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut out = Vec::new();
    for requirement in linked {
        if matches!(requirement.kind, Kind::Advice(_)) {
            continue;
        }
        let change = match recorded
            .iter()
            .find(|known| known["artifactId"] == requirement.artifact_id.as_str())
        {
            Some(known) if known["derivedHash"] == requirement.hash.as_str() => continue,
            Some(_) => "revised",
            None if !requirement.via.contains(&"input")
                && requirement
                    .edge_at
                    .as_deref()
                    .is_some_and(|drawn| drawn > checked_at) =>
            {
                "linked_after"
            }
            None => "not_considered",
        };
        let mut entry = json!({"requirementId": requirement.artifact_id,
            "revisionId": requirement.revision_id, "title": requirement.title, "change": change,
            "kind": requirement.kind.name()});
        if let Some(target) = requirement
            .target
            .as_ref()
            .filter(|_| matches!(requirement.kind, Kind::Statement))
        {
            entry["target"] = json!(target);
        }
        out.push(entry);
    }
    out
}

/// What a verification read adds about spec items: the gaps of the recorded
/// report, the requirements linked or changed since, and why no check can
/// run (`conflict`) when linked requirements disagree. `None` when there is
/// none of these.
pub(crate) fn readiness(
    evidence: &Value,
    since: Vec<Value>,
    conflict: Option<String>,
) -> Option<Value> {
    let spec = &evidence["spec"];
    if !spec.is_object() && since.is_empty() && conflict.is_none() {
        return None;
    }
    let counts = if spec["counts"].is_object() {
        spec["counts"].clone()
    } else {
        json!({"items": 0, "passed": 0, "failed": 0, "unasserted": 0, "notShown": 0, "blocking": 0})
    };
    let missing = spec["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row["state"] == "unasserted")
        .take(LISTED)
        .map(|row| {
            let mut entry = json!({"item": row["item"]});
            for key in ["requirementId", "statement"] {
                if !row[key].is_null() {
                    entry[key] = row[key].clone();
                }
            }
            entry
        })
        .collect::<Vec<_>>();
    let blocking = counts["blocking"].as_u64().unwrap_or(0) + since.len() as u64;
    let mut out = json!({"counts": counts, "missing": missing,
        "linkedSince": since.iter().take(LISTED).collect::<Vec<_>>(),
        "linkedSinceCount": since.len(), "blocking": blocking});
    if let Some(conflict) = conflict {
        out["conflict"] = json!(conflict);
    }
    Some(out)
}

/// Requirements the items of `expect` name that are not linked to the part,
/// at their current revisions, as a check adds them. Ids that no longer
/// name a current requirement are passed over.
fn named_by_items(
    handle: &ProjectHandle,
    revision: &Value,
    expect: &Value,
    linked: &mut Vec<Linked>,
) -> CoreResult<()> {
    let part_id = required_str(revision, "artifactId")?;
    let named = expect["spec"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["requirementId"].as_str());
    for id in named {
        if linked.iter().any(|known| known.artifact_id == id) {
            continue;
        }
        let Ok(artifact) = require_artifact(handle, id) else {
            continue;
        };
        if artifact["type"] != "requirement" || artifact["archived"] == true {
            continue;
        }
        if let Some(current) = current_revision(handle, id)? {
            add(
                linked, handle, part_id, &artifact, &current, "item", false, None,
            )?;
        }
    }
    Ok(())
}

/// The expect a check of `revision` sends next, in request form: the
/// committed one as it reads with the linked requirements as they stand
/// (`expect::rederive`), with the items of requirements linked or changed
/// since, and an item naming each statement requirement no item shows yet.
/// The placeholders have no assertions: they show where one is missing.
/// An error when linked requirements disagree, so no check can run.
pub(crate) fn next_expect(
    handle: &ProjectHandle,
    revision: &Value,
    committed: &Value,
    readiness: &Value,
) -> CoreResult<Value> {
    let base = if committed.is_object() {
        expect::request_form(committed)
    } else {
        json!({})
    };
    let mut linked = standing(handle, revision)?;
    named_by_items(handle, revision, &base, &mut linked)?;
    let mut next = expect::rederive(&base, &derived(&linked))?.expect;
    let since = readiness["linkedSince"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["requirementId"].as_str())
        .collect::<HashSet<_>>();
    let mut rows = readiness["missing"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row["statement"] == true)
        .filter_map(|row| {
            Some((
                row["requirementId"].as_str()?.to_owned(),
                row["item"].as_str()?.to_owned(),
            ))
        })
        .collect::<Vec<_>>();
    rows.extend(
        linked
            .iter()
            .filter(|requirement| {
                matches!(requirement.kind, Kind::Statement)
                    && since.contains(requirement.artifact_id.as_str())
            })
            .map(|requirement| (requirement.artifact_id.clone(), requirement.title.clone())),
    );
    if let Some(map) = next.as_object_mut() {
        let items = map.entry("spec").or_insert_with(|| json!([]));
        if let Some(items) = items.as_array_mut() {
            for (id, title) in rows {
                // An item that names the requirement and asserts a dimension
                // already shows it; it is restated, not doubled.
                let shown = items.iter().any(|item| {
                    item["requirementId"] == id.as_str()
                        && expect::DIMENSIONAL.iter().any(|key| !item[*key].is_null())
                });
                let placeholder = json!({"item": title, "requirementId": id});
                if !shown
                    && !items
                        .iter()
                        .any(|item| expect::item_key(item) == expect::item_key(&placeholder))
                {
                    items.push(placeholder);
                }
            }
        }
        if map["spec"].as_array().is_some_and(Vec::is_empty) {
            map.shift_remove("spec");
        }
    }
    Ok(expect::request_form(&next))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lines a correct V-pulley gives, as the checker names them.
    const PULLEY_LINES: [&str; 16] = [
        "bounding box",
        "watertight",
        "single body",
        "solid at (29.5, 0, 3.5)",
        "solid at (29.5, 0, 12.5)",
        "empty at (0, 0, 2)",
        "empty at (0, 0, 14)",
        "empty at (29.5, 0, 8)",
        "section z=2: hole d8 at (x=0, y=0)",
        "section z=2: outer circle d60",
        "section z=14: hole d8 at (x=0, y=0)",
        "section z=14: outer circle d60",
        "section z=8: outer circle d50",
        "section z=6: outer circle d55",
        "section z=10: outer circle d55",
        "self-intersections",
    ];

    fn lines(failing: &[&str]) -> Vec<Value> {
        PULLEY_LINES
            .iter()
            .map(|name| json!({"name": name, "pass": !failing.contains(name), "detail": ""}))
            .collect()
    }

    fn pulley() -> Value {
        expect::normalize(&json!({"bodies": 1, "spec": [
            {"item": "outer diameter 60 mm", "sections": [{"axis": "z", "at": 2, "outer": {"d": 60}}, {"axis": "z", "at": 14, "outer": {"d": 60}}]},
            {"item": "overall width 16 mm", "bbox": {"min": [-30, -30, 0], "max": [30, 30, 16]}},
            {"item": "Ø8 mm bore", "holes": [{"at": [0, 0, 2], "d": 8}, {"at": [0, 0, 14], "d": 8}]},
            {"item": "V-groove 8 mm wide", "solid": [[29.5, 0, 3.5], [29.5, 0, 12.5]], "empty": [[29.5, 0, 8]]},
            {"item": "groove bottom Ø50", "sections": [{"axis": "z", "at": 8, "outer": {"d": 50}}]},
            {"item": "flanks straight", "sections": [{"axis": "z", "at": 6, "outer": {"d": 55}}, {"axis": "z", "at": 10, "outer": {"d": 55}}]}]}))
        .unwrap()
        .expect
    }

    fn requirement(id: &str, kind: Kind) -> Linked {
        Linked {
            artifact_id: id.into(),
            revision_id: format!("{id}-r1"),
            title: format!("Requirement {id}"),
            priority: "could".into(),
            review: "draft",
            via: vec!["edge"],
            by_person: false,
            edge_at: None,
            single_part: true,
            hash: "h".into(),
            target: None,
            kind,
        }
    }

    fn report(expect: &Value, linked: &[Linked], failing: &[&str]) -> Value {
        assess(expect, linked, &lines(failing), "agent")
            .unwrap()
            .unwrap()
    }

    #[test]
    fn attribution_gives_each_item_its_own_lines_in_a_shared_plane() {
        let report = report(&pulley(), &[], &["section z=8: outer circle d50"]);
        let rows = report["items"].as_array().unwrap();
        let checks = |index: usize| rows[index]["checks"].clone();
        assert_eq!(
            checks(0),
            json!([
                "section z=2: outer circle d60",
                "section z=14: outer circle d60"
            ])
        );
        assert_eq!(
            checks(2),
            json!([
                "empty at (0, 0, 2)",
                "empty at (0, 0, 14)",
                "section z=2: hole d8 at (x=0, y=0)",
                "section z=14: hole d8 at (x=0, y=0)"
            ])
        );
        assert_eq!(
            rows.iter()
                .map(|row| row["state"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["passed", "passed", "passed", "passed", "failed", "passed"]
        );
        assert!(rows.iter().all(|row| row["from"] == "listed"));
        assert_eq!(report["listedBy"], "agent");
        assert_eq!(
            report["counts"],
            json!({"items": 6, "passed": 5, "failed": 1, "unasserted": 0, "notShown": 0, "blocking": 0})
        );
        // No item owns the generic lines.
        assert!(!rows.iter().any(|row| row["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c == "watertight")));
        // Without items or linked requirements there is no report at all.
        assert!(
            assess(&json!({"size": [1, 2, 3]}), &[], &lines(&[]), "agent")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn an_item_without_assertions_blocks_whatever_requirement_it_names() {
        let mut expect = pulley();
        expect["spec"][4] = json!({"item": "groove bottom Ø50", "requirementId": "could"});
        let report = report(
            &expect,
            &[requirement("could", Kind::Features(vec![]))],
            &[],
        );
        assert_eq!(report["items"][4]["state"], "unasserted");
        assert_eq!(report["counts"]["blocking"], 1);
    }

    #[test]
    fn statement_rows_are_shown_only_by_a_dimensional_item_naming_the_requirement() {
        let fit = requirement("fit", Kind::Statement);
        let expect = |item: Value| expect::normalize(&json!({"spec": [item]})).unwrap().expect;
        let row =
            |expect: &Value| report(expect, std::slice::from_ref(&fit), &[])["items"][1].clone();
        // A body count names the requirement but shows no dimension.
        let shells = row(&expect(
            json!({"item": "fits", "requirementId": "fit", "shells": 1}),
        ));
        assert_eq!(
            (shells["state"].as_str(), shells["statement"].as_bool()),
            (Some("unasserted"), Some(true))
        );
        let points = row(&expect(
            json!({"item": "fits", "requirementId": "fit", "solid": [[29.5, 0, 3.5]]}),
        ));
        assert_eq!(points["state"], "unasserted");
        let sized = row(&expect(
            json!({"item": "fits", "requirementId": "fit", "bbox": {"min": [-30, -30, 0], "max": [30, 30, 16]}}),
        ));
        assert_eq!(sized["state"], "passed");
        assert_eq!(sized["checks"], json!(["bounding box"]));
        assert_eq!(sized["item"], "Requirement fit");
        // An item that does not name it shows nothing for it.
        let other = row(&expect(
            json!({"item": "fits", "bbox": {"min": [-30, -30, 0], "max": [30, 30, 16]}}),
        ));
        assert_eq!(other["state"], "unasserted");
        let failing = report(
            &expect(
                json!({"item": "fits", "requirementId": "fit", "bbox": {"min": [-30, -30, 0], "max": [30, 30, 16]}}),
            ),
            std::slice::from_ref(&fit),
            &["bounding box"],
        );
        assert_eq!(failing["items"][1]["state"], "failed");
    }

    #[test]
    fn requirements_no_geometry_shows_are_advice_that_never_passes() {
        assert!(matches!(
            kind_of(&json!({"statement": "Carries 0.3 kg", "target": {"value": 0.3, "unit": "kg"}})),
            Kind::Advice(reason) if reason.contains("mass")
        ));
        assert!(matches!(
            kind_of(&json!({"statement": "Lasts 20 min", "target": {"value": 20, "unit": "min"}})),
            Kind::Advice(_)
        ));
        assert!(matches!(
            kind_of(&json!({"statement": "Printable in PETG"})),
            Kind::Advice(_)
        ));
        assert!(matches!(
            kind_of(&json!({"statement": "Infill", "target": {"value": 20, "unit": "%"}})),
            Kind::Advice(_)
        ));
        assert!(matches!(
            kind_of(
                &json!({"statement": "Unknown", "target": {"unknown": true, "reason": "not decided"}})
            ),
            Kind::Advice(_)
        ));
        for unit in ["mm", "m^2", "mm^3", "deg"] {
            assert!(
                matches!(
                    kind_of(&json!({"statement": "Fits", "target": {"value": 20, "unit": unit}})),
                    Kind::Statement
                ),
                "{unit}"
            );
        }
        let petg = requirement("petg", kind_of(&json!({"statement": "Printable in PETG"})));
        let expect = expect::normalize(
            &json!({"spec": [{"item": "printable", "requirementId": "petg", "shells": 1}]}),
        )
        .unwrap()
        .expect;
        let report = report(&expect, std::slice::from_ref(&petg), &[]);
        assert_eq!(report["items"][0]["state"], "passed");
        let row = &report["items"][1];
        assert_eq!(row["state"], "not_shown");
        assert!(row["reason"]
            .as_str()
            .unwrap()
            .starts_with("No check shows this requirement"));
        assert_eq!(report["counts"]["blocking"], 0);
        assert_eq!(report["counts"]["notShown"], 1);
    }

    fn groove(single_part: bool) -> Linked {
        Linked {
            single_part,
            ..requirement(
                "groove",
                Kind::Features(vec![Feature {
                    label: "groove bottom Ø50".into(),
                    fragment: Some(
                        json!({"sections": [{"axis": "z", "at": 8, "outer": {"d": 50}}]}),
                    ),
                }]),
            )
        }
    }

    #[test]
    fn a_feature_row_says_whose_assertions_show_it() {
        // Taken from the requirement: its own assertion shows the feature.
        let own = groove(true);
        let canonical =
            expect::normalize_with(&json!({"spec": []}), &derived(std::slice::from_ref(&own)))
                .unwrap()
                .expect;
        let row = &report(&canonical, std::slice::from_ref(&own), &[])["items"][0];
        assert_eq!(
            (&row["from"], &row["assertedBy"], &row["state"]),
            (
                &json!("requirement"),
                &json!("requirement"),
                &json!("passed")
            )
        );
        // Linked to another part too, the requirement's assertion is not
        // taken; one listed for its feature shows it, and says so.
        let shared = groove(false);
        let listed = json!({"spec": [{"item": "groove bottom Ø50", "requirementId": "groove",
            "solid": [[29.5, 0, 3.5]]}]});
        let canonical = expect::normalize_with(&listed, &derived(std::slice::from_ref(&shared)))
            .unwrap()
            .expect;
        let row = &report(&canonical, std::slice::from_ref(&shared), &[])["items"][0];
        assert_eq!(
            (&row["from"], &row["assertedBy"]),
            (&json!("requirement"), &json!("listed"))
        );
        // Without an assertion there is nothing to attribute.
        let bare = expect::normalize_with(
            &json!({"spec": [{"item": "groove bottom Ø50", "requirementId": "groove"}]}),
            &derived(std::slice::from_ref(&shared)),
        )
        .unwrap()
        .expect;
        let row = &report(&bare, std::slice::from_ref(&shared), &[])["items"][0];
        assert_eq!(row["state"], "unasserted");
        assert!(row.get("assertedBy").is_none());
        // What a check derives differs once the requirement is shared, so a
        // check that took its assertion no longer stands for it.
        let payload = json!({});
        assert_ne!(
            hash_of(&own.kind, &payload, true),
            hash_of(&own.kind, &payload, false)
        );
        let labels = Kind::Features(vec![Feature {
            label: "Flanks".into(),
            fragment: None,
        }]);
        assert_eq!(
            hash_of(&labels, &payload, true),
            hash_of(&labels, &payload, false)
        );
    }

    #[test]
    fn an_item_in_the_words_of_a_statement_requirement_is_its_row() {
        let fit = requirement("fit", Kind::Statement);
        let placeholder = expect::normalize(&json!({"spec": [
            {"item": "plate", "bbox": {"min": [-30, -30, 0], "max": [30, 30, 16]}},
            {"item": "Requirement fit", "requirementId": "fit"}]}))
        .unwrap()
        .expect;
        let bare = report(&placeholder, std::slice::from_ref(&fit), &[]);
        assert_eq!(
            bare["counts"],
            json!({"items": 2, "passed": 1, "failed": 0, "unasserted": 1, "notShown": 0, "blocking": 1})
        );
        let rows = bare["items"].as_array().unwrap();
        assert_eq!(rows[1]["statement"], true);
        let missing = rows
            .iter()
            .filter(|row| row["state"] == "unasserted")
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            verification::quoted(&missing, 1),
            "requirement \"Requirement fit\""
        );
        // Given a dimension, the same item shows the requirement, still once.
        let mut sized = placeholder.clone();
        sized["spec"][1]["bbox"] = json!({"min": [-30, -30, 0], "max": [30, 30, 16]});
        let shown = report(&sized, std::slice::from_ref(&fit), &[]);
        assert_eq!(shown["counts"]["items"], 2);
        assert_eq!(shown["items"][1]["state"], "passed");
        assert_eq!(shown["items"][1]["assertedBy"], "listed");
        assert_eq!(shown["items"][1]["checks"], json!(["bounding box"]));
    }

    #[test]
    fn requirements_that_disagree_leave_no_check_to_run() {
        let size = |id: &str, z: f64| Linked {
            title: format!("Envelope {id}"),
            ..requirement(
                id,
                Kind::Features(vec![Feature {
                    label: "Envelope".into(),
                    fragment: Some(json!({"size": [20, 10, z]})),
                }]),
            )
        };
        assert!(conflict(&[size("A", 2.0)]).is_none());
        assert_eq!(
            conflict(&[size("A", 2.0), size("B", 3.0)]).as_deref(),
            Some(
                "requirements \"Envelope A\" and \"Envelope B\" state different size for this part"
            )
        );
        // Shared with another part, their assertions are not taken, and
        // nothing disagrees.
        let shared = Linked {
            single_part: false,
            ..size("B", 3.0)
        };
        assert!(conflict(&[size("A", 2.0), shared]).is_none());
    }

    #[test]
    fn checked_items_rewrite_paths_and_repair() {
        let (repaired, notes) = checked_items(&json!({"spec": [
            {"item": "bore", "holes": [{"at": [0, 0, 2], "d": "8"}]}]}))
        .unwrap();
        assert_eq!(repaired["spec"][0]["holes"][0]["d"], 8);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("expect.spec[0].holes[0].d"), "{notes:?}");
        let error = checked_items(&json!({"spec": [{"item": "a"},
            {"item": "groove", "sections": [{"axis": "z", "at": 8, "bogus": 1}]}]}))
        .err()
        .unwrap();
        assert_eq!(error.issues()[0].path, "expect.spec[1].sections[0].bogus");
        assert!(
            error.message.contains("expect.spec[1].sections[0].bogus"),
            "{}",
            error.message
        );
        assert!(error
            .repair
            .unwrap()
            .starts_with("expect.spec[1].… takes the assertions of expect"));
    }

    #[test]
    fn check_features_rejects_bad_fragments_with_payload_paths() {
        let mut payload = json!({"statement": "Groove", "acceptanceCriterion": "Shown", "features": [
            {"label": "Groove bottom Ø50", "expect": {"sections": [{"axis": "z", "at": 8, "outer": {"d": "50"}}]}},
            {"label": "Flanks"}]});
        check_features("requirement", &mut payload).unwrap();
        assert_eq!(
            payload["features"][0]["expect"]["sections"][0]["outer"]["d"],
            50
        );
        let mut bad = json!({"features": [{"label": "a", "expect": {"tol": 0.1}}]});
        let error = check_features("requirement", &mut bad).err().unwrap();
        assert_eq!(error.issues()[0].path, "payload.features[0].expect.tol");
        let mut bad = json!({"features": [{"label": "a", "expect": {"size": [1, 0, 1]}}]});
        let error = check_features("requirement", &mut bad).err().unwrap();
        assert_eq!(error.issues()[0].path, "payload.features[0].expect.size");
        let mut bad =
            json!({"features": [{"label": "a", "expect": {"sections": [{"axis": "w", "at": 1}]}}]});
        let error = check_features("requirement", &mut bad).err().unwrap();
        assert!(error.issues()[0]
            .path
            .starts_with("payload.features[0].expect.sections[0]"));
        let mut repeated = json!({"features": [{"label": "Groove"}, {"label": " groove "}]});
        let error = check_features("requirement", &mut repeated).err().unwrap();
        assert_eq!(error.issues()[0].path, "payload.features[1].label");
        // A label of spaces alone would give its item no words.
        let mut blank = json!({"features": [{"label": "Groove"}, {"label": " \t "}]});
        let error = check_features("requirement", &mut blank).err().unwrap();
        assert_eq!(error.issues()[0].path, "payload.features[1].label");
        assert!(error.message.ends_with("is blank"), "{}", error.message);
        // Other types are not touched.
        let mut other = json!({"features": [{"label": "a", "expect": {"tol": 0.1}}]});
        check_features("note", &mut other).unwrap();
    }

    #[test]
    fn blank_titles_and_labels_still_give_items_words() {
        let artifact = |title: &str| json!({"id": "r1", "title": title});
        let payload = json!({"statement": "  Fits the\n20 mm bay "});
        assert_eq!(
            title_text(&artifact("  Bay  fit "), Some(&payload)),
            "Bay fit"
        );
        assert_eq!(
            title_text(&artifact(" \t "), Some(&payload)),
            "Fits the 20 mm bay"
        );
        assert_eq!(
            title_text(&artifact(" "), Some(&json!({"statement": " "}))),
            "requirement r1"
        );
        assert_eq!(title_text(&artifact(" "), None), "requirement r1");
        // A blank label stored before labels were checked on write.
        let Kind::Features(features) =
            kind_of(&json!({"features": [{"label": "Envelope"}, {"label": "   "}]}))
        else {
            panic!("features");
        };
        assert_eq!(
            features
                .iter()
                .map(|f| f.label.as_str())
                .collect::<Vec<_>>(),
            ["Envelope", "feature 2"]
        );
    }

    #[test]
    fn fragments_are_derived_only_for_a_requirement_of_one_part() {
        let features = Kind::Features(vec![Feature {
            label: "Groove bottom Ø50".into(),
            fragment: Some(json!({"sections": [{"axis": "z", "at": 8, "outer": {"d": 50}}]})),
        }]);
        let mut shared = requirement("r1", features);
        assert!(derived(std::slice::from_ref(&shared))[0].features[0]
            .fragment
            .is_some());
        shared.single_part = false;
        assert!(derived(std::slice::from_ref(&shared))[0].features[0]
            .fragment
            .is_none());
        assert!(derived(&[requirement("r2", Kind::Statement)]).is_empty());
    }

    #[test]
    fn readiness_lists_gaps_and_links_made_since() {
        let mut expect = pulley();
        expect["spec"][4] = json!({"item": "groove bottom Ø50"});
        let report = report(&expect, &[requirement("fit", Kind::Statement)], &[]);
        let evidence = json!({"spec": report});
        let since = vec![
            json!({"requirementId": "r9", "revisionId": "x", "title": "Envelope", "change": "linked_after"}),
        ];
        let read = readiness(&evidence, since, None).unwrap();
        assert_eq!(read["blocking"], 3);
        assert_eq!(
            read["missing"],
            json!([{"item": "groove bottom Ø50"}, {"item": "Requirement fit", "requirementId": "fit", "statement": true}])
        );
        assert_eq!(read["linkedSinceCount"], 1);
        assert!(readiness(&json!({}), vec![], None).is_none());
        let only_since = readiness(&json!({}), vec![json!({"requirementId": "r9"})], None).unwrap();
        assert_eq!(only_since["counts"]["items"], 0);
        assert_eq!(only_since["blocking"], 1);
    }
}
