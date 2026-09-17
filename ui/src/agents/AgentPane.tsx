import {
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  type JSXElement,
} from "solid-js";

import { fileAssetUrl } from "../api/platform";

import Icon from "@ds/components/graphics/Icon/Icon";

import { createEmulator, type Emulator } from "../pty/emulator";
import { isUsableSize, watchResize, type TerminalSize } from "../pty/resize";
import { readTerminalAppearance } from "../pty/theme";
import type { ResolvedTheme } from "../styles/theme";
import { AgentChanges } from "./AgentChanges";
import { imageFileToAscii } from "./asciiImage";
import { openAgentSession, type AgentSession } from "./agentSession";
import type { AgentStore } from "./agentStore";
import { applyVisual, type AgentVisual } from "./visual";

const FALLBACK_SIZE: TerminalSize = { cols: 80, rows: 24 };
const POLL_MS = 4000;

export function AgentPane(props: {
  tabKey: string;
  vaultId: string;
  store: AgentStore;
  resolvedTheme: () => ResolvedTheme;
  visual: () => AgentVisual;
  visualImage: () => string;
  onOpenFile: (path: string) => void;
  onClosed: () => void;
}): JSXElement {
  const [ascii, setAscii] = createSignal<string | null>(null);
  let screen: HTMLDivElement | undefined;
  let emulator: Emulator | undefined;
  let session: AgentSession | undefined;
  let poll: number | undefined;

  const meta = () => props.store.sessionFor(props.tabKey);

  const measure = (): TerminalSize =>
    (emulator ? emulator.fit() : null) ?? emulator?.size() ?? FALLBACK_SIZE;

  const syncSize = () => {
    const size = measure();
    if (isUsableSize(size)) session?.resize(size);
  };

  const refreshChanges = () => void props.store.refreshChanges(props.tabKey);

  onMount(() => {
    const host = screen;
    if (host === undefined) return;

    const spec = props.store.takePending(props.tabKey);
    emulator = createEmulator(
      host,
      applyVisual(readTerminalAppearance(), props.visual()),
    );
    const stopWatching = watchResize(host, syncSize);
    onCleanup(stopWatching);

    void (async () => {
      if (spec === undefined) {
        props.store.register(props.tabKey, {
          status: "failed",
          error: "missing launch spec",
        });
        return;
      }
      try {
        const opened = await openAgentSession(
          {
            vault_id: props.vaultId,
            provider: spec.provider,
            cwd: spec.cwd ?? "",
            command: spec.command,
            prompt: spec.prompt,
            cols: measure().cols,
            rows: measure().rows,
          },
          measure(),
          {
            onBytes: (bytes) => emulator?.write(bytes),
            onExit: () => {
              props.store.register(props.tabKey, { status: "exited" });
              refreshChanges();
            },
          },
        );
        if (emulator === undefined) {
          void opened.close();
          return;
        }
        session = opened;
        props.store.register(props.tabKey, {
          agentId: opened.id,
          status: "running",
        });
        emulator.onData((data) => opened.write(data));
        syncSize();
        emulator.focus();
        refreshChanges();
        poll = window.setInterval(refreshChanges, POLL_MS);
        onCleanup(() => window.clearInterval(poll));
      } catch (err) {
        props.store.register(props.tabKey, {
          status: "failed",
          error: String(err),
        });
      }
    })();
  });

  createEffect(
    on(
      () => [props.resolvedTheme(), props.visual()] as const,
      () => {
        emulator?.applyAppearance(
          applyVisual(readTerminalAppearance(), props.visual()),
        );
        syncSize();
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => [props.visual(), props.visualImage()] as const,
      ([visual, image]) => {
        if (visual !== "ascii" || image === "") {
          setAscii(null);
          return;
        }
        void imageFileToAscii(image).then(setAscii);
      },
    ),
  );

  onCleanup(() => {
    const closing = session;
    session = undefined;
    emulator?.dispose();
    emulator = undefined;
    props.onClosed();
    void closing?.close();
  });

  const imageUrl = () =>
    props.visualImage() === "" ? null : fileAssetUrl(props.visualImage());

  return (
    <div class="agent" data-visual={props.visual()}>
      <Show when={props.visual() === "image" && imageUrl() !== null}>
        <div
          class="agent__backdrop"
          style={{ "background-image": `url(${imageUrl()})` }}
        />
      </Show>
      <Show when={props.visual() === "ascii" && ascii() !== null}>
        <pre class="agent__ascii" aria-hidden="true">
          {ascii()}
        </pre>
      </Show>
      <div class="agent__head">
        <span class="agent__provider">{meta()?.provider ?? "agent"}</span>
        <Show when={meta()?.cwd}>
          <span class="agent__cwd">{meta()!.cwd}</span>
        </Show>
        <span class="agent__status" data-status={meta()?.status ?? "opening"}>
          {meta()?.status ?? "opening"}
        </span>
      </div>
      <div class="agent__body">
        <div class="agent__term">
          <div class="agent__screen" ref={screen} />
          <Show when={meta()?.status === "failed"}>
            <div class="agent__error" role="alert">
              {meta()?.error ?? "Agent failed to start."}
            </div>
          </Show>
        </div>
        <AgentChanges meta={meta} onOpenFile={props.onOpenFile} />
      </div>
      <Show when={meta()?.status === "exited"}>
        <div class="agent__exited" role="status">
          <Icon name="check" size={12} />
          Session ended — changes above reflect the final state.
        </div>
      </Show>
    </div>
  );
}
