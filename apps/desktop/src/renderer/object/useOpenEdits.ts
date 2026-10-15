import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { unsavedEdits } from '../lib/unsaved-edits';

/** The editors of one object that hold unsaved edits right now, by slot name. */
export function useOpenEdits(artifactId: string): string[] {
  const projectId = useStore((s) => s.projectId);
  const prefix = `${projectId}:${artifactId}:`;
  const [slots, setSlots] = useState<string[]>([]);
  useEffect(() => {
    const read = () => {
      const next = unsavedEdits
        .open()
        .filter((e) => e.key.startsWith(prefix))
        .map((e) => e.key.slice(prefix.length));
      setSlots((current) => (current.join() === next.join() ? current : next));
    };
    read();
    return unsavedEdits.subscribe(read);
  }, [prefix]);
  return slots;
}
