//! The expectation vocabulary of `cad.check`.
//!
//! A request may state expectations in a short form (`size`, `holes`,
//! `bodies`, one default `tol`). `normalize` turns that into the canonical
//! expectation before anything is measured, hashed or compared, so the short
//! form and its long equivalent are the same verification scope. Numbers are
//! canonical too: `2` and `2.0` are one value.
use super::*;
use serde_json::Map;

/// Default linear tolerance in millimetres and relative tolerance in percent.
pub(crate) const LINEAR_TOLERANCE: f64 = 0.1;
pub(crate) const PERCENT_TOLERANCE: f64 = 1.5;
pub(crate) const MIN_ROUNDNESS: f64 = 0.97;

const KEY_ORDER: [&str; 13] = [
    "size",
    "bbox",
    "volume",
    "shells",
    "solid",
    "empty",
    "sections",
    "watertight",
    "minRoundness",
    "maxSelfIntersections",
    "preserve",
    "tol",
    "spec",
];

/// Keys a spec item may carry besides `item` and `requirementId`: the
/// assertion groups of the top level, in the same form.
pub(crate) const ITEM_ASSERTIONS: [&str; 9] = [
    "size", "holes", "bodies", "shells", "bbox", "volume", "solid", "empty", "sections",
];
/// Canonical groups that state a dimension of the part. A body count or a
/// point inside or outside material does not.
pub(crate) const DIMENSIONAL: [&str; 4] = ["size", "bbox", "volume", "sections"];
pub(crate) const MAX_SPEC_ITEMS: usize = 128;
/// Longest item text, after spaces are collapsed.
pub(crate) const ITEM_CHARS: usize = 200;

pub(crate) struct Normalized {
    /// Canonical expectation: what is measured, stored as evidence and compared.
    pub expect: Value,
    /// Input that had no effect, in words.
    pub ignored: Vec<String>,
    /// True when the canonical form differs from what was sent.
    pub changed: bool,
    /// Items and assertions linked requirements added, in words.
    pub added: Vec<String>,
    /// Requirement items whose current assertions replaced different ones
    /// that were sent for them, and (`rederive`) what gave way to them.
    pub replaced: Vec<String>,
    /// The assertions `replaced` names, as they were sent.
    pub superseded: Vec<Value>,
}

/// One feature of a linked requirement, as a check derives it: its label
/// (at most `ITEM_CHARS`) and its assertions, when the check takes them.
#[derive(Clone)]
pub(crate) struct Feature {
    pub label: String,
    pub fragment: Option<Value>,
}

/// The features one linked requirement adds to a check.
#[derive(Clone)]
pub(crate) struct Derived {
    pub requirement_id: String,
    pub title: String,
    pub features: Vec<Feature>,
}

fn canonical_numbers(value: &Value) -> Value {
    match value {
        Value::Number(number) => number
            .as_f64()
            .map(params::number_value)
            .unwrap_or_else(|| value.clone()),
        Value::Array(items) => Value::Array(items.iter().map(canonical_numbers).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, item)| !item.is_null())
                .map(|(key, item)| (key.clone(), canonical_numbers(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn sorted(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        Value::Object(map) => {
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, item)| (key.clone(), sorted(item)))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

fn axis_index(axis: &str) -> CoreResult<usize> {
    match axis {
        "x" => Ok(0),
        "y" => Ok(1),
        "z" => Ok(2),
        other => Err(ContractError::validation(format!(
            "Unknown axis \"{other}\"; expected x, y or z"
        ))),
    }
}

fn invalid(path: &str, message: &str, repair: &str) -> ContractError {
    ContractError::validation(format!("Invalid input: {path}: {message}"))
        .with_repair(repair)
        .with_details(json!({"issues": [{"path": path, "kind": "other", "message": message}]}))
}

/// Does any assertion fall back to the default linear tolerance?
fn uses_default_tolerance(expect: &Value) -> bool {
    let lacks = |item: &Value| item.is_object() && item.get("tol").is_none();
    lacks(&expect["bbox"])
        || expect.get("size").is_some()
        || expect["sections"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|section| {
                lacks(&section["outer"])
                    || ["holes", "slots", "polygons"].iter().any(|kind| {
                        section[*kind]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|shape| shape.get("tol").is_none())
                    })
            })
}

/// Keys in `KEY_ORDER` first, then anything else in the order it came.
fn ordered(mut map: Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for key in KEY_ORDER {
        if let Some(value) = map.shift_remove(key) {
            out.insert(key.to_owned(), value);
        }
    }
    out.extend(map);
    out
}

/// The short form of one set of assertions, expanded: `bodies` becomes
/// `shells`, each hole a section assertion and an empty probe. Errors name
/// `path` (`expect`, `expect.spec[2]`, a requirement feature).
fn expand(mut expect: Map<String, Value>, path: &str) -> CoreResult<Map<String, Value>> {
    if let Some(bodies) = expect.shift_remove("bodies") {
        match expect.get("shells") {
            Some(shells) if *shells != bodies => {
                return Err(invalid(
                    &format!("{path}.bodies"),
                    &format!("disagrees with {path}.shells"),
                    "bodies is another name for shells; send one of them.",
                ))
            }
            _ => {
                expect.insert("shells".into(), bodies);
            }
        }
    }
    if let Some(size) = expect.get("size") {
        if !size.as_array().is_some_and(|values| {
            values.len() == 3 && values.iter().all(|v| v.as_f64() > Some(0.0))
        }) {
            return Err(invalid(
                &format!("{path}.size"),
                "expected three positive numbers [x, y, z] in mm",
                "Send the overall size of the part along x, y and z.",
            ));
        }
    }
    if let Some(holes) = expect.shift_remove("holes") {
        let mut sections = expect
            .get("sections")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut empty = expect
            .get("empty")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (index, hole) in holes.as_array().into_iter().flatten().enumerate() {
            let path = format!("{path}.holes[{index}]");
            let at = hole["at"]
                .as_array()
                .filter(|point| point.len() == 3 && point.iter().all(Value::is_number))
                .ok_or_else(|| {
                    invalid(
                        &format!("{path}.at"),
                        "expected a point [x, y, z] in mm",
                        "Give a point on the hole's axis inside the material, for example mid-thickness.",
                    )
                })?;
            if hole["d"].as_f64().is_none_or(|d| d <= 0.0) {
                return Err(invalid(
                    &format!("{path}.d"),
                    "expected a positive diameter in mm",
                    "Send the hole diameter from the request.",
                ));
            }
            let axis_name = hole["axis"].as_str().unwrap_or("z");
            let axis = axis_index(axis_name)?;
            let centre = (0..3)
                .filter(|i| *i != axis)
                .map(|i| at[i].clone())
                .collect::<Vec<_>>();
            let assertion = json!({"center": centre, "d": hole["d"]});
            let existing = sections
                .iter_mut()
                .find(|section| section["axis"] == axis_name && section["at"] == at[axis]);
            match existing {
                Some(section) => match section["holes"].as_array_mut() {
                    Some(list) => list.push(assertion),
                    None => section["holes"] = json!([assertion]),
                },
                None => {
                    sections.push(json!({"axis": axis_name, "at": at[axis], "holes": [assertion]}))
                }
            }
            let probe = Value::Array(at.clone());
            if !empty.contains(&probe) {
                empty.push(probe);
            }
        }
        expect.insert("sections".into(), Value::Array(sections));
        expect.insert("empty".into(), Value::Array(empty));
    }
    for key in ["solid", "empty", "sections"] {
        if expect
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            expect.shift_remove(key);
        }
    }
    Ok(ordered(expect))
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Identity of an item across checks: the requirement it answers and its
/// words, case and spacing aside.
pub(crate) fn item_key(item: &Value) -> (String, String) {
    (
        item["requirementId"].as_str().unwrap_or("").to_owned(),
        collapse(item["item"].as_str().unwrap_or("")).to_lowercase(),
    )
}

fn groups_map(item: &Value) -> Map<String, Value> {
    item.as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| ITEM_ASSERTIONS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// The assertion groups of one item, as an object.
pub(crate) fn item_groups(item: &Value) -> Value {
    Value::Object(groups_map(item))
}

fn item_value(text: &str, requirement: Option<&str>, groups: Map<String, Value>) -> Value {
    let mut out = Map::new();
    out.insert("item".into(), json!(collapse(text)));
    if let Some(id) = requirement {
        out.insert("requirementId".into(), json!(id));
    }
    out.extend(ordered(groups));
    Value::Object(out)
}

/// One `expect.spec[index]` in canonical form.
fn spec_item(raw: &Value, index: usize, earlier: &[Value]) -> CoreResult<Value> {
    let path = format!("expect.spec[{index}]");
    let object = raw.as_object().ok_or_else(|| {
        invalid(
            &path,
            "expected an object",
            "Send each item as {\"item\": \"<the request's words>\", …its assertions}.",
        )
    })?;
    if let Some(key) = object.keys().find(|key| {
        !matches!(key.as_str(), "item" | "requirementId")
            && !ITEM_ASSERTIONS.contains(&key.as_str())
    }) {
        return Err(invalid(
            &format!("{path}.{key}"),
            "not an item key",
            "A spec item takes item, requirementId and the assertion keys size, holes, bodies, shells, bbox, volume, solid, empty and sections; tol, watertight, minRoundness, maxSelfIntersections and preserve stay at the top level of expect.",
        ));
    }
    let text = object
        .get("item")
        .and_then(Value::as_str)
        .map(collapse)
        .unwrap_or_default();
    if text.is_empty() {
        return Err(invalid(
            &format!("{path}.item"),
            "required",
            "Name the dimension or feature in the request's words.",
        ));
    }
    if text.chars().count() > ITEM_CHARS {
        return Err(invalid(
            &format!("{path}.item"),
            "longer than 200 characters",
            "Shorten the item; put the detail in its assertions.",
        ));
    }
    let requirement = match object.get("requirementId") {
        None => None,
        Some(Value::String(id)) => Some(id.as_str()),
        Some(_) => {
            return Err(invalid(
                &format!("{path}.requirementId"),
                "expected a requirement id",
                "Give the id of the requirement this item answers, or leave it out.",
            ))
        }
    };
    let value = item_value(&text, requirement, expand(groups_map(raw), &path)?);
    if let Some(first) = earlier
        .iter()
        .position(|item| item_key(item) == item_key(&value))
    {
        return Err(invalid(
            &format!("{path}.item"),
            &format!("repeats expect.spec[{first}].item"),
            "List each requested feature once; put all its assertions in that one item.",
        ));
    }
    Ok(value)
}

fn union(target: &mut Vec<Value>, values: &[Value]) {
    for value in values {
        if !target.contains(value) {
            target.push(value.clone());
        }
    }
}

fn values(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

const DISAGREES: &str = "Each single-valued assertion appears once: give the value the request states in one item, and leave it out of the top level of expect and of other items.";

/// Parts of a section that join as lists; the rest of a plane holds one value
/// per assertion.
const SECTION_LISTS: [&str; 3] = ["holes", "slots", "polygons"];

fn same_plane(a: &Value, b: &Value) -> bool {
    a["axis"] == b["axis"] && a["at"] == b["at"]
}

fn plane_name(section: &Value) -> String {
    format!(
        "{}={}",
        section["axis"].as_str().unwrap_or("?"),
        section["at"]
    )
}

/// The first single-valued assertion `b` states differently from `a`: the
/// key it sits under and the assertion in words (`size`, `outer at z=8`).
/// Lists join and never disagree.
fn disagreement(a: &Map<String, Value>, b: &Map<String, Value>) -> Option<(String, String)> {
    for (key, value) in b {
        match key.as_str() {
            "solid" | "empty" => {}
            "sections" => {
                let planes = a.get("sections").map(values).unwrap_or(&[]);
                for section in values(value) {
                    let Some(existing) = planes.iter().find(|plane| same_plane(plane, section))
                    else {
                        continue;
                    };
                    for (name, assertion) in section.as_object().into_iter().flatten() {
                        if matches!(name.as_str(), "axis" | "at")
                            || SECTION_LISTS.contains(&name.as_str())
                        {
                            continue;
                        }
                        if existing.get(name).is_some_and(|old| old != assertion) {
                            return Some((
                                "sections".to_owned(),
                                format!("{name} at {}", plane_name(section)),
                            ));
                        }
                    }
                }
            }
            _ => {
                if a.get(key).is_some_and(|old| old != value) {
                    return Some((key.clone(), key.clone()));
                }
            }
        }
    }
    None
}

/// Merge one canonical set of assertions into a canonical expectation. Lists
/// join and repeat nothing; sections join by plane. A single-valued
/// assertion keeps the value that is there; callers check `disagreement`
/// first.
fn merge_into(target: &mut Map<String, Value>, fragment: &Map<String, Value>) {
    for (key, value) in fragment {
        match key.as_str() {
            "solid" | "empty" => {
                let list = target.entry(key.clone()).or_insert_with(|| json!([]));
                if let Some(list) = list.as_array_mut() {
                    union(list, values(value));
                }
            }
            "sections" => {
                let list = target.entry(key.clone()).or_insert_with(|| json!([]));
                let Some(sections) = list.as_array_mut() else {
                    continue;
                };
                for section in values(value) {
                    let Some(existing) = sections
                        .iter_mut()
                        .find(|existing| same_plane(existing, section))
                    else {
                        sections.push(section.clone());
                        continue;
                    };
                    for (name, assertion) in section.as_object().into_iter().flatten() {
                        if matches!(name.as_str(), "axis" | "at") {
                            continue;
                        }
                        if SECTION_LISTS.contains(&name.as_str()) {
                            let list = &mut existing[name.as_str()];
                            if !list.is_array() {
                                *list = json!([]);
                            }
                            if let Some(list) = list.as_array_mut() {
                                union(list, values(assertion));
                            }
                        } else if existing.get(name).is_none() {
                            existing[name.as_str()] = assertion.clone();
                        }
                    }
                }
            }
            _ => {
                target.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
    }
}

/// Take out of `groups` every single-valued assertion `stated` gives
/// differently. Returns what was taken out, as assertion groups, and each
/// one in words; a section left asserting nothing goes too.
fn yield_to(
    stated: &Map<String, Value>,
    groups: &mut Map<String, Value>,
) -> (Map<String, Value>, Vec<String>) {
    let (mut gone, mut words) = (Map::new(), Vec::new());
    for key in ["size", "bbox", "volume", "shells"] {
        if let (Some(theirs), Some(mine)) = (stated.get(key), groups.get(key)) {
            if theirs != mine {
                gone.insert(key.to_owned(), mine.clone());
                groups.shift_remove(key);
                words.push(key.to_owned());
            }
        }
    }
    let planes = stated.get("sections").map(values).unwrap_or(&[]);
    if let Some(sections) = groups.get_mut("sections").and_then(Value::as_array_mut) {
        let mut taken = Vec::new();
        for section in sections.iter_mut() {
            let Some(theirs) = planes.iter().find(|plane| same_plane(plane, section)) else {
                continue;
            };
            let Some(fields) = section.as_object_mut() else {
                continue;
            };
            let mut part = json!({"axis": fields["axis"], "at": fields["at"]});
            let names = fields
                .iter()
                .filter(|(name, value)| {
                    !matches!(name.as_str(), "axis" | "at")
                        && !SECTION_LISTS.contains(&name.as_str())
                        && theirs.get(name.as_str()).is_some_and(|old| old != *value)
                })
                .map(|(name, _)| name.clone())
                .collect::<Vec<_>>();
            for name in names {
                words.push(format!("{name} at {}", plane_name(&part)));
                part[name.as_str()] = fields.shift_remove(&name).unwrap_or(Value::Null);
            }
            if part.as_object().is_some_and(|part| part.len() > 2) {
                taken.push(part);
            }
            if fields.keys().all(|name| name == "axis" || name == "at") {
                fields.clear();
            }
        }
        sections.retain(|section| section.as_object().is_some_and(|f| !f.is_empty()));
        if !taken.is_empty() {
            gone.insert("sections".to_owned(), Value::Array(taken));
        }
    }
    if groups
        .get("sections")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
    {
        groups.shift_remove("sections");
    }
    (gone, words)
}

/// Take out of `top` every assertion `groups` carries, the inverse of
/// `merge_into` for values that agree. A section left asserting nothing by
/// it goes too.
fn subtract(top: &mut Map<String, Value>, groups: &Map<String, Value>) {
    for (key, value) in groups {
        match key.as_str() {
            "solid" | "empty" => {
                if let Some(list) = top.get_mut(key).and_then(Value::as_array_mut) {
                    list.retain(|point| !values(value).contains(point));
                    if list.is_empty() {
                        top.shift_remove(key);
                    }
                }
            }
            "sections" => {
                let Some(sections) = top.get_mut(key).and_then(Value::as_array_mut) else {
                    continue;
                };
                for section in values(value) {
                    let Some(existing) = sections
                        .iter_mut()
                        .find(|e| e["axis"] == section["axis"] && e["at"] == section["at"])
                    else {
                        continue;
                    };
                    let Some(fields) = existing.as_object_mut() else {
                        continue;
                    };
                    let before = fields.len();
                    for (name, assertion) in section.as_object().into_iter().flatten() {
                        match name.as_str() {
                            "axis" | "at" => {}
                            "holes" | "slots" | "polygons" => {
                                if let Some(list) =
                                    fields.get_mut(name).and_then(Value::as_array_mut)
                                {
                                    list.retain(|shape| !values(assertion).contains(shape));
                                    if list.is_empty() {
                                        fields.shift_remove(name);
                                    }
                                }
                            }
                            _ => {
                                if fields.get(name) == Some(assertion) {
                                    fields.shift_remove(name);
                                }
                            }
                        }
                    }
                    if fields.len() < before && fields.keys().all(|k| k == "axis" || k == "at") {
                        fields.clear();
                    }
                }
                sections.retain(|section| section.as_object().is_some_and(|f| !f.is_empty()));
                if sections.is_empty() {
                    top.shift_remove(key);
                }
            }
            _ => {
                if top.get(key) == Some(value) {
                    top.shift_remove(key);
                }
            }
        }
    }
}

/// Check one set of assertions the way `normalize` would expand it, naming
/// `path` in the error: positive sizes, hole points and diameters.
pub(crate) fn check_assertions(groups: &Value, path: &str) -> CoreResult<()> {
    let groups = canonical_numbers(groups)
        .as_object()
        .cloned()
        .unwrap_or_default();
    expand(groups, path).map(|_| ())
}

/// Expand the short form into canonical assertions. Pure: the result depends
/// on the request alone, never on the measured part.
#[cfg(test)]
pub(crate) fn normalize(input: &Value) -> CoreResult<Normalized> {
    normalize_with(input, &[])
}

/// `normalize`, with the features of linked requirements as items. Each
/// item's assertions are merged into the top level, which is what is
/// measured; the canonical form keeps the items under `spec`, so the scope
/// guard binds them. A value that disagrees with another is refused with
/// both places named. Pure, like `normalize`.
pub(crate) fn normalize_with(input: &Value, derived: &[Derived]) -> CoreResult<Normalized> {
    normalized(input, derived, false)
}

/// `input` as it reads with the linked requirements as they stand: like
/// `normalize_with`, but an assertion of the input that a requirement now
/// states differently gives way to the requirement's, and an item left with
/// no assertion goes. `replaced` names what gave way. Requirements that
/// disagree with one another are still refused. Used to restate a committed
/// scope, never to read a caller's request.
pub(crate) fn rederive(input: &Value, derived: &[Derived]) -> CoreResult<Normalized> {
    normalized(input, derived, true)
}

/// Who stated an item's assertions, to name both places when two disagree.
enum Source {
    /// `expect.spec[index]`, as sent.
    Listed(usize),
    /// Feature `index` of a linked requirement, with its own assertions.
    Requirement {
        id: String,
        title: String,
        label: String,
        index: usize,
    },
}

impl Source {
    fn path(&self) -> String {
        match self {
            Source::Listed(index) => format!("expect.spec[{index}]"),
            Source::Requirement { title, index, .. } => {
                format!("requirement \"{title}\" features[{index}].expect")
            }
        }
    }
}

/// The error for item `at` whose `slot` (under `key`) disagrees with what
/// `other` states: the top level of expect (`None`) or another item.
fn disagreeing(
    items: &[Value],
    sources: &[Source],
    at: usize,
    other: Option<usize>,
    key: &str,
    slot: &str,
) -> ContractError {
    const STATED: &str = "The requirement's value is the one checked: leave it out of the top level of expect and of the items you list, or ask a person to change the requirement.";
    let requirement = |source: &Source| match source {
        Source::Requirement { title, label, .. } => {
            format!("the {slot} requirement \"{title}\" states for \"{label}\"")
        }
        Source::Listed(index) => format!(
            "the {slot} of expect.spec[{index}] (\"{}\")",
            reads::clip(items[*index]["item"].as_str().unwrap_or(""), 60)
        ),
    };
    match (&sources[at], other.map(|other| &sources[other])) {
        (Source::Listed(index), None) => invalid(
            &format!("expect.spec[{index}].{key}"),
            &format!("disagrees with the {slot} at the top level of expect"),
            DISAGREES,
        ),
        (Source::Requirement { .. }, None) => invalid(
            &format!("expect.{key}"),
            &format!("disagrees with {}", requirement(&sources[at])),
            STATED,
        ),
        (Source::Listed(index), Some(other @ Source::Requirement { .. }))
        | (other @ Source::Requirement { .. }, Some(Source::Listed(index))) => invalid(
            &format!("expect.spec[{index}].{key}"),
            &format!("disagrees with {}", requirement(other)),
            STATED,
        ),
        (Source::Listed(index), Some(other)) => invalid(
            &format!("expect.spec[{index}].{key}"),
            &format!("disagrees with {}", requirement(other)),
            DISAGREES,
        ),
        (source, Some(other)) => requirements_disagree(source, other, key, slot),
    }
}

/// Two linked requirements state one assertion of the part differently: no
/// check of it can pass until a person reconciles them.
fn requirements_disagree(source: &Source, other: &Source, key: &str, slot: &str) -> ContractError {
    let (
        Source::Requirement {
            id, title, label, ..
        },
        Source::Requirement {
            id: other_id,
            title: other_title,
            label: other_label,
            ..
        },
    ) = (source, other)
    else {
        return invalid(&source.path(), &format!("{slot} disagrees"), DISAGREES);
    };
    let message = if id == other_id {
        format!(
            "requirement \"{title}\" states different {slot} for \"{other_label}\" and \"{label}\""
        )
    } else {
        format!(
            "requirements \"{other_title}\" and \"{title}\" state different {slot} for this part"
        )
    };
    invalid(
        &format!("{}.{key}", source.path()),
        &message,
        "A person must reconcile the requirements; no check of this part can run until they agree. Report it instead of checking again.",
    )
}

fn normalized(input: &Value, derived: &[Derived], yielding: bool) -> CoreResult<Normalized> {
    let mut map = if input.is_null() {
        Map::new()
    } else {
        canonical_numbers(input)
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("expect", "expected an object", "Send expect as an object."))?
    };
    let mut ignored = Vec::new();
    let spec = map.shift_remove("spec");
    let mut top = expand(map, "expect")?;
    let mut items = Vec::<Value>::new();
    match &spec {
        None => {}
        Some(Value::Array(list)) => {
            for (index, raw) in list.iter().enumerate() {
                let item = spec_item(raw, index, &items)?;
                items.push(item);
            }
        }
        Some(_) => {
            return Err(invalid(
                "expect.spec",
                "expected a list of items",
                "Send spec as a list with one {\"item\": …, …assertions} per requested dimension or feature.",
            ))
        }
    }
    // An echoed canonical form also holds each item's assertions at the top
    // level; they are the item's, and merge back below.
    let sent_top = top.clone();
    for item in &items {
        subtract(&mut top, &groups_map(item));
    }
    let mut sources = (0..items.len()).map(Source::Listed).collect::<Vec<_>>();
    let (mut added, mut replaced, mut superseded) = (Vec::new(), Vec::new(), Vec::new());
    for requirement in derived {
        let title = &requirement.title;
        for (index, feature) in requirement.features.iter().enumerate() {
            let fragment = match &feature.fragment {
                Some(fragment) => expand(
                    canonical_numbers(fragment)
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                    &format!("requirement \"{title}\" features[{index}].expect"),
                )?,
                None => Map::new(),
            };
            let value = item_value(
                &feature.label,
                Some(&requirement.requirement_id),
                fragment.clone(),
            );
            let label = value["item"].as_str().unwrap_or_default().to_owned();
            let source = Source::Requirement {
                id: requirement.requirement_id.clone(),
                title: title.clone(),
                label: label.clone(),
                index,
            };
            match items
                .iter()
                .position(|item| item_key(item) == item_key(&value))
            {
                // The requirement's current assertions replace what was sent
                // for its item, so a changed requirement is a changed scope
                // rather than a conflict.
                Some(at) if !fragment.is_empty() => {
                    let sent = ordered(groups_map(&items[at]));
                    if sent.is_empty() {
                        added.push(format!("added to \"{label}\" from requirement \"{title}\""));
                    } else if sent != ordered(fragment) {
                        replaced.push(format!("\"{label}\" from requirement \"{title}\""));
                        superseded.push(Value::Object(sent));
                    }
                    items[at] = value;
                    sources[at] = source;
                }
                Some(at) => items[at]["item"] = json!(label),
                None => {
                    added.push(format!("added from requirement \"{title}\": {label}"));
                    items.push(value);
                    sources.push(Source::Requirement {
                        id: requirement.requirement_id.clone(),
                        title: title.clone(),
                        label,
                        index,
                    });
                }
            }
        }
    }
    if items.len() > MAX_SPEC_ITEMS {
        return Err(invalid(
            "expect.spec",
            &format!("{} items, at most {MAX_SPEC_ITEMS}", items.len()),
            "Group the request into at most 128 items; one item may carry several assertions.",
        ));
    }
    // Linked requirements first agree among themselves.
    requirements_agree(&items, &sources)?;
    if yielding {
        yield_to_requirements(
            &mut top,
            &mut items,
            &mut sources,
            &mut replaced,
            &mut superseded,
        );
    }
    let declared = top.clone();
    for (index, item) in items.iter().enumerate() {
        let groups = groups_map(item);
        if let Some((key, slot)) = disagreement(&top, &groups) {
            let other = if disagreement(&declared, &groups).is_some() {
                None
            } else {
                (0..index)
                    .find(|earlier| disagreement(&groups_map(&items[*earlier]), &groups).is_some())
            };
            return Err(disagreeing(&items, &sources, index, other, &key, &slot));
        }
        merge_into(&mut top, &groups);
    }
    // A top-level assertion the caller sent as well as a replaced item goes
    // with that item; say so rather than verify less in silence.
    if !replaced.is_empty() && !yielding {
        let mut lost = sent_top;
        subtract(&mut lost, &top);
        for key in lost.keys() {
            ignored.push(format!(
                "expect.{key}: went with an item whose assertions a linked requirement now states; send it in an item of its own to keep it"
            ));
        }
    }
    let mut canonical = ordered(top);
    if !items.is_empty() {
        canonical.insert("spec".into(), Value::Array(items));
    }
    let mut canonical = Value::Object(canonical);
    if canonical.get("tol").is_some() && !uses_default_tolerance(&canonical) {
        ignored
            .push("expect.tol: no assertion falls back to the default linear tolerance".to_owned());
        canonical
            .as_object_mut()
            .expect("canonical expectation is an object")
            .shift_remove("tol");
    }
    let changed = canonical != *input;
    Ok(Normalized {
        expect: canonical,
        ignored,
        changed,
        added,
        replaced,
        superseded,
    })
}

/// An error when two requirement items state one assertion differently.
fn requirements_agree(items: &[Value], sources: &[Source]) -> CoreResult<()> {
    let mut stated = Map::new();
    let stating = (0..items.len())
        .filter(|index| matches!(sources[*index], Source::Requirement { .. }))
        .collect::<Vec<_>>();
    for (position, index) in stating.iter().enumerate() {
        let groups = groups_map(&items[*index]);
        if let Some((key, slot)) = disagreement(&stated, &groups) {
            let other = stating[..position]
                .iter()
                .find(|earlier| disagreement(&groups_map(&items[**earlier]), &groups).is_some())
                .copied()
                .unwrap_or(*index);
            return Err(requirements_disagree(
                &sources[*index],
                &sources[other],
                &key,
                &slot,
            ));
        }
        merge_into(&mut stated, &groups);
    }
    Ok(())
}

/// `rederive`: the top level and the listed items give way to what each
/// requirement item states; a listed item left without assertions goes.
fn yield_to_requirements(
    top: &mut Map<String, Value>,
    items: &mut Vec<Value>,
    sources: &mut Vec<Source>,
    replaced: &mut Vec<String>,
    superseded: &mut Vec<Value>,
) {
    let asserted = items
        .iter()
        .map(|item| !groups_map(item).is_empty())
        .collect::<Vec<_>>();
    let stating = (0..items.len())
        .filter_map(|index| match &sources[index] {
            Source::Requirement { title, .. } => Some((index, title.clone())),
            Source::Listed(_) => None,
        })
        .collect::<Vec<_>>();
    for (index, title) in stating {
        let theirs = groups_map(&items[index]);
        let (gone, words) = yield_to(&theirs, top);
        if !words.is_empty() {
            replaced.push(format!(
                "{} at the top level (requirement \"{title}\" states it)",
                words.join(", ")
            ));
            superseded.push(Value::Object(gone));
        }
        for listed in 0..items.len() {
            if !matches!(sources[listed], Source::Listed(_)) {
                continue;
            }
            let mut groups = groups_map(&items[listed]);
            let (gone, words) = yield_to(&theirs, &mut groups);
            if words.is_empty() {
                continue;
            }
            replaced.push(format!(
                "{} of \"{}\" (requirement \"{title}\" states it)",
                words.join(", "),
                items[listed]["item"].as_str().unwrap_or("")
            ));
            superseded.push(Value::Object(gone));
            items[listed] = item_value(
                items[listed]["item"].as_str().unwrap_or(""),
                items[listed]["requirementId"].as_str(),
                groups,
            );
        }
    }
    let keep = items
        .iter()
        .zip(&asserted)
        .map(|(item, asserted)| !asserted || !groups_map(item).is_empty())
        .collect::<Vec<_>>();
    let mut kept = keep.iter();
    items.retain(|_| kept.next() == Some(&true));
    let mut kept = keep.iter();
    sources.retain(|_| kept.next() == Some(&true));
}

/// The form a canonical expectation is shown in and sent back as: the top
/// level keeps only what no item asserts, and the items keep their own
/// assertions. `normalize` turns it back into the same canonical form.
pub(crate) fn request_form(expect: &Value) -> Value {
    let (Some(map), Some(items)) = (
        expect.as_object(),
        expect["spec"].as_array().filter(|items| !items.is_empty()),
    ) else {
        return expect.clone();
    };
    let mut top = map.clone();
    top.shift_remove("spec");
    for item in items {
        subtract(&mut top, &groups_map(item));
    }
    top.insert("spec".into(), Value::Array(items.clone()));
    Value::Object(top)
}

fn fill_defaults(map: &mut Map<String, Value>, default_tol: f64) {
    let fill = |item: Option<&mut Value>, key: &str, default: f64| {
        if let Some(object) = item.and_then(Value::as_object_mut) {
            object
                .entry(key)
                .or_insert_with(|| params::number_value(default));
        }
    };
    fill(map.get_mut("bbox"), "tol", default_tol);
    fill(map.get_mut("volume"), "tolPct", PERCENT_TOLERANCE);
    if let Some(size) = map.get_mut("size").filter(|size| size.is_array()) {
        *size = json!({"value": size.take(), "tol": params::number_value(default_tol)});
    }
    let sections = map.get_mut("sections").and_then(Value::as_array_mut);
    for section in sections.into_iter().flatten() {
        for kind in ["holes", "slots", "polygons"] {
            let shapes = section.get_mut(kind).and_then(Value::as_array_mut);
            for shape in shapes.into_iter().flatten() {
                fill(Some(shape), "tol", default_tol);
            }
        }
        fill(section.get_mut("outer"), "tol", default_tol);
        fill(section.get_mut("materialArea"), "tolPct", PERCENT_TOLERANCE);
    }
}

/// The canonical expectation with every default written out and keys sorted:
/// omission is then equivalent to what the checker actually does. Items get
/// the same defaults as the top level.
fn comparison_form(expect: &Value) -> Value {
    let mut map = canonical_numbers(expect)
        .as_object()
        .cloned()
        .unwrap_or_default();
    let default_tol = map
        .shift_remove("tol")
        .and_then(|tol| tol.as_f64())
        .unwrap_or(LINEAR_TOLERANCE);
    map.entry("watertight").or_insert(json!(true));
    map.entry("minRoundness").or_insert(json!(MIN_ROUNDNESS));
    fill_defaults(&mut map, default_tol);
    let items = map.get_mut("spec").and_then(Value::as_array_mut);
    for item in items.into_iter().flatten() {
        if let Some(item) = item.as_object_mut() {
            fill_defaults(item, default_tol);
        }
    }
    sorted(&Value::Object(map))
}

/// The hash of the comparison form; it covers the item texts too.
pub(crate) fn spec_hash(expect: &Value) -> String {
    hash_text(&comparison_form(expect).to_string())
}

/// Does `after` still assert everything `before` did? More assertions and
/// tighter tolerances are covered; anything removed, moved or loosened is not.
fn covers(before: &Value, after: &Value, key: &str) -> bool {
    if before == after {
        return true;
    }
    if let (Some(a), Some(b)) = (before.as_f64(), after.as_f64()) {
        return match key {
            "tol" | "tolPct" | "maxSelfIntersections" => b <= a,
            "minRoundness" => b >= a,
            _ => false,
        };
    }
    if let Some(values) = before.as_array() {
        let Some(next) = after.as_array() else {
            return false;
        };
        // Coordinates are ordered; lists of independent assertions can grow and reorder.
        if values.iter().all(Value::is_number) {
            return values == next;
        }
        return values
            .iter()
            .all(|old| next.iter().any(|new| covers(old, new, key)));
    }
    if let Some(values) = before.as_object() {
        return after.as_object().is_some_and(|next| {
            values
                .iter()
                .all(|(k, v)| next.get(k).is_some_and(|n| covers(v, n, k)))
        });
    }
    false
}

/// Top-level assertion groups of `before` that `after` no longer covers, then
/// each item of `before` that no item of `after` keeps. An item with
/// assertions is kept by an item that covers every one of them, whatever its
/// words; an item without any, by an item with the same words. A
/// requirement id may be added to an item, never changed or removed.
pub(crate) fn scope_changes(before: &Value, after: &Value) -> Vec<String> {
    let b = comparison_form(before);
    let a = comparison_form(after);
    let mut changes = b
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| key.as_str() != "spec")
        .filter(|(key, old)| !covers(old, &a[key.as_str()], key))
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    let now = values(&a["spec"]);
    for old in values(&b["spec"]) {
        if !kept(old, now) {
            changes.push(format!(
                "spec item \"{}\"",
                reads::clip(old["item"].as_str().unwrap_or(""), 80)
            ));
        }
    }
    changes
}

/// Does an item of `now` keep `old` (both in comparison form)?
fn kept(old: &Value, now: &[Value]) -> bool {
    let groups = groups_map(old);
    now.iter().any(|new| {
        let compatible =
            old["requirementId"].is_null() || new["requirementId"] == old["requirementId"];
        compatible
            && if groups.is_empty() {
                item_key(new).1 == item_key(old).1
            } else {
                groups
                    .iter()
                    .all(|(key, value)| new.get(key).is_some_and(|n| covers(value, n, key)))
            }
    })
}

/// For each item of `before`, whether `after` keeps it, by the rule
/// `scope_changes` applies.
pub(crate) fn kept_items(before: &Value, after: &Value) -> Vec<bool> {
    let (b, a) = (comparison_form(before), comparison_form(after));
    values(&b["spec"])
        .iter()
        .map(|old| kept(old, values(&a["spec"])))
        .collect()
}

/// A requirement feature's assertions as a check takes them: expanded to
/// the canonical groups an item carries. Empty when they do not read.
pub(crate) fn fragment_groups(fragment: &Value) -> Value {
    let groups = canonical_numbers(fragment)
        .as_object()
        .cloned()
        .unwrap_or_default();
    Value::Object(expand(groups, "fragment").unwrap_or_default())
}

/// Does the expectation state anything about this part beyond the generic
/// mesh checks every part gets? Items count through the assertions they add
/// to the top level, not by being listed.
pub(crate) fn explicit(expect: &Value) -> bool {
    expect.as_object().is_some_and(|map| {
        map.iter().any(|(key, value)| {
            !matches!(key.as_str(), "watertight" | "minRoundness" | "tol" | "spec")
                && !value.is_null()
                && !value.as_array().is_some_and(Vec::is_empty)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn more_assertions_and_tighter_tolerances_keep_the_scope() {
        let prior = json!({"bbox": {"min": [0, 0, 0], "max": [10, 10, 10], "tol": 0.1}});
        assert!(scope_changes(
            &prior,
            &json!({"bbox": {"min": [0, 0, 0], "max": [10, 10, 10], "tol": 0.01}, "shells": 1})
        )
        .is_empty());
        assert!(scope_changes(
            &prior,
            &json!({"bbox": {"min": [0, 0, 0], "max": [10, 10, 10], "tol": 0.1}, "solid": [[5, 5, 5]]})
        )
        .is_empty());
    }

    #[test]
    fn removals_changes_and_looser_tolerances_change_the_scope() {
        let prior = json!({"bbox": {"min": [0, 0, 0], "max": [10, 10, 10], "tol": 0.01}});
        assert_eq!(scope_changes(&prior, &json!({})), vec!["bbox"]);
        assert_eq!(
            scope_changes(
                &prior,
                &json!({"bbox": {"min": [0, 0, 0], "max": [10, 10, 10]}})
            ),
            vec!["bbox"]
        );
        assert_eq!(
            scope_changes(
                &prior,
                &json!({"bbox": {"min": [0, 0, 0], "max": [20, 10, 10], "tol": 0.01}})
            ),
            vec!["bbox"]
        );
        assert_eq!(
            scope_changes(&json!({}), &json!({"watertight": false})),
            vec!["watertight"]
        );
        assert_eq!(
            scope_changes(&json!({}), &json!({"minRoundness": 0.9})),
            vec!["minRoundness"]
        );
        assert!(scope_changes(&json!({}), &json!({"minRoundness": 0.99})).is_empty());
    }

    #[test]
    fn coordinates_are_ordered_but_lists_of_assertions_are_not() {
        assert!(scope_changes(
            &json!({"solid": [[1, 2, 3], [4, 5, 6]]}),
            &json!({"solid": [[4, 5, 6], [1, 2, 3], [0, 0, 0]]})
        )
        .is_empty());
        assert_eq!(
            scope_changes(
                &json!({"solid": [[1, 2, 3]]}),
                &json!({"solid": [[3, 2, 1]]})
            ),
            vec!["solid"]
        );
        let section = |holes: Value| json!({"sections": [{"axis": "z", "at": 2, "holes": holes}]});
        assert!(scope_changes(
            &section(json!([{"center": [5, 5], "d": 3.2}])),
            &section(
                json!([{"center": [35, 25], "d": 3.2}, {"center": [5, 5], "d": 3.2, "tol": 0.05}])
            )
        )
        .is_empty());
        assert_eq!(
            scope_changes(
                &section(json!([{"center": [5, 5], "d": 3.2}])),
                &section(json!([{"center": [5, 5], "d": 3.3}]))
            ),
            vec!["sections"]
        );
    }

    #[test]
    fn integers_and_integral_floats_are_one_value() {
        let whole = json!({"bbox": {"min": [0, 0, 0], "max": [40, 30, 4]}, "sections": [{"axis": "z", "at": 2, "holeCount": 4}]});
        let float = json!({"bbox": {"min": [0.0, 0.0, 0.0], "max": [40.0, 30.0, 4.0]}, "sections": [{"axis": "z", "at": 2.0, "holeCount": 4}]});
        assert!(scope_changes(&whole, &float).is_empty());
        assert!(scope_changes(&float, &whole).is_empty());
        assert_eq!(spec_hash(&whole), spec_hash(&float));
        assert_eq!(normalize(&float).unwrap().expect, whole);
    }

    #[test]
    fn written_out_defaults_and_key_order_do_not_change_the_hash() {
        let short =
            json!({"volume": {"value": 400}, "bbox": {"min": [0, 0, 0], "max": [20, 10, 2]}});
        let long = json!({"bbox": {"max": [20, 10, 2], "min": [0, 0, 0], "tol": 0.1}, "volume": {"tolPct": 1.5, "value": 400}, "watertight": true, "minRoundness": 0.97});
        assert_eq!(spec_hash(&short), spec_hash(&long));
        assert_ne!(
            spec_hash(&short),
            spec_hash(&json!({"volume": {"value": 401}}))
        );
    }

    #[test]
    fn short_form_expands_to_sections_probes_and_shells() {
        let normalized = normalize(&json!({
            "size": [40, 30, 4],
            "bodies": 1,
            "holes": [
                {"at": [5, 5, 2], "d": 3.2},
                {"at": [35.0, 25, 2], "d": 3.2},
                {"at": [20, 0, 2], "d": 4, "axis": "y"},
            ],
        }))
        .unwrap();
        assert!(normalized.changed);
        assert!(normalized.ignored.is_empty());
        assert_eq!(
            normalized.expect,
            json!({
                "size": [40, 30, 4],
                "shells": 1,
                "empty": [[5, 5, 2], [35, 25, 2], [20, 0, 2]],
                "sections": [
                    {"axis": "z", "at": 2, "holes": [
                        {"center": [5, 5], "d": 3.2},
                        {"center": [35, 25], "d": 3.2},
                    ]},
                    {"axis": "y", "at": 0, "holes": [{"center": [20, 2], "d": 4}]},
                ],
            })
        );
        assert_eq!(
            serde_json::to_string(&normalized.expect)
                .unwrap()
                .find("\"size\""),
            Some(1)
        );
    }

    #[test]
    fn short_form_and_its_long_equivalent_are_the_same_scope() {
        let short = normalize(&json!({
            "size": [40, 30, 4],
            "bodies": 1,
            "holes": [{"at": [5, 5, 2], "d": 3.2}],
            "tol": 0.05,
        }))
        .unwrap()
        .expect;
        let long = json!({
            "size": [40.0, 30.0, 4.0],
            "tol": 0.05,
            "shells": 1,
            "empty": [[5, 5, 2]],
            "sections": [{"axis": "z", "at": 2, "holes": [{"center": [5, 5], "d": 3.2}]}],
        });
        assert_eq!(spec_hash(&short), spec_hash(&long));
        assert!(scope_changes(&short, &long).is_empty());
        assert!(scope_changes(&long, &short).is_empty());
        let again = normalize(&short).unwrap();
        assert_eq!(again.expect, short);
        assert!(!again.changed);
    }

    #[test]
    fn holes_join_an_existing_section_on_the_same_plane_and_do_not_repeat_probes() {
        let normalized = normalize(&json!({
            "sections": [{"axis": "z", "at": 2, "holeCount": 2}],
            "empty": [[5, 5, 2]],
            "holes": [{"at": [5, 5, 2.0], "d": 3}, {"at": [9, 5, 2], "d": 3}],
        }))
        .unwrap();
        assert_eq!(
            normalized.expect,
            json!({
                "empty": [[5, 5, 2], [9, 5, 2]],
                "sections": [{"axis": "z", "at": 2, "holeCount": 2, "holes": [
                    {"center": [5, 5], "d": 3},
                    {"center": [9, 5], "d": 3},
                ]}],
            })
        );
    }

    #[test]
    fn the_default_tolerance_applies_where_an_assertion_has_none() {
        let loose = json!({"size": [40, 30, 4], "tol": 0.5});
        assert_eq!(
            scope_changes(&json!({"size": [40, 30, 4]}), &loose),
            vec!["size"]
        );
        assert!(scope_changes(&loose, &json!({"size": [40, 30, 4]})).is_empty());
        assert!(scope_changes(&loose, &json!({"size": [40, 30, 4], "tol": 0.2})).is_empty());
        assert_eq!(
            scope_changes(&json!({"size": [40, 30, 4]}), &json!({"size": [41, 30, 4]})),
            vec!["size"]
        );
        let own = json!({"bbox": {"min": [0, 0, 0], "max": [1, 1, 1], "tol": 0.1}, "tol": 0.5});
        let normalized = normalize(&own).unwrap();
        assert_eq!(normalized.ignored.len(), 1);
        assert!(normalized.expect.get("tol").is_none());
        assert_eq!(
            spec_hash(&normalized.expect),
            spec_hash(&json!({"bbox": {"min": [0, 0, 0], "max": [1, 1, 1]}}))
        );
    }

    #[test]
    fn contradictory_or_malformed_short_forms_are_rejected_with_a_path() {
        let error = normalize(&json!({"bodies": 2, "shells": 1})).err().unwrap();
        assert_eq!(error.code, "VALIDATION");
        assert_eq!(error.issues()[0].path, "expect.bodies");
        assert!(normalize(&json!({"bodies": 1, "shells": 1.0})).is_ok());
        let error = normalize(&json!({"size": [40, 0, 4]})).err().unwrap();
        assert_eq!(error.issues()[0].path, "expect.size");
        let error = normalize(&json!({"holes": [{"at": [1, 2], "d": 3}]}))
            .err()
            .unwrap();
        assert_eq!(error.issues()[0].path, "expect.holes[0].at");
        let error = normalize(&json!({"holes": [{"at": [1, 2, 3], "d": 0}]}))
            .err()
            .unwrap();
        assert_eq!(error.issues()[0].path, "expect.holes[0].d");
    }

    #[test]
    fn empty_lists_and_generic_flags_are_not_an_explicit_scope() {
        assert!(!explicit(&json!({})));
        assert!(!explicit(
            &json!({"watertight": true, "minRoundness": 0.97, "tol": 0.2})
        ));
        assert!(!explicit(&json!({"solid": [], "sections": []})));
        assert!(explicit(&json!({"size": [1, 2, 3]})));
        assert!(explicit(&json!({"shells": 1})));
        assert!(explicit(&json!({"preserve": {"changeRegions": []}})));
        assert!(normalize(&json!({"solid": [], "empty": []}))
            .unwrap()
            .expect
            .as_object()
            .unwrap()
            .is_empty());
    }

    fn pulley() -> Value {
        json!({
            "bodies": 1,
            "spec": [
                {"item": "outer diameter 60 mm", "sections": [{"axis": "z", "at": 2, "outer": {"d": 60}}, {"axis": "z", "at": 14, "outer": {"d": 60}}]},
                {"item": "overall width 16 mm (z 0…16)", "bbox": {"min": [-30, -30, 0], "max": [30, 30, 16]}},
                {"item": "Ø8 mm bore through the full width", "holes": [{"at": [0, 0, 2], "d": 8}, {"at": [0, 0, 14], "d": 8}]},
                {"item": "V-groove centered at z = 8, 8 mm wide at Ø60 (z 4…12)", "solid": [[29.5, 0, 3.5], [29.5, 0, 12.5]], "empty": [[29.5, 0, 8]]},
                {"item": "sharp groove bottom at Ø50 (5 mm deep)", "sections": [{"axis": "z", "at": 8, "outer": {"d": 50}}]},
                {"item": "both flanks straight", "sections": [{"axis": "z", "at": 6, "outer": {"d": 55}}, {"axis": "z", "at": 10, "outer": {"d": 55}}]}
            ]
        })
    }

    fn with(spec: Value) -> Value {
        normalize(&spec).unwrap().expect
    }

    #[test]
    fn spec_items_flatten_into_the_canonical_form_and_repeat_nothing() {
        let normalized = normalize(&pulley()).unwrap();
        let canonical = &normalized.expect;
        assert_eq!(canonical["shells"], 1);
        assert_eq!(
            canonical["empty"],
            json!([[0, 0, 2], [0, 0, 14], [29.5, 0, 8]])
        );
        let sections = canonical["sections"].as_array().unwrap();
        assert_eq!(sections.len(), 5, "{sections:?}");
        // The bore and the outer diameter share the z=2 plane.
        assert_eq!(
            sections[0],
            json!({"axis": "z", "at": 2, "outer": {"d": 60}, "holes": [{"center": [0, 0], "d": 8}]})
        );
        // Items keep their own assertions, in canonical form.
        assert_eq!(
            canonical["spec"][2],
            json!({"item": "Ø8 mm bore through the full width", "empty": [[0, 0, 2], [0, 0, 14]], "sections": [
                {"axis": "z", "at": 2, "holes": [{"center": [0, 0], "d": 8}]},
                {"axis": "z", "at": 14, "holes": [{"center": [0, 0], "d": 8}]}]})
        );
        assert!(explicit(canonical));
        let again = normalize(canonical).unwrap();
        assert_eq!(&again.expect, canonical);
        assert!(!again.changed);
        // The request form keeps each assertion once and reads back as the same scope.
        let request = request_form(canonical);
        assert_eq!(request.as_object().unwrap().len(), 2, "{request}");
        assert_eq!(request["shells"], 1);
        assert_eq!(request["spec"], canonical["spec"]);
        assert_eq!(&normalize(&request).unwrap().expect, canonical);
        assert!(scope_changes(canonical, &normalize(&request).unwrap().expect).is_empty());
    }

    #[test]
    fn dropping_an_item_or_the_words_of_one_without_assertions_changes_the_scope() {
        let before = with(pulley());
        let mut fewer = pulley();
        fewer["spec"].as_array_mut().unwrap().remove(4);
        assert_eq!(
            scope_changes(&before, &with(fewer)),
            vec![
                "sections".to_owned(),
                "spec item \"sharp groove bottom at Ø50 (5 mm deep)\"".to_owned()
            ]
        );
        // Rewording an item that keeps its assertions keeps the scope; so do
        // case and spacing, and adding items or assertions.
        let mut reworded = pulley();
        reworded["spec"][4]["item"] = json!("groove bottom diameter 50");
        assert!(scope_changes(&before, &with(reworded)).is_empty());
        let mut spaced = pulley();
        spaced["spec"][4]["item"] = json!("Sharp  groove bottom at Ø50 (5 mm DEEP)");
        assert!(scope_changes(&before, &with(spaced)).is_empty());
        let mut more = pulley();
        more["spec"]
            .as_array_mut()
            .unwrap()
            .push(json!({"item": "one body", "bodies": 1}));
        assert!(scope_changes(&before, &with(more)).is_empty());
        // An item without assertions is kept only by its words.
        let bare = with(json!({"size": [1, 2, 3], "spec": [{"item": "chamfer 1 mm"}]}));
        assert!(scope_changes(
            &bare,
            &with(json!({"size": [1, 2, 3], "spec": [{"item": "Chamfer 1  mm"}]}))
        )
        .is_empty());
        assert_eq!(
            scope_changes(
                &bare,
                &with(json!({"size": [1, 2, 3], "spec": [{"item": "edge break"}]}))
            ),
            vec!["spec item \"chamfer 1 mm\""]
        );
        // A requirement id may be added to an item, never changed or removed.
        let plain = with(json!({"spec": [{"item": "fits 20 mm", "size": [20, 10, 2]}]}));
        let named = with(
            json!({"spec": [{"item": "fits 20 mm", "requirementId": "r1", "size": [20, 10, 2]}]}),
        );
        assert!(scope_changes(&plain, &named).is_empty());
        assert_eq!(
            scope_changes(&named, &plain),
            vec!["spec item \"fits 20 mm\""]
        );
        let other = with(
            json!({"spec": [{"item": "fits 20 mm", "requirementId": "r2", "size": [20, 10, 2]}]}),
        );
        assert_eq!(
            scope_changes(&named, &other),
            vec!["spec item \"fits 20 mm\""]
        );
    }

    #[test]
    fn moving_an_assertion_into_an_item_keeps_the_scope() {
        let plain = with(json!({"size": [60, 60, 16]}));
        let itemised = with(json!({"spec": [{"item": "60 x 60 x 16", "size": [60, 60, 16]}]}));
        assert!(scope_changes(&plain, &itemised).is_empty());
        // An itemised check followed by one without items drops the items.
        assert_eq!(
            scope_changes(&itemised, &plain),
            vec!["spec item \"60 x 60 x 16\""]
        );
    }

    fn groove(fragment: Option<Value>) -> Vec<Derived> {
        vec![Derived {
            requirement_id: "r1".into(),
            title: "V-groove".into(),
            features: vec![
                Feature {
                    label: "Groove bottom Ø50".into(),
                    fragment,
                },
                Feature {
                    label: "Flank angle 34°".into(),
                    fragment: None,
                },
            ],
        }]
    }

    #[test]
    fn requirement_features_join_and_replace_matching_items() {
        let derived = groove(Some(
            json!({"sections": [{"axis": "z", "at": 8, "outer": {"d": 50}}]}),
        ));
        let input = json!({"spec": [
            {"item": "groove bottom ø50", "requirementId": "r1"},
            {"item": "bore", "holes": [{"at": [0, 0, 2], "d": 8}]}
        ]});
        let normalized = normalize_with(&input, &derived).unwrap();
        let items = normalized.expect["spec"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        // The requirement's words and assertions stand for its item.
        assert_eq!(
            items[0],
            json!({"item": "Groove bottom Ø50", "requirementId": "r1", "sections": [{"axis": "z", "at": 8, "outer": {"d": 50}}]})
        );
        assert_eq!(
            items[2],
            json!({"item": "Flank angle 34°", "requirementId": "r1"})
        );
        assert_eq!(
            normalized.added,
            vec![
                "added to \"Groove bottom Ø50\" from requirement \"V-groove\"",
                "added from requirement \"V-groove\": Flank angle 34°"
            ]
        );
        assert!(normalized.replaced.is_empty());
        let again = normalize_with(&normalized.expect, &derived).unwrap();
        assert_eq!(again.expect, normalized.expect);
        assert!(again.added.is_empty() && again.replaced.is_empty());
        // A requirement whose value changed replaces the committed one, in
        // the item and at the top level; the scope guard sees the change.
        let changed = groove(Some(
            json!({"sections": [{"axis": "z", "at": 8, "outer": {"d": 52}}]}),
        ));
        let replaced = normalize_with(&normalized.expect, &changed).unwrap();
        assert_eq!(
            replaced.replaced,
            vec!["\"Groove bottom Ø50\" from requirement \"V-groove\""]
        );
        assert_eq!(replaced.expect["sections"][0]["outer"]["d"], 52);
        assert_eq!(
            scope_changes(&normalized.expect, &replaced.expect),
            vec!["sections", "spec item \"Groove bottom Ø50\""]
        );
        // Without its assertions (several parts), a feature keeps those sent for it.
        let sent = json!({"spec": [{"item": "Groove bottom Ø50", "requirementId": "r1", "sections": [{"axis": "z", "at": 8, "outer": {"d": 50}}]}]});
        let kept = normalize_with(&sent, &groove(None)).unwrap();
        assert_eq!(kept.expect["spec"][0], sent["spec"][0]);
    }

    #[test]
    fn a_value_that_disagrees_is_an_error_with_the_item_path() {
        let error =
            normalize(&json!({"size": [1, 2, 3], "spec": [{"item": "a", "size": [1, 2, 4]}]}))
                .err()
                .unwrap();
        assert_eq!(error.issues()[0].path, "expect.spec[0].size");
        assert!(error.repair.as_deref().unwrap().contains("in one item"));
        let error = normalize(&json!({"spec": [
            {"item": "a", "sections": [{"axis": "z", "at": 2, "outer": {"d": 60}}]},
            {"item": "b", "sections": [{"axis": "z", "at": 2, "outer": {"d": 61}}]}]}))
        .err()
        .unwrap();
        assert_eq!(error.issues()[0].path, "expect.spec[1].sections");
        assert!(error.message.contains("outer at z=2"), "{}", error.message);
        // The same assertion in two items, or at the top level too, is one assertion.
        let shared = normalize(&json!({"solid": [[1, 1, 1]], "spec": [
            {"item": "a", "solid": [[1, 1, 1]]}, {"item": "b", "solid": [[1, 1, 1]], "bodies": 1}]}))
        .unwrap();
        assert_eq!(shared.expect["solid"], json!([[1, 1, 1]]));
    }

    fn envelope(id: &str, title: &str, size: [f64; 3]) -> Derived {
        Derived {
            requirement_id: id.into(),
            title: title.into(),
            features: vec![Feature {
                label: "Envelope".into(),
                fragment: Some(json!({ "size": size })),
            }],
        }
    }

    #[test]
    fn a_disagreement_names_both_places() {
        let a = envelope("r1", "Envelope A", [20.0, 10.0, 2.0]);
        let b = envelope("r2", "Envelope B", [20.0, 10.0, 3.0]);
        // Two requirements: a person reconciles them, whatever the check sends.
        for input in [
            Value::Null,
            json!({"spec": [{"item": "plate", "solid": [[1, 1, 1]]}]}),
        ] {
            let error = normalize_with(&input, &[a.clone(), b.clone()])
                .err()
                .unwrap();
            assert_eq!(
                error.issues()[0].message,
                "requirements \"Envelope A\" and \"Envelope B\" state different size for this part"
            );
            assert_eq!(
                error.issues()[0].path,
                "requirement \"Envelope B\" features[0].expect.size"
            );
            assert!(error
                .repair
                .as_deref()
                .unwrap()
                .starts_with("A person must reconcile the requirements"));
            assert!(rederive(&input, &[a.clone(), b.clone()]).is_err());
        }
        // A listed item against a requirement: the item's path and the
        // requirement, whichever comes first.
        let error = normalize_with(
            &json!({"spec": [{"item": "plate 20 x 10 x 3", "size": [20, 10, 3]}]}),
            std::slice::from_ref(&a),
        )
        .err()
        .unwrap();
        assert_eq!(error.issues()[0].path, "expect.spec[0].size");
        assert_eq!(
            error.issues()[0].message,
            "disagrees with the size requirement \"Envelope A\" states for \"Envelope\""
        );
        assert!(error
            .repair
            .as_deref()
            .unwrap()
            .starts_with("The requirement's value is the one checked"));
        let error = normalize_with(&json!({"size": [20, 10, 3]}), std::slice::from_ref(&a))
            .err()
            .unwrap();
        assert_eq!(error.issues()[0].path, "expect.size");
        // Two listed items: the other one by its index and words.
        let error = normalize(&json!({"spec": [
            {"item": "a", "sections": [{"axis": "z", "at": 2, "outer": {"d": 60}}]},
            {"item": "b", "sections": [{"axis": "z", "at": 2, "outer": {"d": 61}}]}]}))
        .err()
        .unwrap();
        assert_eq!(
            error.issues()[0].message,
            "disagrees with the outer at z=2 of expect.spec[0] (\"a\")"
        );
    }

    #[test]
    fn a_restated_scope_gives_way_to_the_requirements() {
        let committed = with(json!({"bodies": 1, "spec": [
            {"item": "plate 20 x 10 x 3", "size": [20, 10, 3]},
            {"item": "centre is solid", "solid": [[10, 5, 1]], "bbox": {"min": [0, 0, 0], "max": [20, 10, 3]}}]}));
        let thin = envelope("r1", "Thin", [20.0, 10.0, 2.0]);
        // Sent as it is, the check refuses it; restated, the requirement's
        // value stands and the plate item, left with nothing, goes.
        assert!(normalize_with(&request_form(&committed), std::slice::from_ref(&thin)).is_err());
        let restated = rederive(&request_form(&committed), std::slice::from_ref(&thin)).unwrap();
        let items = restated.expect["spec"].as_array().unwrap();
        assert_eq!(
            items
                .iter()
                .map(|item| item["item"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["centre is solid", "Envelope"]
        );
        assert_eq!(restated.expect["size"], json!([20, 10, 2]));
        assert_eq!(
            restated.replaced,
            vec!["size of \"plate 20 x 10 x 3\" (requirement \"Thin\" states it)"]
        );
        assert_eq!(restated.superseded, vec![json!({"size": [20, 10, 3]})]);
        // Restating is stable, and what a check sends from it is the same scope.
        let again = rederive(&request_form(&restated.expect), std::slice::from_ref(&thin)).unwrap();
        assert_eq!(again.expect, restated.expect);
        assert!(again.replaced.is_empty());
        let sent =
            normalize_with(&request_form(&restated.expect), std::slice::from_ref(&thin)).unwrap();
        assert!(scope_changes(&restated.expect, &sent.expect).is_empty());
        // A section value gives way on its own plane only.
        let groove = with(json!({"spec": [{"item": "groove", "sections": [
            {"axis": "z", "at": 8, "outer": {"d": 50}, "holes": [{"center": [0, 0], "d": 8}]}]}]}));
        let restated = rederive(&request_form(&groove), &groove_at(52.0)).unwrap();
        assert_eq!(
            restated.expect["spec"][0],
            json!({"item": "groove", "sections": [{"axis": "z", "at": 8, "holes": [{"center": [0, 0], "d": 8}]}]})
        );
        assert_eq!(
            restated.replaced,
            vec!["outer at z=8 of \"groove\" (requirement \"V-groove\" states it)"]
        );
    }

    fn groove_at(d: f64) -> Vec<Derived> {
        groove(Some(
            json!({"sections": [{"axis": "z", "at": 8, "outer": {"d": d}}]}),
        ))
    }

    #[test]
    fn a_top_level_assertion_that_goes_with_a_replaced_item_is_named() {
        let corners = vec![Derived {
            requirement_id: "r1".into(),
            title: "Envelope".into(),
            features: vec![Feature {
                label: "Plate envelope".into(),
                fragment: Some(json!({"bbox": {"min": [0, 0, 0], "max": [20, 10, 2]}})),
            }],
        }];
        let normalized = normalize_with(
            &json!({"size": [20, 10, 2], "spec": [
                {"item": "Plate envelope", "requirementId": "r1", "size": [20, 10, 2]}]}),
            &corners,
        )
        .unwrap();
        assert!(normalized.expect.get("size").is_none());
        assert_eq!(
            normalized.replaced,
            vec!["\"Plate envelope\" from requirement \"Envelope\""]
        );
        assert_eq!(
            normalized.ignored,
            vec!["expect.size: went with an item whose assertions a linked requirement now states; send it in an item of its own to keep it"]
        );
        // Kept in an item of its own, it stays.
        let kept = normalize_with(
            &json!({"spec": [{"item": "20 x 10 x 2", "size": [20, 10, 2]},
                {"item": "Plate envelope", "requirementId": "r1", "size": [20, 10, 2]}]}),
            &corners,
        )
        .unwrap();
        assert_eq!(kept.expect["size"], json!([20, 10, 2]));
        assert!(kept.ignored.is_empty());
    }

    #[test]
    fn duplicate_items_and_foreign_keys_are_rejected() {
        let error =
            normalize(&json!({"spec": [{"item": "a", "size": [1, 1, 1]}, {"item": " A "}]}))
                .err()
                .unwrap();
        assert_eq!(error.issues()[0].path, "expect.spec[1].item");
        assert_eq!(error.issues()[0].message, "repeats expect.spec[0].item");
        // The same words for two requirements are two items.
        assert!(normalize(&json!({"spec": [
            {"item": "a", "requirementId": "r1"}, {"item": "a", "requirementId": "r2"}]}))
        .is_ok());
        let error = normalize(&json!({"spec": [{"item": "a", "tol": 0.2}]}))
            .err()
            .unwrap();
        assert_eq!(error.issues()[0].path, "expect.spec[0].tol");
        let error = normalize(&json!({"spec": [{"size": [1, 1, 1]}]}))
            .err()
            .unwrap();
        assert_eq!(error.issues()[0].path, "expect.spec[0].item");
        let error = normalize(&json!({"spec": [{"item": "x".repeat(201)}]}))
            .err()
            .unwrap();
        assert_eq!(error.issues()[0].message, "longer than 200 characters");
        let error = normalize(&json!({"spec": [{"item": "a", "holes": [{"at": [1, 2], "d": 3}]}]}))
            .err()
            .unwrap();
        assert_eq!(error.issues()[0].path, "expect.spec[0].holes[0].at");
        let error = normalize(&json!({"spec": {"item": "a"}})).err().unwrap();
        assert_eq!(error.issues()[0].path, "expect.spec");
    }

    #[test]
    fn a_check_without_spec_normalizes_exactly_as_before() {
        for input in [
            json!({}),
            json!({"size": [40, 30, 4], "bodies": 1, "holes": [{"at": [5, 5, 2], "d": 3.2}], "tol": 0.05}),
            json!({"sections": [{"axis": "z", "at": 2, "holeCount": 2}], "empty": [[5, 5, 2]]}),
            json!({"bbox": {"min": [0, 0, 0], "max": [1, 1, 1], "tol": 0.1}, "tol": 0.5}),
        ] {
            let normalized = normalize(&input).unwrap();
            assert!(normalized.expect.get("spec").is_none());
            assert!(normalized.added.is_empty() && normalized.replaced.is_empty());
            assert_eq!(request_form(&normalized.expect), normalized.expect);
        }
        assert_eq!(normalize(&Value::Null).unwrap().expect, json!({}));
    }

    #[test]
    fn spec_is_not_an_explicit_scope_by_itself() {
        let bare = with(json!({"spec": [{"item": "groove bottom Ø50"}]}));
        assert_eq!(bare, json!({"spec": [{"item": "groove bottom Ø50"}]}));
        assert!(!explicit(&bare));
        assert!(explicit(&with(
            json!({"spec": [{"item": "one body", "bodies": 1}]})
        )));
    }

    #[test]
    fn the_item_count_is_limited() {
        let items = |count: usize| json!({"spec": (0..count).map(|index| json!({"item": format!("item {index}")})).collect::<Vec<_>>()});
        assert!(normalize(&items(MAX_SPEC_ITEMS)).is_ok());
        let error = normalize(&items(MAX_SPEC_ITEMS + 1)).err().unwrap();
        assert_eq!(error.issues()[0].path, "expect.spec");
        assert!(error.repair.as_deref().unwrap().contains("at most 128"));
    }

    #[test]
    fn the_longest_labels_normalize_to_the_same_form_again() {
        let label = "ø".repeat(ITEM_CHARS);
        let derived = vec![Derived {
            requirement_id: "r1".into(),
            title: "Long".into(),
            features: vec![Feature {
                label: label.clone(),
                fragment: Some(json!({"size": [1, 2, 3]})),
            }],
        }];
        let first = normalize_with(
            &json!({"spec": [{"item": "y".repeat(ITEM_CHARS)}]}),
            &derived,
        )
        .unwrap();
        let again = normalize_with(&first.expect, &derived).unwrap();
        assert_eq!(again.expect, first.expect);
        assert_eq!(
            normalize_with(&request_form(&first.expect), &derived)
                .unwrap()
                .expect,
            first.expect
        );
    }
}
