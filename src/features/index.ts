import type { Feature } from '../pipeline/types.js';
import { auth } from './auth.js';
import { circuitBreakerFeature } from './circuit-breaker.js';
import { rateLimitFeature } from './rate-limit.js';
import { retryFeature } from './retry.js';

/**
 * Registered features, outermost first: each wraps everything after it. Planned order:
 *
 *   auth → rate_limit → response_transform → request_transform → circuit_breaker → retry → upstream
 *
 * Why rate_limit sits inside auth, and circuit_breaker outside retry: see DECISIONS.md.
 *
 * Adding a feature = one module exporting a Feature + one line here.
 */
export const FEATURES: readonly Feature[] = [auth, rateLimitFeature, circuitBreakerFeature, retryFeature];
