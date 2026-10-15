//! The expectation vocabulary of `cad.check`.
//!
//! A request may state expectations in a short form (`size`, `holes`,
//! `bodies`, one default `tol`). `normalize` turns that into the canonical
//! expectation before anything is measured, hashed or compared, so the short
//! form and its long equivalent are the same verification scope. Numbers are
//! canonical too: `2` and `2.0` are one value.
use super::*;

/// Default linear tolerance in millimetres and relative tolerance in percent.
pub(crate) const LINEAR_TOLERANCE: f64 = 0.1;
pub(crate) const PERCENT_TOLERANCE: f64 = 1.5;
pub(crate) const MIN_ROUNDNESS: f64 = 0.97;

const KEY_ORDER: [&str; 12] = [
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
];

pub(crate) struct Normalized {
    /// Canonical expectation: what is measured, stored as evidence and compared.
    pub expect: Value,
    /// Input that had no effect, in words.
    pub ignored: Vec<String>,
    /// True when the canonical form differs from what was sent.
    pub changed: bool,
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

/// Expand the short form into canonical assertions. Pure: the result depends
/// on the request alone, never on the measured part.
pub(crate) fn normalize(input: &Value) -> CoreResult<Normalized> {
    let mut expect = canonical_numbers(input)
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("expect", "expected an object", "Send expect as an object."))?;
    let mut ignored = Vec::new();
    if let Some(bodies) = expect.shift_remove("bodies") {
        match expect.get("shells") {
            Some(shells) if *shells != bodies => {
                return Err(invalid(
                    "expect.bodies",
                    "disagrees with expect.shells",
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
                "expect.size",
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
            let path = format!("expect.holes[{index}]");
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
    let mut canonical = serde_json::Map::new();
    for key in KEY_ORDER {
        if let Some(value) = expect.shift_remove(key) {
            canonical.insert(key.to_owned(), value);
        }
    }
    canonical.extend(expect);
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
    })
}

/// The canonical expectation with every default written out and keys sorted:
/// omission is then equivalent to what the checker actually does.
fn comparison_form(expect: &Value) -> Value {
    let mut map = canonical_numbers(expect)
        .as_object()
        .cloned()
        .unwrap_or_default();
    let default_tol = map
        .shift_remove("tol")
        .and_then(|tol| tol.as_f64())
        .unwrap_or(LINEAR_TOLERANCE);
    let fill = |item: Option<&mut Value>, key: &str, default: f64| {
        if let Some(object) = item.and_then(Value::as_object_mut) {
            object
                .entry(key)
                .or_insert_with(|| params::number_value(default));
        }
    };
    map.entry("watertight").or_insert(json!(true));
    map.entry("minRoundness").or_insert(json!(MIN_ROUNDNESS));
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
    sorted(&Value::Object(map))
}

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

/// Top-level assertion groups of `before` that `after` no longer covers.
pub(crate) fn scope_changes(before: &Value, after: &Value) -> Vec<String> {
    let b = comparison_form(before);
    let a = comparison_form(after);
    b.as_object()
        .into_iter()
        .flatten()
        .filter(|(key, old)| !covers(old, &a[key.as_str()], key))
        .map(|(key, _)| key.clone())
        .collect()
}

/// Does the expectation state anything about this part beyond the generic
/// mesh checks every part gets?
pub(crate) fn explicit(expect: &Value) -> bool {
    expect.as_object().is_some_and(|map| {
        map.iter().any(|(key, value)| {
            !matches!(key.as_str(), "watertight" | "minRoundness" | "tol")
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
}
