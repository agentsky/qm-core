---
name: update-qm
description: Update this core-only QM source fork by merging upstream core changes, keeping the fork's deletions, and opening a PR. Use when asked to "update qm", "sync from upstream", "pull in the latest qm".
---

# update-qm

This repository is a source fork of upstream qm that keeps only core: Slack is the only
surface, Helm is the only deployment path, and the local, E2B and Modal sandboxes are the
only sandbox providers. Relative to upstream it deleted the Fly, AWS, Porter and Sprites
providers, the qm CLI, the portal, auth, web-ui and admin plugins, the browser-surface
docs and screenshots, and the tests that covered them. Upstream keeps changing all of
that, so every sync produces the same two kinds of noise: modify/delete conflicts on
files the fork removed, and new upstream files under directories the fork removed. The
sync tool resolves both mechanically; you resolve the content conflicts in kept files.

Nothing here maintains a list of removed paths. The tool derives the removed set from
git on every run: a file that exists at the merge base but not in the fork, or a
directory that has files at the merge base and none in the fork. After a sync lands,
the merge base moves to the merged upstream commit, which still carries those files, so
the derivation stays stable from sync to sync.

## Identify the checkout

Run `git remote -v`. If `origin` is `yc-software/qm`, this is upstream itself and not a
sync target. This fork's `origin` is its own repository; check that the `upstream` remote
points to `yc-software/qm` and add it if absent:

```bash
git remote add upstream https://github.com/yc-software/qm
```

Confirm shared history with `git merge-base main upstream/main` before merging. Never
merge fork history into upstream. Pass `--repo` to every `gh` command so it never picks
`upstream` as the base repository.

## Merge, never rebase

`origin/main` is published history that deploys and other clones track. Rebasing it onto
upstream rewrites those commits, so always merge.

```bash
git switch main
git pull --ff-only origin main
git fetch upstream
git switch -c codex/sync-upstream-<yyyy-mm-dd>
node scripts/update-qm.ts merge
```

`merge` refuses a dirty tree or an in-progress merge, runs
`git merge --no-commit --no-ff upstream/main`, then:

- resolves every modify/delete conflict where the fork deleted the file as a deletion,
  except when git's rename detection shows the fork moved the file, which it flags so
  upstream's change can be carried to the new path;
- drops every file upstream added under a directory the fork removed;
- rewrites side-effect imports of removed files the way the fork's own history did
  (`import "./support/auto-fake-sprites.ts"` becomes the smolmachines fixture because
  the fork made that substitution in every test), and strips those with no precedent,
  since a bare import binds nothing;
- leaves every other conflict for you;
- writes `.generated/update-qm/report.md` with the upstream commit range, the lists
  above, the conflicts left, and the new upstream files it kept, marking any kept file
  that imports a removed module.

If it prints "already up to date", delete the branch and report that instead of opening
an empty PR. Read the report before touching anything else: the kept-additions list is
where removed-feature material sneaks back in through a kept directory (a new test whose
subject is a removed module, a doc page about the admin UI), and the dropped list is
where a wanted file can be lost (restore one with `git checkout upstream/main -- <path>`).
A kept file marked as importing a removed module exists for that feature: delete it with
`git rm`, and say so in the PR.

## Resolve the content conflicts

```bash
node scripts/update-qm.ts conflicts
```

For each unmerged file this prints the number of conflict hunks, how many have an empty
fork side, the fork's own change to the file since the merge base, and every import in
the file that points at a path the fork removed. An empty fork side means the fork
deleted feature code there and upstream changed the same region; upstream's side then
usually mixes removed-feature lines with new core code. The rule for every hunk:

1. Read the fork's intent: `git diff <base> HEAD -- <file>`.
2. Read upstream's change: `git diff <base> MERGE_HEAD -- <file>`.
3. Keep upstream's new core behaviour and re-apply the fork's removal on top of it. Drop
   only the lines that exist to serve a removed feature, and whatever they leave dangling
   (an unused import, a variable only the dropped branch used). Split a mixed hunk;
   never take or drop upstream's side wholesale.

Two files have fixed resolutions. `package.json` is upstream's version with the fork's
removals re-applied (license, removed scripts and dependencies, no `cli` in the lint
paths, no `@yc-software/qm` workspace dependency). `package-lock.json` is never
hand-merged: take upstream's copy and regenerate it against the resolved manifest.

```bash
git show MERGE_HEAD:package-lock.json > package-lock.json
npm install --package-lock-only --ignore-scripts
```

`--ignore-scripts` skips the husky prepare hook, which fails on a branch whose
`node_modules` predates the merged manifest.

The fork's own copies of this skill and the other `.codex/skills/` files conflict when
upstream edits them; keep the fork's version and fold in only what still applies to a
Helm-only, Slack-only core.

When intent cannot be recovered from code, tests, or history, ask the operator before
choosing a behaviour.

## Check, then verify

```bash
node scripts/update-qm.ts check
```

`check` fails on unmerged paths, leftover conflict markers, and relative imports whose
target is a file or directory the fork removed, naming which. It also lists, without
failing, every file present under a path the fork removed, so a deliberate restore
stands out from an accidental one. Imports broken any other way are typecheck's job. Fix everything it lists, stage
the result with `git add -A`, and run `check` again until it is clean. Then run the
repository's own gates and the tests that cover the merged range and your resolutions:

```bash
npm ci
npm run typecheck
npm run lint
npm run lint:knip
node --experimental-test-module-mocks --test <affected tests>
```

A removed-feature reference that survives resolution usually surfaces here: typecheck
finds a test in a kept file that exercises a removed option (trim that case), knip finds
a dependency only a dropped file used (remove it from `package.json` and regenerate the
lock), and two upstream contract tests check fork-owned files: `test/helm-secret-env`
requires every secret core can demand to have a key under `secretEnv` in
`deploy/helm/values.yaml`, and `test/onboarding-slack-contract` requires exact phrases
in `skills-seed/admin/SKILL.md`, so keep those phrases when rewording for Slack. Fix
each in the merge, not in a follow-up. A sync that touches wiring, config, or the
orchestrator reaches most of the suite, so run the root suite locally in that case
(`npm test` first builds the connector SDK, which the bundle test needs); otherwise run
the affected tests and let CI run the rest. Compare any failure against the same test
on `main` before treating it as the merge's: a failure that reproduces there is not this
sync's to fix.

A sync can change the Helm chart's values. Render each organization layer against the
merged chart and review the diff:

```bash
helm template qm deploy/helm -f deploy/layers/<org>/values.yaml
```

Adapting a values file the merged chart no longer accepts is part of the sync. Verify
non-trivial behaviour changes in a live dev instance before opening the PR, per
AGENTS.md. Merging source does not update the published runtime images; deploy them
with `scripts/deploy-helm.sh` or the release workflow.

Commit the merge only after `check` and the gates pass:

```bash
git commit --no-edit
```

## Open the PR

```bash
git push -u origin codex/sync-upstream-<yyyy-mm-dd>
gh pr create --repo <source-fork> --base main \
  --title "Sync upstream qm through <short-sha>" \
  --body-file .generated/update-qm/report.md
```

Before using the report as the body, append how each hand-resolved conflict was settled,
anything restored from the dropped list, and the results of the checks above. The report
names upstream commits by subject and short SHA only, never by upstream PR number, and
the additions must not either: a `#NNNN` in this repository links to an unrelated PR. Without
`--repo`, `gh` may pick `upstream` from the clone's remotes and open the PR against qm,
and `gh pr edit 1` then overwrites whatever is PR 1 there.

Land a source-sync PR with a merge commit (`gh pr merge --repo <source-fork> <pr>
--merge`) or an ancestry-preserving fast-forward. Never squash or rebase it, even if the
repository's usual workflow squashes: that loses the upstream merge and makes the next
sync revisit already-integrated history. If repository settings prohibit merge commits,
resolve that policy before landing.

If the fork deploys from `main`, merging this PR ships upstream's changes to production,
so merge when someone can watch it. A sync that adds or changes CI changes what runs on
the next PR; workflows that need secrets the fork never received fail until those are
supplied. Review inherited CI and publishing changes for the fork's own accounts and
registries rather than enabling upstream workflows blindly.

## Never do these

- `git push --mirror` to seed or update a source fork. It copies unrelated branches and
  tags, leaves the default branch implicit, and can delete destination-only refs. Seed
  only `main` and set the default branch explicitly.
- Push a branch whose history contains fork commits to upstream. The `upstream-pr` skill
  pushes upstream only from branches cut fresh from `upstream/main` and scrubbed.
- Rebase `main` onto `upstream/main`, or force-push the fork's `main`.
- Resolve a content conflict by deleting upstream's side wholesale. That silently
  diverges core from upstream, and the divergence returns as a larger conflict next time.
- Restore a removed feature piecemeal to quiet a dangling import. Drop the importing
  line, or the importing file if it exists only for that feature, and say so in the PR.
- Hand-edit `package-lock.json`.
