import { createSignal, For, Show, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import IconButton from "@ds/components/forms/IconButton/IconButton";

import { agentDiff } from "../api/agents";
import type { AgentSessionMeta } from "./agentStore";
import { diffLines, type DiffLine } from "./diff";

const STATUS_GLYPH: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};

interface DiffView {
  path: string;
  status: string;
  lines: DiffLine[] | null;
}

export function AgentChanges(props: {
  meta: () => AgentSessionMeta | undefined;
  onOpenFile: (path: string) => void;
}): JSXElement {
  const [diffView, setDiffView] = createSignal<DiffView | null>(null);

  const showDiff = async (path: string) => {
    const id = props.meta()?.agentId;
    if (id === null || id === undefined) return;
    try {
      const r = await agentDiff(id, path);
      setDiffView({
        path: r.path,
        status: r.status,
        lines:
          r.old === null && r.new === null
            ? null
            : diffLines(r.old ?? "", r.new ?? ""),
      });
    } catch {
      setDiffView(null);
    }
  };

  return (
    <aside class="agent__changes">
      <div class="agent__changes-head">
        <Show
          when={diffView() !== null}
          fallback={
            <>
              <span>Changes</span>
              <span class="agent__changes-count">
                {props.meta()?.changes.length ?? 0}
              </span>
            </>
          }
        >
          <IconButton
            label="Back to changes"
            size="sm"
            onClick={() => setDiffView(null)}
          >
            ‹
          </IconButton>
          <span class="agent__diff-path">{diffView()!.path}</span>
        </Show>
      </div>
      <Show
        when={diffView() === null}
        fallback={
          <div class="agent__diff">
            <Show
              when={diffView()!.lines !== null}
              fallback={
                <p class="agent__empty">
                  {diffView()!.status === "deleted"
                    ? "File deleted."
                    : "Diff unavailable."}
                </p>
              }
            >
              <pre class="agent__diff-lines">
                <For each={diffView()!.lines!}>
                  {(line) => (
                    <div
                      class={`agent__diff-line agent__diff-line--${line.kind}`}
                    >
                      {line.kind === "add"
                        ? "+ "
                        : line.kind === "del"
                          ? "- "
                          : "  "}
                      {line.text}
                    </div>
                  )}
                </For>
              </pre>
            </Show>
          </div>
        }
      >
        <ul class="agent__change-list">
          <For
            each={props.meta()?.changes ?? []}
            fallback={<li class="agent__empty">No filesystem changes yet.</li>}
          >
            {(c) => (
              <li>
                <Button
                  variant="ghost"
                  size="sm"
                  fullWidth
                  class="agent__change"
                  onClick={() => void showDiff(c.path)}
                  title={`${c.path} — click for diff`}
                >
                  <span class="agent__change-glyph" data-status={c.status}>
                    {STATUS_GLYPH[c.status] ?? "M"}
                  </span>
                  <span class="agent__change-path">{c.path}</span>
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </aside>
  );
}
