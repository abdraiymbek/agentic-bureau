//! File-scope OpenSCAD parameters: discovery, evaluation of derived values,
//! statement-accurate replacement and the `-D` override vocabulary.
//!
//! Discovery works on statements, not lines: comments, string literals,
//! braces, parentheses and brackets are tracked, so the arguments of a
//! multi-line call are never mistaken for assignments and a replacement can
//! only touch the right-hand side of the assignment it names.
use super::*;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ScadParam {
    pub name: String,
    /// Number, string or boolean. Derived parameters carry their evaluated number.
    pub value: Value,
    /// True when the right-hand side is an arithmetic expression, not a literal.
    pub derived: bool,
    pub expr: Option<String>,
    pub comment: Option<String>,
    /// One-based line of the assignment.
    pub line: usize,
    /// Byte range of the right-hand side in the source.
    span: Range<usize>,
}

/// The source with every comment blanked and every string interior replaced
/// by a filler, byte for byte, so offsets match the original.
struct Masked {
    code: Vec<u8>,
    /// Trailing `//` comment text by zero-based line.
    line_comments: HashMap<usize, String>,
}

const STRING_FILLER: u8 = b'_';

fn mask(source: &str) -> Masked {
    let bytes = source.as_bytes();
    let mut code = bytes.to_vec();
    let mut line_comments = HashMap::new();
    let mut line = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                line += 1;
                i += 1;
            }
            b'"' => {
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    if bytes[i] == b'\\' && i + 1 < bytes.len() {
                        code[i] = STRING_FILLER;
                        i += 1;
                    }
                    if bytes[i] == b'\n' {
                        line += 1;
                    } else {
                        code[i] = STRING_FILLER;
                    }
                    i += 1;
                }
                i += 1;
            }
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                let end = bytes[i..]
                    .iter()
                    .position(|b| *b == b'\n')
                    .map_or(bytes.len(), |offset| i + offset);
                let text = source[i + 2..end].trim();
                if !text.is_empty() {
                    line_comments.insert(line, text.to_owned());
                }
                code[i..end].fill(b' ');
                i = end;
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                let end = source[i + 2..]
                    .find("*/")
                    .map_or(bytes.len(), |offset| i + 2 + offset + 2);
                for (offset, byte) in bytes[i..end].iter().enumerate() {
                    if *byte == b'\n' {
                        line += 1;
                    } else {
                        code[i + offset] = b' ';
                    }
                }
                i = end;
            }
            _ => i += 1,
        }
    }
    Masked {
        code,
        line_comments,
    }
}

fn masked_text(source: &str) -> String {
    String::from_utf8_lossy(&mask(source).code).into_owned()
}

fn is_ident_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$'
}

fn is_ident(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// File-scope statements as byte ranges that end before their `;`. Blocks
/// (`module m() { … }`) are skipped whole.
fn file_scope_statements(code: &[u8]) -> Vec<Range<usize>> {
    let mut statements = Vec::new();
    let mut start = 0usize;
    let (mut braces, mut parens, mut brackets) = (0usize, 0usize, 0usize);
    let mut block = false;
    for (index, byte) in code.iter().enumerate() {
        match byte {
            b'{' => {
                braces += 1;
                block = true;
            }
            b'}' => {
                braces = braces.saturating_sub(1);
                if braces == 0 {
                    start = index + 1;
                    block = false;
                }
            }
            b'(' => parens += 1,
            b')' => parens = parens.saturating_sub(1),
            b'[' => brackets += 1,
            b']' => brackets = brackets.saturating_sub(1),
            b';' if braces == 0 && parens == 0 && brackets == 0 => {
                if !block {
                    statements.push(start..index);
                }
                start = index + 1;
                block = false;
            }
            _ => {}
        }
    }
    statements
}

fn literal(code: &str, original: &str) -> Option<Value> {
    match code {
        "true" => return Some(json!(true)),
        "false" => return Some(json!(false)),
        _ => {}
    }
    if let Some(number) = parse_number(code) {
        return Some(number_value(number));
    }
    let bytes = code.as_bytes();
    if bytes.len() >= 2
        && bytes[0] == b'"'
        && bytes[bytes.len() - 1] == b'"'
        && bytes[1..bytes.len() - 1]
            .iter()
            .all(|byte| *byte == STRING_FILLER)
    {
        return Some(json!(unescape(&original[1..original.len() - 1])));
    }
    None
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// A decimal literal exactly as OpenSCAD writes one; `inf` and `nan` are not numbers here.
fn parse_number(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut i = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        i += 1;
    }
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let whole = digits(i);
    i += whole;
    let mut fraction = 0;
    if bytes.get(i) == Some(&b'.') {
        fraction = digits(i + 1);
        i += 1 + fraction;
    }
    if whole + fraction == 0 {
        return None;
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        let mut j = i + 1;
        if matches!(bytes.get(j), Some(b'+' | b'-')) {
            j += 1;
        }
        let exponent = digits(j);
        if exponent == 0 {
            return None;
        }
        i = j + exponent;
    }
    if i != bytes.len() {
        return None;
    }
    text.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// JSON number without a spurious fraction: `10`, not `10.0`.
pub(crate) fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Number(f64),
    Name(String),
    Op(u8),
}

fn tokenize(expr: &str) -> Option<Vec<Token>> {
    let bytes = expr.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if byte.is_ascii_whitespace() {
            i += 1;
        } else if b"+-*/()".contains(&byte) {
            tokens.push(Token::Op(byte));
            i += 1;
        } else if byte.is_ascii_digit() || byte == b'.' {
            let mut end = i;
            while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
                end += 1;
            }
            if matches!(bytes.get(end), Some(b'e' | b'E')) {
                let mut exponent = end + 1;
                if matches!(bytes.get(exponent), Some(b'+' | b'-')) {
                    exponent += 1;
                }
                if bytes.get(exponent).is_some_and(u8::is_ascii_digit) {
                    end = exponent;
                    while end < bytes.len() && bytes[end].is_ascii_digit() {
                        end += 1;
                    }
                }
            }
            tokens.push(Token::Number(parse_number(&expr[i..end])?));
            i = end;
        } else if is_ident_start(byte) {
            let mut end = i + 1;
            while end < bytes.len() && is_ident(bytes[end]) {
                end += 1;
            }
            tokens.push(Token::Name(expr[i..end].to_owned()));
            i = end;
        } else {
            return None;
        }
    }
    Some(tokens)
}

/// File-scope arithmetic: `+ - * /` and parentheses over numbers and earlier names.
struct Evaluator<'a> {
    tokens: &'a [Token],
    at: usize,
    env: &'a HashMap<String, f64>,
}

impl Evaluator<'_> {
    fn peek_op(&self) -> Option<u8> {
        match self.tokens.get(self.at) {
            Some(Token::Op(op)) => Some(*op),
            _ => None,
        }
    }

    fn sum(&mut self) -> Option<f64> {
        let mut value = self.product()?;
        while let Some(op @ (b'+' | b'-')) = self.peek_op() {
            self.at += 1;
            let rhs = self.product()?;
            value = if op == b'+' { value + rhs } else { value - rhs };
        }
        Some(value)
    }

    fn product(&mut self) -> Option<f64> {
        let mut value = self.unary()?;
        while let Some(op @ (b'*' | b'/')) = self.peek_op() {
            self.at += 1;
            let rhs = self.unary()?;
            if op == b'/' && rhs == 0.0 {
                return None;
            }
            value = if op == b'*' { value * rhs } else { value / rhs };
        }
        Some(value)
    }

    fn unary(&mut self) -> Option<f64> {
        match self.peek_op() {
            Some(b'-') => {
                self.at += 1;
                self.unary().map(|value| -value)
            }
            Some(b'+') => {
                self.at += 1;
                self.unary()
            }
            _ => self.atom(),
        }
    }

    fn atom(&mut self) -> Option<f64> {
        let token = self.tokens.get(self.at)?;
        self.at += 1;
        match token {
            Token::Number(value) => Some(*value),
            Token::Name(name) => self.env.get(name).copied(),
            Token::Op(b'(') => {
                let value = self.sum()?;
                (self.peek_op() == Some(b')')).then(|| {
                    self.at += 1;
                    value
                })
            }
            Token::Op(_) => None,
        }
    }
}

fn evaluate(expr: &str, env: &HashMap<String, f64>) -> Option<f64> {
    let tokens = tokenize(expr)?;
    if tokens.is_empty() {
        return None;
    }
    let mut evaluator = Evaluator {
        tokens: &tokens,
        at: 0,
        env,
    };
    let value = evaluator.sum()?;
    (evaluator.at == tokens.len() && value.is_finite()).then_some(value)
}

/// Every file-scope `name = value;` whose value is a literal or arithmetic
/// over earlier parameters. Vectors, function calls and anything else that
/// cannot be evaluated here are left out rather than reported as unknown.
pub(crate) fn parameters(source: &str) -> Vec<ScadParam> {
    let masked = mask(source);
    let code = &masked.code;
    let mut env = HashMap::<String, f64>::new();
    let mut out = Vec::new();
    for statement in file_scope_statements(code) {
        let mut at = statement.start;
        while at < statement.end && code[at].is_ascii_whitespace() {
            at += 1;
        }
        if at >= statement.end || !is_ident_start(code[at]) {
            continue;
        }
        let name_start = at;
        at += 1;
        while at < statement.end && is_ident(code[at]) {
            at += 1;
        }
        let name = &source[name_start..at];
        while at < statement.end && code[at].is_ascii_whitespace() {
            at += 1;
        }
        if code.get(at) != Some(&b'=') || code.get(at + 1) == Some(&b'=') || at >= statement.end {
            continue;
        }
        let mut rhs_start = at + 1;
        while rhs_start < statement.end && code[rhs_start].is_ascii_whitespace() {
            rhs_start += 1;
        }
        let mut rhs_end = statement.end;
        while rhs_end > rhs_start && code[rhs_end - 1].is_ascii_whitespace() {
            rhs_end -= 1;
        }
        if rhs_start >= rhs_end {
            continue;
        }
        let rhs_code = String::from_utf8_lossy(&code[rhs_start..rhs_end]).into_owned();
        let line_of = |offset: usize| source[..offset].bytes().filter(|b| *b == b'\n').count();
        let comment = masked.line_comments.get(&line_of(statement.end)).cloned();
        let (value, derived) = match literal(&rhs_code, &source[rhs_start..rhs_end]) {
            Some(value) => (value, false),
            None => match evaluate(&rhs_code, &env) {
                Some(number) => (number_value(number), true),
                None => continue,
            },
        };
        if let Some(number) = value.as_f64() {
            env.insert(name.to_owned(), number);
        } else {
            env.remove(name);
        }
        out.push(ScadParam {
            name: name.to_owned(),
            value,
            derived,
            expr: derived.then(|| rhs_code.split_whitespace().collect::<Vec<_>>().join(" ")),
            comment,
            line: line_of(name_start) + 1,
            span: rhs_start..rhs_end,
        });
    }
    out
}

pub(crate) fn param_json(param: &ScadParam) -> Value {
    let mut item = json!({"name": param.name, "value": param.value, "derived": param.derived});
    if let Some(expr) = &param.expr {
        item["expr"] = json!(expr);
    }
    if let Some(comment) = &param.comment {
        item["comment"] = json!(comment);
    }
    item
}

/// The literal OpenSCAD reads back as exactly this value.
pub(crate) fn format_value(name: &str, value: &Value) -> CoreResult<String> {
    match value {
        Value::Bool(flag) => Ok(flag.to_string()),
        Value::String(text) => serde_json::to_string(text).map_err(internal),
        Value::Number(number) => {
            let number = number
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| {
                    ContractError::validation(format!("Parameter {name} is not a finite number"))
                })?;
            Ok(number_value(number).to_string())
        }
        _ => Err(
            ContractError::validation(format!("Unsupported CAD parameter value: {name}"))
                .with_repair("Send a plain number, string or boolean in model units (mm)."),
        ),
    }
}

fn unknown_parameter(names: &[&str], declared: &[ScadParam]) -> ContractError {
    let available = declared
        .iter()
        .map(|param| param.name.as_str())
        .collect::<Vec<_>>();
    let listing = if available.is_empty() {
        "The source declares no top-level variables; add `name = value;` lines at file scope to make it parametric.".to_owned()
    } else {
        format!(
            "Top-level variables in this source: {}.",
            available.join(", ")
        )
    };
    let nearest = names
        .iter()
        .filter_map(|name| {
            omenflow_contracts::nearest_match(name, available.iter().copied())
                .map(|found| format!("{name} → {found}"))
        })
        .collect::<Vec<_>>();
    let repair = if nearest.is_empty() {
        "Call cad_read_source and use a name from parameters.".to_owned()
    } else {
        format!(
            "Did you mean {}? Call cad_read_source to list the parameters.",
            nearest.join(", ")
        )
    };
    ContractError::validation(format!(
        "Unknown parameter{}: {}. {listing}",
        if names.len() > 1 { "s" } else { "" },
        names.join(", ")
    ))
    .with_repair(repair)
    .with_details(json!({"unknown": names, "available": available}))
}

/// Replace the right-hand side of the effective file-scope assignment of
/// `name`. OpenSCAD lets the last assignment win, so that is the one edited.
pub(crate) fn set_param_source(source: &str, name: &str, value: &Value) -> CoreResult<String> {
    let declared = parameters(source);
    let param = declared
        .iter()
        .rev()
        .find(|param| param.name == name)
        .ok_or_else(|| unknown_parameter(&[name], &declared))?;
    let replacement = format_value(name, value)?;
    let mut out = String::with_capacity(source.len() + replacement.len());
    out.push_str(&source[..param.span.start]);
    out.push_str(&replacement);
    out.push_str(&source[param.span.end..]);
    Ok(out)
}

fn unit_table() -> &'static HashMap<String, (String, f64)> {
    static UNITS: OnceLock<HashMap<String, (String, f64)>> = OnceLock::new();
    UNITS.get_or_init(|| {
        let raw: HashMap<String, Value> =
            serde_json::from_str(include_str!("../../units.json")).expect("frozen contract units");
        raw.into_iter()
            .filter(|(_, unit)| unit["offset"].as_f64().unwrap_or(0.0) == 0.0)
            .filter_map(|(name, unit)| {
                Some((
                    name,
                    (unit["dim"].as_str()?.to_owned(), unit["scale"].as_f64()?),
                ))
            })
            .collect()
    })
}

/// Model coordinates are millimetres and degrees. A typed quantity is
/// converted deliberately; a unit of any other dimension is refused.
fn quantity_in_model_units(name: &str, quantity: &Value) -> CoreResult<f64> {
    let value = quantity["value"]
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| ContractError::validation(format!("Non-finite parameter {name}")))?;
    let unit = quantity["unit"].as_str().unwrap_or("");
    let (dimension, scale) = unit_table().get(unit).ok_or_else(|| {
        ContractError::new(
            "INVALID_UNITS",
            format!("CAD parameter {name} has unknown unit '{unit}'"),
        )
    })?;
    let target = match dimension.as_str() {
        "length" => "mm",
        "angle" => "deg",
        "dimensionless" => "1",
        other => {
            return Err(ContractError::new(
                "INVALID_UNITS",
                format!("CAD parameter {name} has unsupported {other} unit {unit}"),
            )
            .with_repair("CAD parameters are lengths (converted to mm), angles (converted to degrees) or plain numbers."))
        }
    };
    Ok(value * scale / unit_table()[target].1)
}

/// Recorded or requested parameters as plain OpenSCAD values.
pub(crate) fn effective_params(params: &Value) -> CoreResult<serde_json::Map<String, Value>> {
    let mut out = serde_json::Map::new();
    for (name, value) in params.as_object().into_iter().flatten() {
        let valid_name = name.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                is_ident_start(byte)
            } else {
                is_ident(byte)
            }
        });
        if name.is_empty() || !valid_name {
            return Err(ContractError::validation(format!(
                "Invalid CAD parameter name: {name}"
            )));
        }
        let plain = if value.is_object() && value.get("unit").is_some() {
            number_value(quantity_in_model_units(name, value)?)
        } else if let Some(number) = value.as_f64() {
            if !number.is_finite() {
                return Err(ContractError::validation(format!(
                    "Non-finite parameter {name}"
                )));
            }
            number_value(number)
        } else if value.is_string() || value.is_boolean() {
            value.clone()
        } else {
            return Err(ContractError::validation(format!(
                "Unsupported CAD parameter value: {name}"
            ))
            .with_repair("Send a plain number, string or boolean in model units (mm)."));
        };
        out.insert(name.clone(), plain);
    }
    Ok(out)
}

/// `-D` overrides: every key must be a declared file-scope parameter.
pub(crate) fn override_params(input: &Value, declared: &[ScadParam]) -> CoreResult<Value> {
    let params = effective_params(input)?;
    let unknown = params
        .keys()
        .map(String::as_str)
        .filter(|name| !declared.iter().any(|param| param.name == *name))
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(unknown_parameter(&unknown, declared));
    }
    Ok(Value::Object(params))
}

/// An inherited override survives a rewrite only while the declaration it
/// overrides is unchanged; editing the declaration is the newer intent.
pub(crate) fn inherited_overrides(
    source: &str,
    previous_source: &str,
    recorded: &serde_json::Map<String, Value>,
) -> serde_json::Map<String, Value> {
    let effective = |declared: &[ScadParam], name: &str| {
        declared
            .iter()
            .rev()
            .find(|param| param.name == name)
            .map(|param| (param.value.clone(), param.expr.clone()))
    };
    let before = parameters(previous_source);
    let after = parameters(source);
    recorded
        .iter()
        .filter(|(name, _)| {
            let now = effective(&after, name);
            now.is_some() && {
                let then = effective(&before, name);
                then.is_none() || then == now
            }
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn curved(code: &str) -> bool {
    static CURVED: OnceLock<regex::Regex> = OnceLock::new();
    CURVED
        .get_or_init(|| {
            regex::Regex::new(r"\b(cylinder|sphere|circle|rotate_extrude)\s*\(")
                .expect("static pattern")
        })
        .is_match(code)
}

/// Does the source build anything from circles? Such a part renders faceted,
/// so its mesh never equals the analytic shape exactly.
pub(crate) fn uses_curved_primitives(source: &str) -> bool {
    curved(&masked_text(source))
}

/// Prepend `$fn = 64;` when curved primitives are used and `$fn` is never
/// set, so circles do not render as the default coarse polygon.
pub(crate) fn with_default_facets(source: &str) -> (String, bool) {
    static SETS_FN: OnceLock<regex::Regex> = OnceLock::new();
    let code = masked_text(source);
    let sets_fn = SETS_FN.get_or_init(|| regex::Regex::new(r"\$fn\s*=").expect("static pattern"));
    if sets_fn.is_match(&code) || !curved(&code) {
        (source.to_owned(), false)
    } else {
        (format!("$fn = 64;\n{source}"), true)
    }
}

/// V0.1 renders self-contained source only: host files, fonts and random
/// numbers cannot silently change a part.
pub(crate) fn assert_self_contained(source: &str) -> CoreResult<()> {
    static EXTERNAL: OnceLock<regex::Regex> = OnceLock::new();
    let external = EXTERNAL.get_or_init(|| {
        regex::Regex::new(r"\b(?:include|use)\s*<|\b(?:import|surface|text|rands)\s*\(")
            .expect("static pattern")
    });
    if external.is_match(&masked_text(source)) {
        return Err(ContractError::validation("V0.1 CAD source must be self-contained; include/use/import/surface, host-font text() and random rands() dependencies are not yet reproducibly pinned.")
            .with_repair("Inline the geometry, use explicit dimensions, and build shapes directly without host fonts or random calls."));
    }
    Ok(())
}

/// Dimension recorded for a parameter the first time it is seen.
pub(crate) fn inferred_dimension(param: &ScadParam) -> &'static str {
    if param.value.is_boolean() {
        "boolean"
    } else if param.value.is_string() {
        "text"
    } else if param.name == "$fn" {
        "count"
    } else {
        "number"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(source: &str) -> Vec<(String, Value, bool)> {
        parameters(source)
            .into_iter()
            .map(|param| (param.name, param.value, param.derived))
            .collect()
    }

    #[test]
    fn file_scope_literals_are_parameters() {
        assert_eq!(
            summary("w = 100;\n// hole\nhole_d = 8.4;\n$fn = 64;\n"),
            vec![
                ("w".to_owned(), json!(100), false),
                ("hole_d".to_owned(), json!(8.4), false),
                ("$fn".to_owned(), json!(64), false),
            ]
        );
    }

    #[test]
    fn derived_expressions_are_evaluated_and_keep_their_text() {
        let declared = parameters(
            "\n  plate_w = 60;\n  plate_d = 40;\n  height = 2 * plate_w;\n  inset = plate_w / 2 - 5;\n  label = \"mount\";\n",
        );
        let by = |name: &str| declared.iter().find(|p| p.name == name).unwrap();
        assert!(by("height").derived);
        assert_eq!(by("height").expr.as_deref(), Some("2 * plate_w"));
        assert_eq!(by("height").value, json!(120));
        assert!(by("inset").derived);
        assert_eq!(by("inset").value, json!(25));
        assert_eq!(by("label").value, json!("mount"));
        assert!(!by("label").derived);
        assert_eq!(by("height").line, 4);
    }

    #[test]
    fn module_bodies_and_call_arguments_are_not_parameters() {
        assert_eq!(
            summary("w = 10;\nmodule m() { h = 99; cube(h); }\n"),
            vec![("w".to_owned(), json!(10), false)]
        );
        let multiline =
            "translate([0,0,5])\n  cylinder(\n    h = 10,\n    d = 5\n  );\nwall = 2;\n";
        assert_eq!(
            summary(multiline),
            vec![("wall".to_owned(), json!(2), false)]
        );
        assert_eq!(
            summary("function f(x) = x * 2;\nfor (i = [0:3]) cube(i);\nif (a == 1) cube(1);\n"),
            vec![]
        );
    }

    #[test]
    fn values_that_cannot_be_evaluated_are_left_out_instead_of_reported_unknown() {
        assert_eq!(
            summary("size = [40, 30, 4];\nr = sqrt(2);\nbad = inf;\nq = nan;\nok = 3;\nzero = ok / 0;\n"),
            vec![("ok".to_owned(), json!(3), false)]
        );
    }

    #[test]
    fn comments_and_strings_do_not_confuse_the_scanner() {
        let source = "/* w = 1; */\nlabel = \"a; b // not a comment\"; // shown text\n// x = 2;\nw = 4; /* block */ d = w * 2; // both\n";
        let declared = parameters(source);
        assert_eq!(
            declared.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["label", "w", "d"]
        );
        assert_eq!(declared[0].value, json!("a; b // not a comment"));
        assert_eq!(declared[0].comment.as_deref(), Some("shown text"));
        assert_eq!(declared[2].value, json!(8));
        assert_eq!(declared[2].comment.as_deref(), Some("both"));
    }

    #[test]
    fn set_param_replaces_only_the_named_assignment() {
        assert_eq!(
            set_param_source(
                "w = 100;\nhole_d = 8;\ncube([w, 40, 6]);\n",
                "hole_d",
                &json!(10)
            )
            .unwrap(),
            "w = 100;\nhole_d = 10;\ncube([w, 40, 6]);\n"
        );
        assert_eq!(
            set_param_source("width = 20; h = 5;\n", "h", &json!(7)).unwrap(),
            "width = 20; h = 7;\n"
        );
        assert_eq!(
            set_param_source(
                "w = 10;\nmodule m() { w = 99; cube(w); }\n",
                "w",
                &json!(12)
            )
            .unwrap(),
            "w = 12;\nmodule m() { w = 99; cube(w); }\n"
        );
        assert_eq!(
            set_param_source(
                "plate_w = 60;\nheight = 2 * plate_w;\n",
                "height",
                &json!(80.0)
            )
            .unwrap(),
            "plate_w = 60;\nheight = 80;\n"
        );
        assert_eq!(
            set_param_source("w = 10 /* mm */ ; // width\n", "w", &json!(12.5)).unwrap(),
            "w = 12.5 /* mm */ ; // width\n"
        );
    }

    #[test]
    fn set_param_never_touches_call_arguments_and_edits_the_effective_assignment() {
        let source = "cylinder(\n  h = 10,\n  d = 5\n);\n";
        let error = set_param_source(source, "h", &json!(7)).unwrap_err();
        assert_eq!(error.code, "VALIDATION");
        assert!(error.message.contains("declares no top-level variables"));
        assert_eq!(
            set_param_source("$fn = 64;\n$fn=96;\nsphere(2);\n", "$fn", &json!(32)).unwrap(),
            "$fn = 64;\n$fn=32;\nsphere(2);\n"
        );
    }

    #[test]
    fn set_param_writes_strings_and_booleans_as_openscad_literals() {
        assert_eq!(
            set_param_source("label = \"before\";\n", "label", &json!("$& $1 \"q\"")).unwrap(),
            "label = \"$& $1 \\\"q\\\"\";\n"
        );
        assert_eq!(
            set_param_source("flag = false;\n", "flag", &json!(true)).unwrap(),
            "flag = true;\n"
        );
        let error = set_param_source("w = 1;\n", "w", &json!([1, 2])).unwrap_err();
        assert!(error.message.contains("Unsupported"));
    }

    #[test]
    fn unknown_names_list_what_exists_and_the_nearest_match() {
        let error = set_param_source("hole_d = 8;\nw = 2;\n", "hole_dia", &json!(8)).unwrap_err();
        assert!(error.message.contains("hole_d, w"), "{}", error.message);
        assert!(error.repair.unwrap().contains("hole_dia → hole_d"));
        let declared = parameters("w = 2;\n");
        let error = override_params(&json!({"w": 3, "depth": 4}), &declared).unwrap_err();
        assert_eq!(error.details.unwrap()["unknown"], json!(["depth"]));
    }

    #[test]
    fn typed_quantities_become_model_units_and_other_dimensions_are_refused() {
        let params = effective_params(&json!({
            "w": {"value": 2, "unit": "cm"},
            "tilt": {"value": 1, "unit": "rad"},
            "n": 4.0,
            "label": "a",
            "on": true,
        }))
        .unwrap();
        assert_eq!(params["w"], json!(20));
        assert!((params["tilt"].as_f64().unwrap() - 57.29577951308232).abs() < 1e-9);
        assert_eq!(params["n"], json!(4));
        assert_eq!(params["label"], json!("a"));
        assert_eq!(params["on"], json!(true));
        let error = effective_params(&json!({"m": {"value": 2, "unit": "kg"}})).unwrap_err();
        assert_eq!(error.code, "INVALID_UNITS");
        assert_eq!(
            effective_params(&json!({"bad name": 1})).unwrap_err().code,
            "VALIDATION"
        );
    }

    #[test]
    fn inherited_overrides_survive_only_an_unchanged_declaration() {
        let recorded = json!({"w": 30, "h": 9}).as_object().cloned().unwrap();
        let kept = inherited_overrides("w = 20;\nh = 6;\n", "w = 20;\nh = 5;\n", &recorded);
        assert_eq!(Value::Object(kept), json!({"w": 30}));
        let dropped = inherited_overrides("h = 5;\n", "w = 20;\nh = 5;\n", &recorded);
        assert_eq!(Value::Object(dropped), json!({"h": 9}));
    }

    #[test]
    fn default_facets_are_injected_once_and_only_for_curved_source() {
        let (source, injected) =
            with_default_facets("difference(){ cube(10); cylinder(d=4,h=12); }");
        assert!(injected);
        assert!(source.starts_with("$fn = 64;\n"));
        assert!(!with_default_facets("$fn = 12;\ncylinder(d=4,h=10);").1);
        assert!(!with_default_facets("$fn=96;\nsphere(2);").1);
        assert!(!with_default_facets("cube([10,20,30]);").1);
        assert!(with_default_facets("// $fn = 12;\nsphere(2);").1);
    }

    #[test]
    fn external_dependencies_are_refused_but_not_inside_strings_or_comments() {
        assert!(assert_self_contained("use <lib.scad>\ncube(1);").is_err());
        assert!(assert_self_contained("import(\"a.stl\");").is_err());
        assert!(assert_self_contained("text(\"hi\");").is_err());
        assert!(assert_self_contained("// use <lib.scad>\necho(\"import(x)\");\ncube(1);").is_ok());
    }
}
