import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowBendDownLeft,
  ChatCircleText,
  ClockCounterClockwise,
  Export,
  Archive,
  FolderOpen,
  GearSix,
  GitBranch,
  Graph,
  MoonStars,
  Package,
  Palette,
  Files,
  TerminalWindow,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import { openProposals, useStore } from '../store';
import { Kbd, State, TypeGlyph, typeMeta } from '../ui/kit';
import { exportProject, openProjectAt, sendToAgent } from '../lib/actions';
import { errMsg } from '../api';

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: React.ReactNode;
  icon: React.ReactNode;
  keywords?: string;
  run: () => void;
}

/** Scores at or above this come from a contiguous substring match. */
const DIRECT = 500;

/** Subsequence match; earlier and contiguous matches score higher. 0 = no match. */
function score(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1;
  let ti = 0;
  let s = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    s += 10 + run * 5 - (found - ti);
    ti = found + 1;
  }
  return Math.max(1, s);
}

export function Omnibar() {
  const open = useStore((s) => s.omniOpen);
  const projectId = useStore((s) => s.projectId);
  const artifacts = useStore((s) => s.artifacts);
  const recentIds = useStore((s) => s.recentIds);
  const proposals = useStore((s) => s.proposals);
  const session = useStore((s) => s.session);
  const adapters = useStore((s) => s.adapters);
  const { set, go, focus, decide, toast } = useStore.getState();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const close = () => set({ omniOpen: false });

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
    }
  }, [open]);

  const live = session?.state === 'running';
  const agentName =
    adapters.find((a) => a.adapterId === session?.adapterId)?.label ??
    session?.adapterId ??
    'agent';

  const items = useMemo(() => {
    const query = q.trim();
    const all: Item[] = [];
    if (projectId) {
      const recent = recentIds
        .map((id) => artifacts.find((v) => v.artifact.id === id))
        .filter((v): v is NonNullable<typeof v> => !!v);
      const objects = (query ? artifacts : recent).map<Item>((v) => ({
        id: `o:${v.artifact.id}`,
        group: query ? 'Objects' : 'Recent',
        label: v.artifact.title,
        keywords: `${typeMeta(v.artifact.type).label} ${v.artifact.subsystem ?? ''}`,
        icon: <TypeGlyph type={v.artifact.type} size={15} />,
        hint:
          v.freshness !== 'current' ? (
            <State state={v.freshness} quiet />
          ) : (
            <span>{typeMeta(v.artifact.type).label}</span>
          ),
        run: () => focus(v.artifact.id),
      }));
      all.push(...objects);
      const pending = openProposals(proposals).length;
      all.push(
        {
          id: 'lens:flow',
          group: 'Go to',
          label: 'Project flow',
          icon: <Graph size={15} />,
          hint: <Kbd>⌘1</Kbd>,
          keywords: 'map graph overview system home',
          run: () => go({ level: 'project', lens: 'flow' }),
        },
        {
          id: 'decide',
          group: 'Go to',
          label: pending
            ? `Review ${pending} proposed ${pending === 1 ? 'change' : 'changes'}`
            : 'Decisions',
          icon: <GitBranch size={15} />,
          hint: <Kbd>⌘⇧D</Kbd>,
          keywords: 'review proposals approve queue',
          run: () => decide(null),
        },
        {
          id: 'lens:parts',
          group: 'Go to',
          label: 'Parts & bill of materials',
          icon: <Package size={15} />,
          hint: <Kbd>⌘2</Kbd>,
          keywords: 'bom components candidates compare cost mass',
          run: () => go({ level: 'project', lens: 'parts' }),
        },
        {
          id: 'lens:timeline',
          group: 'Go to',
          label: 'Timeline of decisions',
          icon: <ClockCounterClockwise size={15} />,
          hint: <Kbd>⌘3</Kbd>,
          keywords: 'history log changes',
          run: () => go({ level: 'project', lens: 'timeline' }),
        },
        {
          id: 'lens:files',
          group: 'Go to',
          label: 'Files',
          icon: <Files size={15} />,
          hint: <Kbd>⌘4</Kbd>,
          keywords: 'source exports',
          run: () => go({ level: 'project', lens: 'files' }),
        },
        {
          id: 'agent',
          group: 'Actions',
          label: 'Show agent terminal',
          icon: <TerminalWindow size={15} />,
          hint: <Kbd>⌘J</Kbd>,
          keywords: 'codex claude console',
          run: () => {
            set({ consoleOpen: true });
            window.dispatchEvent(new CustomEvent('omenflow:focus-terminal'));
          },
        },
        {
          id: 'export-build',
          group: 'Actions',
          label: 'Export build package…',
          icon: <Export size={15} />,
          run: () => void exportProject('build'),
        },
        {
          id: 'export-archive',
          group: 'Actions',
          label: 'Export project archive…',
          icon: <Archive size={15} />,
          run: () => void exportProject('archive'),
        },
      );
    }
    all.push(
      {
        id: 'open',
        group: 'Actions',
        label: 'Open a project folder…',
        icon: <FolderOpen size={15} />,
        run: () => void openProjectAt().catch((e) => toast('error', errMsg(e))),
      },
      {
        id: 'theme',
        group: 'Actions',
        label: 'Switch light / dark',
        icon: <MoonStars size={15} />,
        keywords: 'appearance theme',
        run: () => set({ theme: useStore.getState().theme === 'dark' ? 'light' : 'dark' }),
      },
      {
        id: 'settings',
        group: 'Actions',
        label: 'Settings — agents, tools, appearance',
        icon: <GearSix size={15} />,
        hint: <Kbd>⌘,</Kbd>,
        keywords: 'connections openscad preferences',
        run: () => set({ settingsOpen: true }),
      },
      {
        id: 'system',
        group: 'Actions',
        label: 'Design system',
        icon: <Palette size={15} />,
        keywords: 'components tokens catalog',
        run: () => go({ level: 'system' }),
      },
    );
    const matched = all
      .map((item) => ({ item, s: score(`${item.label} ${item.keywords ?? ''}`, query) }))
      .filter((x) => x.s > 0);
    const floor = matched.some((x) => x.s >= DIRECT) ? DIRECT : 1;
    const scored = matched.filter((x) => x.s >= floor).sort((a, b) => (query ? b.s - a.s : 0));
    const groupOrder = [...new Set(scored.map((x) => x.item.group))];
    const ranked = groupOrder
      .flatMap((g) => scored.filter((x) => x.item.group === g).map((x) => x.item))
      .slice(0, 40);
    if (projectId && query && live) {
      const ask: Item = {
        id: 'ask',
        group: 'Agent',
        label: `Ask ${agentName}: “${query}”`,
        icon: <ChatCircleText size={15} />,
        hint: <span>Types into the terminal</span>,
        run: () =>
          void sendToAgent(query)
            .then(() => set({ consoleOpen: true }))
            .catch((e) => toast('error', errMsg(e))),
      };
      const sentence = query.split(/\s+/).length >= 3;
      if (sentence || !ranked.length) ranked.unshift(ask);
      else ranked.push(ask);
    }
    return ranked;
  }, [
    q,
    projectId,
    artifacts,
    recentIds,
    proposals,
    live,
    agentName,
    set,
    go,
    focus,
    decide,
    toast,
  ]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  let lastGroup = '';
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="omnibar" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Go to, run, or ask</Dialog.Title>
          <div className="omni-input">
            <MagnifyingGlass size={17} />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls="omni-results"
              aria-activedescendant={items[idx] ? `omni-${idx}` : undefined}
              aria-label="Go to an object, run an action, or ask the agent"
              placeholder={
                projectId
                  ? live
                    ? 'Go to an object, run an action, or ask the agent…'
                    : 'Go to an object or run an action…'
                  : 'Search actions…'
              }
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setIdx((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setIdx((i) => Math.max(i - 1, 0));
                }
                if (e.key === 'Enter' && items[idx]) {
                  e.preventDefault();
                  items[idx]!.run();
                  close();
                }
              }}
            />
            <Kbd>esc</Kbd>
          </div>
          <div
            className="omni-list"
            ref={list}
            id="omni-results"
            role="listbox"
            aria-label="Results"
          >
            {items.map((item, i) => {
              const header = item.group !== lastGroup ? item.group : null;
              lastGroup = item.group;
              return (
                <React.Fragment key={item.id}>
                  {header && <div className="omni-group">{header}</div>}
                  <div
                    role="option"
                    id={`omni-${i}`}
                    aria-selected={i === idx}
                    data-index={i}
                    className={`omni-item ${i === idx ? 'active' : ''}`}
                    onMouseMove={() => setIdx(i)}
                    onClick={() => {
                      item.run();
                      close();
                    }}
                  >
                    <span className="omni-icon">{item.icon}</span>
                    <span className="grow truncate">{item.label}</span>
                    <span className="omni-hint">{item.hint}</span>
                    {i === idx && <ArrowBendDownLeft size={13} className="omni-enter" />}
                  </div>
                </React.Fragment>
              );
            })}
            {!items.length && <div className="omni-empty">Nothing matches “{q}”.</div>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
