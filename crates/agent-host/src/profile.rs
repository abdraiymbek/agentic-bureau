//! Capability profile resolution. A profile is chosen once, when a session
//! starts, and never changes while it runs: it shapes what the agent is shown
//! (tool list, schemas, guidance, result size), never what it may do or how
//! its work is verified.

use omenflow_contracts::{ContractError, Profile};
use std::str::FromStr;

/// What a person can set for an adapter: a fixed profile, or `auto` to derive
/// it from the launch model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProfileSetting {
    #[default]
    Auto,
    Fixed(Profile),
}

impl ProfileSetting {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Fixed(profile) => profile.as_str(),
        }
    }
}

impl FromStr for ProfileSetting {
    type Err = ContractError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if text.trim().eq_ignore_ascii_case("auto") {
            return Ok(Self::Auto);
        }
        text.parse::<Profile>().map(Self::Fixed).map_err(|_| {
            ContractError::validation(format!("Unknown profile: {text}"))
                .with_repair("Use auto, compact, standard, or full.")
        })
    }
}

/// Why a session has the profile it has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileSource {
    User,
    Model,
    AdapterDefault,
}

impl ProfileSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Model => "model",
            Self::AdapterDefault => "adapter-default",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedProfile {
    pub profile: Profile,
    pub source: ProfileSource,
}

/// Small-model markers: one hyphen/slash/dot separated word of the model id.
const SMALL_WORDS: [&str; 5] = ["haiku", "luna", "mini", "nano", "lite"];
/// Large-model markers, compared the same way.
const LARGE_WORDS: [&str; 6] = ["opus", "fable", "astra", "sol", "pro", "max"];
/// Model id prefixes that name a local provider.
const LOCAL_PREFIXES: [&str; 2] = ["ollama/", "lmstudio/"];
/// Launch arguments that select a local provider.
const LOCAL_FLAGS: [&str; 2] = ["--oss", "--local-provider"];

/// Resolve the profile for a session: an explicit setting wins; otherwise the
/// launch model decides; without a model the adapter's default applies.
/// `launch_args` are the extra arguments the person configured, which can
/// select a local provider (`--oss`) without naming it in the model id.
pub fn resolve_profile(
    setting: ProfileSetting,
    model: Option<&str>,
    launch_args: &[String],
    adapter_default: Profile,
) -> ResolvedProfile {
    if let ProfileSetting::Fixed(profile) = setting {
        return ResolvedProfile {
            profile,
            source: ProfileSource::User,
        };
    }
    let local_flag = launch_args
        .iter()
        .any(|arg| LOCAL_FLAGS.contains(&arg.as_str()));
    let model = model.map(str::trim).filter(|model| !model.is_empty());
    if local_flag {
        return ResolvedProfile {
            profile: Profile::Compact,
            source: ProfileSource::Model,
        };
    }
    match model {
        Some(model) => ResolvedProfile {
            profile: profile_for_model(model),
            source: ProfileSource::Model,
        },
        None => ResolvedProfile {
            profile: adapter_default,
            source: ProfileSource::AdapterDefault,
        },
    }
}

/// The profile `auto` gives a model id. Small markers are checked first, so
/// `flash-lite` is compact although `flash` alone is not; an id that carries
/// no marker is standard.
pub fn profile_for_model(model: &str) -> Profile {
    let id = model.trim().to_lowercase();
    if LOCAL_PREFIXES.iter().any(|prefix| id.starts_with(prefix)) || has_size_tag(&id) {
        return Profile::Compact;
    }
    let words = id
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    if words.iter().any(|word| SMALL_WORDS.contains(word)) {
        Profile::Compact
    } else if words.iter().any(|word| LARGE_WORDS.contains(word)) {
        Profile::Full
    } else {
        Profile::Standard
    }
}

/// A parameter-count tag as local runtimes write it: `qwen3:14b`,
/// `llama3.1:8b-instruct-q4`.
fn has_size_tag(id: &str) -> bool {
    id.split(':').skip(1).any(|tag| {
        let digits = tag
            .chars()
            .take_while(|character| character.is_ascii_digit() || *character == '.')
            .count();
        digits > 0 && tag[digits..].starts_with('b')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auto(model: Option<&str>, args: &[&str], default: Profile) -> ResolvedProfile {
        let args = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        resolve_profile(ProfileSetting::Auto, model, &args, default)
    }

    /// Identifiers the installed CLIs and their documentation use.
    #[test]
    fn model_identifiers_map_to_the_documented_tier() {
        let table: &[(&str, Profile)] = &[
            // Claude Code aliases and ids present in 2.1.287.
            ("haiku", Profile::Compact),
            ("claude-haiku-4-5", Profile::Compact),
            ("claude-haiku-4-5-20251001", Profile::Compact),
            // Passed by full id from 0.2.4; not in the 2.1.287 catalogue, but it runs.
            ("claude-haiku-5-5", Profile::Compact),
            ("sonnet", Profile::Standard),
            ("claude-sonnet-4-6", Profile::Standard),
            ("claude-sonnet-5", Profile::Standard),
            ("claude-sonnet-5-5", Profile::Standard),
            ("opus", Profile::Full),
            ("claude-opus-4-8", Profile::Full),
            ("claude-opus-5", Profile::Full),
            ("claude-opus-5-5", Profile::Full),
            ("fable", Profile::Full),
            ("claude-fable-5", Profile::Full),
            ("claude-fable-5-1", Profile::Full),
            ("best", Profile::Standard),
            ("opusplan", Profile::Standard),
            // Codex bundled catalogue, 0.156.1.
            ("gpt-6-luna", Profile::Compact),
            ("gpt-5.6-luna", Profile::Compact),
            ("gpt-5.6-terra", Profile::Standard),
            ("gpt-5.5", Profile::Standard),
            ("gpt-6-sol", Profile::Full),
            ("gpt-5.6-sol", Profile::Full),
            ("gpt-6-astra", Profile::Full),
            // Gemini CLI.
            ("flash-lite", Profile::Compact),
            ("gemini-2.5-flash-lite", Profile::Compact),
            ("flash", Profile::Standard),
            ("gemini-2.5-flash", Profile::Standard),
            ("gemini-3-flash-preview", Profile::Standard),
            ("auto", Profile::Standard),
            ("pro", Profile::Full),
            ("gemini-2.5-pro", Profile::Full),
            ("gemini-3-pro-preview", Profile::Full),
            // OpenCode provider/model ids and local runtimes.
            ("anthropic/claude-sonnet-4-5", Profile::Standard),
            ("anthropic/claude-opus-5", Profile::Full),
            ("ollama/qwen2.5-coder:14b", Profile::Compact),
            ("ollama/llama3.1", Profile::Compact),
            ("lmstudio/qwen3-coder", Profile::Compact),
            ("qwen3:8b", Profile::Compact),
            ("llama3.1:8b-instruct-q4_K_M", Profile::Compact),
            ("qwen2.5-coder", Profile::Standard),
            // Copilot CLI and other vendors' small tiers.
            ("gpt-5.4", Profile::Standard),
            ("claude-haiku-4.5", Profile::Compact),
            ("gpt-5-mini", Profile::Compact),
            ("gpt-5-nano", Profile::Compact),
            ("gpt-5.1-codex-max", Profile::Full),
        ];
        for (model, expected) in table {
            assert_eq!(profile_for_model(model), *expected, "{model}");
        }
    }

    #[test]
    fn markers_match_whole_words_only() {
        // "gemini" contains "mini", "solar" contains "sol", "provider" "pro".
        assert_eq!(profile_for_model("gemini-2.5-flash"), Profile::Standard);
        assert_eq!(profile_for_model("solar-10.7"), Profile::Standard);
        assert_eq!(profile_for_model("provider/model"), Profile::Standard);
        assert_eq!(profile_for_model("maximus"), Profile::Standard);
        // A version tag is not a size tag.
        assert_eq!(profile_for_model("model:latest"), Profile::Standard);
        assert_eq!(profile_for_model("model:beta"), Profile::Standard);
        assert_eq!(profile_for_model("  GPT-6-LUNA  "), Profile::Compact);
    }

    #[test]
    fn explicit_setting_wins_over_model_and_default() {
        let args = Vec::new();
        for profile in Profile::ALL {
            let resolved = resolve_profile(
                ProfileSetting::Fixed(profile),
                Some("haiku"),
                &args,
                Profile::Full,
            );
            assert_eq!(resolved.profile, profile);
            assert_eq!(resolved.source, ProfileSource::User);
        }
    }

    #[test]
    fn auto_uses_the_model_then_the_adapter_default() {
        let by_model = auto(Some("opus"), &[], Profile::Standard);
        assert_eq!(
            (by_model.profile, by_model.source),
            (Profile::Full, ProfileSource::Model)
        );
        let unknown_model = auto(Some("some-new-model"), &[], Profile::Compact);
        assert_eq!(
            (unknown_model.profile, unknown_model.source),
            (Profile::Standard, ProfileSource::Model)
        );
        for default in Profile::ALL {
            for model in [None, Some(""), Some("   ")] {
                let resolved = auto(model, &[], default);
                assert_eq!(resolved.profile, default);
                assert_eq!(resolved.source, ProfileSource::AdapterDefault);
            }
        }
    }

    #[test]
    fn a_local_provider_flag_selects_compact() {
        for args in [
            &["--oss"][..],
            &["--local-provider", "ollama"],
            &["-c", "x=1", "--oss"],
        ] {
            let resolved = auto(Some("gpt-6-sol"), args, Profile::Full);
            assert_eq!(resolved.profile, Profile::Compact);
            assert_eq!(resolved.source, ProfileSource::Model);
        }
        let without_model = auto(None, &["--oss"], Profile::Standard);
        assert_eq!(without_model.profile, Profile::Compact);
        // The flag never overrides a person's explicit choice.
        let args = vec!["--oss".to_owned()];
        let fixed = resolve_profile(
            ProfileSetting::Fixed(Profile::Full),
            None,
            &args,
            Profile::Standard,
        );
        assert_eq!(fixed.profile, Profile::Full);
    }

    #[test]
    fn settings_parse_and_print() {
        assert_eq!(
            "auto".parse::<ProfileSetting>().unwrap(),
            ProfileSetting::Auto
        );
        assert_eq!(
            " AUTO ".parse::<ProfileSetting>().unwrap(),
            ProfileSetting::Auto
        );
        assert_eq!(
            "compact".parse::<ProfileSetting>().unwrap(),
            ProfileSetting::Fixed(Profile::Compact)
        );
        let error = "tiny".parse::<ProfileSetting>().unwrap_err();
        assert_eq!(error.code, "VALIDATION");
        assert_eq!(
            error.repair.as_deref(),
            Some("Use auto, compact, standard, or full.")
        );
        assert_eq!(ProfileSetting::Fixed(Profile::Full).as_str(), "full");
        assert_eq!(ProfileSetting::Auto.as_str(), "auto");
        assert_eq!(ProfileSource::AdapterDefault.as_str(), "adapter-default");
    }
}
