import { useCallback, useEffect, useRef, useState } from 'react';
import { unsavedEdits } from '../lib/unsaved-edits';

/**
 * A small form that is not a revision edit (a new observation, say) but must not be lost
 * either: it registers while it holds input, survives an unasked unmount, and clears when
 * a leave request is answered with "discard".
 */
export function useParkedForm<T extends Record<string, unknown>>(
  key: string,
  label: string,
  empty: T,
  filled: (form: T) => boolean,
): { form: T; edit: (patch: Partial<T>) => void; clear: () => void } {
  const [form, setForm] = useState<T>(() => {
    const entry = unsavedEdits.peek(key);
    return entry && !entry.mounted ? (entry.snapshot as T) : empty;
  });
  const emptyRef = useRef(empty);
  const dirty = filled(form);
  const registered = useRef(false);
  useEffect(() => {
    if (dirty) {
      unsavedEdits.put({ key, label, mounted: true, snapshot: form });
      registered.current = true;
    } else {
      registered.current = false;
      unsavedEdits.drop(key);
    }
  }, [dirty, form, key, label]);
  useEffect(() => () => unsavedEdits.park(key), [key]);
  useEffect(
    () =>
      unsavedEdits.subscribe(() => {
        if (!registered.current || unsavedEdits.peek(key)) return;
        registered.current = false;
        setForm(emptyRef.current);
      }),
    [key],
  );
  const edit = useCallback((patch: Partial<T>) => setForm((f) => ({ ...f, ...patch })), []);
  const clear = useCallback(() => setForm(emptyRef.current), []);
  return { form, edit, clear };
}
