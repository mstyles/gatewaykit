import type { Feature } from '../pipeline/types.js';

/**
 * Registered features, outermost first: each wraps everything after it. Planned order:
 *
 *   auth → rate_limit → response_transform → request_transform → circuit_breaker → retry → upstream
 *
 * Adding a feature = one module exporting a Feature + one line here.
 */
export const FEATURES: readonly Feature[] = [];
