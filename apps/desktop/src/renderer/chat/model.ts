/** Which model ran a conversation turn, as the host recorded it. */
import type { ChatTurn } from '@omenflow/contracts';

/** The model to show for a turn: what the CLI reported, else what Omen Flow passed. */
export function turnModel(turn: ChatTurn): string | null {
  return turn.resolvedModel ?? turn.model ?? null;
}

/**
 * A model id reduced to the model it names: lower case, without a provider's prefix
 * (`us.anthropic.`, `anthropic/`), a context tag (`[1m]`), a version (`@…`, `-v1:0`) or a
 * release date (`-20251001`).
 */
export function modelKey(id: string): string {
  let key = id.trim().toLowerCase();
  const claude = key.indexOf('claude-');
  if (claude > 0) key = key.slice(claude);
  return key
    .replace(/\[[^\]]*\]$/, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/-\d{8}$/, '');
}

/**
 * True when Omen Flow passed a full model id and the CLI reported running another model. An
 * alias the CLI resolves itself, a dated id of the same model and a provider's id for it are
 * not mismatches; `claude-opus-5` is not `claude-opus-5-5`.
 */
export function modelMismatch(turn: ChatTurn): boolean {
  const { model, resolvedModel } = turn;
  if (!model || !resolvedModel || !model.includes('-')) return false;
  return modelKey(model) !== modelKey(resolvedModel);
}
