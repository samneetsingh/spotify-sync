export class SpotifyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "SpotifyError";
  }
}

export class RateLimitError extends SpotifyError {
  constructor(
    public readonly retryAfter: number,
    body?: unknown,
  ) {
    super(`Rate limited, retry after ${retryAfter}s`, 429, body);
    this.name = "RateLimitError";
  }
}
