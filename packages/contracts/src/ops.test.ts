import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { artifactPayloadSchemas } from './entities.js';
import {
  AGENT_OPS,
  AGENT_TOOL_OPS,
  OPS,
  OPS_BY_NAME,
  RUST_HOST_AGENT_OPS,
  RUST_HOST_OPS,
  describeOp,
  opPacks,
  resolveOp,
  type OpDef,
} from './ops.js';
import { buildRegistry, toolListing, type JsonSchema } from './registry.js';
import { adapterStatusSchema, sessionInfoSchema } from './session.js';

const agentTools = OPS.filter((op) => AGENT_TOOL_OPS.has(op.name));
const agentOps = OPS.filter((op) => AGENT_OPS.has(op.name));
const tools = (tier: OpDef['tier']) =>
  agentTools.filter((op) => op.tier === tier).map((op) => op.toolName);
const input = (op: OpDef) => zodToJsonSchema(op.input, { $refStrategy: 'none' }) as JsonSchema;
const op = (name: string) => OPS_BY_NAME.get(name)!;

/** Every `description` string inside a JSON schema. */
function descriptions(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((child) => descriptions(child, out));
  else if (node && typeof node === 'object')
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') out.push(value);
      else descriptions(value, out);
    }
  return out;
}

describe('operation tiers and packs', () => {
  it('lists exactly the fifteen core tools in the compact profile', () => {
    expect(tools('core').sort()).toEqual(
      [
        'project_summary',
        'artifact_list',
        'artifact_read',
        'artifact_create_draft',
        'artifact_update_draft',
        'cad_write_source',
        'cad_read_source',
        'cad_check',
        'cad_view',
        'image_view',
        'proposal_submit',
        'work_status',
        'guide_read',
        'tool_describe',
        'tool_call',
      ].sort(),
    );
  });

  it('adds the everyday engineering tools in the standard profile', () => {
    expect(tools('standard').sort()).toEqual(
      [
        'cad_inspect',
        'cad_patch_source',
        'cad_set_param',
        'cad_compose',
        'component_add_candidate',
        'component_compare',
        'component_propose_selection',
        'component_add_offer',
        'bom_read',
        'bom_propose_edit',
        'source_capture',
        'source_read',
        'research_read_page',
        'wiring_validate',
        'wiring_render',
        'wiring_set_pins',
        'wiring_set_connections',
        'calculation_run',
        'calculation_explain_inputs',
        'calculation_templates',
        'test_create_draft',
        'test_record_result',
        'graph_neighbors',
        'graph_impact',
        'graph_propose_edges',
        'project_search',
        'proposal_read',
        'proposal_list',
        'proposal_wait',
        'project_coverage',
      ].sort(),
    );
  });

  it('leaves the rest to the full profile', () => {
    expect(tools('full').sort()).toEqual(
      [
        'ui_open_artifact',
        'ui_request_review',
        'ui_suggest_action',
        'ui_focus_terminal',
        'build_preview',
        'build_export',
        'cad_export',
        'tool_doctor',
        'bom_export',
        'artifact_history',
        'artifact_compare',
        'artifact_import_file',
        'artifact_read_file',
        'project_changes_since',
        'graph_list',
      ].sort(),
    );
    expect(toolListing('compact')).toHaveLength(15);
    expect(toolListing('standard')).toHaveLength(45);
    expect(toolListing('full').map((tool) => tool.name)).toEqual(
      agentTools.map((tool) => tool.toolName),
    );
  });

  it('gives every operation that is not an agent tool the full tier and a known pack', () => {
    for (const def of OPS) {
      expect(opPacks, def.name).toContain(def.pack);
      if (!AGENT_TOOL_OPS.has(def.name)) expect(def.tier, def.name).toBe('full');
    }
    expect(op('cad.check')).toMatchObject({ tier: 'core', pack: 'cad' });
    expect(op('terminal.start').pack).toBe('system');
    expect(op('proposal.approve').pack).toBe('review');
  });
});

describe('new V1 operations', () => {
  it('registers them with the capability and mutation flags of the specification', () => {
    const flags = (name: string) => {
      const def = op(name);
      return [def.capability, def.mutating, AGENT_OPS.has(name)];
    };
    expect(flags('work.status')).toEqual(['both', false, true]);
    expect(flags('project.coverage')).toEqual(['both', false, true]);
    expect(flags('guide.read')).toEqual(['both', false, true]);
    expect(flags('tool.call')).toEqual(['both', true, true]);
    expect(flags('agent.activity')).toEqual(['user', false, false]);
    expect(flags('cad.export')).toEqual(['both', true, true]);
    expect([...RUST_HOST_OPS].every((name) => OPS_BY_NAME.has(name))).toBe(true);
    // Served by the legacy core for a person only: agents may call them on the Rust host.
    for (const name of RUST_HOST_AGENT_OPS) {
      expect(AGENT_OPS.has(name)).toBe(true);
      expect(RUST_HOST_OPS.has(name)).toBe(false);
    }
  });

  it('accepts the documented inputs', () => {
    expect(op('work.status').input.parse({})).toEqual({});
    expect(op('work.status').input.parse({ scope: 'project' })).toEqual({ scope: 'project' });
    expect(() => op('work.status').input.parse({ scope: 'mine' })).toThrow();
    expect(op('guide.read').input.parse({ topic: 'cad-verify' })).toEqual({ topic: 'cad-verify' });
    expect(op('tool.call').input.parse({ tool: 'bom_read' })).toEqual({ tool: 'bom_read' });
    expect(
      op('tool.call').input.parse({ tool: 'wiring.validate', input: { artifactId: 'x', any: 1 } }),
    ).toEqual({ tool: 'wiring.validate', input: { artifactId: 'x', any: 1 } });
    expect(op('agent.activity').input.parse({})).toEqual({ limit: 100 });
    expect(() => op('agent.activity').input.parse({ limit: 501 })).toThrow();
  });

  it('keeps existing inputs valid while accepting the added fields', () => {
    expect(op('tool.describe').input.parse({})).toEqual({});
    expect(op('tool.describe').input.parse({ op: 'cad.check' })).toEqual({ op: 'cad.check' });
    expect(op('tool.describe').input.parse({ tool: 'cad_check', artifactType: 'note' })).toEqual({
      tool: 'cad_check',
      artifactType: 'note',
    });
    expect(op('terminal.start').input.parse({ adapterId: 'codex' })).toEqual({
      adapterId: 'codex',
    });
    expect(
      op('terminal.start').input.parse({
        adapterId: 'codex',
        cols: 120,
        rows: 40,
        model: 'gpt-6-luna',
        profile: 'auto',
      }),
    ).toMatchObject({ cols: 120, rows: 40, model: 'gpt-6-luna', profile: 'auto' });
    expect(() =>
      op('terminal.start').input.parse({ adapterId: 'codex', profile: 'tiny' }),
    ).toThrow();
    expect(
      op('connection.configure').input.parse({
        adapterId: 'codex',
        model: null,
        profile: 'compact',
      }),
    ).toEqual({ adapterId: 'codex', model: null, profile: 'compact' });
    const send = { conversationId: 'c', requestId: 'r2', adapterId: 'claude-code', text: 'Go on' };
    expect(op('chat.send').input.parse(send)).not.toHaveProperty('continues');
    expect(op('chat.send').input.parse({ ...send, continues: { requestId: 'r1' } })).toMatchObject({
      continues: { requestId: 'r1' },
    });
    // Only the host sends an automatic continuation; the transport cannot claim one.
    expect(() =>
      op('chat.send').input.parse({ ...send, continues: { requestId: 'r1', automatic: true } }),
    ).toThrow();
    const part = '00000000-0000-4000-8000-000000000001';
    expect(op('cad.export').input.parse({ artifactId: part, destPath: '/tmp/a.stl' })).toEqual({
      artifactId: part,
      destPath: '/tmp/a.stl',
      format: 'stl',
    });
    expect(
      op('cad.export').input.parse({
        artifactId: part,
        destPath: 'exports/a.step',
        format: 'step',
        method: 'faceted',
      }),
    ).toMatchObject({ format: 'step', method: 'faceted' });
    expect(() =>
      op('cad.export').input.parse({ artifactId: part, destPath: 'a.igs', format: 'iges' }),
    ).toThrow();
    expect(() =>
      op('cad.export').input.parse({ artifactId: part, destPath: 'a.step', timeoutMs: 300_001 }),
    ).toThrow();
    // cad.check: expect may be left out, and items and requirement ids are added.
    const requirement = '00000000-0000-4000-8000-000000000002';
    expect(
      op('cad.check').input.parse({ artifactId: part, requirementIds: [requirement] }),
    ).toEqual({
      artifactId: part,
      requirementIds: [requirement],
    });
    const spec = {
      bodies: 1,
      spec: [
        { item: 'plate 40 x 30 x 5 mm', size: [40, 30, 5] },
        { item: 'answers the envelope', requirementId: requirement, bbox: { min: [0, 0, 0] } },
        { item: 'groove bottom' },
      ],
    };
    expect(op('cad.check').input.parse({ artifactId: part, expect: spec }).expect).toEqual(spec);
    expect(op('cad.check').input.parse({ artifactId: part, expect: { size: [1, 2, 3] } })).toEqual({
      artifactId: part,
      expect: { size: [1, 2, 3] },
    });
    expect(() =>
      op('cad.check').input.parse({ artifactId: part, expect: { spec: [{ item: '' }] } }),
    ).toThrow();
    expect(() =>
      op('cad.check').input.parse({
        artifactId: part,
        expect: { spec: [{ item: 'x'.repeat(201) }] },
      }),
    ).toThrow();
  });

  it('parses sessions and adapters recorded before V1 and fills the new fields', () => {
    const session = sessionInfoSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      adapterId: 'codex',
      executablePath: '/usr/local/bin/codex',
      state: 'exited',
      pid: null,
      exitCode: 0,
      cols: 80,
      rows: 24,
      startedAt: null,
      endedAt: null,
      lastError: null,
    });
    expect(session).toMatchObject({
      model: null,
      profile: 'standard',
      profileSource: 'adapter-default',
      toolCount: 0,
      calls: 0,
      errors: 0,
    });
    const adapter = adapterStatusSchema.parse({
      adapterId: 'codex',
      label: 'Codex CLI',
      available: false,
      executablePath: null,
      version: null,
      testedVersionRange: null,
      recognizedVersion: false,
      capabilities: { mcp: true, cli: true, resume: false },
      lastTestAt: null,
      lastTestOk: null,
      lastError: null,
      installHint: null,
    });
    expect(adapter).toMatchObject({
      model: null,
      profile: 'auto',
      resolvedProfile: 'standard',
      models: [],
      verified: false,
      docsUrl: null,
      guideChannels: [],
    });
  });
});

describe('agent-facing text', () => {
  it('describes what each agent tool does, when to use it and what it returns', () => {
    for (const tool of agentTools) {
      const max = tool.tier === 'core' ? 900 : 300;
      expect(tool.description.length, tool.toolName).toBeGreaterThanOrEqual(80);
      expect(tool.description.length, tool.toolName).toBeLessThanOrEqual(max);
      expect(tool.description, tool.toolName).toMatch(/\.$|\}$/);
    }
  });

  it('keeps every summary to one line of at most 90 characters', () => {
    for (const def of OPS) {
      expect(def.summary.length, def.name).toBeGreaterThan(0);
      expect(def.summary.length, def.name).toBeLessThanOrEqual(90);
      expect(def.summary, def.name).not.toMatch(/\n/);
    }
  });

  it('describes every parameter of every agent tool', () => {
    const missing: string[] = [];
    for (const tool of agentTools) {
      const properties = (input(tool).properties ?? {}) as Record<string, JsonSchema>;
      for (const [name, schema] of Object.entries(properties))
        if (typeof schema.description !== 'string' || schema.description.length < 8)
          missing.push(`${tool.toolName}.${name}`);
    }
    expect(missing).toEqual([]);
  });

  it('documents idempotencyKey wherever it is exposed', () => {
    const exposed = OPS.filter((def) => 'idempotencyKey' in (input(def).properties as object));
    expect(exposed.length).toBeGreaterThan(20);
    for (const def of exposed)
      expect(
        (input(def).properties as Record<string, JsonSchema>).idempotencyKey!.description,
        def.name,
      ).toBe('Optional; reuse the same key only when retrying the identical call.');
  });

  it('names other tools by tool name, never by dotted operation name', () => {
    const dotted = new RegExp(
      `(^|[^\\w.])(${OPS.map((def) => def.name.replace('.', '\\.')).join('|')})(?![\\w])`,
    );
    const offenders: string[] = [];
    const check = (where: string, text: string) => {
      if (dotted.test(text)) offenders.push(`${where}: ${text}`);
    };
    for (const def of agentOps) {
      check(def.name, def.description);
      check(`${def.name} summary`, def.summary);
      for (const text of descriptions(input(def))) check(`${def.name} parameter`, text);
    }
    for (const [type, schema] of Object.entries(artifactPayloadSchemas))
      for (const text of descriptions(zodToJsonSchema(schema, { $refStrategy: 'none' })))
        check(`${type} payload`, text);
    expect(offenders).toEqual([]);
  });

  it('only names tools that exist', () => {
    const known = new Set(OPS.map((def) => def.toolName));
    const prefixes = [...new Set(OPS.map((def) => def.toolName.split('_')[0]))].join('|');
    const mention = new RegExp(`\\b(?:${prefixes})_[a-z]+(?:_[a-z]+)*\\b`, 'g');
    const unknown: string[] = [];
    for (const def of agentOps)
      for (const text of [def.description, def.summary, ...descriptions(input(def))])
        for (const name of text.match(mention) ?? [])
          if (!known.has(name)) unknown.push(`${def.name}: ${name}`);
    expect(unknown).toEqual([]);
  });
});

describe('examples', () => {
  it('provides one for every agent tool', () => {
    expect(agentTools.filter((tool) => !tool.example).map((tool) => tool.toolName)).toEqual([]);
  });

  it('parses each example with its own input schema', () => {
    for (const def of OPS) {
      if (!def.example) continue;
      const parsed = def.input.safeParse(def.example);
      expect(parsed.success ? [] : parsed.error.issues, def.name).toEqual([]);
    }
  });

  it('keeps the create and update examples valid for the payload they show', () => {
    for (const name of ['artifact.create_draft', 'artifact.update_draft']) {
      const payload = artifactPayloadSchemas.requirement.safeParse(op(name).example!.payload);
      expect(payload.success ? [] : payload.error.issues, name).toEqual([]);
    }
  });

  it('repeats the same call in a core tool description as in its example', () => {
    for (const name of ['artifact.create_draft', 'cad.write_source', 'tool.describe']) {
      const def = op(name);
      const inline = JSON.parse(def.description.slice(def.description.indexOf('Example: ') + 9));
      expect(inline, name).toEqual(def.example);
    }
  });
});

/**
 * True when every value the compact schema describes is shaped like a value
 * the full schema accepts: same property names and nesting, every field the
 * full schema requires, and types and enums no wider than the full ones.
 */
function isSubset(compact: JsonSchema, full: JsonSchema, path: string, problems: string[]): void {
  const branches = full.anyOf as JsonSchema[] | undefined;
  if (branches) {
    const attempts = branches.map((branch) => {
      const found: string[] = [];
      isSubset(compact, branch, path, found);
      return found;
    });
    if (!attempts.some((found) => !found.length)) problems.push(...attempts[0]!);
    return;
  }
  const fullTypes = full.type === undefined ? null : ([full.type].flat() as string[]);
  if (fullTypes) {
    const allowed = fullTypes.includes('number') ? [...fullTypes, 'integer'] : fullTypes;
    if (!allowed.includes(compact.type as string))
      problems.push(`${path}: type ${String(compact.type)}`);
  }
  if (full.enum) {
    const wider = ((compact.enum as unknown[]) ?? [null]).filter(
      (value) => !(full.enum as unknown[]).includes(value),
    );
    if (wider.length) problems.push(`${path}: enum ${wider.join(',')}`);
  }
  for (const key of ['minItems', 'maxItems'] as const)
    if (full[key] !== undefined && compact[key] !== full[key]) problems.push(`${path}: ${key}`);
  if (compact.type === 'object' && full.properties) {
    const fullProps = full.properties as Record<string, JsonSchema>;
    const compactProps = (compact.properties ?? {}) as Record<string, JsonSchema>;
    for (const [name, child] of Object.entries(compactProps)) {
      if (!fullProps[name]) problems.push(`${path}.${name}: not in the full schema`);
      else isSubset(child, fullProps[name], `${path}.${name}`, problems);
    }
    for (const name of (full.required ?? []) as string[])
      if (!((compact.required ?? []) as string[]).includes(name))
        problems.push(`${path}.${name}: required by the full schema`);
  }
  if (compact.type === 'array' && full.items)
    isSubset(compact.items as JsonSchema, full.items as JsonSchema, `${path}[]`, problems);
}

describe('compact overlays', () => {
  const registry = buildRegistry();
  const core = registry.operations.filter((entry) => entry.agentTool && entry.tier === 'core');

  it('exist for every core tool and for nothing else', () => {
    expect(
      registry.operations.filter((entry) => entry.compactSchema).map((entry) => entry.name),
    ).toEqual(core.map((entry) => entry.name));
  });

  it('are subsets of the real input schema', () => {
    for (const entry of core) {
      const problems: string[] = [];
      isSubset(entry.compactSchema!, entry.inputSchema, entry.toolName, problems);
      expect(problems, entry.toolName).toEqual([]);
    }
  });

  it('accept the example of their tool', () => {
    for (const def of OPS) {
      if (!def.compactSchema) continue;
      // Equality also shows that nothing in the example falls outside the overlay.
      expect(def.compactSchema.parse(def.example), def.name).toEqual(def.example);
    }
  });

  it('are exported lean: no dialect marker, closed-object marker, union or format', () => {
    for (const entry of core) {
      const text = JSON.stringify(entry.compactSchema);
      expect(text, entry.toolName).not.toMatch(
        /"\$schema"|"additionalProperties"|"anyOf"|"format"/,
      );
      expect(text, entry.toolName).not.toMatch(/"type":\[/);
    }
  });
});

describe('listing budgets', () => {
  const size = (profile: Parameters<typeof toolListing>[0]) =>
    JSON.stringify(toolListing(profile)).length;

  it('keeps the compact tools list within 8,500 characters', () => {
    // 0.2.4: raised from 7,000 to 8,500 for cad_view and image_view, cad_check spec items and write-and-check expect, measured 8,399 (recorded in audit/v0.2.4)
    expect(size('compact')).toBeLessThanOrEqual(8500);
  });

  // Ceilings a little above the measured sizes, so that growth is a decision.
  // The 0.2.4 registry measures 69,358 standard and 79,336 full characters.
  it('bounds the standard and full tools lists', () => {
    // 0.2.4: raised from 66,000 to 70,000 for cad_view and image_view, cad_check spec items and write-and-check expect, measured 69,358 (recorded in audit/v0.2.4)
    expect(size('standard')).toBeLessThanOrEqual(70_000);
    // 0.2.4: raised from 74,000 to 80,000 for cad_export, cad_view and image_view, cad_check spec items and write-and-check expect, measured 79,336 (recorded in audit/v0.2.4)
    expect(size('full')).toBeLessThanOrEqual(80_000);
  });
});

describe('name resolution', () => {
  it('finds an operation by dotted or underscore name, however many underscores it has', () => {
    for (const def of OPS) {
      expect(resolveOp(def.name)).toBe(def);
      expect(resolveOp(def.toolName)).toBe(def);
    }
    expect(resolveOp('cad_write.source')).toBeUndefined();
  });

  it('describes a tool with its tier, pack, summary, example and schemas', () => {
    const described = describeOp('artifact_create_draft', 'requirement')!;
    expect(described).toMatchObject({
      op: 'artifact.create_draft',
      tool: 'artifact_create_draft',
      tier: 'core',
      pack: 'core',
      mutating: true,
    });
    expect(described.example).toEqual(op('artifact.create_draft').example);
    expect((described.payloadSchema as JsonSchema).properties).toHaveProperty('statement');
    expect(describeOp('no_such_tool')).toBeNull();
  });
});
