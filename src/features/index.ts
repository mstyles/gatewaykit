import type { Feature } from '../pipeline/types.js';
import { auth } from './auth.js';

/**
 * Registered features, outermost first: each wraps everything after it. Planned order:
 *
 *   auth → rate_limit → response_transform → request_transform → circuit_breaker → retry → upstream
 *
 * Why rate_limit sits inside auth, and circuit_breaker outside retry: see DECISIONS.md.
 *
 * Adding a feature = one module exporting a Feature + one line here.
 */
export const FEATURES: readonly Feature[] = [auth];
