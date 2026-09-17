import { createSignal } from "solid-js";

import {
  agentChanges,
  agentsDetect,
  type AgentChangeDto,
  type AgentProviderDto,
} from "../api/agents";

export interface AgentLaunch {
  provider: string;
  command?: string | undefined;
  prompt?: string | undefined;
  cwd?: string | undefined;
}

export type AgentSessionStatus = "opening" | "running" | "exited" | "failed";

export interface AgentSessionMeta {
  tabKey: string;
  agentId: string | null;
  provider: string;
  cwd: string;
  prompt: string;
  status: AgentSessionStatus;
  error: string | null;
  changes: AgentChangeDto[];
  startedAt: number | null;
}

let nextKey = 1;

export interface AgentStore {
  providers: () => AgentProviderDto[];
  defaultProvider: () => string;
  refreshProviders: () => void;
  sessions: () => Map<string, AgentSessionMeta>;
  sessionFor: (tabKey: string) => AgentSessionMeta | undefined;
  prepareLaunch: (spec: AgentLaunch) => string;
  takePending: (tabKey: string) => AgentLaunch | undefined;
  register: (tabKey: string, patch: Partial<AgentSessionMeta>) => void;
  unregister: (tabKey: string) => void;
  refreshChanges: (tabKey: string) => Promise<void>;
}

export function createAgentStore(vaultId: () => string | null): AgentStore {
  const [providers, setProviders] = createSignal<AgentProviderDto[]>([]);
  const [sessions, setSessions] = createSignal<Map<string, AgentSessionMeta>>(
    new Map(),
  );
  const pending = new Map<string, AgentLaunch>();
  let loaded = false;

  const refreshProviders = () => {
    if (vaultId() === null) return;
    void agentsDetect()
      .then((r) => setProviders(r.providers))
      .catch(() => {});
  };

  const mutate = (tabKey: string, patch: Partial<AgentSessionMeta>) => {
    setSessions((m) => {
      const prev = m.get(tabKey);
      if (prev === undefined) return m;
      const next = new Map(m);
      next.set(tabKey, { ...prev, ...patch });
      return next;
    });
  };

  return {
    providers,
    defaultProvider: () =>
      providers().find((p) => p.available)?.id ?? "codex",
    refreshProviders: () => {
      refreshProviders();
      loaded = true;
    },
    sessions,
    sessionFor: (tabKey) => sessions().get(tabKey),
    prepareLaunch: (spec) => {
      const tabKey = `a${nextKey++}`;
      pending.set(tabKey, spec);
      setSessions((m) => {
        const next = new Map(m);
        next.set(tabKey, {
          tabKey,
          agentId: null,
          provider: spec.provider,
          cwd: spec.cwd ?? "",
          prompt: spec.prompt ?? "",
          status: "opening",
          error: null,
          changes: [],
          startedAt: null,
        });
        return next;
      });
      if (!loaded) {
        refreshProviders();
        loaded = true;
      }
      return tabKey;
    },
    takePending: (tabKey) => {
      const spec = pending.get(tabKey);
      pending.delete(tabKey);
      return spec;
    },
    register: mutate,
    unregister: (tabKey) =>
      setSessions((m) => {
        if (!m.has(tabKey)) return m;
        const next = new Map(m);
        next.delete(tabKey);
        return next;
      }),
    refreshChanges: async (tabKey) => {
      const meta = sessions().get(tabKey);
      if (meta?.agentId === null || meta === undefined) return;
      try {
        const r = await agentChanges(meta.agentId!);
        mutate(tabKey, {
          changes: r.changes,
          provider: r.provider,
          cwd: r.cwd,
          startedAt: r.started_at,
        });
      } catch {
        /* session may be gone */
      }
    },
  };
}
