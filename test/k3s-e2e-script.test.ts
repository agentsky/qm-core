import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/k3s-e2e.sh", import.meta.url));

const STUB = `#!/usr/bin/env bash
name="$(basename "$0")"
printf '%s %s\\n' "$name" "$*" >>"$STUB_LOG"
case "$name $*" in
  "sudo "*) exec "$@" ;;
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
  "kubectl"*" get svc"*) echo service/stub ;;
  "kubectl"*" port-forward"*) echo $$ >"$STUB_PORT_FORWARD_PID"; exec sleep 300 ;;
  "kubectl"*" apply"*|"k3s"*) cat >/dev/null ;;
  "helm"*" template"*"--set"*) echo "set services.core.dataDir instead; replicas must be 1; needs services.core.dataDir; not a service the chart declares"; exit 1 ;;
  "helm"*" template"*) echo "mountPath: /data" ;;
  "helm"*" upgrade"*) [[ "\${STUB_HELM_UPGRADE:-ok}" == "ok" ]] ;;
  "openssl rand"*) echo 0123456789abcdef0123456789abcdef0123456789abcdef ;;
  "curl"*"/healthz"*) [[ "$*" == *" -w "* ]] && echo 200; exit 0 ;;
  "curl"*) exit 1 ;;
esac
`;

const STUBS = ["sudo", "kubectl", "helm", "docker", "k3s", "openssl", "curl"];

function run(env: Record<string, string>, stubs = STUBS, basePath = process.env.PATH ?? "") {
  const dir = mkdtempSync(join(tmpdir(), "k3s-e2e-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of stubs) {
    writeFileSync(join(bin, name), STUB, { mode: 0o755 });
  }
  const logDir = join(dir, "logs");
  const stubLog = join(dir, "calls.log");
  const portForwardPidFile = join(dir, "port-forward.pid");
  writeFileSync(stubLog, "");
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${basePath}`,
      HOME: dir,
      STUB_LOG: stubLog,
      STUB_PORT_FORWARD_PID: portForwardPidFile,
      K3S_E2E_LOG_DIR: logDir,
      K3S_E2E_NAMESPACE: "qm-e2e-under-test",
      K3S_E2E_K3S_KUBECONFIG: join(dir, "absent-k3s.yaml"),
      ...env,
    },
  });
  const calls = readFileSync(stubLog, "utf8");
  const kubeconfigCopy = existsSync(join(logDir, "kubeconfig"));
  const portForwardPid = existsSync(portForwardPidFile) ? Number(readFileSync(portForwardPidFile, "utf8")) : undefined;
  rmSync(dir, { recursive: true, force: true });
  return { result, calls, kubeconfigCopy, portForwardPid };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  assert.match(result.stderr, /cannot create namespace qm-e2e-under-test \(Error from server \(AlreadyExists\)/);
  assert.match(calls, /^kubectl --context stub-context create namespace qm-e2e-under-test$/m);
  assert.doesNotMatch(calls, uninstall);
  assert.doesNotMatch(calls, deleteNamespace);
});

test("a missing helm binary is installed rather than mistaken for the helm wrapper", () => {
  const { result, calls } = run(
    { STUB_CLUSTER: "reachable" },
    STUBS.filter((name) => name !== "helm"),
    "/usr/bin:/bin",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installing helm/);
  assert.match(calls, /^curl -fsSL https:\/\/raw\.githubusercontent\.com\/helm\/helm\/main\/scripts\/get-helm-3$/m);
  assert.doesNotMatch(calls, /create namespace/);
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
  const { result, calls, kubeconfigCopy } = run({
    STUB_CLUSTER: "kubeconfig",
    STUB_NAMESPACE_EXISTS: "1",
    K3S_E2E_K3S_KUBECONFIG: source,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /adopted the k3s kubeconfig/);
  assert.equal(statSync(source).mode & 0o777, 0o600);
  assert.doesNotMatch(calls, /chmod/);
  assert.equal(kubeconfigCopy, false);
  assert.doesNotMatch(calls, uninstall);
  assert.doesNotMatch(calls, deleteNamespace);
});

test("stopping a port-forward kills the kubectl process itself, not a wrapper shell around it", () => {
  const { result, calls, portForwardPid } = run({ STUB_CLUSTER: "reachable" });
  assert.notEqual(result.status, 0);
  assert.match(
    calls,
    /^kubectl --context stub-context port-forward -n qm-e2e-under-test --address 127\.0\.0\.1 service\/stub 18080:8080$/m,
  );
  assert.ok(portForwardPid, "the port-forward stub recorded its pid");
  assert.equal(alive(portForwardPid), false);
  assert.match(calls, deleteNamespace);
});
