/** Live purchase-research regression. Only GPT-6 Luna / medium may run this campaign. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { AGENT_OPS, newId, type SourcePayload, type Money } from '@bureau/contracts';
import { CoreApp, nullHost, type compareComponents, type readBom } from '@bureau/core';
import { BridgeServer, CodexAdapter, writeBootstrapBrief } from '@bureau/agent-host';
import { connectMcpToBridge } from '@bureau/mcp-server';

async function main() {
  const output = path.resolve(process.argv[2] ?? 'out/parts-luna');
  fs.mkdirSync(output, { recursive: true });
  const projectDir = path.join(output, 'project');
  const observed: { url: string; status: number; html: string }[] = [];
  let page = {
    url: '',
    title: '',
    text: '',
    links: [] as { text: string; url: string }[],
    images: [] as { url: string; alt: string }[],
    structuredData: [] as unknown[],
  };
  const decode = (s: string) =>
    s
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  async function readLive(url: string) {
    // Public seller sites only in this bounded test host; no private network requests.
    const u = new URL(url);
    if (
      u.protocol !== 'https:' ||
      !['www.adafruit.com', 'www.pololu.com', 'www.sparkfun.com'].includes(u.hostname)
    )
      throw new Error('Evaluation host supports Adafruit, Pololu and SparkFun product pages');
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(25000) });
    const html = await res.text();
    observed.push({ url, status: res.status, html });
    if (!res.ok) throw new Error(`Product page HTTP ${res.status}`);
    const structuredData = [
      ...html.matchAll(
        /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
      ),
    ].flatMap((m) => {
      try {
        return [JSON.parse(m[1]!)];
      } catch {
        return [];
      }
    });
    const images = [...html.matchAll(/<img\b[^>]*>/gi)]
      .flatMap((m) => {
        const src = m[0].match(/\bsrc=["']([^"']+)["']/i)?.[1];
        return src
          ? [
              {
                url: new URL(decode(src), url).href,
                alt: decode(m[0].match(/\balt=["']([^"']*)["']/i)?.[1] ?? ''),
              },
            ]
          : [];
      })
      .slice(0, 80);
    const text = decode(
      html
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' '),
    );
    return {
      url,
      title: decode(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? ''),
      text: text.slice(0, 100000),
      images,
      structuredData,
      links: [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
        .slice(0, 300)
        .map((m) => ({
          url: new URL(decode(m[1]!), url).href,
          text: decode(m[2]!.replace(/<[^>]+>/g, ' ')).slice(0, 140),
        })),
    };
  }
  const app = new CoreApp(path.join(output, 'appdata'), {
    ...nullHost,
    async researchOpen(url) {
      try {
        page = await readLive(url);
        return { ok: true };
      } catch (e) {
        page = { url: '', title: '', text: '', links: [], images: [], structuredData: [] };
        return { ok: false, error: String(e) };
      }
    },
    async researchReadPage() {
      return page;
    },
  });
  const user = { kind: 'user' as const };
  const created = (await app.dispatch(
    'project.create',
    {
      path: projectDir,
      name: 'Sourced sensor station',
      intent: 'A small indoor temperature and humidity station, USB powered, for a desk.',
    },
    user,
  )) as { projectId: string };
  const projectId = created.projectId;
  const ctx = app.contextFor(projectId);
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofp-'));
  const bridge = new BridgeServer(app, { socketPath: path.join(socketDir, 'b.sock') });
  bridge.onMcpConnection = (sock, grant, buffered) =>
    void connectMcpToBridge(sock, app, grant, buffered);
  await bridge.ready;
  try {
    const sessionId = newId();
    const token = bridge.issueToken({ projectId, sessionId, ops: [...AGENT_OPS] });
    const bootstrapPath = writeBootstrapBrief(ctx, sessionId);
    const adapter = new CodexAdapter(() => ({}));
    const spec = await adapter.launchSpec({
      ctx,
      sessionId,
      config: {},
      bootstrapPath,
      bridgeEnv: {
        BUREAU_BRIDGE_SOCK: bridge.socketPath,
        BUREAU_BRIDGE_TOKEN: token,
        BUREAU_PROJECT_ID: projectId,
        BUREAU_SESSION_ID: sessionId,
      },
    });
    const bin = path.join(output, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'bureau'),
      `#!/bin/sh\nexec "${process.execPath}" "${path.resolve('packages/agent-host/bin/bureau.mjs')}" "$@"\n`,
      { mode: 0o755 },
    );
    const prompt = `Research exactly three purchasable parts for this desk sensor station: a USB microcontroller board, an I2C temperature/humidity breakout, and a matching cable connecting their I2C ports. Use Adafruit's exact product pages, starting with the QT Py and STEMMA QT options. You can use research_read_page to read live pages and their product photos and structured pricing, and browser_read after research_search. The test research host supports direct HTTPS pages at www.adafruit.com, www.pololu.com and www.sparkfun.com; search engines are unavailable. Read the project AGENTS.md instructions. Find suitable products using live evidence; do not guess prices or URLs. Save each as a component candidate with real product imageUrl, selectionReason, sourced offer price/currency/quantityBasis, availability and exact product URL. Read all candidates back. Propose BOM selections, quantity one of each, with the actual offerId and reason in notes. Leave proposals pending for human approval. In your final answer provide the three actual purchase links and prices and disclose any limitations. Do not buy anything.`;
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '-m',
      'gpt-6-luna',
      '-c',
      'model_reasoning_effort="medium"',
      '-c',
      'approval_policy="never"',
      '-o',
      path.join(output, 'last-message.md'),
      ...spec.args,
      prompt,
    ];
    fs.writeFileSync(
      path.join(output, 'protocol.json'),
      JSON.stringify({ model: 'gpt-6-luna', reasoningEffort: 'medium', args, projectDir }, null, 2),
    );
    const trace = fs.createWriteStream(path.join(output, 'trace.jsonl'));
    const child = spawn(spec.path, args, {
      cwd: projectDir,
      env: {
        ...process.env,
        ...spec.env,
        PATH: `${bin}${path.delimiter}${spec.env.PATH ?? process.env.PATH}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(trace);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    const timer = setTimeout(() => child.kill('SIGTERM'), 480000);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('exit', resolve);
      child.on('error', reject);
    });
    clearTimeout(timer);
    fs.writeFileSync(path.join(output, 'stderr.txt'), stderr);
    bridge.revoke(sessionId);
    const components = ctx.repo.listArtifacts({ type: 'component' });
    const compared = (await app.dispatch(
      'component.compare',
      { artifactIds: components.map((c) => c.id) },
      user,
      projectId,
    )) as ReturnType<typeof compareComponents>;
    const checks: {
      title: string;
      price: Money | null | undefined;
      url?: string;
      imageUrl?: string;
      imageStatus: number | null;
      imageType: string;
      priceInPage: boolean;
      hasReason: boolean;
      sourceMatches: boolean;
      visited: boolean;
      unapproved: boolean;
    }[] = [];
    for (const c of compared.components) {
      const p = c.payload;
      if (!p) throw new Error(`Missing component payload: ${c.artifact.title}`);
      const offer = c.offers[0];
      const source = offer?.sourceId
        ? (ctx.repo.listRevisions(offer.sourceId).at(-1)?.payload as SourcePayload | undefined)
        : null;
      if (offer?.url) await readLive(offer.url);
      const evidence = observed.find((o) => o.url === offer?.url && o.status === 200);
      let imageStatus: number | null = null;
      let imageType = '';
      if (p.imageUrl) {
        const r = await fetch(p.imageUrl, { signal: AbortSignal.timeout(20000) });
        imageStatus = r.status;
        imageType = r.headers.get('content-type') ?? '';
        await r.body?.cancel();
      }
      const recordedPrice = offer?.price?.amount;
      const priceInPage =
        !!evidence &&
        !!recordedPrice &&
        (evidence.html.includes(recordedPrice) ||
          evidence.html.includes(String(Number(recordedPrice))));
      checks.push({
        title: c.artifact.title,
        price: offer?.price,
        url: offer?.url,
        imageUrl: p.imageUrl,
        imageStatus,
        imageType,
        priceInPage,
        hasReason: !!p.selectionReason,
        sourceMatches: source?.url === offer?.url,
        visited: !!evidence,
        unapproved: c.artifact.selectedRevisionId === null,
      });
    }
    const proposals = ctx.repo.listProposals();
    const before = (await app.dispatch('bom.read', {}, user, projectId)) as ReturnType<
      typeof readBom
    >;
    // Test-only human review in the disposable project verifies the full BOM data path.
    for (const proposal of proposals.filter((p) => p.state === 'pending'))
      await app.dispatch(
        'proposal.approve',
        {
          proposalId: proposal.id,
          rationale:
            'Disposable evaluation: reviewer checked sourced fields and exact product URLs.',
        },
        user,
        projectId,
      );
    const bom = (await app.dispatch('bom.read', {}, user, projectId)) as ReturnType<typeof readBom>;
    const pass =
      exitCode === 0 &&
      checks.length === 3 &&
      checks.every(
        (c) =>
          c.visited &&
          c.priceInPage &&
          c.hasReason &&
          c.sourceMatches &&
          c.imageStatus === 200 &&
          c.imageType.startsWith('image/') &&
          c.unapproved,
      ) &&
      before.lines.length === 0 &&
      bom.lines.length === 3 &&
      bom.lines.every((l) => l.offer?.url && l.offer?.price && l.imageUrl && l.selectionReason);
    fs.writeFileSync(path.join(output, 'observations.json'), JSON.stringify(observed, null, 2));
    fs.writeFileSync(path.join(output, 'candidates.json'), JSON.stringify(compared, null, 2));
    fs.writeFileSync(
      path.join(output, 'result.json'),
      JSON.stringify({ pass, exitCode, checks, proposals: proposals.length, bom }, null, 2),
    );
    console.log(JSON.stringify({ pass, exitCode, checks, projectDir }, null, 2));
    if (!pass) process.exitCode = 1;
  } finally {
    await bridge.close();
    app.closeAll();
    fs.rmSync(socketDir, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
