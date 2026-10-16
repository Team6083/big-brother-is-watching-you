export class SyncError extends Error {
  constructor(code, retryable = true, retryAfterMs = 0) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export function discordError(error) {
  if (error?.name === 'RateLimitError') {
    const delay = Number(error.timeToReset);
    return new SyncError('discord_rate_limited', true,
      Number.isFinite(delay) ? Math.min(3_600_000, Math.max(0, delay)) : 0);
  }
  if ([50001, 50013].includes(error?.code)) return new SyncError('discord_permission', false);
  if (error?.code === 10003) return new SyncError('discord_thread_missing', false);
  // Unknown Message may mean the starter is not available yet.
  if (error?.code === 10008) return new SyncError('starter_not_ready');
  return new SyncError('discord_request_failed');
}

export function backoff(attempt, random = Math.random) {
  return Math.min(60_000, 2_000 * 2 ** (attempt - 1)) + Math.floor(random() * 1_000);
}
