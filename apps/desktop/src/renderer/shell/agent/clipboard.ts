/** Put text on the clipboard. True only when the copy actually happened. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older WebKit refuses the async API outside a direct gesture; the copy command still works.
    const active = document.activeElement as HTMLElement | null;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    active?.focus();
    return ok;
  }
}
