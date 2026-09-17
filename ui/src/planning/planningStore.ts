import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import {
  calendarItems,
  eventCreate,
  eventDelete,
  eventUpdate,
  projectAddTask,
  projectCreate,
  projectOverview,
  projectSetTask,
  projectUpdate,
  projectsList,
  type CalendarItemsResponse,
  type EventCreateInput,
  type EventPatch,
  type ProjectOverview,
  type ProjectPatch,
  type ProjectSummary,
} from "../api/planning";
import { showErrorToast } from "../toast/toastState";
import { errorMessage } from "../core/errorMessage";
import { rangeKey, type Range } from "./model";

export interface PlanningStoreDeps {
  vaultId: () => string | null;
  refreshTick: () => number;
}

export interface PlanningStore {
  projects: () => ProjectSummary[];
  overview: (path: string) => ProjectOverview | undefined;
  items: (range: Range) => CalendarItemsResponse | undefined;
  refresh: () => void;
  projectCreateIntent: () => number;
  requestProjectCreate: () => void;
  eventDraftRequest: () => string | null;
  requestEventDraft: (date: string) => void;
  clearEventDraftRequest: () => void;
  createProject: (name: string, description: string) => Promise<string | null>;
  patchProject: (path: string, patch: ProjectPatch) => Promise<void>;
  setTask: (file: string, offset: number, done: boolean) => Promise<void>;
  addTask: (path: string, text: string) => Promise<void>;
  createEvent: (input: EventCreateInput) => Promise<string | null>;
  patchEvent: (path: string, patch: EventPatch) => Promise<string | null>;
  removeEvent: (path: string) => Promise<void>;
}

export function createPlanningStore(deps: PlanningStoreDeps): PlanningStore {
  const [projects, setProjects] = createSignal<ProjectSummary[]>([]);
  const [overviews, setOverviews] =
    createStore<Record<string, ProjectOverview>>({});
  const [ranges, setRanges] =
    createStore<Record<string, CalendarItemsResponse>>({});
  const [staleTick, setStaleTick] = createSignal(0);
  const [projectCreateIntent, setProjectCreateIntent] = createSignal(0);
  const [eventDraftRequest, setEventDraftRequest] =
    createSignal<string | null>(null);
  const inflight = new Set<string>();
  const failed = new Set<string>();

  const vid = () => deps.vaultId();
  const report = (e: unknown) => showErrorToast(errorMessage(e));
  const attempt = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      report(e);
    }
  };

  const loadProjects = () =>
    attempt(async () => {
      const id = vid();
      if (!id) {
        setProjects([]);
        return;
      }
      const resp = await projectsList(id);
      setProjects(resp.projects);
    });

  const loadOverview = async (path: string) => {
    const id = vid();
    const key = `ov:${path}`;
    if (!id || inflight.has(key) || failed.has(key)) return;
    inflight.add(key);
    try {
      setOverviews(path, await projectOverview(id, path));
      failed.delete(key);
    } catch (e) {
      failed.add(key);
      report(e);
    } finally {
      inflight.delete(key);
    }
  };

  const loadRange = async (range: Range) => {
    const id = vid();
    const key = `rg:${rangeKey(range)}`;
    if (!id || inflight.has(key) || failed.has(key)) return;
    inflight.add(key);
    try {
      setRanges(rangeKey(range), await calendarItems(id, range.from, range.to));
      failed.delete(key);
    } catch (e) {
      failed.add(key);
      report(e);
    } finally {
      inflight.delete(key);
    }
  };

  const refresh = () => {
    failed.clear();
    void loadProjects();
    for (const path of Object.keys(overviews)) void loadOverview(path);
    for (const key of Object.keys(ranges)) {
      const [from, to] = key.split("..");
      if (from && to) void loadRange({ from, to });
    }
  };

  let seenVault: string | null = null;
  createEffect(
    on(
      () => [deps.vaultId(), deps.refreshTick(), staleTick()],
      () => {
        const id = deps.vaultId();
        if (id !== seenVault) {
          seenVault = id;
          failed.clear();
          setOverviews(reconcile({}));
          setRanges(reconcile({}));
        }
        refresh();
      },
      { defer: false },
    ),
  );

  onCleanup(() => setProjects([]));

  const overview = (path: string): ProjectOverview | undefined => {
    const hit = overviews[path];
    if (hit === undefined) void loadOverview(path);
    return hit;
  };

  const items = (range: Range): CalendarItemsResponse | undefined => {
    const hit = ranges[rangeKey(range)];
    if (hit === undefined) void loadRange(range);
    return hit;
  };

  const createProject = async (name: string, description: string) => {
    const id = vid();
    if (!id) return null;
    try {
      const resp = await projectCreate(id, name, description);
      await loadProjects();
      return resp.path;
    } catch (e) {
      report(e);
      return null;
    }
  };

  const patchProject = (path: string, patch: ProjectPatch) =>
    attempt(async () => {
      const id = vid();
      if (!id) return;
      await projectUpdate(id, path, patch);
      await Promise.all([loadProjects(), loadOverview(path)]);
    });

  const setTask = (file: string, offset: number, done: boolean) =>
    attempt(async () => {
      const id = vid();
      if (!id) return;
      await projectSetTask(id, file, offset, done);
      await loadOverview(file.split("/").slice(0, 2).join("/"));
    });

  const addTask = (path: string, text: string) =>
    attempt(async () => {
      const id = vid();
      if (!id) return;
      await projectAddTask(id, path, text);
      await loadOverview(path);
    });

  const createEvent = async (
    input: EventCreateInput,
  ): Promise<string | null> => {
    const id = vid();
    if (!id) return null;
    try {
      const resp = await eventCreate(id, input);
      setStaleTick((n) => n + 1);
      return resp.path;
    } catch (e) {
      report(e);
      return null;
    }
  };

  const patchEvent = async (path: string, patch: EventPatch) => {
    const id = vid();
    if (!id) return null;
    try {
      const resp = await eventUpdate(id, path, patch);
      setStaleTick((n) => n + 1);
      return resp.path;
    } catch (e) {
      report(e);
      return null;
    }
  };

  const removeEvent = (path: string) =>
    attempt(async () => {
      const id = vid();
      if (!id) return;
      await eventDelete(id, path);
      setStaleTick((n) => n + 1);
    });

  return {
    projects,
    overview,
    items,
    refresh,
    projectCreateIntent,
    requestProjectCreate: () => setProjectCreateIntent((n) => n + 1),
    eventDraftRequest,
    requestEventDraft: (date) => setEventDraftRequest(date),
    clearEventDraftRequest: () => setEventDraftRequest(null),
    createProject,
    patchProject,
    setTask,
    addTask,
    createEvent,
    patchEvent,
    removeEvent,
  };
}
