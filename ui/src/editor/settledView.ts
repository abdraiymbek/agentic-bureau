import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";

// Markdown's parse is incremental with a time budget — under worker
// contention the tree can be incomplete when decoration fields initialise,
// so widget assertions flake. Finish the parse, then force one real
// transaction so every field recomputes against the complete tree.
export function settledState(state: EditorState): EditorState {
  ensureSyntaxTree(state, state.doc.length, 5_000);
  return state.update({ changes: { from: state.doc.length, insert: " " } })
    .state;
}

export function settledView(state: EditorState): EditorView {
  return new EditorView({ state: settledState(state), parent: document.body });
}
