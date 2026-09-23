use super::*;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

const SCOPE: &str = "Experimental: referenced source values are labels, not resolved revision fields; supplied quantities are used as given. Derived-unit inference is incomplete — declare the output unit explicitly. Do not treat results as verified engineering evidence.";

fn all_templates() -> Vec<Value> {
    let mut entries: Vec<Value> = serde_json::from_str(include_str!("../calc_templates.json"))
        .expect("frozen calculation templates");
    for entry in &mut entries {
        let limits = entry["limitations"]
            .as_array_mut()
            .expect("template limitations");
        if !limits.iter().any(|limit| limit == SCOPE) {
            limits.push(json!(SCOPE));
        }
    }
    entries
}

pub(super) fn templates() -> CoreResult<Value> {
    Ok(json!({"templates": all_templates()}))
}

pub(super) fn explain_inputs(handle: &ProjectHandle, input: &Value) -> CoreResult<Value> {
    let id = required_str(input, "artifactId")?;
    let artifact = require_artifact(handle, id)?;
    let revision = if let Some(selected) = artifact["selectedRevisionId"].as_str() {
        require_revision(handle, selected)?
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
            .ok_or_else(|| ContractError::validation("No revision on calculation"))?
    };
    let mut inputs = revision["payload"]["inputs"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for item in &mut inputs {
        let mut title = Value::Null;
        let mut moved = false;
        if let Some(source_id) = item["sourceRef"]["artifactId"].as_str() {
            if let Some(source) = handle
                .db
                .query_row(
                    "SELECT * FROM artifact WHERE id=?1",
                    [source_id],
                    artifact_from_row,
                )
                .optional()
                .map_err(internal)?
            {
                title = source["title"].clone();
                moved = source["selectedRevisionId"] != item["sourceRef"]["revisionId"];
            } else {
                moved = true;
            }
        }
        item["sourceTitle"] = title;
        item["sourceMoved"] = json!(moved);
    }
    let view = artifact_view(handle, &artifact)?;
    Ok(
        json!({"artifact": artifact,"revision":revision,"inputs":inputs,
        "expression":revision["payload"]["expression"],"templateId":revision["payload"]["templateId"],
        "freshness":view["freshness"]}),
    )
}

#[derive(Clone, Deserialize)]
struct Unit {
    name: String,
    dim: String,
    scale: f64,
    offset: f64,
}

fn units() -> &'static HashMap<String, Unit> {
    static UNITS: OnceLock<HashMap<String, Unit>> = OnceLock::new();
    UNITS.get_or_init(|| {
        serde_json::from_str(include_str!("../units.json")).expect("frozen contract units")
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Dim([i16; 7]); // length, mass, time, current, temperature, data, angle

impl Dim {
    const ZERO: Self = Self([0; 7]);
    fn add(self, rhs: Self) -> Self {
        Self(std::array::from_fn(|i| self.0[i] + rhs.0[i]))
    }
    fn sub(self, rhs: Self) -> Self {
        Self(std::array::from_fn(|i| self.0[i] - rhs.0[i]))
    }
    fn times(self, exponent: i16) -> Self {
        Self(self.0.map(|v| v * exponent))
    }
}

fn dimension(name: &str) -> Dim {
    Dim(match name {
        "length" => [1, 0, 0, 0, 0, 0, 0],
        "mass" => [0, 1, 0, 0, 0, 0, 0],
        "time" => [0, 0, 1, 0, 0, 0, 0],
        "current" => [0, 0, 0, 1, 0, 0, 0],
        "temperature" => [0, 0, 0, 0, 1, 0, 0],
        "data" => [0, 0, 0, 0, 0, 1, 0],
        "angle" => [0, 0, 0, 0, 0, 0, 1],
        "speed" => [1, 0, -1, 0, 0, 0, 0],
        "acceleration" => [1, 0, -2, 0, 0, 0, 0],
        "angular_speed" => [0, 0, -1, 0, 0, 0, 1],
        "charge" => [0, 0, 1, 1, 0, 0, 0],
        "voltage" => [2, 1, -3, -1, 0, 0, 0],
        "power" => [2, 1, -3, 0, 0, 0, 0],
        "energy" | "torque" => [2, 1, -2, 0, 0, 0, 0],
        "force" => [1, 1, -2, 0, 0, 0, 0],
        _ => [0; 7],
    })
}

#[derive(Clone, Copy, Debug)]
struct Number {
    base: f64,
    dim: Dim,
}

impl Number {
    fn plain(value: f64) -> Self {
        Self {
            base: value,
            dim: Dim::ZERO,
        }
    }
}

fn unit(name: &str) -> CoreResult<&'static Unit> {
    units()
        .get(name)
        .ok_or_else(|| ContractError::new("INVALID_UNITS", format!("Unknown unit '{name}'")))
}

fn quantity(value: &Value) -> CoreResult<Number> {
    let value_num = value["value"]
        .as_f64()
        .ok_or_else(|| ContractError::new("INVALID_UNITS", "Quantity has no numeric value"))?;
    let unit = unit(required_str(value, "unit")?)?;
    Ok(Number {
        base: value_num * unit.scale + unit.offset,
        dim: dimension(&unit.dim),
    })
}

struct Parser<'a> {
    source: &'a str,
    pos: usize,
    vars: &'a HashMap<String, Number>,
    steps: usize,
}

impl<'a> Parser<'a> {
    fn new(source: &'a str, vars: &'a HashMap<String, Number>) -> CoreResult<Self> {
        if source.trim().is_empty() {
            return Err(ContractError::validation("Expression is empty"));
        }
        if source.len() > 2000 {
            return Err(ContractError::validation("Expression too long"));
        }
        if !source
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_+-*/^%(),. \t\r\n<>=!".contains(&b))
        {
            return Err(ContractError::validation(
                "Expression contains disallowed character",
            ));
        }
        Ok(Self {
            source,
            pos: 0,
            vars,
            steps: 0,
        })
    }
    fn rest(&self) -> &str {
        &self.source[self.pos..]
    }
    fn space(&mut self) {
        while self
            .rest()
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_whitespace())
        {
            self.pos += 1;
        }
    }
    fn take(&mut self, text: &str) -> bool {
        self.space();
        if self.rest().starts_with(text) {
            self.pos += text.len();
            true
        } else {
            false
        }
    }
    fn expression(&mut self, min_bp: u8) -> CoreResult<Number> {
        self.steps += 1;
        if self.steps > 512 {
            return Err(ContractError::validation("Expression is too complex"));
        }
        let mut lhs = if self.take("+") {
            self.expression(7)?
        } else if self.take("-") {
            let mut v = self.expression(7)?;
            v.base = -v.base;
            v
        } else {
            self.primary()?
        };
        loop {
            self.space();
            let operators: [(&str, u8, u8); 11] = [
                (">=", 1, 2),
                ("<=", 1, 2),
                ("==", 1, 2),
                ("!=", 1, 2),
                (">", 1, 2),
                ("<", 1, 2),
                ("+", 2, 3),
                ("-", 2, 3),
                ("*", 4, 5),
                ("/", 4, 5),
                ("^", 8, 8),
            ];
            let Some((op, left_bp, right_bp)) = operators
                .iter()
                .find(|(op, _, _)| self.rest().starts_with(op))
            else {
                break;
            };
            if *left_bp < min_bp {
                break;
            }
            self.pos += op.len();
            let rhs = self.expression(*right_bp)?;
            lhs = apply(op, lhs, rhs)?;
        }
        Ok(lhs)
    }
    fn primary(&mut self) -> CoreResult<Number> {
        self.space();
        if self.take("(") {
            let value = self.expression(0)?;
            if !self.take(")") {
                return Err(ContractError::validation("Missing ')'"));
            }
            return Ok(value);
        }
        let first = self
            .rest()
            .as_bytes()
            .first()
            .copied()
            .ok_or_else(|| ContractError::validation("Unexpected end of expression"))?;
        if first.is_ascii_digit() || first == b'.' {
            let start = self.pos;
            while self
                .rest()
                .as_bytes()
                .first()
                .is_some_and(|b| b.is_ascii_digit() || *b == b'.')
            {
                self.pos += 1;
            }
            if self.rest().starts_with('e') || self.rest().starts_with('E') {
                self.pos += 1;
                if self.rest().starts_with('+') || self.rest().starts_with('-') {
                    self.pos += 1;
                }
                while self
                    .rest()
                    .as_bytes()
                    .first()
                    .is_some_and(|b| b.is_ascii_digit())
                {
                    self.pos += 1;
                }
            }
            let number = self.source[start..self.pos]
                .parse::<f64>()
                .map_err(|_| ContractError::validation("Invalid number"))?;
            return Ok(Number::plain(number));
        }
        if first.is_ascii_alphabetic() || first == b'_' {
            let start = self.pos;
            while self
                .rest()
                .as_bytes()
                .first()
                .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
            {
                self.pos += 1;
            }
            let name = &self.source[start..self.pos];
            if self.take("(") {
                let mut args = Vec::new();
                if !self.take(")") {
                    loop {
                        args.push(self.expression(0)?);
                        if self.take(")") {
                            break;
                        }
                        if !self.take(",") {
                            return Err(ContractError::validation("Expected ',' in function call"));
                        }
                    }
                }
                return function(name, &args);
            }
            if name == "pi" {
                return Ok(Number::plain(std::f64::consts::PI));
            }
            if name == "e" {
                return Ok(Number::plain(std::f64::consts::E));
            }
            return self
                .vars
                .get(name)
                .copied()
                .ok_or_else(|| ContractError::validation(format!("Undefined input '{name}'")));
        }
        Err(ContractError::validation("Unexpected expression token"))
    }
}

fn same_dimension(a: Number, b: Number) -> CoreResult<()> {
    if a.dim != b.dim {
        Err(ContractError::new(
            "INVALID_UNITS",
            "Incompatible units in expression",
        ))
    } else {
        Ok(())
    }
}

fn apply(op: &str, a: Number, b: Number) -> CoreResult<Number> {
    let value = match op {
        "+" | "-" | ">" | "<" | ">=" | "<=" | "==" | "!=" => {
            same_dimension(a, b)?;
            let base = match op {
                "+" => a.base + b.base,
                "-" => a.base - b.base,
                ">" => (a.base > b.base) as i32 as f64,
                "<" => (a.base < b.base) as i32 as f64,
                ">=" => (a.base >= b.base) as i32 as f64,
                "<=" => (a.base <= b.base) as i32 as f64,
                "==" => (a.base == b.base) as i32 as f64,
                _ => (a.base != b.base) as i32 as f64,
            };
            Number {
                base,
                dim: if matches!(op, "+" | "-") {
                    a.dim
                } else {
                    Dim::ZERO
                },
            }
        }
        "*" => Number {
            base: a.base * b.base,
            dim: a.dim.add(b.dim),
        },
        "/" => Number {
            base: a.base / b.base,
            dim: a.dim.sub(b.dim),
        },
        "^" => {
            if b.dim != Dim::ZERO {
                return Err(ContractError::new(
                    "INVALID_UNITS",
                    "Exponent must be dimensionless",
                ));
            }
            if a.dim != Dim::ZERO && (b.base.fract() != 0.0 || b.base.abs() > 16.0) {
                return Err(ContractError::new(
                    "INVALID_UNITS",
                    "Dimensional exponent must be a small integer",
                ));
            }
            Number {
                base: a.base.powf(b.base),
                dim: if a.dim == Dim::ZERO {
                    Dim::ZERO
                } else {
                    a.dim.times(b.base as i16)
                },
            }
        }
        _ => return Err(ContractError::validation("Unknown operator")),
    };
    if !value.base.is_finite() {
        return Err(ContractError::validation("Result is not finite"));
    }
    Ok(value)
}

fn function(name: &str, args: &[Number]) -> CoreResult<Number> {
    if args.is_empty() {
        return Err(ContractError::validation(format!(
            "Function {name} needs arguments"
        )));
    }
    let a = args[0];
    let result = match name {
        "min" | "max" => {
            for value in args {
                same_dimension(a, *value)?;
            }
            Number {
                base: if name == "min" {
                    args.iter().map(|x| x.base).fold(f64::INFINITY, f64::min)
                } else {
                    args.iter()
                        .map(|x| x.base)
                        .fold(f64::NEG_INFINITY, f64::max)
                },
                dim: a.dim,
            }
        }
        "abs" | "floor" | "ceil" | "round" if args.len() == 1 => Number {
            base: match name {
                "abs" => a.base.abs(),
                "floor" => a.base.floor(),
                "ceil" => a.base.ceil(),
                _ => a.base.round(),
            },
            dim: a.dim,
        },
        "sqrt" if args.len() == 1 => {
            if a.dim.0.iter().any(|v| v % 2 != 0) {
                return Err(ContractError::new(
                    "INVALID_UNITS",
                    "Cannot take square root of these units",
                ));
            }
            Number {
                base: a.base.sqrt(),
                dim: Dim(a.dim.0.map(|v| v / 2)),
            }
        }
        "sin" | "cos" | "tan" if args.len() == 1 => {
            if a.dim != Dim::ZERO && a.dim != dimension("angle") {
                return Err(ContractError::new(
                    "INVALID_UNITS",
                    "Trigonometry expects an angle",
                ));
            }
            Number::plain(match name {
                "sin" => a.base.sin(),
                "cos" => a.base.cos(),
                _ => a.base.tan(),
            })
        }
        "exp" | "log" | "log10" if args.len() == 1 => {
            if a.dim != Dim::ZERO {
                return Err(ContractError::new(
                    "INVALID_UNITS",
                    "Function needs dimensionless input",
                ));
            }
            Number::plain(match name {
                "exp" => a.base.exp(),
                "log" => a.base.ln(),
                _ => a.base.log10(),
            })
        }
        "pow" if args.len() == 2 => apply("^", a, args[1])?,
        _ => {
            return Err(ContractError::validation(format!(
                "Unsupported calculation function '{name}'"
            )))
        }
    };
    if !result.base.is_finite() {
        return Err(ContractError::validation("Result is not finite"));
    }
    Ok(result)
}

fn evaluate(expression: &str, vars: &HashMap<String, Number>) -> CoreResult<Number> {
    let mut parser = Parser::new(expression, vars)?;
    let result = parser.expression(0)?;
    parser.space();
    if parser.pos != expression.len() {
        return Err(ContractError::validation("Unexpected expression suffix"));
    }
    Ok(result)
}

pub(super) fn run(handle: &mut ProjectHandle, input: &Value, origin: &Origin) -> CoreResult<Value> {
    let templates = all_templates();
    let template = if let Some(id) = input["templateId"].as_str() {
        Some(
            templates
                .into_iter()
                .find(|entry| entry["id"] == id)
                .ok_or_else(|| {
                    ContractError::new("NOT_FOUND", format!("Unknown template: {id}"))
                })?,
        )
    } else {
        None
    };
    let expression = template
        .as_ref()
        .and_then(|t| t["expression"].as_str())
        .or(input["expression"].as_str())
        .ok_or_else(|| {
            ContractError::validation("calculation.run needs templateId or expression")
        })?;
    let provided = input["inputs"]
        .as_array()
        .ok_or_else(|| ContractError::validation("Inputs must be an array"))?;
    let mut vars = HashMap::new();
    let mut payload_inputs = Vec::new();
    let mut refs = Vec::new();
    for item in provided {
        let name = required_str(item, "name")?;
        if !name
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            || matches!(
                name,
                "import"
                    | "eval"
                    | "function"
                    | "require"
                    | "process"
                    | "globalThis"
                    | "constructor"
                    | "prototype"
                    | "__proto__"
            )
        {
            return Err(ContractError::validation(format!(
                "Invalid input name '{name}'"
            )));
        }
        if item["quantity"]["unknown"] == true {
            return Err(ContractError::new(
                "INVALID_UNITS",
                format!(
                    "Input '{name}' is unknown ({})",
                    item["quantity"]["reason"].as_str().unwrap_or("no value")
                ),
            ));
        }
        vars.insert(name.to_owned(), quantity(&item["quantity"])?);
        payload_inputs.push(item.clone());
        if item["sourceRef"].is_object() {
            refs.push(json!({"artifactId":item["sourceRef"]["artifactId"],"revisionId":item["sourceRef"]["revisionId"],"relationship":"depends_on","label":format!("input {name}")}));
        }
    }
    if let Some(template) = &template {
        for required in template["inputs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|entry| entry["required"] == true)
        {
            let name = required_str(required, "name")?;
            let value = provided
                .iter()
                .find(|entry| entry["name"] == name)
                .ok_or_else(|| {
                    ContractError::new(
                        "INVALID_UNITS",
                        format!("Missing required input '{name}' ({})", required["unit"]),
                    )
                })?;
            let expected = unit(required_str(required, "unit")?)?;
            let actual = unit(required_str(&value["quantity"], "unit")?)?;
            if dimension(&expected.dim) != dimension(&actual.dim) {
                return Err(ContractError::new(
                    "INVALID_UNITS",
                    format!("Cannot convert {} to {}", actual.name, expected.name),
                ));
            }
        }
    }
    let output_name = template
        .as_ref()
        .and_then(|t| t["outputUnit"].as_str())
        .or_else(|| {
            provided
                .first()
                .and_then(|i| i["quantity"]["unit"].as_str())
        })
        .unwrap_or("1");
    let output = unit(output_name)?;
    let job_id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    handle.db.execute("INSERT INTO job(id,kind,tool,tool_version,inputs,input_hashes,command,status,log,output_hashes,error,session_id,created_at,started_at,finished_at) VALUES(?1,'calculation','calc',NULL,?2,'{}',NULL,'running','','{}',NULL,?3,?4,?4,NULL)",
        params![job_id,json!({"templateId":input["templateId"],"expression":expression,"experimental":true}).to_string(),origin.session_id(),timestamp]).map_err(internal)?;
    let result = evaluate(expression, &vars).and_then(|number| {
        if number.dim != Dim::ZERO && number.dim != dimension(&output.dim) {
            return Err(ContractError::new(
                "INVALID_UNITS",
                format!("Cannot convert calculation result to {output_name}"),
            ));
        }
        let value = if number.dim == Dim::ZERO && dimension(&output.dim) != Dim::ZERO {
            number.base
        } else {
            (number.base - output.offset) / output.scale
        };
        if !value.is_finite() {
            return Err(ContractError::validation("Result is not finite"));
        }
        Ok(value)
    });
    let value = match result {
        Ok(value) => value,
        Err(error) => {
            handle
                .db
                .execute(
                    "UPDATE job SET status='failed',error=?1,finished_at=?2 WHERE id=?3",
                    params![
                        json!({"code":error.code,"message":error.message}).to_string(),
                        now(),
                        job_id
                    ],
                )
                .map_err(internal)?;
            return Err(error);
        }
    };
    let mut limitations = template
        .as_ref()
        .and_then(|t| t["limitations"].as_array())
        .cloned()
        .unwrap_or_default();
    if !limitations.iter().any(|limit| limit == SCOPE) {
        limitations.push(json!(SCOPE));
    }
    let mut assumptions = template
        .as_ref()
        .and_then(|t| t["assumptions"].as_array())
        .cloned()
        .unwrap_or_default();
    assumptions.extend(
        input["assumptions"]
            .as_array()
            .into_iter()
            .flatten()
            .cloned(),
    );
    let mut payload = json!({"expression":expression,"inputs":payload_inputs,
        "assumptions":assumptions,"result":{"quantity":{"value":value,"unit":output.name}},
        "limitations":limitations,"toolVersion":"rust-restricted","ranAt":now(),"evidenceKind":"calculated"});
    if let Some(template_id) = input["templateId"].as_str() {
        payload["templateId"] = json!(template_id);
    }
    let created = if let Some(artifact_id) = input["artifactId"].as_str() {
        let artifact = require_artifact(handle, artifact_id)?;
        update_draft(
            handle,
            &json!({"artifactId":artifact_id,"baseRevisionId":artifact["selectedRevisionId"],
            "payload":payload,"files":[],"inputs":refs,"rationale":format!("run {}",input["templateId"].as_str().unwrap_or("expression"))}),
            origin,
        )?
    } else {
        create_draft(
            handle,
            &json!({"type":"calculation","title":input["title"].as_str().or_else(||template.as_ref().and_then(|t|t["title"].as_str())).unwrap_or("calculation"),
            "payload":payload,"files":[],"inputs":refs,"rationale":format!("run {}",input["templateId"].as_str().unwrap_or("expression"))}),
            origin,
        )?
    };
    let artifact_id = required_str(&created["artifact"], "id")?;
    let revision = created["revision"].clone();
    let proposal = if input["submitForReview"].as_bool().unwrap_or(true) {
        let selected = &created["artifact"]["selectedRevisionId"];
        let kind = if selected.is_null() {
            "new_artifact"
        } else {
            "baseline_update"
        };
        let p = proposal_submit(
            handle,
            &json!({"changes":[{"artifactId":artifact_id,"baseRevisionId":selected,
            "newRevisionId":revision["id"],"kind":kind}],"reason":format!("calculation result: {value} {}",output.name)}),
            origin,
        )?;
        p
    } else {
        Value::Null
    };
    handle
        .db
        .execute(
            "UPDATE job SET status='succeeded',output_hashes=?1,finished_at=?2 WHERE id=?3",
            params![
                json!({"revision":revision["id"]}).to_string(),
                now(),
                job_id
            ],
        )
        .map_err(internal)?;
    Ok(
        json!({"artifactId":artifact_id,"revision":revision,"result":{"value":value,"unit":output.name},
        "proposal":proposal,"experimental":true,"limitations":limitations}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_keep_dimensions_and_human_review_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let mut handle = ProjectHandle::create(temp.path().join("calc"), "Calc", "test").unwrap();
        let mass = run(
            &mut handle,
            &json!({"templateId":"mass_budget","inputs":[
            {"name":"payload","quantity":{"value":2,"unit":"kg"}},
            {"name":"chassis","quantity":{"value":500,"unit":"g"}},
            {"name":"electronics","quantity":{"value":0.25,"unit":"kg"}},
            {"name":"battery","quantity":{"value":1,"unit":"kg"}}
        ],"assumptions":[],"submitForReview":true}),
            &Origin::Agent {
                session_id: "agent-session".into(),
            },
        )
        .unwrap();
        assert_eq!(mass["result"]["value"], 3.75);
        assert_eq!(mass["result"]["unit"], "kg");
        assert_eq!(mass["proposal"]["state"], "pending");
        assert!(mass["revision"]["payload"]["limitations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == SCOPE));
        let artifact = require_artifact(&handle, mass["artifactId"].as_str().unwrap()).unwrap();
        assert!(artifact["selectedRevisionId"].is_null());
        let bad = run(
            &mut handle,
            &json!({"expression":"x + y","inputs":[
            {"name":"x","quantity":{"value":1,"unit":"kg"}},
            {"name":"y","quantity":{"value":1,"unit":"m"}}
        ],"assumptions":[],"submitForReview":false}),
            &Origin::User,
        )
        .unwrap_err();
        assert_eq!(bad.code, "INVALID_UNITS");
    }
}
