import type { Origin } from '@bureau/contracts';

/**
 * What a fixture builder needs from a core: the dispatch surface and nothing
 * else. The Rust host client and the legacy TypeScript `CoreApp` both fit.
 */
export interface FixtureCore {
  dispatch(
    op: string,
    payload: unknown,
    origin: Origin,
    projectId?: string,
    idempotencyKey?: string,
  ): Promise<unknown>;
}
