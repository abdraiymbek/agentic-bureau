import { describe, expect, it } from 'vitest';
import {
  describe as describeValue,
  diffFiles,
  diffLines,
  diffPayload,
  diffSequence,
  fieldLabel,
  foldUnchanged,
  formatBytes,
  quantityText,
  textContent,
  type DiffEntry,
} from '../../apps/desktop/src/renderer/lib/diff';

const brief = (entries: DiffEntry[]) =>
  entries.map((e) => ({
    label: e.label,
    change: e.change,
    from: e.from?.text,
    to: e.to?.text,
    notes: e.notes,
  }));

describe('payload diff: nested objects', () => {
  it('reports each changed leaf with its path, in the new payload order', () => {
    const entries = diffPayload(
      { statement: 'Carry 0.3 kg', priority: 'should', meta: { owner: 'A', note: 'x' } },
      { statement: 'Carry 0.3 kg', priority: 'must', meta: { owner: 'B', added: true } },
    );
    expect(brief(entries)).toEqual([
      { label: 'Priority', change: 'changed', from: 'should', to: 'must', notes: [] },
      { label: 'Meta › owner', change: 'changed', from: 'A', to: 'B', notes: [] },
      { label: 'Meta › added', change: 'added', from: undefined, to: 'Yes', notes: [] },
      { label: 'Meta › note', change: 'removed', from: 'x', to: undefined, notes: [] },
    ]);
  });

  it('says nothing when only key order differs', () => {
    expect(diffPayload({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toEqual([]);
  });

  it('keeps recorded keys verbatim and turns schema names into words', () => {
    expect(fieldLabel('acceptanceCriterion')).toBe('acceptance criterion');
    expect(fieldLabel('V_IN_max')).toBe('V_IN_max');
    expect(fieldLabel('GPIO17.mode')).toBe('GPIO17.mode');
    const [entry] = diffPayload(
      { properties: { V_IN_max: { quantity: { value: 5, unit: 'V' } } } },
      { properties: { V_IN_max: { quantity: { value: 6, unit: 'V' } } } },
    );
    expect(entry!.label).toBe('Properties › V_IN_max › quantity');
    expect([entry!.from?.text, entry!.to?.text]).toEqual(['5 V', '6 V']);
  });
});

describe('payload diff: quantities are atomic', () => {
  it('changes value and unit together in one entry', () => {
    const entries = diffPayload(
      { target: { value: 0.3, unit: 'kg' } },
      { target: { value: 0.5, unit: 'kg' } },
    );
    expect(brief(entries)).toEqual([
      { label: 'Target', change: 'changed', from: '0.3 kg', to: '0.5 kg', notes: [] },
    ]);
  });

  it('reports a bound change even when the value is the same', () => {
    const entries = diffPayload(
      { target: { value: 0.5, unit: 'kg', min: 0.4, max: 0.6 } },
      { target: { value: 0.5, unit: 'kg', min: 0.49, max: 0.51 } },
    );
    expect(brief(entries)).toEqual([
      {
        label: 'Target',
        change: 'changed',
        from: '0.5 [0.4–0.6] kg',
        to: '0.5 [0.49–0.51] kg',
        notes: ['bounds changed'],
      },
    ]);
  });

  it('shows a single bound and its removal', () => {
    expect(quantityText({ value: 2, unit: 'A', max: 3 })).toBe('2 A (max 3)');
    const [entry] = diffPayload(
      { current: { value: 2, unit: 'A', min: 1 } },
      { current: { value: 2, unit: 'A' } },
    );
    expect([entry!.from?.text, entry!.to?.text, entry!.notes]).toEqual([
      '2 A (min 1)',
      '2 A',
      ['bounds changed'],
    ]);
  });

  it('names a unit change', () => {
    const [entry] = diffPayload(
      { m: { value: 300, unit: 'g' } },
      { m: { value: 0.3, unit: 'kg' } },
    );
    expect(entry!.notes).toEqual(['unit changed from g to kg']);
    expect([entry!.from?.text, entry!.to?.text]).toEqual(['300 g', '0.3 kg']);
  });

  it('never lets rounding hide a change', () => {
    const [entry] = diffPayload(
      { m: { value: 0.30001, unit: 'kg' } },
      { m: { value: 0.30002, unit: 'kg' } },
    );
    expect([entry!.from?.text, entry!.to?.text]).toEqual(['0.30001 kg', '0.30002 kg']);
  });
});

describe('payload diff: unknown values', () => {
  it('turns known into unknown as one entry carrying the reason', () => {
    const entries = diffPayload(
      { target: { value: 0.3, unit: 'kg' } },
      { target: { unknown: true, reason: 'battery mass not yet sourced' } },
    );
    expect(brief(entries)).toEqual([
      {
        label: 'Target',
        change: 'changed',
        from: '0.3 kg',
        to: 'Unknown — battery mass not yet sourced',
        notes: ['became unknown: battery mass not yet sourced'],
      },
    ]);
    expect(entries[0]!.to?.unknown).toBe(true);
  });

  it('turns unknown into known, and notices a changed reason', () => {
    expect(
      diffPayload({ v: { unknown: true, reason: 'r' } }, { v: { value: 1, unit: 'm' } })[0]!.notes,
    ).toEqual(['now known']);
    expect(
      diffPayload({ v: { unknown: true, reason: 'r' } }, { v: { unknown: true, reason: 's' } })[0]!
        .notes,
    ).toEqual(['reason for the unknown changed']);
  });
});

describe('payload diff: arrays', () => {
  it('matches named items by name: removing the first input names that input', () => {
    const a = {
      inputs: [
        { name: 'payload_mass', quantity: { value: 0.3, unit: 'kg' }, literal: false },
        { name: 'chassis_mass', quantity: { value: 0.9, unit: 'kg' }, literal: false },
      ],
    };
    const b = { inputs: [a.inputs[1]] };
    const entries = diffPayload(a, b);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: 'Inputs › payload_mass', change: 'removed' });
    expect(entries[0]!.fields?.map((f) => `${f.label}: ${f.value.text}`)).toEqual([
      'name: payload_mass',
      'quantity: 0.3 kg',
      'literal: No',
    ]);
  });

  it('matches items by id wherever they move, and reports the move and the edit', () => {
    const one = { id: 'a', seller: 'Pololu', price: { amount: '12.50', currency: 'USD' } };
    const two = { id: 'b', seller: 'Digi-Key', price: { amount: '9.10', currency: 'USD' } };
    const three = { id: 'c', seller: 'Mouser', price: null };
    const entries = diffPayload(
      { offers: [one, two, three] },
      { offers: [{ ...two, price: { amount: '8.90', currency: 'USD' } }, one, three] },
    );
    // A swap of two neighbours is one move; which of the two is "the" move is the engine's choice.
    expect(entries.filter((e) => e.change === 'moved')).toHaveLength(1);
    expect(brief(entries.filter((e) => e.change !== 'moved'))).toEqual([
      {
        label: 'Offers › Digi-Key › price',
        change: 'changed',
        from: '9.10 USD',
        to: '8.90 USD',
        notes: [],
      },
    ]);
    const shuffled = diffPayload({ offers: [one, two, three] }, { offers: [three, one, two] });
    expect(brief(shuffled)).toEqual([
      {
        label: 'Offers › Mouser',
        change: 'moved',
        from: undefined,
        to: undefined,
        notes: ['moved from position 3 to 1'],
      },
    ]);
  });

  it('inserts a step at the front without blaming the steps that shifted', () => {
    const steps = [
      { order: 1, instruction: 'Mount motors', tools: ['2 mm hex'] },
      { order: 2, instruction: 'Route harness', tools: [] },
    ];
    const next = [
      { order: 1, instruction: 'Fit bearings', tools: ['press'] },
      { ...steps[0], order: 2 },
      { ...steps[1], order: 3 },
    ];
    const entries = diffPayload({ steps }, { steps: next });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: 'Steps › Fit bearings', change: 'added' });
  });

  it('shows an added or removed item without its position and names the objects it refers to', () => {
    const ref = '5c951dcd-1111-4222-8333-944444444444';
    const entries = diffPayload(
      { steps: [{ order: 1, instruction: 'Mount the Pi', componentRefs: [ref] }] },
      { steps: [] },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fields?.map((f) => f.label)).toEqual(['instruction', 'component refs']);
    expect(entries[0]!.fields?.[1]?.value.refs).toEqual([ref]);
  });

  it('never hides a field that merely happens to equal the position', () => {
    const entries = diffPayload({ parts: [] }, { parts: [{ count: 1, label: 'M2.5 screw' }] });
    expect(entries[0]!.fields?.map((f) => `${f.label}: ${f.value.text}`)).toEqual([
      'count: 1',
      'label: M2.5 screw',
    ]);
  });

  it('reports a reordered list as moves, not as changed items', () => {
    const entries = diffPayload(
      { systems: ['drive', 'camera', 'power'] },
      {
        systems: ['camera', 'power', 'drive'],
      },
    );
    expect(brief(entries)).toEqual([
      {
        label: 'Systems',
        change: 'moved',
        from: undefined,
        to: 'drive',
        notes: ['moved from position 1 to 3'],
      },
    ]);
  });

  it('treats an edited item without identity as the same item, changed', () => {
    const entries = diffPayload(
      { steps: [{ order: 1, instruction: 'Mount motors', tools: ['2 mm hex'] }] },
      { steps: [{ order: 1, instruction: 'Mount both motors', tools: ['2 mm hex'] }] },
    );
    expect(brief(entries)).toEqual([
      {
        label: 'Steps › Mount both motors › instruction',
        change: 'changed',
        from: 'Mount motors',
        to: 'Mount both motors',
        notes: [],
      },
    ]);
  });

  it('adds and removes plain list values by content', () => {
    const entries = diffPayload(
      { tools: ['2 mm hex', 'press'] },
      { tools: ['press', 'torque driver'] },
    );
    expect(brief(entries)).toEqual([
      { label: 'Tools', change: 'removed', from: '2 mm hex', to: undefined, notes: [] },
      { label: 'Tools', change: 'added', from: undefined, to: 'torque driver', notes: [] },
    ]);
  });

  it('matches wiring pins by component and label', () => {
    const pin = (p: string, type: string) => ({ componentArtifactId: 'c1', pin: p, type });
    const entries = diffPayload(
      { pins: [pin('GND', 'ground'), pin('VIN', 'power')] },
      { pins: [pin('VIN', 'power'), pin('GND', 'power')] },
    );
    expect(entries.map((e) => [e.label, e.change])).toEqual([
      ['Pins › GND', 'moved'],
      ['Pins › GND › type', 'changed'],
    ]);
  });
});

describe('payload diff: long text', () => {
  it('stacks long text with a line diff and marks the changed words', () => {
    const before =
      'The rover shall carry a 300 g sensor payload\nup a 15 degree ramp\nwithout stalling.';
    const after =
      'The rover shall carry a 500 g sensor payload\nup a 15 degree ramp\nwithout stalling.';
    const [entry] = diffPayload({ markdown: before }, { markdown: after });
    expect(entry!.kind).toBe('text');
    expect(entry!.to?.long).toBe(true);
    const lines = entry!.lines!;
    expect(lines.map((l) => l.op)).toEqual(['removed', 'added', 'same', 'same']);
    const added = lines[1]!;
    expect(
      added.op === 'added' && added.words?.filter((w) => w.changed).map((w) => w.text),
    ).toEqual(['500']);
  });

  it('keeps short text inline', () => {
    const [entry] = diffPayload({ owner: 'Ana' }, { owner: 'Ben' });
    expect(entry!.kind).toBe('value');
    expect(entry!.to?.long).toBeFalsy();
  });

  it('folds long unchanged runs but keeps context around each edit', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 10', 'line ten');
    const folded = foldUnchanged(diffLines(a, b)!, 2);
    expect(folded.map((l) => (l.op === 'skip' ? `skip ${l.count}` : l.op))).toEqual([
      'skip 8',
      'same',
      'same',
      'removed',
      'added',
      'same',
      'same',
      'skip 7',
    ]);
  });

  it('computes a minimal edit script', () => {
    const ops = diffSequence([...'ABCABBA'], [...'CBABAC'])!;
    expect(ops.filter((o) => o.op !== '=')).toHaveLength(5);
    expect(diffSequence([], [])).toEqual([]);
    expect(diffSequence([...'abc'], [...'xyz'], undefined, 2)).toBeNull();
  });
});

describe('payload diff: references and times', () => {
  it('marks artifact ids so the renderer can name them, and timestamps for local display', () => {
    const id = '5c951dcd-1111-4222-8333-944444444444';
    expect(describeValue(id, 'sourceId')).toMatchObject({ ref: id });
    expect(describeValue(id, 'note').ref).toBeUndefined();
    expect(describeValue('2026-10-14T00:25:56.910Z', 'ranAt').time).toBe(
      '2026-10-14T00:25:56.910Z',
    );
    expect(describeValue({ amount: '12.50', currency: 'USD' }).text).toBe('12.50 USD');
    expect(describeValue(undefined)).toMatchObject({ text: 'Not set', empty: true });
  });
});

describe('file diff', () => {
  const f = (path: string, sha: string, role: 'source' | 'output' = 'source') => ({
    path,
    sha256: sha.repeat(64).slice(0, 64),
    role,
  });

  it('separates added, removed, changed, renamed and unchanged files', () => {
    const base = [f('a.scad', '1'), f('b.md', '2'), f('old.txt', '3'), f('gone.bin', '4')];
    const next = [f('a.scad', '1'), f('b.md', '5'), f('new.txt', '3'), f('c.png', '6')];
    const { changes, unchanged } = diffFiles(base, next);
    expect(unchanged).toBe(1);
    expect(changes.map((c) => [c.change, c.path, c.previousPath])).toEqual([
      ['changed', 'b.md', undefined],
      ['renamed', 'new.txt', 'old.txt'],
      ['added', 'c.png', undefined],
      ['removed', 'gone.bin', undefined],
    ]);
  });

  it('tells text from binary and sizes bytes with a unit', () => {
    expect(textContent(new TextEncoder().encode('cube(10);\n'))).toBe('cube(10);\n');
    expect(textContent(new Uint8Array([0x73, 0x6f, 0x00, 0x01]))).toBeNull();
    expect(textContent(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull();
    expect([formatBytes(812), formatBytes(12_400), formatBytes(3_200_000)]).toEqual([
      '812 B',
      '12.4 kB',
      '3.2 MB',
    ]);
  });
});
