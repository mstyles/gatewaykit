import type http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { parseConfig } from '../src/config/load.js';
import { silentLogger, type Logger } from '../src/logger.js';
import { createGateway } from '../src/server.js';
import { createMockUpstream } from '../mock/upstream.js';

/** Listens on an ephemeral port and returns the base URL. */
export async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function startMockUpstream(name: string) {
  const server = createMockUpstream(name);
  const url = await listen(server);
  return { url, close: () => closeServer(server) };
}

/** A URL nothing is listening on, for "upstream is down" cases. */
export async function deadUpstreamUrl(): Promise<string> {
  const { url, close } = await startMockUpstream('dead');
  await close();
  return url;
}

export async function startGateway(yaml: string, logger: Logger = silentLogger) {
  const { config } = parseConfig(yaml);
  const gateway = createGateway(config, { logger });
  const url = await listen(gateway.server);
  return { url, close: (graceMs?: number) => gateway.close(graceMs) };
}

/** Records every log call, so tests can assert on what the gateway logged. */
export function recordingLogger() {
  const entries: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const record = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    entries.push({ level, msg, fields });
  };
  const logger: Logger = { info: record('info'), warn: record('warn'), error: record('error') };
  return { logger, entries };
}

export interface RawRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Written after the headers; not checked against any content-length header. */
  body?: string;
}

export interface RawResponse {
  /** null if the connection closed without a response. */
  status: number | null;
  /** Lowercased names; repeated headers are joined with ", ". */
  headers: Record<string, string>;
  body: string;
}

/**
 * Sends a hand-written HTTP/1.1 request, for requests fetch() would normalize or refuse (bad
 * targets, lying content-length, hop-by-hop headers). Always sends `connection: close` unless
 * overridden, and reads until the server closes the connection.
 */
export function rawRequest(baseUrl: string, target: string, options: RawRequestOptions = {}): Promise<RawResponse> {
  const { hostname, port } = new URL(baseUrl);
  const { method = 'GET', headers = {}, body = '' } = options;
  const headerLines = Object.entries({ host: hostname, connection: 'close', ...headers })
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(`${method} ${target} HTTP/1.1\r\n${headerLines}\r\n${body}`);
    });
    socket.on('data', (chunk) => (data += chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(parseRawResponse(data)));
  });
}

function parseRawResponse(data: string): RawResponse {
  const [head, ...rest] = data.split('\r\n\r\n');
  const [statusLine, ...headerLines] = head.split('\r\n');
  const status = /^HTTP\/1\.1 (\d{3})/.exec(statusLine);
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }
  return { status: status ? Number(status[1]) : null, headers, body: rest.join('\r\n\r\n') };
}

/** Manually advanced clock for time-based features. */
export class FakeClock {
  constructor(public time = 0) {}
  now = () => this.time;
  sleep = async (ms: number) => {
    this.time += ms;
  };
  advance(ms: number): void {
    this.time += ms;
  }
}
