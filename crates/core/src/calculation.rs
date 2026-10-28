//! Unit-aware calculations. Inputs are quantities, the expression is plain
//! arithmetic over their names, and the result takes its unit from the
//! dimensions of the expression or from an output unit the caller declares.
//! A result is never labelled with a unit it does not have.
use super::*;
use units::{Coherent, Dim, Unit};

const SCOPE: &str = "Experimental: referenced source values are labels, not resolved revision fields; supplied quantities are used as given. The result unit comes from the dimensions of the expression or from the declared output unit. Do not treat results as verified engineering evidence.";

/// Recorded with every result and job, so a reader can tell which evaluator
/// produced a number.
/// Recorded with every calculation run. Runs before the rename recorded
/// `omenflow-calc/2`, the same engine; the label is provenance, never compared.
const ENGINE: &str = "bureau-calc/2";

const MAX_EXPRESSION_CHARS: usize = 2000;
const MAX_TOKENS: usize = 512;
const MAX_DEPTH: usize = 64;

const FUNCTIONS: [&str; 30] = [
    "abs", "acos", "asin", "atan", "atan2", "cbrt", "ceil", "cos", "cosh", "exp", "floor", "hypot",
    "ln", "log", "log10", "log2", "max", "mean", "min", "mod", "pow", "round", "sign", "sin",
    "sinh", "sqrt", "sum", "tan", "tanh", "nthRoot",
];
const CONSTANTS: [(&str, f64); 3] = [
    ("pi", std::f64::consts::PI),
    ("e", std::f64::consts::E),
    ("tau", std::f64::consts::TAU),
];
const SYNTAX: &str = "An expression may use numbers, input names, + - * / % ^, parentheses, the constants pi, e and tau, and functions such as min, max, abs, sqrt, cbrt, hypot, round, floor, ceil, sin, cos, tan, asin, acos, atan, atan2, exp, ln, log10 and mod. Units belong on the inputs, not in the expression.";

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

/// What a value stands for beyond its number and dimension.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Plain,
    /// A temperature on a scale with a zero offset (degrees Celsius).
    Point,
    /// The difference of two such temperatures: the offset no longer applies.
    Difference,
    /// The outcome of a comparison, one or zero.
    Truth,
}

#[derive(Clone, Debug)]
struct Number {
    /// Value in coherent SI base units.
    base: f64,
    dim: Dim,
    /// The unit this value is known to be expressed in: the unit of an input,
    /// kept through sums of the same unit and scaling by a plain number.
    unit: Option<Unit>,
    kind: Kind,
}

impl Number {
    fn plain(value: f64) -> Self {
        Self {
            base: value,
            dim: Dim::NONE,
            unit: None,
            kind: Kind::Plain,
        }
    }

    fn of(value: f64, unit: Unit) -> Self {
        Self {
            base: unit.to_base(value),
            dim: unit.dim,
            kind: if unit.has_offset() {
                Kind::Point
            } else {
                Kind::Plain
            },
            unit: Some(unit),
        }
    }

    /// A bare number: a literal or a ratio, with no unit attached.
    fn is_bare(&self) -> bool {
        self.dim.is_none() && self.unit.is_none()
    }

    /// The value in its own unit, when it has one.
    fn in_unit(&self) -> Option<(f64, &Unit)> {
        let unit = self.unit.as_ref()?;
        Some(match self.kind {
            Kind::Difference => (unit.difference_of(self.base), unit),
            _ => (unit.value_of(self.base), unit),
        })
    }

    fn describe(&self) -> String {
        match &self.unit {
            Some(unit) => format!("{} ({})", unit.name, unit.measures()),
            None if self.dim.is_none() => "a plain number".into(),
            None => self.dim.si_expression(),
        }
    }
}

fn units_error(message: impl Into<String>, repair: &str) -> ContractError {
    ContractError::new("INVALID_UNITS", message).with_repair(repair)
}

fn not_finite() -> ContractError {
    ContractError::validation("Result is not a finite real number")
        .with_repair("Check for a division by zero, the root or logarithm of a negative number, or an inverse sine or cosine outside -1 to 1.")
}

fn finite(number: Number) -> CoreResult<Number> {
    if number.base.is_finite() {
        Ok(number)
    } else {
        Err(not_finite())
    }
}

fn overflow() -> ContractError {
    units_error(
        "The units of the expression have an exponent that is too large",
        "Simplify the expression so that no unit is raised beyond the 127th power.",
    )
}

fn common_unit(a: &Number, b: &Number) -> Option<Unit> {
    match (&a.unit, &b.unit) {
        (Some(left), Some(right)) if left.name == right.name => Some(left.clone()),
        _ => None,
    }
}

fn same_dimension(operation: &str, a: &Number, b: &Number) -> CoreResult<()> {
    if a.dim == b.dim {
        return Ok(());
    }
    Err(units_error(
        format!(
            "Incompatible units in {operation}: {} and {}",
            a.describe(),
            b.describe()
        ),
        "Both sides must measure the same thing. Convert one input, or multiply or divide by the quantity that relates them.",
    ))
}

fn add(a: &Number, b: &Number, subtract: bool) -> CoreResult<Number> {
    same_dimension(if subtract { "subtraction" } else { "addition" }, a, b)?;
    let (kind, unit) = match (a.kind, b.kind, subtract) {
        (Kind::Point, Kind::Point, false) => {
            return Err(units_error(
                "Adding two temperatures on a scale with a zero offset has no physical meaning",
                "Subtract them for a temperature difference, or give the rise in K and add it to one temperature.",
            ))
        }
        (Kind::Point, Kind::Point, true) => (Kind::Difference, None),
        // A temperature moved by a difference, or by a rise given in kelvin,
        // is a temperature on the same scale.
        (Kind::Point, Kind::Difference, _) | (Kind::Point, _, false) => {
            (Kind::Point, a.unit.clone())
        }
        (_, Kind::Point, false) => (Kind::Point, b.unit.clone()),
        (Kind::Difference, Kind::Difference, _) => (Kind::Difference, None),
        // A value in kelvin taken from a temperature, or a temperature taken
        // from one: the record cannot say whether a temperature or a
        // difference results, so the result stays in kelvin.
        (Kind::Point, _, true) | (_, Kind::Point, true) => (Kind::Plain, None),
        _ => (Kind::Plain, common_unit(a, b)),
    };
    finite(Number {
        base: if subtract {
            a.base - b.base
        } else {
            a.base + b.base
        },
        dim: a.dim,
        unit,
        kind,
    })
}

fn multiply(a: &Number, b: &Number) -> CoreResult<Number> {
    // Scaling by a dimensionless number, a percentage included, keeps the
    // unit of the other operand; of two candidates the one with a unit wins.
    let carried = |value: &Number, factor: &Number| factor.dim.is_none().then(|| scaled(value));
    let (unit, kind) = match (carried(a, b), carried(b, a)) {
        (Some(kept @ (Some(_), _)), _) | (_, Some(kept @ (Some(_), _))) => kept,
        (Some(kept), _) | (_, Some(kept)) => kept,
        (None, None) => (None, Kind::Plain),
    };
    finite(Number {
        base: a.base * b.base,
        dim: a.dim.plus(b.dim).ok_or_else(overflow)?,
        unit,
        kind,
    })
}

fn divide(a: &Number, b: &Number) -> CoreResult<Number> {
    if b.base == 0.0 {
        return Err(ContractError::validation("Division by zero")
            .with_repair("Check the input that the expression divides by."));
    }
    // Dividing by a bare number keeps the unit; dividing by anything with a
    // unit, a percentage included, gives a new quantity or a plain ratio.
    let (unit, kind) = if b.is_bare() {
        scaled(a)
    } else {
        (None, Kind::Plain)
    };
    finite(Number {
        base: a.base / b.base,
        dim: a.dim.minus(b.dim).ok_or_else(overflow)?,
        unit,
        kind,
    })
}

/// What a value keeps when it is scaled by a dimensionless number: its unit,
/// unless that unit has a zero offset, and the fact that it is a difference.
fn scaled(value: &Number) -> (Option<Unit>, Kind) {
    let unit = value.unit.clone().filter(|unit| !unit.has_offset());
    let kind = if value.kind == Kind::Difference {
        Kind::Difference
    } else {
        Kind::Plain
    };
    (unit, kind)
}

fn power(a: &Number, b: &Number) -> CoreResult<Number> {
    if !b.dim.is_none() {
        return Err(units_error(
            format!("An exponent must be a plain number, not {}", b.describe()),
            "Divide the exponent by a quantity in the same unit so that it is dimensionless.",
        ));
    }
    let dim = if a.dim.is_none() {
        Dim::NONE
    } else {
        a.dim.powered(b.base).ok_or_else(|| {
            units_error(
                format!(
                    "Cannot raise {} to the power {}: the result is not a whole power of the base units",
                    a.describe(),
                    units::format_number(b.base)
                ),
                "Use an exponent that leaves whole powers (area ^ 0.5, volume ^ (1/3)), or raise a dimensionless ratio instead.",
            )
        })?
    };
    finite(Number {
        base: a.base.powf(b.base),
        dim,
        unit: None,
        kind: Kind::Plain,
    })
}

fn root(name: &str, a: &Number, degree: f64) -> CoreResult<Number> {
    let dim = a.dim.powered(1.0 / degree).ok_or_else(|| {
        units_error(
            format!(
                "Cannot take {name} of {}: the result is not a whole power of the base units",
                a.describe()
            ),
            "Take the root of a quantity whose unit is a matching power, such as sqrt of an area or cbrt of a volume.",
        )
    })?;
    let base = if degree == 2.0 {
        a.base.sqrt()
    } else if degree == 3.0 {
        a.base.cbrt()
    } else if a.base < 0.0 && degree % 2.0 == 1.0 {
        -(-a.base).powf(1.0 / degree)
    } else {
        a.base.powf(1.0 / degree)
    };
    finite(Number {
        base,
        dim,
        unit: None,
        kind: Kind::Plain,
    })
}

fn compare(operator: &str, a: &Number, b: &Number) -> CoreResult<Number> {
    same_dimension("comparison", a, b)?;
    let truth = match operator {
        ">" => a.base > b.base,
        "<" => a.base < b.base,
        ">=" => a.base >= b.base,
        "<=" => a.base <= b.base,
        "==" => a.base == b.base,
        _ => a.base != b.base,
    };
    Ok(Number {
        kind: Kind::Truth,
        ..Number::plain(f64::from(u8::from(truth)))
    })
}

fn modulo(a: &Number, b: &Number) -> CoreResult<Number> {
    same_dimension("remainder", a, b)?;
    if b.base == 0.0 {
        return Err(ContractError::validation("Remainder of a division by zero")
            .with_repair("Check the input that the expression divides by."));
    }
    // The sign follows the divisor, as mathjs and Python define mod.
    let remainder = a.base - b.base * (a.base / b.base).floor();
    finite(Number {
        base: remainder,
        dim: a.dim,
        unit: common_unit(a, b),
        kind: Kind::Plain,
    })
}

fn dimensionless(name: &str, a: &Number) -> CoreResult<f64> {
    if a.dim.is_none() {
        return Ok(a.base);
    }
    Err(units_error(
        format!("{name} needs a plain number, not {}", a.describe()),
        "Divide by a quantity in the same unit first, so the argument is a ratio.",
    ))
}

/// Round in the unit the value is expressed in, never in SI base units:
/// `ceil` of 12.3 mm is 13 mm.
fn round_with(name: &str, a: &Number, places: f64, round: fn(f64) -> f64) -> CoreResult<Number> {
    let factor = 10_f64.powf(places);
    let apply = |value: f64| round(value * factor) / factor;
    if let Some((value, unit)) = a.in_unit() {
        let rounded = apply(value);
        let base = if a.kind == Kind::Difference {
            rounded * unit.scale
        } else {
            unit.to_base(rounded)
        };
        return finite(Number { base, ..a.clone() });
    }
    if a.dim.is_none() {
        return finite(Number::plain(apply(a.base)));
    }
    Err(units_error(
        format!(
            "{name} cannot tell which unit to round {} in",
            a.describe()
        ),
        "Give every term in the same unit, or divide by a quantity in the unit you want first, for example ceil(length / step) * step.",
    ))
}

fn angle_argument(name: &str, a: &Number) -> CoreResult<f64> {
    if a.dim.is_none() || a.dim == units::dimension("angle") {
        return Ok(a.base);
    }
    Err(units_error(
        format!(
            "{name} needs an angle or a plain number, not {}",
            a.describe()
        ),
        "Give the angle in deg or rad, or pass a dimensionless ratio in radians.",
    ))
}

fn angle(radians: f64) -> Number {
    Number {
        base: radians,
        dim: units::dimension("angle"),
        unit: None,
        kind: Kind::Plain,
    }
}

fn arity(name: &str, args: &[Number], allowed: std::ops::RangeInclusive<usize>) -> CoreResult<()> {
    if allowed.contains(&args.len()) {
        return Ok(());
    }
    let expected = if allowed.start() == allowed.end() {
        format!("{}", allowed.start())
    } else if *allowed.end() == usize::MAX {
        format!("at least {}", allowed.start())
    } else {
        format!("{} to {}", allowed.start(), allowed.end())
    };
    Err(ContractError::validation(format!(
        "{name} takes {expected} argument(s), got {}",
        args.len()
    ))
    .with_repair(SYNTAX))
}

/// The unit all of `args` are expressed in, when they agree.
fn shared_unit(args: &[Number]) -> Option<Unit> {
    let first = args.first()?.unit.as_ref()?;
    args.iter()
        .all(|value| {
            value
                .unit
                .as_ref()
                .is_some_and(|unit| unit.name == first.name)
        })
        .then(|| first.clone())
}

fn function(name: &str, args: &[Number]) -> CoreResult<Number> {
    let expected = match name {
        "min" | "max" | "sum" | "mean" | "hypot" => 1..=usize::MAX,
        "round" | "log" => 1..=2,
        "pow" | "mod" | "atan2" | "nthRoot" => 2..=2,
        _ => 1..=1,
    };
    if FUNCTIONS.contains(&name) {
        arity(name, args, expected)?;
    }
    let every = |kind: Kind| args.iter().all(|value| value.kind == kind);
    let result = match name {
        "min" | "max" | "hypot" => {
            let a = &args[0];
            for value in args {
                same_dimension(name, a, value)?;
            }
            let values = args.iter().map(|value| value.base);
            let base = match name {
                "min" => values.fold(f64::INFINITY, f64::min),
                "max" => values.fold(f64::NEG_INFINITY, f64::max),
                _ => values.fold(0.0, f64::hypot),
            };
            let (kind, unit) = if every(Kind::Difference) {
                (Kind::Difference, None)
            } else if every(Kind::Point) && name != "hypot" {
                (Kind::Point, shared_unit(args))
            } else if args.iter().any(|value| value.kind == Kind::Point) {
                (Kind::Plain, None)
            } else {
                (Kind::Plain, shared_unit(args))
            };
            Number {
                base,
                dim: a.dim,
                unit,
                kind,
            }
        }
        // The mean of temperatures is a temperature; every other sum follows
        // the rules of addition.
        "mean" if every(Kind::Point) => {
            for value in args {
                same_dimension(name, &args[0], value)?;
            }
            Number {
                base: args.iter().map(|value| value.base).sum::<f64>() / args.len() as f64,
                dim: args[0].dim,
                unit: shared_unit(args),
                kind: Kind::Point,
            }
        }
        "sum" | "mean" => {
            let total = args[1..]
                .iter()
                .try_fold(args[0].clone(), |total, value| add(&total, value, false))?;
            if name == "sum" {
                total
            } else {
                divide(&total, &Number::plain(args.len() as f64))?
            }
        }
        "abs" => Number {
            base: args[0].base.abs(),
            kind: if args[0].kind == Kind::Difference {
                Kind::Difference
            } else {
                Kind::Plain
            },
            unit: args[0].unit.clone().filter(|unit| !unit.has_offset()),
            dim: args[0].dim,
        },
        "sign" => Number::plain(if args[0].base == 0.0 {
            0.0
        } else {
            args[0].base.signum()
        }),
        "floor" | "ceil" | "round" => {
            let places = match args.get(1) {
                Some(places) => {
                    let places = dimensionless("The number of decimals", places)?;
                    if places.fract() != 0.0 || !(0.0..=15.0).contains(&places) {
                        return Err(ContractError::validation(
                            "round takes a whole number of decimals from 0 to 15",
                        )
                        .with_repair("Write round(x, 2) for two decimals."));
                    }
                    places
                }
                None => 0.0,
            };
            let round: fn(f64) -> f64 = match name {
                "floor" => f64::floor,
                "ceil" => f64::ceil,
                _ => f64::round,
            };
            round_with(name, &args[0], places, round)?
        }
        "sqrt" => root("the square root", &args[0], 2.0)?,
        "cbrt" => root("the cube root", &args[0], 3.0)?,
        "nthRoot" => {
            let degree = dimensionless("The degree of a root", &args[1])?;
            if degree.fract() != 0.0 || degree < 1.0 {
                return Err(
                    ContractError::validation("nthRoot takes a whole degree of 1 or more")
                        .with_repair("Write nthRoot(x, 3) for a cube root."),
                );
            }
            root("that root", &args[0], degree)?
        }
        "pow" => power(&args[0], &args[1])?,
        "mod" => modulo(&args[0], &args[1])?,
        "sin" | "cos" | "tan" => {
            let value = angle_argument(name, &args[0])?;
            Number::plain(match name {
                "sin" => value.sin(),
                "cos" => value.cos(),
                _ => value.tan(),
            })
        }
        "asin" | "acos" | "atan" => {
            let value = dimensionless(name, &args[0])?;
            angle(match name {
                "asin" => value.asin(),
                "acos" => value.acos(),
                _ => value.atan(),
            })
        }
        "atan2" => {
            same_dimension(name, &args[0], &args[1])?;
            angle(args[0].base.atan2(args[1].base))
        }
        "exp" | "ln" | "log10" | "log2" | "sinh" | "cosh" | "tanh" => {
            let value = dimensionless(name, &args[0])?;
            Number::plain(match name {
                "exp" => value.exp(),
                "ln" => value.ln(),
                "log10" => value.log10(),
                "log2" => value.log2(),
                "sinh" => value.sinh(),
                "cosh" => value.cosh(),
                _ => value.tanh(),
            })
        }
        "log" => {
            let value = dimensionless(name, &args[0])?;
            Number::plain(match args.get(1) {
                Some(base) => value.log(dimensionless("The base of a logarithm", base)?),
                None => value.ln(),
            })
        }
        _ => {
            let nearest = bureau_contracts::nearest_match(name, FUNCTIONS);
            let hint = nearest
                .map(|nearest| format!("Did you mean {nearest}? "))
                .unwrap_or_default();
            return Err(
                ContractError::validation(format!("Unsupported function '{name}'"))
                    .with_repair(format!("{hint}{SYNTAX}"))
                    .with_details(
                        json!({"function": name, "nearest": nearest, "functions": FUNCTIONS}),
                    ),
            );
        }
    };
    finite(result)
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Token<'a> {
    Value(f64),
    Name(&'a str),
    Operator(&'a str),
    Open,
    Close,
    Comma,
}

impl Token<'_> {
    fn text(&self) -> String {
        match self {
            Token::Value(value) => units::format_number(*value),
            Token::Name(name) => (*name).to_owned(),
            Token::Operator(operator) => (*operator).to_owned(),
            Token::Open => "(".into(),
            Token::Close => ")".into(),
            Token::Comma => ",".into(),
        }
    }
}

/// A syntax or evaluation failure, located in the expression as written.
fn located(error: ContractError, expression: &str, at: usize) -> ContractError {
    let column = expression[..at.min(expression.len())].chars().count() + 1;
    let mut details = error
        .details
        .as_deref()
        .cloned()
        .unwrap_or_else(|| json!({}));
    if details["column"].is_number() {
        return error;
    }
    details["expression"] = json!(expression);
    details["column"] = json!(column);
    let repair = error.repair.clone().unwrap_or_else(|| SYNTAX.to_owned());
    ContractError::new(&error.code, format!("{} (column {column})", error.message))
        .with_repair(repair)
        .with_details(details)
}

fn syntax(message: impl Into<String>, repair: impl Into<String>) -> ContractError {
    ContractError::validation(message).with_repair(repair)
}

fn tokenize(expression: &str) -> CoreResult<Vec<(Token<'_>, usize)>> {
    const OPERATORS: [&str; 12] = [
        ">=", "<=", "==", "!=", ">", "<", "+", "-", "*", "/", "%", "^",
    ];
    let bytes = expression.as_bytes();
    let mut tokens = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if byte.is_ascii_whitespace() {
            at += 1;
            continue;
        }
        let start = at;
        let token = if byte.is_ascii_digit() || byte == b'.' {
            while at < bytes.len() && (bytes[at].is_ascii_digit() || bytes[at] == b'.') {
                at += 1;
            }
            // An exponent only when digits follow: `2e` is the number 2 times e.
            if at < bytes.len() && matches!(bytes[at], b'e' | b'E') {
                let mut end = at + 1;
                if end < bytes.len() && matches!(bytes[end], b'+' | b'-') {
                    end += 1;
                }
                if end < bytes.len() && bytes[end].is_ascii_digit() {
                    while end < bytes.len() && bytes[end].is_ascii_digit() {
                        end += 1;
                    }
                    at = end;
                }
            }
            let value = expression[start..at].parse::<f64>().map_err(|_| {
                located(
                    syntax(
                        format!("'{}' is not a number", &expression[start..at]),
                        SYNTAX,
                    ),
                    expression,
                    start,
                )
            })?;
            Token::Value(value)
        } else if byte.is_ascii_alphabetic() || byte == b'_' {
            while at < bytes.len() && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_') {
                at += 1;
            }
            Token::Name(&expression[start..at])
        } else if let Some(operator) = OPERATORS
            .iter()
            .find(|operator| expression[at..].starts_with(**operator))
        {
            at += operator.len();
            Token::Operator(operator)
        } else {
            at += 1;
            match byte {
                b'(' => Token::Open,
                b')' => Token::Close,
                b',' => Token::Comma,
                b'=' => {
                    return Err(located(
                        syntax(
                            "Assignments are not allowed in an expression",
                            "Write only the formula; the result is recorded for you. Use == to compare.",
                        ),
                        expression,
                        start,
                    ))
                }
                _ => {
                    let character = expression[start..].chars().next().unwrap_or('?');
                    return Err(located(
                        syntax(format!("Unexpected character '{character}'"), SYNTAX),
                        expression,
                        start,
                    ));
                }
            }
        };
        tokens.push((token, start));
        if tokens.len() > MAX_TOKENS {
            return Err(syntax(
                "Expression is too complex",
                "Split the calculation into smaller calculations that feed each other.",
            ));
        }
    }
    Ok(tokens)
}

struct Parser<'a> {
    expression: &'a str,
    tokens: Vec<(Token<'a>, usize)>,
    next: usize,
    vars: &'a [(String, Number)],
    depth: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<Token<'a>> {
        self.tokens.get(self.next).map(|(token, _)| *token)
    }

    /// Byte offset of the next token, or the end of the expression.
    fn position(&self) -> usize {
        self.tokens
            .get(self.next)
            .map_or(self.expression.len(), |(_, at)| *at)
    }

    fn take(&mut self, expected: Token<'_>) -> bool {
        if self.peek() == Some(expected) {
            self.next += 1;
            true
        } else {
            false
        }
    }

    fn fail(&self, error: ContractError, at: usize) -> ContractError {
        located(error, self.expression, at)
    }

    fn expression(&mut self, min_power: u8) -> CoreResult<Number> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(syntax(
                "Expression is nested too deeply",
                "Split the calculation into smaller calculations that feed each other.",
            ));
        }
        let mut left = if self.take(Token::Operator("+")) {
            self.expression(7)?
        } else if self.take(Token::Operator("-")) {
            let value = self.expression(7)?;
            Number {
                base: -value.base,
                unit: value.unit.clone().filter(|unit| !unit.has_offset()),
                kind: if value.kind == Kind::Difference {
                    Kind::Difference
                } else {
                    Kind::Plain
                },
                dim: value.dim,
            }
        } else {
            self.primary()?
        };
        while let Some(Token::Operator(operator)) = self.peek() {
            let (left_power, right_power) = match operator {
                ">=" | "<=" | "==" | "!=" | ">" | "<" => (1, 2),
                "+" | "-" => (3, 4),
                "*" | "/" | "%" => (5, 6),
                _ => (9, 8),
            };
            if left_power < min_power {
                break;
            }
            let operator_at = self.position();
            self.next += 1;
            if self.peek().is_none() || self.peek() == Some(Token::Close) {
                let repair = if operator == "%" {
                    "'%' is the remainder operator and needs a value on both sides. For a percentage, give the input in % or divide by 100."
                } else {
                    SYNTAX
                };
                return Err(self.fail(
                    syntax(format!("'{operator}' has nothing on its right"), repair),
                    operator_at,
                ));
            }
            let right = self.expression(right_power)?;
            left = match operator {
                "+" => add(&left, &right, false),
                "-" => add(&left, &right, true),
                "*" => multiply(&left, &right),
                "/" => divide(&left, &right),
                "%" => modulo(&left, &right),
                "^" => power(&left, &right),
                _ => compare(operator, &left, &right),
            }
            .map_err(|error| self.fail(error, operator_at))?;
        }
        self.depth -= 1;
        Ok(left)
    }

    fn primary(&mut self) -> CoreResult<Number> {
        let at = self.position();
        let Some(token) = self.peek() else {
            return Err(self.fail(syntax("The expression ends too early", SYNTAX), at));
        };
        self.next += 1;
        let value = match token {
            Token::Open => {
                let value = self.expression(0)?;
                if !self.take(Token::Close) {
                    return Err(
                        self.fail(syntax("A '(' is never closed", "Add the missing ')'."), at)
                    );
                }
                value
            }
            Token::Value(value) => Number::plain(value),
            Token::Name(name) if self.take(Token::Open) => {
                let mut args = Vec::new();
                if !self.take(Token::Close) {
                    loop {
                        args.push(self.expression(0)?);
                        if self.take(Token::Close) {
                            break;
                        }
                        if !self.take(Token::Comma) {
                            return Err(self.fail(
                                syntax(
                                    format!("The arguments of {name} need ',' between them and ')' after them"),
                                    SYNTAX,
                                ),
                                self.position(),
                            ));
                        }
                    }
                }
                function(name, &args).map_err(|error| self.fail(error, at))?
            }
            Token::Name(name) => self.variable(name, at)?,
            other => {
                return Err(self.fail(syntax(format!("Unexpected '{}'", other.text()), SYNTAX), at))
            }
        };
        // Two values side by side: an implied multiplication or a unit
        // written into the expression. Neither is guessed at.
        if let Some(next @ (Token::Value(_) | Token::Name(_) | Token::Open)) = self.peek() {
            return Err(self.fail(
                syntax(
                    format!("Unexpected '{}' after a value", next.text()),
                    "Write multiplication with * (2 * a). Units belong on inputs: add an input such as {\"name\": \"g\", \"quantity\": {\"value\": 9.80665, \"unit\": \"m/s^2\"}} and use its name.",
                ),
                self.position(),
            ));
        }
        Ok(value)
    }

    /// An input wins over a constant of the same name: an efficiency called
    /// `e` is the caller's 0.85, never 2.718.
    fn variable(&self, name: &str, at: usize) -> CoreResult<Number> {
        if let Some((_, value)) = self.vars.iter().find(|(known, _)| known == name) {
            return Ok(value.clone());
        }
        if let Some((_, value)) = CONSTANTS.iter().find(|(known, _)| *known == name) {
            return Ok(Number::plain(*value));
        }
        let names = self
            .vars
            .iter()
            .map(|(known, _)| known.as_str())
            .collect::<Vec<_>>();
        let nearest = bureau_contracts::nearest_match(name, names.iter().copied());
        let listed = if names.is_empty() {
            "No inputs were given".to_owned()
        } else {
            format!("The inputs are: {}", names.join(", "))
        };
        let hint = nearest
            .map(|nearest| format!(" Did you mean '{nearest}'?"))
            .unwrap_or_default();
        Err(self.fail(
            ContractError::validation(format!("Undefined input '{name}'"))
                .with_repair(format!(
                    "Add an input named '{name}' with its value and unit, or correct the name. {listed}.{hint}"
                ))
                .with_details(json!({"name": name, "inputs": names, "nearest": nearest})),
            at,
        ))
    }
}

fn evaluate(expression: &str, vars: &[(String, Number)]) -> CoreResult<Number> {
    if expression.trim().is_empty() {
        return Err(syntax(
            "Expression is empty",
            "Give a formula over the input names, for example \"mass * g\".",
        ));
    }
    if expression.len() > MAX_EXPRESSION_CHARS {
        return Err(syntax(
            format!(
                "Expression too long ({} > {MAX_EXPRESSION_CHARS} characters)",
                expression.len()
            ),
            "Split the calculation into smaller calculations that feed each other.",
        ));
    }
    let mut parser = Parser {
        expression,
        tokens: tokenize(expression)?,
        next: 0,
        vars,
        depth: 0,
    };
    let result = parser.expression(0)?;
    if let Some(token) = parser.peek() {
        let message = if token == Token::Close {
            "A ')' has no matching '('".to_owned()
        } else {
            format!("Unexpected '{}'", token.text())
        };
        return Err(parser.fail(syntax(message, SYNTAX), parser.position()));
    }
    Ok(result)
}

/// Whether a result of dimension `result` may be reported in `unit`. Besides
/// an exact match, a leftover radian may be dropped (torque x angular speed
/// in W), but never into a bare number or a frequency: rad/s is not Hz.
fn reportable(result: Dim, unit: &Unit) -> bool {
    if result == unit.dim {
        return true;
    }
    result.has_angle()
        && result.without_angle() == unit.dim
        && !unit.dim.is_none()
        && unit.dim != units::dimension("frequency")
}

/// The reported value and unit of a result: in the declared unit when there
/// is one, otherwise in the unit the dimensions of the expression give it.
fn report(number: &Number, declared: Option<&Unit>) -> CoreResult<(f64, String)> {
    if number.kind == Kind::Truth {
        return Err(ContractError::validation(
            "The expression is a comparison: it gives true or false, not a quantity",
        )
        .with_repair("Calculate the margin or ratio instead (for example available / required). A pass or fail verdict belongs in a recorded test result."));
    }
    let Some(unit) = declared else {
        if let Some((value, unit)) = number.in_unit() {
            return Ok((value, unit.name.clone()));
        }
        // A leftover radian is dropped when a unit without it fits: torque
        // times angular speed is a power.
        let reduced = number.dim.without_angle();
        let drop_angle = number.dim.has_angle()
            && !reduced.is_none()
            && reduced != units::dimension("frequency");
        let chosen = match units::coherent(number.dim) {
            Coherent::Unit(unit) if unit.quantity.is_none() && drop_angle => {
                units::coherent(reduced)
            }
            other => other,
        };
        let unit = match chosen {
            Coherent::Unit(unit) => unit,
            Coherent::Ambiguous(options) => {
                return Err(units_error(
                    format!(
                        "The result has the dimension {}, which more than one quantity shares, so it cannot be labelled without a declared unit",
                        reduced.si_expression()
                    ),
                    &format!("Declare outputUnit, for example \"{}\".", options.join("\" or \"")),
                )
                .with_details(json!({"outputUnits": options})))
            }
        };
        return Ok((unit.value_of(number.base), unit.name));
    };
    if !reportable(number.dim, unit) {
        let fitting = if number.dim.is_none() {
            "The result is dimensionless: use outputUnit \"1\" or \"%\", or leave it out."
                .to_owned()
        } else {
            match units::coherent(number.dim) {
                Coherent::Unit(fit) => format!(
                    "Declare an outputUnit of that dimension, for example \"{}\", or leave it out.",
                    fit.name
                ),
                Coherent::Ambiguous(options) => format!(
                    "Declare an outputUnit of that dimension, for example \"{}\".",
                    options.join("\" or \"")
                ),
            }
        };
        return Err(units_error(
            format!(
                "The result has the dimension {}, which cannot be reported in {} ({})",
                if number.dim.is_none() {
                    "of a plain number".to_owned()
                } else {
                    number.dim.si_expression()
                },
                unit.name,
                unit.measures()
            ),
            &fitting,
        ));
    }
    let value = match (unit.has_offset(), number.kind) {
        (false, _) | (true, Kind::Point) => unit.value_of(number.base),
        (true, Kind::Difference) => unit.difference_of(number.base),
        (true, _) => {
            return Err(units_error(
                format!(
                    "Cannot tell whether the result is a temperature or a temperature difference, so it cannot be reported in {}",
                    unit.name
                ),
                "Use outputUnit \"K\", or give every temperature in the same scale so that the result is known to be a temperature or a difference.",
            ))
        }
    };
    Ok((value, unit.name.clone()))
}

fn valid_input_name(name: &str) -> bool {
    name.bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        && !matches!(
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
}

/// Everything `calculation.run` needs, checked before any job is recorded.
struct Prepared {
    template: Option<Value>,
    expression: String,
    vars: Vec<(String, Number)>,
    inputs: Vec<Value>,
    refs: Vec<Value>,
    /// Unit the result is reported in when one was declared.
    declared: Option<Unit>,
    /// The declared unit when it came from the caller or an earlier run of
    /// this calculation rather than from the template: recorded with the
    /// result so that a re-run reports in the same unit.
    recorded_unit: Option<String>,
    /// Template defaults used for inputs the request left out.
    assumed: Vec<String>,
}

fn template_named(id: &str) -> CoreResult<Value> {
    all_templates()
        .into_iter()
        .find(|entry| entry["id"] == id)
        .ok_or_else(|| {
            ContractError::new("NOT_FOUND", format!("Unknown template: {id}")).with_repair(
                "Call calculation_templates for the template ids, or give an expression instead.",
            )
        })
}

fn prepare(input: &Value, inherited_unit: Option<&str>) -> CoreResult<Prepared> {
    let template = input["templateId"]
        .as_str()
        .map(template_named)
        .transpose()?;
    let expression = template
        .as_ref()
        .and_then(|template| template["expression"].as_str())
        .or(input["expression"].as_str())
        .ok_or_else(|| {
            ContractError::validation("calculation.run needs templateId or expression")
                .with_repair("Give templateId from calculation_templates, or expression with a formula over the input names.")
        })?
        .to_owned();
    let mut provided = input["inputs"]
        .as_array()
        .ok_or_else(|| ContractError::validation("Inputs must be an array"))?
        .clone();
    for required in template
        .iter()
        .flat_map(|template| template["inputs"].as_array().into_iter().flatten())
        .filter(|entry| entry["required"] == true)
    {
        let name = required_str(required, "name")?;
        let wanted = required_str(required, "unit")?;
        let given = provided
            .iter()
            .find(|entry| entry["name"] == name)
            .map(|entry| units::read(&entry["quantity"]));
        let Some(units::Reading::Known { unit, .. }) = given else {
            return Err(ContractError::new(
                "INVALID_UNITS",
                format!("Missing required input '{name}' ({wanted})"),
            )
            .with_repair(format!("Supply {name} in {wanted}."))
            .with_details(json!({"issues": [{"path": "inputs", "message": format!("needs {name} in {wanted}")}]})));
        };
        units::convert(1.0, &unit, &units::parse(wanted)?).map_err(|error| {
            ContractError::new(
                "INVALID_UNITS",
                format!("Input '{name}': {}", error.message),
            )
            .with_repair(format!(
                "Supply {name} in {wanted} or another unit of the same quantity."
            ))
        })?;
    }
    // An optional template input the request did not give takes the
    // template's stated default, which is recorded as an assumption and as an
    // input, never chosen silently.
    let mut assumed = Vec::new();
    for optional in template
        .iter()
        .flat_map(|template| template["inputs"].as_array().into_iter().flatten())
        .filter(|entry| entry["required"] != true && entry["default"].is_number())
    {
        let name = required_str(optional, "name")?;
        if provided.iter().any(|entry| entry["name"] == name) {
            continue;
        }
        let unit = required_str(optional, "unit")?;
        let default = &optional["default"];
        provided.push(json!({"name": name, "quantity": {"value": default, "unit": unit}}));
        let shown = match unit {
            "1" => default.to_string(),
            _ => format!("{default} {unit}"),
        };
        assumed.push(format!(
            "{name} was not given, so the template default {shown} was used."
        ));
    }
    let mut vars = Vec::<(String, Number)>::new();
    let mut refs = Vec::new();
    for (index, item) in provided.iter().enumerate() {
        let name = required_str(item, "name")?;
        let path = format!("inputs[{index}]");
        if !valid_input_name(name) {
            return Err(ContractError::validation(format!("Invalid input name '{name}'"))
                .with_repair("Name an input with letters, digits and underscores, starting with a letter, for example wheel_radius.")
                .with_details(json!({"issues": [{"path": format!("{path}.name"), "message": "letters, digits and underscores only, not starting with a digit"}]})));
        }
        if vars.iter().any(|(known, _)| known == name) {
            return Err(ContractError::validation(format!("Input '{name}' is given twice"))
                .with_repair("Give each input name once.")
                .with_details(json!({"issues": [{"path": format!("{path}.name"), "message": "duplicate input name"}]})));
        }
        let quantity = &item["quantity"];
        if quantity["unknown"] == true {
            return Err(ContractError::new(
                "INVALID_UNITS",
                format!(
                    "Input '{name}' is unknown ({})",
                    quantity["reason"].as_str().unwrap_or("no value")
                ),
            )
            .with_repair("A calculation needs a value for every input. Find the value, or record the assumption you are making and supply it as a literal input.")
            .with_details(json!({"issues": [{"path": format!("{path}.quantity"), "message": "unknown value"}]})));
        }
        let value = quantity["value"].as_f64().ok_or_else(|| {
            ContractError::new(
                "INVALID_UNITS",
                format!("Input '{name}' has no numeric value"),
            )
            .with_repair("Give the input as {\"value\": number, \"unit\": \"...\"}.")
        })?;
        let unit = units::parse(required_str(quantity, "unit")?).map_err(|error| {
            ContractError::new(&error.code, format!("Input '{name}': {}", error.message))
                .with_repair(error.repair.clone().unwrap_or_default())
                .with_details(json!({"issues": [{"path": format!("{path}.quantity.unit"), "message": error.message}]}))
        })?;
        vars.push((name.to_owned(), Number::of(value, unit)));
        if item["sourceRef"].is_object() {
            refs.push(json!({"artifactId":item["sourceRef"]["artifactId"],"revisionId":item["sourceRef"]["revisionId"],"relationship":"depends_on","label":format!("input {name}")}));
        }
    }
    let output_unit = |name: &str| {
        units::parse(name).map_err(|error| {
            ContractError::new(&error.code, format!("Output unit: {}", error.message))
                .with_repair(error.repair.clone().unwrap_or_default())
                .with_details(json!({"issues": [{"path": "outputUnit", "message": error.message}]}))
        })
    };
    let chosen = input["outputUnit"]
        .as_str()
        .or(inherited_unit)
        .map(output_unit)
        .transpose()?;
    let recorded_unit = chosen.as_ref().map(|unit| unit.name.clone());
    let declared = match chosen {
        Some(unit) => Some(unit),
        None => template
            .as_ref()
            .and_then(|template| template["outputUnit"].as_str())
            .map(output_unit)
            .transpose()?,
    };
    Ok(Prepared {
        template,
        expression,
        vars,
        inputs: provided,
        refs,
        declared,
        recorded_unit,
        assumed,
    })
}

/// Whether this engine computes the result a calculation revision records
/// from the formula and inputs the revision records. A result typed into the
/// payload, or one with an input that has no value, was not computed, however
/// it is labelled; only a computed result is calculation evidence.
pub(crate) fn computed(payload: &Value) -> bool {
    let recorded = &payload["result"]["quantity"];
    let (Some(value), Some(unit)) = (recorded["value"].as_f64(), recorded["unit"].as_str()) else {
        return false;
    };
    let request = json!({"templateId": payload["templateId"], "expression": payload["expression"],
        "inputs": payload["inputs"], "outputUnit": payload["outputUnit"]});
    let Ok(prepared) = prepare(&request, None) else {
        return false;
    };
    // Every input the engine uses has to be on record.
    if !prepared.assumed.is_empty() {
        return false;
    }
    let Ok((result, result_unit)) = evaluate(&prepared.expression, &prepared.vars)
        .and_then(|number| report(&number, prepared.declared.as_ref()))
    else {
        return false;
    };
    let (Ok(from), Ok(to)) = (units::parse(unit), units::parse(&result_unit)) else {
        return false;
    };
    units::convert(value, &from, &to)
        .is_ok_and(|value| (value - result).abs() <= result.abs().max(value.abs()) * 1e-9)
}

/// Equal as recorded engineering content: numbers by value (2 and 2.0 are
/// one quantity), objects without regard to key order or absent nulls.
fn equivalent(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(l, r)| equivalent(l, r))
        }
        (Value::Object(left), Value::Object(right)) => left
            .keys()
            .chain(right.keys())
            .all(|key| equivalent(&a[key.as_str()], &b[key.as_str()])),
        _ => a == b,
    }
}

/// A re-run that reproduces a recorded revision adds nothing for a person to
/// review: same formula, same inputs, same result.
fn same_calculation(candidate: &Value, recorded: &Value) -> bool {
    [
        "templateId",
        "expression",
        "inputs",
        "assumptions",
        "outputUnit",
        "result",
    ]
    .iter()
    .all(|key| equivalent(&candidate[*key], &recorded[*key]))
}

fn job_event(
    handle: &ProjectHandle,
    origin: &Origin,
    job_id: &str,
    status: &str,
) -> CoreResult<()> {
    emit(
        handle,
        "job.updated",
        origin,
        json!({"jobId": job_id, "status": status, "kind": "calculation", "tool": "calc"}),
    )?;
    Ok(())
}

pub(super) fn run(handle: &mut ProjectHandle, input: &Value, origin: &Origin) -> CoreResult<Value> {
    let target = input["artifactId"]
        .as_str()
        .map(|id| -> CoreResult<Value> {
            let artifact = require_artifact(handle, id)?;
            if artifact["type"] != "calculation" {
                return Err(ContractError::validation(format!(
                    "{} is a {} artifact, not a calculation",
                    artifact["title"].as_str().unwrap_or(id),
                    artifact["type"].as_str().unwrap_or("different")
                ))
                .with_repair("Leave artifactId out to create a new calculation, or pass the id of a calculation artifact."));
            }
            Ok(artifact)
        })
        .transpose()?;
    // Revisions a re-run can reproduce: the newest working draft, then the
    // approved baseline.
    let mut recorded = Vec::new();
    if let Some(artifact) = &target {
        let id = required_str(artifact, "id")?;
        let baseline = artifact["selectedRevisionId"]
            .as_str()
            .map(|selected| require_revision(handle, selected))
            .transpose()?;
        let after = baseline
            .as_ref()
            .and_then(|b| b["seq"].as_i64())
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
        recorded.extend(draft);
        recorded.extend(baseline);
    }
    // A re-run keeps the output unit the calculation was recorded with unless
    // the caller declares another.
    let inherited_unit = recorded
        .first()
        .and_then(|revision| revision["payload"]["outputUnit"].as_str())
        .map(str::to_owned);
    let prepared = prepare(input, inherited_unit.as_deref())?;
    let job_id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    handle.db.execute("INSERT INTO job(id,kind,tool,tool_version,inputs,input_hashes,command,status,log,output_hashes,error,session_id,created_at,started_at,finished_at) VALUES(?1,'calculation','calc',?2,?3,'{}',NULL,'running','','{}',NULL,?4,?5,?5,NULL)",
        params![job_id, ENGINE, json!({"templateId":input["templateId"],"expression":prepared.expression,"experimental":true}).to_string(),origin.session_id(),timestamp]).map_err(internal)?;
    job_event(handle, origin, &job_id, "running")?;
    // Every exit from here finishes the job: a failed draft or proposal must
    // not leave it running.
    match record(handle, input, &prepared, target.as_ref(), &recorded, origin) {
        Ok(result) => {
            handle
                .db
                .execute(
                    "UPDATE job SET status='succeeded',output_hashes=?1,finished_at=?2 WHERE id=?3",
                    params![
                        json!({"revision": result["revision"]["id"]}).to_string(),
                        now(),
                        job_id
                    ],
                )
                .map_err(internal)?;
            job_event(handle, origin, &job_id, "succeeded")?;
            Ok(result)
        }
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
            job_event(handle, origin, &job_id, "failed")?;
            Err(error)
        }
    }
}

fn pending_proposal_for(handle: &ProjectHandle, revision_id: &str) -> CoreResult<Value> {
    let mut stmt = handle
        .db
        .prepare("SELECT id,changes FROM proposal WHERE state='pending' ORDER BY created_at DESC")
        .map_err(internal)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(internal)?;
    for (id, changes) in rows {
        let changes: Value = serde_json::from_str(&changes).map_err(internal)?;
        if changes.as_array().is_some_and(|items| {
            items
                .iter()
                .any(|change| change["newRevisionId"] == revision_id)
        }) {
            return require_proposal(handle, &id);
        }
    }
    Ok(Value::Null)
}

fn record(
    handle: &mut ProjectHandle,
    input: &Value,
    prepared: &Prepared,
    target: Option<&Value>,
    recorded: &[Value],
    origin: &Origin,
) -> CoreResult<Value> {
    let number = evaluate(&prepared.expression, &prepared.vars)?;
    let (value, unit) = report(&number, prepared.declared.as_ref())?;
    if !value.is_finite() {
        return Err(not_finite());
    }
    let template = prepared.template.as_ref();
    let mut limitations = template
        .and_then(|template| template["limitations"].as_array())
        .cloned()
        .unwrap_or_default();
    if !limitations.iter().any(|limit| limit == SCOPE) {
        limitations.push(json!(SCOPE));
    }
    let mut assumptions = template
        .and_then(|template| template["assumptions"].as_array())
        .cloned()
        .unwrap_or_default();
    assumptions.extend(prepared.assumed.iter().map(|assumed| json!(assumed)));
    assumptions.extend(
        input["assumptions"]
            .as_array()
            .into_iter()
            .flatten()
            .cloned(),
    );
    let mut payload = json!({"expression":prepared.expression,"inputs":prepared.inputs,
        "assumptions":assumptions,"result":{"quantity":{"value":value,"unit":unit}},
        "limitations":limitations,"toolVersion":ENGINE,"ranAt":now(),"evidenceKind":"calculated"});
    if let Some(template_id) = input["templateId"].as_str() {
        payload["templateId"] = json!(template_id);
    }
    if let Some(declared) = &prepared.recorded_unit {
        payload["outputUnit"] = json!(declared);
    }
    let rationale = format!(
        "run {}",
        input["templateId"].as_str().unwrap_or("expression")
    );
    let summary = units::format_quantity(value, &unit);
    let outcome = |artifact_id: &Value, revision: Value, proposal: Value, unchanged: bool| {
        let mut result = json!({"artifactId":artifact_id,"revision":revision,
            "result":{"value":value,"unit":unit},"proposal":proposal,"unchanged":unchanged,
            "experimental":true,"limitations":limitations});
        if !prepared.assumed.is_empty() {
            result["notes"] = json!(prepared.assumed);
        }
        if unchanged {
            result["note"] = json!(format!(
                "Formula, inputs and result ({summary}) are the same as the recorded revision. No new revision or proposal was created."
            ));
        }
        result
    };
    let created = if let Some(artifact) = target {
        let candidate = parse_artifact_payload("calculation", payload.clone())?;
        if let Some(same) = recorded
            .iter()
            .find(|revision| same_calculation(&candidate, &revision["payload"]))
        {
            let proposal = pending_proposal_for(handle, required_str(same, "id")?)?;
            return Ok(outcome(&artifact["id"], same.clone(), proposal, true));
        }
        update_draft(
            handle,
            &json!({"artifactId":artifact["id"],"baseRevisionId":artifact["selectedRevisionId"],
            "payload":payload,"files":[],"inputs":prepared.refs,"rationale":rationale}),
            origin,
        )?
    } else {
        create_draft(
            handle,
            &json!({"type":"calculation","title":input["title"].as_str().or_else(||template.and_then(|t|t["title"].as_str())).unwrap_or("calculation"),
            "payload":payload,"files":[],"inputs":prepared.refs,"rationale":rationale}),
            origin,
        )?
    };
    let artifact_id = &created["artifact"]["id"];
    let revision = created["revision"].clone();
    let proposal = if input["submitForReview"].as_bool().unwrap_or(true) {
        let selected = &created["artifact"]["selectedRevisionId"];
        let kind = if selected.is_null() {
            "new_artifact"
        } else {
            "baseline_update"
        };
        proposal_submit(
            handle,
            &json!({"changes":[{"artifactId":artifact_id,"baseRevisionId":selected,
            "newRevisionId":revision["id"],"kind":kind}],"reason":format!("calculation result: {summary}")}),
            origin,
        )?
    } else {
        Value::Null
    };
    Ok(outcome(artifact_id, revision, proposal, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    type Inputs<'a> = &'a [(&'a str, f64, &'a str)];
    /// Expression, inputs, declared output unit, then the value and unit expected.
    type Case<'a> = (&'a str, Inputs<'a>, Option<&'a str>, f64, &'a str);
    /// Expression, inputs, declared output unit, then the error code and the
    /// text expected in the message and in the repair.
    type Refusal<'a> = (
        &'a str,
        Inputs<'a>,
        Option<&'a str>,
        &'a str,
        &'a str,
        &'a str,
    );

    /// Evaluate and report without a project: the engine alone.
    fn calc(expression: &str, inputs: Inputs, output: Option<&str>) -> CoreResult<(f64, String)> {
        let vars = inputs
            .iter()
            .map(|(name, value, unit)| {
                let unit = units::parse(unit).expect("test unit");
                ((*name).to_owned(), Number::of(*value, unit))
            })
            .collect::<Vec<_>>();
        let declared = output.map(|unit| units::parse(unit).expect("test output unit"));
        report(&evaluate(expression, &vars)?, declared.as_ref())
    }

    fn close(actual: f64, expected: f64) -> bool {
        (actual - expected).abs() <= expected.abs() * 1e-12 + 1e-15
    }

    fn project() -> (tempfile::TempDir, ProjectHandle) {
        let temp = tempfile::tempdir().unwrap();
        let handle = ProjectHandle::create(temp.path().join("calc"), "Calc", "test").unwrap();
        (temp, handle)
    }

    fn agent() -> Origin {
        Origin::Agent {
            session_id: "agent-session".into(),
        }
    }

    fn inputs(entries: Inputs) -> Value {
        json!(entries
            .iter()
            .map(|(name, value, unit)| json!({"name": name, "quantity": {"value": value, "unit": unit}, "literal": false}))
            .collect::<Vec<_>>())
    }

    fn jobs(handle: &ProjectHandle) -> Vec<(String, Option<String>)> {
        let mut stmt = handle
            .db
            .prepare("SELECT status,tool_version FROM job ORDER BY created_at,rowid")
            .unwrap();
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows
    }

    fn job_events(handle: &ProjectHandle) -> Vec<Value> {
        let mut stmt = handle
            .db
            .prepare("SELECT data FROM event WHERE type='job.updated' ORDER BY seq")
            .unwrap();
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|data| serde_json::from_str(&data.unwrap()).unwrap())
            .collect();
        rows
    }

    /// Expected values were worked out outside this engine (by hand or with
    /// Python's math module); the comment on each row says how.
    #[test]
    fn results_carry_the_unit_their_dimensions_give_them() {
        #[rustfmt::skip]
        let cases: &[Case] = &[
            // A ratio of two torques is a plain number, never "2.5 N*m".
            ("stall / required", &[("stall", 2.5, "N*m"), ("required", 1.0, "N*m")], None, 2.5, "1"),
            ("x / y", &[("x", 4.0, "kg"), ("y", 2.0, "kg")], None, 2.0, "1"),
            // 12 V x 2 A = 24 W, whichever input comes first.
            ("voltage * current", &[("voltage", 12.0, "V"), ("current", 2.0, "A")], None, 24.0, "W"),
            ("current * voltage", &[("voltage", 12.0, "V"), ("current", 2000.0, "mA")], None, 24.0, "W"),
            // 100 / 0.85: the input named e is the efficiency, not 2.718.
            ("p_out / e", &[("p_out", 100.0, "W"), ("e", 0.85, "1")], None, 117.64705882352942, "W"),
            ("pi * 2", &[("pi", 3.0, "1")], None, 6.0, "1"),
            // 2 x pi x 0.03 with the constant.
            ("2 * pi * r", &[("r", 0.03, "m")], None, 0.18849555921538758, "m"),
            ("tau * r", &[("r", 0.03, "m")], None, 0.18849555921538758, "m"),
            // Rounding happens in the unit of the input: 12.3 mm -> 13 mm.
            ("ceil(x)", &[("x", 12.3, "mm")], None, 13.0, "mm"),
            ("round(m)", &[("m", 1499.4, "g")], None, 1499.0, "g"),
            ("floor(m)", &[("m", 2.7, "kg")], None, 2.0, "kg"),
            ("round(x, 2)", &[("x", 1234.5678, "mm")], None, 1234.57, "mm"),
            ("round(a + b)", &[("a", 1.4, "mm"), ("b", 1.3, "mm")], None, 3.0, "mm"),
            ("round(2.5)", &[], None, 3.0, "1"),
            ("round(p)", &[("p", 12.6, "%")], None, 13.0, "%"),
            // ceil(12.3 / 5) = 3 steps of 5 mm.
            ("ceil(length / step) * step", &[("length", 12.3, "mm"), ("step", 5.0, "mm")], None, 15.0, "mm"),
            // atan(0.5) in radians and in degrees.
            ("atan(rise / run)", &[("rise", 1.0, "m"), ("run", 2.0, "m")], None, 0.46364760900080615, "rad"),
            ("atan(rise / run)", &[("rise", 1.0, "m"), ("run", 2.0, "m")], Some("deg"), 26.565051177077994, "deg"),
            ("atan2(y, x)", &[("y", 1.0, "m"), ("x", 1.0, "m")], Some("deg"), 45.0, "deg"),
            ("asin(0.5)", &[], None, 0.5235987755982988, "rad"),
            ("acos(1)", &[], None, 0.0, "rad"),
            ("sin(a)", &[("a", 30.0, "deg")], None, 0.5, "1"),
            ("cos(0)", &[], None, 1.0, "1"),
            // 3-4-5 triangle; mixed units fall back to metres.
            ("hypot(a, b)", &[("a", 3.0, "m"), ("b", 4.0, "m")], None, 5.0, "m"),
            ("hypot(a, b)", &[("a", 30.0, "mm"), ("b", 4.0, "cm")], None, 0.05, "m"),
            // Cube root of 27 cm^3 is 3 cm = 0.03 m.
            ("cbrt(vol)", &[("vol", 27.0, "cm^3")], None, 0.03, "m"),
            ("sqrt(area)", &[("area", 9.0, "m^2")], None, 3.0, "m"),
            ("area ^ 0.5", &[("area", 4.0, "m^2")], None, 2.0, "m"),
            ("vol ^ (1/3)", &[("vol", 8.0, "m^3")], None, 2.0, "m"),
            ("nthRoot(x, 4)", &[("x", 16.0, "1")], None, 2.0, "1"),
            ("x ^ 0.5", &[("x", 3.0, "1")], None, 1.7320508075688772, "1"),
            ("pow(len, 2)", &[("len", 3.0, "m")], None, 9.0, "m^2"),
            // Remainders take the sign of the divisor.
            ("a % 3", &[("a", 10.0, "1")], None, 1.0, "1"),
            ("mod(a, 3)", &[("a", -7.0, "1")], None, 2.0, "1"),
            ("mod(a, turn)", &[("a", 370.0, "deg"), ("turn", 360.0, "deg")], None, 10.0, "deg"),
            ("abs(a - b)", &[("a", 3.0, "kg"), ("b", 5.0, "kg")], None, 2.0, "kg"),
            ("min(a, b)", &[("a", 500.0, "g"), ("b", 0.4, "kg")], None, 0.4, "kg"),
            ("max(a, b, c)", &[("a", 1.0, "W"), ("b", 3.0, "W"), ("c", 2.0, "W")], None, 3.0, "W"),
            ("sum(a, b)", &[("a", 1.0, "kg"), ("b", 500.0, "g")], None, 1.5, "kg"),
            ("mean(1, 2, 3)", &[], None, 2.0, "1"),
            ("sign(a)", &[("a", -2.0, "m")], None, -1.0, "1"),
            // 0.5 N*m x 300 rpm = 0.5 x 31.4159... rad/s: a power once the radian is dropped.
            ("torque * speed", &[("torque", 0.5, "N*m"), ("speed", 300.0, "rpm")], None, 15.707963267948966, "W"),
            ("torque * speed", &[("torque", 0.5, "N*m"), ("speed", 300.0, "rpm")], Some("mW"), 15707.963267948966, "mW"),
            // 300 rpm at a 30 mm radius.
            ("speed * radius", &[("speed", 300.0, "rpm"), ("radius", 0.03, "m")], None, 0.9424777960769379, "m/s"),
            ("speed ^ 2 * radius", &[("speed", 300.0, "rpm"), ("radius", 0.03, "m")], None, 29.608813203268074, "m/s^2"),
            ("speed", &[("speed", 300.0, "rpm")], None, 300.0, "rpm"),
            ("speed * 2", &[("speed", 300.0, "rpm")], Some("rad/s"), 62.83185307179586, "rad/s"),
            // Energy and torque share a dimension: the declared unit decides.
            ("force * distance", &[("force", 10.0, "N"), ("distance", 2.0, "m")], Some("J"), 20.0, "J"),
            ("force * arm", &[("force", 10.0, "N"), ("arm", 2.0, "m")], Some("N*m"), 20.0, "N*m"),
            ("force * distance", &[("force", 10.0, "N"), ("distance", 2.0, "m")], Some("Wh"), 0.005555555555555556, "Wh"),
            ("voltage * capacity", &[("voltage", 7.4, "V"), ("capacity", 0.45, "Ah")], Some("Wh"), 3.33, "Wh"),
            // 100 N over 25 mm^2 = 4 MPa.
            ("force / area", &[("force", 100.0, "N"), ("area", 25.0, "mm^2")], None, 4_000_000.0, "Pa"),
            ("force / area", &[("force", 100.0, "N"), ("area", 25.0, "mm^2")], Some("MPa"), 4.0, "MPa"),
            ("force / area", &[("force", 100.0, "N"), ("area", 25.0, "mm^2")], Some("N/mm^2"), 4.0, "N/mm^2"),
            ("v / i", &[("v", 5.0, "V"), ("i", 20.0, "mA")], None, 250.0, "ohm"),
            ("mass / vol", &[("mass", 2.0, "kg"), ("vol", 4.0, "L")], None, 500.0, "kg/m^3"),
            // Temperatures: a difference is in kelvin, a rise added to a temperature stays on its scale.
            ("t_hot - t_cold", &[("t_hot", 80.0, "degC"), ("t_cold", 20.0, "degC")], None, 60.0, "K"),
            ("t_hot - t_cold", &[("t_hot", 80.0, "degC"), ("t_cold", 20.0, "degC")], Some("degC"), 60.0, "degC"),
            ("t_amb + rise", &[("t_amb", 25.0, "degC"), ("rise", 30.0, "K")], None, 55.0, "degC"),
            ("t_amb + power * r_th", &[("t_amb", 25.0, "degC"), ("power", 2.0, "W"), ("r_th", 15.0, "K/W")], None, 55.0, "degC"),
            ("t", &[("t", 25.0, "degC")], Some("K"), 298.15, "K"),
            ("mean(a, b)", &[("a", 20.0, "degC"), ("b", 30.0, "degC")], None, 25.0, "degC"),
            ("t - (t_hot - t_cold)", &[("t", 100.0, "degC"), ("t_hot", 80.0, "degC"), ("t_cold", 20.0, "degC")], None, 40.0, "degC"),
            // 80 degC less a value in kelvin is 333.15 K whether that value is a drop or a temperature.
            ("t - drop", &[("t", 80.0, "degC"), ("drop", 20.0, "K")], None, 333.15, "K"),
            ("(t_hot - t_cold) * 2", &[("t_hot", 80.0, "degC"), ("t_cold", 20.0, "degC")], Some("degC"), 120.0, "degC"),
            // Percentages keep their unit; a sum of one unit keeps it too.
            ("p * 2", &[("p", 25.0, "%")], None, 50.0, "%"),
            ("mass * p", &[("mass", 2.0, "kg"), ("p", 25.0, "%")], None, 0.5, "kg"),
            // A percentage scales a length in the length's own unit.
            ("p * length", &[("length", 12.0, "mm"), ("p", 50.0, "%")], None, 6.0, "mm"),
            ("2 * p", &[("p", 25.0, "%")], None, 50.0, "%"),
            ("p * q", &[("p", 50.0, "%"), ("q", 50.0, "%")], None, 25.0, "%"),
            ("p / q", &[("p", 50.0, "%"), ("q", 25.0, "%")], None, 2.0, "1"),
            ("length / 4", &[("length", 12.0, "mm")], None, 3.0, "mm"),
            ("a + b", &[("a", 500.0, "g"), ("b", 250.0, "g")], None, 750.0, "g"),
            ("a + b", &[("a", 500.0, "g"), ("b", 0.25, "kg")], None, 0.75, "kg"),
            ("a + b", &[("a", 500.0, "g"), ("b", 0.25, "kg")], Some("lb"), 1.6534669663852733, "lb"),
            // Comparisons count as one or zero inside arithmetic.
            ("(a > b) * 2", &[("a", 3.0, "m"), ("b", 2.0, "m")], None, 2.0, "1"),
            // Operator precedence.
            ("-a^2", &[("a", 3.0, "1")], None, -9.0, "1"),
            ("2^3^2", &[], None, 512.0, "1"),
            ("2 + 3 * 4", &[], None, 14.0, "1"),
            ("10 - 4 - 3", &[], None, 3.0, "1"),
            ("8 / 4 / 2", &[], None, 1.0, "1"),
            ("2^-1", &[], None, 0.5, "1"),
            ("1.5e-3 * 2", &[], None, 0.003, "1"),
            ("(1 + 2) * (3 + 4)", &[], None, 21.0, "1"),
            ("log(100, 10)", &[], None, 2.0, "1"),
            ("ln(e)", &[], None, 1.0, "1"),
            ("log10(1000)", &[], None, 3.0, "1"),
            ("log2(8)", &[], None, 3.0, "1"),
            ("exp(0)", &[], None, 1.0, "1"),
        ];
        for (expression, inputs, output, expected, unit) in cases {
            let (value, reported) = calc(expression, inputs, *output).unwrap_or_else(|error| {
                panic!(
                    "{expression} failed: {} / {:?}",
                    error.message, error.repair
                )
            });
            assert!(
                close(value, *expected) && reported == *unit,
                "{expression} with {inputs:?} gave {value} {reported}, expected {expected} {unit}"
            );
        }
    }

    #[test]
    fn expressions_that_cannot_be_computed_say_why_and_how_to_repair() {
        #[rustfmt::skip]
        let cases: &[Refusal] = &[
            // (expression, inputs, output unit, code, text in the message, text in the repair)
            ("x + y", &[("x", 1.0, "kg"), ("y", 1.0, "m")], None, "INVALID_UNITS", "Incompatible units in addition: kg (mass) and m (length) (column 3)", "same thing"),
            ("stall >= required", &[("stall", 2.5, "N*m"), ("required", 1.0, "N*m")], None, "VALIDATION", "comparison", "margin or ratio"),
            ("a / b", &[("a", 4.0, "kg"), ("b", 2.0, "kg")], Some("kg"), "INVALID_UNITS", "plain number, which cannot be reported in kg (mass)", "\"1\" or \"%\""),
            ("mass", &[("mass", 4.0, "kg")], Some("1"), "INVALID_UNITS", "dimension kg, which cannot be reported in 1", "for example \"kg\""),
            ("voltage * current", &[("voltage", 12.0, "V"), ("current", 2.0, "A")], Some("N"), "INVALID_UNITS", "cannot be reported in N (force)", "for example \"W\""),
            ("force * distance", &[("force", 10.0, "N"), ("distance", 2.0, "m")], None, "INVALID_UNITS", "more than one quantity shares", "\"J\" or \"N*m\""),
            ("speed", &[("speed", 300.0, "rpm")], Some("Hz"), "INVALID_UNITS", "cannot be reported in Hz (frequency)", "outputUnit"),
            ("ceil(a + b)", &[("a", 1.0, "mm"), ("b", 1.0, "cm")], None, "INVALID_UNITS", "ceil cannot tell which unit to round", "ceil(length / step) * step"),
            ("round(a * b)", &[("a", 2.0, "m"), ("b", 3.0, "m")], None, "INVALID_UNITS", "round cannot tell which unit", "same unit"),
            ("round(a, 1.5)", &[("a", 2.0, "m")], None, "VALIDATION", "whole number of decimals", "round(x, 2)"),
            ("len ^ 0.5", &[("len", 4.0, "m")], None, "INVALID_UNITS", "Cannot raise m (length) to the power 0.5", "area ^ 0.5"),
            ("sqrt(len)", &[("len", 4.0, "m")], None, "INVALID_UNITS", "Cannot take the square root of m (length)", "sqrt of an area"),
            ("2 ^ len", &[("len", 4.0, "m")], None, "INVALID_UNITS", "exponent must be a plain number", "dimensionless"),
            ("ln(mass)", &[("mass", 4.0, "kg")], None, "INVALID_UNITS", "ln needs a plain number, not kg (mass)", "ratio"),
            ("sin(mass)", &[("mass", 4.0, "kg")], None, "INVALID_UNITS", "sin needs an angle", "deg or rad"),
            ("atan2(y, x)", &[("y", 1.0, "m"), ("x", 1.0, "s")], None, "INVALID_UNITS", "Incompatible units in atan2", "same thing"),
            ("(((x^16)^16)^16)^16", &[("x", 1.0, "m")], None, "INVALID_UNITS", "Cannot raise", "whole powers"),
            ("x^100 * x^100", &[("x", 1.0, "m")], None, "INVALID_UNITS", "exponent that is too large", "Simplify"),
            ("t_a + t_b", &[("t_a", 20.0, "degC"), ("t_b", 30.0, "degC")], None, "INVALID_UNITS", "Adding two temperatures", "Subtract"),
            ("t", &[("t", 300.0, "K")], Some("degC"), "INVALID_UNITS", "temperature or a temperature difference", "\"K\""),
            ("t - drop", &[("t", 80.0, "degC"), ("drop", 20.0, "K")], Some("degC"), "INVALID_UNITS", "temperature or a temperature difference", "\"K\""),
            ("a / b", &[("a", 1.0, "m"), ("b", 0.0, "s")], None, "VALIDATION", "Division by zero (column 3)", "divides by"),
            ("acos(2)", &[], None, "VALIDATION", "not a finite real number", "inverse sine or cosine"),
            ("sqrt(0 - 1)", &[], None, "VALIDATION", "not a finite real number", "negative number"),
            ("x ^ (1/3)", &[("x", -8.0, "1")], None, "VALIDATION", "not a finite real number", "negative number"),
            // Syntax the oracle accepted or agents try, with what to write instead.
            ("mass * 9.81 m/s^2", &[("mass", 2.0, "kg")], None, "VALIDATION", "Unexpected 'm' after a value (column 13)", "Units belong on inputs"),
            ("2 a", &[("a", 2.0, "kg")], None, "VALIDATION", "Unexpected 'a' after a value (column 3)", "2 * a"),
            ("2(a + 1)", &[("a", 2.0, "1")], None, "VALIDATION", "Unexpected '(' after a value (column 2)", "2 * a"),
            ("m * g * h", &[("m", 2.0, "kg"), ("h", 1.0, "m")], None, "VALIDATION", "Undefined input 'g' (column 5)", "The inputs are: m, h"),
            ("mas * 2", &[("mass", 2.0, "kg")], None, "VALIDATION", "Undefined input 'mas' (column 1)", "Did you mean 'mass'?"),
            ("foo(1)", &[], None, "VALIDATION", "Unsupported function 'foo' (column 1)", "functions such as"),
            ("sqr(4)", &[], None, "VALIDATION", "Unsupported function 'sqr'", "Did you mean sqrt?"),
            ("sqrt(1, 2)", &[], None, "VALIDATION", "sqrt takes 1 argument(s), got 2", "functions such as"),
            ("atan2(1)", &[], None, "VALIDATION", "atan2 takes 2 argument(s), got 1", "functions such as"),
            ("min()", &[], None, "VALIDATION", "min takes at least 1 argument(s), got 0", "functions such as"),
            ("50%", &[], None, "VALIDATION", "'%' has nothing on its right (column 3)", "For a percentage"),
            ("a +", &[("a", 1.0, "1")], None, "VALIDATION", "'+' has nothing on its right (column 3)", "numbers, input names"),
            ("(a + 1", &[("a", 1.0, "1")], None, "VALIDATION", "A '(' is never closed (column 1)", "missing ')'"),
            ("a + 1)", &[("a", 1.0, "1")], None, "VALIDATION", "A ')' has no matching '(' (column 6)", "numbers, input names"),
            ("a = 2", &[("a", 1.0, "1")], None, "VALIDATION", "Assignments are not allowed in an expression (column 3)", "Use =="),
            ("a $ 2", &[("a", 1.0, "1")], None, "VALIDATION", "Unexpected character '$' (column 3)", "numbers, input names"),
            ("a!", &[("a", 3.0, "1")], None, "VALIDATION", "Unexpected character '!' (column 2)", "numbers, input names"),
            ("1.2.3", &[], None, "VALIDATION", "'1.2.3' is not a number (column 1)", "numbers, input names"),
            ("", &[], None, "VALIDATION", "Expression is empty", "formula over the input names"),
            ("* 2", &[], None, "VALIDATION", "Unexpected '*' (column 1)", "numbers, input names"),
        ];
        for (expression, inputs, output, code, message, repair) in cases {
            let error = match calc(expression, inputs, *output) {
                Ok((value, unit)) => panic!("{expression} must fail, gave {value} {unit}"),
                Err(error) => error,
            };
            let given_repair = error.repair.clone().unwrap_or_default();
            assert!(
                error.code == *code
                    && error.message.contains(message)
                    && given_repair.contains(repair),
                "{expression}: got {} / {} / {given_repair}",
                error.code,
                error.message
            );
        }
        let nested = format!("{}1{}", "(".repeat(80), ")".repeat(80));
        assert!(calc(&nested, &[], None)
            .unwrap_err()
            .message
            .contains("nested too deeply"));
        let long = "1 + ".repeat(600) + "1";
        assert!(calc(&long, &[], None).unwrap_err().message.contains("too"));
        let located = calc("m * g", &[("m", 2.0, "kg")], None).unwrap_err();
        let details = located.details.unwrap();
        assert_eq!(details["column"], 5);
        assert_eq!(details["expression"], "m * g");
        assert_eq!(details["inputs"], json!(["m"]));
    }

    /// Reference values are the mathjs oracle's (`MathJsCalcEngine.evaluate`
    /// on the same inputs), cross-checked with Python's math module.
    #[test]
    fn templates_match_the_oracle() {
        let (_temp, mut handle) = project();
        #[rustfmt::skip]
        let cases: &[(&str, Inputs, f64, &str)] = &[
            ("mass_budget", &[("payload", 2.0, "kg"), ("chassis", 500.0, "g"), ("electronics", 0.25, "kg"), ("battery", 1.0, "kg")], 3.75, "kg"),
            ("mass_budget", &[("payload", 300.0, "g"), ("chassis", 0.12, "kg"), ("electronics", 55.0, "g"), ("battery", 1.06, "oz")], 0.5050504945125, "kg"),
            ("power_budget", &[("avg_load", 8.0, "W"), ("peak_load", 9.5, "W"), ("margin", 1.25, "1")], 10.0, "W"),
            ("power_budget", &[("avg_load", 3200.0, "mW"), ("peak_load", 0.0061, "kW"), ("margin", 125.0, "%")], 6.1000000000000005, "W"),
            ("battery_energy", &[("voltage", 7.4, "V"), ("capacity", 450.0, "mAh"), ("usable_fraction", 0.8, "1")], 2.6639999999999997, "Wh"),
            ("battery_energy", &[("voltage", 11100.0, "mV"), ("capacity", 2.2, "Ah"), ("usable_fraction", 85.0, "%")], 20.757000000000005, "Wh"),
            ("battery_energy", &[("voltage", 7.4, "V"), ("capacity", 450.0, "mAh")], 3.33, "Wh"),
            ("power_budget", &[("avg_load", 8.0, "W"), ("peak_load", 9.5, "W")], 9.5, "W"),
            ("power_budget", &[("avg_load", 8.0, "W"), ("peak_load", 6.0, "W")], 8.0, "W"),
            ("torque_load", &[("mass", 0.505, "kg"), ("g", 9.80665, "m/s^2"), ("incline", 15.0, "deg"), ("wheel_radius", 30.0, "mm"), ("accel", 0.5, "m/s^2")], 0.04602793899811771, "N*m"),
            ("torque_load", &[("mass", 1.2, "lb"), ("g", 9.80665, "m/s^2"), ("incline", 0.2, "rad"), ("wheel_radius", 1.5, "in"), ("accel", 40.0, "cm/s^2")], 0.04869921393379981, "N*m"),
        ];
        for (template, entries, expected, unit) in cases {
            let result = run(
                &mut handle,
                &json!({"templateId": template, "inputs": inputs(entries), "assumptions": [], "submitForReview": false}),
                &Origin::User,
            )
            .unwrap();
            let value = result["result"]["value"].as_f64().unwrap();
            assert!(
                close(value, *expected) && result["result"]["unit"] == *unit,
                "{template} gave {value} {}, the oracle gives {expected} {unit}",
                result["result"]["unit"]
            );
            assert_eq!(result["revision"]["payload"]["toolVersion"], ENGINE);
        }
    }

    /// A template never needs a value the request did not give: an optional
    /// input left out takes the template's default, stated as an assumption
    /// and recorded as an input, so the reader sees what was used.
    #[test]
    fn an_optional_template_input_left_out_is_a_recorded_assumption() {
        let (_temp, mut handle) = project();
        for template in all_templates() {
            for entry in template["inputs"].as_array().unwrap() {
                let description = entry["description"].as_str().unwrap();
                assert!(!description.contains("e.g."), "{description}");
                if entry["required"] != true {
                    assert_eq!(entry["default"], 1, "{entry}");
                }
            }
        }
        let result = run(
            &mut handle,
            &json!({"templateId": "battery_energy", "inputs": inputs(&[("voltage", 7.4, "V"), ("capacity", 450.0, "mAh")]), "submitForReview": false}),
            &agent(),
        )
        .unwrap();
        let assumption = "usable_fraction was not given, so the template default 1 was used.";
        assert_eq!(result["notes"], json!([assumption]));
        let payload = &result["revision"]["payload"];
        assert!(payload["assumptions"]
            .as_array()
            .unwrap()
            .contains(&json!(assumption)));
        assert_eq!(payload["inputs"][2]["name"], "usable_fraction");
        assert_eq!(
            payload["inputs"][2]["quantity"],
            json!({"value": 1, "unit": "1"})
        );
        // Given, the value is used as it is and nothing is assumed.
        let given = run(
            &mut handle,
            &json!({"templateId": "battery_energy", "inputs": inputs(&[("voltage", 7.4, "V"), ("capacity", 450.0, "mAh"), ("usable_fraction", 0.8, "1")]), "submitForReview": false}),
            &agent(),
        )
        .unwrap();
        assert!(given.get("notes").is_none());
        assert!(!given["revision"]["payload"]["assumptions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|text| text.as_str().unwrap().contains("not given")));
    }

    #[test]
    fn templates_keep_dimensions_and_human_review_boundary() {
        let (_temp, mut handle) = project();
        let mass = run(
            &mut handle,
            &json!({"templateId":"mass_budget","inputs":inputs(&[("payload", 2.0, "kg"), ("chassis", 500.0, "g"), ("electronics", 0.25, "kg"), ("battery", 1.0, "kg")]),"assumptions":[],"submitForReview":true}),
            &agent(),
        )
        .unwrap();
        assert_eq!(mass["result"]["value"], 3.75);
        assert_eq!(mass["result"]["unit"], "kg");
        assert_eq!(mass["proposal"]["state"], "pending");
        assert_eq!(mass["proposal"]["reason"], "calculation result: 3.75 kg");
        assert!(mass["revision"]["payload"]["limitations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == SCOPE));
        let artifact = require_artifact(&handle, mass["artifactId"].as_str().unwrap()).unwrap();
        assert!(artifact["selectedRevisionId"].is_null());
        let bad = run(
            &mut handle,
            &json!({"expression":"x + y","inputs":inputs(&[("x", 1.0, "kg"), ("y", 1.0, "m")]),"assumptions":[],"submitForReview":false}),
            &Origin::User,
        )
        .unwrap_err();
        assert_eq!(bad.code, "INVALID_UNITS");
    }

    #[test]
    fn template_inputs_are_checked_against_their_declared_quantity() {
        let (_temp, mut handle) = project();
        let missing = run(
            &mut handle,
            &json!({"templateId":"mass_budget","inputs":inputs(&[("payload", 2.0, "kg")]),"assumptions":[],"submitForReview":false}),
            &Origin::User,
        )
        .unwrap_err();
        assert_eq!(missing.code, "INVALID_UNITS");
        assert_eq!(missing.message, "Missing required input 'chassis' (kg)");
        assert_eq!(missing.repair.as_deref(), Some("Supply chassis in kg."));
        let wrong = run(
            &mut handle,
            &json!({"templateId":"mass_budget","inputs":inputs(&[("payload", 2.0, "m"), ("chassis", 1.0, "kg"), ("electronics", 1.0, "kg"), ("battery", 1.0, "kg")]),"assumptions":[],"submitForReview":false}),
            &Origin::User,
        )
        .unwrap_err();
        assert_eq!(
            wrong.message,
            "Input 'payload': Cannot convert m (length) to kg (mass)"
        );
        let unknown = run(
            &mut handle,
            &json!({"expression":"a * 2","inputs":[{"name":"a","quantity":{"unknown":true,"reason":"not on the datasheet"}}],"assumptions":[],"submitForReview":false}),
            &Origin::User,
        )
        .unwrap_err();
        assert_eq!(
            unknown.message,
            "Input 'a' is unknown (not on the datasheet)"
        );
        assert_eq!(
            unknown.details.unwrap()["issues"][0]["path"],
            "inputs[0].quantity"
        );
        let unit = run(
            &mut handle,
            &json!({"expression":"a * 2","inputs":inputs(&[("a", 1.0, "stone")]),"assumptions":[],"submitForReview":false}),
            &Origin::User,
        )
        .unwrap_err();
        assert_eq!(unit.message, "Input 'a': Unknown unit 'stone'");
        assert_eq!(
            unit.details.unwrap()["issues"][0]["path"],
            "inputs[0].quantity.unit"
        );
        let twice = run(
            &mut handle,
            &json!({"expression":"a * 2","inputs":inputs(&[("a", 1.0, "kg"), ("a", 2.0, "kg")]),"assumptions":[],"submitForReview":false}),
            &Origin::User,
        )
        .unwrap_err();
        assert_eq!(twice.message, "Input 'a' is given twice");
        let name = run(
            &mut handle,
            &json!({"expression":"a * 2","inputs":inputs(&[("2a", 1.0, "kg")]),"assumptions":[],"submitForReview":false}),
            &Origin::User,
        )
        .unwrap_err();
        assert_eq!(name.message, "Invalid input name '2a'");
        let template = run(
            &mut handle,
            &json!({"templateId":"lift","inputs":[],"assumptions":[],"submitForReview":false}),
            &Origin::User,
        )
        .unwrap_err();
        assert_eq!(template.code, "NOT_FOUND");
        // None of these reached evaluation, so none of them recorded a job.
        assert!(jobs(&handle).is_empty());
    }

    #[test]
    fn every_job_finishes_and_reports_its_status() {
        let (_temp, mut handle) = project();
        let ok = run(
            &mut handle,
            &json!({"expression":"a * 2","inputs":inputs(&[("a", 1.5, "kg")]),"assumptions":[],"submitForReview":false}),
            &agent(),
        )
        .unwrap();
        assert_eq!(ok["result"], json!({"value": 3.0, "unit": "kg"}));
        // Evaluation fails.
        run(
            &mut handle,
            &json!({"expression":"a / b","inputs":inputs(&[("a", 1.0, "kg"), ("b", 0.0, "s")]),"assumptions":[],"submitForReview":false}),
            &agent(),
        )
        .unwrap_err();
        // Evaluation succeeds and recording fails: the source revision does not exist.
        let missing = uuid::Uuid::new_v4().to_string();
        let failed = run(
            &mut handle,
            &json!({"expression":"a * 2","inputs":[{"name":"a","quantity":{"value":1,"unit":"kg"},"sourceRef":{"artifactId":missing,"revisionId":missing}}],"assumptions":[],"submitForReview":false}),
            &agent(),
        )
        .unwrap_err();
        assert_eq!(failed.code, "NOT_FOUND");
        assert_eq!(
            jobs(&handle),
            vec![
                ("succeeded".to_owned(), Some(ENGINE.to_owned())),
                ("failed".to_owned(), Some(ENGINE.to_owned())),
                ("failed".to_owned(), Some(ENGINE.to_owned())),
            ]
        );
        let statuses = job_events(&handle)
            .iter()
            .map(|event| {
                assert_eq!(event["kind"], "calculation");
                assert_eq!(event["tool"], "calc");
                event["status"].as_str().unwrap().to_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            statuses,
            [
                "running",
                "succeeded",
                "running",
                "failed",
                "running",
                "failed"
            ]
        );
        let running: i64 = handle
            .db
            .query_row(
                "SELECT COUNT(*) FROM job WHERE status='running'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(running, 0);
    }

    fn count(bench: &mut crate::testkit::Bench, op: &str, key: &str, input: Value) -> usize {
        bench.user(op, input).unwrap()[key]
            .as_array()
            .unwrap()
            .len()
    }

    #[test]
    fn a_rerun_with_unchanged_inputs_creates_no_revision_and_no_proposal() {
        let mut bench = crate::testkit::Bench::new();
        let run = |payload: f64, artifact: Option<&Value>| {
            let mut input = json!({"templateId": "mass_budget", "title": "Rover mass budget", "inputs": [
                {"name": "payload", "quantity": {"value": payload, "unit": "kg"}},
                {"name": "chassis", "quantity": {"value": 120, "unit": "g"}},
                {"name": "electronics", "quantity": {"value": 55, "unit": "g"}},
                {"name": "battery", "quantity": {"value": 30, "unit": "g"}},
            ], "assumptions": ["Fasteners weighed with the chassis"]});
            if let Some(artifact) = artifact {
                input["artifactId"] = artifact.clone();
            }
            input
        };
        let first = bench.user("calculation.run", run(0.3, None)).unwrap();
        assert_eq!(first["unchanged"], false);
        assert_eq!(first["proposal"]["reason"], "calculation result: 0.505 kg");
        bench.approve(&first["proposal"]);
        let id = first["artifactId"].clone();
        let history = json!({"artifactId": id});

        // The same recorded inputs again: nothing for a person to review.
        let again = bench.user("calculation.run", run(0.3, Some(&id))).unwrap();
        assert_eq!(again["unchanged"], true);
        assert_eq!(again["proposal"], Value::Null);
        assert_eq!(again["revision"]["id"], first["revision"]["id"]);
        assert_eq!(again["result"], first["result"]);
        assert!(again["note"].as_str().unwrap().contains("0.505 kg"));
        assert_eq!(
            count(&mut bench, "artifact.history", "revisions", history.clone()),
            1
        );
        assert_eq!(
            count(
                &mut bench,
                "proposal.list",
                "proposals",
                json!({"state": "pending"})
            ),
            0
        );
        // A value sent as 0.30 or with other key order is still the same quantity.
        let mut reordered = run(0.3, Some(&id));
        reordered["inputs"][1]["quantity"] = json!({"unit": "g", "value": 120.0});
        assert_eq!(
            bench.user("calculation.run", reordered).unwrap()["unchanged"],
            true
        );

        // A changed input is a new result and goes to review once.
        let changed = bench.user("calculation.run", run(0.5, Some(&id))).unwrap();
        assert_eq!(changed["unchanged"], false);
        assert_eq!(changed["proposal"]["state"], "pending");
        assert_eq!(
            changed["proposal"]["reason"],
            "calculation result: 0.705 kg"
        );
        assert_eq!(changed["revision"]["parentId"], first["revision"]["id"]);
        let repeated = bench.user("calculation.run", run(0.5, Some(&id))).unwrap();
        assert_eq!(repeated["unchanged"], true);
        assert_eq!(repeated["revision"]["id"], changed["revision"]["id"]);
        assert_eq!(repeated["proposal"]["id"], changed["proposal"]["id"]);
        assert_eq!(
            count(&mut bench, "artifact.history", "revisions", history),
            2
        );
        assert_eq!(
            count(
                &mut bench,
                "proposal.list",
                "proposals",
                json!({"state": "pending"})
            ),
            1
        );
        // Every run, changed or not, finished its job.
        let jobs = bench.user("job.list", json!({})).unwrap();
        let statuses = jobs["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|job| job["status"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(statuses, ["succeeded"; 5]);
        assert_eq!(bench.events("job.updated").len(), 10);
    }

    #[test]
    fn a_declared_output_unit_is_recorded_and_kept_by_a_rerun() {
        let mut bench = crate::testkit::Bench::new();
        let run = |extra: Value| {
            let mut input = json!({"title": "Pack energy", "expression": "voltage * capacity", "submitForReview": false, "inputs": [
                {"name": "voltage", "quantity": {"value": 7.4, "unit": "V"}},
                {"name": "capacity", "quantity": {"value": 450, "unit": "mAh"}},
            ]});
            for (key, value) in extra.as_object().unwrap() {
                input[key.as_str()] = value.clone();
            }
            input
        };
        // V x Ah is an energy, and energy shares its dimension with torque: the caller has to say.
        let ambiguous = bench.agent("calculation.run", run(json!({}))).unwrap_err();
        assert_eq!(ambiguous.code, "INVALID_UNITS");
        assert!(ambiguous.repair.unwrap().contains("\"J\" or \"N*m\""));
        let first = bench
            .agent("calculation.run", run(json!({"outputUnit": "Wh"})))
            .unwrap();
        assert!(close(first["result"]["value"].as_f64().unwrap(), 3.33));
        assert_eq!(first["result"]["unit"], "Wh");
        assert_eq!(first["revision"]["payload"]["outputUnit"], "Wh");
        assert_eq!(
            first["revision"]["payload"]["result"]["quantity"]["unit"],
            "Wh"
        );
        // The re-run names no unit and still reports in the recorded one.
        let again = bench
            .agent(
                "calculation.run",
                run(json!({"artifactId": first["artifactId"]})),
            )
            .unwrap();
        assert_eq!(again["unchanged"], true);
        assert_eq!(again["result"]["unit"], "Wh");
        let joules = bench
            .agent(
                "calculation.run",
                run(json!({"artifactId": first["artifactId"], "outputUnit": "J"})),
            )
            .unwrap();
        assert_eq!(joules["unchanged"], false);
        assert_eq!(joules["result"], json!({"value": 11988.0, "unit": "J"}));
        let wrong = bench
            .agent("calculation.run", run(json!({"outputUnit": "W"})))
            .unwrap_err();
        assert_eq!(wrong.code, "INVALID_UNITS");
        let unknown = bench
            .agent("calculation.run", run(json!({"outputUnit": "horsepower"})))
            .unwrap_err();
        assert_eq!(unknown.message, "Output unit: Unknown unit 'horsepower'");
        assert_eq!(unknown.details.unwrap()["issues"][0]["path"], "outputUnit");
        // An agent's run never moves a baseline.
        let listed = bench.read(first["artifactId"].as_str().unwrap());
        assert!(listed["view"]["artifact"]["selectedRevisionId"].is_null());
    }

    #[test]
    fn a_run_on_another_artifact_type_is_refused_before_any_job() {
        let (_temp, mut handle) = project();
        let note = create_draft(
            &mut handle,
            &json!({"type":"note","title":"Notes","payload":{"markdown":"x"}}),
            &Origin::User,
        )
        .unwrap();
        let error = run(
            &mut handle,
            &json!({"artifactId":note["artifact"]["id"],"expression":"1 + 1","inputs":[],"assumptions":[],"submitForReview":false}),
            &Origin::User,
        )
        .unwrap_err();
        assert_eq!(error.message, "Notes is a note artifact, not a calculation");
        assert!(jobs(&handle).is_empty());
    }
}
