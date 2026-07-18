import { z } from 'zod';
import * as http from 'http';
import * as https from 'https';

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function hasExpectedPrototype(value: object, array: boolean): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) {
    return false;
  }
  const parent = Object.getPrototypeOf(prototype);
  if (!array) {
    return parent === null;
  }
  return (
    parent !== null &&
    Object.getPrototypeOf(parent) === null &&
    Object.prototype.hasOwnProperty.call(prototype, 'push')
  );
}

function addUnsafeKeyIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number> = []
): void {
  if (Array.isArray(value)) {
    if (!hasExpectedPrototype(value, true)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Array prototype is not allowed.',
        path,
      });
      return;
    }
    value.forEach((item, index) => addUnsafeKeyIssues(item, ctx, [...path, index]));
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (!hasExpectedPrototype(value, false)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Object prototype is not allowed.',
      path,
    });
    return;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsafe key \"${key}\" is not allowed.`,
        path: [...path, key],
      });
    }

    addUnsafeKeyIssues(nestedValue, ctx, [...path, key]);
  }
}

function safeObject<T extends z.ZodRawShape>(shape: T) {
  return z
    .object(shape)
    .passthrough()
    .superRefine((value, ctx) => addUnsafeKeyIssues(value, ctx));
}

function guardRawInput<T extends z.ZodTypeAny>(schema: T): T {
  return z
    .unknown()
    .superRefine((value, ctx) => addUnsafeKeyIssues(value, ctx))
    .pipe(schema) as unknown as T;
}

const OpenAIFunctionCallSchema = safeObject({
  name: z.string().min(1),
  arguments: z.string(),
});

const OpenAIChatToolFunctionSchema = safeObject({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
});

const OpenAIChatToolSchema = safeObject({
  type: z.literal('function'),
  function: OpenAIChatToolFunctionSchema,
});

const OpenAIChatToolCallSchema = safeObject({
  id: z.string().min(1),
  type: z.literal('function'),
  function: OpenAIFunctionCallSchema,
});

const OpenAIResponseFormatSchema = z.union([
  safeObject({
    type: z.literal('text'),
  }),
  safeObject({
    type: z.literal('json_object'),
  }),
  safeObject({
    type: z.literal('json_schema'),
    json_schema: safeObject({
      name: z.string().min(1),
      description: z.string().min(1).optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
      strict: z.boolean().optional(),
    }),
  }),
]);

const OpenAILogitBiasSchema = z.record(z.string(), z.number());

const OpenAIStreamOptionsSchema = safeObject({
  include_usage: z.boolean().optional(),
});

const OpenAIUsageSchema = safeObject({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  prompt_tokens_details: z.record(z.string(), z.number().int().nonnegative()).optional(),
  completion_tokens_details: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

const OpenAITopLogprobSchema = safeObject({
  token: z.string(),
  logprob: z.number(),
  bytes: z.array(z.number().int().min(0).max(255)).nullable().optional(),
});

const OpenAILogprobContentSchema = safeObject({
  token: z.string(),
  logprob: z.number(),
  bytes: z.array(z.number().int().min(0).max(255)).nullable().optional(),
  top_logprobs: z.array(OpenAITopLogprobSchema).optional(),
});

const OpenAILogprobsSchema = safeObject({
  content: z.array(OpenAILogprobContentSchema).nullable().optional(),
  refusal: z.array(OpenAILogprobContentSchema).nullable().optional(),
}).refine(value => value.content !== undefined || value.refusal !== undefined, {
  message: 'logprobs must include content or refusal',
}) as z.ZodType<Record<string, unknown>>;

/**
 * Zod Schema representing an OpenAI-compatible Chat Message.
 */
export const OpenAIChatMessageSchema = z
  .object({
    role: z.enum(['developer', 'system', 'user', 'assistant', 'tool', 'function']),
    content: z.union([z.string(), z.null()]).optional(),
    name: z.string().min(1).optional(),
    tool_call_id: z.string().min(1).optional(),
    function_call: OpenAIFunctionCallSchema.optional(),
    tool_calls: z.array(OpenAIChatToolCallSchema).min(1).optional(),
    refusal: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => addUnsafeKeyIssues(value, ctx));

export const OpenAIChatCompletionRequestSchema = guardRawInput(
  z
    .object({
      model: z.string().min(1),
      messages: z.array(OpenAIChatMessageSchema).min(1),
      temperature: z.number().min(0).max(2).optional(),
      top_p: z.number().min(0).max(1).optional(),
      max_tokens: z.number().int().positive().optional(),
      max_completion_tokens: z.number().int().positive().optional(),
      n: z.number().int().positive().optional(),
      stop: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
      presence_penalty: z.number().min(-2).max(2).optional(),
      frequency_penalty: z.number().min(-2).max(2).optional(),
      logit_bias: OpenAILogitBiasSchema.optional(),
      logprobs: z.boolean().optional(),
      top_logprobs: z.number().int().min(0).max(20).optional(),
      seed: z.number().int().optional(),
      tools: z.array(OpenAIChatToolSchema).min(1).optional(),
      tool_choice: z
        .union([
          z.enum(['none', 'auto', 'required']),
          z
            .object({
              type: z.literal('function'),
              function: z
                .object({
                  name: z.string().min(1),
                })
                .strict(),
            })
            .strict(),
        ])
        .optional(),
      parallel_tool_calls: z.boolean().optional(),
      response_format: OpenAIResponseFormatSchema.optional(),
      stream: z.boolean().optional(),
      stream_options: OpenAIStreamOptionsSchema.optional(),
      metadata: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional(),
      user: z.string().min(1).optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => addUnsafeKeyIssues(value, ctx))
);

export const OpenAIChatCompletionChoiceSchema = z
  .object({
    index: z.number().int().nonnegative(),
    message: OpenAIChatMessageSchema,
    logprobs: OpenAILogprobsSchema.nullish(),
    finish_reason: z.union([
      z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']),
      z.null(),
    ]),
  })
  .passthrough()
  .superRefine((value, ctx) => addUnsafeKeyIssues(value, ctx));

export const OpenAIChatCompletionResponseSchema = guardRawInput(
  z
    .object({
      id: z.string().min(1),
      object: z.literal('chat.completion'),
      created: z.number().int().nonnegative(),
      model: z.string().min(1),
      choices: z.array(OpenAIChatCompletionChoiceSchema).min(1),
      usage: OpenAIUsageSchema.optional(),
      system_fingerprint: z.string().min(1).optional(),
      service_tier: z.string().min(1).optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => addUnsafeKeyIssues(value, ctx))
);

export const OpenAIChatCompletionChunkChoiceSchema = z
  .object({
    index: z.number().int().nonnegative(),
    delta: z
      .object({
        role: z.enum(['developer', 'system', 'user', 'assistant', 'tool', 'function']).optional(),
        content: z.union([z.string(), z.null()]).optional(),
        function_call: OpenAIFunctionCallSchema.optional(),
        tool_calls: z
          .array(
            z
              .object({
                index: z.number().int().nonnegative().optional(),
                id: z.string().min(1).optional(),
                type: z.literal('function').optional(),
                function: z
                  .object({
                    name: z.string().min(1).optional(),
                    arguments: z.string().optional(),
                  })
                  .passthrough()
                  .superRefine((value, ctx) => addUnsafeKeyIssues(value, ctx))
                  .optional(),
              })
              .passthrough()
              .superRefine((value, ctx) => addUnsafeKeyIssues(value, ctx))
          )
          .min(1)
          .optional(),
        refusal: z.union([z.string(), z.null()]).optional(),
      })
      .passthrough()
      .superRefine((value, ctx) => addUnsafeKeyIssues(value, ctx)),
    logprobs: OpenAILogprobsSchema.nullish(),
    finish_reason: z.union([
      z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']),
      z.null(),
    ]),
  })
  .passthrough()
  .superRefine((value, ctx) => addUnsafeKeyIssues(value, ctx));

export const OpenAIChatCompletionChunkSchema = guardRawInput(
  z
    .object({
      id: z.string().min(1),
      object: z.literal('chat.completion.chunk'),
      created: z.number().int().nonnegative(),
      model: z.string().min(1),
      choices: z.array(OpenAIChatCompletionChunkChoiceSchema),
      usage: OpenAIUsageSchema.nullish(),
      system_fingerprint: z.string().min(1).optional(),
      service_tier: z.string().min(1).optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => addUnsafeKeyIssues(value, ctx))
);

export const RoutingDecisionSchema = z
  .object({
    model: z.string().min(1),
    provider: z.string().min(1),
    tier: z.number().int().min(0).max(3),
    reason: z.string().min(1),
    latencyMs: z.number().nonnegative(),
  })
  .strict();

export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;
export type OpenAIChatCompletionRequest = z.infer<typeof OpenAIChatCompletionRequestSchema>;
export type OpenAIChatCompletionResponse = z.infer<typeof OpenAIChatCompletionResponseSchema>;
export type OpenAIChatCompletionChunk = z.infer<typeof OpenAIChatCompletionChunkSchema>;

export interface ProxyRequestLike {
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  llmRouter?: { decision?: Partial<RoutingDecision> };
}

export interface ProxyResponseLike {
  status(code: number): ProxyResponseLike;
  json(payload: unknown): unknown;
  setHeader(name: string, value: string | string[]): void;
  write(chunk: Uint8Array | string): boolean;
  end(chunk?: Uint8Array | string): void;
  headersSent?: boolean;
  flushHeaders?: () => void;
}

export type ProxyNextFunction = (error?: unknown) => void;

export interface GatewayConfig {
  primaryModel?: string;
  baseUrl?: string;
  usageUrl?: string;
  apiKey?: string;
  providerConnIds?: Record<string, string>;
  transportAdapter?: TransportAdapterConfig;
}

export type TransportAdapterKind = 'openai-compatible' | 'omniroute-documented';

export interface TransportAdapterConfig {
  kind?: TransportAdapterKind;
  modelListPath?: string;
  usagePathTemplate?: string;
  authHeader?: string;
  authScheme?: string;
  timeoutMs?: number;
  modelCacheTtlMs?: number;
  usageCacheTtlMs?: number;
}

interface NormalizedTransportAdapter {
  kind: TransportAdapterKind;
  modelListPath: string;
  usagePathTemplate: string | null;
  authHeader: string;
  authScheme: string;
  timeoutMs: number;
  modelCacheTtlMs: number;
  usageCacheTtlMs: number;
}

/**
 * Enterprise LLM Criticality Router and Dynamic Offload Proxy Middleware.
 * Automatically delegates chat request processing based on payload criticality, dynamically fetching
 * live capability bands and live provider quotas before routing.
 */
export class LlmGateNode {
  private primaryModel: string;
  private baseUrl: string;
  private usageUrl: string;
  private apiKey: string;
  private providerConnIds: Record<string, string>;
  private transportAdapter: NormalizedTransportAdapter;
  private autoDetectorRan = false;

  private usageCache: Record<string, { at: number; data: any }> = {};
  private modelsCache: { at: number; ids: string[] } = { at: 0, ids: [] };

  // Q-Learning state for autonomous, self-learning routing optimization
  private qTable: Record<
    string,
    { attempts: number; successes: number; latencySum: number; score: number }
  > = {};

  constructor(configOrModel: string | GatewayConfig = {}) {
    const config =
      typeof configOrModel === 'string' ? { primaryModel: configOrModel } : configOrModel;
    this.primaryModel = config.primaryModel || 'cc/claude-opus-4-8';
    this.baseUrl = config.baseUrl || process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20132/v1';
    this.usageUrl =
      config.usageUrl || process.env.OMNIROUTE_API_BASE_URL || 'http://127.0.0.1:20132/api';
    this.apiKey =
      config.apiKey || process.env.OMNIROUTE_API_KEY || process.env.OPENAI_API_KEY || '';
    this.providerConnIds = config.providerConnIds || {};
    this.transportAdapter = this.normalizeTransportAdapter(config.transportAdapter);
    this.autoDetectDependencies();
  }

  /**
   * Normalizes the documented upstream transport adapter configuration.
   */
  private normalizeTransportAdapter(
    config: TransportAdapterConfig | undefined
  ): NormalizedTransportAdapter {
    const kind = config?.kind || 'omniroute-documented';
    if (kind === 'openai-compatible') {
      return {
        kind,
        modelListPath: config?.modelListPath || '/models',
        usagePathTemplate: config?.usagePathTemplate || null,
        authHeader: config?.authHeader || 'Authorization',
        authScheme: config?.authScheme || 'Bearer',
        timeoutMs: config?.timeoutMs ?? 6000,
        modelCacheTtlMs: config?.modelCacheTtlMs ?? 60000,
        usageCacheTtlMs: config?.usageCacheTtlMs ?? 45000,
      };
    }

    return {
      kind,
      modelListPath: config?.modelListPath || '/models',
      usagePathTemplate: config?.usagePathTemplate || '/usage/{connectionId}',
      authHeader: config?.authHeader || 'Authorization',
      authScheme: config?.authScheme || 'Bearer',
      timeoutMs: config?.timeoutMs ?? 6000,
      modelCacheTtlMs: config?.modelCacheTtlMs ?? 60000,
      usageCacheTtlMs: config?.usageCacheTtlMs ?? 45000,
    };
  }

  /**
   * Returns the configured adapter-specific authorization headers.
   */
  private buildAdapterHeaders(): Record<string, string> {
    if (!this.apiKey) {
      return {};
    }

    if (!this.transportAdapter.authScheme) {
      return { [this.transportAdapter.authHeader]: this.apiKey };
    }

    return {
      [this.transportAdapter.authHeader]: `${this.transportAdapter.authScheme} ${this.apiKey}`,
    };
  }

  /**
   * Fetches a JSON payload from a documented upstream adapter endpoint.
   */
  private async fetchAdapterJson(url: string): Promise<any | null> {
    try {
      const res = await fetch(url, {
        headers: this.buildAdapterHeaders(),
        signal: AbortSignal.timeout(this.transportAdapter.timeoutMs),
      });
      if (!res.ok) {
        return null;
      }
      return await res.json();
    } catch (_err) {
      return null;
    }
  }

  /**
   * Scans system for appropriate peer dependencies dynamically and logs an installation prompt.
   */
  private autoDetectDependencies(): void {
    if (this.autoDetectorRan) return;
    this.autoDetectorRan = true;
    const required = ['express', 'zod'];
    const missing: string[] = [];
    for (const pkg of required) {
      try {
        require.resolve(pkg);
      } catch (e) {
        missing.push(pkg);
      }
    }
    if (missing.length > 0) {
      console.warn(
        `[LLM-Gate] WARNING: Missing recommended peer libraries: ${missing.join(', ')}.`
      );
      console.warn(`[LLM-Gate] Auto-prompt: Please run: npm install ${missing.join(' ')}`);
    }
  }

  /**
   * Returns configured provider connection IDs.
   *
   * The public package never reads private multiplexer databases. A future
   * documented quota adapter may populate this map through an explicit API.
   */
  private getProviderConnIds(): Record<string, string> {
    return this.providerConnIds;
  }

  /**
   * Fetches the configured upstream usage payload for a given provider natively via fetch.
   * @param provider The name string corresponding to the provider.
   * @returns Raw API quota data or null if unavailable / error.
   */
  private async getUsageForProvider(provider: string): Promise<any | null> {
    const connMap = this.getProviderConnIds();
    const cid = connMap[provider];
    if (!cid) return null;

    const now = Date.now();
    const ent = this.usageCache[provider];
    if (ent && now - ent.at < this.transportAdapter.usageCacheTtlMs) return ent.data;

    if (
      this.transportAdapter.kind !== 'omniroute-documented' ||
      !this.transportAdapter.usagePathTemplate
    ) {
      return null;
    }

    const usagePath = this.transportAdapter.usagePathTemplate.replace('{connectionId}', cid);

    const data = await this.fetchAdapterJson(`${this.usageUrl}${usagePath}`);
    if (!data || typeof data !== 'object') {
      return null;
    }

    if (
      'message' in data &&
      typeof data.message === 'string' &&
      data.message.toLowerCase().includes('not implemented')
    ) {
      return null; // Fail-open gracefully
    }

    this.usageCache[provider] = { at: now, data };
    return data;
  }

  /**
   * Validates per-model headroom when a documented usage adapter is configured.
   * Fails open if data is missing.
   * @param modelId The canonical model name string.
   * @returns Boolean true if the model has valid quota OR if validation state is inconclusive.
   */
  private async modelHasHeadroom(modelId: string): Promise<boolean> {
    const parts = modelId.split('/');
    const provider = parts.length > 1 ? parts[0] : null;
    if (!provider) return true;

    const data = await this.getUsageForProvider(provider);
    if (!data || !data.quotas) return true;

    const raw = parts.length > 1 ? parts[1].toLowerCase() : modelId.toLowerCase();
    const normalizeModelToken = (value: string): string =>
      value
        .toLowerCase()
        .replace('-thinking', '')
        .replace('-preview', '')
        .replace(/[^a-z0-9]/g, '');
    const stem = normalizeModelToken(raw);

    for (const [key, q] of Object.entries(data.quotas)) {
      if (!q || typeof q !== 'object') continue;
      const qObj = q as any;
      const keyToken = normalizeModelToken(key);
      const modelKeyToken = normalizeModelToken(String(qObj.modelKey || ''));
      const displayNameToken = normalizeModelToken(String(qObj.displayName || ''));

      if (
        stem &&
        (keyToken.includes(stem) ||
          stem.includes(keyToken) ||
          modelKeyToken.includes(stem) ||
          stem.includes(modelKeyToken) ||
          displayNameToken.includes(stem) ||
          stem.includes(displayNameToken))
      ) {
        if (qObj.unlimited) return true;
        return (qObj.remainingPercentage || 0) >= 1;
      }
    }
    return true; // fail-open
  }

  /**
   * Automatically discovers the functional pool of models from the configured OpenAI-compatible upstream.
   * @returns List of active valid model ids.
   */
  private async discoverCapabilities(force: boolean = false): Promise<string[]> {
    const now = Date.now();
    if (
      !force &&
      this.modelsCache.ids.length > 0 &&
      now - this.modelsCache.at < this.transportAdapter.modelCacheTtlMs
    ) {
      return this.modelsCache.ids;
    }
    const data = await this.fetchAdapterJson(
      `${this.baseUrl}${this.transportAdapter.modelListPath}`
    );
    if (!data || !Array.isArray(data.data)) {
      return this.modelsCache.ids;
    }

    const ids: string[] = [];
    for (const item of data.data) {
      if (item && typeof item.id === 'string' && item.id.length > 0) {
        ids.push(item.id);
      }
    }

    if (ids.length > 0) {
      this.modelsCache = { at: now, ids };
    }
    return ids.length > 0 ? ids : this.modelsCache.ids;
  }

  /**
   * Backward-compatible model discovery alias.
   */
  private async discoverModels(force: boolean = false): Promise<string[]> {
    return this.discoverCapabilities(force);
  }

  /**
   * Substring extraction categorization mapping capability slots.
   * @param modelId Model ID string evaluating target functionality tiers.
   * @returns 1 (HIGH), 2 (MID), or 3 (BASIC), or null.
   */
  private bandOfModel(modelId: string): number | null {
    const raw = modelId.includes('/') ? modelId.split('/')[1].toLowerCase() : modelId.toLowerCase();
    if (raw.match(/(opus|gpt-5\.5|grok-4|sonnet-5|3\.1-pro|-pro-preview|-thinking|reasoning)/))
      return 1;
    if (raw.match(/(sonnet|gpt-5\.4|2\.5-pro|grok-3|grok-code|70b|-pro|mistral-large|3-flash)/))
      return 2;
    if (raw.match(/(haiku|flash|mini|lite|small|8b|fast-1|grok-code-fast)/)) return 3;
    return null;
  }

  /**
   * Generates a fully dynamic fallback ladder, pulling models mapped to the evaluated task tier,
   * verified for headroom availability.
   */
  private async buildDynamicLadder(targetTier: number): Promise<string[]> {
    if (targetTier === 0) return [this.primaryModel];

    const roster = await this.discoverModels();
    const ladder: string[] = [];

    // Prioritize dynamically fetching capable tier band
    for (const m of roster) {
      if (!m.includes('/')) continue; // Ignore prefixless aliases
      if (this.bandOfModel(m) === targetTier) {
        if (await this.modelHasHeadroom(m)) {
          ladder.push(m);
        }
      }
    }

    if (!ladder.includes(this.primaryModel)) ladder.push(this.primaryModel);

    // Self-Learning Optimization: Sort models based on autonomously learned Q-scores
    ladder.sort((a, b) => {
      const scoreA = this.qTable[a]?.score ?? 0.5;
      const scoreB = this.qTable[b]?.score ?? 0.5;
      return scoreB - scoreA;
    });

    return ladder;
  }

  /**
   * Evaluates the Tier for a given prompt ensuring T0 extraction guarantees.
   */
  private evaluateTier(prompt: string): number {
    if (
      prompt.match(
        /(money[- ]?path|live[- ]?bot|kelly|whitelist|v70|v55|signal[-_ ]?gate|place\s*orders?|live_order|live\.py|position|sizing)/i
      )
    ) {
      return 0; // T0_CRITICAL
    }
    if (prompt.match(/(adversarial|red[- ]?team|architect|debate|synthes)/i)) {
      return 1; // T_HIGH
    }
    if (prompt.match(/(analy|research|review|audit|spec|codegen|implement|refactor)/i)) {
      return 2; // T_MID
    }
    return 3; // T_BASIC
  }

  /**
   * Autonomous Q-Learning Feedback Loop.
   * Dynamically tracks historical success rates and latencies to prioritize healthy/fast models.
   */
  private updateQScore(model: string, success: boolean, latency: number): void {
    if (!this.qTable[model]) {
      this.qTable[model] = { attempts: 0, successes: 0, latencySum: 0, score: 0.5 };
    }
    const stat = this.qTable[model];
    stat.attempts++;
    if (success) stat.successes++;
    stat.latencySum += latency;

    // Epsilon-Greedy influenced weighting calculation
    const successRate = stat.successes / stat.attempts;
    const avgLatency = stat.latencySum / stat.attempts;
    // Lower latency boosts the raw success rate score marginally.
    const latencyBonus = Math.max(0, 0.1 - avgLatency / 100000);
    stat.score = successRate + latencyBonus;
  }

  /**
   * Intercepts preliminary evaluations to log heuristic latency.
   * @returns Express Request Handler.
   */
  public middleware() {
    return async (req: any, res: any, next: any) => {
      const start = Date.now();
      try {
        const body = req.body || {};
        const prompt = JSON.stringify(body);
        const targetTier = this.evaluateTier(prompt);
        req.llmRouter = {
          decision: {
            model: 'evaluating-dynamic-ladder',
            provider: targetTier === 0 ? 'primary' : 'dynamic-ladder',
            tier: targetTier,
            reason: `Evaluated dynamically to Tier ${targetTier}`,
            latencyMs: Date.now() - start,
          },
        };
        next();
      } catch (err) {
        req.llmRouter = {
          decision: {
            model: this.primaryModel,
            provider: 'primary',
            tier: 0,
            reason: 'Fail-open',
            latencyMs: Date.now() - start,
          },
        };
        next();
      }
    };
  }

  private getRequestHeader(req: ProxyRequestLike, name: string): string | undefined {
    const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
    if (Array.isArray(raw)) {
      return raw.join(', ');
    }
    return typeof raw === 'string' ? raw : undefined;
  }

  private buildUpstreamHeaders(req: ProxyRequestLike): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const accept = this.getRequestHeader(req, 'accept');
    if (accept) {
      headers.Accept = accept;
    }

    return headers;
  }

  private isRetryableStatus(status: number): boolean {
    return status === 402 || status === 404 || status === 429;
  }

  private copyUpstreamHeaders(response: Response, res: ProxyResponseLike): void {
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
  }

  private async forwardJsonResponse(response: Response, res: ProxyResponseLike): Promise<unknown> {
    const payload = await response.json();
    const parsed = OpenAIChatCompletionResponseSchema.safeParse(payload);

    if (!parsed.success) {
      return res.status(502).json({
        error: 'Upstream returned malformed chat completion JSON.',
        details: parsed.error.issues,
      });
    }

    return res.json(parsed.data);
  }

  private validateSseEventData(data: string): string | null {
    const trimmed = data.trim();
    if (trimmed.length === 0 || trimmed === '[DONE]') {
      return null;
    }

    try {
      const parsedJson = JSON.parse(trimmed);
      const parsedChunk = OpenAIChatCompletionChunkSchema.safeParse(parsedJson);

      if (!parsedChunk.success) {
        throw parsedChunk.error;
      }

      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Unknown SSE validation error';
    }
  }

  private async forwardSseResponse(response: Response, res: ProxyResponseLike): Promise<void> {
    if (!response.body) {
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';

    res.flushHeaders?.();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunkText = decoder.decode(value, { stream: true });
      buffered += chunkText;

      let boundary = buffered.indexOf('\n\n');
      while (boundary !== -1) {
        const eventText = buffered.slice(0, boundary);
        const lines = eventText
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart());

        if (lines.length > 0) {
          const error = this.validateSseEventData(lines.join('\n'));
          if (error) {
            throw new Error(`Malformed upstream SSE chunk: ${error}`);
          }
        }

        res.write(eventText + '\n\n');
        buffered = buffered.slice(boundary + 2);
        boundary = buffered.indexOf('\n\n');
      }
    }

    buffered += decoder.decode();
    if (buffered.length > 0) {
      const lines = buffered
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart());

      if (lines.length > 0) {
        const error = this.validateSseEventData(lines.join('\n'));
        if (error) {
          throw new Error(`Malformed upstream SSE chunk: ${error}`);
        }
      }

      res.write(buffered);
    }

    res.end();
  }

  /**
   * End-to-end Proxy and Streaming wrapper.
   * Constructs the Dynamic Route Ladder, validates live availability usage logic sequentially,
   * and executes direct stream connections ensuring 429/402 fallbacks gracefully.
   * @returns Express Request Proxy Output Generator Context.
   */
  public proxy() {
    return async (req: ProxyRequestLike, res: ProxyResponseLike, next: ProxyNextFunction) => {
      const tier = req.llmRouter?.decision?.tier ?? 0;
      const parsedRequest = OpenAIChatCompletionRequestSchema.safeParse(req.body ?? {});

      if (!parsedRequest.success) {
        return res.status(400).json({
          error: 'Invalid OpenAI chat completion request.',
          details: parsedRequest.error.issues,
        });
      }

      const ladder = await this.buildDynamicLadder(tier);
      const requestBody = parsedRequest.data;
      const isStream = requestBody.stream === true;
      let lastError = null;

      for (const candidateModel of ladder) {
        const fetchStart = Date.now();
        try {
          const payload = { ...requestBody, model: candidateModel };
          const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: this.buildUpstreamHeaders(req),
            body: JSON.stringify(payload),
          });

          if (this.isRetryableStatus(response.status)) {
            console.warn(
              `[LLM-Gate] Model ${candidateModel} flagged ${response.status}. Falling back...`
            );
            continue;
          }
          if (!response.ok) {
            throw new Error(`Upstream error: ${response.status} ${response.statusText}`);
          }

          res.status(response.status);
          this.copyUpstreamHeaders(response, res);

          if (isStream) {
            await this.forwardSseResponse(response, res);
            return;
          } else {
            return await this.forwardJsonResponse(response, res);
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Malformed upstream SSE chunk:')) {
            next(err);
            return;
          }

          console.error(`[LLM-Gate] Network failure for ${candidateModel}:`, err);
          this.updateQScore(candidateModel, false, Date.now() - fetchStart);
          lastError = err;
        }
      }

      res.status(502).json({
        error: 'All downstream dynamic routing targets failed/exhausted.',
        details: String(lastError),
      });
    };
  }
}

export { LlmGateNode as LLMGateway };
