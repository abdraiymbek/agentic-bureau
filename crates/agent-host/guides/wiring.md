# Wiring

Electrical work uses the artifact type "wiring" (not "electrical" or "electronics"). A diagram is not validation.

1. Record every connected part as a component first (guide_read topic components) and note each componentArtifactId: pins and connections refer to it.
2. Create the wiring artifact once: artifact_create_draft with type "wiring", a title and payload {"pins": [], "connections": []}. Keep its artifactId.
3. Call wiring_set_pins with every pin: componentArtifactId, pin (the label printed on the part or datasheet), type (power, ground, signal, data, mechanical or unknown) and voltageRange {"min": {"value": 4.5, "unit": "V"}, "max": {"value": 5.5, "unit": "V"}} where the datasheet gives one. The list replaces all earlier pins, so send them all. Type the power and ground pins, or the ground-return check cannot run.
4. Call wiring_set_connections with every connection: from and to ends {componentArtifactId, pin}, signalRole, and voltage as a quantity where known. Leave id and componentRevisionId out: Bureau assigns each connection an id and pins each end to the component's approved revision. The list replaces all earlier connections, so keep the ids of connections you send again. Call tool_describe {"tool": "wiring_set_connections"} for the exact fields.
5. Use only values you can source. Unknown voltage or current stays unknown with a reason; do not assume 5 V or 3.3 V.
6. Call wiring_validate on the artifact; it checks the newest draft. Read every finding and its severity (only errors are real problems), fix the pins or connections, and validate again until the findings that remain are ones you can explain.
7. Call wiring_render to review the connection table.
8. State the limits in your answer: the checks cover voltage ranges, ground return, pins used twice and unknown pins. They are not a full electrical rule check and do not prove safety. Put what is not covered in coverageNote.
9. When the wiring is validated and the remaining findings are named, then call work_status.
