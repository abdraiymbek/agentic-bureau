import { describe, expect, it } from "vitest";

import { diffLines } from "./diff";

describe("diffLines", () => {
  it("returns identical lines as same", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(d).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("marks added and deleted lines", () => {
    const d = diffLines("a\nb", "a\nc");
    expect(d).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "c" },
    ]);
  });

  it("treats empty old as all adds", () => {
    const d = diffLines("", "x\ny");
    expect(d).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
  });

  it("treats empty new as all dels", () => {
    const d = diffLines("x\ny", "");
    expect(d).toEqual([
      { kind: "del", text: "x" },
      { kind: "del", text: "y" },
    ]);
  });
});
