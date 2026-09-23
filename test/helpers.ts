import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseConfig } from '../src/config/load.js';
import { silentLogger } from '../src/logger.js';
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

export async function startGateway(yaml: string) {
  const { config } = parseConfig(yaml);
  const gateway = createGateway(config, { logger: silentLogger });
  const url = await listen(gateway.server);
  return { url, close: () => gateway.close() };
}
