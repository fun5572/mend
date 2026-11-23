// mend applies edits to UTF-8 text files. Run it as `node main.ts [options] [PATCH]` with Node 22.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmdirSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

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
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function* parents(p: string): Iterable<string> {
  for (let slash = p.indexOf('/'); slash >= 0; slash = p.indexOf('/', slash + 1)) {
    yield p.slice(0, slash);
  }
}

function diskEntry(p: string) {
  try {
    return lstatSync(p, { throwIfNoEntry: false });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw e;
  }
}

function requireSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
  for (const part of [...parents(p), p]) {
    const entry = diskEntry(part);
    if (entry === undefined || entry.isFile()) return;
    if (!entry.isDirectory()) throw new Fail('unsafe', p);
  }
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      this.orig.set(p, diskEntry(p)?.isFile() ? readFileSync(p, 'utf8') : null);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  read(p: string): string {
    const text = this.get(p);
    if (text === null) throw new Fail('missing', p);
    return text;
  }

  requireVacant(p: string, movingFrom?: string): void {
    if (this.get(p) !== null || diskEntry(p)?.isDirectory()) throw new Fail('exists', p);
    for (const parent of parents(p)) {
      if (parent !== movingFrom && this.get(parent) !== null) throw new Fail('exists', p);
    }
    for (const [path, text] of this.now) {
      if (text !== null && path.startsWith(`${p}/`)) throw new Fail('exists', p);
    }
  }

  move(from: string, to: string, text: string): void {
    this.now.set(from, null);
    this.now.set(to, text);
    this.moves.push([from, to]);
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

function parseError(line: number): never {
  throw new Exit2(`error: parse ${line}`);
}

interface TextFile {
  lines: string[];
  lineBreak: string;
  finalBreak: boolean;
}

function readLines(text: string): TextFile {
  const nl = text.indexOf('\n');
  const lineBreak = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(lineBreak);
  const finalBreak = text.endsWith(lineBreak);
  if (finalBreak) lines.pop();
  return { lines, lineBreak, finalBreak };
}

function writeLines({ lines, lineBreak, finalBreak }: TextFile): string {
  return lines.length === 0 ? '' : lines.join(lineBreak) + (finalBreak ? lineBreak : '');
}

function newFile(lines: string[], finalBreak = true): string {
  return writeLines({ lines, lineBreak: '\n', finalBreak });
}

const trimTrailing = (line: string): string => line.replace(/[ \t]+$/, '');
const indent = (line: string): string => /^[ \t]*/.exec(line)![0];
const trimEdges = (line: string): string => trimTrailing(line.slice(indent(line).length));

function matches(
  lines: string[], old: string[], strict: boolean, first = 0, last = lines.length - old.length,
): { tier: number; positions: number[] } | null {
  if (first > last) return null;
  for (const [tier, normalize] of [null, trimTrailing, trimEdges].entries()) {
    if (strict && tier > 0) break;
    const wanted = normalize === null ? old : old.map(normalize);
    // After a mismatch, reuse the longest prefix that has already matched. This also finds overlaps.
    const prefix = new Array<number>(wanted.length).fill(0);
    for (let i = 1, count = 0; i < wanted.length; i++) {
      while (count > 0 && wanted[count] !== wanted[i]) count = prefix[count - 1]!;
      if (wanted[count] === wanted[i]) count++;
      prefix[i] = count;
    }
    const positions: number[] = [];
    for (let i = first, count = 0; i < last + wanted.length; i++) {
      const line = normalize === null ? lines[i]! : normalize(lines[i]!);
      while (count > 0 && wanted[count] !== line) count = prefix[count - 1]!;
      if (wanted[count] === line) count++;
      if (count === wanted.length) {
        positions.push(i + 1 - count);
        count = prefix[count - 1]!;
      }
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface LineEdit {
  old: string[];
  replacement: { text: string; context?: number }[];
}

function lineEdit(body: string[]): LineEdit {
  const old: LineEdit['old'] = [];
  const replacement: LineEdit['replacement'] = [];
  for (const line of body) {
    const text = line.slice(1);
    if (line === '' || line.startsWith(' ')) {
      replacement.push({ text, context: old.length });
      old.push(text);
    } else if (line.startsWith('-')) {
      old.push(text);
    } else if (line.startsWith('+')) {
      replacement.push({ text });
    }
  }
  return { old, replacement };
}

function replaceLines(file: TextFile, edit: LineEdit, at: number, tier: number): void {
  const oldIndent = tier === 2 ? indent(edit.old[0]!) : '';
  const fileIndent = tier === 2 ? indent(file.lines[at]!) : '';
  const next = edit.replacement.map(({ text, context }) => {
    if (context !== undefined) return file.lines[at + context]!;
    return tier === 2 && !blank(text) && text.startsWith(oldIndent)
      ? fileIndent + text.slice(oldIndent.length)
      : text;
  });
  file.lines = file.lines.slice(0, at).concat(next, file.lines.slice(at + edit.old.length));
}

function create(tree: Tree, path: string, text: string): void {
  tree.requireVacant(path);
  tree.now.set(path, text);
}

function remove(tree: Tree, path: string): void {
  tree.read(path);
  tree.now.set(path, null);
}

function change(tree: Tree, path: string, to: string | null, apply: (file: TextFile) => void): void {
  const file = readLines(tree.read(path));
  if (to !== null) tree.requireVacant(to, path);
  apply(file);
  const text = writeLines(file);
  if (to === null) tree.now.set(path, text);
  else tree.move(path, to, text);
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | undefined;
  let candidate: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimEnd() !== '<<<<<<< SEARCH') {
      const text = line.trim();
      if (text !== '' && !text.startsWith('```')) candidate = text;
      continue;
    }

    const path = candidate ?? previousPath;
    if (path === undefined) parseError(i + 1);
    let middle = i + 1;
    while (middle < lines.length && lines[middle]!.trimEnd() !== '=======') middle++;
    let end = middle + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end++;
    if (end >= lines.length) parseError(i + 1);

    const old = lines.slice(i + 1, middle);
    const next = lines.slice(middle + 1, end);
    const edit: LineEdit = { old, replacement: next.map((text) => ({ text })) };
    edits.push((tree) => {
      requireSafe(path);
      if (old.length === 0) {
        create(tree, path, newFile(next));
        return;
      }
      change(tree, path, null, (file) => {
        const match = matches(file.lines, old, strict);
        if (match === null) throw new Fail('no-match', path);
        if (match.positions.length !== 1) throw new Fail('ambiguous', path);
        replaceLines(file, edit, match.positions[0]!, match.tier);
      });
    });
    previousPath = path;
    candidate = undefined;
    i = end;
  }
  return edits;
}

interface Hunk {
  start: number;
  body: string[];
  edit: LineEdit;
}

function gitHeader(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

function pathPair(lines: string[], i: number): boolean {
  return lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
}

function unifiedPath(line: string): string | null {
  const path = line.slice(4).split('\t', 1)[0]!.trim();
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}

function bodyEndsWithBreak(body: string[], creation = false): boolean {
  const last = body.findLastIndex((line) => line.startsWith('+') ||
    (!creation && (line === '' || line.startsWith(' '))));
  return last < 0 || !(body[last + 1] ?? '').startsWith('\\');
}

function applyHunks(file: TextFile, hunks: Hunk[], path: string, strict: boolean): void {
  let delta = 0;
  for (const { start, body, edit } of hunks) {
    const count = edit.old.length;
    let at = Math.max(0, Math.min(file.lines.length, start + delta));
    let tier = 0;
    if (count !== 0) {
      const match = matches(file.lines, edit.old, strict);
      if (match === null) throw new Fail('no-match', path);
      const hint = Math.max(0, Math.min(file.lines.length, start - 1 + delta));
      at = match.positions[0]!;
      for (const position of match.positions) {
        if (Math.abs(position - hint) < Math.abs(at - hint)) at = position;
      }
      tier = match.tier;
    }
    if (at + count === file.lines.length) file.finalBreak = bodyEndsWithBreak(body);
    replaceLines(file, edit, at, tier);
    delta += edit.replacement.length - count;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    let git: RegExpExecArray | null = null;
    if (gitHeader(line)) {
      git = /^diff --git a\/(.+?) b\/(.+)$/s.exec(line);
      if (git === null) parseError(i + 1);
      i++;
    } else if (!pathPair(lines, i)) {
      if (line.startsWith('@@')) parseError(i + 1);
      i++;
      continue;
    }

    let pair: [string | null, string | null] | null = null;
    let renameFrom = git?.[1] ?? '';
    let renameTo = git?.[2] ?? '';
    let adding = false;
    let deleting = false;
    const hunks: Hunk[] = [];
    while (i < lines.length) {
      const line = lines[i]!;
      if (gitHeader(line)) break;
      if (pathPair(lines, i)) {
        if (pair !== null || hunks.length !== 0) break;
        pair = [unifiedPath(line), unifiedPath(lines[i + 1]!)];
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) {
        const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
        if (header === null) parseError(i + 1);
        const first = ++i;
        while (i < lines.length && !gitHeader(lines[i]!) && !pathPair(lines, i) &&
          (lines[i] === '' || /^[ +\\-]/.test(lines[i]!))) i++;
        let end = i;
        while (end > first && lines[end - 1] === '') end--;
        const body = lines.slice(first, end);
        hunks.push({ start: Number(header[1]), body, edit: lineEdit(body) });
        continue;
      }
      if (hunks.length === 0) {
        if (line.startsWith('--- ')) parseError(i + 2);
        if (line.startsWith('rename from ')) renameFrom = line.slice(12).trim();
        if (line.startsWith('rename to ')) renameTo = line.slice(10).trim();
        if (/^new file mode(?: |$)/.test(line)) adding = true;
        if (/^deleted file mode(?: |$)/.test(line)) deleting = true;
      }
      i++;
    }

    const [from, to] = pair ?? [renameFrom, renameTo];
    edits.push((tree) => {
      if (from !== null) requireSafe(from);
      if (to !== null && to !== from) requireSafe(to);
      if (adding || from === null) {
        if (to === null) throw new Fail('unsafe', '');
        const added: string[] = [];
        let finalBreak = true;
        for (const { body } of hunks) {
          const additions = body.filter((line) => line.startsWith('+'));
          if (additions.length !== 0) finalBreak = bodyEndsWithBreak(body, true);
          for (const line of additions) added.push(line.slice(1));
        }
        create(tree, to, newFile(added, finalBreak));
      } else if (deleting || to === null) {
        remove(tree, from);
      } else {
        change(tree, from, from === to ? null : to, (file) => applyHunks(file, hunks, from, strict));
      }
    });
  }
  return edits;
}

const v4aSection = /^\*\*\* (Add|Delete|Update) File: (.*)$/s;
const moveTo = '*** Move to: ';

function v4aBodyLine(line: string): boolean {
  return line.length === 0 || line[0] === ' ' || line[0] === '-' || line[0] === '+';
}

interface Chunk {
  anchor: string;
  atEnd: boolean;
  edit: LineEdit;
}

function v4aChunks(lines: string[], first: number, end: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = first; i < end;) {
    const line = lines[i]!;
    let anchor = '';
    if (line.startsWith('@@')) {
      anchor = line.slice(2).trim();
      i++;
    } else if (chunks.length !== 0 || !v4aBodyLine(line)) {
      parseError(i + 1);
    }
    const bodyStart = i;
    while (i < end && v4aBodyLine(lines[i]!)) i++;
    const edit = lineEdit(lines.slice(bodyStart, i));
    const atEnd = i < end && lines[i] === '*** End of File';
    if (atEnd) i++;
    chunks.push({ anchor, atEnd, edit });
  }
  return chunks;
}

function applyChunks(file: TextFile, chunks: Chunk[], path: string, strict: boolean): void {
  let cursor = 0;
  for (const { anchor, atEnd, edit } of chunks) {
    if (anchor !== '') {
      const match = matches(file.lines, [anchor], strict, cursor);
      if (match === null) throw new Fail('no-match', path);
      cursor = match.positions[0]! + 1;
    }

    const last = file.lines.length - edit.old.length;
    let at = atEnd ? last : cursor;
    let tier = 0;
    if (edit.old.length > 0) {
      const match = matches(file.lines, edit.old, strict, Math.max(cursor, at), last);
      if (match === null) throw new Fail('no-match', path);
      at = match.positions[0]!;
      tier = match.tier;
    }
    replaceLines(file, edit, at, tier);
    cursor = at + edit.replacement.length;
  }
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') parseError(Math.max(0, first) + 1);
  const last = lines.findLastIndex((line) => !blank(line));
  if (lines[last]!.trim() !== '*** End Patch') parseError(lines.length + 1);

  const edits: Edit[] = [];
  for (let i = first + 1; i < last;) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const section = v4aSection.exec(line);
    if (section === null) parseError(i + 1);
    const kind = section[1]!;
    const path = section[2]!.trim();
    const header = i++;
    let next = i;
    while (next < last && !v4aSection.test(lines[next]!)) next++;
    let end = next;
    while (end > i && blank(lines[end - 1]!)) end--;

    if (kind === 'Add') {
      const added = lines.slice(i, end).map((line, offset) => {
        if (line !== '' && !line.startsWith('+')) parseError(i + offset + 1);
        return line.slice(1);
      });
      edits.push((tree) => {
        requireSafe(path);
        create(tree, path, newFile(added));
      });
    } else if (kind === 'Delete') {
      if (i < end) parseError(i + 1);
      edits.push((tree) => {
        requireSafe(path);
        remove(tree, path);
      });
    } else {
      const to = i < end && lines[i]!.startsWith(moveTo) ? lines[i++]!.slice(moveTo.length).trim() : null;
      const chunks = v4aChunks(lines, i, end);
      if (to === null && chunks.length === 0) parseError(header + 1);
      edits.push((tree) => {
        requireSafe(path);
        if (to !== null) requireSafe(to);
        change(tree, path, to, (file) => applyChunks(file, chunks, path, strict));
      });
    }
    i = next;
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    requireSafe(p);
    return tree.read(p);
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      requireSafe(p);
      create(tree, p, text);
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
      const file = readLines(exists(tree));
      if (line < 0 || line > file.lines.length) throw new Fail('no-match', p);
      file.lines = file.lines.slice(0, line).concat(add, file.lines.slice(line));
      tree.now.set(p, writeLines(file));
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

interface FileChange {
  before: string | null;
  after: string | null;
}

function changeRows(changes: Map<string, FileChange>, moves: Tree['moves']): string[] {
  const rows = new Map<string, string>();
  for (const [path, { before, after }] of changes) {
    rows.set(path, `${before === null ? 'A' : after === null ? 'D' : 'M'} ${path}`);
  }
  for (const [from, to] of moves) {
    if (rows.get(from)?.startsWith('D ') && rows.get(to)?.startsWith('A ')) {
      rows.delete(from);
      rows.set(to, `R ${from} -> ${to}`);
    }
  }
  return [...rows.keys()]
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((path) => rows.get(path)!);
}

function commit(changes: Map<string, FileChange>): void {
  if (changes.size === 0) return;
  const work = mkdtempSync('.mend-');
  const undo: (() => void)[] = [];
  const staged = new Map<string, string>();
  const backups = new Map<string, string>();
  try {
    let index = 0;
    for (const [path, { before, after }] of changes) {
      requireSafe(path);
      const entry = diskEntry(path);
      const current = entry?.isFile() ? readFileSync(path, 'utf8') : null;
      if (current !== before || entry?.isDirectory()) throw new Error(`Path changed during edit: ${path}`);
      index++;
      if (before !== null) backups.set(path, join(work, `${index}.old`));
      if (after !== null) {
        const file = join(work, `${index}.new`);
        writeFileSync(file, after);
        if (entry !== undefined) chmodSync(file, entry.mode & 0o777);
        staged.set(path, file);
      }
    }
    for (const [path, backup] of backups) {
      renameSync(path, backup);
      undo.push(() => {
        if (diskEntry(path) !== undefined) throw new Error(`Path occupied during rollback: ${path}`);
        renameSync(backup, path);
      });
    }
    for (const [path, file] of staged) {
      requireSafe(path);
      for (const parent of parents(path)) {
        if (diskEntry(parent) !== undefined) continue;
        mkdirSync(parent);
        undo.push(() => rmdirSync(parent));
      }
      if (diskEntry(path) !== undefined) throw new Error(`Path occupied during edit: ${path}`);
      renameSync(file, path);
      undo.push(() => unlinkSync(path));
    }
  } catch (error) {
    const failures: unknown[] = [error];
    for (const step of undo.reverse()) {
      try {
        step();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, `Rollback incomplete. Recovery files are in ${work}`);
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
  rmSync(work, { recursive: true, force: true });
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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changes = new Map<string, FileChange>();
  for (const [path, after] of tree.now) {
    const before = tree.original(path);
    if (before !== after) changes.set(path, { before, after });
  }
  const rows = changeRows(changes, tree.moves);
  if (!check) {
    try {
      commit(changes);
    } catch (error) {
      const detail = error instanceof Fail ? `${error.code} ${error.path}` : String(error);
      writeSync(2, `mend: ${detail}\n`);
      return { code: 1, out: [] };
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
