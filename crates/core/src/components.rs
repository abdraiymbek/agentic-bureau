//! Purchasable parts: sourced candidates, seller offers, selection through a
//! reviewable proposal, and the bill of materials. A value that is unknown,
//! in an unknown unit or of the wrong quantity is left out of a total and
//! counted with its reason; it is never added as zero.
use super::*;
use units::Reading;

/// One problem with a named input field, in the shape validation errors use.
fn issue(path: impl Into<String>, message: impl Into<String>) -> Value {
    json!({"path": path.into(), "message": message.into()})
}

fn component(handle: &ProjectHandle, id: &str, path: &str) -> CoreResult<Value> {
    let artifact = require_artifact(handle, id)?;
    if artifact["type"] != "component" {
        return Err(ContractError::validation(format!(
            "{} is a {} artifact, not a component",
            artifact["title"].as_str().unwrap_or(id),
            artifact["type"].as_str().unwrap_or("different")
        ))
        .with_repair(
            "Pass the id of a component artifact; artifact_list with type component lists them.",
        )
        .with_details(json!({"issues": [issue(path, "must be the id of a component artifact")]})));
    }
    Ok(artifact)
}

/// The revision a caller means when it names none: the newest working draft,
/// else the approved one.
fn working_revision(handle: &ProjectHandle, artifact: &Value) -> CoreResult<Value> {
    let id = required_str(artifact, "id")?;
    let draft = handle
        .db
        .query_row(
            "SELECT * FROM revision WHERE artifact_id=?1 AND review_state IN ('draft','proposed') ORDER BY seq DESC LIMIT 1",
            [id],
            revision_from_row,
        )
        .optional()
        .map_err(internal)?;
    match (draft, artifact["selectedRevisionId"].as_str()) {
        (Some(draft), _) => Ok(draft),
        (None, Some(selected)) => require_revision(handle, selected),
        (None, None) => Err(ContractError::validation(format!(
            "{} has no revision to select",
            artifact["title"].as_str().unwrap_or(id)
        ))),
    }
}

pub(super) fn add_candidate(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let filled = |value: &Value| value.as_str().is_some_and(|text| !text.trim().is_empty());
    if !filled(&input["manufacturer"]) && !filled(&input["vendor"]) {
        return Err(ContractError::new(
            "MISSING_SOURCE",
            "Component needs a manufacturer or vendor",
        )
        .with_repair("Add manufacturer (who makes the part) or vendor (the brand it is sold under), as shown on the product page.")
        .with_details(json!({"issues": [
            issue("manufacturer", "give this or vendor"),
            issue("vendor", "give this or manufacturer"),
        ]})));
    }
    let offer = input.get("offer").filter(|offer| offer.is_object());
    let offer_field = |key: &str| offer.is_some_and(|offer| filled(&offer[key]));
    if !filled(&input["sourceId"])
        && !input["source"].is_object()
        && !offer_field("url")
        && !offer_field("sourceId")
    {
        return Err(ContractError::new(
            "MISSING_SOURCE",
            "Component needs a source (URL/datasheet capture)",
        )
        .with_repair("Say where the part was observed: add source {url, title, excerpt} for the page you read, or offer.url for the product page, or sourceId from source_capture.")
        .with_details(json!({"issues": [
            issue("source", "give the page the facts came from, or one of the fields below"),
            issue("offer.url", "address of the exact product page"),
            issue("sourceId", "id of a source artifact from source_capture"),
        ]})));
    }
    // Check every reference and unit before anything is written, so a
    // mistake in one field does not leave a source or a candidate behind.
    let mut facts = serde_json::Map::new();
    for key in ["properties", "attributes"] {
        if !input[key].is_null() {
            facts.insert(key.into(), input[key].clone());
        }
    }
    let notes = if matches!(origin, Origin::Agent { .. }) {
        let mut checked = Value::Object(facts);
        let notes = units::check_authored(&mut checked, "")?;
        facts = checked.as_object().cloned().unwrap_or_default();
        notes
    } else {
        Vec::new()
    };
    if let Some(id) = input["sourceId"].as_str() {
        let source = require_artifact(handle, id)?;
        if source["type"] != "source" {
            return Err(ContractError::validation(format!(
                "sourceId names {}, which is a {} artifact, not a source",
                source["title"].as_str().unwrap_or(id),
                source["type"].as_str().unwrap_or("different")
            ))
            .with_repair("Pass the id returned by source_capture, or give source {url, title, excerpt} instead.")
            .with_details(json!({"issues": [issue("sourceId", "must be the id of a source artifact")]})));
        }
    }
    if let Some(other) = input["alternativeTo"].as_str() {
        component(handle, other, "alternativeTo")?;
    }
    let captured = if input["sourceId"].is_null() && input["source"].is_object() {
        Some(simple::source_capture(handle, &input["source"], origin)?)
    } else {
        None
    };
    let source_id = input["sourceId"].as_str().or_else(|| {
        captured
            .as_ref()
            .and_then(|source| source["artifact"]["id"].as_str())
    });
    let mut body = serde_json::Map::new();
    for key in [
        "manufacturer",
        "vendor",
        "partNumber",
        "description",
        "imageUrl",
        "selectionReason",
    ] {
        if !input[key].is_null() {
            body.insert(key.into(), input[key].clone());
        }
    }
    body.insert("status".into(), json!("candidate"));
    body.extend(facts);
    let mut body = Value::Object(body);
    let missing = input["properties"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.iter())
        .filter(|(_, p)| p["quantity"]["unknown"] == true)
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    body["missingFields"] = json!(missing);
    let inputs = source_id
        .map(|id| {
            vec![json!({"artifactId":id,"relationship":"derived_from","label":"sourced from"})]
        })
        .unwrap_or_default();
    let mut draft = create_draft(
        handle,
        &json!({"type":"component","title":input["title"],"payload":body,"files":[],"inputs":inputs,"rationale":"component candidate"}),
        origin,
    )?;
    let artifact_id = required_str(&draft["artifact"], "id")?.to_owned();
    let saved = offer
        .map(|offer| {
            let mut offer = offer.clone();
            // An offer read on the captured page cites that page.
            let same_page = captured
                .as_ref()
                .is_some_and(|source| source["revision"]["payload"]["url"] == offer["url"]);
            if offer["sourceId"].is_null() && same_page {
                offer["sourceId"] = json!(source_id);
            }
            insert_offer(handle, &artifact_id, &offer)
        })
        .transpose()?;
    if let Some(other) = input["alternativeTo"].as_str() {
        graph::propose_edges(
            handle,
            &json!({"edges":[{"upstreamArtifactId":artifact_id,"downstreamArtifactId":other,"relationship":"alternative_to","label":"alternative"}]}),
            origin.kind(),
        )?;
    }
    draft["offer"] = saved.unwrap_or(Value::Null);
    if let Some(source) = captured {
        draft["source"] = source;
    }
    if !notes.is_empty() {
        draft["notes"] = json!(notes);
    }
    Ok(draft)
}

fn insert_offer(handle: &ProjectHandle, artifact_id: &str, input: &Value) -> CoreResult<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let observed_at = now();
    handle.db.execute("INSERT INTO offer(id,component_artifact_id,seller,url,price_amount,price_currency,quantity_basis,availability_text,observed_at,source_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![id,artifact_id,required_str(input,"seller")?,input["url"].as_str(),input["price"]["amount"].as_str(),input["price"]["currency"].as_str(),input["quantityBasis"].as_f64().unwrap_or(1.0),input["availabilityText"].as_str(),observed_at,input["sourceId"].as_str()]).map_err(internal)?;
    offer_by_id(handle, &id)?.ok_or_else(|| internal("Offer was not saved"))
}

pub(super) fn add_offer(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let id = required_str(input, "artifactId")?;
    let artifact = require_artifact(handle, id)?;
    if artifact["type"] != "component" {
        return Err(
            ContractError::validation("Offers attach to component artifacts")
                .with_repair("Pass the id of the component the offer is for.")
                .with_details(json!({"issues": [issue("artifactId", "must be the id of a component artifact")]})),
        );
    }
    let offer = insert_offer(handle, id, input)?;
    emit(
        handle,
        "component.offer_added",
        origin,
        json!({"artifactId":id,"offerId":offer["id"]}),
    )?;
    Ok(json!({"offer":offer}))
}

fn offer_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let amount: Option<String> = row.get("price_amount")?;
    let currency: Option<String> = row.get("price_currency")?;
    let mut offer = json!({"id":row.get::<_,String>("id")?,"componentArtifactId":row.get::<_,String>("component_artifact_id")?,"seller":row.get::<_,String>("seller")?,"price":amount.zip(currency).map(|(amount,currency)|json!({"amount":amount,"currency":currency})),"quantityBasis":row.get::<_,f64>("quantity_basis")?,"observedAt":row.get::<_,String>("observed_at")?});
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

/// A BOM line may only buy from an offer recorded for its own component.
fn offer_of(
    handle: &ProjectHandle,
    artifact: &Value,
    offer_id: &str,
    path: &str,
) -> CoreResult<()> {
    let artifact_id = required_str(artifact, "id")?;
    if offer_by_id(handle, offer_id)?
        .is_some_and(|offer| offer["componentArtifactId"] == artifact_id)
    {
        return Ok(());
    }
    let known = offers_for(handle, artifact_id)?
        .iter()
        .map(|offer| {
            format!(
                "{} ({})",
                offer["id"].as_str().unwrap_or(""),
                offer["seller"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>();
    let title = artifact["title"].as_str().unwrap_or(artifact_id);
    let repair = if known.is_empty() {
        format!("{title} has no offer yet: add one with component_add_offer, or leave offerId out.")
    } else {
        format!("Use one of the offers of {title}: {}.", known.join(", "))
    };
    Err(
        ContractError::validation(format!("Offer {offer_id} does not belong to {title}"))
            .with_repair(repair)
            .with_details(json!({"issues": [issue(path, "must be an offer of this component")]})),
    )
}

pub(super) fn compare(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let mut rows = Vec::new();
    // Criteria in the order they were first written, as the candidates list them.
    let mut criteria = Vec::<String>::new();
    for (index, id) in input["artifactIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .enumerate()
    {
        let artifact = component(handle, id, &format!("artifactIds[{index}]"))?;
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
        for name in body["properties"]
            .as_object()
            .into_iter()
            .flat_map(|p| p.keys())
        {
            if !criteria.contains(name) {
                criteria.push(name.clone());
            }
        }
        let freshness = artifact_view(handle, &artifact)?["freshness"].clone();
        rows.push(json!({"artifact":artifact,"revision":revision,"payload":body,"offers":offers_for(handle,id)?,"freshness":freshness}));
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
    let artifact = component(handle, artifact_id, "artifactId")?;
    let revision = match input["revisionId"].as_str() {
        Some(id) => require_revision(handle, id)?,
        None => working_revision(handle, &artifact)?,
    };
    if revision["artifactId"] != artifact_id {
        return Err(
            ContractError::validation("Revision does not belong to component")
                .with_repair("Leave revisionId out to select the newest draft of the component, or pass one of its own revision ids.")
                .with_details(json!({"issues": [issue("revisionId", "must be a revision of artifactId")]})),
        );
    }
    let offers = offers_for(handle, artifact_id)?;
    let mut notes = Vec::new();
    let mut lines = Vec::new();
    for (index, line) in input["bomLines"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let offer_id = match line["offerId"].as_str() {
            Some(id) => {
                offer_of(handle, &artifact, id, &format!("bomLines[{index}].offerId"))?;
                json!(id)
            }
            None => match offers.as_slice() {
                [only] => {
                    notes.push(format!(
                        "BOM line {} buys from the only recorded offer, {} ({}).",
                        index + 1,
                        only["seller"].as_str().unwrap_or("unnamed seller"),
                        only["id"].as_str().unwrap_or("")
                    ));
                    only["id"].clone()
                }
                [] => {
                    notes.push(format!(
                        "BOM line {} has no offer: its price stays unknown until one is recorded with component_add_offer.",
                        index + 1
                    ));
                    Value::Null
                }
                several => {
                    notes.push(format!(
                        "BOM line {} names no offer and the component has {}: its price stays unknown until offerId names one.",
                        index + 1,
                        several.len()
                    ));
                    Value::Null
                }
            },
        };
        lines.push(json!({"componentArtifactId":artifact_id,"subsystem":line["subsystem"],"quantity":line["quantity"],"offerId":offer_id,"location":line["location"],"notes":line["notes"]}));
    }
    let mut change = json!({"artifactId":artifact_id,"baseRevisionId":artifact["selectedRevisionId"],"kind":"component_selection"});
    if let Some(replaced_id) = input["replacesArtifactId"].as_str() {
        let replaced = component(handle, replaced_id, "replacesArtifactId")?;
        if replaced_id == artifact_id {
            return Err(
                ContractError::validation("A component cannot replace itself")
                    .with_repair("Leave replacesArtifactId out, or name the component this one takes the place of.")
                    .with_details(json!({"issues": [issue("replacesArtifactId", "must be a different component")]})),
            );
        }
        // The replaced part leaves the bill of materials with the same decision.
        let removed = line_ids_of(handle, replaced_id)?;
        if !removed.is_empty() {
            notes.push(format!(
                "Approval removes {} BOM line(s) of {}.",
                removed.len(),
                replaced["title"].as_str().unwrap_or(replaced_id)
            ));
            change["removeBomLineIds"] = json!(removed);
        }
        change["replacesArtifactId"] = json!(replaced_id);
    }
    let mut body = revision["payload"].clone();
    body["status"] = json!("selected");
    let draft = update_draft(
        handle,
        &json!({"artifactId":artifact_id,"draftRevisionId":revision["id"],"payload":body,"inputs":revision["inputs"],"rationale":format!("select {}",artifact["title"].as_str().unwrap_or("component"))}),
        origin,
    )?;
    let new_id = required_str(&draft["revision"], "id")?;
    for line in &mut lines {
        line["componentRevisionId"] = json!(new_id);
    }
    change["newRevisionId"] = json!(new_id);
    change["bomLines"] = json!(lines);
    let proposal = proposal_submit(
        handle,
        &json!({"changes":[change],"reason":input["reason"]}),
        origin,
    )?;
    Ok(json!({"proposal":proposal,"notes":notes}))
}

fn bom_line_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":row.get::<_,String>("id")?,"componentArtifactId":row.get::<_,String>("component_artifact_id")?,"componentRevisionId":row.get::<_,String>("component_revision_id")?,"subsystem":row.get::<_,Option<String>>("subsystem")?,"quantity":row.get::<_,f64>("quantity")?,"offerId":row.get::<_,Option<String>>("offer_id")?,"location":row.get::<_,Option<String>>("location")?,"notes":row.get::<_,String>("notes")?}),
    )
}

fn bom_line(handle: &ProjectHandle, id: &str) -> CoreResult<Option<Value>> {
    handle
        .db
        .query_row(
            "SELECT * FROM bom_line WHERE id=?1",
            [id],
            bom_line_from_row,
        )
        .optional()
        .map_err(internal)
}

fn line_ids_of(handle: &ProjectHandle, component_id: &str) -> CoreResult<Vec<String>> {
    let mut stmt = handle
        .db
        .prepare("SELECT id FROM bom_line WHERE component_artifact_id=?1 ORDER BY subsystem,id")
        .map_err(internal)?;
    let ids = stmt
        .query_map([component_id], |row| row.get::<_, String>(0))
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    Ok(ids)
}

/// Mass of one unit of a component, from `mass` or else `weight`. A value in
/// a unit that is not a mass is unknown, with the reason.
fn unit_mass(properties: &Value) -> Result<(Value, f64, units::Unit), String> {
    let mut reason = None;
    for name in ["mass", "weight"] {
        let quantity = &properties[name]["quantity"];
        if properties[name].is_null() {
            continue;
        }
        match units::read(quantity) {
            Reading::Known { value, unit } if unit.quantity == Some("mass") => {
                return Ok((quantity.clone(), value, unit));
            }
            Reading::Known { unit, .. } => {
                reason.get_or_insert(format!(
                    "{name} is recorded in {} ({}), not a unit of mass",
                    unit.name,
                    unit.measures()
                ));
            }
            Reading::Unknown { reason: why } => {
                reason.get_or_insert(format!("{name}: {why}"));
            }
        }
    }
    Err(reason.unwrap_or_else(|| "no mass recorded".into()))
}

/// Money as a decimal string: two decimals, or four when two would show a
/// price that is not zero as 0.00.
fn money(amount: f64) -> String {
    let cents = format!("{amount:.2}");
    if amount != 0.0 && cents.trim_start_matches('-') == "0.00" {
        format!("{amount:.4}")
    } else {
        cents
    }
}

fn decimals(amount: &str) -> usize {
    amount
        .split_once('.')
        .map_or(0, |(_, fraction)| fraction.len())
}

/// Price of a line: the offer price scaled by quantity over the pack size.
fn line_total(offer: Option<&Value>, line: &Value, quantity: f64) -> Result<Value, String> {
    let Some(offer) = offer else {
        return Err(if line["offerId"].is_null() {
            "no offer chosen for this line".into()
        } else {
            "the chosen offer no longer exists".into()
        });
    };
    let (Some(amount), Some(currency)) = (
        offer["price"]["amount"].as_str(),
        offer["price"]["currency"].as_str(),
    ) else {
        return Err("the offer records no price".into());
    };
    let amount = amount
        .parse::<f64>()
        .map_err(|_| format!("the offer price '{amount}' is not a number"))?;
    let basis = offer["quantityBasis"].as_f64().filter(|basis| *basis > 0.0);
    let basis = basis.ok_or("the offer has no pack size")?;
    Ok(json!({"amount": money(amount * quantity / basis), "currency": currency}))
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
    let mut replaced = Vec::new();
    // Per currency, in the order first seen: the sum and the decimals shown.
    let mut cost = Vec::<(String, f64, usize)>::new();
    let mut unknown_cost = Vec::new();
    let mut known_mass: Option<(f64, units::Unit)> = None;
    let mut unknown_mass = Vec::new();
    for line in lines {
        let artifact_id = required_str(&line, "componentArtifactId")?;
        let artifact = handle
            .db
            .query_row(
                "SELECT * FROM artifact WHERE id=?1",
                [artifact_id],
                artifact_from_row,
            )
            .optional()
            .map_err(internal)?;
        let revision = get_revision(handle, required_str(&line, "componentRevisionId")?)?;
        let title = artifact
            .as_ref()
            .map_or(json!(artifact_id), |artifact| artifact["title"].clone());
        let body = revision
            .as_ref()
            .map_or(Value::Null, |revision| revision["payload"].clone());
        let offer = line["offerId"]
            .as_str()
            .map(|id| offer_by_id(handle, id))
            .transpose()?
            .flatten();
        let quantity = line["quantity"].as_f64().unwrap_or(0.0);
        let mass = unit_mass(&body["properties"]);
        let total = line_total(offer.as_ref(), &line, quantity);
        let mut row = json!({"line":line,"componentTitle":title,"partNumber":body["partNumber"],
            "manufacturer":body["manufacturer"].as_str().or(body["vendor"].as_str()).unwrap_or(""),
            "imageUrl":body["imageUrl"],"selectionReason":body["selectionReason"],"description":body["description"],
            "offer":offer,
            "unitMass":mass.as_ref().map_or(Value::Null, |(quantity, _, _)| quantity.clone()),
            "lineMassKnown":mass.is_ok(),
            "lineTotal":total.as_ref().map_or(Value::Null, Value::clone),
            "componentRevisionCurrent":artifact.as_ref().is_some_and(|artifact| artifact["selectedRevisionId"] == line["componentRevisionId"])});
        if let Err(reason) = &mass {
            row["massUnknownReason"] = json!(reason);
        }
        if let Err(reason) = &total {
            row["priceUnknownReason"] = json!(reason);
        }
        // A replaced or archived component is no longer part of the build:
        // its lines are reported apart and add nothing to the totals.
        if artifact
            .as_ref()
            .is_some_and(|artifact| artifact["archived"] == true)
        {
            row["reason"] = json!("component archived or replaced");
            replaced.push(row);
            continue;
        }
        let unknown = |reason: &String| json!({"lineId": line["id"], "componentTitle": title, "reason": reason});
        match &total {
            Ok(total) => {
                let currency = total["currency"].as_str().unwrap_or("");
                let amount = total["amount"].as_str().unwrap_or("0");
                let value = amount.parse::<f64>().unwrap_or(0.0);
                match cost.iter_mut().find(|(known, _, _)| known == currency) {
                    Some((_, sum, shown)) => {
                        *sum += value;
                        *shown = (*shown).max(decimals(amount));
                    }
                    None => cost.push((currency.to_owned(), value, decimals(amount))),
                }
            }
            Err(reason) => unknown_cost.push(unknown(reason)),
        }
        match &mass {
            Ok((_, value, unit)) => {
                let line_mass = value * quantity;
                known_mass = Some(match known_mass.take() {
                    // The total is kept in the unit of the first known line.
                    Some((sum, first)) if first.name == unit.name => (sum + line_mass, first),
                    Some((sum, first)) => (sum + units::convert(line_mass, unit, &first)?, first),
                    None => (line_mass, unit.clone()),
                });
            }
            Err(reason) => unknown_mass.push(unknown(reason)),
        }
        rows.push(row);
    }
    let totals = json!({
        "cost":cost.iter().map(|(currency,amount,shown)|json!({"amount":format!("{amount:.shown$}"),"currency":currency})).collect::<Vec<_>>(),
        "missingPriceCount":unknown_cost.len(),"unknownCost":unknown_cost,
        "knownMass":known_mass.map(|(value,unit)|json!({"value":value,"unit":unit.name})),
        "missingMassCount":unknown_mass.len(),"unknownMass":unknown_mass,
        "lineCount":rows.len(),"replacedLineCount":replaced.len()});
    Ok(json!({"lines":rows,"replacedLines":replaced,"totals":totals}))
}

pub(super) fn bom_propose_edit(
    handle: &mut ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let mut lines = Vec::new();
    for (index, line) in input["lines"].as_array().into_iter().flatten().enumerate() {
        let path = format!("lines[{index}]");
        let id = required_str(line, "componentArtifactId")?;
        let artifact = component(handle, id, &format!("{path}.componentArtifactId"))?;
        let title = artifact["title"].as_str().unwrap_or(id);
        let revision_id = line["componentRevisionId"]
            .as_str()
            .or(artifact["selectedRevisionId"].as_str())
            .ok_or_else(|| {
                ContractError::validation(format!("{title} has no approved revision"))
                    .with_repair("A BOM line needs an approved component. Use component_propose_selection to select it; that proposal carries its BOM lines.")
                    .with_details(json!({"issues": [issue(format!("{path}.componentArtifactId"), "component has no approved revision")]}))
            })?;
        let revision = require_revision(handle, revision_id)?;
        if revision["artifactId"] != id {
            return Err(ContractError::validation(
                "BOM line revision does not belong to component",
            )
            .with_repair("Leave componentRevisionId out to use the approved revision of the component.")
            .with_details(json!({"issues": [issue(format!("{path}.componentRevisionId"), "must be a revision of componentArtifactId")]})));
        }
        if let Some(offer_id) = line["offerId"].as_str() {
            offer_of(handle, &artifact, offer_id, &format!("{path}.offerId"))?;
        }
        let mut item = line.clone();
        item["componentRevisionId"] = json!(revision_id);
        lines.push(item);
    }
    let mut removed = Vec::new();
    let mut first_removed = None;
    for (index, id) in input["removeLineIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .enumerate()
    {
        let line = bom_line(handle, id)?.ok_or_else(|| {
            ContractError::new("NOT_FOUND", format!("BOM line not found: {id}"))
                .with_repair("Call bom_read for the current line ids.")
                .with_details(json!({"issues": [issue(format!("removeLineIds[{index}]"), "no BOM line has this id")]}))
        })?;
        first_removed.get_or_insert(line);
        removed.push(id);
    }
    // A proposal changes an artifact, so the edit is carried by the component
    // of its first line.
    let artifact_id = lines
        .first()
        .or(first_removed.as_ref())
        .map(|line| required_str(line, "componentArtifactId"))
        .transpose()?
        .ok_or_else(|| {
            ContractError::validation("A BOM edit needs a line to add or a line to remove")
                .with_repair("Give lines with at least one {componentArtifactId, quantity}, or removeLineIds with line ids from bom_read.")
                .with_details(json!({"issues": [issue("lines", "empty"), issue("removeLineIds", "empty")]}))
        })?
        .to_owned();
    let artifact = require_artifact(handle, &artifact_id)?;
    let selected = artifact["selectedRevisionId"].as_str().ok_or_else(|| {
        ContractError::validation(format!(
            "{} has no approved revision",
            artifact["title"].as_str().unwrap_or(&artifact_id)
        ))
    })?;
    let baseline = require_revision(handle, selected)?;
    // The copy only carries the edit: approval applies the lines and keeps
    // the component's baseline, so the lines stay pinned to it.
    let draft = update_draft(
        handle,
        &json!({"artifactId":artifact_id,"baseRevisionId":selected,"payload":baseline["payload"],"rationale":input["reason"]}),
        origin,
    )?;
    let mut change = json!({"artifactId":artifact_id,"baseRevisionId":selected,"newRevisionId":draft["revision"]["id"],"kind":"bom_edit","bomLines":lines});
    if !removed.is_empty() {
        change["removeBomLineIds"] = json!(removed);
    }
    let proposal = proposal_submit(
        handle,
        &json!({"changes":[change],"reason":input["reason"]}),
        origin,
    )?;
    Ok(json!({"proposal":proposal}))
}

fn line_not_found(id: &str) -> ContractError {
    ContractError::new("NOT_FOUND", format!("BOM line not found: {id}"))
        .with_repair("The line may have been removed. Read the bill of materials again.")
        .with_details(json!({"issues": [issue("lineId", "no BOM line has this id")]}))
}

pub(super) fn bom_update_line(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let id = required_str(input, "lineId")?;
    let current = bom_line(handle, id)?.ok_or_else(|| line_not_found(id))?;
    if let Some(offer_id) = input["offerId"].as_str() {
        let artifact = require_artifact(handle, required_str(&current, "componentArtifactId")?)?;
        offer_of(handle, &artifact, offer_id, "offerId")?;
    }
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
    let removed = handle
        .db
        .execute("DELETE FROM bom_line WHERE id=?1", [id])
        .map_err(internal)?;
    if removed == 0 {
        return Err(line_not_found(id));
    }
    emit(handle, "bom.changed", &Origin::User, json!({"removed":id}))?;
    Ok(json!({"ok":true}))
}

fn csv_cell(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// Text inside a Markdown table cell: a pipe or a line break would end it.
fn table_cell(text: &str) -> String {
    text.replace('|', "\\|").replace(['\r', '\n'], " ")
}

fn unit_price(row: &Value) -> Option<Value> {
    let offer = row["offer"].is_object().then_some(&row["offer"]);
    line_total(offer, &row["line"], 1.0).ok()
}

fn bom_csv(bom: &Value) -> String {
    let mut rows = vec![
        "title,part_number,manufacturer,qty,unit_price,currency,seller,url,observed_at,notes,offer_price,quantity_basis,line_total,price_unknown_reason,mass_unknown_reason"
            .to_owned(),
    ];
    for row in bom["lines"].as_array().into_iter().flatten() {
        let offer = &row["offer"];
        let unit_price = unit_price(row);
        let text = |value: &Value| csv_cell(value.as_str().unwrap_or(""));
        rows.push(
            [
                text(&row["componentTitle"]),
                text(&row["partNumber"]),
                text(&row["manufacturer"]),
                units::format_number(row["line"]["quantity"].as_f64().unwrap_or(0.0)),
                unit_price
                    .as_ref()
                    .and_then(|price| price["amount"].as_str())
                    .unwrap_or("")
                    .to_owned(),
                offer["price"]["currency"].as_str().unwrap_or("").to_owned(),
                text(&offer["seller"]),
                text(&offer["url"]),
                offer["observedAt"].as_str().unwrap_or("").to_owned(),
                text(&row["line"]["notes"]),
                text(&offer["price"]["amount"]),
                offer["quantityBasis"]
                    .as_f64()
                    .map(units::format_number)
                    .unwrap_or_default(),
                row["lineTotal"]["amount"].as_str().unwrap_or("").to_owned(),
                text(&row["priceUnknownReason"]),
                text(&row["massUnknownReason"]),
            ]
            .join(","),
        );
    }
    rows.join("\n")
}

fn bom_markdown(bom: &Value) -> String {
    let mut rows = vec![
        "# Bill of materials".to_owned(),
        String::new(),
        "| Part | Part no. | Manufacturer | Qty | Unit price | Offer price / basis | Line total | Mass | Notes |".into(),
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |".into(),
    ];
    for row in bom["lines"].as_array().into_iter().flatten() {
        let offer = &row["offer"];
        let quantity = row["line"]["quantity"].as_f64().unwrap_or(0.0);
        let unknown = |field: &str| {
            row[field]
                .as_str()
                .map(|reason| format!("unknown ({})", table_cell(reason)))
                .unwrap_or_else(|| "unknown".into())
        };
        let money_text = |price: &Value| {
            price["amount"]
                .as_str()
                .zip(price["currency"].as_str())
                .map(|(amount, currency)| table_cell(&format!("{amount} {currency}")))
        };
        let price = unit_price(row)
            .as_ref()
            .and_then(money_text)
            .unwrap_or_else(|| unknown("priceUnknownReason"));
        let offer_price = money_text(&offer["price"])
            .zip(offer["quantityBasis"].as_f64().filter(|basis| *basis > 0.0))
            .map(|(price, basis)| format!("{price} / {} unit(s)", units::format_number(basis)))
            .unwrap_or_else(|| unknown("priceUnknownReason"));
        let total = money_text(&row["lineTotal"]).unwrap_or_else(|| unknown("priceUnknownReason"));
        // A price is evidence of one day: the date it was observed goes with it.
        let observed = offer["observedAt"]
            .as_str()
            .map(|at| format!(" (observed {})", at.get(..10).unwrap_or(at)))
            .unwrap_or_default();
        let mass = row["unitMass"]["value"]
            .as_f64()
            .zip(row["unitMass"]["unit"].as_str())
            .map(|(value, unit)| units::format_quantity(value * quantity, unit))
            .unwrap_or_else(|| unknown("massUnknownReason"));
        let text = |value: &Value| table_cell(value.as_str().unwrap_or(""));
        rows.push(format!(
            "| {} | {} | {} | {} | {price} | {offer_price}{observed} | {total} | {mass} | {} |",
            text(&row["componentTitle"]),
            text(&row["partNumber"]),
            text(&row["manufacturer"]),
            units::format_number(quantity),
            text(&row["line"]["notes"])
        ));
    }
    rows.push(String::new());
    let totals = &bom["totals"];
    let cost = totals["cost"]
        .as_array()
        .into_iter()
        .flatten()
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
    let mass = totals["knownMass"]["value"]
        .as_f64()
        .zip(totals["knownMass"]["unit"].as_str())
        .map(|(value, unit)| units::format_quantity(value, unit))
        .unwrap_or_else(|| "unknown".into());
    rows.push(format!(
        "Known mass: {mass} — {} line(s) missing mass",
        totals["missingMassCount"]
    ));
    let replaced = totals["replacedLineCount"].as_u64().unwrap_or(0);
    if replaced > 0 {
        rows.push(format!(
            "Not included: {replaced} line(s) of archived or replaced components"
        ));
    }
    rows.join("\n")
}

/// The bill of materials as text: `csv`, or Markdown for any other format.
pub(super) fn bom_text(handle: &ProjectHandle, format: &str) -> CoreResult<String> {
    let bom = bom_read(handle)?;
    Ok(if format == "csv" {
        bom_csv(&bom)
    } else {
        bom_markdown(&bom)
    })
}

pub(super) fn bom_export(
    handle: &ProjectHandle,
    input: &Value,
    origin: &Origin,
) -> CoreResult<Value> {
    let content = bom_text(handle, input["format"].as_str().unwrap_or("markdown"))?;
    let mut result = json!({"content": content});
    if let Some(destination) = input["destPath"].as_str() {
        result["path"] = json!(write_export(handle, destination, &content, origin)?);
    }
    Ok(result)
}

/// Where an export may be written: `Some(path relative to the project)`, or
/// `None` for a path outside it that a person chose. A person may choose any
/// path; an agent writes inside the project only. Every export operation
/// decides its destination here.
pub(super) fn export_target(
    handle: &ProjectHandle,
    destination: &str,
    origin: &Origin,
    example: &str,
) -> CoreResult<Option<String>> {
    let path = Path::new(destination);
    if !path.is_absolute() {
        return Ok(Some(destination.to_owned()));
    }
    if !matches!(origin, Origin::Agent { .. }) {
        return Ok(None);
    }
    let relative = path.strip_prefix(&handle.root).map_err(|_| {
        ContractError::new(
            "PATH_OUTSIDE_PROJECT",
            "An agent can write an export only inside the project",
        )
        .with_repair(format!(
            "Give destPath relative to the project, for example {example}."
        ))
        .with_details(json!({"issues": [issue("destPath", "must be inside the project")]}))
    })?;
    Ok(Some(relative.to_string_lossy().into_owned()))
}

/// Write an export where the caller asked, within what `export_target` allows.
fn write_export(
    handle: &ProjectHandle,
    destination: &str,
    content: &str,
    origin: &Origin,
) -> CoreResult<PathBuf> {
    if let Some(relative) = export_target(handle, destination, origin, "exports/bom.csv")? {
        write_materialized_file(&handle.root, &relative, content.as_bytes())
            .map_err(storage_error)?;
        return resolve_materialization_path(&handle.root, &relative).map_err(storage_error);
    }
    let dest = PathBuf::from(destination);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(internal)?;
    }
    let temp = dest.with_extension(format!("omenflow-{}.tmp", uuid::Uuid::new_v4()));
    let written = fs::write(&temp, content).and_then(|()| fs::rename(&temp, &dest));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written.map_err(internal)?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Bench;

    fn kg(value: f64) -> Value {
        json!({"value": value, "unit": "kg"})
    }

    /// Select a candidate with one BOM line in `subsystem` and approve it.
    fn select(bench: &mut Bench, candidate: &Value, subsystem: &str, quantity: f64) -> Value {
        let selected = bench
            .agent(
                "component.propose_selection",
                json!({"artifactId": candidate["artifact"]["id"], "bomLines": [{"subsystem": subsystem, "quantity": quantity}], "reason": "needed"}),
            )
            .unwrap();
        bench.approve(&selected["proposal"]);
        selected
    }

    fn bom(bench: &mut Bench) -> Value {
        bench.user("bom.read", json!({})).unwrap()
    }

    #[test]
    fn component_selection_requires_human_approval_before_bom_changes() {
        let mut bench = Bench::new();
        let source = bench.user("source.capture",json!({"title":"Datasheet","url":"https://example.test/datasheet","sourceKind":"datasheet"})).unwrap();
        let component = bench.agent("component.add_candidate",json!({"title":"Motor","manufacturer":"Acme","partNumber":"M1","imageUrl":"https://shop.example.test/motor.jpg","selectionReason":"Drives the wheels at the required torque.","offer":{"seller":"Acme","url":"https://shop.example.test/motor","price":{"amount":"12.50","currency":"USD"}},"sourceId":source["artifact"]["id"],"properties":{"mass":{"quantity":{"value":0.2,"unit":"kg"}}}})).unwrap();
        let comparison = bench
            .user(
                "component.compare",
                json!({"artifactIds":[component["artifact"]["id"]]}),
            )
            .unwrap();
        let offer_id = &comparison["components"][0]["offers"][0]["id"];
        // The saved offer comes back with the candidate: no second call is needed to learn its id.
        assert_eq!(&component["offer"]["id"], offer_id);
        let selected = bench.agent("component.propose_selection",json!({"artifactId":component["artifact"]["id"],"revisionId":component["revision"]["id"],"bomLines":[{"quantity":2,"offerId":offer_id}],"reason":"Choose motor"})).unwrap();
        assert_eq!(bom(&mut bench)["totals"]["lineCount"], 0);
        let accepted = bench.approve(&selected["proposal"]);
        assert_eq!(accepted["state"], "accepted");
        let bom = bom(&mut bench);
        assert_eq!(bom["totals"]["lineCount"], 1);
        assert_eq!(bom["lines"][0]["componentTitle"], "Motor");
        assert_eq!(bom["lines"][0]["line"]["quantity"], 2.0);
        assert_eq!(
            bom["lines"][0]["imageUrl"],
            "https://shop.example.test/motor.jpg"
        );
        assert_eq!(
            bom["lines"][0]["selectionReason"],
            "Drives the wheels at the required torque."
        );
        assert_eq!(bom["lines"][0]["offer"]["price"]["amount"], "12.50");
        assert_eq!(bom["lines"][0]["lineTotal"]["amount"], "25.00");
        assert_eq!(bom["lines"][0]["componentRevisionCurrent"], true);
    }

    #[test]
    fn mass_totals_convert_units_and_count_unknowns_with_their_reason() {
        let mut bench = Bench::new();
        // Subsystems a..f fix the line order, so the total is in the first line's unit (kg).
        let motor = bench.component("Motor", kg(0.2), Some("12.50"));
        select(&mut bench, &motor, "a", 2.0);
        let sensor = bench.component("Sensor", json!({"value": 15, "unit": "g"}), Some("3.20"));
        select(&mut bench, &sensor, "b", 1.0);
        let pack = bench.component("Pack", json!({"value": 1.5, "unit": "oz"}), None);
        select(&mut bench, &pack, "c", 2.0);
        let bracket = bench.component(
            "Bracket",
            json!({"unknown": true, "reason": "not on the product page"}),
            None,
        );
        select(&mut bench, &bracket, "d", 4.0);
        // An agent cannot save a unit nothing converts; data from the
        // interface or an earlier build can still hold one.
        let cable = bench
            .user(
                "component.add_candidate",
                json!({"title": "Cable", "manufacturer": "Acme", "partNumber": "cable",
                    "properties": {"mass": {"quantity": {"value": 2, "unit": "stone"}}},
                    "offer": {"seller": "Acme Shop", "url": "https://shop.example.test/cable"}}),
            )
            .unwrap();
        select(&mut bench, &cable, "e", 1.0);
        let spacer = bench.component("Spacer", json!({"value": 5, "unit": "mm"}), None);
        select(&mut bench, &spacer, "f", 8.0);

        let bom = bom(&mut bench);
        let totals = &bom["totals"];
        assert_eq!(totals["lineCount"], 6);
        // 2 x 0.2 kg + 15 g + 2 x 1.5 oz (28.349523125 g each) = 0.500048569375 kg.
        assert_eq!(totals["knownMass"]["unit"], "kg");
        let mass = totals["knownMass"]["value"].as_f64().unwrap();
        assert!((mass - 0.500048569375).abs() < 1e-12, "{mass}");
        // The gram line is known and counted, not dropped for its unit.
        assert_eq!(bom["lines"][1]["lineMassKnown"], true);
        assert_eq!(
            bom["lines"][1]["unitMass"],
            json!({"value": 15, "unit": "g"})
        );
        assert_eq!(totals["missingMassCount"], 3);
        let reasons = totals["unknownMass"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                format!(
                    "{}: {}",
                    entry["componentTitle"].as_str().unwrap(),
                    entry["reason"].as_str().unwrap()
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            reasons,
            [
                "Bracket: mass: not on the product page",
                "Cable: mass: Unknown unit 'stone'",
                "Spacer: mass is recorded in mm (length), not a unit of mass",
            ]
        );
        assert_eq!(bom["lines"][3]["lineMassKnown"], false);
        assert_eq!(bom["lines"][3]["unitMass"], Value::Null);
        assert_eq!(
            bom["lines"][3]["massUnknownReason"],
            "mass: not on the product page"
        );
        // 2 x 12.50 + 3.20 in the one currency; four lines have no price.
        assert_eq!(
            totals["cost"],
            json!([{"amount": "28.20", "currency": "USD"}])
        );
        assert_eq!(totals["missingPriceCount"], 4);
        assert_eq!(
            totals["unknownCost"][0],
            json!({"lineId": bom["lines"][2]["line"]["id"], "componentTitle": "Pack", "reason": "the offer records no price"})
        );
    }

    #[test]
    fn weight_is_used_when_mass_is_unknown_and_a_total_starts_in_any_unit() {
        let mut bench = Bench::new();
        let servo = bench.agent("component.add_candidate", json!({"title":"Servo","vendor":"Acme","partNumber":"S1","offer":{"seller":"Shop","url":"https://shop.example.test/servo"},
            "properties":{"mass":{"quantity":{"unknown":true,"reason":"not listed"}},"weight":{"quantity":{"value":55,"unit":"g"}}}})).unwrap();
        select(&mut bench, &servo, "a", 2.0);
        let horn = bench.component("Horn", kg(0.004), None);
        select(&mut bench, &horn, "b", 1.0);
        let totals = bom(&mut bench)["totals"].clone();
        // 2 x 55 g + 0.004 kg, in grams because the first known line is in grams.
        assert_eq!(totals["knownMass"], json!({"value": 114.0, "unit": "g"}));
        assert_eq!(totals["missingMassCount"], 0);
    }

    #[test]
    fn prices_keep_their_currency_pack_size_and_sub_cent_amounts() {
        let mut bench = Bench::new();
        let mut add = |title: &str, subsystem: &str, quantity: f64, offer: Value| {
            let candidate = bench
                .agent(
                    "component.add_candidate",
                    json!({"title": title, "manufacturer": "Acme", "partNumber": title, "offer": offer}),
                )
                .unwrap();
            select(&mut bench, &candidate, subsystem, quantity);
        };
        // 3 from a pack of 10 at 4.00: 1.20.
        add(
            "Screws",
            "a",
            3.0,
            json!({"seller":"Shop","url":"https://shop.example.test/s","price":{"amount":"4.00","currency":"USD"},"quantityBasis":10}),
        );
        // One resistor at 0.004 is not free.
        add(
            "Resistor",
            "b",
            1.0,
            json!({"seller":"Shop","url":"https://shop.example.test/r","price":{"amount":"0.004","currency":"USD"}}),
        );
        add(
            "Board",
            "c",
            2.0,
            json!({"seller":"Laden","url":"https://shop.example.test/b","price":{"amount":"9.90","currency":"EUR"}}),
        );
        add(
            "Header",
            "d",
            1.0,
            json!({"seller":"Shop","url":"https://shop.example.test/h","price":null}),
        );
        let bom = bom(&mut bench);
        assert_eq!(
            bom["lines"][0]["lineTotal"],
            json!({"amount": "1.20", "currency": "USD"})
        );
        assert_eq!(
            bom["lines"][1]["lineTotal"],
            json!({"amount": "0.0040", "currency": "USD"})
        );
        assert_eq!(bom["lines"][3]["lineTotal"], Value::Null);
        assert_eq!(
            bom["lines"][3]["priceUnknownReason"],
            "the offer records no price"
        );
        // Currencies are never added together; they are listed in the order first seen.
        assert_eq!(
            bom["totals"]["cost"],
            json!([{"amount": "1.2040", "currency": "USD"}, {"amount": "19.80", "currency": "EUR"}])
        );
        assert_eq!(bom["totals"]["missingPriceCount"], 1);
    }

    #[test]
    fn a_replaced_component_leaves_the_bill_of_materials() {
        let mut bench = Bench::new();
        let old = bench.component("Motor 50:1", kg(0.2), Some("12.50"));
        select(&mut bench, &old, "drive", 2.0);
        let new = bench.component("Motor 100:1", kg(0.3), Some("14.00"));
        let proposed = bench
            .agent(
                "component.propose_selection",
                json!({"artifactId": new["artifact"]["id"], "replacesArtifactId": old["artifact"]["id"], "bomLines": [{"subsystem": "drive", "quantity": 2}], "reason": "more torque"}),
            )
            .unwrap();
        assert_eq!(
            proposed["notes"],
            json!([
                format!(
                    "BOM line 1 buys from the only recorded offer, Acme Shop ({}).",
                    new["offer"]["id"].as_str().unwrap()
                ),
                "Approval removes 1 BOM line(s) of Motor 50:1.",
            ])
        );
        // Nothing changes before the human decides.
        assert_eq!(bom(&mut bench)["lines"][0]["componentTitle"], "Motor 50:1");
        bench.approve(&proposed["proposal"]);
        let after = bom(&mut bench);
        assert_eq!(after["totals"]["lineCount"], 1);
        assert_eq!(after["lines"][0]["componentTitle"], "Motor 100:1");
        assert_eq!(
            after["totals"]["knownMass"],
            json!({"value": 0.6, "unit": "kg"})
        );
        assert_eq!(
            after["totals"]["cost"],
            json!([{"amount": "28.00", "currency": "USD"}])
        );
        assert_eq!(after["replacedLines"], json!([]));
    }

    #[test]
    fn lines_of_an_archived_component_are_listed_apart_and_not_totalled() {
        let mut bench = Bench::new();
        let kept = bench.component("Frame", kg(1.0), Some("20.00"));
        select(&mut bench, &kept, "a", 1.0);
        let gone = bench.component("Old bracket", kg(0.5), Some("5.00"));
        select(&mut bench, &gone, "b", 2.0);
        bench
            .user(
                "artifact.archive",
                json!({"artifactId": gone["artifact"]["id"], "archived": true}),
            )
            .unwrap();
        let bom = bom(&mut bench);
        assert_eq!(bom["totals"]["lineCount"], 1);
        assert_eq!(bom["totals"]["replacedLineCount"], 1);
        assert_eq!(
            bom["totals"]["knownMass"],
            json!({"value": 1.0, "unit": "kg"})
        );
        assert_eq!(
            bom["totals"]["cost"],
            json!([{"amount": "20.00", "currency": "USD"}])
        );
        assert_eq!(bom["replacedLines"][0]["componentTitle"], "Old bracket");
        assert_eq!(
            bom["replacedLines"][0]["reason"],
            "component archived or replaced"
        );
        let text = bench.user("bom.export", json!({})).unwrap();
        let content = text["content"].as_str().unwrap();
        assert!(!content.contains("Old bracket"));
        assert!(content.ends_with("Not included: 1 line(s) of archived or replaced components"));
    }

    #[test]
    fn candidate_errors_name_the_field_to_repair() {
        let mut bench = Bench::new();
        let maker = bench
            .agent(
                "component.add_candidate",
                json!({"title":"Motor","manufacturer":"  ","partNumber":"M1","offer":{"seller":"Shop","url":"https://shop.example.test/m"}}),
            )
            .unwrap_err();
        assert_eq!(maker.code, "MISSING_SOURCE");
        assert_eq!(maker.message, "Component needs a manufacturer or vendor");
        assert!(maker.repair.unwrap().contains("manufacturer"));
        assert_eq!(
            maker.details.unwrap()["issues"],
            json!([{"path":"manufacturer","message":"give this or vendor"},{"path":"vendor","message":"give this or manufacturer"}])
        );
        let source = bench
            .agent(
                "component.add_candidate",
                json!({"title":"Motor","manufacturer":"Acme","partNumber":"M1","offer":{"seller":"Shop"}}),
            )
            .unwrap_err();
        assert_eq!(source.code, "MISSING_SOURCE");
        let paths = source.details.unwrap()["issues"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(paths, ["source", "offer.url", "sourceId"]);
        let motor = bench.component("Motor", kg(0.2), None);
        let wrong = bench
            .agent(
                "component.add_candidate",
                json!({"title":"Gear","manufacturer":"Acme","partNumber":"G1","sourceId":motor["artifact"]["id"]}),
            )
            .unwrap_err();
        assert_eq!(wrong.code, "VALIDATION");
        assert_eq!(
            wrong.message,
            "sourceId names Motor, which is a component artifact, not a source"
        );
        assert_eq!(wrong.details.unwrap()["issues"][0]["path"], "sourceId");
        // Nothing was written by the refused calls.
        let listed = bench.user("artifact.list", json!({})).unwrap();
        assert_eq!(listed["artifacts"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_candidate_records_its_page_as_a_source_in_the_same_call() {
        let mut bench = Bench::new();
        let page = "https://shop.example.test/mg996r";
        let servo = bench
            .agent(
                "component.add_candidate",
                json!({"title":"MG996R servo","manufacturer":"TowerPro","partNumber":"MG996R",
                    "source":{"url":page,"title":"MG996R product page","excerpt":"MG996R, 55 g, 12.50 USD, in stock"},
                    "properties":{"mass":{"quantity":{"value":55,"unit":"g"}}},
                    "offer":{"seller":"Example Robotics","url":page,"price":{"amount":"12.50","currency":"USD"}}}),
            )
            .unwrap();
        let source_id = servo["source"]["artifact"]["id"].as_str().unwrap();
        let source = bench.read(source_id);
        assert_eq!(source["view"]["artifact"]["type"], "source");
        assert_eq!(source["revision"]["payload"]["url"], page);
        assert_eq!(source["revision"]["payload"]["sourceKind"], "supplier");
        assert_eq!(
            source["revision"]["payload"]["excerpt"],
            "MG996R, 55 g, 12.50 USD, in stock"
        );
        // The candidate is derived from that source, and the offer read on the same page cites it.
        assert_eq!(servo["revision"]["inputs"][0]["artifactId"], source_id);
        assert_eq!(
            servo["revision"]["inputs"][0]["relationship"],
            "derived_from"
        );
        assert_eq!(servo["offer"]["sourceId"], source_id);
        assert_eq!(
            servo["offer"]["price"],
            json!({"amount":"12.50","currency":"USD"})
        );
        // Three calls from page to proposal: this one, and the selection with nothing to look up.
        let selected = bench
            .agent(
                "component.propose_selection",
                json!({"artifactId": servo["artifact"]["id"], "bomLines": [{"quantity": 2}], "reason": "steering"}),
            )
            .unwrap();
        bench.approve(&selected["proposal"]);
        let bom = bom(&mut bench);
        assert_eq!(
            bom["lines"][0]["lineTotal"],
            json!({"amount":"25.00","currency":"USD"})
        );
        assert_eq!(bom["lines"][0]["offer"]["id"], servo["offer"]["id"]);
    }

    #[test]
    fn selection_checks_offers_and_revisions() {
        let mut bench = Bench::new();
        let motor = bench.component("Motor", kg(0.2), Some("12.50"));
        let other = bench.component("Sensor", kg(0.1), Some("3.00"));
        let foreign = bench
            .agent(
                "component.propose_selection",
                json!({"artifactId": motor["artifact"]["id"], "bomLines": [{"quantity": 1, "offerId": other["offer"]["id"]}], "reason": "x"}),
            )
            .unwrap_err();
        assert_eq!(foreign.code, "VALIDATION");
        assert!(foreign.message.ends_with("does not belong to Motor"));
        assert!(foreign
            .repair
            .unwrap()
            .contains(motor["offer"]["id"].as_str().unwrap()));
        assert_eq!(
            foreign.details.unwrap()["issues"][0]["path"],
            "bomLines[0].offerId"
        );
        let revision = bench
            .agent(
                "component.propose_selection",
                json!({"artifactId": motor["artifact"]["id"], "revisionId": other["revision"]["id"], "bomLines": [{"quantity": 1}], "reason": "x"}),
            )
            .unwrap_err();
        assert_eq!(revision.details.unwrap()["issues"][0]["path"], "revisionId");
        let not_component = bench
            .user(
                "artifact.create_draft",
                json!({"type":"note","title":"Notes","payload":{"markdown":"x"}}),
            )
            .unwrap();
        let wrong_type = bench
            .agent(
                "component.propose_selection",
                json!({"artifactId": not_component["artifact"]["id"], "bomLines": [{"quantity": 1}], "reason": "x"}),
            )
            .unwrap_err();
        assert_eq!(
            wrong_type.message,
            "Notes is a note artifact, not a component"
        );
        // With two offers and none named, the line is priced by neither.
        bench
            .agent(
                "component.add_offer",
                json!({"artifactId": motor["artifact"]["id"], "seller": "Other Shop", "url": "https://other.example.test/motor", "price": {"amount": "11.00", "currency": "USD"}}),
            )
            .unwrap();
        let unpriced = bench
            .agent(
                "component.propose_selection",
                json!({"artifactId": motor["artifact"]["id"], "bomLines": [{"quantity": 1}], "reason": "x"}),
            )
            .unwrap();
        assert_eq!(
            unpriced["notes"],
            json!(["BOM line 1 names no offer and the component has 2: its price stays unknown until offerId names one."])
        );
        assert_eq!(
            unpriced["proposal"]["changes"][0]["bomLines"][0]["offerId"],
            Value::Null
        );
        // The selection descends from the revision that was selected and keeps its inputs.
        let newest = bench.read(motor["artifact"]["id"].as_str().unwrap())["revision"].clone();
        assert_eq!(newest["payload"]["status"], "selected");
        assert_eq!(newest["parentId"], motor["revision"]["id"]);
        assert_eq!(newest["inputs"], motor["revision"]["inputs"]);
    }

    #[test]
    fn comparison_lists_criteria_in_the_order_written() {
        let mut bench = Bench::new();
        let a = bench.agent("component.add_candidate", json!({"title":"A","manufacturer":"Acme","partNumber":"A","offer":{"seller":"S","url":"https://shop.example.test/a"},
            "properties":{"torque":{"quantity":{"value":1,"unit":"N*m"}},"mass":{"quantity":{"value":10,"unit":"g"}}}})).unwrap();
        let b = bench.agent("component.add_candidate", json!({"title":"B","manufacturer":"Acme","partNumber":"B","offer":{"seller":"S","url":"https://shop.example.test/b"},
            "properties":{"mass":{"quantity":{"value":12,"unit":"g"}},"current":{"quantity":{"unknown":true,"reason":"not listed"}}}})).unwrap();
        let compared = bench
            .user(
                "component.compare",
                json!({"artifactIds": [a["artifact"]["id"], b["artifact"]["id"]]}),
            )
            .unwrap();
        let criteria = compared["matrix"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["criterion"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(criteria, ["torque", "mass", "current"]);
        assert_eq!(
            compared["matrix"][0]["values"],
            json!([{"value":1,"unit":"N*m"}, null])
        );
        assert_eq!(
            compared["matrix"][2]["values"][1],
            json!({"unknown":true,"reason":"not listed"})
        );
        assert_eq!(compared["components"][0]["freshness"], "current");
    }

    #[test]
    fn a_bom_edit_adds_and_removes_lines_through_one_proposal() {
        let mut bench = Bench::new();
        let motor = bench.component("Motor", kg(0.2), Some("12.50"));
        select(&mut bench, &motor, "drive", 2.0);
        let wheel = bench.component("Wheel", kg(0.05), Some("2.00"));
        select(&mut bench, &wheel, "drive", 2.0);
        let wheel_baseline = bench
            .user(
                "artifact.read",
                json!({"artifactId": wheel["artifact"]["id"]}),
            )
            .unwrap()["view"]["artifact"]["selectedRevisionId"]
            .clone();
        let before = bom(&mut bench);
        let motor_line = before["lines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["componentTitle"] == "Motor")
            .unwrap()["line"]["id"]
            .clone();
        let edit = bench
            .agent(
                "bom.propose_edit",
                json!({"lines": [{"componentArtifactId": wheel["artifact"]["id"], "quantity": 4, "offerId": wheel["offer"]["id"], "notes": "four wheels"}], "removeLineIds": [motor_line], "reason": "four-wheel layout without the old motor line"}),
            )
            .unwrap();
        assert_eq!(edit["proposal"]["state"], "pending");
        assert_eq!(edit["proposal"]["changes"][0]["kind"], "bom_edit");
        assert_eq!(bom(&mut bench)["totals"]["lineCount"], 2);
        bench.approve(&edit["proposal"]);
        let after = bom(&mut bench);
        let titles = after["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row["componentTitle"].as_str().unwrap(),
                    row["line"]["quantity"].as_f64().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        assert!(
            titles.contains(&("Wheel", 2.0))
                && titles.contains(&("Wheel", 4.0))
                && titles.len() == 2
        );
        // The edit leaves the component's baseline as it was; the new line
        // points at it.
        assert_eq!(
            bench
                .user(
                    "artifact.read",
                    json!({"artifactId": wheel["artifact"]["id"]})
                )
                .unwrap()["view"]["artifact"]["selectedRevisionId"],
            wheel_baseline
        );
        let added = after["lines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["line"]["quantity"] == 4.0)
            .unwrap();
        assert_eq!(added["componentRevisionCurrent"], true);
        assert_eq!(
            added["lineTotal"],
            json!({"amount": "8.00", "currency": "USD"})
        );

        let nothing = bench
            .agent("bom.propose_edit", json!({"reason": "nothing"}))
            .unwrap_err();
        assert_eq!(
            nothing.message,
            "A BOM edit needs a line to add or a line to remove"
        );
        let missing = bench
            .agent(
                "bom.propose_edit",
                json!({"removeLineIds": [uuid::Uuid::new_v4().to_string()], "reason": "x"}),
            )
            .unwrap_err();
        assert_eq!(missing.code, "NOT_FOUND");
        assert_eq!(
            missing.details.unwrap()["issues"][0]["path"],
            "removeLineIds[0]"
        );
        let candidate = bench.component("Candidate", kg(0.1), None);
        let unapproved = bench
            .agent("bom.propose_edit", json!({"lines": [{"componentArtifactId": candidate["artifact"]["id"], "quantity": 1}], "reason": "x"}))
            .unwrap_err();
        assert_eq!(unapproved.message, "Candidate has no approved revision");
        assert!(unapproved
            .repair
            .unwrap()
            .contains("component_propose_selection"));
    }

    #[test]
    fn line_edits_by_the_person_report_a_missing_line() {
        let mut bench = Bench::new();
        let motor = bench.component("Motor", kg(0.2), Some("12.50"));
        select(&mut bench, &motor, "drive", 2.0);
        let line = bom(&mut bench)["lines"][0]["line"]["id"].clone();
        bench
            .user(
                "bom.update_line",
                json!({"lineId": line, "quantity": 3, "notes": "one spare"}),
            )
            .unwrap();
        let updated = bom(&mut bench);
        assert_eq!(updated["lines"][0]["line"]["quantity"], 3.0);
        assert_eq!(updated["lines"][0]["line"]["notes"], "one spare");
        assert_eq!(updated["lines"][0]["lineTotal"]["amount"], "37.50");
        bench
            .user("bom.remove_line", json!({"lineId": line}))
            .unwrap();
        assert_eq!(bom(&mut bench)["totals"]["lineCount"], 0);
        for op in ["bom.update_line", "bom.remove_line"] {
            let error = bench.user(op, json!({"lineId": line})).unwrap_err();
            assert_eq!(error.code, "NOT_FOUND", "{op}");
        }
    }

    #[test]
    fn exports_read_like_the_interface_and_can_be_written_to_a_file() {
        let mut bench = Bench::new();
        let motor = bench.agent("component.add_candidate", json!({"title":"Motor, \"HP\" | 6 V","manufacturer":"Acme","partNumber":"M-1",
            "properties":{"mass":{"quantity":{"value":0.1,"unit":"kg"}}},
            "offer":{"seller":"Shop, Inc.","url":"https://shop.example.test/motor?a=1,2","price":{"amount":"12.50","currency":"USD"}}})).unwrap();
        let selected = bench
            .agent(
                "component.propose_selection",
                json!({"artifactId": motor["artifact"]["id"], "bomLines": [{"quantity": 3, "notes": "left | right"}], "reason": "drive"}),
            )
            .unwrap();
        bench.approve(&selected["proposal"]);
        let observed = motor["offer"]["observedAt"].as_str().unwrap();
        let markdown = bench.user("bom.export", json!({})).unwrap();
        assert_eq!(
            markdown["content"].as_str().unwrap(),
            format!(
                "# Bill of materials\n\n| Part | Part no. | Manufacturer | Qty | Unit price | Offer price / basis | Line total | Mass | Notes |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| Motor, \"HP\" \\| 6 V | M-1 | Acme | 3 | 12.50 USD | 12.50 USD / 1 unit(s) (observed {}) | 37.50 USD | 0.3 kg | left \\| right |\n\nKnown subtotal: 37.50 USD — 0 line(s) missing price\nKnown mass: 0.3 kg — 0 line(s) missing mass",
                &observed[..10]
            )
        );
        let csv = bench.user("bom.export", json!({"format": "csv"})).unwrap();
        assert_eq!(
            csv["content"].as_str().unwrap(),
            format!(
                "title,part_number,manufacturer,qty,unit_price,currency,seller,url,observed_at,notes,offer_price,quantity_basis,line_total,price_unknown_reason,mass_unknown_reason\n\"Motor, \"\"HP\"\" | 6 V\",\"M-1\",\"Acme\",3,12.50,USD,\"Shop, Inc.\",\"https://shop.example.test/motor?a=1,2\",{observed},\"left | right\",\"12.50\",1,37.50,\"\",\"\""
            )
        );
        // A person may write the export anywhere; an agent only inside the project.
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("exports/bom.csv");
        let written = bench
            .user("bom.export", json!({"format": "csv", "destPath": target}))
            .unwrap();
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            written["content"].as_str().unwrap()
        );
        assert_eq!(written["path"], json!(target));
        let refused = bench
            .agent("bom.export", json!({"format": "csv", "destPath": target}))
            .unwrap_err();
        assert_eq!(refused.code, "PATH_OUTSIDE_PROJECT");
        let inside = bench
            .agent("bom.export", json!({"destPath": "exports/bom.md"}))
            .unwrap();
        let path = bench.root().join("exports/bom.md");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            inside["content"].as_str().unwrap()
        );
    }

    #[test]
    fn exports_distinguish_unit_prices_from_packs_and_preserve_unknowns() {
        let mut bench = Bench::new();
        for (title, subsystem, quantity, price, basis) in [
            (
                "Screws",
                "a",
                3.0,
                json!({"amount":"4.00","currency":"USD"}),
                10,
            ),
            (
                "Board",
                "b",
                2.0,
                json!({"amount":"9.90","currency":"EUR"}),
                1,
            ),
            ("Header", "c", 1.0, Value::Null, 1),
        ] {
            let candidate = bench.agent("component.add_candidate", json!({
                "title":title,"manufacturer":"Acme","partNumber":title,
                "properties":{"mass":{"quantity":{"unknown":true,"reason":"not on the product page"}}},
                "offer":{"seller":"Shop","url":"https://shop.example.test/part","price":price,"quantityBasis":basis}
            })).unwrap();
            select(&mut bench, &candidate, subsystem, quantity);
        }
        let read = bom(&mut bench);
        let markdown = bom_markdown(&read);
        assert!(
            markdown.contains("| 3 | 0.40 USD | 4.00 USD / 10 unit(s)"),
            "{markdown}"
        );
        assert!(
            markdown.contains("| 1.20 USD | unknown (mass: not on the product page)"),
            "{markdown}"
        );
        assert!(markdown.contains("unknown (the offer records no price)"));
        assert!(markdown.contains("1.20 USD + 19.80 EUR"));
        let csv = bom_csv(&read);
        let rows = csv.lines().collect::<Vec<_>>();
        assert!(rows[1].contains(",3,0.40,USD,"), "{}", rows[1]);
        assert!(rows[1].contains(",\"4.00\",10,1.20,\"\",\"mass: not on the product page\""));
        assert!(rows[2].contains(",2,9.90,EUR,"));
        assert!(rows[3].contains(",1,,,"), "{}", rows[3]);
        assert!(rows[3].contains("\"the offer records no price\""));
    }
}
