import { describe, expect, it } from 'vitest';
import { qty, type Pin, type WiringConnection, type WiringPayload } from '@stark/contracts';
import { WiringAnalyzer } from './wiring-analyzer.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const RA = 'cccccccc-0000-4000-8000-000000000003';
const RB = 'dddddddd-0000-4000-8000-000000000004';

const analyzer = () => new WiringAnalyzer();
const ok = (_id: string) => ({ title: 'known' });

const pin = (comp: string, p: string, type: Pin['type'], v?: [number, number, string]): Pin => ({
  componentArtifactId: comp,
  pin: p,
  type,
  voltageRange: v ? { min: qty(v[0], v[2]), max: qty(v[1], v[2]) } : undefined,
});

const conn = (
  id: string,
  fromPin: string,
  toPin: string,
  voltage?: ReturnType<typeof qty>,
): WiringConnection => ({
  id,
  from: { componentArtifactId: A, componentRevisionId: RA, pin: fromPin },
  to: { componentArtifactId: B, componentRevisionId: RB, pin: toPin },
  voltage,
  signalRole: 'power',
});

const codes = (payload: WiringPayload, resolve = ok) =>
  analyzer()
    .validate(payload, resolve)
    .findings.map((f) => f.code);

describe('WiringAnalyzer.validate', () => {
  it('clean payload produces no findings', () => {
    const payload: WiringPayload = {
      pins: [
        pin(A, 'VCC', 'power', [4.5, 14, 'V']),
        pin(A, 'GND', 'ground'),
        pin(B, 'VIN', 'power', [4.5, 14, 'V']),
        pin(B, 'GND', 'ground'),
      ],
      connections: [conn('c1', 'VCC', 'VIN', qty(12, 'V')), conn('c2', 'GND', 'GND', qty(0, 'V'))],
    };
    const { findings, coverage } = analyzer().validate(payload, ok);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(coverage).toContain('voltage range');
    expect(coverage).toContain('electrical safety');
  });

  it('NO_CONNECTIONS when empty', () => {
    const { findings } = analyzer().validate({ pins: [], connections: [] }, ok);
    expect(findings).toEqual([
      expect.objectContaining({ severity: 'info', code: 'NO_CONNECTIONS' }),
    ]);
  });

  it('CONNECTION_UNKNOWN_PIN for undeclared pin names', () => {
    const payload: WiringPayload = {
      pins: [
        pin(A, 'VCC', 'power'),
        pin(B, 'VIN', 'power'),
        pin(B, 'GND', 'ground'),
        pin(A, 'GND', 'ground'),
      ],
      connections: [conn('c1', 'VCC', 'VIN'), conn('c2', 'GND', 'GND'), conn('c3', 'X9', 'GND')],
    };
    const f = analyzer().validate(payload, ok).findings;
    expect(f.some((x) => x.code === 'CONNECTION_UNKNOWN_PIN' && x.connectionId === 'c3')).toBe(
      true,
    );
    expect(f.find((x) => x.code === 'CONNECTION_UNKNOWN_PIN')!.severity).toBe('warning');
  });

  it('VOLTAGE_INCOMPATIBLE when connection voltage is outside a pin range', () => {
    const payload: WiringPayload = {
      pins: [
        pin(A, 'VCC', 'power', [4.5, 5.5, 'V']),
        pin(B, 'VIN', 'power'),
        pin(A, 'GND', 'ground'),
        pin(B, 'GND', 'ground'),
      ],
      connections: [conn('c1', 'VCC', 'VIN', qty(12, 'V')), conn('c2', 'GND', 'GND')],
    };
    const f = analyzer().validate(payload, ok).findings;
    const v = f.find((x) => x.code === 'VOLTAGE_INCOMPATIBLE');
    expect(v?.severity).toBe('error');
    expect(v?.connectionId).toBe('c1');
  });

  it('VOLTAGE_INCOMPATIBLE converts across compatible units', () => {
    const payload: WiringPayload = {
      pins: [
        pin(A, 'VCC', 'power', [3000, 3600, 'mV']),
        pin(B, 'VIN', 'power'),
        pin(A, 'GND', 'ground'),
        pin(B, 'GND', 'ground'),
      ],
      connections: [conn('c1', 'VCC', 'VIN', qty(3.3, 'V')), conn('c2', 'GND', 'GND')],
    };
    expect(codes(payload)).not.toContain('VOLTAGE_INCOMPATIBLE');
  });

  it('MISSING_GROUND when a powered component has no ground connection', () => {
    const payload: WiringPayload = {
      pins: [pin(A, 'VCC', 'power'), pin(B, 'VIN', 'power'), pin(A, 'GND', 'ground')],
      connections: [conn('c1', 'VCC', 'VIN')],
    };
    const f = analyzer().validate(payload, ok).findings;
    expect(f.some((x) => x.code === 'MISSING_GROUND')).toBe(true);
    // Both endpoints powered, neither grounded.
    expect(f.filter((x) => x.code === 'MISSING_GROUND').length).toBe(2);
  });

  it('DUPLICATE_EXCLUSIVE when a pin is used by multiple connections', () => {
    const payload: WiringPayload = {
      pins: [
        pin(A, 'VCC', 'power'),
        pin(B, 'VIN', 'power'),
        pin(A, 'GND', 'ground'),
        pin(B, 'GND', 'ground'),
      ],
      connections: [conn('c1', 'VCC', 'VIN'), conn('c2', 'VCC', 'GND')],
    };
    const f = analyzer().validate(payload, ok).findings;
    const d = f.find((x) => x.code === 'DUPLICATE_EXCLUSIVE');
    expect(d?.severity).toBe('error');
    expect(d?.message).toContain('VCC');
  });

  it('CHANGED_COMPONENT when the component no longer resolves', () => {
    const payload: WiringPayload = {
      pins: [
        pin(A, 'VCC', 'power'),
        pin(B, 'VIN', 'power'),
        pin(A, 'GND', 'ground'),
        pin(B, 'GND', 'ground'),
      ],
      connections: [conn('c1', 'VCC', 'VIN'), conn('c2', 'GND', 'GND')],
    };
    const resolve = (id: string) => (id === A ? { title: 'A' } : undefined);
    const f = analyzer().validate(payload, resolve).findings;
    const ch = f.filter((x) => x.code === 'CHANGED_COMPONENT');
    expect(ch.length).toBeGreaterThan(0);
    expect(ch[0]!.severity).toBe('error');
    expect(ch[0]!.message).toContain('unavailable');
  });
});

describe('WiringAnalyzer.render', () => {
  const payload: WiringPayload = {
    pins: [
      pin(A, 'VCC', 'power'),
      pin(B, 'VIN', 'power'),
      pin(A, 'GND', 'ground'),
      pin(B, 'GND', 'ground'),
    ],
    connections: [conn('c1', 'VCC', 'VIN', qty(12, 'V')), conn('c2', 'GND', 'GND')],
  };
  const titles = (id: string) =>
    id === A ? { title: 'ESP32 <Board>' } : { title: 'Motor & Driver' };

  it('produces a labeled table', () => {
    const { table } = analyzer().render(payload, titles);
    expect(table.length).toBe(2);
    expect(table[0]!.fromLabel).toBe('ESP32 <Board>.VCC');
    expect(table[0]!.toLabel).toBe('Motor & Driver.VIN');
    expect(table[0]!.connection.id).toBe('c1');
  });

  it('produces an escaped, dark-theme SVG diagram', () => {
    const { diagramSvg } = analyzer().render(payload, titles);
    expect(diagramSvg).toContain('<svg');
    expect(diagramSvg).toContain('#87AFC7');
    expect(diagramSvg).toContain('#E6E9ED');
    expect(diagramSvg).toContain('ESP32 &lt;Board&gt;');
    expect(diagramSvg).toContain('Motor &amp; Driver');
    expect(diagramSvg).not.toContain('<Board>');
    expect(diagramSvg).toContain('power 12V');
  });

  it('handles an empty payload', () => {
    const { diagramSvg, table } = analyzer().render({ pins: [], connections: [] }, titles);
    expect(table).toEqual([]);
    expect(diagramSvg).toContain('no connections');
  });

  it('renders self-connections and right-to-left connections', () => {
    const C = 'cccccccc-0000-4000-8000-000000000009';
    const p: WiringPayload = {
      pins: [],
      connections: [
        {
          id: 'c1',
          from: { componentArtifactId: C, componentRevisionId: RA, pin: 'TX' },
          to: { componentArtifactId: A, componentRevisionId: RB, pin: 'RX' },
          signalRole: 'uart',
        },
        {
          id: 'c2',
          from: { componentArtifactId: B, componentRevisionId: RB, pin: 'P1' },
          to: { componentArtifactId: B, componentRevisionId: RB, pin: 'P2' },
          signalRole: 'jumper',
        },
      ],
    };
    const t = (id: string) => ({ title: `T-${id.slice(0, 4)}` });
    const { diagramSvg, table } = analyzer().render(p, t);
    expect(diagramSvg).toContain('uart');
    expect(diagramSvg).toContain('jumper');
    // C sorts first (first appearance) but the wire runs C→A regardless of geometry.
    expect(table[0]!.fromLabel).toBe('T-cccc.TX');
    expect(table[0]!.toLabel).toBe('T-aaaa.RX');
    expect(table[1]!.fromLabel).toBe('T-bbbb.P1');
    expect(table[1]!.toLabel).toBe('T-bbbb.P2');
  });
});
