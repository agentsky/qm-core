export function slackHistoryRateLimitMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; retryAfter?: unknown; data?: { error?: unknown } };
  if (value.code !== "slack_webapi_rate_limited_error" && value.data?.error !== "ratelimited") return undefined;
  const seconds = Number(value.retryAfter);
  const retry = Number.isFinite(seconds) && seconds > 0 ? `in ${Math.ceil(seconds)} seconds` : "shortly";
  return `Slack is temporarily limiting history reads, so I may be missing earlier context. Try again ${retry}.`;
}
