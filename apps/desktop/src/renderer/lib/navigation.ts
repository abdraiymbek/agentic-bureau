/**
 * Moving between zoom levels, as pure functions over the view and its history. Back and
 * forward follow the path actually taken; zooming out goes up one level to where the person
 * came from, not always to the flow map.
 */
import type { Lens } from '../project/lenses';
import type { View } from '../store';

export const HISTORY_LIMIT = 40;

export function sameView(a: View, b: View): boolean {
  if (a.level !== b.level) return false;
  switch (a.level) {
    case 'project':
      return a.lens === (b as typeof a).lens;
    case 'object':
      return a.id === (b as typeof a).id && a.revisionId === (b as typeof a).revisionId;
    case 'decide':
      return a.proposalId === (b as typeof a).proposalId;
    default:
      return true;
  }
}

export interface History {
  back: View[];
  forward: View[];
}

/** Going somewhere new: the current view joins the back stack and the forward stack clears. */
export function pushHistory(history: History, current: View): History {
  return { back: [...history.back.slice(-(HISTORY_LIMIT - 1)), current], forward: [] };
}

export function stepBack(history: History, current: View): ({ view: View } & History) | null {
  const view = history.back[history.back.length - 1];
  if (!view) return null;
  return {
    view,
    back: history.back.slice(0, -1),
    forward: [current, ...history.forward].slice(0, HISTORY_LIMIT),
  };
}

export function stepForward(history: History, current: View): ({ view: View } & History) | null {
  const [view, ...forward] = history.forward;
  if (!view) return null;
  return { view, back: [...history.back.slice(-(HISTORY_LIMIT - 1)), current], forward };
}

/**
 * One level up from `view`, or null when there is nowhere higher.
 * - A decision returns to the object it was opened from, else to the project.
 * - An object returns to the lens it was opened from.
 * - Another lens returns to the flow map; the flow map is the top.
 * - The agent tab and the catalogue return to the last place in the workspace.
 */
export function zoomOutTarget(
  view: View,
  back: readonly View[],
  lastLens: Lens,
  hasProject: boolean,
): View | null {
  const project: View = { level: 'project', lens: lastLens };
  const previous = (accept: (v: View) => boolean) => [...back].reverse().find(accept);
  switch (view.level) {
    case 'decide': {
      const from = back[back.length - 1];
      return from?.level === 'object' ? from : project;
    }
    case 'object':
      return project;
    case 'project':
      return view.lens === 'flow' ? null : { level: 'project', lens: 'flow' };
    case 'agent':
      return previous((v) => v.level !== 'agent' && v.level !== 'system') ?? project;
    case 'system':
      return (
        previous((v) => v.level !== 'system' && (hasProject || v.level === 'project')) ?? {
          level: 'project',
          lens: 'flow',
        }
      );
  }
}
