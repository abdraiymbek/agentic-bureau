/** Evaluation cost estimates come from list prices and the CLI's tokens, never the CLI's own figure. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeMetrics, codexMetrics } from '../evals/agent/cli';
import { estimateClaudeRun, priceOf, PRICES_AS_OF } from '../evals/agent/pricing';

const here = path.dirname(fileURLToPath(import.meta.url));
const lines = fs
  .readFileSync(path.join(here, 'fixtures/claude-stream-haiku-5-5.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean);
const events = lines.map((line) => JSON.parse(line) as Record<string, any>);

describe('list-price estimate of a Claude Code run', () => {
  it('prices each request once, with 1-hour writes, the long tier and unseen requests', () => {
    // msg_1 (short): 10 input × 0.10 + 20,000 one-hour writes × 0.20 = 4,001
    // msg_2 (long, 121,050 prompt tokens): 50 × 0.50 + 120,000 reads × 0.05 + 1,000 writes × 1.00 = 7,025
    // 400 output tokens, half at each tier: 200 × 0.50 + 200 × 2.50 = 600
    // 100 input tokens no assistant event shows, short tier: 100 × 0.10 = 10
    const estimate = estimateClaudeRun(events);
    expect(estimate.usd).toBeCloseTo(11_636 / 1_000_000, 12);
    expect(estimate).toMatchObject({ unpriced: [], requests: 2, longRequests: 1 });
  });

  it('keeps the CLI figure apart, for audit, and drops its cost from the per-model tokens', () => {
    const metrics = claudeMetrics(lines);
    expect(metrics.costUsd).toBeCloseTo(0.011636, 9);
    expect(metrics.cliCostUsd).toBe(0.4321);
    expect(metrics.pricesAsOf).toBe(PRICES_AS_OF);
    expect(metrics.model).toBe('claude-haiku-5-5');
    expect(metrics.modelUsage).toEqual({
      'claude-haiku-5-5': {
        inputTokens: 160,
        outputTokens: 400,
        cacheReadInputTokens: 120000,
        cacheCreationInputTokens: 21000,
      },
    });
    expect(JSON.stringify(metrics.modelUsage)).not.toContain('cost');
    expect(metrics.inputTokens).toBe(160 + 21000 + 120000);
    expect(codexMetrics([])).toMatchObject({ costUsd: null, cliCostUsd: null, model: null });
  });

  it('gives no figure when a model that ran has no list price here', () => {
    const renamed = lines.map((line) => line.replaceAll('claude-haiku-5-5', 'claude-mystery-9'));
    const metrics = claudeMetrics(renamed);
    expect(metrics.costUsd).toBeNull();
    expect(metrics.unpricedModels).toEqual(['claude-mystery-9']);
    expect(metrics.cliCostUsd).toBe(0.4321);
  });

  it('prices first-party ids only: a provider prices its own ids separately', () => {
    expect(priceOf('claude-haiku-5-5')?.long?.above).toBe(100_000);
    expect(priceOf(' Claude-Haiku-4-5-20251001 ')?.rate.input).toBe(1);
    expect(priceOf('claude-opus-5-5')?.rate).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
    });
    for (const id of [
      'us.anthropic.claude-opus-5-5',
      'anthropic.claude-opus-5-5-20260101-v1:0',
      'claude-opus-5-5@20260101',
      'claude-opus-5-5[1m]',
      'haiku',
    ])
      expect(priceOf(id), id).toBeNull();
  });
});
