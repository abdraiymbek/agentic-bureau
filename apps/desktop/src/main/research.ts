import { BrowserWindow, WebContentsView } from 'electron';
import { MAX_EXTRACT_CHARS } from '@stark/contracts';

/**
 * Isolated research browser: a WebContentsView on a separate partition with no
 * preload, no node, and only app-owned extraction scripts. Rendered as an
 * overlay panel on the right side of the main window when shown.
 */
export class ResearchSurface {
  private view: WebContentsView | null = null;
  private visible = false;

  constructor(private getWindow: () => BrowserWindow | null) {}

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    const win = this.getWindow();
    if (!win) throw new Error('No window');
    this.view = new WebContentsView({
      webPreferences: {
        partition: 'research',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: undefined,
      },
    });
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.view.webContents.on('will-navigate', (e, url) => {
      if (!/^https?:/.test(url)) e.preventDefault();
    });
    win.contentView.addChildView(this.view);
    this.layout();
    win.on('resize', () => this.layout());
    return this.view;
  }

  private layout(): void {
    const win = this.getWindow();
    if (!win || !this.view) return;
    const { width, height } = win.getContentBounds();
    const w = Math.min(560, Math.floor(width * 0.42));
    this.view.setBounds({ x: width - w, y: 40, width: w, height: height - 40 });
    this.view.setVisible(this.visible);
  }

  show(): void {
    this.ensure();
    this.visible = true;
    this.layout();
  }
  hide(): void {
    this.visible = false;
    this.view?.setVisible(false);
  }
  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }
  get isVisible(): boolean {
    return this.visible;
  }

  async open(url: string): Promise<{ ok: boolean; error?: string }> {
    try {
      this.show();
      await this.ensure().webContents.loadURL(url);
      this.layout();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async readPage(): Promise<{ url: string; title: string; text: string; links: { text: string; url: string }[] }> {
    const v = this.ensure();
    return v.webContents.executeJavaScript(`(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText ?? '').slice(0, ${MAX_EXTRACT_CHARS}),
      links: [...document.querySelectorAll('a[href]')].slice(0, 300).map(a => ({ text: (a.innerText || '').slice(0, 140), url: a.href }))
    }))()`);
  }

  async followLink(sel: { selector?: string; url?: string }): Promise<{ ok: boolean; error?: string }> {
    const v = this.ensure();
    try {
      if (sel.url) {
        await v.webContents.loadURL(sel.url);
        return { ok: true };
      }
      if (sel.selector) {
        const navigated = await v.webContents.executeJavaScript(`(() => {
          const el = document.querySelector(${JSON.stringify(sel.selector)});
          if (!el) return false;
          el.click();
          return true;
        })()`);
        return navigated ? { ok: true } : { ok: false, error: 'selector not found' };
      }
      return { ok: false, error: 'need selector or url' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async screenshot(): Promise<{ pngBase64: string }> {
    const v = this.ensure();
    const img = await v.webContents.capturePage();
    return { pngBase64: img.toPNG().toString('base64') };
  }
}
