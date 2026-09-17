import path from "node:path";

export interface ForkShape {
  baseFiles: ReadonlySet<string>;
  headFiles: ReadonlySet<string>;
  baseDirs: ReadonlySet<string>;
  headDirs: ReadonlySet<string>;
}

function ancestorDirs(files: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    let dir = path.posix.dirname(file);
    while (dir !== "." && dir !== "/" && !dirs.has(dir)) {
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  return dirs;
}

export function forkShape(baseFiles: Iterable<string>, headFiles: Iterable<string>): ForkShape {
  const base = new Set(baseFiles);
  const head = new Set(headFiles);
  return { baseFiles: base, headFiles: head, baseDirs: ancestorDirs(base), headDirs: ancestorDirs(head) };
}

export function removedAncestor(shape: ForkShape, file: string): string | undefined {
  let dir = path.posix.dirname(file);
  while (dir !== "." && dir !== "/") {
    if (shape.headDirs.has(dir)) return undefined;
    if (shape.baseDirs.has(dir)) return dir;
    dir = path.posix.dirname(dir);
  }
  return undefined;
}

export function removalReason(shape: ForkShape, file: string): string | undefined {
  if (shape.baseFiles.has(file) && !shape.headFiles.has(file)) return "file removed by the fork";
  const dir = removedAncestor(shape, file);
  return dir === undefined ? undefined : `under ${dir}/, a directory the fork removed`;
}

const ATTRIBUTES = String.raw`(?:\s*(?:with|assert)\s*\{[^}]*\})?`;
const SPECIFIER_PATTERNS = [
  new RegExp(String.raw`\bfrom\s+["'](\.[^"'\n]+)["']${ATTRIBUTES}\s*;?\s*$`),
  new RegExp(String.raw`^\s*import\s+["'](\.[^"'\n]+)["']${ATTRIBUTES}\s*;?\s*$`),
  /^[^"'\n]*?\b(?:import|require)\s*\(\s*["'](\.[^"'\n]+)["']\s*\)/,
];
const BARE_STATEMENT = /^\s*(?:await\s+)?(?:import|require)\s*\(\s*["'][^"'\n]+["']\s*\)\s*;?\s*$/;

export interface ImportRef {
  line: number;
  specifier: string;
  sideEffect: boolean;
}

export function relativeImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  source.split("\n").forEach((text, index) => {
    SPECIFIER_PATTERNS.forEach((pattern, at) => {
      const specifier = pattern.exec(text)?.[1];
      if (specifier === undefined) return;
      refs.push({ line: index + 1, specifier, sideEffect: at === 1 || BARE_STATEMENT.test(text) });
    });
  });
  return refs;
}

export function importCandidates(fromFile: string, specifier: string): string[] {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [target];
  if (target.endsWith(".js")) candidates.push(`${target.slice(0, -3)}.ts`);
  if (target.endsWith(".mjs")) candidates.push(`${target.slice(0, -4)}.mts`);
  if (!path.posix.extname(target))
    candidates.push(`${target}.ts`, `${target}.js`, `${target}/index.ts`, `${target}/index.js`);
  return candidates;
}

export function removedImportTarget(
  shape: ForkShape,
  fromFile: string,
  specifier: string,
  exists: (file: string) => boolean,
): { target: string; reason: string } | undefined {
  const candidates = importCandidates(fromFile, specifier);
  if (candidates.some(exists)) return undefined;
  const removed = candidates.filter((target) => removalReason(shape, target));
  const target = removed.find((file) => shape.baseFiles.has(file)) ?? removed[0];
  return target === undefined ? undefined : { target, reason: removalReason(shape, target)! };
}

export function relativeSpecifier(fromFile: string, target: string): string {
  const relative = path.posix.relative(path.posix.dirname(fromFile), target);
  return relative.startsWith("./") || relative.startsWith("../") ? relative : `./${relative}`;
}

export function replaceSpecifier(line: string, specifier: string, replacement: string): string {
  return line.replace(`"${specifier}"`, `"${replacement}"`).replace(`'${specifier}'`, `'${replacement}'`);
}

export interface Precedent {
  file: string;
  removed: string[];
  added: string[];
}

export function sideEffectPrecedents(diff: string): Precedent[] {
  const precedents: Precedent[] = [];
  let current: Precedent | undefined;
  for (const line of diff.split("\n")) {
    if (/^--- (a\/|\/dev\/null)/.test(line) || line === "+++ /dev/null") {
      current = undefined;
      continue;
    }
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header?.[1]) {
      current = { file: header[1], removed: [], added: [] };
      precedents.push(current);
      continue;
    }
    if (!current || !/^[+-]/.test(line)) continue;
    const ref = relativeImports(line.slice(1))[0];
    if (!ref?.sideEffect) continue;
    (line.startsWith("-") ? current.removed : current.added).push(ref.specifier);
  }
  return precedents;
}

export function learnedReplacements(
  precedents: readonly Precedent[],
  resolve: (file: string, specifier: string) => string | undefined,
  removedTarget: (file: string, specifier: string) => string,
): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  for (const { file, removed, added } of precedents) {
    for (const gone of removed) {
      const target = removedTarget(file, gone);
      const tally = votes.get(target) ?? new Map<string, number>();
      votes.set(target, tally);
      for (const specifier of added) {
        const resolved = resolve(file, specifier);
        if (resolved) tally.set(resolved, (tally.get(resolved) ?? 0) + 1);
      }
    }
  }
  const replacements = new Map<string, string>();
  for (const [target, tally] of votes) {
    const ranked = [...tally].sort((a, b) => b[1] - a[1]);
    const best = ranked[0];
    if (best && best[1] >= 2 && (ranked[1]?.[1] ?? 0) < best[1]) replacements.set(target, best[0]);
  }
  return replacements;
}

export function emptyForkSideHunks(source: string): { hunks: number; emptyOurs: number } {
  let hunks = 0;
  let emptyOurs = 0;
  let ours: string[] | undefined;
  for (const line of source.split("\n")) {
    if (line.startsWith("<<<<<<< ")) {
      ours = [];
      hunks++;
    } else if (ours && (line.startsWith("||||||| ") || /^=======\r?$/.test(line))) {
      if (ours.every((text) => text.trim() === "")) emptyOurs++;
      ours = undefined;
    } else if (ours) {
      ours.push(line);
    }
  }
  return { hunks, emptyOurs };
}

export function markerLines(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((line, index) => {
    if (line.startsWith("<<<<<<< ") || line.startsWith(">>>>>>> ")) lines.push(index + 1);
  });
  return lines;
}

export function parsePorcelain(raw: string): { code: string; file: string }[] {
  const entries: { code: string; file: string }[] = [];
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const code = field.slice(0, 2);
    const file = field.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) i++;
    entries.push({ code, file });
  }
  return entries;
}
