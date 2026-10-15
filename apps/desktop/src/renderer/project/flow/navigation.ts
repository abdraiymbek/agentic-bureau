import type { FlowLayout } from './layout';

/**
 * Keyboard movement over the map. Left and right follow recorded links upstream and downstream;
 * up and down move within a column; first and last jump to the ends of a column.
 */
export type Move = 'left' | 'right' | 'up' | 'down' | 'first' | 'last';

export interface NavModel {
  /** Node ids per column, top to bottom. */
  columns: string[][];
  place: Map<string, { col: number; row: number; centre: number }>;
  upstream: Map<string, string[]>;
  downstream: Map<string, string[]>;
}

export function navModel(layout: FlowLayout): NavModel {
  const place = new Map<string, { col: number; row: number; centre: number }>();
  const columns = layout.columns.map((column, col) => {
    column.nodes.forEach((id, row) => {
      const node = layout.byId.get(id)!;
      place.set(id, { col, row, centre: node.y + node.h / 2 });
    });
    return column.nodes;
  });
  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();
  for (const edge of layout.edges) {
    upstream.set(edge.to, [...(upstream.get(edge.to) ?? []), edge.from]);
    downstream.set(edge.from, [...(downstream.get(edge.from) ?? []), edge.to]);
  }
  return { columns, place, upstream, downstream };
}

/** The candidate closest in height to `centre`; ties go to the higher one, then to the lower id. */
function nearest(model: NavModel, candidates: string[], centre: number): string | null {
  let best: string | null = null;
  let bestKey: [number, number, string] | null = null;
  for (const id of candidates) {
    const at = model.place.get(id);
    if (!at) continue;
    const key: [number, number, string] = [Math.abs(at.centre - centre), at.centre, id];
    if (
      !bestKey ||
      key[0] < bestKey[0] ||
      (key[0] === bestKey[0] &&
        (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))
    ) {
      best = id;
      bestKey = key;
    }
  }
  return best;
}

/**
 * Where focus goes from `current`, or null when there is nowhere to go that way.
 *
 * Left and right prefer `cameFrom` when it is linked in that direction, so stepping along a link
 * and back returns to the same object. An object with no link in a direction steps to the
 * nearest object in the neighbouring column instead, so no part of the map is out of reach.
 */
export function nextFocus(
  model: NavModel,
  current: string,
  move: Move,
  cameFrom: string | null = null,
): string | null {
  const at = model.place.get(current);
  if (!at) return null;
  const column = model.columns[at.col]!;
  switch (move) {
    case 'up':
      return column[at.row - 1] ?? null;
    case 'down':
      return column[at.row + 1] ?? null;
    case 'first':
      return at.row === 0 ? null : column[0]!;
    case 'last':
      return at.row === column.length - 1 ? null : column[column.length - 1]!;
    case 'left':
    case 'right': {
      const linked = (move === 'left' ? model.upstream : model.downstream).get(current) ?? [];
      if (cameFrom && linked.includes(cameFrom)) return cameFrom;
      const followed = nearest(model, linked, at.centre);
      if (followed) return followed;
      const neighbour = model.columns[at.col + (move === 'left' ? -1 : 1)];
      return neighbour ? nearest(model, neighbour, at.centre) : null;
    }
  }
}
