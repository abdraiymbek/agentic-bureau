# Calculations

A calculation is evidence only when it was actually run and recorded with its inputs and units.

1. Call calculation_templates to see the templates: id, expression, the input names each needs and their units. Use a template only when you were given every input it needs; otherwise write the expression from the inputs you have.
2. Call calculation_run with a title, either templateId or expression, and inputs: each {"name": "mass", "quantity": {"value": 1.2, "unit": "kg"}, "literal": true}. The name is the variable used in the expression. The result unit follows from the expression; give outputUnit to report it in another unit, and always when the result could be an energy or a torque ("J" or "N*m").
3. Say where each input comes from. A value taken from an artifact gets sourceRef {"artifactId": "...", "revisionId": "..."}; a value you typed gets literal true. An input that is not known is {"unknown": true, "reason": "..."}: do not guess it to make the run complete. A typical or example value (a template's "e.g.") is a guess, not an input.
4. List the assumptions the result depends on in assumptions.
5. Pass submitForReview false unless the person asked for review; the default also submits a proposal.
6. Read the result with its unit and the limitations returned. Check the unit is the one you expected: a result in the wrong unit means an input unit or the expression is wrong. Never restate a result with a different unit.
7. To run it again with new inputs, call calculation_run with the same artifactId so the history stays on one artifact. calculation_explain_inputs shows where each input came from and whether its source has changed since.
8. Never write a result you did not run. When a calculation cannot be run with these tools, record the expression, inputs, assumptions and limitations as a draft and say it has no result.
9. A result is a calculated value, not a verdict. Do not state that a requirement passes because a number is close; link it with graph_propose_edges (relationship "validates") and leave the judgement to a recorded test or the human.
10. When the result and its limitations are recorded, then call work_status.
