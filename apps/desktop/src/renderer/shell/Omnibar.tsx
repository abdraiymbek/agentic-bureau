import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  AppWindow,
  Archive,
  ArrowBendDownLeft,
  ArrowClockwise,
  At,
  ChatCircleText,
  Copy,
  Export,
  FolderOpen,
  FolderSimple,
  GearSix,
  GitBranch,
  Globe,
  HandPalm,
  MagnifyingGlass,
  MoonStars,
  Palette,
  Play,
  Robot,
  SignOut,
  StopCircle,
  Sun,
} from '@phosphor-icons/react';
import { openProposals, useStore } from '../store';
import { needsYou } from '../lib/proposals';
import { LENSES } from '../project/lenses';
import { Button, Kbd, TypeGlyph, stateLabel, typeMeta } from '../ui/kit';
import {
  askAgent,
  closeProject,
  exportProject,
  flushAsks,
  interruptAgent,
  openProjectAt,
  restartAgent,
  showAgent,
  startAgent,
  stopAgent,
} from '../lib/actions';
import { errMsg } from '../api';
import { useAgentUi, type SettingsSection } from './agent/agent-store';
import { copyText } from './agent/clipboard';
import { detectAgents } from './agent/feed';
import { adapterLabel, sessionStatus } from './agent/session-view';
import {
  ASK_PREFIX,
  moveSelection,
  parseQuery,
  rank,
  scoreCandidate,
  type Candidate,
} from './omnibar/rank';
import { useContentSearch } from './omnibar/useContentSearch';
import { contentExcerpt } from './omnibar/content';

interface Action {
  id: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

interface Item extends Candidate {
  icon: React.ReactNode;
  /** Right-hand context: shortcut, type and state. */
  hint?: React.ReactNode;
  run: () => void;
  /** Irreversible: the first Return arms it and shows this label, the second runs it. */
  confirm?: string;
  /** Secondary actions on the row, reached with Tab. The first is `run`. */
  actions?: Action[];
  /** Remembered as a recent command. */
  command?: boolean;
  snippet?: string;
}

const RECENT_KEY = 'omen.omni.recent';
const RECENT_LIMIT = 5;

function readRecentCommands(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function rememberCommand(id: string) {
  try {
    const next = [id, ...readRecentCommands().filter((x) => x !== id)].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* recents are a convenience */
  }
}

function report(action: Promise<unknown>) {
  void action.catch((e) => useStore.getState().toast('error', errMsg(e)));
}

function openSettings(section: SettingsSection) {
  useAgentUi.getState().setSettingsSection(section);
  useStore.getState().set({ settingsOpen: true });
}

/** ⌘K: go to an object, run any action, or — explicitly — ask the agent. */
export function Omnibar() {
  const open = useStore((s) => s.omniOpen);
  const set = useStore((s) => s.set);
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && set({ omniOpen: false })}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay motion-fade" />
        <Dialog.Content className="omnibar motion-rise" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Go to, run, or ask</Dialog.Title>
          {open && <OmniBody />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function useItems(text: string) {
  const projectId = useStore((s) => s.projectId);
  const projectPath = useStore((s) => s.projectPath);
  const readOnly = useStore((s) => s.readOnly);
  const artifacts = useStore((s) => s.artifacts);
  const recentIds = useStore((s) => s.recentIds);
  const proposals = useStore((s) => s.proposals);
  const session = useStore((s) => s.session);
  const adapters = useStore((s) => s.adapters);
  const agentId = useStore((s) => s.agentId);
  const view = useStore((s) => s.view);
  const windowOpen = useStore((s) => s.agentWindowOpen);
  const theme = useStore((s) => s.theme);
  const pendingAsks = useAgentUi((s) => s.pending.length);

  return useMemo(() => {
    const { set, go, focus, decide } = useStore.getState();
    const status = sessionStatus(session);
    const agentName = session
      ? adapterLabel(adapters, session.adapterId)
      : (adapters.find((a) => a.adapterId === agentId)?.label ?? 'the agent');
    const items: Item[] = [];
    const recentCommands = readRecentCommands();
    const commandRank = (id: string) => {
      const i = recentCommands.indexOf(id);
      return i >= 0 ? i : undefined;
    };

    if (projectId) {
      const recentRank = new Map(recentIds.map((id, i) => [id, i]));
      for (const v of artifacts) {
        if (v.artifact.archived) continue;
        const meta = typeMeta(v.artifact.type);
        const review = v.revision ? stateLabel(v.revision.reviewState) : 'No baseline';
        const fresh = v.freshness === 'current' ? null : stateLabel(v.freshness);
        const state = fresh ?? review;
        const id = v.artifact.id;
        const reference = `About the Omen Flow ${meta.label.toLowerCase()} "${v.artifact.title}" (artifact ${id}${v.revision ? `, revision ${v.revision.seq}` : ''}): `;
        items.push({
          id: `o:${id}`,
          group: 'objects',
          label: v.artifact.title,
          keywords: [
            meta.label,
            v.artifact.subsystem ?? '',
            review,
            fresh ?? '',
            v.freshness === 'stale' ? 'stale outdated changed' : '',
            v.pendingProposal ? 'in review proposal pending' : '',
            id,
          ].join(' '),
          recent: recentRank.get(id),
          icon: <TypeGlyph type={v.artifact.type} size={15} />,
          hint: (
            <span className="omni-object-meta">
              <span>{meta.label}</span>
              <span className={fresh ? 'tone-warn' : undefined}>{state}</span>
              {v.artifact.subsystem && <span>{v.artifact.subsystem}</span>}
            </span>
          ),
          run: () => focus(id),
          actions: [
            { id: 'open', label: 'Open', shortcut: '↵', run: () => focus(id) },
            ...(readOnly
              ? []
              : [
                  {
                    id: 'ask',
                    label: 'Ask agent about',
                    shortcut: '⌘↵',
                    run: () => void askAgent(reference),
                  },
                ]),
            {
              id: 'copy',
              label: 'Copy id',
              run: () =>
                void copyText(id).then((ok) =>
                  useStore
                    .getState()
                    .toast(
                      ok ? 'ok' : 'error',
                      ok ? 'Object id copied' : 'The clipboard did not accept the id.',
                    ),
                ),
            },
          ],
        });
      }
      for (const id of recentIds) {
        const v = artifacts.find((x) => x.artifact.id === id);
        if (!v || v.artifact.archived) continue;
        const object = items.find((i) => i.id === `o:${id}`)!;
        items.push({ ...object, id: `r:o:${id}`, group: 'recent' });
      }

      for (const p of openProposals(proposals))
        items.push({
          id: `p:${p.id}`,
          group: 'decisions',
          label: `Review: ${p.reason}`,
          keywords: `proposal decision ${stateLabel(p.state)} ${p.id}`,
          icon: <GitBranch size={15} />,
          hint: <span>{stateLabel(p.state)}</span>,
          run: () => decide(p.id),
        });

      const pending = needsYou(proposals).length;
      items.push(
        {
          id: 'goto:agent',
          group: 'goto',
          label: 'Agent',
          keywords: 'terminal cli codex claude session',
          icon: <Robot size={15} />,
          command: true,
          run: () => go({ level: 'agent' }),
        },
        ...LENSES.map<Item>((l) => ({
          id: `goto:${l.id}`,
          group: 'goto',
          label: l.description,
          keywords: `${l.label} ${l.keywords ?? ''}`,
          icon: <l.icon size={15} />,
          hint: <Kbd>{`⌘${l.shortcut}`}</Kbd>,
          command: true,
          run: () => go({ level: 'project', lens: l.id }),
        })),
        {
          id: 'goto:decide',
          group: 'goto',
          label: pending
            ? `Review ${pending} proposed ${pending === 1 ? 'change' : 'changes'}`
            : 'Decisions',
          keywords: 'decisions review proposals approve queue',
          icon: <GitBranch size={15} />,
          hint: <Kbd>⌘⇧D</Kbd>,
          command: true,
          run: () => decide(null),
        },
      );

      if (!readOnly) {
        if (status.live) {
          items.push(
            {
              id: 'agent:interrupt',
              group: 'agent',
              label: `Interrupt ${agentName}`,
              keywords: 'agent cancel ctrl-c stop current',
              icon: <HandPalm size={15} />,
              command: true,
              run: () => report(interruptAgent()),
            },
            {
              id: 'agent:restart',
              group: 'agent',
              label: 'Restart the agent session',
              keywords: 'agent new session conversation',
              icon: <ArrowClockwise size={15} />,
              confirm: 'Press Return again to restart the session',
              command: true,
              run: () => report(restartAgent()),
            },
            {
              id: 'agent:stop',
              group: 'agent',
              label: 'Stop the agent session',
              keywords: 'agent end quit kill',
              icon: <StopCircle size={15} />,
              confirm: 'Press Return again to stop the session',
              command: true,
              run: () => report(stopAgent()),
            },
          );
        } else {
          for (const a of adapters.filter((x) => x.available))
            items.push({
              id: `agent:start:${a.adapterId}`,
              group: 'agent',
              label: `Start ${a.label}`,
              keywords: 'agent run launch session',
              icon: <Play size={15} />,
              command: true,
              run: () => {
                useStore.getState().setAgent(a.adapterId);
                showAgent();
                report(startAgent(a.adapterId));
              },
            });
        }
        if (pendingAsks && status.live)
          items.push({
            id: 'agent:paste',
            group: 'agent',
            label: 'Paste the waiting request into the terminal',
            keywords: 'agent queue pending ask',
            icon: <ChatCircleText size={15} />,
            run: () => {
              showAgent();
              flushAsks(true);
            },
          });
      }
      if (view.level !== 'agent')
        items.push({
          id: 'agent:window',
          group: 'agent',
          label: windowOpen ? 'Hide the agent window' : 'Show the agent window',
          keywords: 'agent terminal console floating',
          icon: <AppWindow size={15} />,
          hint: <Kbd>⌘J</Kbd>,
          command: true,
          run: () => set({ agentWindowOpen: !windowOpen }),
        });
      items.push({
        id: 'agent:detect',
        group: 'agent',
        label: 'Detect agent CLIs again',
        keywords: 'agent install codex claude find',
        icon: <ArrowClockwise size={15} />,
        command: true,
        run: () => void detectAgents(),
      });

      items.push(
        {
          id: 'act:export-build',
          group: 'actions',
          label: 'Export build package…',
          keywords: 'zip deliver',
          icon: <Export size={15} />,
          command: true,
          run: () => void exportProject('build'),
        },
        {
          id: 'act:export-archive',
          group: 'actions',
          label: 'Export project archive…',
          keywords: 'zip backup share',
          icon: <Archive size={15} />,
          command: true,
          run: () => void exportProject('archive'),
        },
        {
          id: 'act:reveal',
          group: 'actions',
          label: 'Reveal project folder',
          keywords: 'finder files directory show',
          icon: <FolderSimple size={15} />,
          command: true,
          run: () => {
            if (projectPath) report(window.omenflow.revealPath(projectPath));
          },
        },
        {
          id: 'act:research',
          group: 'actions',
          label: 'Research browser',
          keywords: 'web sources browse',
          icon: <Globe size={15} />,
          command: true,
          run: () => report(window.omenflow.toggleResearch()),
        },
        {
          id: 'act:close',
          group: 'actions',
          label: 'Close project',
          keywords: 'leave launcher',
          icon: <SignOut size={15} />,
          command: true,
          run: () => report(closeProject()),
        },
      );
    }

    items.push(
      {
        id: 'act:open',
        group: 'actions',
        label: 'Open a project folder…',
        keywords: 'project load',
        icon: <FolderOpen size={15} />,
        command: true,
        run: () => report(openProjectAt()),
      },
      {
        id: 'act:theme',
        group: 'actions',
        label: theme === 'dark' ? 'Switch to Paper (light)' : 'Switch to Graphite (dark)',
        keywords: 'appearance theme light dark mode',
        icon: theme === 'dark' ? <Sun size={15} /> : <MoonStars size={15} />,
        command: true,
        run: () => set({ theme: theme === 'dark' ? 'light' : 'dark' }),
      },
      {
        id: 'act:settings-agents',
        group: 'actions',
        label: 'Settings: Agents',
        keywords: 'preferences model profile connection codex claude',
        icon: <GearSix size={15} />,
        hint: <Kbd>⌘,</Kbd>,
        command: true,
        run: () => openSettings('agents'),
      },
      {
        id: 'act:settings-tools',
        group: 'actions',
        label: 'Settings: Engineering tools',
        keywords: 'preferences openscad cad path',
        icon: <GearSix size={15} />,
        command: true,
        run: () => openSettings('tools'),
      },
      {
        id: 'act:settings-appearance',
        group: 'actions',
        label: 'Settings: Appearance',
        keywords: 'preferences theme',
        icon: <GearSix size={15} />,
        command: true,
        run: () => openSettings('appearance'),
      },
      {
        id: 'act:system',
        group: 'actions',
        label: 'Design system',
        keywords: 'components tokens catalogue',
        icon: <Palette size={15} />,
        command: true,
        run: () => go({ level: 'system' }),
      },
    );

    for (const item of items)
      if (item.command) {
        const r = commandRank(item.id);
        if (r !== undefined) item.recent = r;
      }
    if (!text.trim())
      for (const id of recentCommands) {
        const item = items.find((i) => i.id === id);
        if (item) items.push({ ...item, id: `r:${id}`, group: 'recent' });
      }

    const askText = text.trim().startsWith(ASK_PREFIX)
      ? text.trim().slice(ASK_PREFIX.length).trim()
      : text.trim();
    const ask: Item | null =
      projectId && !readOnly && askText
        ? {
            id: 'ask',
            group: 'ask',
            label: `Ask ${agentName}: “${askText}”`,
            icon: <At size={15} />,
            hint: <span>Types into the terminal</span>,
            run: () => void askAgent(askText),
          }
        : null;
    return { items, ask, agentName };
  }, [
    text,
    projectId,
    projectPath,
    readOnly,
    artifacts,
    recentIds,
    proposals,
    session,
    adapters,
    agentId,
    view.level,
    windowOpen,
    theme,
    pendingAsks,
  ]);
}

interface Selection {
  /** The query the selection belongs to; a new query starts from the ranking's default. */
  q: string;
  idx: number;
  /** Which of the active row's actions Return runs. */
  action: number;
  /** Item whose confirmation is armed. */
  armed: string | null;
  itemId?: string;
}

function OmniBody() {
  const projectId = useStore((s) => s.projectId);
  const readOnly = useStore((s) => s.readOnly);
  const set = useStore((s) => s.set);
  const [q, setQ] = useState('');
  const { items, ask, agentName } = useItems(q);
  const { state: content, retry: retryContent } = useContentSearch(projectId, q);
  const combined = useMemo(() => {
    if (content.status !== 'ready') return items;
    const next = [...items];
    const query = parseQuery(q);
    for (const hit of content.value.results) {
      const index = next.findIndex((item) => item.id === `o:${hit.artifactId}`);
      const existing = index >= 0 ? next[index] : undefined;
      const open = () =>
        useStore.getState().go({
          level: 'object',
          id: hit.artifactId,
          revisionId: hit.revisionId,
        });
      const localMatch = existing && scoreCandidate(existing, query) > 0;
      const reference = `About the Omen Flow ${typeMeta(hit.type).label.toLowerCase()} "${hit.title}" (artifact ${hit.artifactId}, revision ${hit.revisionId}): `;
      const match: Item = {
        ...(localMatch ? existing : {}),
        id: localMatch ? existing.id : `c:${hit.artifactId}:${hit.revisionId}`,
        group: localMatch ? 'objects' : 'content',
        label: hit.title,
        icon: <TypeGlyph type={hit.type} size={15} />,
        contentQuery: query.text,
        snippet: contentExcerpt(hit.snippet),
        hint: (
          <span>
            {typeMeta(hit.type).label} · Matched{' '}
            {hit.reviewState ? stateLabel(hit.reviewState) : 'revision'}
          </span>
        ),
        run: open,
        actions: [
          { id: 'open', label: 'Open', shortcut: '↵', run: open },
          ...(readOnly
            ? []
            : [
                {
                  id: 'ask',
                  label: 'Ask agent about',
                  shortcut: '⌘↵',
                  run: () => void askAgent(reference),
                },
              ]),
          ...(existing?.actions?.filter((action) => action.id === 'copy') ?? []),
        ],
      };
      if (localMatch) next[index] = match;
      else next.push(match);
    }
    return next;
  }, [items, content, q, readOnly]);
  const ranking = useMemo(() => rank(combined, q, ask), [combined, q, ask]);
  const [sel, setSel] = useState<Selection>({ q: '', idx: -1, action: 0, armed: null });
  const list = useRef<HTMLDivElement>(null);
  const close = () => set({ omniOpen: false });

  const flat = ranking.flat;
  const selectedIndex = sel.itemId ? flat.findIndex((item) => item.id === sel.itemId) : sel.idx;
  const current =
    sel.q === q && selectedIndex < flat.length
      ? { ...sel, idx: selectedIndex }
      : { q, idx: ranking.initial, action: 0, armed: null };
  const { idx, action, armed } = current;
  const active = idx >= 0 ? flat[idx] : undefined;

  useEffect(() => {
    list.current?.querySelector(`[data-index="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const select = (next: number) =>
    setSel({ q, idx: next, itemId: flat[next]?.id, action: 0, armed: null });
  const setAction = (next: number) => setSel({ ...current, itemId: active?.id, action: next });

  const run = (item: Item, which = 0) => {
    if (item.confirm && which === 0 && armed !== item.id) {
      setSel({ ...current, itemId: item.id, armed: item.id });
      return;
    }
    const chosen = item.actions?.[which];
    if (item.command) rememberCommand(item.id.replace(/^r:/, ''));
    close();
    (chosen?.run ?? item.run)();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const handled = () => {
      e.preventDefault();
      // The omnibar's keys never reach the views behind it.
      e.stopPropagation();
    };
    const move = (delta: number) => select(moveSelection(idx, flat.length, delta));
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      handled();
      move(1);
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      handled();
      move(-1);
    } else if (e.key === 'PageDown') {
      handled();
      select(Math.min(flat.length - 1, Math.max(0, idx) + 6));
    } else if (e.key === 'PageUp') {
      handled();
      select(Math.max(0, idx - 6));
    } else if (e.key === 'Tab') {
      handled();
      const count = active?.actions?.length ?? 0;
      if (count > 1) setAction((action + (e.shiftKey ? count - 1 : 1)) % count);
    } else if (e.key === 'Enter') {
      handled();
      if (!active) return;
      if (e.metaKey || e.ctrlKey) {
        const askIndex = active.actions?.findIndex((a) => a.id === 'ask') ?? -1;
        if (askIndex >= 0) run(active, askIndex);
        return;
      }
      run(active, action);
    }
  };

  let index = -1;
  return (
    <>
      <div className="omni-input">
        <MagnifyingGlass size={17} />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="omni-results"
          aria-autocomplete="list"
          aria-activedescendant={active ? `omni-${idx}` : undefined}
          aria-label="Go to an object, run an action, or ask the agent"
          placeholder={
            projectId
              ? `Go to an object or run an action · ${ASK_PREFIX} to ask ${agentName}`
              : 'Search actions…'
          }
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <Kbd>esc</Kbd>
      </div>
      <div className="omni-list" ref={list} id="omni-results" role="listbox" aria-label="Results">
        {ranking.groups.map((g) => (
          <div key={g.id} role="group" aria-labelledby={`omni-group-${g.id}`}>
            <div className="omni-group" id={`omni-group-${g.id}`} role="presentation">
              {g.label}
            </div>
            {g.items.map((item) => {
              index++;
              const i = index;
              const isActive = i === idx;
              const isArmed = armed === item.id;
              return (
                <div
                  key={item.id}
                  role="option"
                  id={`omni-${i}`}
                  aria-selected={isActive}
                  data-index={i}
                  className={`omni-item ${isActive ? 'active' : ''} ${item.group === 'ask' ? 'ask' : ''} ${isArmed ? 'armed' : ''} ${item.snippet ? 'has-snippet' : ''}`}
                  onMouseMove={() => i !== idx && select(i)}
                  onClick={() => run(item, isActive ? action : 0)}
                >
                  <span className="omni-icon">{item.icon}</span>
                  <span className="omni-label truncate">
                    <span className="truncate">{isArmed ? item.confirm : item.label}</span>
                    {item.snippet && <span className="omni-snippet">{item.snippet}</span>}
                  </span>
                  <span className="omni-hint">{item.hint}</span>
                  {isActive && item.actions && item.actions.length > 1 && (
                    <span className="omni-actions" aria-label="Actions (Tab to choose)">
                      {item.actions.map((a, n) => (
                        <button
                          key={a.id}
                          type="button"
                          tabIndex={-1}
                          className={`omni-action ${n === action ? 'current' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            run(item, n);
                          }}
                        >
                          {a.id === 'ask' ? (
                            <ChatCircleText size={12} />
                          ) : a.id === 'copy' ? (
                            <Copy size={12} />
                          ) : null}
                          {a.label}
                          {a.shortcut && n !== action && <Kbd>{a.shortcut}</Kbd>}
                        </button>
                      ))}
                    </span>
                  )}
                  {isActive && <ArrowBendDownLeft size={13} className="omni-enter" />}
                </div>
              );
            })}
            {g.more > 0 && (
              <div className="omni-more" role="presentation">
                {g.more} more — refine your search
              </div>
            )}
          </div>
        ))}
        {content.status === 'loading' && (
          <div className="omni-more" role="status">
            Searching project content…
          </div>
        )}
        {content.status === 'error' && (
          <div className="omni-more" role="status">
            Project content search failed: {content.message}{' '}
            <Button size="sm" variant="ghost" onClick={retryContent}>
              Try again
            </Button>
          </div>
        )}
        {content.status === 'ready' && content.value.matched === 'any_term' && (
          <div className="omni-more">Content results match some of the search words.</div>
        )}
        {!flat.some((i) => i.group !== 'ask') && q.trim() && !q.trim().startsWith(ASK_PREFIX) && (
          <div className="omni-empty" role="status">
            {content.status === 'loading'
              ? 'No title or action matches yet.'
              : `Nothing matches “${q.trim()}”.`}
            {ask && (
              <span>
                {' '}
                Press ↓ to choose “Ask”, or start with {ASK_PREFIX} to ask {agentName} directly.
              </span>
            )}
          </div>
        )}
        {q.trim().startsWith(ASK_PREFIX) && !ask && (
          <div className="omni-empty" role="status">
            {projectId
              ? readOnly
                ? 'This project is read-only, so there is no agent to ask.'
                : `Type what to ask ${agentName} after ${ASK_PREFIX}.`
              : 'Open a project to ask an agent.'}
          </div>
        )}
      </div>
    </>
  );
}
