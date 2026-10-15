//! Units of measure shared by the bill of materials, calculations and wiring.
//!
//! One table (`units.json`, the contract units plus exact SI additions), one
//! dimension vector, one conversion. A unit that is not in the table can still
//! be written as a product of table units (`N/mm^2`, `g/cm^3`, `kg*m^2`).
//! A value whose unit is unknown or does not fit is never treated as zero: the
//! caller gets the reason and counts it as unknown.

use super::*;
use serde::Deserialize;
use std::sync::OnceLock;

/// Symbols of the base dimensions, in the order of the exponent vector.
const BASE_SYMBOLS: [&str; 7] = ["m", "kg", "s", "A", "K", "B", "rad"];
const ANGLE: usize = 6;

/// Named dimensions: the name used in `units.json`, its exponents over
/// [length, mass, time, current, temperature, data, angle], and the coherent
/// SI unit a derived result is reported in.
const DIMENSIONS: [(&str, [i8; 7], &str); 22] = [
    ("dimensionless", [0, 0, 0, 0, 0, 0, 0], "1"),
    ("length", [1, 0, 0, 0, 0, 0, 0], "m"),
    ("mass", [0, 1, 0, 0, 0, 0, 0], "kg"),
    ("time", [0, 0, 1, 0, 0, 0, 0], "s"),
    ("current", [0, 0, 0, 1, 0, 0, 0], "A"),
    ("temperature", [0, 0, 0, 0, 1, 0, 0], "K"),
    ("data", [0, 0, 0, 0, 0, 1, 0], "B"),
    ("angle", [0, 0, 0, 0, 0, 0, 1], "rad"),
    ("speed", [1, 0, -1, 0, 0, 0, 0], "m/s"),
    ("acceleration", [1, 0, -2, 0, 0, 0, 0], "m/s^2"),
    ("angular_speed", [0, 0, -1, 0, 0, 0, 1], "rad/s"),
    ("frequency", [0, 0, -1, 0, 0, 0, 0], "Hz"),
    ("charge", [0, 0, 1, 1, 0, 0, 0], "C"),
    ("voltage", [2, 1, -3, -1, 0, 0, 0], "V"),
    ("resistance", [2, 1, -3, -2, 0, 0, 0], "ohm"),
    ("power", [2, 1, -3, 0, 0, 0, 0], "W"),
    ("energy", [2, 1, -2, 0, 0, 0, 0], "J"),
    ("torque", [2, 1, -2, 0, 0, 0, 0], "N*m"),
    ("force", [1, 1, -2, 0, 0, 0, 0], "N"),
    ("pressure", [-1, 1, -2, 0, 0, 0, 0], "Pa"),
    ("volume", [3, 0, 0, 0, 0, 0, 0], "m^3"),
    ("area", [2, 0, 0, 0, 0, 0, 0], "m^2"),
];

/// Exponents of the base dimensions. Arithmetic is checked: an expression
/// cannot overflow an exponent, it gets an error instead.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) struct Dim([i8; 7]);

impl Dim {
    pub(crate) const NONE: Self = Self([0; 7]);

    pub(crate) fn is_none(self) -> bool {
        self == Self::NONE
    }

    pub(crate) fn plus(self, other: Self) -> Option<Self> {
        self.zip(other, i8::checked_add)
    }

    pub(crate) fn minus(self, other: Self) -> Option<Self> {
        self.zip(other, i8::checked_sub)
    }

    fn zip(self, other: Self, op: fn(i8, i8) -> Option<i8>) -> Option<Self> {
        let mut out = [0_i8; 7];
        for (index, slot) in out.iter_mut().enumerate() {
            *slot = op(self.0[index], other.0[index])?;
        }
        Some(Self(out))
    }

    /// Every exponent multiplied by `power`. `None` when a result is not a
    /// whole number (`m ^ 0.5`) or does not fit.
    pub(crate) fn powered(self, power: f64) -> Option<Self> {
        let mut out = [0_i8; 7];
        for (index, slot) in out.iter_mut().enumerate() {
            let exact = f64::from(self.0[index]) * power;
            let whole = exact.round();
            if (exact - whole).abs() > 1e-9 || whole.abs() > f64::from(i8::MAX) {
                return None;
            }
            *slot = whole as i8;
        }
        Some(Self(out))
    }

    /// The radian is the coherent SI unit of angle and equals one, so a
    /// result such as torque x angular speed is a power once the angle is
    /// dropped.
    pub(crate) fn without_angle(self) -> Self {
        let mut out = self.0;
        out[ANGLE] = 0;
        Self(out)
    }

    pub(crate) fn has_angle(self) -> bool {
        self.0[ANGLE] != 0
    }

    fn named(name: &str) -> Option<Self> {
        DIMENSIONS
            .iter()
            .find(|(candidate, _, _)| *candidate == name)
            .map(|(_, exponents, _)| Self(*exponents))
    }

    /// Product of SI base units for this dimension, e.g. `kg*m^2/s^2`.
    pub(crate) fn si_expression(self) -> String {
        let term = |index: usize, exponent: i8| {
            if exponent == 1 {
                BASE_SYMBOLS[index].to_owned()
            } else {
                format!("{}^{exponent}", BASE_SYMBOLS[index])
            }
        };
        // Mass first, then the vector order: kg*m^2/s^2 reads as SI writes it.
        let order = [1, 0, 2, 3, 4, 5, 6];
        let above = order
            .iter()
            .filter(|index| self.0[**index] > 0)
            .map(|index| term(*index, self.0[*index]))
            .collect::<Vec<_>>();
        let below = order
            .iter()
            .filter(|index| self.0[**index] < 0)
            .map(|index| term(*index, -self.0[*index]))
            .collect::<Vec<_>>();
        let numerator = if above.is_empty() {
            "1".to_owned()
        } else {
            above.join("*")
        };
        match below.len() {
            0 => numerator,
            1 => format!("{numerator}/{}", below[0]),
            _ => format!("{numerator}/({})", below.join("*")),
        }
    }
}

/// A unit of measure: `base = value * scale + offset`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Unit {
    /// Canonical spelling (`N*m` for `Nm`).
    pub(crate) name: String,
    pub(crate) dim: Dim,
    pub(crate) scale: f64,
    pub(crate) offset: f64,
    /// Named dimension from the table (`mass`, `torque`); `None` for a unit
    /// composed from other units.
    pub(crate) quantity: Option<&'static str>,
}

impl Unit {
    pub(crate) fn to_base(&self, value: f64) -> f64 {
        value * self.scale + self.offset
    }

    pub(crate) fn value_of(&self, base: f64) -> f64 {
        (base - self.offset) / self.scale
    }

    /// Like `value_of` for a difference: the zero offset of a scale such as
    /// degrees Celsius does not apply to a temperature rise.
    pub(crate) fn difference_of(&self, base: f64) -> f64 {
        base / self.scale
    }

    pub(crate) fn has_offset(&self) -> bool {
        self.offset != 0.0
    }

    /// What the unit measures, for messages: `mass`, or the SI expression of
    /// a composed unit.
    pub(crate) fn measures(&self) -> String {
        self.quantity
            .map(str::to_owned)
            .unwrap_or_else(|| self.dim.si_expression())
    }

    /// Two table units measure the same thing only when the table says so:
    /// torque and energy share a dimension vector and still do not convert.
    /// A composed unit is compared by dimension.
    pub(crate) fn converts_to(&self, other: &Unit) -> bool {
        match (self.quantity, other.quantity) {
            (Some(a), Some(b)) => a == b,
            _ => self.dim == other.dim,
        }
    }
}

#[derive(Deserialize)]
struct TableEntry {
    name: String,
    dim: String,
    scale: f64,
    offset: f64,
}

fn table() -> &'static HashMap<String, Unit> {
    static TABLE: OnceLock<HashMap<String, Unit>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let entries: HashMap<String, TableEntry> =
            serde_json::from_str(include_str!("../units.json")).expect("frozen unit table");
        entries
            .into_iter()
            .map(|(key, entry)| {
                let (quantity, exponents, _) = DIMENSIONS
                    .iter()
                    .find(|(name, _, _)| *name == entry.dim)
                    .expect("unit table names a known dimension");
                let unit = Unit {
                    name: entry.name,
                    dim: Dim(*exponents),
                    scale: entry.scale,
                    offset: entry.offset,
                    quantity: Some(quantity),
                };
                (key, unit)
            })
            .collect()
    })
}

fn unknown_unit(text: &str) -> ContractError {
    let names = table().keys().map(String::as_str);
    let nearest =
        omenflow_contracts::nearest_match(text, names).map(|key| table()[key].name.clone());
    let mut repair = String::from(
        "Use a unit from the table (kg, g, mm, m, s, V, A, W, Wh, N, N*m, rad, deg, rpm, Pa, ohm, Hz, 1, %) or a product of them such as N/mm^2 or g/cm^3.",
    );
    if let Some(nearest) = &nearest {
        repair = format!("Did you mean '{nearest}'? {repair}");
    }
    ContractError::new("INVALID_UNITS", format!("Unknown unit '{text}'"))
        .with_repair(repair)
        .with_details(json!({"unit": text, "nearest": nearest}))
}

/// Parse a unit as written on a quantity: a table unit or alias, or a product
/// and quotient of table units with whole-number powers.
pub(crate) fn parse(text: &str) -> CoreResult<Unit> {
    if let Some(unit) = table().get(text).or_else(|| table().get(text.trim())) {
        return Ok(unit.clone());
    }
    let compact: String = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .map(|character| if character == '·' { '*' } else { character })
        .collect();
    if !compact.contains(['*', '/', '^', '(']) {
        return Err(unknown_unit(text));
    }
    let mut parser = CompoundParser {
        text: &compact,
        chars: compact.char_indices().peekable(),
        original: text,
    };
    let (dim, scale) = parser.product()?;
    if parser.chars.peek().is_some() {
        return Err(unknown_unit(text));
    }
    Ok(Unit {
        name: compact.clone(),
        dim,
        scale,
        offset: 0.0,
        quantity: None,
    })
}

struct CompoundParser<'a> {
    text: &'a str,
    chars: std::iter::Peekable<std::str::CharIndices<'a>>,
    original: &'a str,
}

impl CompoundParser<'_> {
    fn overflow(&self) -> ContractError {
        ContractError::new(
            "INVALID_UNITS",
            format!("Unit '{}' has an exponent that is too large", self.original),
        )
    }

    fn product(&mut self) -> CoreResult<(Dim, f64)> {
        let (mut dim, mut scale) = self.factor()?;
        while let Some((_, operator)) = self.chars.next_if(|(_, c)| matches!(c, '*' | '/')) {
            let (next_dim, next_scale) = self.factor()?;
            if operator == '*' {
                dim = dim.plus(next_dim).ok_or_else(|| self.overflow())?;
                scale *= next_scale;
            } else {
                dim = dim.minus(next_dim).ok_or_else(|| self.overflow())?;
                scale /= next_scale;
            }
        }
        Ok((dim, scale))
    }

    fn factor(&mut self) -> CoreResult<(Dim, f64)> {
        let (dim, scale) = if self.chars.next_if(|(_, c)| *c == '(').is_some() {
            let inner = self.product()?;
            if self.chars.next_if(|(_, c)| *c == ')').is_none() {
                return Err(unknown_unit(self.original));
            }
            inner
        } else {
            self.atom()?
        };
        if self.chars.next_if(|(_, c)| *c == '^').is_none() {
            return Ok((dim, scale));
        }
        let start = self
            .chars
            .peek()
            .map_or(self.text.len(), |(index, _)| *index);
        let mut end = start;
        while let Some((index, character)) = self
            .chars
            .next_if(|(index, c)| c.is_ascii_digit() || (*c == '-' && *index == start))
        {
            end = index + character.len_utf8();
        }
        let power: i8 = self.text[start..end]
            .parse()
            .map_err(|_| unknown_unit(self.original))?;
        let dim = dim
            .powered(f64::from(power))
            .ok_or_else(|| self.overflow())?;
        Ok((dim, scale.powi(i32::from(power))))
    }

    fn atom(&mut self) -> CoreResult<(Dim, f64)> {
        let start = self
            .chars
            .peek()
            .map_or(self.text.len(), |(index, _)| *index);
        let mut end = start;
        while let Some((index, character)) = self
            .chars
            .next_if(|(_, c)| !matches!(c, '*' | '/' | '^' | '(' | ')'))
        {
            end = index + character.len_utf8();
        }
        let name = &self.text[start..end];
        let unit = table().get(name).ok_or_else(|| unknown_unit(name))?;
        if unit.has_offset() {
            return Err(ContractError::new(
                "INVALID_UNITS",
                format!(
                    "'{name}' has a zero offset and cannot be part of the composed unit '{}'",
                    self.original
                ),
            )
            .with_repair("Use K for temperature inside a composed unit."));
        }
        Ok((unit.dim, unit.scale))
    }
}

/// Unit names written out in words, each with the one symbol it means. A
/// name that could mean more than one quantity is not here: it is refused
/// with the candidates rather than guessed.
const SPELLED: [(&str, &str); 92] = [
    ("degree", "deg"),
    ("degrees", "deg"),
    ("radian", "rad"),
    ("radians", "rad"),
    ("second", "s"),
    ("seconds", "s"),
    ("secs", "s"),
    ("millisecond", "ms"),
    ("milliseconds", "ms"),
    ("microsecond", "us"),
    ("microseconds", "us"),
    ("minute", "min"),
    ("minutes", "min"),
    ("mins", "min"),
    ("hours", "h"),
    ("hrs", "h"),
    ("days", "day"),
    ("gram", "g"),
    ("grams", "g"),
    ("gramme", "g"),
    ("grammes", "g"),
    ("kilogram", "kg"),
    ("kilograms", "kg"),
    ("kilogramme", "kg"),
    ("kilogrammes", "kg"),
    ("kgs", "kg"),
    ("milligram", "mg"),
    ("milligrams", "mg"),
    ("meter", "m"),
    ("meters", "m"),
    ("metre", "m"),
    ("metres", "m"),
    ("millimeter", "mm"),
    ("millimeters", "mm"),
    ("millimetre", "mm"),
    ("millimetres", "mm"),
    ("centimeter", "cm"),
    ("centimeters", "cm"),
    ("centimetre", "cm"),
    ("centimetres", "cm"),
    ("kilometer", "km"),
    ("kilometers", "km"),
    ("kilometre", "km"),
    ("kilometres", "km"),
    ("micrometer", "um"),
    ("micrometers", "um"),
    ("micrometre", "um"),
    ("micrometres", "um"),
    ("micron", "um"),
    ("microns", "um"),
    ("inches", "in"),
    ("foot", "ft"),
    ("feet", "ft"),
    ("volt", "V"),
    ("volts", "V"),
    ("millivolt", "mV"),
    ("millivolts", "mV"),
    ("amp", "A"),
    ("amps", "A"),
    ("ampere", "A"),
    ("amperes", "A"),
    ("milliamp", "mA"),
    ("milliamps", "mA"),
    ("watt", "W"),
    ("watts", "W"),
    ("milliwatt", "mW"),
    ("milliwatts", "mW"),
    ("kilowatt", "kW"),
    ("kilowatts", "kW"),
    ("joule", "J"),
    ("joules", "J"),
    ("watt hour", "Wh"),
    ("watt hours", "Wh"),
    ("amp hour", "Ah"),
    ("amp hours", "Ah"),
    ("milliamp hour", "mAh"),
    ("milliamp hours", "mAh"),
    ("newton", "N"),
    ("newtons", "N"),
    ("newton meter", "N*m"),
    ("newton meters", "N*m"),
    ("newton metre", "N*m"),
    ("newton metres", "N*m"),
    ("hertz", "Hz"),
    ("pascal", "Pa"),
    ("pascals", "Pa"),
    ("ohms", "ohm"),
    ("kelvin", "K"),
    ("celsius", "degC"),
    ("degrees celsius", "degC"),
    ("liter", "L"),
    ("liters", "L"),
];

/// Names that mean more than one quantity, with the symbols to choose from.
const AMBIGUOUS: [(&str, &str); 4] = [
    ("pound", "lb (mass) or lbf (force)"),
    ("pounds", "lb (mass) or lbf (force)"),
    (
        "ounce",
        "oz (mass); a volume in fluid ounces has no unit here, use mL",
    ),
    (
        "ounces",
        "oz (mass); a volume in fluid ounces has no unit here, use mL",
    ),
];

/// The symbol a written-out unit name means, when it means exactly one.
fn spelled(text: &str) -> Option<&'static str> {
    let words = text
        .trim()
        .to_lowercase()
        .replace(['-', '_', '·'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    SPELLED
        .iter()
        .find(|(name, _)| *name == words)
        .map(|(_, symbol)| *symbol)
}

/// Whether `check_authored` keeps a quantity in `unit`.
pub(crate) fn accepts(unit: &str) -> bool {
    parse(unit).is_ok() || spelled(unit).is_some()
}

/// Check every quantity (`{"value": <number>, "unit": "<text>"}`) in content
/// an agent authored, at any depth below `path`. A unit the table reads stays
/// as written. A unit written out in words with one meaning becomes its
/// symbol, and each change is returned as a note. Anything else, including a
/// name that could mean more than one quantity, is refused: a value whose
/// unit nothing can convert would be stored as if it were known.
pub(crate) fn check_authored(value: &mut Value, path: &str) -> CoreResult<Vec<String>> {
    let mut notes = Vec::new();
    let mut issues = Vec::new();
    check_at(value, path, &mut notes, &mut issues);
    if issues.is_empty() {
        return Ok(notes);
    }
    let first = issues[0]["message"].as_str().unwrap_or_default().to_owned();
    let suggestions = issues
        .iter()
        .filter_map(|issue| issue["expected"].as_str())
        .collect::<Vec<_>>();
    let mut repair = String::from("Write each unit as a symbol");
    if !suggestions.is_empty() {
        repair.push_str(&format!(" ({})", suggestions.join("; ")));
    }
    repair.push_str(": kg, g, mm, m, s, min, h, deg, rad, V, A, mAh, Wh, W, N, N*m, Pa, ohm, Hz, 1 or %, or a product of them such as N/mm^2.");
    Err(ContractError::new(
        "INVALID_UNITS",
        if issues.len() == 1 {
            first
        } else {
            format!("{first} (+{} more)", issues.len() - 1)
        },
    )
    .with_repair(repair)
    .with_details(json!({"issues": issues})))
}

fn check_at(value: &mut Value, path: &str, notes: &mut Vec<String>, issues: &mut Vec<Value>) {
    let join = |key: &str| {
        if path.is_empty() {
            key.to_owned()
        } else {
            format!("{path}.{key}")
        }
    };
    match value {
        Value::Object(fields) => {
            if let (Some(Value::Number(_)), Some(Value::String(unit))) =
                (fields.get("value"), fields.get("unit"))
            {
                let at = join("unit");
                if parse(unit).is_err() {
                    match spelled(unit) {
                        Some(symbol) => {
                            notes.push(format!("{at}: read \"{unit}\" as {symbol}"));
                            fields.insert("unit".into(), json!(symbol));
                        }
                        None => issues.push(unit_issue(&at, unit)),
                    }
                }
            }
            for (key, child) in fields.iter_mut() {
                check_at(child, &join(key), notes, issues);
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                check_at(item, &format!("{path}[{index}]"), notes, issues);
            }
        }
        _ => {}
    }
}

fn unit_issue(path: &str, unit: &str) -> Value {
    let lowered = unit.trim().to_lowercase();
    let expected = match AMBIGUOUS.iter().find(|(name, _)| *name == lowered) {
        Some((_, choices)) => Some((*choices).to_owned()),
        None => unknown_unit(unit).details.and_then(|details| {
            details["nearest"]
                .as_str()
                .map(|nearest| format!("nearest: {nearest}"))
        }),
    };
    let mut issue = json!({"path": path, "message": format!("Unknown unit '{unit}' at {path}"), "received": unit});
    if let Some(expected) = expected {
        issue["expected"] = json!(expected);
    }
    issue
}

/// Convert a value between two units that measure the same thing.
pub(crate) fn convert(value: f64, from: &Unit, to: &Unit) -> CoreResult<f64> {
    if !from.converts_to(to) {
        return Err(ContractError::new(
            "INVALID_UNITS",
            format!(
                "Cannot convert {} ({}) to {} ({})",
                from.name,
                from.measures(),
                to.name,
                to.measures()
            ),
        )
        .with_repair(format!(
            "Give the value in a unit of {}, for example {}.",
            to.measures(),
            to.name
        )));
    }
    Ok(to.value_of(from.to_base(value)))
}

/// A recorded quantity as the engineering record holds it: a value with a
/// unit, or an explicit unknown with the reason.
pub(crate) enum Reading {
    Known { value: f64, unit: Unit },
    Unknown { reason: String },
}

/// Read `{value, unit}` or `{unknown: true, reason}`. Anything that cannot be
/// used as a number with a known unit is `Unknown` with the reason.
pub(crate) fn read(quantity: &Value) -> Reading {
    if quantity.is_null() {
        return Reading::Unknown {
            reason: "not recorded".into(),
        };
    }
    if quantity["unknown"] == true {
        return Reading::Unknown {
            reason: quantity["reason"]
                .as_str()
                .filter(|reason| !reason.trim().is_empty())
                .unwrap_or("recorded as unknown")
                .to_owned(),
        };
    }
    let Some(value) = quantity["value"].as_f64().filter(|value| value.is_finite()) else {
        return Reading::Unknown {
            reason: "no numeric value".into(),
        };
    };
    match parse(quantity["unit"].as_str().unwrap_or("")) {
        Ok(unit) => Reading::Known { value, unit },
        Err(error) => Reading::Unknown {
            reason: error.message,
        },
    }
}

/// How a derived result is reported when the caller declared no unit.
pub(crate) enum Coherent {
    Unit(Unit),
    /// Several table quantities share the dimension (energy and torque): the
    /// caller has to say which one is meant.
    Ambiguous(Vec<&'static str>),
}

/// The coherent SI unit for a dimension: the table unit when exactly one
/// quantity has that dimension, otherwise a product of base units.
pub(crate) fn coherent(dim: Dim) -> Coherent {
    let named = DIMENSIONS
        .iter()
        .filter(|(_, exponents, _)| Dim(*exponents) == dim)
        .map(|(_, _, unit)| *unit)
        .collect::<Vec<_>>();
    match named.as_slice() {
        [unit] => Coherent::Unit(parse(unit).expect("coherent unit is in the table")),
        [] => Coherent::Unit(Unit {
            name: dim.si_expression(),
            dim,
            scale: 1.0,
            offset: 0.0,
            quantity: None,
        }),
        _ => Coherent::Ambiguous(named),
    }
}

/// Dimension of a named table quantity (`mass`, `voltage`).
pub(crate) fn dimension(name: &str) -> Dim {
    Dim::named(name).unwrap_or(Dim::NONE)
}

/// `value` rounded to `digits` significant digits, a tie going away from zero
/// (the rule of JavaScript `toPrecision`, which the interface uses).
fn round_significant(value: f64, digits: usize) -> f64 {
    if value == 0.0 || !value.is_finite() {
        return value;
    }
    // Twenty digits past the kept ones are more than an f64 carries, so the
    // first dropped digit decides the rounding exactly.
    let text = format!("{:.*e}", digits + 20, value.abs());
    let Some((mantissa, exponent)) = text.split_once('e') else {
        return value;
    };
    let Ok(exponent) = exponent.parse::<i32>() else {
        return value;
    };
    let all = mantissa
        .bytes()
        .filter(u8::is_ascii_digit)
        .map(|byte| u64::from(byte - b'0'))
        .collect::<Vec<_>>();
    let mut kept = all[..digits].iter().fold(0, |sum, digit| sum * 10 + digit);
    if all[digits] >= 5 {
        kept += 1;
    }
    format!("{kept}e{}", exponent - (digits as i32 - 1))
        .parse::<f64>()
        .map_or(value, |rounded| rounded.copysign(value))
}

/// A number as JavaScript prints it: shortest text that reads back to the
/// same value, exponent form only for very large and very small magnitudes.
pub(crate) fn format_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let magnitude = value.abs();
    if (1e-6..1e21).contains(&magnitude) {
        return format!("{value}");
    }
    let text = format!("{value:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// A quantity for people: four significant digits and the unit, the same text
/// the interface shows (`formatQty` in the contracts package).
pub(crate) fn format_quantity(value: f64, unit: &str) -> String {
    format!("{} {unit}", format_number(round_significant(value, 4)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn converted(value: f64, from: &str, to: &str) -> CoreResult<f64> {
        convert(value, &parse(from).unwrap(), &parse(to).unwrap())
    }

    fn close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= expected.abs() * 1e-12 + 1e-15,
            "{actual} is not {expected}"
        );
    }

    #[test]
    fn converts_between_units_of_one_quantity() {
        // Expected values are the defining factors, written out by hand.
        for (value, from, to, expected) in [
            (15.0, "g", "kg", 0.015),
            (1.0, "lb", "g", 453.59237),
            (1.0, "oz", "g", 28.349523125),
            (25.4, "mm", "in", 1.0),
            (1.0, "ft", "mm", 304.8),
            (3300.0, "mV", "V", 3.3),
            (2.0, "Ah", "mAh", 2000.0),
            (1.0, "Wh", "J", 3600.0),
            (1.0, "kg*cm", "N*m", 0.0980665),
            (180.0, "deg", "rad", std::f64::consts::PI),
            (60.0, "rpm", "rad/s", 2.0 * std::f64::consts::PI),
            (36.0, "km/h", "m/s", 10.0),
            (25.0, "degC", "K", 298.15),
            (0.0, "K", "degC", -273.15),
            (1.0, "MiB", "KiB", 1024.0),
            (50.0, "%", "1", 0.5),
            (1.0, "bar", "kPa", 100.0),
            (1.0, "psi", "Pa", 6894.757293168361),
            (4.7, "kohm", "ohm", 4700.0),
            (1.5, "L", "mL", 1500.0),
            (250.0, "um", "mm", 0.25),
        ] {
            close(converted(value, from, to).unwrap(), expected);
        }
    }

    #[test]
    fn aliases_resolve_to_the_canonical_unit() {
        assert_eq!(parse("Nm").unwrap().name, "N*m");
        assert_eq!(parse("lbs").unwrap().name, "lb");
        assert_eq!(parse("°C").unwrap().name, "degC");
        assert_eq!(parse("Ω").unwrap().name, "ohm");
        assert_eq!(parse(" kg ").unwrap().name, "kg");
        assert_eq!(parse("").unwrap().name, "1");
    }

    #[test]
    fn composed_units_carry_scale_and_dimension() {
        let stress = parse("N/mm^2").unwrap();
        assert_eq!(stress.dim, dimension("pressure"));
        close(convert(1.0, &stress, &parse("MPa").unwrap()).unwrap(), 1.0);
        close(converted(1.0, "g/cm^3", "kg/m^3").unwrap(), 1000.0);
        close(converted(2.0, "m^2", "cm^2").unwrap(), 20_000.0);
        close(converted(1.0, "L", "cm^3").unwrap(), 1000.0);
        close(converted(5.0, "V/A", "ohm").unwrap(), 5.0);
        close(converted(1.0, "kg*m^2/s^2", "J").unwrap(), 1.0);
        close(converted(3.0, "1/s", "Hz").unwrap(), 3.0);
        close(converted(1.0, "W/(m·K)", "mW/(mm*K)").unwrap(), 1.0);
        assert_eq!(parse("s^-1").unwrap().dim, dimension("frequency"));
        // A table name wins over composition: kg*cm is the torque kgf.cm.
        assert_eq!(parse("kg*cm").unwrap().quantity, Some("torque"));
    }

    #[test]
    fn refuses_conversions_that_change_the_quantity() {
        let error = converted(1.0, "g", "m").unwrap_err();
        assert_eq!(error.code, "INVALID_UNITS");
        assert_eq!(error.message, "Cannot convert g (mass) to m (length)");
        assert!(error.repair.unwrap().contains("unit of length"));
        // Same dimension vector, different quantity.
        let torque = converted(1.0, "J", "N*m").unwrap_err();
        assert_eq!(torque.message, "Cannot convert J (energy) to N*m (torque)");
        assert_eq!(
            converted(1.0, "mm^2", "m").unwrap_err().message,
            "Cannot convert mm^2 (m^2) to m (length)"
        );
    }

    #[test]
    fn unknown_units_are_errors_with_the_nearest_name() {
        let error = parse("stone").unwrap_err();
        assert_eq!(error.code, "INVALID_UNITS");
        assert_eq!(error.message, "Unknown unit 'stone'");
        let near = parse("Kg").unwrap_err();
        assert!(near.repair.unwrap().starts_with("Did you mean 'kg'?"));
        assert_eq!(
            parse("N/furlong").unwrap_err().message,
            "Unknown unit 'furlong'"
        );
        assert_eq!(parse("m^").unwrap_err().code, "INVALID_UNITS");
        assert_eq!(parse("(m").unwrap_err().code, "INVALID_UNITS");
        assert_eq!(parse("m^200").unwrap_err().code, "INVALID_UNITS");
        assert!(parse("W/degC").unwrap_err().message.contains("zero offset"));
    }

    #[test]
    fn readings_keep_unknown_values_unknown() {
        let known = read(&json!({"value": 15, "unit": "g"}));
        assert!(
            matches!(known, Reading::Known { value, ref unit } if value == 15.0 && unit.name == "g")
        );
        for (quantity, reason) in [
            (Value::Null, "not recorded"),
            (
                json!({"unknown": true, "reason": "not on the datasheet"}),
                "not on the datasheet",
            ),
            (
                json!({"unknown": true, "reason": ""}),
                "recorded as unknown",
            ),
            (json!({"unit": "g"}), "no numeric value"),
            (json!({"value": 2, "unit": "stone"}), "Unknown unit 'stone'"),
        ] {
            match read(&quantity) {
                Reading::Unknown { reason: actual } => assert_eq!(actual, reason),
                Reading::Known { .. } => panic!("{quantity} must be unknown"),
            }
        }
    }

    #[test]
    fn coherent_units_follow_the_dimension() {
        let name = |dim: Dim| match coherent(dim) {
            Coherent::Unit(unit) => unit.name,
            Coherent::Ambiguous(options) => options.join(" or "),
        };
        assert_eq!(name(Dim::NONE), "1");
        assert_eq!(name(dimension("power")), "W");
        assert_eq!(name(dimension("pressure")), "Pa");
        assert_eq!(name(dimension("energy")), "J or N*m");
        let density = parse("kg/m^3").unwrap().dim;
        assert_eq!(name(density), "kg/m^3");
        let odd = parse("A^2*s/(kg*m)").unwrap().dim;
        assert_eq!(name(odd), "s*A^2/(kg*m)");
        assert_eq!(parse(&name(odd)).unwrap().dim, odd);
        assert_eq!(name(parse("1/m").unwrap().dim), "1/m");
    }

    #[test]
    fn dimension_arithmetic_is_checked() {
        let length = dimension("length");
        assert_eq!(length.powered(2.0), Some(dimension("area")));
        assert_eq!(dimension("area").powered(0.5), Some(length));
        assert_eq!(dimension("volume").powered(1.0 / 3.0), Some(length));
        assert_eq!(length.powered(0.5), None);
        assert_eq!(length.powered(200.0), None);
        let big = length.powered(100.0).unwrap();
        assert_eq!(big.plus(big), None);
        assert_eq!(
            dimension("angular_speed").without_angle(),
            dimension("frequency")
        );
    }

    #[test]
    fn quantities_print_as_the_interface_prints_them() {
        for (value, unit, text) in [
            (0.30000000000000004, "kg", "0.3 kg"),
            (23.519999999999996, "Wh", "23.52 Wh"),
            (2.0, "kg", "2 kg"),
            (1234.5, "g", "1235 g"),
            (-1234.5, "g", "-1235 g"),
            (0.00012344, "m", "0.0001234 m"),
            (123456.0, "mm", "123500 mm"),
            (0.0, "V", "0 V"),
            (1.5e-7, "A", "1.5e-7 A"),
            (2.5e21, "B", "2.5e+21 B"),
            (99995.0, "s", "100000 s"),
        ] {
            assert_eq!(format_quantity(value, unit), text);
        }
        assert_eq!(format_number(2.0), "2");
        assert_eq!(format_number(0.5), "0.5");
    }
}
