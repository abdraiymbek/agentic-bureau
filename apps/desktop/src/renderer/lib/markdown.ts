/**
 * Recorded markdown as HTML that cannot run script or take the window anywhere. Three layers:
 * the renderer writes an anchor only for an http(s) destination, the sanitiser strips every
 * other URL and all active content from raw HTML, and the prose container opens links through
 * the system browser instead of letting the webview follow them.
 */
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { webUrl } from '../ui/ExternalLink';

function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const markdown = new Marked({
  gfm: true,
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const url = webUrl(href);
      // A destination that is not a web address keeps its words and loses its link.
      if (!url) return text;
      const hint = title ? ` title="${attribute(title)}"` : '';
      return `<a href="${attribute(url)}"${hint}>${text}</a>`;
    },
  },
});

/** Markdown to HTML, before sanitising. Exposed for tests; render with `safeMarkdown`. */
export function markdownHtml(text: string): string {
  return markdown.parse(text, { async: false }) as string;
}

const SANITIZE = {
  USE_PROFILES: { html: true },
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option', 'style'],
  FORBID_ATTR: ['style'],
};

export function safeMarkdown(text: string): string {
  return DOMPurify.sanitize(markdownHtml(text), SANITIZE);
}

export function safeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } });
}

/** The web address a clicked anchor may open in the system browser, or null to do nothing. */
export function linkDestination(href: string | null | undefined): string | null {
  return webUrl(href ?? undefined);
}
