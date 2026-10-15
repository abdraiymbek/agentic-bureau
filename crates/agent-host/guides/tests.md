# Tests and results

A test plan and a test result are different records. A plan says what will be done; a result says what was observed.

1. Find the requirement the test speaks to with artifact_list (type "requirement") and note its artifactId and revisionId.
2. Call test_create_draft with a title, procedure (steps numbered from 1, each {"step": 1, "instruction": "...", "expected": "..."}), conditions, and requirementRefs [{"artifactId": "...", "revisionId": "..."}]. This records the plan only.
3. Do not record a result for a test nobody ran. A plan with no run stays a plan, and its state is "not run".
4. When the person gives you an observation or a measurement file, call test_record_result with the artifactId, observation (what was seen, with values and units), result (passed, failed, inconclusive, not_run or planned), evidenceKind and requirementRef. On an approved test your result is saved as a draft: it counts once the human accepts it.
5. Choose evidenceKind truthfully: measured only for a real physical measurement; simulated, calculated, sourced or assumed for the rest. Put the instrument, file or person in measurementOrigin and attach logs or photos in attachments.
6. Record a failed or inconclusive result as it is. Do not soften it and do not replace it with a later pass: each result is a new revision and the history stays.
7. Never turn a calculation or a render into a test result. A check of geometry belongs to cad_check; a computed value belongs to calculation_run.
8. project_coverage shows each requirement with its evidence. A verdict appears there only from a recorded test result.
9. Read the test back with artifact_read and confirm the procedure and results were saved, then call work_status.
