//! Compiled schemas and the schema-directed pass that turns what a caller
//! sent into the canonical value a handler sees.

use crate::issue::{self, brief, push_index, push_key, Located, ValidationIssue};
use crate::nearest::fold_key;
use jsonschema::Validator;
use serde_json::{Map, Number, Value};
use std::collections::HashMap;
use std::fmt::Write;

/// A schema's validators, built once. Union branches are compiled on their own
/// and keyed by schema pointer (`/properties/price/anyOf/0`) because choosing a
/// branch means validating the value against that branch alone.
pub(crate) struct Compiled {
    validator: Validator,
    branches: HashMap<String, Validator>,
}

impl std::fmt::Debug for Compiled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Compiled")
            .field("branches", &self.branches.len())
            .finish_non_exhaustive()
    }
}

impl Compiled {
    pub(crate) fn new(schema: &Value) -> Result<Self, String> {
        let mut branches = HashMap::new();
        compile_branches(schema, &mut String::new(), &mut branches)?;
        Ok(Self {
            validator: compile(schema)?,
            branches,
        })
    }

    pub(crate) fn issues(&self, schema: &Value, instance: &Value) -> Vec<Located> {
        issue::collect(&self.validator, schema, instance)
    }
}

fn compile(schema: &Value) -> Result<Validator, String> {
    // Draft 7 has no `uuid` format, and an unknown format is ignored.
    jsonschema::draft7::options()
        .with_format("uuid", is_uuid)
        .build(schema)
        .map_err(|error| error.to_string())
}

/// The shape Zod's `.uuid()` accepts: 8-4-4-4-12 hexadecimal digits.
fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn compile_branches(
    schema: &Value,
    pointer: &mut String,
    branches: &mut HashMap<String, Validator>,
) -> Result<(), String> {
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        for (key, property) in properties {
            within(pointer, &["properties", key], |pointer| {
                compile_branches(property, pointer, branches)
            })?;
        }
    }
    if let Some(values) = schema
        .get("additionalProperties")
        .filter(|values| values.is_object())
    {
        within(pointer, &["additionalProperties"], |pointer| {
            compile_branches(values, pointer, branches)
        })?;
    }
    match schema.get("items") {
        Some(Value::Array(tuple)) => {
            for (index, item) in tuple.iter().enumerate() {
                within(pointer, &["items", &index.to_string()], |pointer| {
                    compile_branches(item, pointer, branches)
                })?;
            }
        }
        Some(items) => within(pointer, &["items"], |pointer| {
            compile_branches(items, pointer, branches)
        })?,
        None => {}
    }
    for keyword in ["anyOf", "oneOf"] {
        let options = schema.get(keyword).and_then(Value::as_array);
        for (index, option) in options.into_iter().flatten().enumerate() {
            within(pointer, &[keyword, &index.to_string()], |pointer| {
                branches.insert(pointer.clone(), compile(option)?);
                compile_branches(option, pointer, branches)
            })?;
        }
    }
    Ok(())
}

/// Run `visit` with `segments` appended to a schema pointer.
fn within<R>(pointer: &mut String, segments: &[&str], visit: impl FnOnce(&mut String) -> R) -> R {
    let length = pointer.len();
    push_pointer(pointer, segments);
    let result = visit(pointer);
    pointer.truncate(length);
    result
}

fn push_pointer(pointer: &mut String, segments: &[&str]) {
    for segment in segments {
        pointer.push('/');
        pointer.push_str(&segment.replace('~', "~0").replace('/', "~1"));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// Zod object parsing: unknown keys are discarded, defaults applied.
    Ui,
    /// The same, plus lossless repairs that are each reported in a note, and
    /// unknown keys reported as issues instead of vanishing.
    Agent,
}

/// One walk of a value against its schema. The value is rewritten in place;
/// `notes` and `issues` are only ever filled in agent mode.
pub(crate) struct Pass<'a> {
    compiled: &'a Compiled,
    mode: Mode,
    /// Schema pointer of the node being visited.
    pointer: String,
    /// The value being visited: dotted for people, JSON pointer for ordering.
    path: String,
    location: String,
    pub(crate) notes: Vec<String>,
    pub(crate) issues: Vec<Located>,
}

/// A union branch tried against a copy of the value.
struct Attempt<'a> {
    validator: Option<&'a Validator>,
    value: Value,
    notes: Vec<String>,
    issues: Vec<Located>,
    valid: bool,
    /// The value is not even of a JSON type the branch admits.
    wrong_type: bool,
}

impl Attempt<'_> {
    /// How far the value is from the branch: the wrong type altogether, then
    /// the number of problems left.
    fn distance(&self) -> (bool, usize) {
        let remaining = match self.validator {
            Some(validator) if !self.valid => validator.iter_errors(&self.value).count(),
            _ => 0,
        };
        (self.wrong_type, self.issues.len() + remaining)
    }
}

impl<'a> Pass<'a> {
    pub(crate) fn new(compiled: &'a Compiled, mode: Mode) -> Self {
        Self {
            compiled,
            mode,
            pointer: String::new(),
            path: String::new(),
            location: String::new(),
            notes: Vec::new(),
            issues: Vec::new(),
        }
    }

    pub(crate) fn run(&mut self, schema: &Value, value: &mut Value) {
        self.scalar(schema, value);
        if let Value::Object(object) = value {
            self.object(schema, object);
        }
        if let (Some(items), Value::Array(array)) = (schema.get("items"), &mut *value) {
            self.array(items, array);
        }
        for keyword in ["anyOf", "oneOf"] {
            if let Some(branches) = schema.get(keyword).and_then(Value::as_array) {
                self.union(keyword, branches, value);
            }
        }
    }

    /// Visit a child schema with the schema pointer extended.
    fn descend(&mut self, segments: &[&str], schema: &Value, value: &mut Value) {
        let length = self.pointer.len();
        push_pointer(&mut self.pointer, segments);
        self.run(schema, value);
        self.pointer.truncate(length);
    }

    fn at_key(&mut self, key: &str, visit: impl FnOnce(&mut Self)) {
        let lengths = (self.path.len(), self.location.len());
        push_key(&mut self.path, key);
        push_pointer(&mut self.location, &[key]);
        visit(self);
        self.path.truncate(lengths.0);
        self.location.truncate(lengths.1);
    }

    fn at_index(&mut self, index: usize, visit: impl FnOnce(&mut Self)) {
        let lengths = (self.path.len(), self.location.len());
        push_index(&mut self.path, index);
        push_pointer(&mut self.location, &[&index.to_string()]);
        visit(self);
        self.path.truncate(lengths.0);
        self.location.truncate(lengths.1);
    }

    fn scalar(&mut self, schema: &Value, value: &mut Value) {
        let types = Types::of(schema);
        match value {
            // JSON does not tell 12.0 from 12; handlers reading an integer do.
            Value::Number(number) if types.integer && !types.number => {
                if let Some(integer) = whole(number) {
                    *value = integer.into();
                }
            }
            Value::String(text) if self.mode == Mode::Agent && types.declared && !types.string => {
                let repaired = numeric(text, types)
                    .or_else(|| boolean(text, types))
                    .or_else(|| quantity(text, schema, types));
                if let Some((kind, repaired)) = repaired {
                    let subject = if self.path.is_empty() {
                        "input"
                    } else {
                        self.path.as_str()
                    };
                    self.notes.push(format!(
                        "read {subject} {} as {kind} {repaired}",
                        brief(value)
                    ));
                    *value = repaired;
                }
            }
            _ => {}
        }
    }

    fn object(&mut self, schema: &Value, object: &mut Map<String, Value>) {
        let declared = schema.get("properties").and_then(Value::as_object);
        let additional = schema.get("additionalProperties");
        if declared.is_none() && additional.is_none() {
            return;
        }
        let empty = Map::new();
        let properties = declared.unwrap_or(&empty);
        if additional == Some(&Value::Bool(false)) {
            if self.mode == Mode::Agent {
                self.unknown_keys(properties, object);
            }
            object.retain(|key, _| properties.contains_key(key));
        }
        for (key, property) in properties {
            if !object.contains_key(key) {
                if let Some(default) = property.get("default") {
                    object.insert(key.clone(), default.clone());
                }
            }
            if let Some(member) = object.get_mut(key) {
                self.at_key(key, |pass| {
                    pass.descend(&["properties", key], property, member);
                });
            }
        }
        // Zod's object parser emits declared fields in schema order, then the
        // rest as given. Keep that order for JSON.stringify request hashes
        // shared with the existing TypeScript idempotency store.
        let mut given = Map::new();
        let mut rest = Vec::new();
        for (key, member) in std::mem::take(object) {
            if properties.contains_key(&key) {
                given.insert(key, member);
            } else {
                rest.push((key, member));
            }
        }
        for key in properties.keys() {
            if let Some(member) = given.remove(key) {
                object.insert(key.clone(), member);
            }
        }
        // Record values (`z.record`) are normalised like any other member.
        let values = additional.filter(|schema| schema.is_object());
        for (key, mut member) in rest {
            if let Some(values) = values {
                self.at_key(&key, |pass| {
                    pass.descend(&["additionalProperties"], values, &mut member);
                });
            }
            object.insert(key, member);
        }
    }

    /// Agent mode, closed objects: a key that differs from exactly one unset
    /// declared key only by case or snake/camel form is renamed with a note;
    /// every other undeclared key becomes an issue.
    fn unknown_keys(&mut self, properties: &Map<String, Value>, object: &mut Map<String, Value>) {
        let unknown = object
            .keys()
            .filter(|key| !properties.contains_key(*key))
            .cloned()
            .collect::<Vec<_>>();
        for key in unknown {
            let folded = fold_key(&key);
            let mut twins = properties
                .keys()
                .filter(|declared| fold_key(declared) == folded);
            let twin = twins.next().filter(|_| twins.next().is_none());
            let from = issue::joined(&self.path, &key);
            match twin {
                Some(declared) if !object.contains_key(declared) => {
                    if let Some(member) = object.remove(&key) {
                        object.insert(declared.clone(), member);
                    }
                    self.notes.push(format!(
                        "renamed {from} → {}",
                        issue::joined(&self.path, declared)
                    ));
                }
                _ => self.issues.push(Located {
                    pointer: issue::member(&self.location, &key),
                    issue: ValidationIssue::unknown_key(
                        from,
                        &key,
                        properties,
                        twin.map(String::as_str),
                    ),
                }),
            }
        }
    }

    fn array(&mut self, items: &Value, array: &mut [Value]) {
        match items {
            Value::Array(tuple) => {
                for (index, (schema, item)) in tuple.iter().zip(array).enumerate() {
                    self.at_index(index, |pass| {
                        pass.descend(&["items", &index.to_string()], schema, item);
                    });
                }
            }
            schema => {
                for (index, item) in array.iter_mut().enumerate() {
                    self.at_index(index, |pass| pass.descend(&["items"], schema, item));
                }
            }
        }
    }

    /// Keep the first branch the value satisfies as sent; failing that, the
    /// first it satisfies once repaired. When none fits, continue with the
    /// closest branch so the errors that follow are about that shape.
    fn union(&mut self, keyword: &str, branches: &[Value], value: &mut Value) {
        let compiled = self.compiled;
        let (noted, raised) = (self.notes.len(), self.issues.len());
        let mut attempts = Vec::with_capacity(branches.len());
        for (index, branch) in branches.iter().enumerate() {
            let mut candidate = value.clone();
            let length = self.pointer.len();
            let _ = write!(self.pointer, "/{keyword}/{index}");
            self.run(branch, &mut candidate);
            let validator = compiled.branches.get(&self.pointer);
            self.pointer.truncate(length);
            let notes = self.notes.split_off(noted);
            let issues = self.issues.split_off(raised);
            let valid = validator.is_some_and(|validator| validator.is_valid(&candidate));
            if valid && notes.is_empty() && issues.is_empty() {
                *value = candidate;
                return;
            }
            attempts.push(Attempt {
                wrong_type: !Types::of(branch).allows(&candidate),
                validator,
                value: candidate,
                notes,
                issues,
                valid,
            });
        }
        let chosen = attempts
            .iter()
            .position(|attempt| attempt.valid && attempt.issues.is_empty())
            .or_else(|| {
                let distances = attempts.iter().map(Attempt::distance);
                let (index, distance) = distances
                    .enumerate()
                    .min_by_key(|(_, distance)| *distance)?;
                (!distance.0).then_some(index)
            });
        if let Some(chosen) = chosen {
            let attempt = attempts.swap_remove(chosen);
            *value = attempt.value;
            self.notes.extend(attempt.notes);
            self.issues.extend(attempt.issues);
        }
    }
}

/// The JSON types a schema's `type` keyword admits.
#[derive(Debug, Clone, Copy, Default)]
struct Types {
    declared: bool,
    null: bool,
    boolean: bool,
    integer: bool,
    number: bool,
    string: bool,
    array: bool,
    object: bool,
}

impl Types {
    fn of(schema: &Value) -> Self {
        let mut types = Self::default();
        let mut admit = |name: &str| {
            types.declared = true;
            match name {
                "null" => types.null = true,
                "boolean" => types.boolean = true,
                "integer" => types.integer = true,
                "number" => types.number = true,
                "string" => types.string = true,
                "array" => types.array = true,
                "object" => types.object = true,
                _ => {}
            }
        };
        match schema.get("type") {
            Some(Value::String(name)) => admit(name),
            Some(Value::Array(names)) => names.iter().filter_map(Value::as_str).for_each(admit),
            _ => {}
        }
        types
    }

    fn allows(self, value: &Value) -> bool {
        !self.declared
            || match value {
                Value::Null => self.null,
                Value::Bool(_) => self.boolean,
                Value::Number(number) => {
                    self.number || (self.integer && (!number.is_f64() || whole(number).is_some()))
                }
                Value::String(_) => self.string,
                Value::Array(_) => self.array,
                Value::Object(_) => self.object,
            }
    }
}

/// The integer a float-encoded number stands for, when it stands for one that
/// every JSON implementation represents exactly.
fn whole(number: &Number) -> Option<i64> {
    const EXACT: f64 = 9_007_199_254_740_992.0;
    let float = number.as_f64().filter(|_| number.is_f64())?;
    (float.fract() == 0.0 && float.abs() <= EXACT).then_some(float as i64)
}

fn numeric(text: &str, types: Types) -> Option<(&'static str, Value)> {
    if !types.number && !types.integer {
        return None;
    }
    let number = serde_json::from_str::<Number>(text).ok()?;
    if types.number {
        return Some(("number", Value::Number(number)));
    }
    let integer = if number.is_f64() {
        whole(&number)?.into()
    } else {
        number
    };
    Some(("integer", Value::Number(integer)))
}

fn boolean(text: &str, types: Types) -> Option<(&'static str, Value)> {
    let flag = match text {
        "true" => true,
        "false" => false,
        _ => return None,
    };
    types.boolean.then_some(("boolean", Value::Bool(flag)))
}

/// `"300 g"` or `"0.5kg"` where the schema is the quantity object: a required
/// numeric `value` and a required string `unit`. The unit is kept exactly as
/// written; anything looser than number-then-unit is left for the caller.
fn quantity(text: &str, schema: &Value, types: Types) -> Option<(&'static str, Value)> {
    let properties = schema.get("properties")?;
    let required = schema.get("required")?.as_array()?;
    let requires = |key: &str| required.iter().any(|name| name == key);
    let value_type = &properties["value"]["type"];
    let shaped = types.object
        && (value_type == "number" || value_type == "integer")
        && properties["unit"]["type"] == "string"
        && requires("value")
        && requires("unit");
    if !shaped {
        return None;
    }
    let text = text.trim();
    let (number, unit) = text.split_at(number_prefix(text));
    let unit = unit.trim_start();
    let starts_like_a_unit = unit
        .chars()
        .next()
        .is_some_and(|first| first.is_alphabetic() || first == '°' || first == '%');
    if !starts_like_a_unit || unit.contains(char::is_whitespace) {
        return None;
    }
    let value = serde_json::from_str::<Number>(number).ok()?;
    let mut parsed = Map::new();
    parsed.insert("value".to_owned(), Value::Number(value));
    parsed.insert("unit".to_owned(), Value::String(unit.to_owned()));
    Some(("quantity", Value::Object(parsed)))
}

/// Byte length of the longest JSON-number-shaped prefix. An `e` only belongs
/// to the number when digits follow it, so `5eV` is 5 with unit `eV`.
fn number_prefix(text: &str) -> usize {
    let bytes = text.as_bytes();
    let digits = |mut at: usize| {
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        at
    };
    let mut end = digits(usize::from(bytes.first() == Some(&b'-')));
    if bytes.get(end) == Some(&b'.') && digits(end + 1) > end + 1 {
        end = digits(end + 1);
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        if digits(end + 1 + sign) > end + 1 + sign {
            end = digits(end + 1 + sign);
        }
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn quantity_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "value": { "type": "number" },
                "unit": { "type": "string", "minLength": 1 }
            },
            "required": ["value", "unit"],
            "additionalProperties": false
        })
    }

    fn read_quantity(text: &str) -> Option<Value> {
        let schema = quantity_schema();
        quantity(text, &schema, Types::of(&schema)).map(|(_, value)| value)
    }

    #[test]
    fn uuid_format_matches_zod() {
        assert!(is_uuid("11111111-1111-4111-8111-111111111111"));
        assert!(is_uuid("00000000-0000-0000-0000-00000000000A"));
        assert!(!is_uuid("motor-mount"));
        assert!(!is_uuid("11111111-1111-4111-8111-11111111111"));
        assert!(!is_uuid("11111111x1111-4111-8111-111111111111"));
        assert!(!is_uuid("{11111111-1111-4111-8111-111111111111}"));
    }

    #[test]
    fn quantity_strings_keep_the_unit_as_written() {
        assert_eq!(
            read_quantity("300 g"),
            Some(json!({ "value": 300, "unit": "g" }))
        );
        assert_eq!(
            read_quantity("0.5kg"),
            Some(json!({ "value": 0.5, "unit": "kg" }))
        );
        assert_eq!(
            read_quantity("-40 °C"),
            Some(json!({ "value": -40, "unit": "°C" }))
        );
        assert_eq!(
            read_quantity("5eV"),
            Some(json!({ "value": 5, "unit": "eV" }))
        );
        assert_eq!(
            read_quantity("1e3 N*m"),
            Some(json!({ "value": 1000.0, "unit": "N*m" }))
        );
        assert_eq!(
            read_quantity("12 %"),
            Some(json!({ "value": 12, "unit": "%" }))
        );
    }

    #[test]
    fn loose_quantity_strings_are_not_guessed() {
        for text in [
            "300",
            "g",
            "about 300 g",
            "300 g approx",
            "300-400 g",
            "1,000 g",
            "12 V DC",
            "$12",
            "007 g",
            ".5 kg",
            "",
        ] {
            assert_eq!(read_quantity(text), None, "{text:?}");
        }
        // A money object is not a quantity.
        let money = json!({
            "type": "object",
            "properties": { "amount": { "type": "string" }, "currency": { "type": "string" } },
            "required": ["amount", "currency"]
        });
        assert!(quantity("12.50 USD", &money, Types::of(&money)).is_none());
    }

    #[test]
    fn numeric_strings_are_read_only_when_the_whole_string_is_a_number() {
        let integer = Types::of(&json!({ "type": "integer" }));
        let number = Types::of(&json!({ "type": "number" }));
        assert_eq!(numeric("12", integer), Some(("integer", json!(12))));
        assert_eq!(numeric("12.0", integer), Some(("integer", json!(12))));
        assert_eq!(numeric("12.5", integer), None);
        assert_eq!(numeric("12.5", number), Some(("number", json!(12.5))));
        assert_eq!(numeric("-3", number), Some(("number", json!(-3))));
        for text in ["", "12px", "1,000", "0x10", "NaN", "+5", "1e999", "twelve"] {
            assert_eq!(numeric(text, number), None, "{text:?}");
        }
        assert_eq!(
            numeric("12", Types::of(&json!({ "type": "boolean" }))),
            None
        );
    }
}
