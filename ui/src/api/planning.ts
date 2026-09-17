import { invoke } from "./transport";

export interface ProjectSummary {
  name: string;
  path: string;
  status: string;
  deadline: string | null;
  description: string;
}

export interface ProjectsListResponse {
  projects: ProjectSummary[];
}

export interface ProjectTask {
  file: string;
  line: number;
  text: string;
  done: boolean;
  offset: number;
}

export interface ProjectFile {
  path: string;
  type_id: string;
  mtime_unix: number;
}

export interface ProjectEvent {
  path: string;
  title: string;
  date: string;
  start: string | null;
  end: string | null;
}

export interface ProjectOverview {
  name: string;
  path: string;
  status: string;
  deadline: string | null;
  description: string;
  project_file: string | null;
  tasks: ProjectTask[];
  files: ProjectFile[];
  events: ProjectEvent[];
}

export interface ProjectCreateResponse {
  path: string;
  project_file: string;
}

export interface ProjectAddTaskResponse {
  file: string;
  offset: number;
}

export type ProjectPatch = {
  status?: string | null;
  deadline?: string | null;
  description?: string | null;
};

export interface CalendarEvent {
  path: string;
  title: string;
  date: string;
  start: string | null;
  end: string | null;
  project: string | null;
}

export interface CalendarDeadline {
  project: string;
  project_path: string;
  date: string;
  status: string;
}

export interface CalendarItemsResponse {
  events: CalendarEvent[];
  deadlines: CalendarDeadline[];
}

export interface EventCreateResponse {
  path: string;
}

export interface EventUpdateResponse {
  path: string;
}

export type EventPatch = {
  title?: string | null;
  date?: string | null;
  start?: string | null;
  end?: string | null;
  project?: string | null;
};

export interface EventCreateInput {
  title: string;
  date: string;
  start?: string | undefined;
  end?: string | undefined;
  project?: string | undefined;
  notes?: string | undefined;
}

export function projectsList(vaultId: string): Promise<ProjectsListResponse> {
  return invoke("projects_list", { req: { vault_id: vaultId } });
}

export function projectOverview(
  vaultId: string,
  path: string,
): Promise<ProjectOverview> {
  return invoke("project_overview", {
    req: { vault_id: vaultId, path },
  });
}

export function projectCreate(
  vaultId: string,
  name: string,
  description = "",
): Promise<ProjectCreateResponse> {
  return invoke("project_create", {
    req: { vault_id: vaultId, name, description },
  });
}

export function projectUpdate(
  vaultId: string,
  path: string,
  patch: ProjectPatch,
): Promise<void> {
  return invoke("project_update", {
    req: { vault_id: vaultId, path, patch },
  });
}

export function projectSetTask(
  vaultId: string,
  file: string,
  offset: number,
  done: boolean,
): Promise<void> {
  return invoke("project_set_task", {
    req: { vault_id: vaultId, file, offset, done },
  });
}

export function projectAddTask(
  vaultId: string,
  path: string,
  text: string,
): Promise<ProjectAddTaskResponse> {
  return invoke("project_add_task", {
    req: { vault_id: vaultId, path, text },
  });
}

export function calendarItems(
  vaultId: string,
  from: string,
  to: string,
): Promise<CalendarItemsResponse> {
  return invoke("calendar_items", {
    req: { vault_id: vaultId, from, to },
  });
}

export function eventCreate(
  vaultId: string,
  input: EventCreateInput,
): Promise<EventCreateResponse> {
  return invoke("event_create", {
    req: { vault_id: vaultId, ...input },
  });
}

export function eventUpdate(
  vaultId: string,
  path: string,
  patch: EventPatch,
): Promise<EventUpdateResponse> {
  return invoke("event_update", {
    req: { vault_id: vaultId, path, patch },
  });
}

export function eventDelete(vaultId: string, path: string): Promise<void> {
  return invoke("event_delete", { req: { vault_id: vaultId, path } });
}
