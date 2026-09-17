import { createSignal, For, Show, type JSXElement } from "solid-js";

import { pickImageFile } from "../api/platform";

import Button from "@ds/components/forms/Button/Button";
import SegmentedControl from "@ds/components/forms/SegmentedControl/SegmentedControl";
import Select from "@ds/components/forms/Select/Select";
import TextInput from "@ds/components/forms/TextInput/TextInput";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { AgentStore } from "./agentStore";
import { AGENT_VISUALS, type AgentVisual } from "./visual";

const VISUAL_OPTIONS = AGENT_VISUALS.map((v) => ({
  value: v,
  label: v[0]!.toUpperCase() + v.slice(1),
}));

export interface ProjectCwdOption {
  name: string;
  path: string;
}

export function AgentsPage(props: {
  store: AgentStore;
  projects: () => ProjectCwdOption[];
  visual: () => AgentVisual;
  setVisual: (v: string) => void;
  visualImage: () => string;
  setVisualImage: (path: string) => void;
  onLaunch: (spec: {
    provider: string;
    command?: string | undefined;
    prompt?: string | undefined;
    cwd?: string | undefined;
  }) => void;
  onOpenSession: (tabKey: string) => void;
}): JSXElement {
  const [providerId, setProviderId] = createSignal("codex");
  const [projectPath, setProjectPath] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [customCmd, setCustomCmd] = createSignal("");

  const providers = () => props.store.providers();
  const chosen = () =>
    providers().find((p) => p.id === providerId()) ??
    providers().find((p) => p.available) ??
    providers()[0];

  const sessions = () => [...props.store.sessions().values()];

  const providerOptions = () => [
    ...providers().map((p) => ({
      value: p.id,
      label: p.available ? p.name : `${p.name} (not found)`,
    })),
    { value: "custom", label: "Custom command" },
  ];

  const projectOptions = () => [
    { value: "", label: "Workspace root" },
    ...props.projects().map((p) => ({ value: p.path, label: p.name })),
  ];

  const launch = () => {
    const p = providerId();
    if (p === "custom" && customCmd().trim() === "") return;
    props.onLaunch({
      provider: p,
      command: p === "custom" ? customCmd().trim() : undefined,
      prompt: prompt().trim() || undefined,
      cwd: projectPath() || undefined,
    });
    setPrompt("");
  };

  const pickImage = () => {
    void pickImageFile().then((res) => {
      if (res !== null) props.setVisualImage(res);
    });
  };

  return (
    <div class="agents-page">
      <section class="agents-page__section">
        <h2 class="agents-page__h">New session</h2>
        <div class="agents-launch">
          <div class="agents-launch__row">
            <Select
              ariaLabel="Agent provider"
              value={providerId()}
              options={providerOptions()}
              onChange={setProviderId}
            />
            <Select
              ariaLabel="Working directory"
              value={projectPath()}
              options={projectOptions()}
              onChange={setProjectPath}
            />
          </div>
          <Show when={providerId() === "custom"}>
            <TextInput
              ariaLabel="Agent command"
              placeholder="my-agent --task {prompt}"
              value={customCmd()}
              onInput={setCustomCmd}
            />
          </Show>
          <TextInput
            ariaLabel="Task"
            placeholder={
              chosen()?.prompt_style === "positional"
                ? "Describe the task for the agent…"
                : "Instructions (optional) — you can also type in the session"
            }
            value={prompt()}
            onInput={setPrompt}
            onKeyDown={(e) => {
              if (e.key === "Enter") launch();
            }}
          />
          <div class="agents-launch__actions">
            <Button variant="primary" size="sm" onClick={launch}>
              <Icon name="terminal" size={13} />
              Start agent
            </Button>
            <Show when={providerId() !== "custom" && chosen() && !chosen()!.available}>
              <span class="agents-launch__warn">
                {chosen()!.name} was not found on PATH — install it or pick
                another provider.
              </span>
            </Show>
          </div>
        </div>
      </section>

      <section class="agents-page__section">
        <h2 class="agents-page__h">Sessions</h2>
        <ul class="agents-sessions">
          <For
            each={sessions()}
            fallback={
              <li class="agents-page__empty">
                No agent sessions. Start one above — it runs in this
                workspace and can edit your files directly.
              </li>
            }
          >
            {(s) => (
              <li>
                <Button
                  variant="ghost"
                  size="sm"
                  fullWidth
                  class="agents-session"
                  onClick={() => props.onOpenSession(s.tabKey)}
                >
                  <span class="agents-session__provider">{s.provider}</span>
                  <span class="agents-session__prompt">
                    {s.prompt || s.cwd || "Interactive session"}
                  </span>
                  <span
                    class="agents-session__status"
                    data-status={s.status}
                  >
                    {s.status}
                  </span>
                </Button>
              </li>
            )}
          </For>
        </ul>
      </section>

      <section class="agents-page__section">
        <h2 class="agents-page__h">Appearance</h2>
        <div class="agents-visual">
          <SegmentedControl
            ariaLabel="Agent visual"
            variant="pill"
            value={props.visual()}
            options={VISUAL_OPTIONS}
            onChange={props.setVisual}
          />
          <Show when={props.visual() === "image" || props.visual() === "ascii"}>
            <div class="agents-visual__image">
              <Button variant="secondary" size="sm" onClick={pickImage}>
                <Icon name="image" size={13} />
                {props.visualImage() === "" ? "Choose image…" : "Change image"}
              </Button>
              <Show when={props.visualImage() !== ""}>
                <span class="agents-visual__path">{props.visualImage()}</span>
              </Show>
            </div>
          </Show>
        </div>
      </section>
    </div>
  );
}
