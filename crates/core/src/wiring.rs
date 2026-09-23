use super::*;
use std::collections::{HashMap, HashSet};

const COVERAGE: &str = "Checks: voltage range, ground return, exclusive pins, pin knowledge. Not a schematic ERC; does not prove electrical safety.";

fn wiring_revision(handle: &ProjectHandle, input: &Value) -> CoreResult<(Value, Value)> {
    let id = required_str(input, "artifactId")?;
    let artifact = require_artifact(handle, id)?;
    if artifact["type"] != "wiring" {
        return Err(ContractError::validation("Not a wiring artifact"));
    }
    let revision = if let Some(id) = input["revisionId"]
        .as_str()
        .or(input["baseRevisionId"].as_str())
        .or(artifact["selectedRevisionId"].as_str())
    {
        require_revision(handle, id)?
    } else {
        handle
            .db
            .query_row(
                "SELECT * FROM revision WHERE artifact_id=?1 ORDER BY seq DESC LIMIT 1",
                [id],
                revision_from_row,
            )
            .optional()
            .map_err(internal)?
            .ok_or_else(|| ContractError::validation("No wiring revision"))?
    };
    if revision["artifactId"] != id {
        return Err(ContractError::validation(
            "Revision does not belong to wiring artifact",
        ));
    }
    Ok((artifact, revision))
}

pub(super) fn set_pins(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let (_, revision) = wiring_revision(handle, input)?;
    let mut body = revision["payload"].clone();
    body["pins"] = input["pins"].clone();
    update_draft(
        handle,
        &json!({"artifactId":input["artifactId"],"payload":body,"rationale":"set pins"}),
        origin,
    )
    .map(|result| result["revision"].clone())
}

pub(super) fn set_connections(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let (_, revision) = wiring_revision(handle, input)?;
    let mut body = revision["payload"].clone();
    body["connections"] = input["connections"].clone();
    let mut inputs = revision["inputs"].as_array().cloned().unwrap_or_default();
    for connection in input["connections"].as_array().into_iter().flatten() {
        for name in ["from", "to"] {
            let end = &connection[name];
            if !inputs.iter().any(|prior| {
                prior["artifactId"] == end["componentArtifactId"]
                    && prior["revisionId"] == end["componentRevisionId"]
            }) {
                inputs.push(json!({"artifactId":end["componentArtifactId"],"revisionId":end["componentRevisionId"],"relationship":"depends_on","label":"pinout source"}));
            }
        }
    }
    update_draft(handle,&json!({"artifactId":input["artifactId"],"payload":body,"inputs":inputs,"rationale":"set connections"}),origin).map(|result|result["revision"].clone())
}

pub(super) fn validate(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let (_, revision) = wiring_revision(handle, input)?;
    let body = &revision["payload"];
    let pins = body["pins"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let connections = body["connections"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut findings = Vec::new();
    if connections.is_empty() {
        findings.push(
            json!({"severity":"info","code":"NO_CONNECTIONS","message":"No connections declared"}),
        );
    }
    let mut powered = HashSet::new();
    let mut grounded = HashSet::new();
    let mut uses: HashMap<(String, String), Vec<String>> = HashMap::new();
    for connection in connections {
        let connection_id = connection["id"].as_str().unwrap_or("");
        for name in ["from", "to"] {
            let end = &connection[name];
            let component_id = end["componentArtifactId"].as_str().unwrap_or("");
            let revision_id = end["componentRevisionId"].as_str().unwrap_or("");
            let pin_name = end["pin"].as_str().unwrap_or("");
            let component = handle
                .db
                .query_row(
                    "SELECT selected_revision_id FROM artifact WHERE id=?1",
                    [component_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(internal)?;
            if component.flatten().is_none() {
                findings.push(json!({"severity":"error","code":"CHANGED_COMPONENT","connectionId":connection_id,"message":format!("Component revision unavailable or changed: {component_id}@{revision_id} ({name} '{pin_name}')")}));
            }
            let pin = pins
                .iter()
                .find(|p| p["componentArtifactId"] == component_id && p["pin"] == pin_name);
            if pin.is_none() {
                findings.push(json!({"severity":"warning","code":"CONNECTION_UNKNOWN_PIN","connectionId":connection_id,"message":format!("Unknown pin '{pin_name}' on component {component_id} — not verified")}));
            }
            uses.entry((component_id.into(), pin_name.into()))
                .or_default()
                .push(connection_id.into());
            match effective_pin_type(pin, pin_name) {
                "power" => {
                    powered.insert(component_id.to_owned());
                }
                "ground" => {
                    grounded.insert(component_id.to_owned());
                }
                _ => {}
            }
            if let (Some(pin), Some(voltage)) =
                (pin, connection.get("voltage").filter(|v| !v.is_null()))
            {
                let range = &pin["voltageRange"];
                if !range.is_null() {
                    let compared = voltage_value(voltage)
                        .zip(voltage_value(&range["min"]))
                        .zip(voltage_value(&range["max"]));
                    match compared{
                        Some(((v,(lo,unit)),(hi,other)))=>{
                            if unit!=other {findings.push(json!({"severity":"warning","code":"CONNECTION_UNKNOWN_PIN","connectionId":connection_id,"message":format!("Could not compare voltage range on pin '{pin_name}' ({component_id})")}));}
                            else if v.0<lo||v.0>hi {findings.push(json!({"severity":"error","code":"VOLTAGE_INCOMPATIBLE","connectionId":connection_id,"message":format!("Connection voltage {} {} outside '{pin_name}' range {}–{} {} on component {component_id}",voltage["value"],voltage["unit"].as_str().unwrap_or(""),range["min"]["value"],range["max"]["value"],range["max"]["unit"].as_str().unwrap_or(""))}));}
                        },
                        None=>findings.push(json!({"severity":"warning","code":"CONNECTION_UNKNOWN_PIN","connectionId":connection_id,"message":format!("Could not compare voltage range on pin '{pin_name}' ({component_id})")}))
                    }
                }
            }
        }
    }
    for ((component, pin), ids) in uses {
        let distinct = ids.into_iter().collect::<HashSet<_>>();
        if distinct.len() > 1 {
            let mut ordered = distinct.into_iter().collect::<Vec<_>>();
            ordered.sort();
            findings.push(json!({"severity":"error","code":"DUPLICATE_EXCLUSIVE","connectionId":ordered[1],"message":format!("Pin '{pin}' on component {component} used by {} connections ({}) — pins are exclusive",ordered.len(),ordered.join(", "))}));
        }
    }
    for component in powered {
        if !grounded.contains(&component) {
            findings.push(json!({"severity":"error","code":"MISSING_GROUND","message":format!("Component {component} has a power pin connected but no ground pin in any connection")}));
        }
    }
    Ok(json!({"findings":findings,"coverage":COVERAGE}))
}

fn effective_pin_type(pin: Option<&Value>, name: &str) -> &'static str {
    match pin.and_then(|p| p["type"].as_str()).unwrap_or("unknown") {
        "power" => "power",
        "ground" => "ground",
        "signal" => "signal",
        "data" => "data",
        "mechanical" => "mechanical",
        _ => {
            let lower = name.to_ascii_lowercase();
            if [
                "gnd", "ground", "vss", "v-", "0v", "agnd", "dgnd", "pgnd", "chassis",
            ]
            .contains(&lower.as_str())
            {
                "ground"
            } else if [
                "vcc", "vdd", "v+", "vin", "vs", "vbat", "vbatt", "pwr", "power", "5v", "3v3",
                "12v", "24v",
            ]
            .contains(&lower.as_str())
                || lower.starts_with("vcc_")
            {
                "power"
            } else {
                "unknown"
            }
        }
    }
}

fn voltage_value(quantity: &Value) -> Option<(f64, &str)> {
    let value = quantity["value"].as_f64()?;
    let unit = quantity["unit"].as_str()?;
    let scale = match unit {
        "V" => 1.0,
        "mV" => 0.001,
        "kV" => 1000.0,
        _ => return None,
    };
    Some((value * scale, "V"))
}

pub(super) fn render(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let (_, revision) = wiring_revision(handle, input)?;
    let body = &revision["payload"];
    let connections = body["connections"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut order = Vec::<String>::new();
    for connection in connections {
        for name in ["from", "to"] {
            if let Some(id) = connection[name]["componentArtifactId"].as_str() {
                if !order.contains(&id.to_owned()) {
                    order.push(id.into());
                }
            }
        }
    }
    for pin in body["pins"].as_array().into_iter().flatten() {
        if let Some(id) = pin["componentArtifactId"].as_str() {
            if !order.contains(&id.to_owned()) {
                order.push(id.into());
            }
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
    let diagram = if order.is_empty() {
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"200\" height=\"60\"><text x=\"20\" y=\"34\" fill=\"#E6E9ED\" font-family=\"monospace\" font-size=\"12\">no connections</text></svg>".into()
    } else {
        let width = 80 + order.len() * 180 + order.len().saturating_sub(1) * 140;
        let height = 180;
        let mut parts=vec![format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\" font-family=\"monospace\" font-size=\"11\">")];
        for (index, id) in order.iter().enumerate() {
            let x = 40 + index * 320;
            parts.push(format!("<rect x=\"{x}\" y=\"60\" width=\"180\" height=\"70\" fill=\"none\" stroke=\"#87AFC7\" stroke-width=\"1.2\" rx=\"4\"/><text x=\"{}\" y=\"77\" fill=\"#E6E9ED\" text-anchor=\"middle\">{}</text>",x+90,escape_xml(&title(id))));
        }
        for (index, c) in connections.iter().enumerate() {
            let from = c["from"]["componentArtifactId"].as_str().unwrap_or("");
            let to = c["to"]["componentArtifactId"].as_str().unwrap_or("");
            let Some(fi) = order.iter().position(|id| id == from) else {
                continue;
            };
            let Some(ti) = order.iter().position(|id| id == to) else {
                continue;
            };
            let y = 100 + (index % 3) * 10;
            let x1 = 40 + fi * 320 + 180;
            let x2 = 40 + ti * 320;
            parts.push(format!("<path d=\"M {x1} {y} C {} {y}, {} {y}, {x2} {y}\" fill=\"none\" stroke=\"#87AFC7\" stroke-width=\"1.2\"/>",(x1+x2)/2,(x1+x2)/2));
        }
        parts.push("</svg>".into());
        parts.join("")
    };
    Ok(json!({"table":table,"diagramSvg":diagram}))
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wiring_validation_labels_unverified_connections_and_keeps_revisions() {
        let temp = tempfile::tempdir().unwrap();
        let mut app = CoreApp::new(temp.path().join("app")).unwrap();
        let project = app
            .dispatch(
                "project.create",
                json!({"path":temp.path().join("project"),"name":"Wire","intent":"test"}),
                Origin::User,
                None,
            )
            .unwrap();
        let project_id = project["projectId"].as_str().unwrap();
        let draft = app
            .dispatch(
                "artifact.create_draft",
                json!({"type":"wiring","title":"Harness","payload":{"pins":[],"connections":[]}}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        let id = draft["artifact"]["id"].as_str().unwrap();
        let empty = app
            .dispatch(
                "wiring.validate",
                json!({"artifactId":id}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        assert_eq!(empty["findings"][0]["code"], "NO_CONNECTIONS");
        let revised=app.dispatch("wiring.set_pins",json!({"artifactId":id,"pins":[{"componentArtifactId":uuid::Uuid::new_v4().to_string(),"pin":"GND","type":"ground"}]}),Origin::User,Some(project_id)).unwrap();
        assert_eq!(revised["seq"], 2);
        let history = app
            .dispatch(
                "artifact.history",
                json!({"artifactId":id}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        assert_eq!(history["revisions"].as_array().unwrap().len(), 2);
        let view = app
            .dispatch(
                "wiring.render",
                json!({"artifactId":id}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        assert!(view["diagramSvg"].as_str().unwrap().starts_with("<svg"));
    }
}
