import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  Block,
  Button,
  Disclosure,
  Empty,
  Field,
  IconButton,
  Notice,
  Qty,
  Segmented,
  State,
  Time,
  segmentedStep,
} from '../../apps/desktop/src/renderer/ui/kit';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const h = React.createElement;
const html = (el: unknown) => renderToStaticMarkup(el) as string;

describe('Button', () => {
  it('keeps its content and width while busy: the spinner covers, presses are refused', () => {
    const out = html(h(Button, { busy: true }, 'Save requirement'));
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('aria-disabled="true"');
    expect(out).toContain('busy busy-cover');
    expect(out).toContain('<span class="btn-label">Save requirement</span>');
    expect(out).toMatch(/class="btn-spinner" aria-hidden="true"/);
  });

  it('puts the spinner in the icon slot when there is an icon', () => {
    const out = html(h(Button, { busy: true, icon: h('svg', { 'data-icon': 'x' }) }, 'Render'));
    expect(out).toMatch(/class="btn-icon"><svg data-icon="x"><\/svg><span class="btn-spinner"/);
    expect(out).not.toContain('busy-cover');
  });

  it('announces a shortcut as a shortcut, not as part of its name', () => {
    const out = html(h(Button, { shortcut: '⌘↵', variant: 'primary' }, 'Approve changes'));
    expect(out).toMatch(/aria-keyshortcuts="(Meta|Control)\+Enter"/);
    expect(out).toMatch(/<kbd class="kbd" aria-hidden="true">/);
  });

  it('renders a zero label', () => {
    expect(html(h(Button, null, 0))).toContain('<span class="btn-label">0</span>');
  });
});

describe('controls', () => {
  it('IconButton exposes toggles as pressed', () => {
    const out = html(h(IconButton, { label: 'Wireframe', pressed: true, size: 'lg' }, 'W'));
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('aria-label="Wireframe"');
    expect(out).toContain('icon-btn-lg');
  });

  it('Segmented is a radio group with one tab stop, skipping disabled options', () => {
    const out = html(
      h(Segmented, {
        label: 'Lens',
        value: 'files',
        onChange: () => {},
        options: [
          { value: 'flow', label: 'Flow' },
          { value: 'parts', label: 'Parts', count: 7 },
          { value: 'files', label: 'Files', disabled: true },
        ],
      }),
    );
    expect(out).toContain('role="radiogroup"');
    expect(out.match(/tabindex="0"/g)).toHaveLength(1);
    expect(out).toMatch(/role="radio" aria-checked="false" tabindex="0"[^>]*>Flow/);
    expect(out).toContain('aria-label="Parts, 7"');
  });

  it('Segmented arrow keys wrap and skip disabled options', () => {
    const disabled = [false, true, false, false];
    expect(segmentedStep(disabled, 0, 'ArrowRight')).toBe(2);
    expect(segmentedStep(disabled, 3, 'ArrowRight')).toBe(0);
    expect(segmentedStep(disabled, 0, 'ArrowLeft')).toBe(3);
    expect(segmentedStep(disabled, 2, 'Home')).toBe(0);
    expect(segmentedStep(disabled, 0, 'End')).toBe(3);
    expect(segmentedStep([true, true], 0, 'ArrowRight')).toBe(-1);
  });

  it('Field keeps the control id and connects an error', () => {
    const out = html(
      h(
        Field,
        { label: 'Target', error: 'Enter a number.', required: true },
        h('input', { id: 'target' }),
      ),
    );
    expect(out).toContain('for="target"');
    expect(out).toContain('id="target"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="target-error"');
    expect(out).toMatch(
      /<p id="target-error" class="field-error" role="alert">Enter a number\.<\/p>/,
    );
    expect(out).toContain('aria-required="true"');
  });
});

describe('content primitives', () => {
  it('State renders the vocabulary word for its dimension', () => {
    expect(html(h(State, { state: 'pending' }))).toContain('In review');
    expect(html(h(State, { state: 'passed', dimension: 'verification' }))).toContain('Verified');
    expect(html(h(State, { state: 'stale' }))).toContain('tone-warn');
  });

  it('Notice says its tone in words for assistive technology', () => {
    expect(html(h(Notice, { tone: 'err' }, 'Missing input.'))).toContain(
      '<span class="sr-only">Problem: </span>Missing input.',
    );
    expect(html(h(Notice, null, 'Plain.'))).not.toContain('sr-only');
  });

  it('Block keeps its count apart from its title', () => {
    expect(html(h(Block, { title: 'Depends on', count: 2 }, 'x'))).toContain(
      'Depends on<span class="sr-only">, </span><span class="count">2</span>',
    );
  });

  it('Disclosure manages itself when uncontrolled and names its body', () => {
    const closed = html(h(Disclosure, { label: 'Detail' }, 'Body'));
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('Body');
    const open = html(h(Disclosure, { label: 'Detail', defaultOpen: true }, 'Body'));
    const id = /aria-controls="([^"]+)"/.exec(open)?.[1];
    expect(id).toBeTruthy();
    expect(open).toContain(`id="${id}">Body`);
  });

  it('Empty takes the heading level of its outline', () => {
    expect(html(h(Empty, { title: 'Nothing waiting', as: 'h2' }))).toContain(
      '<h2 class="empty-title">Nothing waiting</h2>',
    );
  });

  it('Qty marks unknown and not set values', () => {
    expect(html(h(Qty, { value: null }))).toBe('<span class="qty unknown">Not set</span>');
    expect(html(h(Qty, { value: { value: 4, unit: 'g' } }))).toBe(
      '<span class="qty num">4 g</span>',
    );
  });

  it('Time carries the exact moment and says unknown for unreadable input', () => {
    const out = html(h(Time, { value: '2026-09-26' }));
    expect(out).toContain('dateTime="2026-09-26"');
    expect(html(h(Time, { value: 'later' }))).toContain('Unknown time');
  });
});
