use crate::error::ContractError;
use crate::nearest::nearest_match;
use crate::schema::Compiled;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractRegistry {
    pub protocol_version: u64,
    pub schema_version: u64,
    pub project_file: String,
    pub max_frame_bytes: usize,
    pub env_keys: HashMap<String, String>,
    pub error_codes: Vec<String>,
    pub event_types: Vec<String>,
    pub artifact_payload_schemas: HashMap<String, Value>,
    pub operations: Vec<Operation>,
    #[serde(skip)]
    by_name: HashMap<String, usize>,
    /// Dotted names and tool names in the form `resolve` compares.
    #[serde(skip)]
    by_alias: HashMap<String, usize>,
    #[serde(skip)]
    payloads: HashMap<String, OnceLock<Result<Compiled, String>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub name: String,
    pub tool_name: String,
    pub description: String,
    pub capability: String,
    pub mutating: bool,
    pub agent_visible: bool,
    pub agent_allowed: bool,
    pub agent_tool: bool,
    /// Smallest profile whose tool list shows the operation.
    #[serde(default, deserialize_with = "null_as_default")]
    pub tier: Tier,
    #[serde(default, deserialize_with = "null_as_default")]
    pub pack: String,
    /// One imperative line for catalogues; tools are named by underscore name.
    #[serde(default, deserialize_with = "null_as_default")]
    pub summary: String,
    /// A minimal valid input.
    #[serde(default)]
    pub example: Option<Value>,
    /// Smaller schema shown in the compact tool list. Presentation only:
    /// input is always validated against `input_schema`.
    #[serde(default)]
    pub compact_schema: Option<Value>,
    pub input_schema: Value,
    #[serde(skip)]
    compiled: OnceLock<Result<Compiled, String>>,
}

fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Core,
    Standard,
    /// Also what an operation without a tier gets: listed only when
    /// everything is.
    #[default]
    Full,
}

/// The capability profile a session is launched with. It shapes what an agent
/// is shown; it never changes what is validated or allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Compact,
    #[default]
    Standard,
    Full,
}

impl Profile {
    pub const ALL: [Profile; 3] = [Profile::Compact, Profile::Standard, Profile::Full];

    pub fn as_str(self) -> &'static str {
        match self {
            Profile::Compact => "compact",
            Profile::Standard => "standard",
            Profile::Full => "full",
        }
    }

    /// Whether the profile's tool list shows `op`: `compact` shows the core
    /// tier, `standard` adds the standard tier, `full` shows every agent tool.
    /// An agent-allowed operation that is not listed stays callable through
    /// `tool_call`.
    pub fn lists(self, op: &Operation) -> bool {
        let widest = match self {
            Profile::Compact => Tier::Core,
            Profile::Standard => Tier::Standard,
            Profile::Full => Tier::Full,
        };
        op.agent_tool && op.tier <= widest
    }
}

impl fmt::Display for Profile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Profile {
    type Err = ContractError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let wanted = text.trim();
        Profile::ALL
            .into_iter()
            .find(|profile| profile.as_str().eq_ignore_ascii_case(wanted))
            .ok_or_else(|| {
                ContractError::validation(format!("Unknown profile: {text}"))
                    .with_repair("Use compact, standard, or full.")
            })
    }
}

static REGISTRY: OnceLock<ContractRegistry> = OnceLock::new();

pub fn registry() -> &'static ContractRegistry {
    REGISTRY.get_or_init(|| {
        ContractRegistry::from_json(include_str!("../registry.json")).expect("valid registry.json")
    })
}

impl ContractRegistry {
    /// Build a registry from the JSON `scripts/export-rust-contracts.ts`
    /// writes. Tests use this with an inline fixture.
    pub fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        let mut registry: ContractRegistry = serde_json::from_str(text)?;
        for (index, op) in registry.operations.iter().enumerate() {
            let duplicate = |name: &str| {
                <serde_json::Error as serde::de::Error>::custom(format!(
                    "operation {name} is declared twice"
                ))
            };
            if registry.by_name.insert(op.name.clone(), index).is_some() {
                return Err(duplicate(&op.name));
            }
            for name in [&op.name, &op.tool_name] {
                let taken = registry.by_alias.insert(alias(name), index);
                if taken.is_some_and(|other| other != index) {
                    return Err(duplicate(name));
                }
            }
        }
        registry.payloads = registry
            .artifact_payload_schemas
            .keys()
            .map(|kind| (kind.clone(), OnceLock::new()))
            .collect();
        Ok(registry)
    }

    /// Exact lookup by dotted operation name.
    pub fn operation(&self, name: &str) -> Option<&Operation> {
        self.by_name.get(name).map(|index| &self.operations[*index])
    }

    /// Lookup by the name an agent or person is likely to type: dotted
    /// (`cad.write_source`), tool (`cad_write_source`), any letter case, or a
    /// client-prefixed tool name (`mcp__omenflow__cad_write_source`).
    pub fn resolve(&self, name: &str) -> Option<&Operation> {
        self.by_alias
            .get(&alias(name))
            .map(|index| &self.operations[*index])
    }

    /// The operation whose name is closest to a name `resolve` rejected.
    pub fn nearest(&self, name: &str) -> Option<&Operation> {
        self.nearest_among(name, |_| true)
    }

    /// `nearest`, restricted to operations an agent may call.
    pub fn nearest_agent(&self, name: &str) -> Option<&Operation> {
        self.nearest_among(name, |op| op.agent_allowed)
    }

    fn nearest_among(&self, name: &str, admit: impl Fn(&Operation) -> bool) -> Option<&Operation> {
        let candidates = self
            .operations
            .iter()
            .filter(|op| admit(op))
            .map(|op| op.tool_name.as_str());
        nearest_match(&alias(name), candidates).and_then(|tool| self.resolve(tool))
    }

    /// `NOT_FOUND` for a name `resolve` rejected, suggesting the closest
    /// agent-callable tool and pointing at the catalogue.
    pub fn unknown_operation(&self, name: &str) -> ContractError {
        let nearest = self.nearest_agent(name).map(|op| op.tool_name.as_str());
        let suggestion = nearest.map_or_else(String::new, |tool| format!("Did you mean {tool}? "));
        ContractError::new("NOT_FOUND", format!("Unknown operation: {name}"))
            .with_repair(format!(
                "{suggestion}Call tool_describe with no arguments to list every tool."
            ))
            .with_details(serde_json::json!({
                "name": name,
                "nearest": nearest,
                "listingTool": "tool_describe",
            }))
    }

    pub fn agent_operations(&self) -> impl Iterator<Item = &Operation> {
        self.operations.iter().filter(|op| op.agent_allowed)
    }

    pub fn agent_tools(&self) -> impl Iterator<Item = &Operation> {
        self.operations.iter().filter(|op| op.agent_tool)
    }

    /// The tools a profile lists, in registry order so the list is stable
    /// across sessions.
    pub fn tools_for(&self, profile: Profile) -> impl Iterator<Item = &Operation> {
        self.operations.iter().filter(move |op| profile.lists(op))
    }

    /// An artifact payload schema and its validators.
    pub(crate) fn payload(&self, kind: &str) -> Result<(&Value, &Compiled), ContractError> {
        let known = self
            .artifact_payload_schemas
            .get(kind)
            .zip(self.payloads.get(kind));
        let (schema, compiled) = known
            .ok_or_else(|| ContractError::validation(format!("Unknown artifact type: {kind}")))?;
        Ok((schema, compiled_or_internal(compiled, schema, kind)?))
    }
}

impl Operation {
    /// The schema to show in a profile's tool list.
    pub fn schema_for(&self, profile: Profile) -> &Value {
        match (&self.compact_schema, profile) {
            (Some(compact), Profile::Compact) => compact,
            _ => &self.input_schema,
        }
    }

    pub(crate) fn compiled(&self) -> Result<&Compiled, ContractError> {
        compiled_or_internal(&self.compiled, &self.input_schema, &self.name)
    }
}

/// Compile on first use; every later call reuses the validators.
fn compiled_or_internal<'a>(
    cell: &'a OnceLock<Result<Compiled, String>>,
    schema: &Value,
    owner: &str,
) -> Result<&'a Compiled, ContractError> {
    cell.get_or_init(|| Compiled::new(schema))
        .as_ref()
        .map_err(|error| {
            ContractError::new(
                "INTERNAL",
                format!("Schema for {owner} does not compile: {error}"),
            )
        })
}

/// Tool-name form of whatever the caller typed: the part after a client's
/// `server__` prefix, lowercase, dots as underscores.
fn alias(name: &str) -> String {
    let name = name.trim();
    let name = name.rsplit_once("__").map_or(name, |(_, tool)| tool);
    name.to_lowercase().replace('.', "_")
}
