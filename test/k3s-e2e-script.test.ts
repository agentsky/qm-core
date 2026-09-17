import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/k3s-e2e.sh", import.meta.url));

const STUB = `#!/usr/bin/env bash
name="$(basename "$0")"
printf '%s %s\\n' "$name" "$*" >>"$STUB_LOG"
case "$name $*" in
  "sudo "*) shift; exec "$@" ;;
  "kubectl cluster-info"*)
    case "$STUB_CLUSTER" in
      reachable) exit 0 ;;
      kubeconfig) [[ -n "\${KUBECONFIG:-}" ]] ;;
      *) exit 1 ;;
    esac ;;
  "kubectl config current-context"*) echo stub-context ;;
  "kubectl"*" create namespace"*)
    if [[ "\${STUB_NAMESPACE_EXISTS:-0}" == "1" ]]; then
      echo 'Error from server (AlreadyExists): namespaces already exists' >&2
      exit 1
    fi ;;
  "kubectl"*" get deployments"*) echo deployment/stub ;;
  "kubectl"*" apply"*|"k3s"*) cat >/dev/null ;;
  "helm"*" upgrade"*) [[ "\${STUB_HELM_UPGRADE:-ok}" == "ok" ]] ;;
  "openssl rand"*) echo 0123456789abcdef0123456789abcdef0123456789abcdef ;;
  "curl"*) exit 1 ;;
esac
`;

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "k3s-e2e-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["sudo", "kubectl", "helm", "docker", "k3s", "openssl", "curl"]) {
    writeFileSync(join(bin, name), STUB, { mode: 0o755 });
  }
  const logDir = join(dir, "logs");
  const stubLog = join(dir, "calls.log");
  writeFileSync(stubLog, "");
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: dir,
      STUB_LOG: stubLog,
      K3S_E2E_LOG_DIR: logDir,
      K3S_E2E_NAMESPACE: "qm-e2e-under-test",
      K3S_E2E_K3S_KUBECONFIG: join(dir, "absent-k3s.yaml"),
      ...env,
    },
  });
  return { dir, logDir, result, calls: readFileSync(stubLog, "utf8") };
}

const uninstall = /^helm .*uninstall/m;
const deleteNamespace = /^kubectl .*delete namespace/m;

test("a prerequisite failure before anything is created tears nothing down", () => {
  const { result, calls } = run({ STUB_CLUSTER: "never" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not fetch or run the k3s installer/);
  assert.doesNotMatch(calls, uninstall);
  assert.doesNotMatch(calls, deleteNamespace);
});

test("an existing namespace is refused and left untouched", () => {
  const { result, calls } = run({ STUB_CLUSTER: "reachable", STUB_NAMESPACE_EXISTS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /namespace qm-e2e-under-test already exists/);
  assert.match(calls, /^kubectl --context stub-context create namespace qm-e2e-under-test$/m);
  assert.doesNotMatch(calls, uninstall);
  assert.doesNotMatch(calls, deleteNamespace);
});

test("a namespace the script created is torn down when a later step fails", () => {
  const { result, calls } = run({ STUB_CLUSTER: "reachable", STUB_HELM_UPGRADE: "fail" });
  assert.notEqual(result.status, 0);
  assert.match(calls, /^kubectl --context stub-context create namespace qm-e2e-under-test$/m);
  assert.match(calls, /^helm --kube-context stub-context uninstall qm --namespace qm-e2e-under-test/m);
  assert.match(calls, /^kubectl --context stub-context delete namespace qm-e2e-under-test/m);
});

test("adopting the k3s kubeconfig copies it owner-only and leaves the original's mode alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "k3s-kubeconfig-"));
  const source = join(dir, "k3s.yaml");
  writeFileSync(source, "apiVersion: v1\nkind: Config\n");
  chmodSync(source, 0o600);
  const { logDir, result, calls } = run({
    STUB_CLUSTER: "kubeconfig",
    STUB_NAMESPACE_EXISTS: "1",
    K3S_E2E_K3S_KUBECONFIG: source,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /adopted the k3s kubeconfig/);
  assert.equal(statSync(source).mode & 0o777, 0o600);
  assert.doesNotMatch(calls, /chmod/);
  assert.equal(existsSync(join(logDir, "kubeconfig")), false);
  assert.doesNotMatch(calls, uninstall);
  assert.doesNotMatch(calls, deleteNamespace);
});
