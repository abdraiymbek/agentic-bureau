import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_TOOL_OPS } from '@omenflow/contracts';
import { CoreApp, nullHost } from './index.js';
const roots: string[] = [];
const apps: CoreApp[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.closeAll();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
async function setup(host = nullHost) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-test-'));
  roots.push(root);
  const app = new CoreApp(path.join(root, 'app'), host);
  apps.push(app);
  const user = { kind: 'user' as const };
  const agent = { kind: 'agent' as const, sessionId: '00000000-0000-4000-8000-000000000123' };
  const p = (await app.dispatch(
    'project.create',
    { path: path.join(root, 'project'), name: 'Parts' },
    user,
  )) as { projectId: string };
  return {
    app,
    user,
    agent,
    call: (op: string, input: unknown, origin = agent) =>
      app.dispatch(op, input, origin, p.projectId) as Promise<any>,
    projectId: p.projectId,
  };
}
describe('purchase fields across candidate, proposal and BOM', () => {
  it('keeps sourced photos and reasons through approval; uses selected offer and pack basis', async () => {
    const { app, call, user, projectId } = await setup();
    const source = await call('source.capture', {
      title: 'Product page',
      url: 'https://www.adafruit.com/product/4210',
      excerpt: 'Cable, pack of 2, USD 4.00',
      sourceKind: 'supplier',
    });
    const c = await call('component.add_candidate', {
      title: 'Cable',
      manufacturer: 'Adafruit',
      partNumber: '4210',
      imageUrl: 'https://cdn-shop.adafruit.com/970x728/4210-01.jpg',
      selectionReason: 'Connects matching I2C ports.',
      sourceId: source.artifact.id,
      offer: {
        seller: 'Adafruit',
        url: 'https://www.adafruit.com/product/4210',
        price: { amount: '4.00', currency: 'USD' },
        quantityBasis: 2,
        sourceId: source.artifact.id,
      },
    });
    const comparison = await call('component.compare', { artifactIds: [c.artifact.id] });
    expect(comparison.components[0].payload.imageUrl).toContain('4210-01.jpg');
    const offer = comparison.components[0].offers[0];
    const proposal = await call('component.propose_selection', {
      artifactId: c.artifact.id,
      revisionId: c.revision.id,
      bomLines: [{ quantity: 4, offerId: offer.id }],
      reason: 'Two packs needed',
    });
    expect((await call('bom.read', {})).lines).toHaveLength(0);
    await app.dispatch(
      'proposal.approve',
      { proposalId: proposal.proposal.id, rationale: 'Reviewed' },
      user,
      projectId,
    );
    const bom = await call('bom.read', {});
    expect(bom.lines[0]).toMatchObject({
      imageUrl: c.revision.payload.imageUrl,
      selectionReason: 'Connects matching I2C ports.',
      offer: { url: offer.url, price: { amount: '4.00', currency: 'USD' }, quantityBasis: 2 },
      lineTotal: { amount: '8.00', currency: 'USD' },
    });
  });
  it('exposes read-only page research and stops after a failed navigation instead of returning stale data', async () => {
    let reads = 0;
    const { call } = await setup({
      ...nullHost,
      async researchOpen() {
        return { ok: false, error: '404 product missing' };
      },
      async researchReadPage() {
        reads++;
        return { url: 'https://old-shop.com/', title: 'Wrong part', text: '10 USD', links: [] };
      },
    });
    expect(AGENT_TOOL_OPS.has('research.read_page')).toBe(true);
    expect(AGENT_TOOL_OPS.has('browser.open')).toBe(false);
    await expect(
      call('research.read_page', { url: 'https://www.adafruit.com/product/missing' }),
    ).rejects.toThrow('404 product missing');
    expect(reads).toBe(0);
    for (const url of [
      'file:///etc/passwd',
      'http://127.0.0.2/',
      'http://[::1]/',
      'https://user:pass@www.adafruit.com/',
    ])
      await expect(call('research.read_page', { url })).rejects.toThrow();
  });
});
