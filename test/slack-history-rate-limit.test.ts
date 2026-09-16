import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { WebClient, LogLevel } from "@slack/web-api";
import { HISTORY_NO_RETRY } from "../src/slack/config.ts";
import { slackHistoryRateLimitMessage } from "../src/slack/history-rate-limit.ts";

test("history throttling gives retry timing without leaking the error or linking anywhere", () => {
  const message = slackHistoryRateLimitMessage({
    code: "slack_webapi_rate_limited_error",
    retryAfter: 30,
    message: "private-token",
  });
  assert.match(message!, /Try again in 30 seconds/);
  assert.match(message!, /I may be missing earlier context/);
  assert.doesNotMatch(message!, /workspace admin|ask an admin/);
  assert.doesNotMatch(message!, /https?:\/\//);
  assert.doesNotMatch(message!, /private-token/);
});

test("a sub-second retry delay rounds up to whole seconds", () => {
  const message = slackHistoryRateLimitMessage({ code: "slack_webapi_rate_limited_error", retryAfter: 2.2 });
  assert.match(message!, /Try again in 3 seconds/);
});

test("unrelated errors produce no throttling note", () => {
  for (const error of [null, "rate limited", new Error("429"), { data: { error: "missing_scope" } }]) {
    assert.equal(slackHistoryRateLimitMessage(error), undefined);
  }
});

test("a malformed delay degrades to plain guidance", () => {
  const message = slackHistoryRateLimitMessage({ data: { error: "ratelimited" }, retryAfter: "invalid" });
  assert.match(message!, /Try again shortly/);
  assert.doesNotMatch(message!, /NaN/);
});

test("Slack history 429 returns immediately instead of sleeping inside the SDK", { timeout: 5000 }, async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(429, { "retry-after": "60", "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "ratelimited" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new WebClient("test-token", {
    ...HISTORY_NO_RETRY,
    slackApiUrl: `http://127.0.0.1:${address.port}/api/`,
    logLevel: LogLevel.ERROR,
  });
  try {
    await assert.rejects(client.conversations.history({ channel: "C1" }), (error: unknown) => {
      assert.match(slackHistoryRateLimitMessage(error)!, /Try again in 60 seconds/);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
