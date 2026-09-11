import type { AgentAdapter, AdapterConfig, ConfigGetter } from './base.js';
import { CodexAdapter } from './codex.js';
import { ClaudeAdapter } from './claude.js';
import { CustomAdapter } from './custom.js';

export * from './base.js';
export { CodexAdapter } from './codex.js';
export { ClaudeAdapter } from './claude.js';
export { CustomAdapter } from './custom.js';

/**
 * Build the shipped adapter set. `getConfig(adapterId)` reads the persisted
 * per-adapter config (CoreApp.adapterConfigs).
 */
export function createAdapterRegistry(
  getConfig: (adapterId: string) => AdapterConfig,
): AgentAdapter[] {
  const forId =
    (id: string): ConfigGetter =>
    () =>
      getConfig(id);
  return [
    new CodexAdapter(forId('codex')),
    new ClaudeAdapter(forId('claude-code')),
    new CustomAdapter(forId('custom')),
  ];
}

export function adapterById(adapters: AgentAdapter[], id: string): AgentAdapter | null {
  return adapters.find((a) => a.id === id) ?? null;
}
