const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

/** Parses a duration string such as "500ms", "30s", "5m" or "1h" into milliseconds. */
export function parseDuration(input: string): number {
  const match = DURATION.exec(input.trim());
  if (!match) {
    throw new Error(`invalid duration "${input}" (expected e.g. "500ms", "30s", "5m", "1h")`);
  }
  const [, amount, unit] = match;
  return Math.round(Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS]);
}
