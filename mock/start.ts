import { createMockUpstream } from './upstream.js';

// Starts one mock upstream per port; defaults to the ports used by gateway.yaml.
const args = process.argv.slice(2).map(Number);
const ports = args.length > 0 ? args : [3001, 3002, 3003, 3004, 3005, 3006];

for (const port of ports) {
  createMockUpstream(`mock-${port}`).listen(port, () => console.log(`mock upstream listening on :${port}`));
}
