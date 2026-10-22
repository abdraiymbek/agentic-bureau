# Requirements and assumptions

1. Call artifact_list with type "requirement", then with type "assumption", so you extend what exists instead of duplicating it.
2. Call tool_describe {"tool": "artifact_create_draft", "artifactType": "requirement"} once to see the payload fields.
3. Create each requirement with artifact_create_draft, type "requirement": one testable statement per artifact. Fields: statement, target (a quantity with a unit symbol, such as {"value": 2.5, "unit": "h"}, plus min or max for "at least" or "at most", or unknown with a reason), acceptanceCriterion (how it will be judged), priority (must, should or could), verification, and sourceId when it comes from a captured source. A unit written as a word ("hours", "grams") cannot be converted.
4. Record what the design takes for granted as type "assumption": statement, value, reason, uncertainty, owner, needsValidation. An assumption is not a requirement and it is not evidence.
5. A requirement on a part's shape or size lists features, one per dimension or feature: label in its words, quantity with its unit and, when the part's frame is known, expect with the cad_check assertions that show it. A part checked against it must assert each.
6. To change one, call artifact_read, then artifact_update_draft on the same artifactId with the complete payload. The payload you send replaces the previous one; nothing is merged.
7. Read the saved revision back with artifact_read and check that the statement, the target and its unit were kept as you intended.
8. Link evidence when it exists with graph_propose_edges: the requirement is the upstream artifact, the test or calculation is the downstream one, relationship "validates" (a part checked against a requirement too, or give cad_check its requirementIds). project_coverage lists the requirements that still have no current evidence.
9. Never state that a requirement is met. A pass or fail verdict exists only where a recorded test result says so; a number that looks close enough is not a verdict.
10. Record other content the same way: architecture and note carry markdown; concept carries description, systems, approxDimensions, alternatives, uncertainties; software carries files, language, entryPoint, notes; assembly carries ordered steps. Ask tool_describe for the fields of each type.
11. When the drafts are saved and read back, then call work_status.
