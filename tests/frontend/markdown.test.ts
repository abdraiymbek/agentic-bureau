import { describe, expect, it } from 'vitest';
import { linkDestination, markdownHtml } from '../../apps/desktop/src/renderer/lib/markdown';

describe('markdown link safety', () => {
  it('writes an anchor only for a web address', () => {
    const html = markdownHtml('[datasheet](https://example.com/a?b=1&c=2 "Rev C")');
    expect(html).toContain(
      '<a href="https://example.com/a?b=1&amp;c=2" title="Rev C">datasheet</a>',
    );
  });
  it.each([
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['file:///etc/passwd'],
    ['omenflow-app://index.html'],
    ['/settings'],
    ['../other'],
    ['//evil.example/path'],
    ['#top'],
    ['mailto:a@example.com'],
  ])('keeps the words and drops the link for %s', (target) => {
    const html = markdownHtml(`before [the words](${target}) after`);
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
    expect(html).toContain('the words');
  });
  it('renders bare and bracketed web addresses as web links', () => {
    expect(markdownHtml('See https://example.com/x and <http://example.org>.')).toMatch(
      /<a href="https:\/\/example\.com\/x">.*<a href="http:\/\/example\.org\/?">/,
    );
  });
  it('cannot be broken out of with quotes in a destination or title', () => {
    const html = markdownHtml('[x](https://example.com/"onmouseover="alert(1) "a\\"b")');
    expect(html).not.toMatch(/href="[^"]*"\s*onmouseover=/);
    expect(html).not.toContain('title="a"b"');
  });
  it('opens only http and https from a clicked anchor', () => {
    expect(linkDestination('https://example.com/part')).toBe('https://example.com/part');
    expect(linkDestination('http://example.com')).toBe('http://example.com/');
    for (const href of [null, undefined, '', '/settings', '#x', 'javascript:alert(1)', 'blob:x'])
      expect(linkDestination(href)).toBeNull();
  });
});
