import { For, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import Icon, { type IconName } from "@ds/components/graphics/Icon/Icon";

import type { NavSection } from "../settings/settingsState";

const SECTIONS: { id: NavSection; label: string; icon: IconName }[] = [
  { id: "notes", label: "Notes", icon: "file-text" },
  { id: "projects", label: "Projects", icon: "kanban" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "agents", label: "Agents", icon: "bot" },
];

export function SectionNav(props: {
  section: () => NavSection;
  onSelect: (s: NavSection) => void;
}): JSXElement {
  return (
    <nav class="section-nav" aria-label="Workspace sections">
      <For each={SECTIONS}>
        {(s) => (
          <Button
            variant="ghost"
            size="sm"
            class="section-nav__item"
            ariaPressed={props.section() === s.id}
            onClick={() => props.onSelect(s.id)}
          >
            <Icon name={s.icon} size={14} />
            <span>{s.label}</span>
          </Button>
        )}
      </For>
    </nav>
  );
}
