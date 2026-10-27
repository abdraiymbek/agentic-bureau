/**
 * Bureau's icons, drawn for the app on a 16-unit grid: a 1.5 stroke with square caps
 * and mitred joins, straight lines and 45° turns, circles only where something is
 * measured or round in life. The agent is pixels from the mark, never a robot.
 *
 * Each icon keeps the name the code used before (Phosphor's), so a call site only
 * changes where it imports from. `weight` thins or thickens the stroke; `fill` swaps
 * in a solid form where the icon has one.
 */
import React from 'react';

export type IconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'ref'> {
  size?: number | string;
  weight?: IconWeight;
  color?: string;
  mirrored?: boolean;
  /** An accessible name; without one the icon should be marked aria-hidden. */
  alt?: string;
}

export type Icon = React.ForwardRefExoticComponent<IconProps & React.RefAttributes<SVGSVGElement>>;

interface Shape {
  /** Stroked paths. */
  line?: string;
  /** Paths that are always solid (pixels, dots). */
  solid?: string;
  /** The solid form `weight="fill"` draws instead of the strokes. */
  fill?: string;
  /** Dashes for a line that is not established. */
  dash?: string;
}

const STROKE: Record<IconWeight, number> = {
  thin: 1,
  light: 1.25,
  regular: 1.5,
  duotone: 1.5,
  bold: 2,
  fill: 1.5,
};

/** A circle as path data, so every shape is one `d`. */
const ring = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

function make(name: string, shape: Shape): Icon {
  const component = React.forwardRef<SVGSVGElement, IconProps>(function BureauIcon(
    {
      size = 16,
      weight = 'regular',
      color = 'currentColor',
      mirrored,
      alt,
      className,
      style,
      ...rest
    },
    ref,
  ) {
    const solidOnly = weight === 'fill' && shape.fill;
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={className ? `icon ${className}` : 'icon'}
        style={mirrored ? { transform: 'scaleX(-1)', ...style } : style}
        {...rest}
      >
        {alt && <title>{alt}</title>}
        {solidOnly ? (
          <path d={shape.fill} fill={color} />
        ) : (
          shape.line && (
            <path
              d={shape.line}
              stroke={color}
              strokeWidth={STROKE[weight]}
              strokeLinecap={shape.dash ? 'butt' : 'square'}
              strokeLinejoin="miter"
              strokeDasharray={shape.dash}
            />
          )
        )}
        {!solidOnly && shape.solid && <path d={shape.solid} fill={color} />}
      </svg>
    );
  });
  component.displayName = name;
  return component;
}

/* The agent: five pixels of the mark's checker. */
const AGENT: Shape = { solid: 'M2 2h4v4H2zM10 2h4v4h-4zM6 6h4v4H6zM2 10h4v4H2zM10 10h4v4h-4z' };

/* ---------------------------------------------------------------- places */
export const Robot = make('Agent', AGENT);
export const Sparkle = make('Suggestion', AGENT);
export const Graph = make('Flow', {
  line: 'M2 6.5h3.5v3H2zM10.5 2.5H14v3h-3.5zM10.5 10.5H14v3h-3.5zM5.5 8H8M8 4v8M8 4h2.5M8 12h2.5',
});
export const Package = make('Parts', {
  line: `M14.5 8 11.25 13.63H4.75L1.5 8l3.25-5.63h6.5z${ring(8, 8, 2.25)}`,
});
export const ClockCounterClockwise = make('Timeline', { line: 'M3 2v12M3 4h11M3 8h7M3 12h9' });
export const Files = make('Files', { line: 'M3.75 1.75h5.5l3 3v9.5h-8.5zM9.25 1.75v3h3' });
export const Target = make('Evidence', {
  line: `${ring(8, 8, 4.25)}M8 1.25v2.5M8 12.25v2.5M1.25 8h2.5M12.25 8h2.5`,
});
export const GitBranch = make('Decision', {
  line: 'M8 1.75 14.25 8 8 14.25 1.75 8z',
  solid: 'M7 7h2v2H7z',
});
export const GearSix = make('Settings', {
  line: 'M2 5h5.5M12 5h2M6.5 11H14M8.25 3.25h3v3.5h-3zM2.75 9.25h3v3.5h-3z',
});
export const SlidersHorizontal = GearSix;
export const MagnifyingGlass = make('Search', { line: `${ring(7, 7, 4.5)}M10.5 10.5 14 14` });
export const MagnifyingGlassPlus = make('Zoom in', {
  line: `${ring(7, 7, 4.5)}M10.5 10.5 14 14M5 7h4M7 5v4`,
});
export const MagnifyingGlassMinus = make('Zoom out', {
  line: `${ring(7, 7, 4.5)}M10.5 10.5 14 14M5 7h4`,
});
export const SidebarSimple = make('Sidebar', { line: 'M1.75 2.75h12.5v10.5H1.75zM6 2.75v10.5' });
export const AppWindow = make('Agent panel', { line: 'M1.75 2.75h12.5v10.5H1.75zM10 2.75v10.5' });
export const PictureInPicture = make('Float', {
  line: 'M1.75 2.75h12.5v10.5H1.75z',
  solid: 'M8.5 8.25h4.25v3.5H8.5z',
});
export const TerminalWindow = make('Terminal', {
  line: 'M1.75 2.75h12.5v10.5H1.75zM4.5 6l2 2-2 2M8.5 10.5H11',
});
export const ChatCircle = make('Conversation', { line: 'M2 3h12v8H7.5L4.5 13.5V11H2z' });
export const ChatCircleText = make('Message', {
  line: 'M2 3h12v8H7.5L4.5 13.5V11H2zM5 6h6M5 8.5h4',
});
export const FolderSimple = make('Folder', { line: 'M1.75 3.25h4.5l1.5 1.5h6.5v8.5H1.75z' });
export const FolderOpen = make('Open folder', {
  line: 'M1.75 12.75v-9.5h4.5l1.5 1.5h5V7M1.75 12.75 3.5 7h11l-1.75 5.75z',
});
export const HardDrive = make('Disk', {
  line: 'M1.75 9h12.5v4.25H1.75zM3.25 9 5 2.75h6L12.75 9M11 11.25h.5',
});
export const Globe = make('Web', {
  line: `${ring(8, 8, 6.25)}M1.75 8h12.5M8 1.75c-2.25 2.5-2.25 10 0 12.5M8 1.75c2.25 2.5 2.25 10 0 12.5`,
});
export const BookOpen = make('Guide', {
  line: 'M8 4v9.75M1.75 3h4.5L8 4l1.75-1h4.5v9.5h-4.5L8 13.75 6.25 12.5h-4.5z',
});
export const Archive = make('Archive', {
  line: 'M1.75 2.75h12.5v3H1.75zM2.75 5.75v7.5h10.5v-7.5M6 8.5h4',
});
export const Keyboard = make('Keys', {
  line: 'M1.75 3.75h12.5v8.5H1.75zM4.5 9.5h7M4 6.5h.5M6.5 6.5h.5M9 6.5h.5M11.5 6.5h.5',
});
export const Palette = make('Appearance', {
  line: 'M2 2h5v5H2zM9 9h5v5H9zM9 2h5v5H9z',
  solid: 'M2 9h5v5H2z',
});
export const Sun = make('Light', {
  line: `${ring(8, 8, 2.75)}M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06`,
});
export const MoonStars = make('Dark', {
  line: 'M13.25 9.75A5.75 5.75 0 1 1 6.25 2.75a4.5 4.5 0 0 0 7 7z',
});
export const SquareHalf = make('Follow the system', {
  line: 'M2.75 2.75h10.5v10.5H2.75z',
  solid: 'M2.75 2.75H8v10.5H2.75z',
});

/* --------------------------------------------------------------- objects */
export const ListChecks = make('Requirement', { line: 'M2.5 4h11M2.5 8h8M2.5 12h5' });
export const Question = make('Assumption', { line: 'M2.5 2.5h11v11h-11z', dash: '2.5 2' });
export const Lightbulb = make('Concept', {
  line: 'M5.25 10.25a4.5 4.5 0 1 1 5.5 0V12h-5.5zM6 14.25h4',
});
export const TreeStructure = make('Architecture', {
  line: 'M6 1.75h4v3.5H6zM1.75 10.75h4v3.5h-4zM10.25 10.75h4v3.5h-4zM8 5.25V8M3.75 10.75V8h8.5v2.75',
});
export const Stack = make('Subsystem', {
  line: 'M2 5.25 8 2.5l6 2.75L8 8zM2 8.25 8 11l6-2.75M2 11.25 8 14l6-2.75',
});
export const Cube = make('Mechanical', {
  line: 'M8 1.75 14 5v6l-6 3.25L2 11V5zM2 5l6 3.25L14 5M8 8.25v6',
});
export const Circuitry = make('Electronics', {
  line: 'M4 4h8v8H4zM6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5',
});
export const Code = make('Software', {
  line: 'M5.5 5.5 2 8l3.5 2.5M10.5 5.5 14 8l-3.5 2.5M9 3l-2 10',
});
export const Wrench = make('Assembly', { line: 'M2 6h8v8H2zM6 6V2h8v8h-4' });
export const FileText = make('Note', {
  line: 'M3.75 1.75h8.5v12.5h-8.5zM6 5.5h4M6 8.5h4M6 11.5h2',
});
export const Link = make('Source', { line: 'M9.5 2H14v4.5M14 2 7.5 8.5M12 9.5V14H2V4h4.5' });
export const ArrowSquareOut = Link;
export const Calculator = make('Calculation', { line: 'M12.5 3h-9l4.75 5-4.75 5h9' });
export const Flask = make('Test', { line: 'M6 2v4.25L2.5 14h11L10 6.25V2M4.5 2h7' });
export const Circle = make('Object', { line: ring(8, 8, 5.5) });
export const CircleDashed = make('Pending', {
  line: 'M8 2.5v1.5M8 12v1.5M2.5 8H4M12 8h1.5M4.11 4.11l1.06 1.06M10.83 10.83l1.06 1.06M4.11 11.89l1.06-1.06M10.83 5.17l1.06-1.06',
});
export const ImageSquare = make('Picture', {
  line: `M1.75 2.75h12.5v10.5H1.75zM1.75 11l4-4 3 3 2-2 3.5 3.5${ring(10.5, 5.75, 1.25)}`,
});
export const Quotes = make('Excerpt', {
  solid: 'M2 4h5v4.5L5 12H3l1.25-3.5H2zM9 4h5v4.5L12 12h-2l1.25-3.5H9z',
});
export const ChartLine = make('Chart', { line: 'M2 2v12h12M4.5 10l3-3.5 2.5 2 4-4.5' });
export const Ruler = make('Measure', {
  line: 'M1.75 10.5 10.5 1.75l3.75 3.75-8.75 8.75zM4.75 7.5l1.5 1.5M7 5.25l1 1M9.25 3l1.5 1.5',
});
export const BoundingBox = make('Envelope', {
  line: 'M4 2.75h8M4 13.25h8M2.75 4v8M13.25 4v8',
  solid:
    'M1.75 1.75h2.5v2.5h-2.5zM11.75 1.75h2.5v2.5h-2.5zM1.75 11.75h2.5v2.5h-2.5zM11.75 11.75h2.5v2.5h-2.5z',
});
export const GridFour = make('Grid', { line: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z' });
export const Scales = make('Compare', {
  line: 'M8 2v12M4.5 14h7M2.5 4.5h11M3.5 4.5 1.75 9h3.5zM12.5 4.5 10.75 9h3.5z',
});
export const ShieldCheck = make('Verified', {
  line: 'M8 1.75 13.5 3.75V8c0 3.25-2.5 5.25-5.5 6.25C5 13.25 2.5 11.25 2.5 8V3.75zM5.5 8l1.75 1.75 3.25-3.5',
});
export const At = make('Mention', {
  line: `${ring(8, 8, 2.5)}M10.5 8v1.25a1.75 1.75 0 0 0 3.5 0V8a6 6 0 1 0-2.5 4.9`,
});
export const Eye = make('Show', {
  line: `M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z${ring(8, 8, 2)}`,
});

/* --------------------------------------------------------------- actions */
export const Plus = make('Add', { line: 'M8 3v10M3 8h10' });
export const Minus = make('Remove', { line: 'M3 8h10' });
export const X = make('Close', { line: 'M3.5 3.5l9 9M12.5 3.5l-9 9' });
export const Check = make('Done', { line: 'M2.75 8.5 6.25 12l7-7.75' });
export const CheckCircle = make('Passed', {
  line: `${ring(8, 8, 6.25)}M5.25 8.25 7.25 10.25l3.5-4`,
  fill: `${ring(8, 8, 7)}`,
});
export const WarningCircle = make('Warning', {
  line: 'M8 1.75 14.75 13.75H1.25zM8 6v3.5M8 11.5v.5',
  fill: 'M8 .75 15.6 14.25H.4zM7.25 5.5v4.5h1.5V5.5zm0 5.75v1.5h1.5v-1.5z',
});
export const Info = make('About', { line: `${ring(8, 8, 6.25)}M8 7.25v4M8 4.75v.5` });
export const Copy = make('Copy', { line: 'M5.5 5.5h8v8h-8zM10.5 5.5V2.5h-8v8h3' });
export const CopySimple = Copy;
export const Trash = make('Delete', {
  line: 'M2.5 4h11M6 4V2.25h4V4M3.75 4l.75 9.75h7L12.25 4M6.5 6.75v4.5M9.5 6.75v4.5',
});
export const DotsThree = make('More', {
  solid: 'M2 7h2.5v2.5H2zM6.75 7h2.5v2.5h-2.5zM11.5 7H14v2.5h-2.5z',
});
export const Square = make('Stop', { line: 'M3.75 3.75h8.5v8.5h-8.5z', fill: 'M4 4h8v8H4z' });
export const StopCircle = make('Stop', {
  line: `${ring(8, 8, 6.25)}`,
  solid: 'M5.75 5.75h4.5v4.5h-4.5z',
});
export const HandPalm = make('Interrupt', { line: 'M5.5 3.5v9M10.5 3.5v9' });
export const Play = make('Start', { line: 'M4.5 2.75v10.5L13 8z', fill: 'M4 2v12l9.5-6z' });
export const Broom = make('Clear', {
  line: 'M11.5 1.5 8.5 7M4.5 7.5h6.5l1.25 6H3.25zM6.25 10.5v3M8.75 10.5v3',
});
export const ArrowClockwise = make('Re-run', {
  line: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M12.5 1.75v2.75H9.75',
});
export const ArrowCounterClockwise = make('Reset', {
  line: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M3.5 1.75v2.75h2.75',
});
export const ArrowUUpLeft = make('Back', { line: 'M5.5 9.5 2 6l3.5-3.5M2 6h8a4 4 0 0 1 0 8H7' });
export const ArrowBendDownLeft = make('Return', { line: 'M13.5 2.5V8h-11M5.5 5 2.5 8l3 3' });
export const ArrowRight = make('Next', { line: 'M2.5 8h10.5M9.25 4.25 13 8l-3.75 3.75' });
export const ArrowLeft = make('Previous', { line: 'M13.5 8H3M6.75 4.25 3 8l3.75 3.75' });
export const ArrowUp = make('Send', { line: 'M8 13.5V3M3.75 7.25 8 3l4.25 4.25' });
export const ArrowDown = make('Down', { line: 'M8 2.5V13M3.75 8.75 8 13l4.25-4.25' });
export const ArrowLineRight = make('Dock right', { line: 'M2 8h9M8 5l3 3-3 3M14 2v12' });
export const ArrowsOut = make('Expand', {
  line: 'M9.5 2H14v4.5M14 2l-4.5 4.5M6.5 14H2V9.5M2 14l4.5-4.5',
});
export const ArrowsOutLineHorizontal = make('Widen', {
  line: 'M1.5 8h13M4.5 5 1.5 8l3 3M11.5 5l3 3-3 3',
});
export const CornersOut = make('Fit', {
  line: 'M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5',
});
export const FrameCorners = CornersOut;
export const CornersIn = make('Shrink', {
  line: 'M5.5 2v3.5H2M14 5.5h-3.5V2M10.5 14v-3.5H14M2 10.5h3.5V14',
});
export const CaretDown = make('Expand', { line: 'M4 6l4 4 4-4' });
export const CaretUp = make('Collapse', { line: 'M4 10l4-4 4 4' });
export const CaretRight = make('Open', { line: 'M6 4l4 4-4 4' });
export const CaretLeft = make('Back', { line: 'M10 4 6 8l4 4' });
export const CaretDoubleRight = make('Unfold', { line: 'M3.5 4l4 4-4 4M8.5 4l4 4-4 4' });
export const CaretDoubleLeft = make('Fold', { line: 'M12.5 4l-4 4 4 4M7.5 4l-4 4 4 4' });
export const DownloadSimple = make('Download', {
  line: 'M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11',
});
export const Export = make('Export', { line: 'M8 10V2M4.5 5.5 8 2l3.5 3.5M3 8.5v5h10v-5' });
export const SignOut = make('Close project', { line: 'M9.5 2.25h-7v11.5h7M6.5 8H14M11 5l3 3-3 3' });
