import type { ChatInput, ChatPart } from '@omenflow/contracts';
import { unitDef } from '../ui/units';

export type QuantityFields = Extract<ChatPart, { kind: 'form' }>['fields'];
export type QuantityDraft = ChatInput['fields'];

/** Validate against the recorded field, including drafts restored from local storage. */
export function quantityProblem(fields: QuantityFields, draft: QuantityDraft): string | null {
  if (draft.length !== fields.length) return 'The recorded fields changed. Reopen this form.';
  for (let i = 0; i < fields.length; i++) {
    const recorded = fields[i]!;
    const field = draft[i]!;
    if (field.name !== recorded.name) return 'The recorded fields changed. Reopen this form.';
    const label = recorded.label || recorded.name;
    if (recorded.unit) {
      if (!field.unit.trim()) return `${label} needs its recorded unit (${recorded.unit}).`;
      if (field.unknown && field.unit !== recorded.unit)
        return `${label} is unknown; keep its recorded unit (${recorded.unit}).`;
      const from = unitDef(recorded.unit);
      const to = unitDef(field.unit);
      if (field.unit !== recorded.unit && (!from || !to || from.dim !== to.dim))
        return `${label} needs a unit compatible with ${recorded.unit}.`;
    } else if (field.unknown && field.unit !== recorded.unit) {
      return `${label} is unknown; keep its unit explicitly unspecified.`;
    }
    if (field.unknown) {
      if (!field.reason?.trim()) return `${label} needs a reason for being unknown.`;
    } else if (
      !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(field.text.trim()) ||
      !Number.isFinite(Number(field.text))
    ) {
      return `${label} needs a finite number.`;
    }
  }
  return null;
}
