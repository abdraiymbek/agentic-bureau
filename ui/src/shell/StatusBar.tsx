import { Show, type JSXElement } from "solid-js";

import type { BrokenBlockRef } from "../api/blocks";
import FeatureBoundary from "../core/FeatureBoundary";
import type { SettingsState } from "../settings/settingsState";
import { formatBrokenBlockRefs } from "../statusbar/brokenRefs";
import PendingRewrites from "../statusbar/PendingRewrites";
import { formatPendingRewrites } from "../statusbar/pendingRewritesLabel";
import {
  BLOCK_COUNT_SEGMENT,
  FILE_PATH_SEGMENT,
  VAULT_PATH_SEGMENT,
  WORD_COUNT_SEGMENT,
} from "../statusbar/segments";
import { leadingSeparators } from "../statusbar/separators";
import type { TabView } from "../tabs/tabModel";
import { showErrorToast } from "../toast/toastState";

export function StatusBar(props: {
  settings: SettingsState;
  vaultId: string | null;
  vaultPath: string | null;
  scanStatus: string;
  filesProcessed: number;
  filesTotalEstimate: number;
  brokenBlockRefs: BrokenBlockRef[];
  pendingRewritesCount: number;
  view: TabView;
  selectedPath: string | null;
  wordCount: number;
  blockCount: number;
}): JSXElement {
  const s = () => props.settings;
  const vaultVis = () => s().segVisible(VAULT_PATH_SEGMENT);
  const scanVis = () => props.scanStatus === "in_progress";
  const brokenVis = () => !!formatBrokenBlockRefs(props.brokenBlockRefs);
  const pendingVis = () => !!formatPendingRewrites(props.pendingRewritesCount);
  const sep = () =>
    leadingSeparators([vaultVis(), scanVis(), brokenVis(), pendingVis()]);

  return (
    <FeatureBoundary feature="Status bar">
      <footer class="statusbar">
        <span class="statusbar__group statusbar__group--proj">
          <Show when={vaultVis()}>
            <span class="statusbar__dir" title={props.vaultPath ?? ""}>
              {props.vaultPath ?? props.vaultId}
            </span>
          </Show>
          <Show when={scanVis()}>
            <Show when={sep()[1]}>
              <span class="statusbar__sep">·</span>
            </Show>
            <span>
              Scanning… {props.filesProcessed} / {props.filesTotalEstimate}
            </span>
          </Show>
          <Show when={formatBrokenBlockRefs(props.brokenBlockRefs)}>
            {(display) => (
              <>
                <Show when={sep()[2]}>
                  <span class="statusbar__sep">·</span>
                </Show>
                <span
                  title={display().title}
                  style={{ color: "var(--c-warning, var(--c-accent))" }}
                >
                  {display().label}
                </span>
              </>
            )}
          </Show>
          <Show when={sep()[3]}>
            <span class="statusbar__sep">·</span>
          </Show>
          <PendingRewrites
            vaultId={props.vaultId}
            count={props.pendingRewritesCount}
            onError={(m: string) => showErrorToast(m)}
          />
        </span>

        <Show when={props.view.kind === "file" && !!props.selectedPath}>
          {(() => {
            const wordVis = () => s().segVisible(WORD_COUNT_SEGMENT);
            const blockVis = () => s().segVisible(BLOCK_COUNT_SEGMENT);
            const midSep = () => leadingSeparators([wordVis(), blockVis()]);
            return (
              <span class="statusbar__group statusbar__mid">
                <Show when={wordVis()}>
                  <b>{props.wordCount}</b> words
                </Show>
                <Show when={blockVis()}>
                  <Show when={midSep()[1]}>
                    <span class="statusbar__sep">·</span>
                  </Show>
                  <b>{props.blockCount}</b> blocks
                </Show>
              </span>
            );
          })()}
        </Show>

        <span class="statusbar__group statusbar__group--file">
          <Show
            when={
              props.view.kind === "file" &&
              props.selectedPath &&
              s().segVisible(FILE_PATH_SEGMENT)
            }
          >
            <span class="statusbar__dir" title={props.selectedPath ?? ""}>
              {props.selectedPath}
            </span>
          </Show>
        </span>
      </footer>
    </FeatureBoundary>
  );
}
