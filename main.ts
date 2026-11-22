// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  noteMove(o: string, n: string): void {
    this.moves.push([o, n]);
  }
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- section 5: files, lines and matching ----------

interface Split {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitText(text: string): Split {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinText(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const ok = o.map((l) => tierKey(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== ok[j]) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

/** First tier (0..2, or only 0 when strict) at which O occurs, with its occurrences. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

function buildReplacement(n: NewLine[], o: string[], fileLines: string[], at: number, tier: number): string[] {
  if (tier !== 2) return n.map((e) => (e.ctx ? fileLines[at + e.oIdx]! : e.text));
  const F = leadOf(fileLines[at]!);
  const P = leadOf(o[0]!);
  return n.map((e) => {
    if (e.ctx) return fileLines[at + e.oIdx]!;
    const l = e.text;
    if (l === '' || l.trim() === '') return l;
    return l.startsWith(P) ? F + l.slice(P.length) : l;
  });
}

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** a `\` line immediately follows the hunk's last context or `+` line */
  lastBs: boolean;
  /** a `\` line immediately follows the hunk's last `+` line (false when it has none) */
  lastPlusBs: boolean;
}

interface UniSection {
  oldP: string | null;
  newP: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` line: text after the four characters, up to the first tab, trimmed; /dev/null is null. */
function uniPathFrom(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseHunkBody(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  let lastCp = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: true, oIdx: o.length - 1 });
      lastCp = k;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, oIdx: o.length - 1 });
      lastCp = k;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      lastCp = k;
      lastPlus = k;
    }
    // a `\` line refers to the body line before it; it adds nothing to O or N
  }
  const lastBs = lastCp >= 0 && lastCp + 1 < body.length && body[lastCp + 1]!.startsWith('\\');
  const lastPlusBs = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\');
  return { a, o, n, lastBs, lastPlusBs };
}

function applyHunk(f: Split, h: Hunk, d: number, strict: boolean, path: string): Split {
  if (h.o.length === 0) {
    const at = Math.min(h.a + d, f.lines.length);
    const ins = h.n.map((e) => e.text);
    const lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
    const touches = at === f.lines.length;
    return { br: f.br, lines, final: touches ? !h.lastBs : f.final };
  }
  const found = findTier(f.lines, h.o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  let bd = Math.abs(best - target);
  for (const p of found.occ) {
    const dd = Math.abs(p - target);
    if (dd < bd) {
      best = p;
      bd = dd;
    }
  }
  const at = best;
  const repl = buildReplacement(h.n, h.o, f.lines, at, found.tier);
  const lines = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + h.o.length)];
  const touches = at + h.o.length === f.lines.length;
  return { br: f.br, lines, final: touches ? !h.lastBs : f.final };
}

function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldP;
    const newP = sec.newP;
    const isCreate = sec.create || oldP === null;
    const isDelete = !isCreate && (sec.del || newP === null);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const e of h.n) if (!e.ctx) plus.push(e.text);
      let final = true;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const h = sec.hunks[k]!;
        if (h.n.some((e) => !e.ctx)) {
          final = !h.lastPlusBs;
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const op = oldP!;
    const isMove = newP !== null && newP !== op;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (isMove && !safe(newP!)) throw new Fail('unsafe', newP!);
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let f = splitText(cur);
    let d = 0;
    for (const h of sec.hunks) {
      f = applyHunk(f, h, d, strict, op);
      d += h.n.length - h.o.length;
    }
    const text = joinText(f);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(newP!, text);
      tree.noteMove(op, newP!);
    } else {
      tree.now.set(op, text);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const n = lines.length;
  let cur: UniSection | null = null;
  let state: 'out' | 'head' | 'after' = 'out';
  let havePair = false;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldP: m[1]!, newP: m[2]!.trimEnd(), create: false, del: false, hunks: [] };
      sections.push(cur);
      state = 'head';
      havePair = false;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'head' && cur !== null && !havePair) {
        cur.oldP = uniPathFrom(l);
        cur.newP = uniPathFrom(lines[i + 1]!);
        havePair = true;
        i += 2;
        continue;
      }
      cur = { oldP: uniPathFrom(l), newP: uniPathFrom(lines[i + 1]!), create: false, del: false, hunks: [] };
      sections.push(cur);
      state = 'head';
      havePair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(hm[1]!, 10);
      i++;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          i++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(parseHunkBody(a, body));
      state = 'after';
      continue;
    }
    if (state === 'head' && cur !== null) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.newP = uniPathFrom(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.oldP = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.newP = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => uniSectionEdit(s, strict));
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitText(cur);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const repl = buildReplacement(
      newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })),
      oldLines,
      f.lines,
      at,
      found.tier,
    );
    tree.now.set(path, joinText({ br: f.br, lines: [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oldLines.length)], final: f.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevReplaceIdx = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceIdx; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eqIdx = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let repIdx = -1;
    for (let j = eqIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eqIdx), lines.slice(eqIdx + 1, repIdx), strict));
    prevPath = path;
    prevReplaceIdx = repIdx;
    i = repIdx + 1;
  }
  return edits;
}

// ---------- section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitText(cur);
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        for (const t of tiers) {
          const key = tierKey(ch.anchor, t);
          for (let k = cursor; k < f.lines.length; k++) {
            if (tierKey(f.lines[k]!, t) === key) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const ins = ch.n.map((e) => e.text);
        f = { br: f.br, lines: [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)], final: f.final };
        cursor = at + ins.length;
        continue;
      }
      let hit: { tier: number; at: number } | null = null;
      for (const t of tiers) {
        const occ = occurrences(f.lines, ch.o, t).filter((p) => p >= cursor);
        if (ch.eof) {
          const eofOcc = occ.filter((p) => p + ch.o.length === f.lines.length);
          if (eofOcc.length > 0) {
            hit = { tier: t, at: eofOcc[0]! };
            break;
          }
        } else if (occ.length > 0) {
          hit = { tier: t, at: occ[0]! };
          break;
        }
      }
      if (hit === null) throw new Fail('no-match', path);
      const repl = buildReplacement(ch.n, ch.o, f.lines, hit.at, hit.tier);
      f = { br: f.br, lines: [...f.lines.slice(0, hit.at), ...repl, ...f.lines.slice(hit.at + ch.o.length)], final: f.final };
      cursor = hit.at + repl.length;
    }
    const text = joinText(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.noteMove(path, moveTo);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x)) break;
        if (x === '' || x.startsWith('+')) {
          fileLines.push(x === '' ? '' : x.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      i++;
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x)) break;
        if (blank(x)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const path = l.slice('*** Update File:'.length).trim();
      const updateIdx = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const startChunk = (anchor: string | null): void => {
        cur = { anchor, o: [], n: [], eof: false };
        chunks.push(cur);
      };
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x)) break;
        if (x.startsWith('@@')) {
          startChunk(x.slice(2).trim());
          i++;
          continue;
        }
        if (x.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          i++;
          continue;
        }
        if (x === '' || x[0] === ' ' || x[0] === '-' || x[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            startChunk(null);
          }
          const b = x;
          if (b === '') {
            cur!.o.push('');
            cur!.n.push({ text: '', ctx: true, oIdx: cur!.o.length - 1 });
          } else if (b[0] === ' ') {
            const t = b.slice(1);
            cur!.o.push(t);
            cur!.n.push({ text: t, ctx: true, oIdx: cur!.o.length - 1 });
          } else if (b[0] === '-') {
            cur!.o.push(b.slice(1));
          } else {
            cur!.n.push({ text: b.slice(1), ctx: false, oIdx: -1 });
          }
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const b = chunks[chunks.length - 1]!;
        // blank lines at the end of the section are not part of it: drop trailing
        // body lines that are blank (empty or only whitespace)
        while (b.o.length > 0 || b.n.length > 0) {
          const lastO = b.o[b.o.length - 1];
          const lastN = b.n[b.n.length - 1];
          // a trailing blank is an empty context line: it is the last line of both O and N
          if (lastO !== undefined && lastO.trim() === '' && lastN !== undefined && lastN.ctx && lastN.text.trim() === '' && lastN.oIdx === b.o.length - 1) {
            b.o.pop();
            b.n.pop();
            continue;
          }
          break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateIdx + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const consumed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [o, nw] of tree.moves) {
    const wasO = tree.original(o);
    const nowO = tree.now.get(o);
    const wasN = tree.original(nw);
    const nowN = tree.now.get(nw);
    if (wasO !== null && nowO === null && wasN === null && nowN !== null) {
      rows.push({ key: nw, line: `R ${o} -> ${nw}` });
      consumed.add(o);
      consumed.add(nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
