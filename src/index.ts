import { loadConfigFile } from './config/load.js';
import { ConfigError } from './config/validate.js';
import { consoleLogger as logger } from './logger.js';
import { createGateway } from './server.js';

const configPath = process.argv[2] ?? process.env.GATEWAY_CONFIG;
if (!configPath) {
  console.error('usage: npm start -- <config.yaml>   (or set GATEWAY_CONFIG=<config.yaml>)');
  process.exit(2);
}

let loaded;
try {
  loaded = loadConfigFile(configPath);
} catch (err) {
  // Fail fast: a gateway running a half-understood config is worse than one that won't start.
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const { config, warnings } = loaded;
for (const warning of warnings) logger.warn('config warning', { warning });

const gateway = createGateway(config, { logger });
gateway.server.on('error', (err) => {
  logger.error('server error', { error: err.message });
  process.exit(1);
});
gateway.server.listen(config.port, () => {
  logger.info('gateway listening', { port: config.port, config: configPath, routes: config.routes.length });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    logger.info('shutting down', { signal });
    await gateway.close();
    process.exit(0);
  });
}
