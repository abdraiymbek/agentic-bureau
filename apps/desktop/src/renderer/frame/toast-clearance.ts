/** The stack's edge offset and widest toast, as in `.toasts` / `.toast` (shell.css). */
export const TOAST_EDGE = 16;
const WIDEST = 420;
/** A stack not measured yet is taken to be one toast tall. */
const ONE_TOAST = 44;
const GAP = 8;

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * How far above the window's bottom edge the stack must sit so it covers none of the controls
 * that mark themselves `data-toast-avoid` (the decision bar, the map's controls, a save bar).
 * The stack is anchored bottom right; it rises past each avoided box it would overlap, lowest
 * first. A box beside the stack or above it never moves it.
 */
export function toastClearance(
  view: { width: number; height: number },
  stack: { width: number; height: number },
  avoid: Box[],
): number {
  const right = view.width - TOAST_EDGE;
  const left = right - (stack.width || WIDEST);
  const height = stack.height || ONE_TOAST;
  let bottom = TOAST_EDGE;
  const beside = avoid
    .filter((b) => b.right > b.left && b.bottom > b.top && b.right > left && b.left < right)
    .sort((a, b) => b.bottom - a.bottom);
  for (const b of beside) {
    const stackBottom = view.height - bottom;
    const stackTop = stackBottom - height;
    if (b.top < stackBottom && b.bottom > stackTop)
      bottom = Math.max(bottom, view.height - b.top + GAP);
  }
  return bottom;
}
