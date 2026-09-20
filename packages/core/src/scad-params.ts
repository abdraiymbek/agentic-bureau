/**
 * Top-level OpenSCAD parameter discovery. File-scope literals are `-D`-able
 * (OpenSCAD customizer). File-scope arithmetic expressions are also exposed
 * with `derived: true` so an agent can see computed sizes, even though `-D`
 * cannot rewrite the expression itself. Assignments inside modules are ignored.
 */

export interface ScadParameter {
  name: string;
  value: number | string | boolean;
  /** Trailing `// comment` on the same line, if any. */
  comment?: string;
  line: number;
  /** True when the right-hand side is an expression, not a literal. */
  derived: boolean;
  /** Original expression when `derived` (file-scope, not `-D`-able as a literal). */
  expr?: string;
}

export function parseScadParameters(source: string): ScadParameter[] {
  const out: ScadParameter[] = [];
  const env: Record<string, number> = {};
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
        const name = m[1]!;
        const rhs = m[2]!;
        const value = literal(rhs);
        if (value !== undefined) {
          out.push({
            name,
            value,
            derived: false,
            ...(comment ? { comment } : {}),
            line: i + 1,
          });
          if (typeof value === 'number') env[name] = value;
          continue;
        }
        const evaluated = evalExpr(rhs, env);
        if (evaluated !== undefined) {
          out.push({
            name,
            value: evaluated,
            derived: true,
            expr: rhs.trim(),
            ...(comment ? { comment } : {}),
            line: i + 1,
          });
          env[name] = evaluated;
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

type Tok = number | string;

function tokenizeExpr(expr: string): Tok[] | undefined {
  const out: Tok[] = [];
  let i = 0;
  const s = expr.trim();
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if ('+-*/()'.includes(ch)) {
      out.push(ch);
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m) return undefined;
      out.push(Number(m[0]));
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_]*/.exec(s.slice(i));
      if (!m) return undefined;
      out.push(m[0]);
      i += m[0].length;
      continue;
    }
    return undefined;
  }
  return out;
}

/** File-scope arithmetic: + - * / and parentheses over numbers / earlier names. */
function evalExpr(expr: string, env: Record<string, number>): number | undefined {
  const tokens = tokenizeExpr(expr);
  if (!tokens || tokens.length === 0) return undefined;
  let i = 0;
  const peek = () => tokens[i];
  const eat = () => tokens[i++];
  const parseExpr = (): number | undefined => {
    let v = parseTerm();
    if (v === undefined) return undefined;
    while (peek() === '+' || peek() === '-') {
      const op = eat();
      const r = parseTerm();
      if (r === undefined) return undefined;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = (): number | undefined => {
    let v = parseUnary();
    if (v === undefined) return undefined;
    while (peek() === '*' || peek() === '/') {
      const op = eat();
      const r = parseUnary();
      if (r === undefined) return undefined;
      if (op === '/' && r === 0) return undefined;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const parseUnary = (): number | undefined => {
    if (peek() === '-') {
      eat();
      const v = parseUnary();
      return v === undefined ? undefined : -v;
    }
    if (peek() === '+') {
      eat();
      return parseUnary();
    }
    return parseAtom();
  };
  const parseAtom = (): number | undefined => {
    const t = eat();
    if (t === undefined) return undefined;
    if (t === '(') {
      const v = parseExpr();
      if (eat() !== ')') return undefined;
      return v;
    }
    if (typeof t === 'number') return t;
    if (typeof t === 'string' && Object.prototype.hasOwnProperty.call(env, t)) return env[t];
    return undefined;
  };
  const v = parseExpr();
  if (i !== tokens.length || v === undefined || !Number.isFinite(v)) return undefined;
  return v;
}

const CURVED = /\b(cylinder|sphere|circle|rotate_extrude)\s*\(/;

/**
 * Prepend `$fn = 64;` when the source uses curved primitives and does not
 * already set `$fn`. Prismatic-only files are left alone.
 */
export function ensureDefaultFaceting(source: string): { source: string; injected: boolean } {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  if (/\$fn\s*=/.test(stripped)) return { source, injected: false };
  if (!CURVED.test(stripped)) return { source, injected: false };
  return { source: `$fn = 64;\n${source}`, injected: true };
}
