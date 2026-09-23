/**
 * A failure the gateway itself reports to the client (as opposed to an upstream response,
 * which is passed through). Middleware throws these; the server turns them into JSON:
 * `{ "error": code, ...body }`.
 */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(`${status} ${code}`);
    this.name = 'GatewayError';
  }
}
