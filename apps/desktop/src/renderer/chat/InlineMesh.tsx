import React, { useEffect, useRef, useState } from 'react';
import { ArrowsOut, CornersOut, CornersIn } from '@phosphor-icons/react';
import type { MechanicalPayload, Revision } from '@omenflow/contracts';
import { Button, Spinner } from '../ui/kit';
import { useRevisionMesh } from '../object/mechanical/useCad';
import { ViewportScene, type SceneTheme } from '../object/viewport/scene';
import { formatEnvelope } from '../lib/viewport-math';
import { meshProvenance } from '../lib/render-jobs';

function theme(): SceneTheme {
  const s = getComputedStyle(document.documentElement);
  const t = (n: string) => s.getPropertyValue(n).trim();
  return {
    background: t('--canvas-bg'),
    grid: t('--canvas-grid'),
    gridMajor: t('--canvas-grid-major'),
    axes: t('--text-3'),
    model: t('--model-color'),
    compare: t('--model-compare'),
    edge: t('--canvas-bg'),
    sectionFill: t('--text-2'),
    outline: t('--text-2'),
    measure: t('--signal-stroke'),
  };
}
/** A focused conversation viewport, sharing only geometry/scene code with the expert stage. */
export default function InlineMesh({
  revision,
  onShown,
}: {
  revision: Revision;
  onShown?: (ready: boolean) => void;
}) {
  const payload = revision.payload as MechanicalPayload;
  const file =
    revision.files.find((f) => f.path === payload.stl?.path) ??
    revision.files.find((f) => f.path.endsWith('.stl'));
  const mesh = useRevisionMesh(revision, file);
  const mount = useRef<HTMLDivElement>(null);
  const scene = useRef<ViewportScene | null>(null);
  const shown = useRef(onShown);
  shown.current = onShown;
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const ready = mesh.status === 'ready' ? mesh.value : null;
  useEffect(() => {
    if (!mount.current || !ready) return;
    let view: ViewportScene;
    let drawn = false;
    let visible = false;
    const publish = () => {
      if (drawn && visible) shown.current?.(true);
    };
    const drawnReady = () => {
      drawn = true;
      publish();
    };
    const visibility = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      publish();
    });
    visibility.observe(mount.current);
    try {
      view = new ViewportScene(mount.current, theme(), {
        onFrame: (drawn) => {
          if (drawn === ready) {
            drawnReady();
          }
        },
        onContextLost: () => {
          setError('The graphics context was lost. Reopen this card to retry.');
          shown.current?.(false);
        },
      });
      scene.current = view;
      view.setMesh(ready);
      view.setZoomEnabled(false);
      setError('');
    } catch (e) {
      visibility.disconnect();
      setError(String(e));
      shown.current?.(false);
      return;
    }
    const observer = new MutationObserver(() => view.setTheme(theme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      shown.current?.(false);
      observer.disconnect();
      visibility.disconnect();
      view.dispose();
      scene.current = null;
    };
  }, [ready]);
  const provenance = meshProvenance(payload, revision.files);
  return (
    <div className={`inline-mesh${expanded ? ' expanded' : ''}`}>
      <div
        className="inline-mesh-canvas"
        ref={mount}
        tabIndex={0}
        role="group"
        aria-label="3D model. Drag to orbit, arrow keys to rotate, F to fit."
        onFocus={() => scene.current?.setZoomEnabled(true)}
        onBlur={() => scene.current?.setZoomEnabled(false)}
        onKeyDown={(e) => {
          const view = scene.current;
          if (!view || e.altKey || e.metaKey || e.ctrlKey) return;
          const actions: Record<string, () => void> = {
            ArrowLeft: () => view.orbit(-Math.PI / 12, 0),
            ArrowRight: () => view.orbit(Math.PI / 12, 0),
            ArrowUp: () => view.orbit(0, -Math.PI / 12),
            ArrowDown: () => view.orbit(0, Math.PI / 12),
            f: () => view.fit(),
            '+': () => view.zoom(1.2),
            '-': () => view.zoom(1 / 1.2),
          };
          if (actions[e.key]) {
            e.preventDefault();
            actions[e.key]!();
          }
        }}
      />
      <div className="inline-mesh-tools">
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowsOut size={14} />}
          onClick={() => scene.current?.fit()}
          disabled={!ready}
        >
          Fit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={expanded ? <CornersIn size={14} /> : <CornersOut size={14} />}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Compact' : 'Larger view'}
        </Button>
      </div>
      {!ready && (
        <div className="inline-mesh-empty">
          {mesh.status === 'loading' ? (
            <>
              <Spinner /> Reading recorded mesh…
            </>
          ) : mesh.status === 'failed' ? (
            <>
              <p role="alert">{mesh.error}</p>
              <Button size="sm" onClick={mesh.retry}>
                Try again
              </Button>
            </>
          ) : (
            'No mesh recorded. Send dimensions to the agent to render this part.'
          )}
        </div>
      )}
      {error && (
        <p className="inline-mesh-empty" role="alert">
          3D unavailable: {error}
        </p>
      )}
      <div className="inline-mesh-caption">
        <span>
          {provenance === 'rendered'
            ? 'Engine render · exact revision'
            : provenance === 'illustrative'
              ? 'Illustrative mesh · unverified'
              : provenance === 'unlinked'
                ? 'Attached mesh · render identity unverified'
                : 'No rendered geometry'}
        </span>
        {ready && (
          <span className="num">
            Mesh envelope {formatEnvelope(ready.bounds, payload.modelUnit || 'unit unspecified')}
          </span>
        )}
      </div>
    </div>
  );
}
