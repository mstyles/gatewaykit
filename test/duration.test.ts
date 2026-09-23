import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/config/duration.js';

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['1.5s', 1_500],
    ['5m', 300_000],
    ['1h', 3_600_000],
    [' 10s ', 10_000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['', '30', 's', '-5s', '5 seconds', '1d'])('rejects %j', (input) => {
    expect(() => parseDuration(input)).toThrow(/invalid duration/);
  });
});
