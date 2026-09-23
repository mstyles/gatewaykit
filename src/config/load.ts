import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { ConfigError, validateConfig, type ValidationResult } from './validate.js';

export function parseConfig(text: string): ValidationResult {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ConfigError([`YAML parse error: ${(err as Error).message}`]);
  }
  return validateConfig(raw);
}

export function loadConfigFile(path: string): ValidationResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError([`cannot read config file "${path}": ${(err as Error).message}`]);
  }
  return parseConfig(text);
}
