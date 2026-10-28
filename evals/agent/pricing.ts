/**
 * What an evaluation run cost at list price, estimated from the tokens the CLI reported.
 *
 * The CLI's own figure is never used: Claude Code 2.1.287 prices a model it does not know at
 * another model's rates (Claude Haiku 5.5 at Claude Opus 5.5 rates, measured at about 36 times
 * list price), and it does not say when it did. Bureau itself never shows a cost.
 */

/** When the table below was taken from the source. */
export const PRICES_AS_OF = '2026-10-06';
export const PRICES_SOURCE =
  'Anthropic first-party list prices (claude-api reference, cached 2026-10-06)';

/** USD per million tokens. */
export interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}
export interface ModelPrice {
  rate: Rate;
  /** A request whose prompt (input, cache reads and writes) is above `above` tokens costs `rate`. */
  long?: { above: number; rate: Rate };
}

const rate = (input: number, output: number, cacheRead = input * 0.1): Rate => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-5-5': { rate: rate(0.1, 0.5), long: { above: 100_000, rate: rate(0.5, 2.5) } },
  'claude-sonnet-5-5': { rate: rate(2, 10, 0.2) },
  'claude-opus-5-5': { rate: rate(4, 20, 0.2) },
  'claude-fable-5-1': { rate: rate(10, 50, 0.25) },
  'claude-haiku-4-5': { rate: rate(1, 5) },
};

/**
 * The list price of a first-party model id, also with a release date (`-20251001`). A
 * provider's id (Bedrock, Vertex: `us.anthropic.…`, `…@date`) or a context variant (`[1m]`) is
 * priced separately by that provider, so it has no price here.
 */
export function priceOf(model: string): ModelPrice | null {
  const id = model.trim().toLowerCase();
  return PRICES[id] ?? PRICES[id.replace(/-\d{8}$/, '')] ?? null;
}

export interface CostEstimate {
  /** Null when a model that ran has no price. */
  usd: number | null;
  unpriced: string[];
  /** Requests seen in the stream, and how many of them were priced at a long-prompt tier. */
  requests: number;
  longRequests: number;
}

interface Request {
  model: string;
  input: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
}

const count = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0);

/**
 * Estimate a Claude Code run from its stream-json events.
 *
 * - Prompt side, per request: `assistant` events carry the request's `message.usage`; one
 *   request emits an event per content block, so they are deduplicated by `message.id` (the
 *   last one wins). Cache writes are split into 5-minute and 1-hour writes when
 *   `usage.cache_creation` says so, else counted as 5-minute writes.
 * - A request is long when its whole prompt is above the model's long-prompt threshold.
 * - Output: `result.modelUsage[model].outputTokens`, split between the tiers by the model's
 *   share of long requests (the per-request output in `assistant` events is partial).
 * - Prompt tokens in `modelUsage` beyond what `assistant` events show (background or subagent
 *   requests) are priced at the short tier; their cache writes at the 1-hour rate when the
 *   run's `result.usage.cache_creation` shows only 1-hour writes, else at the 5-minute rate.
 */
export function estimateClaudeRun(events: Record<string, any>[]): CostEstimate {
  const requests = new Map<string, Request>();
  let result: Record<string, any> | undefined;
  for (const event of events) {
    if (event.type === 'result') result = event;
    // Subagent requests count too: they are requests of the run, with their own message ids.
    if (event.type !== 'assistant') continue;
    const message = event.message ?? {};
    const usage = message.usage;
    if (!usage || typeof message.model !== 'string') continue;
    const split = usage.cache_creation;
    const write5m = split
      ? count(split.ephemeral_5m_input_tokens)
      : count(usage.cache_creation_input_tokens);
    const write1h = split ? count(split.ephemeral_1h_input_tokens) : 0;
    requests.set(String(message.id ?? requests.size), {
      model: message.model,
      input: count(usage.input_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      write5m,
      write1h,
    });
  }
  const runSplit = result?.usage?.cache_creation;
  const onlyHourWrites =
    !!runSplit &&
    count(runSplit.ephemeral_5m_input_tokens) === 0 &&
    count(runSplit.ephemeral_1h_input_tokens) > 0;
  const models = new Set<string>([
    ...[...requests.values()].map((request) => request.model),
    ...Object.keys(result?.modelUsage ?? {}),
  ]);
  const unpriced: string[] = [];
  let usd = 0;
  let longRequests = 0;
  for (const model of models) {
    const price = priceOf(model);
    if (!price) {
      unpriced.push(model);
      continue;
    }
    const seen = [...requests.values()].filter((request) => request.model === model);
    const isLong = (request: Request) =>
      !!price.long &&
      request.input + request.cacheRead + request.write5m + request.write1h > price.long.above;
    const tierOf = (request: Request) => (isLong(request) ? price.long!.rate : price.rate);
    const prompt = (request: Request, at: Rate) =>
      request.input * at.input +
      request.cacheRead * at.cacheRead +
      request.write5m * at.cacheWrite5m +
      request.write1h * at.cacheWrite1h;
    let cost = 0;
    for (const request of seen) cost += prompt(request, tierOf(request));
    const long = seen.filter(isLong).length;
    longRequests += long;
    const reported = result?.modelUsage?.[model] ?? {};
    const output = count(reported.outputTokens);
    const longShare = seen.length ? long / seen.length : 0;
    cost +=
      output * (1 - longShare) * price.rate.output +
      (price.long ? output * longShare * price.long.rate.output : 0);
    // Requests the stream did not show, priced at the short tier.
    const total = (key: keyof Omit<Request, 'model'>) =>
      seen.reduce((sum, request) => sum + request[key], 0);
    const extraInput = Math.max(0, count(reported.inputTokens) - total('input'));
    const extraRead = Math.max(0, count(reported.cacheReadInputTokens) - total('cacheRead'));
    const extraWrite = Math.max(
      0,
      count(reported.cacheCreationInputTokens) - total('write5m') - total('write1h'),
    );
    cost +=
      extraInput * price.rate.input +
      extraRead * price.rate.cacheRead +
      extraWrite * (onlyHourWrites ? price.rate.cacheWrite1h : price.rate.cacheWrite5m);
    usd += cost / 1_000_000;
  }
  return {
    usd: unpriced.length ? null : usd,
    unpriced: unpriced.sort(),
    requests: requests.size,
    longRequests,
  };
}
