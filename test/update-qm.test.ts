import { test } from "node:test";
import assert from "node:assert/strict";
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
  removedAncestor,
  removedImportTarget,
  replaceSpecifier,
  sideEffectPrecedents,
} from "../scripts/lib/update-qm.ts";

const shape = forkShape(
  [
    "src/index.ts",
    "src/deploy/fly.ts",
    "src/runs/task-protection.ts",
    "plugins/web-ui/src/main.ts",
    "plugins/chassis/src/http.ts",
    "test/fly.test.ts",
  ],
  [
    "src/index.ts",
    "src/runs/guard/task-protection.ts",
    "plugins/chassis/src/http.ts",
    "plugins/chassis/src/new.ts",
    "test/keep.test.ts",
  ],
);

test("a directory with files at the base and none in the fork is a removed directory", () => {
  assert.equal(removedAncestor(shape, "plugins/web-ui/src/new-view.ts"), "plugins/web-ui/src");
  assert.equal(removedAncestor(shape, "plugins/web-ui/test/new.test.ts"), "plugins/web-ui");
  assert.equal(removedAncestor(shape, "src/deploy/aws.ts"), "src/deploy");
});

test("directories the fork still populates are kept, as are brand new directories", () => {
  assert.equal(removedAncestor(shape, "plugins/chassis/src/added.ts"), undefined);
  assert.equal(removedAncestor(shape, "src/runs/new.ts"), undefined);
  assert.equal(removedAncestor(shape, "docs/new/page.md"), undefined);
});

test("removalReason names deleted files before deleted directories", () => {
  assert.equal(removalReason(shape, "test/fly.test.ts"), "file removed by the fork");
  assert.equal(removalReason(shape, "src/deploy/fly.ts"), "file removed by the fork");
  assert.equal(removalReason(shape, "src/deploy/porter.ts"), "under src/deploy/, a directory the fork removed");
  assert.equal(removalReason(shape, "test/new.test.ts"), undefined);
  assert.equal(removalReason(shape, "src/index.ts"), undefined);
});

test("removedImportTarget names the removed path an unresolved import points at, trying js as ts", () => {
  const exists = (file: string) => file === "src/index.ts";
  assert.deepEqual(removedImportTarget(shape, "test/x.test.ts", "../src/deploy/fly.js", exists), {
    target: "src/deploy/fly.ts",
    reason: "file removed by the fork",
  });
  assert.equal(removedImportTarget(shape, "test/x.test.ts", "../src/index.ts", exists), undefined);
  assert.equal(removedImportTarget(shape, "test/x.test.ts", "./typo.ts", exists), undefined);
});

test("relativeImports finds static, dynamic, side-effect and require specifiers with line numbers", () => {
  const source = [
    'import { a } from "./a.ts";',
    'import type { B } from "../b.ts";',
    'import "./side-effect.ts";',
    'const c = await import("./c.ts");',
    'const d = require("./d.js");',
    'import external from "node:path";',
    'import pkg from "some-package";',
    'const fixture = ["import { e } from \\"./e.ts\\";", "await import(\\"./f.ts\\")"];',
    "import {",
    "  g,",
    '} from "./g.ts";',
    '  await import("./h.ts");',
    'import manifest from "./manifest.json" with { type: "json" };',
  ].join("\n");
  assert.deepEqual(relativeImports(source), [
    { line: 1, specifier: "./a.ts", sideEffect: false },
    { line: 2, specifier: "../b.ts", sideEffect: false },
    { line: 3, specifier: "./side-effect.ts", sideEffect: true },
    { line: 4, specifier: "./c.ts", sideEffect: false },
    { line: 5, specifier: "./d.js", sideEffect: false },
    { line: 11, specifier: "./g.ts", sideEffect: false },
    { line: 12, specifier: "./h.ts", sideEffect: true },
    { line: 13, specifier: "./manifest.json", sideEffect: false },
  ]);
});

test("importCandidates resolves relative to the importing file and maps js to ts", () => {
  assert.deepEqual(importCandidates("src/api/deps.ts", "../suggestions/activities.ts"), [
    "src/suggestions/activities.ts",
  ]);
  assert.deepEqual(importCandidates("src/a.ts", "./b.js"), ["src/b.js", "src/b.ts"]);
  assert.deepEqual(importCandidates("src/a.ts", "./lib"), [
    "src/lib",
    "src/lib.ts",
    "src/lib.js",
    "src/lib/index.ts",
    "src/lib/index.js",
  ]);
});

test("relativeSpecifier and replaceSpecifier rewrite an import to a new target", () => {
  assert.equal(relativeSpecifier("test/x.test.ts", "test/support/fake.ts"), "./support/fake.ts");
  assert.equal(relativeSpecifier("test/deep/x.test.ts", "test/support/fake.ts"), "../support/fake.ts");
  assert.equal(relativeSpecifier("root.ts", ".codex/x.ts"), "./.codex/x.ts");
  assert.equal(
    replaceSpecifier('import "./support/old.ts";', "./support/old.ts", "./support/new.ts"),
    'import "./support/new.ts";',
  );
});

test("side-effect precedents come from the fork's own diff and vote for a replacement", () => {
  const diff = [
    "--- a/test/one.test.ts",
    "+++ b/test/one.test.ts",
    '-import "./support/auto-fake-sprites.ts";',
    '+import "./support/auto-fake-smolmachines.ts";',
    ' import { x } from "./x.ts";',
    "--- a/test/two.test.ts",
    "+++ b/test/two.test.ts",
    '-import "./support/auto-fake-sprites.ts";',
    '+import "./support/auto-fake-smolmachines.ts";',
    '+import "./support/other.ts";',
    "--- a/test/three.test.ts",
    "+++ b/test/three.test.ts",
    '-import "./support/gone.ts";',
    "--- a/test/deleted.test.ts",
    "+++ /dev/null",
    '-import "./support/auto-fake-sprites.ts";',
    '-import "./support/other.ts";',
    "--- a/test/four.test.ts",
    "+++ b/test/four.test.ts",
    "--- x;",
    '-import "./support/auto-fake-sprites.ts";',
    '+import "./support/auto-fake-smolmachines.ts";',
  ].join("\n");
  const precedents = sideEffectPrecedents(diff);
  assert.deepEqual(precedents, [
    {
      file: "test/one.test.ts",
      removed: ["./support/auto-fake-sprites.ts"],
      added: ["./support/auto-fake-smolmachines.ts"],
    },
    {
      file: "test/two.test.ts",
      removed: ["./support/auto-fake-sprites.ts"],
      added: ["./support/auto-fake-smolmachines.ts", "./support/other.ts"],
    },
    { file: "test/three.test.ts", removed: ["./support/gone.ts"], added: [] },
    {
      file: "test/four.test.ts",
      removed: ["./support/auto-fake-sprites.ts"],
      added: ["./support/auto-fake-smolmachines.ts"],
    },
  ]);
  const target = (file: string, specifier: string) => importCandidates(file, specifier)[0]!;
  const replacements = learnedReplacements(precedents, target, target);
  assert.deepEqual(
    [...replacements],
    [["test/support/auto-fake-sprites.ts", "test/support/auto-fake-smolmachines.ts"]],
  );
});

test("emptyForkSideHunks counts hunks and those whose fork side is blank, ignoring a diff3 base", () => {
  const source = [
    "keep",
    "<<<<<<< HEAD",
    "=======",
    'import { x } from "./x.ts";',
    ">>>>>>> upstream/main",
    "<<<<<<< HEAD",
    "ours line",
    "||||||| merged common ancestors",
    "base line",
    "=======",
    "theirs line",
    ">>>>>>> upstream/main",
  ].join("\n");
  assert.deepEqual(emptyForkSideHunks(source), { hunks: 2, emptyOurs: 1 });
  assert.deepEqual(markerLines(source), [2, 5, 6, 12]);
  assert.deepEqual(markerLines("Title\n=======\n"), []);
});

test("parsePorcelain reads NUL-separated status entries", () => {
  const raw = ["DU src/deploy/fly.ts", "A  src/new.ts", "UU src/wiring.ts", "M  README.md", ""].join("\0");
  assert.deepEqual(parsePorcelain(raw), [
    { code: "DU", file: "src/deploy/fly.ts" },
    { code: "A ", file: "src/new.ts" },
    { code: "UU", file: "src/wiring.ts" },
    { code: "M ", file: "README.md" },
  ]);
});
