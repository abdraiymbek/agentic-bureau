/**
 * The introduction: a full-window layer over the launcher, played once on first launch and
 * whenever it is asked for. Four acts play the product on the rover's own map (arrive, see the
 * whole, focus on one, decide), then five steps set the person up. One causal rail along the
 * bottom is the progress; → and ← move, Esc skips; everything is remembered as seen.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, WarningCircle, X } from '../ui/icons';
import { useStore } from '../store';
import { focusKind, openLayer, topmostLayer } from '../lib/layers';
import { isMacPlatform } from '../ui/shortcuts';
import { Button, Mark } from '../ui/kit';
import { MapScene, type MapPhase } from './MapScene';
import { ObjectAct, preloadTray } from './ObjectAct';
import { DecideAct } from './DecideAct';
import { Rail } from './Rail';
import { AgentStep, EngineStep, KeysStep, LocalStep, LookStep } from './Setup';
import { usePrefersReducedMotion } from './motion';
import {
  APPROVED_MS,
  ARRIVE_MS,
  DRAW_MS,
  IMPACT_MS,
  fitScale,
  introNavKey,
  nextScene,
  platformOf,
  prevScene,
  primerFor,
  sceneDef,
  type SceneId,
} from './model';
import { FOCUS, NODE, WORLD } from './rover';

const STRIP = 48;
const FOOT = 84;
const FOCUS_ZOOM = 2.6;
/** How long the layer takes to leave, matching `--t-scene`. */
const LEAVE_MS = 560;

const AFFECTED: [title: string, kind: string][] = [
  ['Camera tray', 'Mechanical'],
  ['Rover mass budget', 'Calculation'],
  ['Wheel torque at 15° incline', 'Calculation'],
  ['Ramp traverse with payload', 'Test'],
];

/** Words that rise one after another; `from` offsets the stagger after earlier text. */
function words(text: string, from = 0) {
  return text.split(' ').map((w, i) => (
    <React.Fragment key={i}>
      {i > 0 && ' '}
      <span className="intro-w" style={{ '--i': from + i } as React.CSSProperties}>
        <span>{w}</span>
      </span>
    </React.Fragment>
  ));
}

function letters(text: string, from = 0) {
  return [...text].map((ch, i) => (
    <span key={i} className="intro-letter" style={{ '--i': from + i } as React.CSSProperties}>
      <span>{ch}</span>
    </span>
  ));
}

function Arrival({ ready }: { ready: boolean }) {
  return (
    <div className="intro-arrive">
      <div className="intro-ring" aria-hidden="true" />
      <div className="intro-lockup">
        <Mark size={40} className="intro-lockup-mark" />
        <div className="intro-wordmark" role="heading" aria-level={1} aria-label="Agentic Bureau">
          <span className="intro-wordmark-lead" aria-hidden="true">
            {letters('Agentic')}
          </span>
          <span className="intro-wordmark-name" aria-hidden="true">
            {letters('Bureau', 7)}
          </span>
        </div>
        <p className="intro-tagline">{words('See the whole. Focus on one. Decide.')}</p>
        <p className="intro-sub" data-on={ready ? '' : undefined}>
          Local desktop engineering workspace · bring your own agent CLI
        </p>
      </div>
    </div>
  );
}

function ActTitle({ id, moral }: { id: SceneId; moral: boolean }) {
  const s = sceneDef(id);
  return (
    <div className="intro-act">
      <h2 className="intro-act-title">{words(s.title)}</h2>
      {s.caption && <p className="intro-act-caption mono">{s.caption}</p>}
      {moral && <p className="intro-act-moral">Approval never means validated.</p>}
    </div>
  );
}

function NeedsYou() {
  return (
    <aside
      className="island intro-needs motion-rise"
      aria-label="Needs you: four objects whose input changed since they were recorded"
    >
      <h3>
        Needs you <span className="num">4</span>
      </h3>
      {AFFECTED.map(([title, kind]) => (
        <div className="intro-need" key={title}>
          <WarningCircle size={14} aria-hidden="true" />
          <div>
            <strong>{title}</strong>
            <small>{kind}</small>
          </div>
        </div>
      ))}
    </aside>
  );
}

export function Intro() {
  const theme = useStore((s) => s.theme);
  const endIntro = useStore((s) => s.endIntro);
  const reduced = usePrefersReducedMotion();
  const mac = isMacPlatform();
  const platform = platformOf(navigator.userAgent, navigator.platform);
  const root = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<SceneId>('arrive');
  const [arrived, setArrived] = useState(false);
  /** The map has drawn and lit once; returning to it does not redraw. */
  const [lit, setLit] = useState(false);
  const [approved, setApproved] = useState(false);
  const [impact, setImpact] = useState(false);
  /** The impact has reached the last dependent. */
  const [settled, setSettled] = useState(false);
  const [keysSeen, setKeysSeen] = useState<Set<string>>(() => new Set());
  const [leaving, setLeaving] = useState(false);
  const [box, setBox] = useState({ width: 1440, height: 900 });
  const def = sceneDef(scene);

  // The introduction owns the keyboard while it is open (a registered layer, not a dialog, so
  // its own keys are not mistaken for a dialog's); a sheet opened from it sits above.
  useEffect(() => openLayer('intro'), []);
  useEffect(() => {
    root.current?.focus();
    void preloadTray().catch(() => {});
  }, []);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Timed beats: the arrival offers Continue once the lockup has risen; the map lights its
  // thread once it has drawn; approval lets the impact travel, and Continue returns when it has
  // arrived. Reduced motion skips every wait.
  useEffect(() => {
    if (scene === 'arrive' && !arrived) {
      if (reduced) return setArrived(true);
      const t = window.setTimeout(() => setArrived(true), ARRIVE_MS);
      return () => window.clearTimeout(t);
    }
    if (scene === 'whole' && !lit) {
      if (reduced) return setLit(true);
      const t = window.setTimeout(() => setLit(true), DRAW_MS);
      return () => window.clearTimeout(t);
    }
  }, [scene, arrived, lit, reduced]);
  useEffect(() => {
    if (!approved || impact) return;
    if (reduced) return setImpact(true);
    const t = window.setTimeout(() => setImpact(true), APPROVED_MS);
    return () => window.clearTimeout(t);
  }, [approved, impact, reduced]);
  useEffect(() => {
    if (!impact || settled) return;
    if (reduced) return setSettled(true);
    const t = window.setTimeout(() => setSettled(true), IMPACT_MS);
    return () => window.clearTimeout(t);
  }, [impact, settled, reduced]);

  const finish = useCallback(() => setLeaving(true), []);
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(
      () => {
        endIntro();
        document.querySelector<HTMLElement>('.launcher-name')?.focus();
      },
      reduced ? 0 : LEAVE_MS,
    );
    return () => window.clearTimeout(t);
  }, [leaving, reduced, endIntro]);

  const canContinue = scene === 'arrive' ? arrived : scene === 'decide' ? settled : true;
  const next = useCallback(() => {
    const n = nextScene(scene);
    if (n) setScene(n);
    else finish();
  }, [scene, finish]);
  const back = useCallback(() => {
    const p = prevScene(scene);
    if (p) setScene(p);
  }, [scene]);
  const approve = useCallback(() => setApproved(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat || leaving) return;
      // A sheet or menu opened from the introduction has the keyboard until it closes.
      if (topmostLayer() !== 'custom') return;
      const press = {
        key: e.key,
        mod: mac ? e.metaKey : e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
      };
      if (scene === 'keys') {
        const id = primerFor(press);
        if (id) {
          e.preventDefault();
          setKeysSeen((seen) => (seen.has(id) ? seen : new Set(seen).add(id)));
          return;
        }
      }
      if (scene === 'decide' && !approved && press.mod && e.key === 'Enter') {
        e.preventDefault();
        approve();
        return;
      }
      const target = e.target as HTMLElement | null;
      const focus = target?.closest?.('button, a, [role="radio"], [role="tab"]')
        ? 'button'
        : focusKind(e.target);
      const nav = introNavKey(press, focus);
      if (!nav) return;
      e.preventDefault();
      if (nav === 'skip') finish();
      else if (nav === 'back') back();
      else if (canContinue) next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scene, approved, canContinue, leaving, mac, next, back, finish, approve]);

  // The map fits the stage; focusing zooms it toward the tray, and the stage grows from there.
  const fit = fitScale(box, WORLD);
  const stageHeight = Math.max(0, box.height - STRIP - FOOT);
  const left = (box.width - WORLD.width * fit) / 2;
  const top = (stageHeight - WORLD.height * fit) / 2 + 28;
  const tray = NODE[FOCUS]!;
  const zoom =
    scene === 'one'
      ? `translate(${WORLD.width / 2 - tray.cx}px, ${WORLD.height / 2 - tray.cy}px) scale(${FOCUS_ZOOM})`
      : 'none';
  const origin = `${Math.round(left + tray.cx * fit)}px ${Math.round(top + tray.cy * fit)}px`;
  const phase: MapPhase =
    scene === 'arrive'
      ? 'hidden'
      : scene === 'whole'
        ? lit
          ? 'lit'
          : 'drawing'
        : scene === 'one'
          ? 'focus'
          : scene === 'decide'
            ? impact
              ? 'impact'
              : 'decide'
            : 'backdrop';
  const last = !nextScene(scene);

  return (
    <div
      ref={root}
      className="intro"
      tabIndex={-1}
      role="region"
      aria-label="Introduction to Bureau"
      data-scene={scene}
      data-kind={def.kind}
      data-leaving={leaving ? '' : undefined}
    >
      <div className="intro-strip" data-tauri-drag-region>
        <span
          className="intro-strip-brand"
          data-on={scene !== 'arrive' ? '' : undefined}
          aria-hidden="true"
        >
          <Mark size={16} />
          <span>Bureau</span>
        </span>
        <Button variant="ghost" size="sm" icon={<X size={13} />} shortcut="esc" onClick={finish}>
          Skip introduction
        </Button>
      </div>

      <div className="intro-stage">
        <div
          className="intro-world"
          data-phase={phase}
          style={{
            width: WORLD.width,
            height: WORLD.height,
            transform: `translate(${left}px, ${top}px) scale(${fit})`,
          }}
        >
          <div
            className="intro-zoom"
            style={{ transformOrigin: `${tray.cx}px ${tray.cy}px`, transform: zoom }}
          >
            <MapScene phase={phase} reduced={reduced} />
          </div>
        </div>
        {scene === 'arrive' && <Arrival ready={arrived} />}
        {def.kind === 'act' && scene !== 'arrive' && (
          <ActTitle key={scene} id={scene} moral={scene === 'decide' && settled} />
        )}
        {scene === 'one' && <ObjectAct theme={theme} reduced={reduced} origin={origin} />}
        {scene === 'decide' && (
          <DecideAct approved={approved} leaving={impact} onApprove={approve} />
        )}
        {scene === 'decide' && settled && <NeedsYou />}
        {def.kind === 'setup' && (
          <section className="intro-card island" key={scene} aria-labelledby="intro-card-title">
            <h2 id="intro-card-title" className="intro-card-title">
              {def.title}
            </h2>
            <div className="intro-card-body">
              {scene === 'agent' ? (
                <AgentStep />
              ) : scene === 'engine' ? (
                <EngineStep platform={platform} />
              ) : scene === 'look' ? (
                <LookStep />
              ) : scene === 'keys' ? (
                <KeysStep seen={keysSeen} />
              ) : (
                <LocalStep platform={platform} />
              )}
            </div>
          </section>
        )}
      </div>

      <div className="intro-foot">
        <Rail current={scene} onJump={setScene} />
        <div className="intro-nav">
          {prevScene(scene) && (
            <Button variant="ghost" icon={<ArrowLeft size={13} />} onClick={back}>
              Back
            </Button>
          )}
          {scene === 'decide' && !settled ? (
            <span className="intro-nav-hint" role="status">
              {approved ? 'The impact is travelling…' : 'Approve the proposal to continue'}
            </span>
          ) : (
            <Button
              variant="primary"
              shortcut={last ? '↵' : '→'}
              disabled={!canContinue}
              onClick={next}
            >
              {last ? 'Start' : 'Continue'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default Intro;
