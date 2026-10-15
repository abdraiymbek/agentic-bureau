import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowsOutLineHorizontal,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
} from '@phosphor-icons/react';
import { IconButton } from '../../ui/kit';
import { ZOOM_STEPS, fitScale, stepZoom, svgNaturalSize } from '../../lib/diagram';
import { SvgDiagram } from './shared';

/**
 * A drawing shown at a stated scale. It opens at the size it was drawn for, so its labels are
 * legible, and scrolls inside its own frame; "Fit width" trades legibility for an overview.
 */
export function DiagramViewer({
  svg,
  label,
  className,
}: {
  svg: string;
  label: string;
  className?: string;
}) {
  const natural = useMemo(() => svgNaturalSize(svg), [svg]);
  const frame = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [zoom, setZoom] = useState<number | 'fit'>(1);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  if (!natural) return <SvgDiagram svg={svg} className={className} />;
  const scale = zoom === 'fit' ? fitScale(natural, available) : zoom;
  const percent = Math.round(scale * 100);
  return (
    <figure className="diagram-viewer" aria-label={label}>
      <div className="diagram-tools">
        <IconButton
          size="sm"
          label="Zoom out"
          disabled={scale <= ZOOM_STEPS[0]!}
          onClick={() => setZoom(stepZoom(scale, -1))}
        >
          <MagnifyingGlassMinus size={14} />
        </IconButton>
        <button
          type="button"
          className="diagram-scale num"
          aria-label={`Scale ${percent} percent. Show at 100 percent.`}
          onClick={() => setZoom(1)}
        >
          {percent}%
        </button>
        <IconButton
          size="sm"
          label="Zoom in"
          disabled={scale >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!}
          onClick={() => setZoom(stepZoom(scale, 1))}
        >
          <MagnifyingGlassPlus size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label="Fit width"
          aria-pressed={zoom === 'fit'}
          onClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')}
        >
          <ArrowsOutLineHorizontal size={14} />
        </IconButton>
      </div>
      <div className="diagram-frame" ref={frame} tabIndex={0} aria-label={`${label}, scrollable`}>
        <div className="diagram-sheet" style={{ width: natural.width * scale }}>
          <SvgDiagram svg={svg} className={className} framed={false} />
        </div>
      </div>
    </figure>
  );
}
