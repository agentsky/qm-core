import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const doc = readFileSync(new URL("../docs/getting-started.md", import.meta.url), "utf8");
const fixture = readFileSync(new URL("../deploy/helm/examples/getting-started.yaml", import.meta.url), "utf8");
const chartValues = readFileSync(new URL("../deploy/helm/values.yaml", import.meta.url), "utf8");

test("the getting-started values example is the fixture the k3s e2e installs", () => {
  const mention = doc.indexOf("deploy/helm/examples/getting-started.yaml");
  assert.notEqual(mention, -1, "getting-started.md names the fixture");
  const block = /```yaml\n([\s\S]*?)```/.exec(doc.slice(mention));
  assert.ok(block, "getting-started.md shows the fixture after naming it");
  assert.equal(block[1], fixture);
});

test("the e2e script installs the documented fixture", () => {
  const script = readFileSync(new URL("../scripts/k3s-e2e.sh", import.meta.url), "utf8");
  assert.match(script, /VALUES="\$CHART\/examples\/getting-started\.yaml"/);
  assert.match(script, /-f "\$VALUES"/);
});

test("the chart runs core on postgres-backed stores with a real harness by default", () => {
  const deployment = readFileSync(new URL("../deploy/helm/templates/deployment.yaml", import.meta.url), "utf8");
  for (const [key, value] of [
    ["SESSION_STORE", "postgres"],
    ["RUN_STORE", "postgres"],
    ["HARNESS", "pi"],
  ]) {
    assert.ok(deployment.includes(`set $wired "${key}" "${value}"`), `core is wired with ${key}=${value}`);
  }
  const core = /^ {2}core:\n((?: {4}.*\n)+)/m.exec(chartValues);
  assert.ok(core, "values.yaml declares services.core");
  assert.match(core[1]!, /^ {4}persistence:\n {6}enabled: true$/m);
  assert.doesNotMatch(fixture, /SESSION_STORE|RUN_STORE|HARNESS/);
});
