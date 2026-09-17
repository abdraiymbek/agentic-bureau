import type { TerminalAppearance } from "../pty/theme";

export type AgentVisual = "default" | "image" | "ascii" | "minimal";

export const AGENT_VISUALS: readonly AgentVisual[] = [
  "default",
  "image",
  "ascii",
  "minimal",
];

const RAMP = " .:-=+*#%@";

export function luminanceToChar(luma: number): string {
  const idx = Math.min(
    RAMP.length - 1,
    Math.max(0, Math.round((luma / 255) * (RAMP.length - 1))),
  );
  return RAMP[idx]!;
}

export function pixelsToAscii(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): string {
  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const luma =
        0.2126 * pixels[i]! + 0.7152 * pixels[i + 1]! + 0.0722 * pixels[i + 2]!;
      line += luminanceToChar(luma);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function applyVisual(
  base: TerminalAppearance,
  visual: AgentVisual,
): TerminalAppearance {
  if (visual !== "minimal") return base;
  return {
    ...base,
    theme: {
      ...base.theme,
      foreground: "#e8e8e8",
      background: "#000000",
      cursor: "#e8e8e8",
      cursorAccent: "#000000",
      selectionBackground: "#333333",
      black: "#000000",
      red: "#e8e8e8",
      green: "#e8e8e8",
      yellow: "#e8e8e8",
      blue: "#e8e8e8",
      magenta: "#e8e8e8",
      cyan: "#e8e8e8",
      white: "#e8e8e8",
      brightBlack: "#666666",
      brightRed: "#ffffff",
      brightGreen: "#ffffff",
      brightYellow: "#ffffff",
      brightBlue: "#ffffff",
      brightMagenta: "#ffffff",
      brightCyan: "#ffffff",
      brightWhite: "#ffffff",
    },
  };
}
