use super::*;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn add_candidate(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    if input["manufacturer"].as_str().is_none() && input["vendor"].as_str().is_none() {
        return Err(ContractError::new(
            "MISSING_SOURCE",
            "Component needs a manufacturer or vendor",
        ));
    }
    if input["sourceId"].is_null()
        && input["offer"]["url"].is_null()
        && input["offer"]["sourceId"].is_null()
    {
        return Err(ContractError::new(
            "MISSING_SOURCE",
            "Component needs a source (URL/datasheet capture)",
        ));
    }
    let mut body = serde_json::Map::new();
    for key in [
        "manufacturer",
        "vendor",
        "partNumber",
        "description",
        "properties",
        "attributes",
    ] {
        if !input[key].is_null() {
            body.insert(key.into(), input[key].clone());
        }
    }
    body.insert("status".into(), json!("candidate"));
    let missing = input["properties"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.iter())
        .filter(|(_, p)| p["quantity"]["unknown"] == true)
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    body.insert("missingFields".into(), json!(missing));
    let inputs = input["sourceId"]
        .as_str()
        .map(|id| {
            vec![json!({"artifactId":id,"relationship":"derived_from","label":"sourced from"})]
        })
        .unwrap_or_default();
    let draft = create_draft(
        handle,
        &json!({"type":"component","title":input["title"],"payload":body,"files":[],"inputs":inputs,"rationale":"component candidate"}),
        origin,
    )?;
    let artifact_id = required_str(&draft["artifact"], "id")?;
    if let Some(offer) = input.get("offer").filter(|v| !v.is_null()) {
        insert_offer(handle, artifact_id, offer)?;
    }
    if let Some(other) = input["alternativeTo"].as_str() {
        graph::propose_edges(
            handle,
            &json!({"edges":[{"upstreamArtifactId":artifact_id,"downstreamArtifactId":other,"relationship":"alternative_to","label":"alternative"}]}),
            origin.kind(),
        )?;
    }
    Ok(draft)
}

fn insert_offer(handle: &ProjectHandle, artifact_id: &str, input: &Value) -> CoreResult<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let observed_at = now();
    handle.db.execute("INSERT INTO offer(id,component_artifact_id,seller,url,price_amount,price_currency,quantity_basis,availability_text,observed_at,source_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![id,artifact_id,required_str(input,"seller")?,input["url"].as_str(),input["price"]["amount"].as_str(),input["price"]["currency"].as_str(),input["quantityBasis"].as_f64().unwrap_or(1.0),input["availabilityText"].as_str(),observed_at,input["sourceId"].as_str()]).map_err(internal)?;
    Ok(offer_by_id(handle, &id)?.unwrap())
}

pub(super) fn add_offer(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let id = required_str(input, "artifactId")?;
    let artifact = require_artifact(handle, id)?;
    if artifact["type"] != "component" {
        return Err(ContractError::validation(
            "Offers attach to component artifacts",
        ));
    }
    Ok(json!({"offer":insert_offer(handle,id,input)?}))
}

fn offer_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let amount: Option<String> = row.get("price_amount")?;
    let currency: Option<String> = row.get("price_currency")?;
    let mut offer = json!({"id":row.get::<_,String>("id")?,"seller":row.get::<_,String>("seller")?,"price":amount.zip(currency).map(|(amount,currency)|json!({"amount":amount,"currency":currency})),"quantityBasis":row.get::<_,f64>("quantity_basis")?,"observedAt":row.get::<_,String>("observed_at")?});
    for (column, key) in [
        ("url", "url"),
        ("availability_text", "availabilityText"),
        ("source_id", "sourceId"),
    ] {
        if let Some(value) = row.get::<_, Option<String>>(column)? {
            offer[key] = json!(value);
        }
    }
    Ok(offer)
}

fn offer_by_id(handle: &ProjectHandle, id: &str) -> CoreResult<Option<Value>> {
    handle
        .db
        .query_row("SELECT * FROM offer WHERE id=?1", [id], offer_from_row)
        .optional()
        .map_err(internal)
}

fn offers_for(handle: &ProjectHandle, id: &str) -> CoreResult<Vec<Value>> {
    let mut stmt = handle
        .db
        .prepare("SELECT * FROM offer WHERE component_artifact_id=?1 ORDER BY observed_at DESC")
        .map_err(internal)?;
    let offers = stmt
        .query_map([id], offer_from_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(offers)
}

pub(super) fn compare(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let mut rows = Vec::new();
    let mut criteria = BTreeSet::new();
    for id in input["artifactIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let artifact = require_artifact(handle, id)?;
        if artifact["type"] != "component" {
            return Err(ContractError::validation(format!(
                "{} is not a component",
                artifact["title"].as_str().unwrap_or(id)
            )));
        }
        let revision = if let Some(selected) = artifact["selectedRevisionId"].as_str() {
            get_revision(handle, selected)?
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
        };
        let body = revision
            .as_ref()
            .map(|r| r["payload"].clone())
            .unwrap_or(Value::Null);
        if let Some(props) = body["properties"].as_object() {
            criteria.extend(props.keys().cloned());
        }
        let stale: i64 = handle
            .db
            .query_row(
                "SELECT COUNT(*) FROM stale WHERE artifact_id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(internal)?;
        rows.push(json!({"artifact":artifact,"revision":revision,"payload":body,"offers":offers_for(handle,id)?,"freshness":if stale==0{"current"}else{"stale"}}));
    }
    let matrix=criteria.iter().map(|name|json!({"criterion":name,"values":rows.iter().map(|row|row["payload"]["properties"][name]["quantity"].clone()).collect::<Vec<_>>()})).collect::<Vec<_>>();
    Ok(json!({"components":rows,"matrix":matrix}))
}

pub(super) fn propose_selection(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let artifact_id = required_str(input, "artifactId")?;
    let artifact = require_artifact(handle, artifact_id)?;
    if artifact["type"] != "component" {
        return Err(ContractError::validation(
            "Selection target must be a component",
        ));
    }
    let revision = require_revision(handle, required_str(input, "revisionId")?)?;
    if revision["artifactId"] != artifact_id {
        return Err(ContractError::validation(
            "Revision does not belong to component",
        ));
    }
    let mut body = revision["payload"].clone();
    body["status"] = json!("selected");
    let draft = update_draft(
        handle,
        &json!({"artifactId":artifact_id,"payload":body,"rationale":format!("select {}",artifact["title"].as_str().unwrap_or("component"))}),
        origin,
    )?;
    let new_id = required_str(&draft["revision"], "id")?;
    let lines=input["bomLines"].as_array().into_iter().flatten().map(|line|json!({"componentArtifactId":artifact_id,"componentRevisionId":new_id,"subsystem":line["subsystem"],"quantity":line["quantity"],"offerId":line["offerId"],"location":line["location"],"notes":line["notes"]})).collect::<Vec<_>>();
    let proposal = proposal_submit(
        handle,
        &json!({"changes":[{"artifactId":artifact_id,"baseRevisionId":artifact["selectedRevisionId"],"newRevisionId":new_id,"kind":"component_selection","replacesArtifactId":input["replacesArtifactId"],"bomLines":lines}],"reason":input["reason"]}),
        origin,
    )?;
    Ok(json!({"proposal":proposal}))
}

fn bom_line_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":row.get::<_,String>("id")?,"componentArtifactId":row.get::<_,String>("component_artifact_id")?,"componentRevisionId":row.get::<_,String>("component_revision_id")?,"subsystem":row.get::<_,Option<String>>("subsystem")?,"quantity":row.get::<_,f64>("quantity")?,"offerId":row.get::<_,Option<String>>("offer_id")?,"location":row.get::<_,Option<String>>("location")?,"notes":row.get::<_,String>("notes")?}),
    )
}

pub(super) fn bom_read(handle: &ProjectHandle) -> CoreResult<Value> {
    let mut stmt = handle
        .db
        .prepare("SELECT * FROM bom_line ORDER BY subsystem,id")
        .map_err(internal)?;
    let lines = stmt
        .query_map([], bom_line_from_row)
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    let mut rows = Vec::new();
    let mut cost = BTreeMap::<String, f64>::new();
    let mut missing_price = 0;
    let mut known_mass: Option<(f64, String)> = None;
    let mut missing_mass = 0;
    for line in lines {
        let artifact_id = required_str(&line, "componentArtifactId")?;
        let artifact = require_artifact(handle, artifact_id)?;
        let revision = require_revision(handle, required_str(&line, "componentRevisionId")?)?;
        let body = &revision["payload"];
        let offer = line["offerId"]
            .as_str()
            .map(|id| offer_by_id(handle, id))
            .transpose()?
            .flatten();
        let mass = &body["properties"]["mass"]["quantity"];
        let mass = if mass["value"].is_number() {
            mass
        } else {
            &body["properties"]["weight"]["quantity"]
        };
        let unit_mass =
            if let (Some(value), Some(unit)) = (mass["value"].as_f64(), mass["unit"].as_str()) {
                Some(json!({"value":value,"unit":unit}))
            } else {
                None
            };
        let quantity = line["quantity"].as_f64().unwrap_or(0.0);
        let line_total = offer.as_ref().and_then(|offer| {
            let amount = offer["price"]["amount"].as_str()?.parse::<f64>().ok()?;
            let currency = offer["price"]["currency"].as_str()?;
            let basis = offer["quantityBasis"].as_f64().unwrap_or(1.0);
            Some(json!({"amount":format!("{:.2}",amount*quantity/basis),"currency":currency}))
        });
        if let Some(total) = &line_total {
            let currency = total["currency"].as_str().unwrap_or("");
            *cost.entry(currency.into()).or_default() += total["amount"]
                .as_str()
                .unwrap_or("0")
                .parse::<f64>()
                .unwrap_or(0.0);
        } else {
            missing_price += 1;
        }
        if let Some(unit_mass) = &unit_mass {
            let mass = unit_mass["value"].as_f64().unwrap_or(0.0) * quantity;
            let unit = unit_mass["unit"].as_str().unwrap_or("");
            match &mut known_mass {
                Some((sum, prior_unit)) if prior_unit == unit => *sum += mass,
                None => known_mass = Some((mass, unit.into())),
                _ => missing_mass += 1,
            }
        } else {
            missing_mass += 1;
        }
        rows.push(json!({"line":line,"componentTitle":artifact["title"],"partNumber":body["partNumber"],"manufacturer":body["manufacturer"].as_str().or(body["vendor"].as_str()).unwrap_or(""),"offer":offer,"unitMass":unit_mass,"lineMassKnown":unit_mass.is_some(),"lineTotal":line_total}));
    }
    let totals = json!({"cost":cost.iter().map(|(currency,amount)|json!({"amount":format!("{amount:.2}"),"currency":currency})).collect::<Vec<_>>(),"missingPriceCount":missing_price,"knownMass":known_mass.map(|(value,unit)|json!({"value":value,"unit":unit})),"missingMassCount":missing_mass,"lineCount":rows.len()});
    Ok(json!({"lines":rows,"totals":totals}))
}

pub(super) fn bom_propose_edit(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let mut lines = Vec::new();
    for line in input["lines"].as_array().into_iter().flatten() {
        let id = required_str(line, "componentArtifactId")?;
        let artifact = require_artifact(handle, id)?;
        let revision_id = line["componentRevisionId"]
            .as_str()
            .or(artifact["selectedRevisionId"].as_str())
            .ok_or_else(|| ContractError::validation("Component has no baseline revision"))?;
        let revision = require_revision(handle, revision_id)?;
        if revision["artifactId"] != id {
            return Err(ContractError::validation(
                "BOM line revision does not belong to component",
            ));
        }
        let mut item = line.clone();
        item["componentRevisionId"] = json!(revision_id);
        lines.push(item);
    }
    let anchor = lines
        .first()
        .ok_or_else(|| ContractError::validation("No BOM lines"))?;
    let artifact_id = required_str(anchor, "componentArtifactId")?;
    let artifact = require_artifact(handle, artifact_id)?;
    let revision = require_revision(handle, required_str(anchor, "componentRevisionId")?)?;
    let draft = update_draft(
        handle,
        &json!({"artifactId":artifact_id,"payload":revision["payload"],"rationale":input["reason"]}),
        origin,
    )?;
    let proposal = proposal_submit(
        handle,
        &json!({"changes":[{"artifactId":artifact_id,"baseRevisionId":artifact["selectedRevisionId"],"newRevisionId":draft["revision"]["id"],"kind":"bom_edit","bomLines":lines}],"reason":input["reason"]}),
        origin,
    )?;
    Ok(json!({"proposal":proposal}))
}

pub(super) fn bom_update_line(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let id = required_str(input, "lineId")?;
    let current = handle
        .db
        .query_row(
            "SELECT * FROM bom_line WHERE id=?1",
            [id],
            bom_line_from_row,
        )
        .optional()
        .map_err(internal)?;
    let Some(current) = current else {
        return Ok(json!({"ok":true}));
    };
    handle
        .db
        .execute(
            "UPDATE bom_line SET quantity=?1,offer_id=?2,location=?3,notes=?4 WHERE id=?5",
            params![
                input["quantity"]
                    .as_f64()
                    .unwrap_or(current["quantity"].as_f64().unwrap_or(1.0)),
                input.get("offerId").unwrap_or(&current["offerId"]).as_str(),
                input
                    .get("location")
                    .unwrap_or(&current["location"])
                    .as_str(),
                input["notes"].as_str().or(current["notes"].as_str()),
                id
            ],
        )
        .map_err(internal)?;
    emit(handle, "bom.changed", &Origin::User, json!({"lineId":id}))?;
    Ok(json!({"ok":true}))
}

pub(super) fn bom_remove_line(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let id = required_str(input, "lineId")?;
    handle
        .db
        .execute("DELETE FROM bom_line WHERE id=?1", [id])
        .map_err(internal)?;
    emit(handle, "bom.changed", &Origin::User, json!({"removed":id}))?;
    Ok(json!({"ok":true}))
}

pub(super) fn bom_export(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let bom = bom_read(handle)?;
    let lines = bom["lines"].as_array().unwrap();
    if input["format"] == "csv" {
        let mut rows = vec![
            "title,part_number,manufacturer,qty,unit_price,currency,seller,url,observed_at,notes"
                .to_owned(),
        ];
        let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        for row in lines {
            let offer = &row["offer"];
            rows.push(format!(
                "{},{},{},{},{},{},{},{},{},{}",
                quote(row["componentTitle"].as_str().unwrap_or("")),
                quote(row["partNumber"].as_str().unwrap_or("")),
                quote(row["manufacturer"].as_str().unwrap_or("")),
                row["line"]["quantity"],
                offer["price"]["amount"].as_str().unwrap_or(""),
                offer["price"]["currency"].as_str().unwrap_or(""),
                offer["seller"].as_str().unwrap_or(""),
                offer["url"].as_str().unwrap_or(""),
                offer["observedAt"].as_str().unwrap_or(""),
                quote(row["line"]["notes"].as_str().unwrap_or(""))
            ));
        }
        Ok(json!({"content":rows.join("\n")}))
    } else {
        let mut rows = vec![
            "# Bill of materials".to_owned(),
            String::new(),
            "| Part | Part no. | Manufacturer | Qty | Unit price | Mass | Notes |".into(),
            "| --- | --- | --- | --- | --- | --- | --- |".into(),
        ];
        for row in lines {
            let offer = &row["offer"];
            let price = offer["price"]["amount"]
                .as_str()
                .zip(offer["price"]["currency"].as_str())
                .map(|(a, c)| format!("{a} {c}"))
                .unwrap_or_else(|| "unknown".into());
            let mass = row["unitMass"]["value"]
                .as_f64()
                .zip(row["unitMass"]["unit"].as_str())
                .map(|(v, u)| {
                    format!(
                        "{} {u}",
                        v * row["line"]["quantity"].as_f64().unwrap_or(1.0)
                    )
                })
                .unwrap_or_else(|| "unknown".into());
            rows.push(format!(
                "| {} | {} | {} | {} | {} | {} | {} |",
                row["componentTitle"].as_str().unwrap_or(""),
                row["partNumber"].as_str().unwrap_or(""),
                row["manufacturer"].as_str().unwrap_or(""),
                row["line"]["quantity"],
                price,
                mass,
                row["line"]["notes"].as_str().unwrap_or("")
            ));
        }
        rows.push(String::new());
        let totals = &bom["totals"];
        let cost = totals["cost"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                format!(
                    "{} {}",
                    c["amount"].as_str().unwrap_or(""),
                    c["currency"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join(" + ");
        rows.push(format!(
            "Known subtotal: {} — {} line(s) missing price",
            if cost.is_empty() { "unknown" } else { &cost },
            totals["missingPriceCount"]
        ));
        rows.push(format!(
            "Known mass: {} — {} line(s) missing mass",
            if totals["knownMass"].is_null() {
                "unknown".into()
            } else {
                format!(
                    "{} {}",
                    totals["knownMass"]["value"],
                    totals["knownMass"]["unit"].as_str().unwrap_or("")
                )
            },
            totals["missingMassCount"]
        ));
        Ok(json!({"content":rows.join("\n")}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn component_selection_requires_human_approval_before_bom_changes() {
        let temp = tempfile::tempdir().unwrap();
        let mut app = CoreApp::new(temp.path().join("app")).unwrap();
        let project = app
            .dispatch(
                "project.create",
                json!({"path":temp.path().join("project"),"name":"Parts","intent":"test"}),
                Origin::User,
                None,
            )
            .unwrap();
        let project_id = project["projectId"].as_str().unwrap();
        let source = app.dispatch("source.capture",json!({"title":"Datasheet","url":"https://example.test/datasheet","sourceKind":"datasheet"}),Origin::User,Some(project_id)).unwrap();
        let component = app.dispatch("component.add_candidate",json!({"title":"Motor","manufacturer":"Acme","partNumber":"M1","sourceId":source["artifact"]["id"],"properties":{"mass":{"quantity":{"value":0.2,"unit":"kg"}}}}),Origin::Agent{session_id:uuid::Uuid::new_v4().to_string()},Some(project_id)).unwrap();
        let selected = app.dispatch("component.propose_selection",json!({"artifactId":component["artifact"]["id"],"revisionId":component["revision"]["id"],"bomLines":[{"quantity":2}],"reason":"Choose motor"}),Origin::Agent{session_id:uuid::Uuid::new_v4().to_string()},Some(project_id)).unwrap();
        assert_eq!(
            app.dispatch("bom.read", json!({}), Origin::User, Some(project_id))
                .unwrap()["totals"]["lineCount"],
            0
        );
        let proposal_id = selected["proposal"]["id"].as_str().unwrap();
        let accepted = app
            .dispatch(
                "proposal.approve",
                json!({"proposalId":proposal_id,"rationale":"Reviewed datasheet"}),
                Origin::User,
                Some(project_id),
            )
            .unwrap();
        assert_eq!(accepted["state"], "accepted");
        let bom = app
            .dispatch("bom.read", json!({}), Origin::User, Some(project_id))
            .unwrap();
        assert_eq!(bom["totals"]["lineCount"], 1);
        assert_eq!(bom["lines"][0]["componentTitle"], "Motor");
        assert_eq!(bom["lines"][0]["line"]["quantity"], 2.0);
    }
}
