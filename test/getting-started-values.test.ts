import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const doc = readFileSync(new URL("../docs/getting-started.md", import.meta.url), "utf8");
const fixture = readFileSync(new URL("../deploy/helm/examples/getting-started.yaml", import.meta.url), "utf8");
const chartValues = readFileSync(new URL("../deploy/helm/values.yaml", import.meta.url), "utf8");

test("the getting-started values example is the fixture the k3s e2e installs", () => {
  const block = /```yaml\n([\s\S]*?)```/.exec(doc);
  assert.ok(block, "getting-started.md shows a yaml values example");
  assert.equal(block[1], fixture);
});

test("the e2e script installs the documented fixture", () => {
  const script = readFileSync(new URL("../scripts/k3s-e2e.sh", import.meta.url), "utf8");
  assert.match(script, /VALUES="\$CHART\/examples\/getting-started\.yaml"/);
  assert.match(script, /-f "\$VALUES"/);
});

test("the chart runs core on postgres-backed stores with a real harness by default", () => {
  const core = /^ {2}core:\n((?: {4}.*\n)+)/m.exec(chartValues);
  assert.ok(core, "values.yaml declares services.core");
  for (const line of ["SESSION_STORE: postgres", "RUN_STORE: postgres", "HARNESS: pi", "enabled: true"]) {
    assert.ok(core[1]!.includes(line), `services.core sets ${line}`);
  }
  assert.doesNotMatch(fixture, /SESSION_STORE|RUN_STORE|HARNESS/);
});
