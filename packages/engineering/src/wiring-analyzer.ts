import {
  convert,
  type Pin,
  type Quantity,
  type WiringConnection,
  type WiringPayload,
} from '@omenflow/contracts';
import type { WiringAnalyzer as WiringAnalyzerContract, WiringFinding } from '@omenflow/core';

const COVERAGE =
  'Checks: voltage range, ground return, exclusive pins, pin knowledge. ' +
  'Not a schematic ERC; does not prove electrical safety.';

/** Name heuristics for pins whose declared type is 'unknown' / undeclared. */
const GROUND_NAMES = /^(gnd|ground|vss|v-|0v|agnd|dgnd|pgnd|chassis)$/i;
const POWER_NAMES =
  /^(vcc|vdd|vcc_?\d.*|v\+|vin|vs|vbat|vbatt|pwr|power|\+?\d+v.*|5v|3v3?|12v|24v)$/i;

function effectivePinType(pin: Pin | undefined, pinName: string): Pin['type'] {
  if (pin && pin.type !== 'unknown') return pin.type;
  if (GROUND_NAMES.test(pinName)) return 'ground';
  if (POWER_NAMES.test(pinName)) return 'power';
  return pin?.type ?? 'unknown';
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wiring consistency checks over a WiringPayload: pin knowledge, voltage
 * ranges, ground returns, exclusive pin usage, and component staleness.
 */
export class WiringAnalyzer implements WiringAnalyzerContract {
  validate(
    payload: WiringPayload,
    resolveComponent: (artifactId: string) => Record<string, unknown> | undefined,
  ): { findings: WiringFinding[]; coverage: string } {
    const findings: WiringFinding[] = [];
    const pins = payload.pins ?? [];
    const conns = payload.connections ?? [];

    if (conns.length === 0) {
      findings.push({
        severity: 'info',
        code: 'NO_CONNECTIONS',
        message: 'No connections declared',
      });
    }

    const pinsByComponent = new Map<string, Pin[]>();
    for (const p of pins) {
      const list = pinsByComponent.get(p.componentArtifactId) ?? [];
      list.push(p);
      pinsByComponent.set(p.componentArtifactId, list);
    }
    const findPin = (componentArtifactId: string, pinName: string): Pin | undefined =>
      pinsByComponent.get(componentArtifactId)?.find((p) => p.pin === pinName);

    const powered = new Set<string>();
    const grounded = new Set<string>();
    /** `${componentId}:${pin}` → connection ids using it. */
    const exclusiveUse = new Map<string, { connId: string; end: 'from' | 'to' }[]>();

    for (const c of conns) {
      for (const endName of ['from', 'to'] as const) {
        const end = c[endName];
        if (resolveComponent(end.componentArtifactId) === undefined) {
          findings.push({
            severity: 'error',
            code: 'CHANGED_COMPONENT',
            connectionId: c.id,
            message: `Component revision unavailable or changed: ${end.componentArtifactId}@${end.componentRevisionId} (${endName} '${end.pin}')`,
          });
        }
        const pin = findPin(end.componentArtifactId, end.pin);
        if (!pin) {
          findings.push({
            severity: 'warning',
            code: 'CONNECTION_UNKNOWN_PIN',
            connectionId: c.id,
            message: `Unknown pin '${end.pin}' on component ${end.componentArtifactId} — not verified`,
          });
        }
        const key = `${end.componentArtifactId}:${end.pin}`;
        const uses = exclusiveUse.get(key) ?? [];
        uses.push({ connId: c.id, end: endName });
        exclusiveUse.set(key, uses);

        const t = effectivePinType(pin, end.pin);
        if (t === 'power') powered.add(end.componentArtifactId);
        if (t === 'ground') grounded.add(end.componentArtifactId);
      }

      if (c.voltage) {
        for (const endName of ['from', 'to'] as const) {
          const end = c[endName];
          const range = findPin(end.componentArtifactId, end.pin)?.voltageRange;
          if (!range) continue;
          try {
            const v = convert(c.voltage as Quantity, range.min.unit).value;
            const lo = range.min.value;
            const hi = convert(range.max, range.min.unit).value;
            if (v < lo || v > hi) {
              findings.push({
                severity: 'error',
                code: 'VOLTAGE_INCOMPATIBLE',
                connectionId: c.id,
                message:
                  `Connection voltage ${c.voltage.value} ${c.voltage.unit} outside ` +
                  `'${end.pin}' range ${range.min.value}–${range.max.value} ${range.max.unit} on component ${end.componentArtifactId}`,
              });
            }
          } catch {
            // Range units broken in the pin declaration itself — report, don't crash.
            findings.push({
              severity: 'warning',
              code: 'CONNECTION_UNKNOWN_PIN',
              connectionId: c.id,
              message: `Could not compare voltage range on pin '${end.pin}' (${end.componentArtifactId})`,
            });
          }
        }
      }
    }

    for (const [key, uses] of exclusiveUse) {
      const distinct = [...new Set(uses.map((u) => u.connId))];
      if (distinct.length > 1) {
        findings.push({
          severity: 'error',
          code: 'DUPLICATE_EXCLUSIVE',
          connectionId: distinct[1],
          message: `Pin '${key.split(':')[1]}' on component ${key.split(':')[0]} used by ${distinct.length} connections (${distinct.join(', ')}) — pins are exclusive`,
        });
      }
    }

    for (const compId of powered) {
      if (!grounded.has(compId)) {
        findings.push({
          severity: 'error',
          code: 'MISSING_GROUND',
          message: `Component ${compId} has a power pin connected but no ground pin in any connection`,
        });
      }
    }

    return { findings, coverage: COVERAGE };
  }

  render(
    payload: WiringPayload,
    resolveTitle: (artifactId: string) => { title: string } | undefined,
  ): {
    table: { connection: WiringConnection; fromLabel: string; toLabel: string }[];
    diagramSvg: string;
  } {
    const label = (end: WiringConnection['from']) => {
      const title =
        resolveTitle(end.componentArtifactId)?.title ?? end.componentArtifactId.slice(0, 8);
      return `${title}.${end.pin}`;
    };
    const table = (payload.connections ?? []).map((c) => ({
      connection: c,
      fromLabel: label(c.from),
      toLabel: label(c.to),
    }));
    return { table, diagramSvg: buildDiagram(payload, resolveTitle) };
  }
}

/* ------------------------------ SVG diagram ---------------------------- */

const BOX_W = 180;
const BOX_TOP = 60;
const GAP = 140;
const MARGIN_X = 40;
const PORT_H = 18;
const PORT_TOP = 34;
const MIN_BOX_H = 56;
const STROKE = '#87AFC7';
const TEXT = '#E6E9ED';

function buildDiagram(
  payload: WiringPayload,
  resolveTitle: (artifactId: string) => { title: string } | undefined,
): string {
  const conns = payload.connections ?? [];

  // Components in deterministic order: first appearance in connections, then pins.
  const order: string[] = [];
  const seen = new Set<string>();
  const addComp = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  };
  for (const c of conns) {
    addComp(c.from.componentArtifactId);
    addComp(c.to.componentArtifactId);
  }
  for (const p of payload.pins ?? []) addComp(p.componentArtifactId);

  if (order.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="20" y="34" fill="${TEXT}" font-family="monospace" font-size="12">no connections</text></svg>`;
  }

  const xOf = new Map<string, number>();
  order.forEach((id, i) => xOf.set(id, MARGIN_X + i * (BOX_W + GAP)));

  // Assign port slots per box side: right = outgoing 'from', left = incoming 'to'.
  // For self-connections both ends live on the right side.
  const rightPorts = new Map<string, { y: number; conn: WiringConnection; pin: string }[]>();
  const leftPorts = new Map<string, { y: number; conn: WiringConnection; pin: string }[]>();
  const push = (
    m: Map<string, { y: number; conn: WiringConnection; pin: string }[]>,
    id: string,
    conn: WiringConnection,
    pin: string,
  ) => {
    const l = m.get(id) ?? [];
    l.push({ y: 0, conn, pin });
    m.set(id, l);
  };
  for (const c of conns) {
    const sameBox = c.from.componentArtifactId === c.to.componentArtifactId;
    const reverse =
      !sameBox && xOf.get(c.from.componentArtifactId)! > xOf.get(c.to.componentArtifactId)!;
    if (sameBox) {
      // Both ends of a self-connection live on the right side of the box.
      push(rightPorts, c.from.componentArtifactId, c, c.from.pin);
      push(rightPorts, c.from.componentArtifactId, c, c.to.pin);
    } else {
      push(
        rightPorts,
        reverse ? c.to.componentArtifactId : c.from.componentArtifactId,
        c,
        reverse ? c.to.pin : c.from.pin,
      );
      push(
        leftPorts,
        reverse ? c.from.componentArtifactId : c.to.componentArtifactId,
        c,
        reverse ? c.from.pin : c.to.pin,
      );
    }
  }

  const boxH = new Map<string, number>();
  for (const id of order) {
    const n = Math.max(rightPorts.get(id)?.length ?? 0, leftPorts.get(id)?.length ?? 0);
    boxH.set(id, Math.max(MIN_BOX_H, PORT_TOP + n * PORT_H + 12));
  }
  // Assign port Y positions.
  for (const id of order) {
    rightPorts.get(id)?.forEach((p, i) => (p.y = BOX_TOP + PORT_TOP + i * PORT_H));
    leftPorts.get(id)?.forEach((p, i) => (p.y = BOX_TOP + PORT_TOP + i * PORT_H));
  }

  const maxH = Math.max(...[...boxH.values()]);
  const height = BOX_TOP + maxH + 60;
  const width = MARGIN_X * 2 + order.length * BOX_W + (order.length - 1) * GAP;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="monospace" font-size="11">`,
  );

  // Boxes.
  for (const id of order) {
    const x = xOf.get(id)!;
    const h = boxH.get(id)!;
    const title = resolveTitle(id)?.title ?? `${id.slice(0, 8)}…`;
    parts.push(
      `<rect x="${x}" y="${BOX_TOP}" width="${BOX_W}" height="${h}" fill="none" stroke="${STROKE}" stroke-width="1.2" rx="4"/>`,
    );
    parts.push(
      `<text x="${x + BOX_W / 2}" y="${BOX_TOP + 17}" fill="${TEXT}" text-anchor="middle">${escXml(title)}</text>`,
    );
    for (const p of rightPorts.get(id) ?? []) {
      parts.push(`<circle cx="${x + BOX_W}" cy="${p.y}" r="2.5" fill="${STROKE}"/>`);
      parts.push(
        `<text x="${x + BOX_W - 8}" y="${p.y - 5}" fill="${TEXT}" text-anchor="end">${escXml(p.pin)}</text>`,
      );
    }
    for (const p of leftPorts.get(id) ?? []) {
      parts.push(`<circle cx="${x}" cy="${p.y}" r="2.5" fill="${STROKE}"/>`);
      parts.push(`<text x="${x + 8}" y="${p.y - 5}" fill="${TEXT}">${escXml(p.pin)}</text>`);
    }
  }

  // Connection lines.
  for (const c of conns) {
    const sameBox = c.from.componentArtifactId === c.to.componentArtifactId;
    const reverse =
      !sameBox && xOf.get(c.from.componentArtifactId)! > xOf.get(c.to.componentArtifactId)!;
    const fromId = reverse ? c.to.componentArtifactId : c.from.componentArtifactId;
    const toId = reverse ? c.from.componentArtifactId : c.to.componentArtifactId;
    const fromPin = reverse ? c.to.pin : c.from.pin;
    const toPin = reverse ? c.from.pin : c.to.pin;
    const fp = rightPorts.get(fromId)?.find((p) => p.conn === c && p.pin === fromPin);
    const lp = leftPorts.get(toId)?.find((p) => p.conn === c && p.pin === toPin);
    const label = `${c.signalRole}${c.voltage ? ` ${c.voltage.value}${c.voltage.unit}` : ''}`;

    if (sameBox) {
      const x = xOf.get(fromId)! + BOX_W;
      const ps = (rightPorts.get(fromId) ?? []).filter((p) => p.conn === c);
      const y1 = ps[0]?.y ?? BOX_TOP + PORT_TOP;
      const y2 = ps[1]?.y ?? y1 + PORT_H;
      const r = 26;
      parts.push(
        `<path d="M ${x} ${y1} C ${x + r} ${y1}, ${x + r} ${y2}, ${x} ${y2}" fill="none" stroke="${STROKE}" stroke-width="1.2"/>`,
      );
      parts.push(
        `<text x="${x + r + 4}" y="${(y1 + y2) / 2 + 4}" fill="${TEXT}">${escXml(label)}</text>`,
      );
      continue;
    }
    if (!fp || !lp) continue;
    const x1 = xOf.get(fromId)! + BOX_W;
    const y1 = fp.y;
    const x2 = xOf.get(toId)!;
    const y2 = lp.y;
    const midX = (x1 + x2) / 2;
    parts.push(
      `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="${STROKE}" stroke-width="1.2"/>`,
    );
    parts.push(
      `<text x="${midX}" y="${(y1 + y2) / 2 - 4}" fill="${TEXT}" text-anchor="middle">${escXml(label)}</text>`,
    );
  }

  parts.push('</svg>');
  return parts.join('');
}
