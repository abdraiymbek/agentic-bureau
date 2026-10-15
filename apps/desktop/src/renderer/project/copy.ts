/** Copying a value the person asked for, with the outcome reported. */
import { useStore } from '../store';

/** Copies text for the person; reports the outcome rather than assuming it. */
export async function copyText(text: string, what: string) {
  const { toast } = useStore.getState();
  try {
    await navigator.clipboard.writeText(text);
    toast('ok', `Copied ${what}`);
  } catch {
    toast('error', `Couldn’t copy ${what}. Select it and copy it instead.`);
  }
}
