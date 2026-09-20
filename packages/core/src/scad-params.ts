/**
 * Top-level OpenSCAD parameter discovery. A "parameter" is a top-level
 * assignment of a literal (number, string, boolean) — the same set OpenSCAD's
 * customizer exposes and the only names `-D name=value` can meaningfully
 * override. Assignments inside modules/functions are ignored.
 */

export interface ScadParameter {
  name: string;
  value: number | string | boolean;
  /** Trailing `// comment` on the same line, if any. */
  comment?: string;
  line: number;
}

export function parseScadParameters(source: string): ScadParameter[] {
  const out: ScadParameter[] = [];
  const lines = source.split(/\r?\n/);
  let depth = 0;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    // Strip block comments (may span lines).
    let code = '';
    let j = 0;
    while (j < line.length) {
      if (inBlockComment) {
        const end = line.indexOf('*/', j);
        if (end < 0) {
          j = line.length;
        } else {
          inBlockComment = false;
          j = end + 2;
        }
        continue;
      }
      const start = line.indexOf('/*', j);
      if (start >= 0) {
        code += line.slice(j, start);
        inBlockComment = true;
        j = start + 2;
        continue;
      }
      code += line.slice(j);
      break;
    }
    line = code;
    const commentIdx = line.indexOf('//');
    const comment = commentIdx >= 0 ? line.slice(commentIdx + 2).trim() : undefined;
    if (commentIdx >= 0) line = line.slice(0, commentIdx);

    if (depth === 0) {
      // Several statements may share a line (`w = 100; d = 40;`).
      for (const stmt of line.split(';')) {
        const m = /^\s*([A-Za-z_$][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(stmt);
        if (!m) continue;
        const value = literal(m[2]!);
        if (value !== undefined) {
          out.push({ name: m[1]!, value, ...(comment ? { comment } : {}), line: i + 1 });
        }
      }
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return out;
}

function literal(expr: string): number | string | boolean | undefined {
  const t = expr.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  const s = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (s) return s[1]!.replace(/\\(.)/g, '$1');
  return undefined;
}
