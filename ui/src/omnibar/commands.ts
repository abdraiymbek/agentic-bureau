export interface OmniCommand {
  id: string;
  title: string;
}

export const OMNI_COMMANDS: OmniCommand[] = [
  { id: "file.new", title: "New note" },
  { id: "project.new", title: "New project" },
  { id: "calendar.new", title: "New event" },
  { id: "agent.new", title: "Start agent session" },
  { id: "nav.notes", title: "Go to Notes" },
  { id: "nav.projects", title: "Go to Projects" },
  { id: "nav.calendar", title: "Go to Calendar" },
  { id: "nav.agents", title: "Go to Agents" },
  { id: "view.openTerminal", title: "Open terminal" },
  { id: "graph.open", title: "Open graph view" },
  { id: "settings.open", title: "Open settings" },
  { id: "statusbar.toggle", title: "Toggle status bar" },
];
