/**
 * The Agent tab's conversation pane: one durable conversation with a headless Codex or Claude Code
 * run per turn, its text as it arrives, and the cards the run presented. The terminal pane beside
 * it runs the same CLIs interactively; a project runs one of them at a time.
 */
import React, { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUp,
  BookOpen,
  CaretDown,
  Check,
  ClockCounterClockwise,
  Copy,
  Cube,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Square,
} from '@phosphor-icons/react';
import type { AgentActivity, ChatTurn } from '@omenflow/contracts';
import { useStore } from '../store';
import { cmd, errMsg } from '../api';
import { stopAgent } from '../lib/actions';
import { useAgentUi } from '../shell/agent/agent-store';
import {
  Button,
  ConfirmButton,
  IconButton,
  Mark,
  Menu,
  Notice,
  Spinner,
  Time,
  TypeGlyph,
  typeMeta,
} from '../ui/kit';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { InlineCards, InputAttachment } from './InlineCards';
import { ContinuationMessage, NoToolCalls, WorkNotFinished } from './InlineGate';
import { RecordedCall } from './RecordedCall';
import { CompactContext } from './compact';
import { modelMismatch, turnModel } from './model';
import { useChat, type ProjectChat } from './chat-store';
const ResponseText = lazy(() =>
  import('./ResponseText').then((m) => ({ default: m.ResponseText })),
);

const starters = [
  {
    icon: <SlidersHorizontal size={19} />,
    title: 'Explore a direction',
    detail: 'Turn an idea into a useful brief',
    text: 'Help me shape the project intent into a practical engineering brief. Ask about constraints that are still unknown before drafting requirements.',
  },
  {
    icon: <Cube size={19} />,
    title: 'Shape a part',
    detail: 'Work from dimensions and constraints',
    text: 'Help me design a part for this project. First inspect the existing mechanical work and ask me for the dimensions and constraints you need.',
  },
  {
    icon: <ShieldCheck size={19} />,
    title: 'Check the evidence',
    detail: 'See what is known, and what is missing',
    text: 'Inspect this project’s requirements and evidence. Explain what is supported, what is unknown, and which test would reduce the most uncertainty.',
  },
];
function report(promise: Promise<unknown>) {
  void promise.catch((e) => useStore.getState().toast('error', errMsg(e)));
}

export function Conversation({
  projectId,
  state,
  compact = false,
}: {
  projectId: string;
  state?: ProjectChat;
  /** The floating window or the dock: one column, and 3D renders only on request. */
  compact?: boolean;
}) {
  const artifacts = useStore((s) => s.artifacts);
  const proposals = useStore((s) => s.proposals);
  const adapters = useStore((s) => s.adapters);
  const agentId = useStore((s) => s.agentId);
  const readOnly = useStore((s) => s.readOnly);
  const terminalLive = useStore((s) => s.session?.state === 'running');
  const recordOpen = useAgentUi((s) => s.recordOpen);
  const { setRecordOpen, setPane } = useAgentUi.getState();
  const openRecord = () => setRecordOpen(!useAgentUi.getState().recordOpen);
  const closeRecord = () => setRecordOpen(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const deliverySequence = useRef(0);
  const followOnDelivery = useRef<number | null>(null);
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [query, setQuery] = useState('');
  const historical = useRef<Set<string> | null>(null);
  const lastConversation = useRef(state?.activeId);
  if (lastConversation.current !== state?.activeId) {
    historical.current = null;
    lastConversation.current = state?.activeId;
  }
  if (state?.loaded && !historical.current)
    historical.current = new Set(
      state.record.conversations.flatMap((c) => c.turns.map((t) => t.requestId)),
    );
  const active = state?.record.conversations.find((c) => c.id === state.activeId);
  const turns = active?.turns ?? [];
  const draft = state?.drafts[state.activeId]?.text ?? '';
  const attempt = state?.pending[state.activeId];
  const sending = state?.sending[state.activeId] ?? false;
  const running =
    state?.record.conversations.some((c) => c.turns.some((t) => t.state === 'running')) ?? false;
  const activeRunning = turns.some((t) => t.state === 'running');
  const chosen =
    adapters.find((a) => a.adapterId === agentId) ??
    adapters.find((a) => ['codex', 'claude-code'].includes(a.adapterId) && a.available) ??
    adapters.find((a) => a.adapterId === 'codex');
  const adapter = chosen?.adapterId === 'claude-code' ? 'claude-code' : 'codex';
  const supported = !chosen || ['codex', 'claude-code'].includes(chosen.adapterId);
  useEffect(() => {
    if (!input.current) return;
    // The floating window keeps the composer short so the thread stays readable above it.
    const [least, most] = compact ? [44, 120] : [78, 220];
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(most, Math.max(least, input.current.scrollHeight))}px`;
  }, [draft, compact]);
  useEffect(() => {
    const focus = () => input.current?.focus();
    window.addEventListener('omenflow:focus-composer', focus);
    return () => window.removeEventListener('omenflow:focus-composer', focus);
  }, []);
  useEffect(() => {
    followOnDelivery.current = null;
    following.current = true;
    setAtBottom(true);
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [state?.activeId]);
  useEffect(() => {
    const reveal = (event: Event) => {
      const owner = (event as CustomEvent<{ project: string; conversationId: string }>).detail;
      if (
        owner?.project !== projectId ||
        owner.conversationId !== useChat.getState().projects[projectId]?.activeId
      )
        return;
      requestAnimationFrame(() => {
        if (owner.conversationId !== useChat.getState().projects[projectId]?.activeId) return;
        const el = scroll.current;
        const card = el
          ? Array.from(el.querySelectorAll('.chat-column > .inline-cards .inline-owned-card')).at(
              -1,
            )
          : null;
        if (!el || !card) return;
        followOnDelivery.current = null;
        following.current = false;
        setAtBottom(false);
        el.scrollTop += card.getBoundingClientRect().top - el.getBoundingClientRect().top - 16;
      });
    };
    window.addEventListener('omenflow:open-card', reveal);
    return () => window.removeEventListener('omenflow:open-card', reveal);
  }, [projectId]);
  const last = turns.at(-1);
  // Text and cards that finish loading after a render (a returning pane, a card's 3D or chart)
  // keep a reader who is following at the latest response.
  const hasTurns = useRef(false);
  hasTurns.current = turns.length > 0;
  useEffect(() => {
    const el = scroll.current;
    const column = el?.firstElementChild;
    if (!el || !column || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (hasTurns.current && following.current && !window.getSelection()?.toString())
        el.scrollTop = el.scrollHeight;
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (
      turns.length > 0 &&
      following.current &&
      scroll.current &&
      !window.getSelection()?.toString()
    )
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [state?.activeId, turns.length, last?.response, last?.state, last?.parts]);
  const offer = (text: string) => {
    useChat.getState().offer(projectId, text);
    input.current?.focus();
  };
  const followLatest = () => {
    following.current = true;
    setAtBottom(true);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  };
  const deliver = (target: 'codex' | 'claude-code', retry?: typeof attempt) => {
    const owner = state?.activeId;
    const delivery = ++deliverySequence.current;
    followOnDelivery.current = delivery;
    followLatest();
    void useChat
      .getState()
      .send(projectId, target, retry)
      .finally(() => {
        requestAnimationFrame(() => {
          if (followOnDelivery.current !== delivery) return;
          if (
            useStore.getState().projectId === projectId &&
            useChat.getState().projects[projectId]?.activeId === owner
          )
            followLatest();
          followOnDelivery.current = null;
        });
      });
  };
  const blocked = running || sending || readOnly || !supported || !!attempt || terminalLive;
  const send = () => {
    if (draft.trim() && !blocked) deliver(adapter);
  };
  const stop = async () => {
    if (!state) return;
    setStopping(true);
    await useChat.getState().cancel(projectId, state.activeId);
    setStopping(false);
  };
  const cards = active?.cards ?? [];
  const inspections = state ? (state.inspections[state.activeId]?.cards ?? []) : [];
  const empty = !turns.length && !cards.length && !inspections.length && !recordOpen;
  const composerHadFocus = input.current !== null && input.current === document.activeElement;
  const caretStart = input.current?.selectionStart;
  const caretEnd = input.current?.selectionEnd;
  useLayoutEffect(() => {
    if (composerHadFocus && input.current) {
      input.current.focus({ preventScroll: true });
      if (caretStart !== undefined && caretEnd !== undefined)
        input.current.setSelectionRange(caretStart, caretEnd);
    }
  }, [empty, composerHadFocus, caretStart, caretEnd]);
  return (
    <CompactContext.Provider value={compact}>
      <section
        className={`chat-conversation${empty ? ' is-empty' : ''}${compact ? ' is-compact' : ''}`}
        aria-label="Conversation"
      >
        <div
          className="chat-conversation-scroll scroll-region"
          ref={scroll}
          onWheel={() => {
            followOnDelivery.current = null;
          }}
          onPointerDown={() => {
            followOnDelivery.current = null;
          }}
          onKeyDown={(event) => {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key))
              followOnDelivery.current = null;
          }}
          onScroll={() => {
            if (followOnDelivery.current) return;
            const el = scroll.current!;
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            const up = el.scrollTop < lastTop.current;
            lastTop.current = el.scrollTop;
            // Content growing below a reader is not the reader scrolling away; scrolling up is.
            if (!near && !up) return;
            following.current = near;
            setAtBottom(near);
          }}
        >
          <div className="chat-column">
            {recordOpen && (
              <section className="inline-card inline-record-picker">
                <header className="inline-card-head">
                  <span className="inline-card-icon">
                    <BookOpen size={18} />
                  </span>
                  <div>
                    <span className="chat-eyebrow">Your project</span>
                    <h2>Pick up where you left off</h2>
                  </div>
                  <Button variant="ghost" size="sm" onClick={closeRecord}>
                    Close
                  </Button>
                </header>
                <label className="chat-record-search">
                  <MagnifyingGlass size={16} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find a part, requirement, or result…"
                    aria-label="Find a project object"
                  />
                </label>
                <div className="chat-record-list">
                  {artifacts
                    .filter((a) =>
                      `${a.artifact.title} ${a.artifact.type}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map((a) => (
                      <button
                        type="button"
                        key={a.artifact.id}
                        onClick={() => {
                          report(
                            useChat.getState().open(projectId, {
                              kind: 'artifact',
                              artifactId: a.artifact.id,
                              ...(a.revision ? { revisionId: a.revision.id } : {}),
                            }),
                          );
                          closeRecord();
                        }}
                      >
                        <TypeGlyph type={a.artifact.type} size={18} />
                        <span className="grow">
                          <strong>{a.artifact.title}</strong>
                          <small>
                            {typeMeta(a.artifact.type).label} ·{' '}
                            {a.revision?.reviewState ?? 'No revision'}
                          </small>
                        </span>
                        <ArrowRight size={14} />
                      </button>
                    ))}
                </div>
                {!artifacts.some((a) =>
                  `${a.artifact.title} ${a.artifact.type}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                ) && <p className="inline-caption">No objects match this search.</p>}
              </section>
            )}
            {cards.length > 0 && state && (
              <InlineCards cards={cards} projectId={projectId} conversationId={state.activeId} />
            )}
            {inspections.length > 0 && state && (
              <>
                <p className="inline-owned-label">
                  Read-only snapshot · temporary inspection, not saved to the project
                </p>
                <InlineCards
                  cards={inspections}
                  projectId={projectId}
                  conversationId={state.activeId}
                />
              </>
            )}
            {empty ? (
              <div className="chat-welcome">
                <div className="chat-welcome-mark">
                  <Mark size={35} />
                </div>
                <h2>What are we making?</h2>
                <p>Bring an idea, a constraint, or a question.</p>
              </div>
            ) : (
              <ol className="chat-messages" aria-label="Recorded conversation">
                {turns.map((turn) => (
                  <Turn
                    key={turn.requestId}
                    turn={turn}
                    projectId={projectId}
                    offer={offer}
                    openRecord={openRecord}
                    fresh={!historical.current?.has(turn.requestId)}
                    conversationId={state!.activeId}
                    latest={turn === turns.at(-1)}
                    continuedBy={turns.find((t) => t.continues?.requestId === turn.requestId)}
                    rootText={chainRoot(turns, turn)}
                    blocked={blocked}
                    refused={state!.refused[turn.requestId]}
                    onContinue={() => {
                      followLatest();
                      report(useChat.getState().continueTurn(projectId, turn));
                    }}
                  />
                ))}
              </ol>
            )}
            {state?.loading && !state.loaded && (
              <p className="chat-load" role="status">
                <Spinner /> Reading the conversation record…
              </p>
            )}
            {state?.error && (
              <Notice tone="err" role="alert">
                {state.error}
                <Button size="sm" onClick={() => void useChat.getState().refresh(projectId)}>
                  Try again
                </Button>
              </Notice>
            )}
            {state?.storageError && (
              <Notice tone="warn">
                This device could not save the draft. Keep this window open or copy your text before
                reloading.
              </Notice>
            )}
            {attempt && (
              <div className="chat-delivery" role="status">
                <strong>{sending ? 'Sending…' : 'Message needs attention'}</strong>
                <p>
                  {attempt.error ??
                    'You can keep writing while this message is sent. Your newer draft stays here.'}
                </p>
                {!sending && (
                  <>
                    <blockquote>{attempt.text}</blockquote>
                    <Button
                      size="sm"
                      disabled={terminalLive}
                      onClick={() => {
                        deliver(attempt.adapterId, attempt);
                      }}
                    >
                      Retry original request
                    </Button>
                  </>
                )}
              </div>
            )}

            {empty && (
              <>
                <div className="chat-starters">
                  {starters.map((s) => (
                    <button type="button" key={s.title} onClick={() => offer(s.text)}>
                      {s.icon}
                      <strong>{s.title}</strong>
                      <span>{s.detail}</span>
                    </button>
                  ))}
                </div>
                {artifacts.length > 0 && !compact && (
                  <section className="chat-artifact-shelf" aria-label="Existing project objects">
                    <header>
                      <span>Already in this project</span>
                      <button type="button" onClick={openRecord}>
                        View all {artifacts.length}
                        <ArrowRight size={12} />
                      </button>
                    </header>
                    <div>
                      {[...artifacts]
                        .sort(
                          (a, b) =>
                            Number(b.artifact.type === 'mechanical') -
                            Number(a.artifact.type === 'mechanical'),
                        )
                        .slice(0, 3)
                        .map((a) => (
                          <button
                            type="button"
                            key={a.artifact.id}
                            onClick={() =>
                              report(
                                useChat.getState().open(projectId, {
                                  kind: 'artifact',
                                  artifactId: a.artifact.id,
                                  ...(a.revision ? { revisionId: a.revision.id } : {}),
                                }),
                              )
                            }
                          >
                            <TypeGlyph type={a.artifact.type} size={19} />
                            <span>
                              <strong>{a.artifact.title}</strong>
                              <small>
                                {typeMeta(a.artifact.type).label} ·{' '}
                                {a.revision?.reviewState ?? 'No revision'}
                              </small>
                            </span>
                            <ArrowRight size={13} />
                          </button>
                        ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
        <div className="chat-composer-dock">
          <div className="chat-column">
            {!atBottom && turns.length > 0 && (
              <Button size="sm" className="chat-latest" onClick={followLatest}>
                Latest response
              </Button>
            )}
            {renderComposer()}
          </div>
        </div>
      </section>
    </CompactContext.Provider>
  );
  function renderComposer() {
    return (
      <>
        {terminalLive && (
          <Notice
            tone="warn"
            role="status"
            action={
              <span className="chat-terminal-actions">
                <Button size="sm" variant="ghost" onClick={() => setPane('terminal')}>
                  Switch to Terminal
                </Button>
                <ConfirmButton
                  size="sm"
                  label="Stop terminal session"
                  confirmLabel="Stop the terminal session"
                  onConfirm={() => report(stopAgent())}
                />
              </span>
            }
          >
            A terminal session is running. One agent works in a project at a time.
          </Notice>
        )}
        {state?.drafts[state.activeId]?.input && (
          <div className="chat-input-attachment">
            <InputAttachment input={state.drafts[state.activeId]!.input!} />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => useChat.getState().clearInput(projectId)}
            >
              Remove attached values
            </Button>
          </div>
        )}
        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            ref={input}
            aria-label="Message the agent"
            placeholder="Describe what you want to make…"
            value={draft}
            onChange={(e) => useChat.getState().draft(projectId, e.target.value)}
            maxLength={32000}
            disabled={readOnly}
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="chat-composer-tools">
            <Menu
              trigger={
                <IconButton label="Add project context">
                  <Plus size={18} />
                </IconButton>
              }
              items={[
                ...proposals
                  .filter((p) => p.state === 'pending')
                  .map((p) => ({
                    label: `Review: ${p.reason}`,
                    onSelect: () =>
                      report(
                        useChat.getState().open(projectId, { kind: 'review', proposalId: p.id }),
                      ),
                  })),
                ...(artifacts.length
                  ? artifacts.slice(0, 12).map((a) => ({
                      label: a.artifact.title,
                      onSelect: () =>
                        report(
                          useChat
                            .getState()
                            .open(projectId, { kind: 'artifact', artifactId: a.artifact.id }),
                        ),
                    }))
                  : [{ label: 'No objects recorded yet', disabled: true, onSelect: () => {} }]),
              ]}
            />
            <Menu
              trigger={
                <button
                  type="button"
                  className="chat-agent-picker"
                  aria-label={`Agent: ${chosen?.label ?? 'Codex CLI'}`}
                >
                  {chosen?.label ?? 'Codex CLI'}
                  <CaretDown size={12} />
                </button>
              }
              items={[
                ...adapters
                  .filter((a) => ['codex', 'claude-code'].includes(a.adapterId))
                  .map((a) => ({
                    label: `${a.label}${a.available ? '' : ' · Not detected'}`,
                    onSelect: () => useStore.getState().setAgent(a.adapterId),
                  })),
                {
                  label: 'Agent settings…',
                  onSelect: () => useStore.getState().set({ settingsOpen: true }),
                },
              ]}
            />
            <span className="grow" />
            {draft.length > 30000 && (
              <span className="chat-character-count">{draft.length}/32000</span>
            )}
            {activeRunning ? (
              <Button
                className="chat-stop"
                size="sm"
                busy={stopping}
                icon={<Square size={13} weight="fill" />}
                onClick={() => void stop()}
              >
                Stop response
              </Button>
            ) : (
              <IconButton
                className="chat-send"
                label="Send message"
                type="submit"
                disabled={!draft.trim() || blocked}
              >
                <ArrowUp size={18} weight="bold" />
              </IconButton>
            )}
          </div>
        </form>
        {!supported && (
          <p className="chat-composer-note tone-warn">
            {chosen?.label} runs in the Terminal pane only. Choose Codex CLI or Claude Code for the
            conversation.
          </p>
        )}
        {running && !activeRunning && (
          <p className="chat-composer-note">
            An agent is working in another conversation in this project.
          </p>
        )}
        {readOnly ? (
          <p className="chat-composer-note">
            This project is read-only. Its conversation record is available for reference.
          </p>
        ) : (
          <p className="chat-composer-note">
            Agents draft. You decide. <span>Enter to send · Shift Enter for a new line</span>
          </p>
        )}
      </>
    );
  }
}

/** The request a chain of continuations started from: what Edit request offers again. */
function chainRoot(turns: ChatTurn[], turn: ChatTurn): string {
  let root = turn;
  for (let hops = 0; root.continues && hops < 32; hops++) {
    const earlier = turns.find((t) => t.requestId === root.continues!.requestId);
    if (!earlier) break;
    root = earlier;
  }
  return root.text;
}

function Turn({
  turn,
  projectId,
  offer,
  openRecord,
  fresh,
  conversationId,
  latest,
  continuedBy,
  rootText,
  blocked,
  refused,
  onContinue,
}: {
  turn: ChatTurn;
  projectId: string;
  offer: (text: string) => void;
  openRecord: () => void;
  fresh: boolean;
  conversationId: string;
  latest: boolean;
  continuedBy?: ChatTurn;
  /** The request this turn's chain of continuations started from. */
  rootText: string;
  blocked: boolean;
  refused?: string;
  onContinue: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [activityError, setActivityError] = useState('');
  const [activityOpen, setActivityOpen] = useState(false);
  const running = turn.state === 'running';
  useEffect(() => {
    if (!activityOpen || !turn.sessionId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await cmd<AgentActivity>(
          'agent.activity',
          { sessionId: turn.sessionId, limit: 100 },
          { projectId },
        );
        if (alive) {
          setActivity(r);
          setActivityError('');
        }
      } catch (e) {
        if (alive) setActivityError(errMsg(e));
      }
      if (alive && running) timer = setTimeout(() => void load(), 1000);
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [activityOpen, projectId, turn.sessionId, running]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turn.response);
      setCopied(true);
    } catch {
      useStore
        .getState()
        .toast('error', 'Could not copy the response. Select the text to copy it.');
    }
  };
  const model = turnModel(turn);
  const gate = turn.gate;
  const gateCard = gate && !gate.ready && (
    <ErrorBoundary label="The completion gate record" resetKey={gate.checkedAt}>
      <WorkNotFinished
        gate={gate}
        latest={latest}
        continuedBy={continuedBy}
        blocked={blocked}
        refused={refused}
        onContinue={onContinue}
        onEdit={() => offer(rootText)}
      />
    </ErrorBoundary>
  );
  return (
    <li className="chat-turn">
      {turn.continues ? (
        <ContinuationMessage text={turn.text} automatic={turn.continues.automatic} />
      ) : (
        <article className="chat-user-message" aria-label="Your message">
          <div>{turn.text}</div>
          {turn.input && <InputAttachment input={turn.input} />}
        </article>
      )}
      <article className="chat-assistant-message" aria-label="Agent response">
        <header>
          <span className="chat-assistant-mark">
            <Mark size={18} />
          </span>
          <strong>Omen Flow</strong>
          <span>{turn.adapterId === 'codex' ? 'Codex CLI' : 'Claude Code'}</span>
          {model && (
            <span
              className="chat-turn-model mono"
              title={[
                turn.model && `Passed ${turn.model}`,
                turn.resolvedModel && `reported by the CLI ${turn.resolvedModel}`,
              ]
                .filter(Boolean)
                .join(', ')}
            >
              {model}
            </span>
          )}
          <Time value={turn.createdAt} />
        </header>
        {modelMismatch(turn) && (
          <Notice tone="warn">
            Claude Code reported running {turn.resolvedModel}, not {turn.model}. Check the model in
            Settings.
          </Notice>
        )}
        {turn.response && (
          <Suspense fallback={<div className="prose">{turn.response}</div>}>
            <ResponseText text={turn.response} running={running} fresh={fresh} />
          </Suspense>
        )}
        {!!turn.parts?.length && (
          <InlineCards cards={turn.parts} projectId={projectId} conversationId={conversationId} />
        )}
        {running && (
          <p className="chat-run-status" role="status">
            <Spinner />
            <span>{turn.response ? 'Response in progress' : 'Agent is working'}</span>
          </p>
        )}
        {turn.error && (
          <Notice tone={turn.state === 'failed' ? 'err' : 'warn'}>
            {turn.state === 'cancelled'
              ? 'Stopped. '
              : turn.state === 'interrupted'
                ? 'Interrupted. '
                : turn.state === 'unavailable'
                  ? 'State unavailable. '
                  : 'Response failed. '}
            {turn.error}
            <Button size="sm" variant="ghost" onClick={() => offer(rootText)}>
              Edit request
            </Button>
          </Notice>
        )}
        {!running && turn.state === 'failed' && gateCard}
        {!running && turn.state === 'completed' && !turn.response && (
          <p className="chat-muted">
            The agent ended the turn without a text response. Inspect its recorded tool calls and
            the project record.
          </p>
        )}
        {!running && turn.state === 'completed' && gateCard}
        {!running &&
          turn.state === 'completed' &&
          gate?.ready &&
          gate.calls === 0 &&
          gate.inScope === 0 && (
            <NoToolCalls
              latest={latest}
              blocked={blocked}
              refused={refused}
              onContinue={onContinue}
            />
          )}
        <footer className="chat-response-actions">
          {turn.response && (
            <IconButton
              size="sm"
              label={copied ? 'Response copied' : 'Copy response'}
              onClick={() => void copy()}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
          )}
          <button
            type="button"
            aria-expanded={activityOpen}
            onClick={() => setActivityOpen((v) => !v)}
          >
            <ClockCounterClockwise size={13} />
            Recorded activity
            <CaretDown size={11} />
          </button>
          <button type="button" onClick={openRecord}>
            <BookOpen size={13} />
            Project record
          </button>
        </footer>
        {activityOpen && (
          <div className="chat-call-ledger">
            <span className="chat-eyebrow">Host call ledger</span>
            {activityError ? (
              <p role="alert">{activityError}</p>
            ) : activity ? (
              activity.calls.length ? (
                <ol>
                  {activity.calls.map((call) => (
                    <RecordedCall
                      key={call.seq}
                      call={call}
                      onInspect={(artifactId) =>
                        report(useChat.getState().open(projectId, { kind: 'artifact', artifactId }))
                      }
                    />
                  ))}
                </ol>
              ) : (
                <p>No engineering tool calls are recorded for this response.</p>
              )
            ) : (
              <p role="status">Reading recorded calls…</p>
            )}
          </div>
        )}
      </article>
    </li>
  );
}
