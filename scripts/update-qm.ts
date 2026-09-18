import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { errMessage } from "../src/util/errors.ts";
import {
  emptyForkSideHunks,
  forkShape,
  importCandidates,
  learnedReplacements,
  markerLines,
  parsePorcelain,
  relativeImports,
  relativeSpecifier,
  removalReason,
  removedImportTarget,
  replaceSpecifier,
  sideEffectPrecedents,
  type ForkShape,
} from "./lib/update-qm.ts";

const USAGE = `usage: node scripts/update-qm.ts <command> [--upstream <ref>]

  merge      merge <ref> (default upstream/main) into the current branch, resolve every
             conflict caused by the fork's deletions, drop upstream's new files under
             directories the fork removed, rewrite or strip side-effect imports of
             removed files the way the fork's own history did, and write
             .generated/update-qm/report.md
  conflicts  annotate the conflicts left for hand resolution: which hunks have an empty
             fork side, which lines import removed paths, and the fork's own change to
             each file since the merge base
  check      fail on unmerged paths, leftover conflict markers, and imports of paths
             the fork removed; list files present under paths the fork removed
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parsedArgs(): { flags: { upstream?: string }; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { upstream: { type: "string" } } });
    return { flags: values, positionals };
  } catch (e: unknown) {
    return fail(`${errMessage(e)}\n\n${USAGE}`);
  }
}

const { flags, positionals } = parsedArgs();
const root = git(["rev-parse", "--show-toplevel"]);
process.chdir(root);
const reportDir = path.join(root, ".generated", "update-qm");
const SOURCE = /\.m?[jt]s$/;

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 }).trimEnd();
}

function gitList(args: string[]): string[] {
  return git([...args, "-z"])
    .split("\0")
    .filter(Boolean);
}

function gitStatus(): { code: string; file: string }[] {
  return parsePorcelain(git(["status", "--porcelain=v1", "-z", "--no-renames"]));
}

function unmergedFiles(): string[] {
  return gitList(["diff", "--name-only", "--diff-filter=U"]);
}

function worktreeFiles(): Set<string> {
  return new Set(
    gitList(["ls-files", "--cached", "--others", "--exclude-standard"]).filter((file) =>
      existsSync(path.join(root, file)),
    ),
  );
}

function mergeHead(): string | undefined {
  return existsSync(path.join(git(["rev-parse", "--git-dir"]), "MERGE_HEAD")) ? "MERGE_HEAD" : undefined;
}

function upstreamRef(): string {
  return flags.upstream ?? mergeHead() ?? "upstream/main";
}

interface Sync {
  base: string;
  shape: ForkShape;
  files: Set<string>;
}

function syncAgainst(upstream: string): Sync {
  const base = git(["merge-base", "HEAD", upstream]);
  return {
    base,
    shape: forkShape(
      gitList(["ls-tree", "-r", "--name-only", base]),
      gitList(["ls-tree", "-r", "--name-only", "HEAD"]),
    ),
    files: worktreeFiles(),
  };
}

function gitBatch(args: string[], files: readonly string[]): void {
  for (let i = 0; i < files.length; i += 200) git([...args, "--", ...files.slice(i, i + 200)]);
}

function bullets(items: readonly string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

function resolveImport(sync: Sync, fromFile: string, specifier: string): string | undefined {
  return importCandidates(fromFile, specifier).find((candidate) => sync.files.has(candidate));
}

function removedImport(
  sync: Sync,
  fromFile: string,
  specifier: string,
): { target: string; reason: string } | undefined {
  return removedImportTarget(sync.shape, fromFile, specifier, (file) => sync.files.has(file));
}

function forkRenames(sync: Sync): Map<string, string> {
  const renames = new Map<string, string>();
  const fields = gitList(["diff", "-M", "--name-status", "--diff-filter=R", sync.base, "HEAD"]);
  for (let i = 0; i + 2 < fields.length; i += 3) renames.set(fields[i + 1]!, fields[i + 2]!);
  return renames;
}

function sourceFiles(sync: Sync): string[] {
  return [...sync.files].filter((file) => SOURCE.test(file));
}

function read(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

function fixtureReplacements(sync: Sync): Map<string, string> {
  const diff = git(["diff", "--no-renames", "-U0", sync.base, "HEAD", "--", "*.ts", "*.mts", "*.mjs", "*.js"]);
  return learnedReplacements(
    sideEffectPrecedents(diff),
    (file, specifier) => resolveImport(sync, file, specifier),
    (file, specifier) => removedImport(sync, file, specifier)?.target ?? importCandidates(file, specifier)[0]!,
  );
}

interface Rewrite {
  rewritten: string[];
  stripped: { file: string; line: number; specifier: string }[];
  files: string[];
}

function rewriteSideEffectImports(sync: Sync, renames: Map<string, string>): Rewrite {
  const replacements = fixtureReplacements(sync);
  const unmerged = new Set(unmergedFiles());
  const rewritten: string[] = [];
  const stripped: Rewrite["stripped"] = [];
  const files: string[] = [];
  for (const file of gitList(["diff", "--name-only", "--cached", "HEAD"])) {
    if (unmerged.has(file) || !SOURCE.test(file) || !sync.files.has(file)) continue;
    const source = read(file);
    const lines = source.split("\n");
    const drop = new Set<number>();
    let changed = false;
    const refs = relativeImports(source);
    const present = new Set(refs.map((ref) => resolveImport(sync, file, ref.specifier)));
    for (const ref of refs) {
      const removed = ref.sideEffect ? removedImport(sync, file, ref.specifier) : undefined;
      if (!removed) continue;
      const replacement = replacements.get(removed.target) ?? renames.get(removed.target);
      const at = ref.line - 1;
      if (replacement !== undefined && !present.has(replacement) && lines[at] !== undefined) {
        const specifier = relativeSpecifier(file, replacement);
        lines[at] = replaceSpecifier(lines[at], ref.specifier, specifier);
        rewritten.push(`${file}:${ref.line} ${ref.specifier} -> ${specifier}`);
      } else {
        drop.add(at);
        stripped.push({ file, line: ref.line, specifier: ref.specifier });
      }
      changed = true;
    }
    if (!changed) continue;
    writeFileSync(path.join(root, file), lines.filter((_, index) => !drop.has(index)).join("\n"));
    files.push(file);
  }
  return { rewritten, stripped, files };
}

function removedImports(sync: Sync, file: string): string[] {
  if (!SOURCE.test(file) || !sync.files.has(file)) return [];
  return relativeImports(read(file))
    .filter((ref) => removedImport(sync, file, ref.specifier))
    .map((ref) => ref.specifier);
}

function danglingImports(sync: Sync, files: Iterable<string>): string[] {
  const dangling: string[] = [];
  for (const file of files) {
    if (!SOURCE.test(file) || !sync.files.has(file)) continue;
    for (const ref of relativeImports(read(file))) {
      const removed = removedImport(sync, file, ref.specifier);
      if (removed) dangling.push(`${file}:${ref.line} imports ${ref.specifier} (${removed.reason})`);
    }
  }
  return dangling;
}

function merge(): void {
  const upstream = upstreamRef();
  if (mergeHead()) fail("a merge is already in progress; finish or abort it first");
  if (gitStatus().length) fail("the working tree must be clean before merging");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") fail("check out a sync branch first");
  const base = git(["merge-base", "HEAD", upstream]);
  const range = `${git(["rev-parse", "--short", base])}..${git(["rev-parse", "--short", upstream])}`;
  const commits = git(["log", "--oneline", `${base}..${upstream}`])
    .split("\n")
    .filter(Boolean)
    .map((subject) =>
      subject
        .replace(/\s*\(#\d+\)/g, "")
        .replace(/#\d+/g, "")
        .trim(),
    );
  if (commits.length === 0) {
    console.log(`already up to date with ${upstream}`);
    return;
  }
  const result = spawnSync("git", ["merge", "--no-commit", "--no-ff", upstream], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (result.status !== 0 && !mergeHead()) fail(`git merge failed:\n${result.stdout}${result.stderr}`);
  const sync = syncAgainst(upstream);
  const renames = forkRenames(sync);

  const deleted: string[] = [];
  const dropped: string[] = [];
  const droppedPaths: string[] = [];
  const manual: string[] = [];
  const added: string[] = [];
  for (const { code, file } of gitStatus()) {
    const reason = code === "A " || code === "DU" ? removalReason(sync.shape, file) : undefined;
    const renamed = code === "DU" ? renames.get(file) : undefined;
    if (renamed) {
      manual.push(`${file} (DU; the fork renamed it to ${renamed}, so carry upstream's change there)`);
    } else if (code === "DU" && reason) {
      deleted.push(file);
    } else if (code === "DU") {
      manual.push(`${file} (DU; upstream moved it here from a path the fork removed, so decide whether it stays)`);
    } else if (reason) {
      dropped.push(`${file} (${reason})`);
      droppedPaths.push(file);
    } else if (code === "A ") {
      added.push(file);
    } else if (code.includes("U") || code === "AA" || code === "DD") {
      manual.push(`${file} (${code.trim()})`);
    }
  }
  gitBatch(["rm", "-qf"], [...deleted, ...droppedPaths]);
  for (const file of [...deleted, ...droppedPaths]) sync.files.delete(file);
  const imports = rewriteSideEffectImports(sync, renames);
  gitBatch(["add"], imports.files);
  const unmerged = new Set(unmergedFiles());
  const dangling = danglingImports(
    sync,
    gitList(["diff", "--name-only", "--cached", "HEAD"]).filter((file) => !unmerged.has(file)),
  );
  const kept = added.map((file) => {
    const removed = [
      ...removedImports(sync, file),
      ...imports.stripped.filter((entry) => entry.file === file).map((entry) => entry.specifier),
    ];
    return removed.length
      ? `${file} (imports removed ${removed.join(", ")}; likely exists only for that feature)`
      : file;
  });

  mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.md");
  writeFileSync(
    reportPath,
    `# Upstream sync ${range}

Merged ${commits.length} upstream commit(s) from ${upstream} into ${branch}.

## Upstream commits

${bullets(commits)}

## Resolved as deleted (the fork removed the file, upstream modified it)

${bullets(deleted)}

## Dropped (upstream added the file under a path the fork removed)

${bullets(dropped)}

## Side-effect imports rewritten to the fork's replacement or renamed path

${bullets(imports.rewritten)}

## Side-effect imports of removed files stripped

${bullets(imports.stripped.map((entry) => `${entry.file}:${entry.line} imported ${entry.specifier}`))}

## Imports of removed paths left in merged files (fix before committing)

${bullets(dangling)}

## Left for hand resolution

${bullets(manual)}

## New upstream files kept (review for removed-feature material)

${bullets(kept)}
`,
  );
  console.log(
    `merged ${range}: ${deleted.length} deletion conflict(s) resolved, ${dropped.length} upstream addition(s) dropped, ${imports.rewritten.length} side-effect import(s) rewritten, ${imports.stripped.length} stripped, ${manual.length} conflict(s) left, ${added.length} new file(s) kept`,
  );
  console.log(`report: ${path.relative(root, reportPath)}`);
  console.log(
    manual.length
      ? "resolve the remaining conflicts by hand; run `node scripts/update-qm.ts conflicts` for the annotated view"
      : "no conflicts left; run `node scripts/update-qm.ts check`, then commit the merge",
  );
}

function conflicts(): void {
  const sync = syncAgainst(upstreamRef());
  const unmerged = unmergedFiles();
  if (unmerged.length === 0) {
    console.log("no unresolved conflicts");
    return;
  }
  const shortBase = git(["rev-parse", "--short", sync.base]);
  for (const file of unmerged) {
    const source = read(file);
    const { hunks, emptyOurs } = emptyForkSideHunks(source);
    const forkStat =
      git(["diff", "--shortstat", sync.base, "HEAD", "--", file]).trim() ||
      "unchanged by the fork since the merge base";
    console.log(`\n${file}: ${hunks} hunk(s), ${emptyOurs} with an empty fork side`);
    console.log(`  fork change since ${shortBase}: ${forkStat}`);
    for (const ref of relativeImports(source)) {
      const removed = removedImport(sync, file, ref.specifier);
      if (removed) console.log(`  L${ref.line} imports ${ref.specifier} (${removed.reason})`);
    }
  }
  console.log(
    `\nfor each file: read the fork's change (git diff ${shortBase} HEAD -- <file>), keep upstream's core additions, and leave out the removed-feature lines flagged above`,
  );
}

function check(): void {
  const sync = syncAgainst(upstreamRef());
  const problems = unmergedFiles().map((file) => `${file}: still unmerged in the index`);
  const notes: string[] = [];
  for (const file of gitList(["diff", "--name-only", sync.base])) {
    if (!sync.files.has(file)) continue;
    const lines = markerLines(read(file));
    if (lines.length) problems.push(`${file}: conflict markers left at line(s) ${lines.join(", ")}`);
  }
  for (const file of sync.files) {
    const reason = removalReason(sync.shape, file);
    if (reason) notes.push(`${file}: present although ${reason}; keep it only if restored on purpose`);
  }
  problems.push(...danglingImports(sync, sourceFiles(sync)));
  if (notes.length) console.log(notes.join("\n"));
  if (problems.length) {
    console.log(problems.join("\n"));
    fail(`${problems.length} problem(s); fix them before committing the merge`);
  }
  console.log("clean: no unmerged paths, conflict markers, or imports of removed paths");
}

const command = positionals[0];
try {
  if (command === "merge") merge();
  else if (command === "conflicts") conflicts();
  else if (command === "check") check();
  else fail(USAGE);
} catch (e: unknown) {
  fail(errMessage(e));
}
