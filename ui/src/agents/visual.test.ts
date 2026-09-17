import { describe, expect, it } from "vitest";

import { applyVisual, luminanceToChar, pixelsToAscii } from "./visual";

describe("luminanceToChar", () => {
  it("maps black to the lightest ramp char and white to the densest", () => {
    expect(luminanceToChar(0)).toBe(" ");
    expect(luminanceToChar(255)).toBe("@");
  });
});

describe("pixelsToAscii", () => {
  it("renders a 2x1 black image as spaces", () => {
    const px = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    expect(pixelsToAscii(px, 2, 1)).toBe("  ");
  });

  it("renders a white pixel as the densest char", () => {
    const px = new Uint8ClampedArray([255, 255, 255, 255]);
    expect(pixelsToAscii(px, 1, 1)).toBe("@");
  });
});

describe("applyVisual", () => {
  const base = {
    fontFamily: "mono",
    fontSize: 13,
    lineHeight: 1.2,
    theme: { foreground: "#111111", background: "#fafafa" },
  };

  it("returns base for non-minimal visuals", () => {
    expect(applyVisual(base, "default")).toBe(base);
    expect(applyVisual(base, "image")).toBe(base);
    expect(applyVisual(base, "ascii")).toBe(base);
  });

  it("flattens to monochrome for minimal", () => {
    const v = applyVisual(base, "minimal");
    expect(v.theme.background).toBe("#000000");
    expect(v.theme.red).toBe("#e8e8e8");
    expect(v.theme.brightBlue).toBe("#ffffff");
  });
});
