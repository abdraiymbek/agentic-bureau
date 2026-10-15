//! Wiring: pins and connections between components, consistency checks over
//! them, and a diagram derived from the record. The checks say what they
//! cover; a diagram is a picture of the record, not a validation of it.
use super::*;
use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;
use units::Reading;

const COVERAGE: &str = "Checks: voltage range, ground return, shared signal pins, changed components, pin knowledge. Not a schematic ERC; does not prove electrical safety.";

fn issue(path: impl Into<String>, message: impl Into<String>) -> Value {
    json!({"path": path.into(), "message": message.into()})
}

/// The wiring artifact and the revision an operation works on: the one the
/// caller names, else the newest draft made since the approved revision, else
/// the approved revision, else the newest.
fn wiring_revision(handle: &ProjectHandle, input: &Value) -> CoreResult<(Value, Value)> {
    let id = required_str(input, "artifactId")?;
    let artifact = require_artifact(handle, id)?;
    if artifact["type"] != "wiring" {
        return Err(ContractError::validation("Not a wiring artifact")
            .with_repair("Pass the id of a wiring artifact. Create one with artifact_create_draft and type \"wiring\".")
            .with_details(json!({"issues": [issue("artifactId", format!("is a {} artifact", artifact["type"].as_str().unwrap_or("different")))]})));
    }
    let named = input["revisionId"]
        .as_str()
        .or(input["baseRevisionId"].as_str());
    let revision = if let Some(named) = named {
        require_revision(handle, named)?
    } else {
        let baseline = artifact["selectedRevisionId"]
            .as_str()
            .map(|selected| require_revision(handle, selected))
            .transpose()?;
        let after = baseline
            .as_ref()
            .and_then(|revision| revision["seq"].as_i64())
            .unwrap_or(0);
        let draft = handle
            .db
            .query_row(
                "SELECT * FROM revision WHERE artifact_id=?1 AND review_state IN ('draft','proposed') AND seq>?2 ORDER BY seq DESC LIMIT 1",
                params![id, after],
                revision_from_row,
            )
            .optional()
            .map_err(internal)?;
        match draft.or(baseline) {
            Some(revision) => revision,
            None => handle
                .db
                .query_row(
                    "SELECT * FROM revision WHERE artifact_id=?1 ORDER BY seq DESC LIMIT 1",
                    [id],
                    revision_from_row,
                )
                .optional()
                .map_err(internal)?
                .ok_or_else(|| ContractError::validation("No wiring revision"))?,
        }
    };
    if revision["artifactId"] != id {
        return Err(
            ContractError::validation("Revision does not belong to wiring artifact")
                .with_repair("Leave the revision out to use the newest draft, or pass a revision id of this wiring artifact.")
                .with_details(json!({"issues": [issue(if input["revisionId"].is_string() { "revisionId" } else { "baseRevisionId" }, "must be a revision of artifactId")]})),
        );
    }
    Ok((artifact, revision))
}

/// The revision of a component a connection is drawn for when the caller
/// names none: the approved one, else the newest that was not rejected.
fn default_component_revision(handle: &ProjectHandle, id: &str, path: &str) -> CoreResult<String> {
    let selected = handle
        .db
        .query_row(
            "SELECT selected_revision_id FROM artifact WHERE id=?1",
            [id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(internal)?
        .ok_or_else(|| {
            ContractError::new("NOT_FOUND", format!("Component not found: {id}"))
                .with_repair("Record the component first (component_add_candidate) and use the artifact id it returns.")
                .with_details(json!({"issues": [issue(format!("{path}.componentArtifactId"), "no artifact has this id")]}))
        })?;
    if let Some(selected) = selected {
        return Ok(selected);
    }
    handle
        .db
        .query_row(
            "SELECT id FROM revision WHERE artifact_id=?1 AND review_state NOT IN ('rejected','superseded') ORDER BY seq DESC LIMIT 1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(internal)?
        .ok_or_else(|| {
            ContractError::validation(format!("Component has no revision: {id}"))
                .with_details(json!({"issues": [issue(format!("{path}.componentArtifactId"), "component has no usable revision")]}))
        })
}

/// Fill in what a caller may leave out of a wiring payload: connection ids
/// and the component revision at each end. Ids a caller supplies are kept.
pub(super) fn complete_payload(
    handle: &ProjectHandle,
    type_name: &str,
    body: &mut Value,
) -> CoreResult<()> {
    if type_name != "wiring" {
        return Ok(());
    }
    let Some(connections) = body["connections"].as_array_mut() else {
        return Ok(());
    };
    let mut seen = HashSet::new();
    for (index, connection) in connections.iter_mut().enumerate() {
        let path = format!("connections[{index}]");
        match connection["id"].as_str() {
            Some(id) if !seen.insert(id.to_owned()) => {
                return Err(ContractError::validation(format!(
                    "Connection id {id} is used twice"
                ))
                .with_repair("Leave id out of new connections; one is assigned to each.")
                .with_details(json!({"issues": [issue(format!("{path}.id"), "duplicate connection id")]})));
            }
            Some(_) => {}
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                seen.insert(id.clone());
                connection["id"] = json!(id);
            }
        }
        for end in ["from", "to"] {
            if connection[end]["componentRevisionId"].is_string() {
                continue;
            }
            let Some(component) = connection[end]["componentArtifactId"].as_str() else {
                continue;
            };
            let revision = default_component_revision(handle, component, &format!("{path}.{end}"))?;
            connection[end]["componentRevisionId"] = json!(revision);
        }
    }
    Ok(())
}

pub(super) fn set_pins(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let (_, revision) = wiring_revision(handle, input)?;
    let mut body = revision["payload"].clone();
    let mut pins = input["pins"].clone();
    // Voltage ranges an agent writes carry units like any other quantity.
    let notes = match origin {
        Origin::Agent { .. } => units::check_authored(&mut pins, "pins")?,
        _ => Vec::new(),
    };
    body["pins"] = pins;
    // The new draft descends from the revision that was read and keeps its
    // recorded inputs, so a component dependency is not lost between edits.
    let mut saved = update_draft(
        handle,
        &json!({"artifactId":input["artifactId"],"draftRevisionId":revision["id"],"payload":body,"inputs":revision["inputs"],"rationale":"set pins"}),
        origin,
    )?["revision"]
        .clone();
    if !notes.is_empty() {
        saved["notes"] = json!(notes);
    }
    Ok(saved)
}

const PINOUT_LABEL: &str = "pinout source";

pub(super) fn set_connections(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let (_, revision) = wiring_revision(handle, input)?;
    let mut body = revision["payload"].clone();
    body["connections"] = input["connections"].clone();
    complete_payload(handle, "wiring", &mut body)?;
    let ends = body["connections"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|connection| [&connection["from"], &connection["to"]])
        .collect::<Vec<_>>();
    let connected = |recorded: &Value| {
        ends.iter().any(|end| {
            recorded["artifactId"] == end["componentArtifactId"]
                && recorded["revisionId"] == end["componentRevisionId"]
        })
    };
    // Dependencies this operation recorded for connections that are gone are
    // dropped; everything a person or agent declared is kept.
    let mut inputs = revision["inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|recorded| recorded["label"] != PINOUT_LABEL || connected(recorded))
        .cloned()
        .collect::<Vec<_>>();
    for end in &ends {
        if !inputs.iter().any(|recorded| {
            recorded["artifactId"] == end["componentArtifactId"]
                && recorded["revisionId"] == end["componentRevisionId"]
        }) {
            inputs.push(json!({"artifactId":end["componentArtifactId"],"revisionId":end["componentRevisionId"],"relationship":"depends_on","label":PINOUT_LABEL}));
        }
    }
    update_draft(handle,&json!({"artifactId":input["artifactId"],"draftRevisionId":revision["id"],"payload":body,"inputs":inputs,"rationale":"set connections"}),origin).map(|result|result["revision"].clone())
}

/// Role of a pin: its declared type, or for an undeclared one what its name
/// says (`GND`, `+5V`, `VCC_IO`).
fn effective_pin_type(pin: Option<&Value>, name: &str) -> &'static str {
    static GROUND: OnceLock<Regex> = OnceLock::new();
    static POWER: OnceLock<Regex> = OnceLock::new();
    match pin.and_then(|p| p["type"].as_str()).unwrap_or("unknown") {
        "power" => "power",
        "ground" => "ground",
        "signal" => "signal",
        "data" => "data",
        "mechanical" => "mechanical",
        _ => {
            let ground = GROUND.get_or_init(|| {
                Regex::new(r"(?i)^(gnd\d*|gnd_\w+|ground|vss[ad]?|v-|0v|agnd|dgnd|pgnd|chassis)$")
                    .expect("ground pin names")
            });
            let power = POWER.get_or_init(|| {
                Regex::new(r"(?i)^(vcc|vdd|vcc_?\d.*|(vcc|vdd)_\w+|v\+|vin|vs|vbat|vbatt|vbus|vsys|vm|vmot|vmotor|pwr|power|\+?\d+(\.\d+)?v.*|5v|3v3?|12v|24v)$")
                    .expect("power pin names")
            });
            if ground.is_match(name) {
                "ground"
            } else if power.is_match(name) {
                "power"
            } else {
                "unknown"
            }
        }
    }
}

/// A voltage in volts, or `None` when it is unknown or not a voltage.
fn volts(quantity: &Value) -> Option<f64> {
    static VOLT: OnceLock<units::Unit> = OnceLock::new();
    let volt = VOLT.get_or_init(|| units::parse("V").expect("volt is in the unit table"));
    match units::read(quantity) {
        Reading::Known { value, unit } => units::convert(value, &unit, volt).ok(),
        Reading::Unknown { .. } => None,
    }
}

fn shown(quantity: &Value) -> String {
    format!(
        "{} {}",
        quantity["value"]
            .as_f64()
            .map(units::format_number)
            .unwrap_or_default(),
        quantity["unit"].as_str().unwrap_or("")
    )
}

struct ComponentState {
    selected: Option<String>,
    archived: bool,
}

fn component_state(handle: &ProjectHandle, id: &str) -> CoreResult<Option<ComponentState>> {
    handle
        .db
        .query_row(
            "SELECT selected_revision_id,archived FROM artifact WHERE id=?1",
            [id],
            |row| {
                Ok(ComponentState {
                    selected: row.get(0)?,
                    archived: row.get::<_, i64>(1)? != 0,
                })
            },
        )
        .optional()
        .map_err(internal)
}

/// Whether two revisions of a component record the same part. Selecting a
/// candidate makes a new revision that differs only in its status; that is
/// not a change to what the wiring was drawn for.
fn same_part(handle: &ProjectHandle, drawn: &str, approved: &str) -> CoreResult<bool> {
    let engineering = |id: &str| -> CoreResult<Option<String>> {
        Ok(get_revision(handle, id)?.map(|revision| {
            let mut payload = revision["payload"].clone();
            if let Some(fields) = payload.as_object_mut() {
                fields.remove("status");
                fields.remove("selectionReason");
            }
            models::content_hash(&payload, &[])
        }))
    };
    Ok(match (engineering(drawn)?, engineering(approved)?) {
        (Some(drawn), Some(approved)) => drawn == approved,
        _ => false,
    })
}

pub(super) fn validate(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let (_, revision) = wiring_revision(handle, input)?;
    let body = &revision["payload"];
    let pins = body["pins"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let connections = body["connections"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let find_pin = |component: &str, name: &str| {
        pins.iter()
            .find(|p| p["componentArtifactId"] == component && p["pin"] == name)
    };
    let mut findings = Vec::new();
    if connections.is_empty() {
        findings.push(
            json!({"severity":"info","code":"NO_CONNECTIONS","message":"No connections declared"}),
        );
    }
    // Everything below keeps declaration order, so two runs over the same
    // record give the same findings in the same order.
    let mut powered = Vec::<String>::new();
    let mut grounded = HashSet::<String>::new();
    let mut uses = Vec::<((String, String), Vec<(String, Option<f64>)>)>::new();
    let mut reported = HashSet::<(String, String)>::new();
    for connection in connections {
        let connection_id = connection["id"].as_str().unwrap_or("");
        let voltage = connection.get("voltage").filter(|v| !v.is_null());
        for name in ["from", "to"] {
            let end = &connection[name];
            let component_id = end["componentArtifactId"].as_str().unwrap_or("");
            let revision_id = end["componentRevisionId"].as_str().unwrap_or("");
            let pin_name = end["pin"].as_str().unwrap_or("");
            let first_report = reported.insert((component_id.to_owned(), revision_id.to_owned()));
            match component_state(handle, component_id)? {
                Some(ComponentState { archived: false, selected: Some(selected) }) => {
                    if selected != revision_id
                        && first_report
                        && !same_part(handle, revision_id, &selected)?
                    {
                        findings.push(json!({"severity":"warning","code":"CHANGED_COMPONENT","connectionId":connection_id,"message":format!("Component {component_id} changed since this wiring was drawn: the connections use revision {revision_id}, the approved revision is {selected}. Check its pins and set the connections again.")}));
                    }
                }
                Some(ComponentState { archived: false, selected: None }) => {
                    if first_report {
                        findings.push(json!({"severity":"info","code":"COMPONENT_UNAPPROVED","connectionId":connection_id,"message":format!("Component {component_id} has no approved revision yet; the wiring is drawn for its draft {revision_id}")}));
                    }
                }
                _ => findings.push(json!({"severity":"error","code":"CHANGED_COMPONENT","connectionId":connection_id,"message":format!("Component revision unavailable or changed: {component_id}@{revision_id} ({name} '{pin_name}')")})),
            }
            let pin = find_pin(component_id, pin_name);
            if pin.is_none() {
                findings.push(json!({"severity":"warning","code":"CONNECTION_UNKNOWN_PIN","connectionId":connection_id,"message":format!("Unknown pin '{pin_name}' on component {component_id} — not verified")}));
            }
            let key = (component_id.to_owned(), pin_name.to_owned());
            let entry = (connection_id.to_owned(), voltage.and_then(volts));
            match uses.iter_mut().find(|(known, _)| *known == key) {
                Some((_, entries)) => entries.push(entry),
                None => uses.push((key, vec![entry])),
            }
            match effective_pin_type(pin, pin_name) {
                "power" => {
                    if !powered.iter().any(|known| known == component_id) {
                        powered.push(component_id.to_owned());
                    }
                }
                "ground" => {
                    grounded.insert(component_id.to_owned());
                }
                _ => {}
            }
        }
        let Some(voltage) = voltage else {
            continue;
        };
        for name in ["from", "to"] {
            let end = &connection[name];
            let component_id = end["componentArtifactId"].as_str().unwrap_or("");
            let pin_name = end["pin"].as_str().unwrap_or("");
            let Some(range) = find_pin(component_id, pin_name)
                .map(|pin| &pin["voltageRange"])
                .filter(|range| !range.is_null())
            else {
                continue;
            };
            let (Some(value), Some(low), Some(high)) =
                (volts(voltage), volts(&range["min"]), volts(&range["max"]))
            else {
                findings.push(json!({"severity":"warning","code":"CONNECTION_UNKNOWN_PIN","connectionId":connection_id,"message":format!("Could not compare voltage range on pin '{pin_name}' ({component_id})")}));
                continue;
            };
            // 3300 mV is 3.3 V: a difference in the last binary digit is not
            // a violation.
            let slack = 1e-9 * low.abs().max(high.abs()).max(1.0);
            if value < low - slack || value > high + slack {
                findings.push(json!({"severity":"error","code":"VOLTAGE_INCOMPATIBLE","connectionId":connection_id,"message":format!("Connection voltage {} outside '{pin_name}' range {}–{} on component {component_id}",shown(voltage),units::format_number(range["min"]["value"].as_f64().unwrap_or(0.0)),shown(&range["max"]))}));
            }
        }
    }
    for ((component, pin), entries) in &uses {
        let mut distinct = Vec::<&str>::new();
        for (id, _) in entries {
            if !distinct.contains(&id.as_str()) {
                distinct.push(id);
            }
        }
        if distinct.len() < 2 {
            continue;
        }
        let mut levels = Vec::<f64>::new();
        for level in entries.iter().filter_map(|(_, level)| *level) {
            if !levels
                .iter()
                .any(|known| (known - level).abs() <= 1e-9 * known.abs().max(1.0))
            {
                levels.push(level);
            }
        }
        if levels.len() > 1 {
            let listed = levels
                .iter()
                .map(|level| format!("{} V", units::format_number(*level)))
                .collect::<Vec<_>>()
                .join(" and ");
            findings.push(json!({"severity":"error","code":"VOLTAGE_INCOMPATIBLE","connectionId":distinct[1],"message":format!("Pin '{pin}' on component {component} is connected at {listed}")}));
        }
        // A supply or ground pin feeds several loads by design; a shared
        // signal pin may be a bus or a mistake, which the record cannot tell.
        if matches!(
            effective_pin_type(find_pin(component, pin), pin),
            "power" | "ground"
        ) {
            continue;
        }
        findings.push(json!({"severity":"warning","code":"DUPLICATE_EXCLUSIVE","connectionId":distinct[1],"message":format!("Pin '{pin}' on component {component} is used by {} connections ({}) — confirm the shared pin is intended",distinct.len(),distinct.join(", "))}));
    }
    for component in &powered {
        if !grounded.contains(component) {
            findings.push(json!({"severity":"error","code":"MISSING_GROUND","message":format!("Component {component} has a power pin connected but no ground pin in any connection")}));
        }
    }
    Ok(json!({"findings":findings,"coverage":COVERAGE,"revisionId":revision["id"]}))
}

pub(super) fn render(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let (_, revision) = wiring_revision(handle, input)?;
    let body = &revision["payload"];
    let connections = body["connections"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut order = Vec::<&str>::new();
    let ends = connections
        .iter()
        .flat_map(|connection| [&connection["from"], &connection["to"]]);
    for id in ends
        .chain(body["pins"].as_array().into_iter().flatten())
        .filter_map(|entry| entry["componentArtifactId"].as_str())
    {
        if !order.contains(&id) {
            order.push(id);
        }
    }
    let title = |id: &str| -> String {
        require_artifact(handle, id)
            .ok()
            .and_then(|a| a["title"].as_str().map(str::to_owned))
            .unwrap_or_else(|| id.chars().take(8).collect())
    };
    let table=connections.iter().map(|c|{
        let from=&c["from"];let to=&c["to"];
        json!({"connection":c,"fromLabel":format!("{}.{}",title(from["componentArtifactId"].as_str().unwrap_or("")),from["pin"].as_str().unwrap_or("")),"toLabel":format!("{}.{}",title(to["componentArtifactId"].as_str().unwrap_or("")),to["pin"].as_str().unwrap_or(""))})
    }).collect::<Vec<_>>();
    let titles = order.iter().map(|id| title(id)).collect::<Vec<_>>();
    let wires = connections
        .iter()
        .filter_map(|connection| {
            let column = |end: &str| {
                let id = connection[end]["componentArtifactId"].as_str()?;
                order.iter().position(|known| *known == id)
            };
            let voltage = Some(&connection["voltage"])
                .filter(|voltage| voltage.is_object())
                .map(|voltage| format!(" {}", shown(voltage)))
                .unwrap_or_default();
            Some(diagram::Wire {
                from: column("from")?,
                to: column("to")?,
                from_pin: connection["from"]["pin"].as_str().unwrap_or("").to_owned(),
                to_pin: connection["to"]["pin"].as_str().unwrap_or("").to_owned(),
                label: format!(
                    "{}{voltage}",
                    connection["signalRole"].as_str().unwrap_or("")
                ),
            })
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"table":table,"diagramSvg":diagram::draw(&titles, &wires),"revisionId":revision["id"]}),
    )
}

/// The wiring diagram: one column per component, one row per connection.
///
/// Every connection has a row of its own, so no two labels can meet however
/// many wires a component has: pin names sit above the wire at its two ends,
/// what the wire carries sits below it. Text that does not fit its space is
/// cut with an ellipsis and keeps the full text as a tooltip. All ink is
/// `currentColor`, so the drawing follows a light or a dark surface.
mod diagram {
    pub(super) struct Wire {
        pub(super) from: usize,
        pub(super) to: usize,
        pub(super) from_pin: String,
        pub(super) to_pin: String,
        pub(super) label: String,
    }

    const FONT: &str = "ui-monospace, 'IBM Plex Mono', Menlo, Consolas, monospace";
    /// Advance of one monospace character at 11 px, rounded up.
    const CHAR: f64 = 6.7;
    const MARGIN: usize = 24;
    const TOP: usize = 24;
    const TITLE_LINE: usize = 14;
    const TITLE_LINES: usize = 3;
    const BOX_PAD: usize = 8;
    const BOX_GAP: usize = 28;
    const FIRST_ROW: usize = 46;
    const ROW: usize = 36;
    const MIN_PITCH: usize = 150;
    const MAX_PITCH: usize = 240;
    const LOOP: usize = 18;

    fn escape(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    fn fits(width: usize) -> usize {
        (width as f64 / CHAR).floor() as usize
    }

    /// `text` cut to `limit` characters, the last one an ellipsis.
    fn cut(text: &str, limit: usize) -> String {
        if text.chars().count() <= limit {
            return text.to_owned();
        }
        let kept = text
            .chars()
            .take(limit.saturating_sub(1))
            .collect::<String>();
        format!("{}…", kept.trim_end())
    }

    /// The words of a title, a number kept together with the unit after it
    /// (`5 V`, `450 mAh`) by a no-break space so that a line never ends
    /// between a value and its unit.
    fn words(title: &str) -> Vec<String> {
        let mut words = Vec::<String>::new();
        let mut value_before = false;
        for word in title.split_whitespace() {
            let is_value = word
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.' || c == ',');
            let is_unit = word.chars().count() <= 4 && word.chars().all(char::is_alphabetic);
            match words.last_mut() {
                Some(last) if value_before && is_unit => {
                    last.push('\u{a0}');
                    last.push_str(word);
                }
                _ => words.push(word.to_owned()),
            }
            value_before = is_value;
        }
        words
    }

    /// Break a title into at most `TITLE_LINES` lines of `limit` characters,
    /// at spaces where possible.
    fn wrap(title: &str, limit: usize) -> Vec<String> {
        let mut lines = Vec::<String>::new();
        for mut word in words(title) {
            loop {
                let line_len = lines.last().map_or(0, |line| line.chars().count());
                let word_len = word.chars().count();
                if !lines.is_empty() && line_len > 0 && line_len + 1 + word_len <= limit {
                    let last = lines.last_mut().expect("a line exists");
                    last.push(' ');
                    last.push_str(&word);
                    break;
                }
                if word_len <= limit {
                    lines.push(word);
                    break;
                }
                // A single word longer than the line is split.
                let head = word.chars().take(limit).collect::<String>();
                word = word.chars().skip(limit).collect();
                lines.push(head);
            }
        }
        if lines.is_empty() {
            lines.push(String::new());
        }
        if lines.len() > TITLE_LINES {
            let rest = lines.split_off(TITLE_LINES - 1).join(" ");
            lines.push(cut(&rest, limit));
        }
        lines
    }

    fn text(
        x: usize,
        y: usize,
        anchor: &str,
        full: &str,
        limit: usize,
        opacity: Option<&str>,
    ) -> String {
        let visible = cut(full, limit);
        let tooltip = if visible == full {
            String::new()
        } else {
            format!("<title>{}</title>", escape(full))
        };
        let opacity = opacity
            .map(|value| format!(" fill-opacity=\"{value}\""))
            .unwrap_or_default();
        format!(
            "<text x=\"{x}\" y=\"{y}\" text-anchor=\"{anchor}\" fill=\"currentColor\"{opacity}>{tooltip}{}</text>",
            escape(&visible)
        )
    }

    pub(super) fn draw(titles: &[String], wires: &[Wire]) -> String {
        if titles.is_empty() {
            return format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"200\" height=\"60\" viewBox=\"0 0 200 60\" font-family=\"{FONT}\" font-size=\"12\"><text x=\"20\" y=\"34\" fill=\"currentColor\">no connections</text></svg>");
        }
        // The pitch is as narrow as the longest pin names and wire labels
        // between neighbours allow, so a small harness is not scaled down.
        let longest = |texts: &mut dyn Iterator<Item = &String>, most: usize| {
            texts
                .map(|text| text.chars().count())
                .max()
                .unwrap_or(0)
                .min(most) as f64
        };
        let pins = longest(
            &mut wires.iter().flat_map(|wire| [&wire.from_pin, &wire.to_pin]),
            14,
        );
        let labels = longest(&mut wires.iter().map(|wire| &wire.label), 30);
        let wanted = (40.0 + 2.0 * pins * CHAR).max(16.0 + labels * CHAR).ceil() as usize;
        let pitch = wanted.clamp(MIN_PITCH, MAX_PITCH).div_ceil(2) * 2;
        let box_width = pitch - BOX_GAP;
        let center = |column: usize| MARGIN + column * pitch + pitch / 2;

        let wrapped = titles
            .iter()
            .map(|title| wrap(title, fits(box_width - 2 * BOX_PAD)))
            .collect::<Vec<_>>();
        let title_lines = wrapped.iter().map(Vec::len).max().unwrap_or(1);
        let box_height = 2 * BOX_PAD + title_lines * TITLE_LINE;
        let first_row = TOP + box_height + FIRST_ROW;
        let rows = wires.len();
        let bottom = if rows == 0 {
            TOP + box_height
        } else {
            first_row + (rows - 1) * ROW + 26
        };
        let width = 2 * MARGIN + titles.len() * pitch;
        let height = bottom + 18;

        let mut parts = vec![format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\" font-family=\"{FONT}\" font-size=\"11\"><title>Wiring diagram: {} component(s), {} connection(s)</title>",
            titles.len(),
            rows
        )];
        for (column, lines) in wrapped.iter().enumerate() {
            let x = center(column);
            parts.push(format!(
                "<rect x=\"{}\" y=\"{TOP}\" width=\"{box_width}\" height=\"{box_height}\" rx=\"4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\"/>",
                x - box_width / 2
            ));
            // Shorter titles are centred in the box height.
            let offset = (title_lines - lines.len()) * TITLE_LINE / 2;
            // A title that was cut or split mid-word keeps its full text as a tooltip.
            let shown = lines.join(" ").replace('\u{a0}', " ");
            let whole = titles[column]
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            for (index, line) in lines.iter().enumerate() {
                let tooltip = if index == 0 && shown != whole {
                    format!("<title>{}</title>", escape(&titles[column]))
                } else {
                    String::new()
                };
                parts.push(format!(
                    "<text x=\"{x}\" y=\"{}\" text-anchor=\"middle\" fill=\"currentColor\" font-weight=\"600\">{tooltip}{}</text>",
                    TOP + BOX_PAD + offset + index * TITLE_LINE + 11,
                    escape(line)
                ));
            }
            if rows > 0 {
                parts.push(format!(
                    "<line x1=\"{x}\" y1=\"{}\" x2=\"{x}\" y2=\"{bottom}\" stroke=\"currentColor\" stroke-opacity=\"0.35\" stroke-dasharray=\"2 4\"/>",
                    TOP + box_height
                ));
            }
        }
        for (row, wire) in wires.iter().enumerate() {
            let y = first_row + row * ROW;
            let x1 = center(wire.from);
            if wire.from == wire.to {
                // Both ends on one component: a short loop beside its line,
                // the two pins and the label to the right of it.
                let space = fits(pitch / 2 - LOOP - 12);
                parts.push(format!(
                    "<path d=\"M {x1} {y} h {LOOP} v 12 h -{LOOP}\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\"/>"
                ));
                parts.push(format!(
                    "<circle cx=\"{x1}\" cy=\"{y}\" r=\"2.5\" fill=\"currentColor\"/><circle cx=\"{x1}\" cy=\"{}\" r=\"2.5\" fill=\"currentColor\"/>",
                    y + 12
                ));
                let pins = format!("{} – {}", wire.from_pin, wire.to_pin);
                parts.push(text(x1 + LOOP + 8, y + 2, "start", &pins, space, None));
                parts.push(text(
                    x1 + LOOP + 8,
                    y + 15,
                    "start",
                    &wire.label,
                    space,
                    Some("0.72"),
                ));
                continue;
            }
            let x2 = center(wire.to);
            let (left, right) = (x1.min(x2), x1.max(x2));
            let span = right - left;
            parts.push(format!(
                "<path d=\"M {x1} {y} H {x2}\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\"/>"
            ));
            parts.push(format!(
                "<circle cx=\"{x1}\" cy=\"{y}\" r=\"2.5\" fill=\"currentColor\"/><circle cx=\"{x2}\" cy=\"{y}\" r=\"2.5\" fill=\"currentColor\"/>"
            ));
            let pin_space = fits((span - 28) / 2);
            let (left_pin, right_pin) = if x1 < x2 {
                (&wire.from_pin, &wire.to_pin)
            } else {
                (&wire.to_pin, &wire.from_pin)
            };
            parts.push(text(left + 8, y - 6, "start", left_pin, pin_space, None));
            parts.push(text(right - 8, y - 6, "end", right_pin, pin_space, None));
            // What the wire carries sits between its first two components
            // when it fits there, clear of the lines of the components the
            // wire passes; a longer text takes the whole wire.
            let near = fits(pitch - 16);
            let (label_x, label_space) = if wire.label.chars().count() <= near {
                (left + pitch / 2, near)
            } else {
                (left + span / 2, fits(span - 16))
            };
            parts.push(text(
                label_x,
                y + 14,
                "middle",
                &wire.label,
                label_space,
                Some("0.72"),
            ));
        }
        parts.push("</svg>".into());
        parts.join("")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Bench;

    fn volts_range(low: f64, high: f64) -> Value {
        json!({"min": {"value": low, "unit": "V"}, "max": {"value": high, "unit": "V"}})
    }

    /// An approved component with the given title; returns (artifact id, revision id).
    fn approved(bench: &mut Bench, title: &str) -> (String, String) {
        let draft = bench.component(title, json!({"value": 10, "unit": "g"}), None);
        bench.accept(&draft);
        (
            draft["artifact"]["id"].as_str().unwrap().to_owned(),
            draft["revision"]["id"].as_str().unwrap().to_owned(),
        )
    }

    fn wiring(bench: &mut Bench, payload: Value) -> String {
        let draft = bench
            .user(
                "artifact.create_draft",
                json!({"type": "wiring", "title": "Harness", "payload": payload}),
            )
            .unwrap();
        draft["artifact"]["id"].as_str().unwrap().to_owned()
    }

    fn findings(bench: &mut Bench, wiring_id: &str) -> Vec<(String, String, String)> {
        let result = bench
            .user("wiring.validate", json!({"artifactId": wiring_id}))
            .unwrap();
        result["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|finding| {
                (
                    finding["severity"].as_str().unwrap().to_owned(),
                    finding["code"].as_str().unwrap().to_owned(),
                    finding["connectionId"].as_str().unwrap_or("").to_owned(),
                )
            })
            .collect()
    }

    fn end(component: &str, pin: &str) -> Value {
        json!({"componentArtifactId": component, "pin": pin})
    }

    /// The wiring of the Sable rover fixture (`fixtures/rover/rover.fixture.ts`):
    /// the same four components, thirteen pins and eight connections.
    fn rover(bench: &mut Bench) -> String {
        let (battery, _) = approved(bench, "LiPo 2S 450 mAh pack (supplier listing)");
        let (driver, _) = approved(bench, "Pololu DRV8835 dual motor driver carrier");
        let (regulator, _) = approved(bench, "Pololu D24V22F5 5 V step-down regulator");
        let (mcu, _) = approved(bench, "Raspberry Pi Zero 2 W");
        let pin = |component: &str, name: &str, kind: &str, range: Option<(f64, f64)>| {
            let mut pin = json!({"componentArtifactId": component, "pin": name, "type": kind});
            if let Some((low, high)) = range {
                pin["voltageRange"] = volts_range(low, high);
            }
            pin
        };
        let connection = |number: u32, from: Value, to: Value, role: &str, voltage: Option<f64>| {
            let mut connection = json!({"id": format!("00000000-0000-4000-8000-00000000c00{number}"), "from": from, "to": to, "signalRole": role});
            if let Some(voltage) = voltage {
                connection["voltage"] = json!({"value": voltage, "unit": "V"});
            }
            connection
        };
        let payload = json!({
            "pins": [
                pin(&battery, "BAT+", "power", Some((6.4, 8.4))),
                pin(&battery, "BAT-", "ground", None),
                pin(&regulator, "VIN", "power", Some((6.0, 36.0))),
                pin(&regulator, "VOUT", "power", Some((5.0, 5.0))),
                pin(&regulator, "GND", "ground", None),
                pin(&driver, "VIN", "power", Some((2.0, 11.0))),
                pin(&driver, "GND", "ground", None),
                pin(&driver, "OUT1", "signal", None),
                pin(&driver, "OUT2", "signal", None),
                pin(&mcu, "GPIO18", "signal", None),
                pin(&mcu, "GPIO19", "signal", None),
                pin(&mcu, "5V", "power", Some((4.75, 5.25))),
                pin(&mcu, "GND", "ground", None),
            ],
            "connections": [
                connection(1, end(&battery, "BAT+"), end(&driver, "VIN"), "motor rail", Some(7.4)),
                connection(2, end(&battery, "BAT+"), end(&regulator, "VIN"), "regulator input", Some(7.4)),
                connection(3, end(&battery, "BAT-"), end(&regulator, "GND"), "ground", None),
                connection(4, end(&battery, "BAT-"), end(&driver, "GND"), "ground", None),
                connection(5, end(&regulator, "VOUT"), end(&mcu, "5V"), "logic rail", Some(5.0)),
                connection(6, end(&regulator, "GND"), end(&mcu, "GND"), "ground", None),
                connection(7, end(&mcu, "GPIO18"), end(&driver, "IN1"), "motor A PWM", None),
                connection(8, end(&mcu, "GPIO19"), end(&driver, "IN2"), "motor B PWM", None),
            ],
            "coverageNote": "Motor OUT leads omitted pending motor pin fixture — see DRV8835 datasheet.",
        });
        wiring(bench, payload)
    }

    #[derive(Debug, Clone, PartialEq)]
    struct LabelBox {
        text: String,
        left: f64,
        right: f64,
        top: f64,
        bottom: f64,
    }

    fn overlap(a: &LabelBox, b: &LabelBox) -> bool {
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    }

    fn attribute(tag: &str, name: &str) -> f64 {
        let pattern = Regex::new(&format!(r#" {name}="([0-9.]+)""#)).unwrap();
        pattern.captures(tag).unwrap()[1].parse().unwrap()
    }

    /// The box every `<text>` of the diagram occupies: 11 px monospace, whose
    /// characters advance 0.6 em, placed by its anchor on its baseline.
    fn label_boxes(svg: &str) -> Vec<LabelBox> {
        let text = Regex::new(r#"<text ([^>]*)>(?:<title>[^<]*</title>)?([^<]*)</text>"#).unwrap();
        text.captures_iter(svg)
            .map(|found| {
                let tag = format!(" {}", &found[1]);
                let content = found[2]
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&quot;", "\"")
                    .replace("&apos;", "'")
                    .replace("&amp;", "&");
                let width = content.chars().count() as f64 * 11.0 * 0.6;
                let (x, y) = (attribute(&tag, "x"), attribute(&tag, "y"));
                let left = if tag.contains(r#"text-anchor="middle""#) {
                    x - width / 2.0
                } else if tag.contains(r#"text-anchor="end""#) {
                    x - width
                } else {
                    x
                };
                LabelBox {
                    text: content,
                    left,
                    right: left + width,
                    top: y - 9.0,
                    bottom: y + 3.0,
                }
            })
            .collect()
    }

    /// No label meets another label, crosses the edge of a component box, or
    /// leaves the drawing.
    fn assert_readable(svg: &str) -> Vec<LabelBox> {
        let labels = label_boxes(svg);
        for (index, a) in labels.iter().enumerate() {
            for b in &labels[index + 1..] {
                assert!(!overlap(a, b), "labels overlap: {a:?} and {b:?}");
            }
        }
        let view = Regex::new(r#"viewBox="0 0 (\d+) (\d+)""#).unwrap();
        let size = view.captures(svg).unwrap();
        let (width, height): (f64, f64) = (size[1].parse().unwrap(), size[2].parse().unwrap());
        let rect = Regex::new(r#"<rect ([^>]*)/>"#).unwrap();
        let boxes = rect
            .captures_iter(svg)
            .map(|found| {
                let tag = format!(" {}", &found[1]);
                let (x, y) = (attribute(&tag, "x"), attribute(&tag, "y"));
                LabelBox {
                    text: "component box".into(),
                    left: x,
                    right: x + attribute(&tag, "width"),
                    top: y,
                    bottom: y + attribute(&tag, "height"),
                }
            })
            .collect::<Vec<_>>();
        for (index, a) in boxes.iter().enumerate() {
            for b in &boxes[index + 1..] {
                assert!(!overlap(a, b), "component boxes overlap: {a:?} and {b:?}");
            }
        }
        for label in &labels {
            assert!(
                label.left >= 0.0
                    && label.right <= width
                    && label.top >= 0.0
                    && label.bottom <= height,
                "label leaves the drawing: {label:?} in {width} x {height}"
            );
            for component in &boxes {
                let inside = label.left >= component.left
                    && label.right <= component.right
                    && label.top >= component.top
                    && label.bottom <= component.bottom;
                assert!(
                    inside || !overlap(label, component),
                    "label crosses a component box: {label:?} and {component:?}"
                );
            }
        }
        labels
    }

    #[test]
    fn wiring_validation_labels_unverified_connections_and_keeps_revisions() {
        let mut bench = Bench::new();
        let id = wiring(&mut bench, json!({"pins":[],"connections":[]}));
        let empty = bench
            .user("wiring.validate", json!({"artifactId":id}))
            .unwrap();
        assert_eq!(empty["findings"][0]["code"], "NO_CONNECTIONS");
        let revised=bench.user("wiring.set_pins",json!({"artifactId":id,"pins":[{"componentArtifactId":uuid::Uuid::new_v4().to_string(),"pin":"GND","type":"ground"}]})).unwrap();
        assert_eq!(revised["seq"], 2);
        let history = bench
            .user("artifact.history", json!({"artifactId":id}))
            .unwrap();
        assert_eq!(history["revisions"].as_array().unwrap().len(), 2);
        let view = bench
            .user("wiring.render", json!({"artifactId":id}))
            .unwrap();
        assert!(view["diagramSvg"].as_str().unwrap().starts_with("<svg"));
        // Checks and drawings say which revision they are of.
        assert_eq!(view["revisionId"], revised["id"]);
    }

    #[test]
    fn the_server_assigns_connection_ids_and_component_revisions() {
        let mut bench = Bench::new();
        let (board, board_revision) = approved(&mut bench, "Board");
        let sensor = bench.component("Sensor", json!({"value": 5, "unit": "g"}), None);
        let sensor_id = sensor["artifact"]["id"].as_str().unwrap();
        let id = wiring(&mut bench, json!({"pins": [], "connections": []}));
        let kept = "00000000-0000-4000-8000-0000000000aa";
        let revision = bench
            .agent(
                "wiring.set_connections",
                json!({"artifactId": id, "connections": [
                    {"from": end(&board, "3V3"), "to": end(sensor_id, "VCC"), "signalRole": "power"},
                    {"id": kept, "from": end(&board, "GND"), "to": end(sensor_id, "GND"), "signalRole": "ground"},
                ]}),
            )
            .unwrap();
        let connections = revision["payload"]["connections"].as_array().unwrap();
        let assigned = connections[0]["id"].as_str().unwrap();
        assert!(uuid::Uuid::parse_str(assigned).is_ok());
        assert_ne!(assigned, kept);
        assert_eq!(connections[1]["id"], kept);
        // An approved component is drawn at its approved revision, a candidate at its newest draft.
        assert_eq!(
            connections[0]["from"]["componentRevisionId"],
            board_revision
        );
        assert_eq!(
            connections[0]["to"]["componentRevisionId"],
            sensor["revision"]["id"]
        );
        // The same completion applies to a wiring payload written as a whole draft.
        let whole = bench
            .agent(
                "artifact.create_draft",
                json!({"type": "wiring", "title": "Second harness", "payload": {"connections": [
                    {"from": end(&board, "5V"), "to": end(sensor_id, "EN"), "signalRole": "enable"},
                ]}}),
            )
            .unwrap();
        let written = &whole["revision"]["payload"]["connections"][0];
        assert!(uuid::Uuid::parse_str(written["id"].as_str().unwrap()).is_ok());
        assert_eq!(written["from"]["componentRevisionId"], board_revision);

        let twice = bench
            .agent(
                "wiring.set_connections",
                json!({"artifactId": id, "connections": [
                    {"id": kept, "from": end(&board, "A"), "to": end(sensor_id, "B"), "signalRole": "x"},
                    {"id": kept, "from": end(&board, "C"), "to": end(sensor_id, "D"), "signalRole": "y"},
                ]}),
            )
            .unwrap_err();
        assert_eq!(twice.message, format!("Connection id {kept} is used twice"));
        assert_eq!(
            twice.details.unwrap()["issues"][0]["path"],
            "connections[1].id"
        );
        let missing = uuid::Uuid::new_v4().to_string();
        let unknown = bench
            .agent(
                "wiring.set_connections",
                json!({"artifactId": id, "connections": [
                    {"from": end(&board, "A"), "to": end(&missing, "B"), "signalRole": "x"},
                ]}),
            )
            .unwrap_err();
        assert_eq!(unknown.code, "NOT_FOUND");
        assert_eq!(unknown.message, format!("Component not found: {missing}"));
        assert_eq!(
            unknown.details.unwrap()["issues"][0]["path"],
            "connections[0].to.componentArtifactId"
        );
    }

    #[test]
    fn undeclared_pins_are_typed_by_their_names_as_the_oracle_does() {
        for name in [
            "VCC", "vdd", "VIN", "VS", "VBAT", "VBATT", "PWR", "power", "V+", "5V", "3V3", "3V",
            "12V", "24V", "+5V", "+3V3", "+12V", "9V", "6V", "48V", "5V0", "1V8", "5V_USB",
            "3V3_OUT", "VCC3", "VCC5", "VCC_3V3", "VCC_IO", "VDD_A", "VBUS", "VSYS", "VMOT",
            "3.3V", "+3.3V",
        ] {
            assert_eq!(effective_pin_type(None, name), "power", "{name}");
        }
        for name in [
            "GND", "gnd", "Ground", "VSS", "VSSA", "V-", "0V", "AGND", "DGND", "PGND", "chassis",
            "GND1", "GND_A",
        ] {
            assert_eq!(effective_pin_type(None, name), "ground", "{name}");
        }
        for name in [
            "IN1", "GPIO18", "SDA", "COM", "OUT", "VREF", "EN", "V", "GNDSENSE",
        ] {
            assert_eq!(effective_pin_type(None, name), "unknown", "{name}");
        }
        // A declared type always wins over the name.
        let declared = json!({"type": "signal"});
        assert_eq!(effective_pin_type(Some(&declared), "5V"), "signal");
        let undeclared = json!({"type": "unknown"});
        assert_eq!(effective_pin_type(Some(&undeclared), "+5V"), "power");
    }

    #[test]
    fn a_supply_named_on_the_silk_screen_needs_a_ground_return() {
        let mut bench = Bench::new();
        let (board, _) = approved(&mut bench, "Board");
        let (sensor, _) = approved(&mut bench, "Sensor");
        let id = wiring(
            &mut bench,
            json!({"connections": [{"from": end(&board, "+5V"), "to": end(&sensor, "VIN"), "signalRole": "power"}]}),
        );
        let found = bench
            .user("wiring.validate", json!({"artifactId": id}))
            .unwrap();
        let grounds = found["findings"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|finding| finding["code"] == "MISSING_GROUND")
            .map(|finding| finding["message"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        // Both ends are supplies by name; neither has a ground. Board first: it was connected first.
        assert_eq!(
            grounds,
            [
                format!("Component {board} has a power pin connected but no ground pin in any connection"),
                format!("Component {sensor} has a power pin connected but no ground pin in any connection"),
            ]
        );
    }

    #[test]
    fn findings_keep_declaration_order_and_repeat_exactly() {
        let mut bench = Bench::new();
        let (mcu, _) = approved(&mut bench, "Controller");
        let (left, _) = approved(&mut bench, "Left driver");
        let (right, _) = approved(&mut bench, "Right driver");
        // Declared so that the order of the ids is the reverse of the order of declaration.
        let first = "00000000-0000-4000-8000-00000000000f";
        let second = "00000000-0000-4000-8000-00000000000e";
        let third = "00000000-0000-4000-8000-00000000000d";
        let id = wiring(
            &mut bench,
            json!({
                "pins": [
                    {"componentArtifactId": mcu, "pin": "PWM", "type": "signal"},
                    {"componentArtifactId": mcu, "pin": "DIR", "type": "signal"},
                    {"componentArtifactId": left, "pin": "IN", "type": "signal"},
                    {"componentArtifactId": right, "pin": "IN", "type": "signal"},
                ],
                "connections": [
                    {"id": first, "from": end(&mcu, "PWM"), "to": end(&left, "IN"), "signalRole": "pwm"},
                    {"id": second, "from": end(&mcu, "PWM"), "to": end(&right, "IN"), "signalRole": "pwm"},
                    {"id": third, "from": end(&mcu, "DIR"), "to": end(&left, "IN"), "signalRole": "direction"},
                ],
            }),
        );
        let once = bench
            .user("wiring.validate", json!({"artifactId": id}))
            .unwrap();
        assert_eq!(
            findings(&mut bench, &id),
            [
                // The controller pin, shared first, is reported first; each names the second user in declaration order.
                (
                    "warning".to_owned(),
                    "DUPLICATE_EXCLUSIVE".to_owned(),
                    second.to_owned()
                ),
                (
                    "warning".to_owned(),
                    "DUPLICATE_EXCLUSIVE".to_owned(),
                    third.to_owned()
                ),
            ]
        );
        assert_eq!(
            once["findings"][0]["message"],
            format!("Pin 'PWM' on component {mcu} is used by 2 connections ({first}, {second}) — confirm the shared pin is intended")
        );
        for _ in 0..5 {
            let again = bench
                .user("wiring.validate", json!({"artifactId": id}))
                .unwrap();
            assert_eq!(again, once);
        }
    }

    #[test]
    fn the_rover_harness_validates_without_false_errors() {
        let mut bench = Bench::new();
        let id = rover(&mut bench);
        let found = bench
            .user("wiring.validate", json!({"artifactId": id}))
            .unwrap();
        // The battery and regulator pins feed several loads: rails fan out by design.
        // The only findings are the two driver inputs the pin list does not declare.
        let messages = found["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|finding| {
                let message = finding["message"].as_str().unwrap();
                format!(
                    "{} {} {}",
                    finding["severity"].as_str().unwrap(),
                    finding["code"].as_str().unwrap(),
                    &message[..message.find(" on component").unwrap()]
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            messages,
            [
                "warning CONNECTION_UNKNOWN_PIN Unknown pin 'IN1'",
                "warning CONNECTION_UNKNOWN_PIN Unknown pin 'IN2'",
            ]
        );
        assert_eq!(found["coverage"], COVERAGE);
    }

    #[test]
    fn voltage_checks_compare_in_volts_and_catch_conflicting_rails() {
        let mut bench = Bench::new();
        let (supply, _) = approved(&mut bench, "Supply");
        let (logic, _) = approved(&mut bench, "Logic");
        let (motor, _) = approved(&mut bench, "Motor");
        let pins = json!([
            {"componentArtifactId": logic, "pin": "3V3", "type": "power", "voltageRange": volts_range(3.0, 3.3)},
            {"componentArtifactId": logic, "pin": "GND", "type": "ground"},
            {"componentArtifactId": supply, "pin": "OUT", "type": "power"},
            {"componentArtifactId": supply, "pin": "GND", "type": "ground"},
            {"componentArtifactId": motor, "pin": "V+", "type": "power", "voltageRange": {"min": {"value": 6, "unit": "V"}, "max": {"value": 2, "unit": "A"}}},
            {"componentArtifactId": motor, "pin": "GND", "type": "ground"},
        ]);
        let connections = |level: Value| {
            json!([
                {"id": "00000000-0000-4000-8000-000000000001", "from": end(&supply, "OUT"), "to": end(&logic, "3V3"), "signalRole": "logic rail", "voltage": level},
                {"id": "00000000-0000-4000-8000-000000000002", "from": end(&supply, "GND"), "to": end(&logic, "GND"), "signalRole": "ground"},
                {"id": "00000000-0000-4000-8000-000000000003", "from": end(&supply, "GND"), "to": end(&motor, "GND"), "signalRole": "ground"},
            ])
        };
        // 3300 mV is exactly the 3.3 V limit: no finding.
        let id = wiring(
            &mut bench,
            json!({"pins": pins, "connections": connections(json!({"value": 3300, "unit": "mV"}))}),
        );
        assert_eq!(findings(&mut bench, &id), []);
        bench
            .user(
                "wiring.set_connections",
                json!({"artifactId": id, "connections": connections(json!({"value": 5, "unit": "V"}))}),
            )
            .unwrap();
        let over = bench
            .user("wiring.validate", json!({"artifactId": id}))
            .unwrap();
        assert_eq!(over["findings"].as_array().unwrap().len(), 1);
        assert_eq!(over["findings"][0]["severity"], "error");
        assert_eq!(over["findings"][0]["code"], "VOLTAGE_INCOMPATIBLE");
        assert_eq!(
            over["findings"][0]["message"],
            format!("Connection voltage 5 V outside '3V3' range 3–3.3 V on component {logic}")
        );
        // One supply pin wired at two different voltages, and a range that is not a voltage.
        let mut conflicting = connections(json!({"value": 3.3, "unit": "V"}));
        conflicting.as_array_mut().unwrap().push(json!(
            {"id": "00000000-0000-4000-8000-000000000004", "from": end(&supply, "OUT"), "to": end(&motor, "V+"), "signalRole": "motor rail", "voltage": {"value": 7.4, "unit": "V"}}
        ));
        bench
            .user(
                "wiring.set_connections",
                json!({"artifactId": id, "connections": conflicting}),
            )
            .unwrap();
        let found = bench
            .user("wiring.validate", json!({"artifactId": id}))
            .unwrap();
        let messages = found["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|finding| finding["message"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            messages,
            [
                format!("Could not compare voltage range on pin 'V+' ({motor})"),
                format!("Pin 'OUT' on component {supply} is connected at 3.3 V and 7.4 V"),
            ]
        );
    }

    #[test]
    fn a_changed_component_is_reported_and_a_candidate_is_not_an_error() {
        let mut bench = Bench::new();
        let (board, board_revision) = approved(&mut bench, "Board");
        let candidate = bench.component("Candidate sensor", json!({"value": 5, "unit": "g"}), None);
        let candidate_id = candidate["artifact"]["id"].as_str().unwrap().to_owned();
        let gone = uuid::Uuid::new_v4().to_string();
        let id = wiring(
            &mut bench,
            json!({
                "pins": [
                    {"componentArtifactId": board, "pin": "D1", "type": "signal"},
                    {"componentArtifactId": board, "pin": "D2", "type": "signal"},
                    {"componentArtifactId": candidate_id, "pin": "OUT", "type": "signal"},
                    {"componentArtifactId": candidate_id, "pin": "INT", "type": "signal"},
                ],
                "connections": [
                    {"id": "00000000-0000-4000-8000-000000000001", "from": end(&candidate_id, "OUT"), "to": end(&board, "D1"), "signalRole": "data"},
                    {"id": "00000000-0000-4000-8000-000000000002", "from": end(&candidate_id, "INT"), "to": end(&board, "D2"), "signalRole": "interrupt"},
                ],
            }),
        );
        // A candidate that is not approved yet is stated once, as information.
        assert_eq!(
            findings(&mut bench, &id),
            [(
                "info".to_owned(),
                "COMPONENT_UNAPPROVED".to_owned(),
                "00000000-0000-4000-8000-000000000001".to_owned()
            )]
        );
        // Selecting the candidate approves a new revision of the same part: nothing to report.
        let selection = bench
            .agent(
                "component.propose_selection",
                json!({"artifactId": candidate_id, "bomLines": [{"quantity": 1}], "reason": "fits"}),
            )
            .unwrap();
        bench.approve(&selection["proposal"]);
        assert_eq!(findings(&mut bench, &id), []);
        // The board gets a new approved revision after the wiring was drawn.
        bench
            .user(
                "artifact.apply_edit",
                json!({"artifactId": board, "baseRevisionId": board_revision, "payloadPatch": {"partNumber": "board-rev-b"}, "rationale": "new board revision"}),
            )
            .unwrap();
        let changed = bench
            .user("wiring.validate", json!({"artifactId": id}))
            .unwrap();
        let change = changed["findings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|finding| finding["code"] == "CHANGED_COMPONENT")
            .unwrap();
        assert_eq!(change["severity"], "warning");
        assert!(change["message"].as_str().unwrap().starts_with(&format!(
            "Component {board} changed since this wiring was drawn: the connections use revision {board_revision}"
        )));
        assert_eq!(
            changed["findings"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|finding| finding["code"] == "CHANGED_COMPONENT")
                .count(),
            1
        );
        // A component that does not exist is an error on each end that names it.
        let missing = wiring(
            &mut bench,
            json!({"connections": [{"id": "00000000-0000-4000-8000-000000000003", "from": {"componentArtifactId": gone, "componentRevisionId": gone, "pin": "A"}, "to": {"componentArtifactId": board, "componentRevisionId": board_revision, "pin": "D1"}, "signalRole": "data"}]}),
        );
        let found = bench
            .user("wiring.validate", json!({"artifactId": missing}))
            .unwrap();
        assert_eq!(found["findings"][0]["severity"], "error");
        assert_eq!(
            found["findings"][0]["message"],
            format!("Component revision unavailable or changed: {gone}@{gone} (from 'A')")
        );
    }

    #[test]
    fn edits_build_on_the_newest_draft_and_keep_component_dependencies() {
        let mut bench = Bench::new();
        let (board, board_revision) = approved(&mut bench, "Board");
        let (sensor, sensor_revision) = approved(&mut bench, "Sensor");
        let (fan, fan_revision) = approved(&mut bench, "Fan");
        let source = bench
            .user(
                "source.capture",
                json!({"title": "Pinout", "url": "https://example.test/pinout"}),
            )
            .unwrap();
        let draft = bench
            .user(
                "artifact.create_draft",
                json!({"type": "wiring", "title": "Harness", "payload": {"pins": [], "connections": []},
                    "inputs": [{"artifactId": source["artifact"]["id"], "relationship": "derived_from", "label": "pinout"}]}),
            )
            .unwrap();
        let id = draft["artifact"]["id"].as_str().unwrap().to_owned();
        let baseline = bench.accept(&draft)["revision"].clone();
        let connected = bench
            .agent(
                "wiring.set_connections",
                json!({"artifactId": id, "connections": [
                    {"from": end(&board, "D1"), "to": end(&sensor, "OUT"), "signalRole": "data"},
                    {"from": end(&board, "D2"), "to": end(&fan, "PWM"), "signalRole": "pwm"},
                ]}),
            )
            .unwrap();
        assert_eq!(connected["parentId"], baseline["id"]);
        let dependencies = |revision: &Value| {
            revision["inputs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|input| {
                    format!(
                        "{} {} {}",
                        input["relationship"].as_str().unwrap(),
                        input["revisionId"].as_str().unwrap(),
                        input["label"].as_str().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
        };
        let source_revision = source["revision"]["id"].as_str().unwrap();
        assert_eq!(
            dependencies(&connected),
            [
                format!("derived_from {source_revision} pinout"),
                format!("depends_on {board_revision} pinout source"),
                format!("depends_on {sensor_revision} pinout source"),
                format!("depends_on {fan_revision} pinout source"),
            ]
        );
        // Pins set next, with no revision named, extend that draft: its connections
        // and its dependencies are still there.
        let pinned = bench
            .agent(
                "wiring.set_pins",
                json!({"artifactId": id, "pins": [{"componentArtifactId": board, "pin": "D1", "type": "signal"}]}),
            )
            .unwrap();
        assert_eq!(pinned["parentId"], connected["id"]);
        assert_eq!(
            pinned["payload"]["connections"],
            connected["payload"]["connections"]
        );
        assert_eq!(pinned["payload"]["pins"][0]["pin"], "D1");
        assert_eq!(dependencies(&pinned), dependencies(&connected));
        // Dropping the fan drops the dependency this operation recorded for it, and nothing else.
        let fewer = bench
            .agent(
                "wiring.set_connections",
                json!({"artifactId": id, "connections": [
                    {"from": end(&board, "D1"), "to": end(&sensor, "OUT"), "signalRole": "data"},
                ]}),
            )
            .unwrap();
        assert_eq!(fewer["parentId"], pinned["id"]);
        assert_eq!(fewer["payload"]["pins"], pinned["payload"]["pins"]);
        assert_eq!(
            dependencies(&fewer),
            [
                format!("derived_from {source_revision} pinout"),
                format!("depends_on {board_revision} pinout source"),
                format!("depends_on {sensor_revision} pinout source"),
            ]
        );
        // The approved wiring is untouched by all of it.
        assert_eq!(
            bench.read(&id)["view"]["artifact"]["selectedRevisionId"],
            baseline["id"]
        );
        let other = wiring(&mut bench, json!({"pins": [], "connections": []}));
        let foreign = bench
            .agent(
                "wiring.set_pins",
                json!({"artifactId": other, "baseRevisionId": fewer["id"], "pins": []}),
            )
            .unwrap_err();
        assert_eq!(
            foreign.details.unwrap()["issues"][0]["path"],
            "baseRevisionId"
        );
    }

    #[test]
    fn the_rover_diagram_has_no_overlapping_labels() {
        let mut bench = Bench::new();
        let id = rover(&mut bench);
        let rendered = bench
            .user("wiring.render", json!({"artifactId": id}))
            .unwrap();
        let svg = rendered["diagramSvg"].as_str().unwrap();
        let labels = assert_readable(svg);
        let texts = labels
            .iter()
            .map(|label| label.text.as_str())
            .collect::<Vec<_>>();
        // Every pin and every wire label of the fixture is drawn in full.
        for expected in [
            "BAT+",
            "BAT-",
            "VIN",
            "VOUT",
            "GND",
            "5V",
            "GPIO18",
            "GPIO19",
            "IN1",
            "IN2",
            "motor rail 7.4 V",
            "regulator input 7.4 V",
            "ground",
            "logic rail 5 V",
            "motor A PWM",
            "motor B PWM",
        ] {
            assert!(
                texts.contains(&expected),
                "{expected} is missing from {texts:?}"
            );
        }
        // Long component titles are wrapped inside their boxes, not cut.
        // A value stays on one line with its unit.
        for line in [
            "LiPo 2S 450\u{a0}mAh",
            "pack (supplier",
            "listing)",
            "Pololu DRV8835",
            "dual motor driver",
            "carrier",
            "Pololu D24V22F5",
            "5\u{a0}V step-down",
            "regulator",
            "Raspberry Pi Zero",
            "2\u{a0}W",
        ] {
            assert!(texts.contains(&line), "{line} is missing from {texts:?}");
        }
        assert!(!svg.contains('…'));
        assert_eq!(svg.matches("<path ").count(), 8);
        assert_eq!(svg.matches("<rect ").count(), 4);
        // Narrow enough to be read without scaling in the stage (788 px at 1440).
        let width: usize = Regex::new(r#"width="(\d+)""#)
            .unwrap()
            .captures(svg)
            .unwrap()[1]
            .parse()
            .unwrap();
        assert!(width <= 760, "{width}");
        // Theme-neutral ink only.
        assert!(svg.contains("currentColor") && !svg.contains('#'));
        assert_eq!(
            rendered["table"][0]["fromLabel"],
            "LiPo 2S 450 mAh pack (supplier listing).BAT+"
        );
        assert_eq!(
            rendered["table"][6]["toLabel"],
            "Pololu DRV8835 dual motor driver carrier.IN1"
        );
    }

    #[test]
    fn long_names_self_connections_and_many_wires_stay_readable() {
        let mut bench = Bench::new();
        let (hub, _) = approved(
            &mut bench,
            "Supercalifragilisticexpialidocious_distribution_board_revision_C <prototype> & spares",
        );
        let (mcu, _) = approved(&mut bench, "MCU");
        let (imu, _) = approved(
            &mut bench,
            "Inertial measurement unit with a very long descriptive product title from the seller",
        );
        let mut connections = vec![
            json!({"from": end(&hub, "SPI0_MOSI/GPIO10/ALT0_FUNCTION_SELECT"), "to": end(&mcu, "PA7_SPI1_MOSI_TIM3_CH2_ADC1_IN7"), "signalRole": "serial peripheral interface, controller out peripheral in, 3.3 V logic", "voltage": {"value": 3.3, "unit": "V"}}),
            json!({"from": end(&imu, "INT1"), "to": end(&hub, "GPIO_INTERRUPT_REQUEST_LINE_1"), "signalRole": "interrupt <active low> & wake"}),
            json!({"from": end(&mcu, "BOOT0"), "to": end(&mcu, "GND_REFERENCE_FOR_BOOT_STRAP"), "signalRole": "boot strap held low for normal start"}),
            json!({"from": end(&imu, "A"), "to": end(&imu, "B"), "signalRole": ""}),
        ];
        for index in 0..20 {
            connections.push(json!({"from": end(&hub, &format!("OUT{index}")), "to": end(&imu, &format!("IN{index}")), "signalRole": format!("channel {index}")}));
        }
        let id = wiring(&mut bench, json!({"connections": connections}));
        let rendered = bench
            .user("wiring.render", json!({"artifactId": id}))
            .unwrap();
        let svg = rendered["diagramSvg"].as_str().unwrap();
        let labels = assert_readable(svg);
        // What does not fit is cut with an ellipsis and keeps its full text as a tooltip.
        assert!(labels.iter().any(|label| label.text.ends_with('…')));
        assert!(svg.contains("<title>SPI0_MOSI/GPIO10/ALT0_FUNCTION_SELECT</title>"));
        assert!(svg.contains("<title>serial peripheral interface, controller out peripheral in, 3.3 V logic 3.3 V</title>"));
        assert!(svg.contains("&lt;prototype&gt; &amp; spares</title>"));
        assert!(svg.contains("interrupt &lt;active low&gt; &amp; wake"));
        assert_eq!(svg.matches("<path ").count(), 24);
        // The table always carries the full names.
        assert_eq!(
            rendered["table"][0]["connection"]["from"]["pin"],
            "SPI0_MOSI/GPIO10/ALT0_FUNCTION_SELECT"
        );
        let empty = wiring(&mut bench, json!({"pins": [], "connections": []}));
        let nothing = bench
            .user("wiring.render", json!({"artifactId": empty}))
            .unwrap();
        let svg = nothing["diagramSvg"].as_str().unwrap();
        assert!(
            svg.contains(">no connections<") && svg.contains("currentColor") && !svg.contains('#')
        );
    }
}
