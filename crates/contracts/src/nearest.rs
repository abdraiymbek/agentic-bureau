//! Did-you-mean matching for operation names, object keys and enum values.
//! A suggestion is only ever reported; nothing here rewrites a caller's value.

/// Lowercase alphanumerics, so `cad.write_source`, `cad_write_source` and
/// `CadWriteSource` compare equal.
fn fold(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The form in which `revisionID`, `revision_id` and `revisionId` are one key.
pub(crate) fn fold_key(key: &str) -> String {
    key.chars()
        .filter(|character| *character != '_')
        .flat_map(char::to_lowercase)
        .collect()
}

/// The candidate closest to `input`, or `None` when nothing is close enough to
/// be worth suggesting. Ties go to the earlier candidate.
pub fn nearest_match<'a>(
    input: &str,
    candidates: impl IntoIterator<Item = &'a str>,
) -> Option<&'a str> {
    let wanted = fold(input);
    if wanted.is_empty() {
        return None;
    }
    let mut best: Option<((u8, usize), &str)> = None;
    for candidate in candidates {
        let Some(rank) = closeness(&wanted, &fold(candidate)) else {
            continue;
        };
        if best.is_none_or(|(current, _)| rank < current) {
            best = Some((rank, candidate));
        }
    }
    best.map(|(_, candidate)| candidate)
}

/// Rank of a folded candidate: identical, then within a third of its length in
/// edits, then one name containing the other (`up` for `upstream`, `tolerance`
/// for `tol`).
fn closeness(wanted: &str, candidate: &str) -> Option<(u8, usize)> {
    if wanted == candidate {
        return Some((0, 0));
    }
    let wanted_len = wanted.chars().count();
    let candidate_len = candidate.chars().count();
    let (shorter, longer) = if wanted_len <= candidate_len {
        (wanted, candidate)
    } else {
        (candidate, wanted)
    };
    let (shorter_len, longer_len) = (wanted_len.min(candidate_len), wanted_len.max(candidate_len));
    let distance = edit_distance(wanted, candidate);
    if distance <= longer_len / 3 {
        return Some((1, distance));
    }
    let contained = (shorter_len >= 2 && longer.starts_with(shorter))
        || (shorter_len >= 3 && longer.contains(shorter));
    contained.then_some((2, longer_len - shorter_len))
}

/// Levenshtein distance over characters.
fn edit_distance(left: &str, right: &str) -> usize {
    let right: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0; right.len() + 1];
    for (row, left_char) in left.chars().enumerate() {
        current[0] = row + 1;
        for (column, right_char) in right.iter().enumerate() {
            let substitution = previous[column] + usize::from(left_char != *right_char);
            current[column + 1] = substitution
                .min(previous[column + 1] + 1)
                .min(current[column] + 1);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_distance_counts_single_character_edits() {
        assert_eq!(edit_distance("", "abc"), 3);
        assert_eq!(edit_distance("cadchek", "cadcheck"), 1);
        assert_eq!(edit_distance("kitten", "sitting"), 3);
        assert_eq!(edit_distance("same", "same"), 0);
    }

    #[test]
    fn nearest_match_suggests_only_close_candidates() {
        let axes = ["x", "y", "z"];
        assert_eq!(nearest_match("Z", axes), Some("z"));
        assert_eq!(nearest_match("w", axes), None);

        let directions = ["upstream", "downstream", "both"];
        assert_eq!(nearest_match("up", directions), Some("upstream"));
        assert_eq!(nearest_match("donwstream", directions), Some("downstream"));
        assert_eq!(nearest_match("sideways", directions), None);

        let kinds = ["baseline_update", "new_artifact", "file_add"];
        assert_eq!(nearest_match("update", kinds), Some("baseline_update"));
        assert_eq!(
            nearest_match("tolerance", ["min", "max", "tol"]),
            Some("tol")
        );

        // A four-letter word three edits away is not a suggestion.
        assert_eq!(nearest_match("part", ["note", "test", "source"]), None);
        assert_eq!(nearest_match("+", ["+", "-"]), None);
    }

    #[test]
    fn nearest_match_prefers_the_closest_then_the_first() {
        assert_eq!(
            nearest_match("artifact_ids", ["revisionId", "artifactId"]),
            Some("artifactId")
        );
        assert_eq!(nearest_match("cat", ["cab", "car"]), Some("cab"));
        // An edit-distance match outranks a containment match.
        assert_eq!(
            nearest_match("limits", ["limitsPerPage", "limit"]),
            Some("limit")
        );
    }

    #[test]
    fn key_folding_ignores_case_and_underscores_only() {
        assert_eq!(fold_key("revision_ID"), "revisionid");
        assert_eq!(fold_key("revisionId"), "revisionid");
        assert_ne!(fold_key("revision-id"), fold_key("revisionId"));
    }
}
