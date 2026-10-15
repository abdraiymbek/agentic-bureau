import type React from 'react';
import {
  ClockCounterClockwise,
  Files,
  Graph,
  Package,
  Target,
  type Icon,
} from '@phosphor-icons/react';

/** Projections of the whole project. */
export type Lens = 'flow' | 'parts' | 'timeline' | 'files' | 'evidence';

export interface LensDef {
  id: Lens;
  /** Short name: the activity-bar tab and its tooltip. */
  label: string;
  /** What the lens shows, as the omnibar lists it. */
  description: string;
  icon: Icon;
  /** The n in ⌘n. */
  shortcut: number;
  /** Extra words the omnibar matches. */
  keywords?: string;
  /** The lens body, rendered below the project identity. Loaded on first use. */
  load: () => Promise<{ default: React.ComponentType }>;
}

/**
 * Every lens the project level offers, in activity-bar order. A new lens is one entry here plus
 * its component; the activity bar, ⌘n, the omnibar, the preview and the catalogue read this list.
 * An id in `Lens` may not have an entry yet, so look one up with `lensDef` and handle undefined.
 */
export const LENSES: LensDef[] = [
  {
    id: 'flow',
    label: 'Flow',
    description: 'Project flow',
    icon: Graph,
    shortcut: 1,
    keywords: 'map graph overview system home',
    load: () => import('./FlowLens'),
  },
  {
    id: 'parts',
    label: 'Parts',
    description: 'Parts & bill of materials',
    icon: Package,
    shortcut: 2,
    keywords: 'bom components candidates compare cost mass',
    load: () => import('./PartsLens').then((m) => ({ default: m.PartsLens })),
  },
  {
    id: 'timeline',
    label: 'Timeline',
    description: 'Timeline of decisions',
    icon: ClockCounterClockwise,
    shortcut: 3,
    keywords: 'history log changes',
    load: () => import('./TimelineLens').then((m) => ({ default: m.TimelineLens })),
  },
  {
    id: 'files',
    label: 'Files',
    description: 'Files',
    icon: Files,
    shortcut: 4,
    keywords: 'source exports',
    load: () => import('./FilesLens').then((m) => ({ default: m.FilesLens })),
  },
  {
    id: 'evidence',
    label: 'Evidence',
    description: 'Evidence for each requirement',
    icon: Target,
    shortcut: 5,
    keywords: 'coverage traceability requirements verification tests calculations gaps',
    load: () => import('./EvidenceLens'),
  },
];

export function lensDef(id: string): LensDef | undefined {
  return LENSES.find((l) => l.id === id);
}
