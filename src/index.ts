import { z } from 'zod';
import * as http from 'http';
import * as https from 'https';
import { execSync } from 'child_process';

/**
 * Zod Schema representing an OpenAI-compatible Chat Message.
 */
export const OpenAIChatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool', 'function']),
    content: z.union([z.string(), z.null()]).optional(),
    name: z.string().min(1).optional(),
    tool_call_id: z.string().min(1).optional(),
  })
  .strict();

export const OpenAIChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(OpenAIChatMessageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    user: z.string().min(1).optional(),
  })
  .strict();

export const OpenAIChatCompletionChoiceSchema = z
  .object({
    index: z.number().int().nonnegative(),
    message: OpenAIChatMessageSchema,
    finish_reason: z.union([
      z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']),
      z.null(),
    ]),
  })
  .strict();

export const OpenAIChatCompletionResponseSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal('chat.completion'),
    created: z.number().int().nonnegative(),
    model: z.string().min(1),
    choices: z.array(OpenAIChatCompletionChoiceSchema).min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

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

export interface GatewayConfig {
  primaryModel?: string;
  baseUrl?: string;
  usageUrl?: string;
  apiKey?: string;
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
  private autoDetectorRan = false;

  private connMapCache: { at: number; map: Record<string, string> } = { at: 0, map: {} };
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
    this.baseUrl = config.baseUrl || 'http://localhost:20128/v1';
    this.usageUrl = config.usageUrl || 'http://localhost:20128/api';
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || 'dummy';
    this.autoDetectDependencies();
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
   * Maps 9router providers to Connection UUIDs from SQLite.
   * @returns Key/value map of Provider -> Connection ID
   */
  private getProviderConnIds(): Record<string, string> {
    const now = Date.now();
    if (Object.keys(this.connMapCache.map).length > 0 && now - this.connMapCache.at < 300000) {
      return this.connMapCache.map;
    }
    try {
      const sqliteCmd = `sqlite3 ~/.9router/db/data.sqlite "SELECT id, provider FROM providerConnections WHERE isActive=1;" -json`;
      const out = execSync(sqliteCmd, { encoding: 'utf8', stdio: 'pipe' });
      const rows = JSON.parse(out || '[]');
      const map: Record<string, string> = {};
      for (const row of rows) {
        if (row.provider && row.id) map[row.provider] = row.id;
      }
      this.connMapCache = { at: now, map };
      return map;
    } catch (e) {
      return this.connMapCache.map;
    }
  }

  /**
   * Fetches the /api/usage payload for a given provider natively via fetch.
   * @param provider The name string corresponding to the provider.
   * @returns Raw API quota data or null if unavailable / error.
   */
  private async getUsageForProvider(provider: string): Promise<any | null> {
    const connMap = this.getProviderConnIds();
    const cid = connMap[provider];
    if (!cid) return null;

    const now = Date.now();
    const ent = this.usageCache[provider];
    if (ent && now - ent.at < 45000) return ent.data;

    try {
      const res = await fetch(`${this.usageUrl}/usage/${cid}`, {
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      if (
        data &&
        data.message &&
        typeof data.message === 'string' &&
        data.message.toLowerCase().includes('not implemented')
      ) {
        return null; // Fail-open gracefully
      }
      this.usageCache[provider] = { at: now, data };
      return data;
    } catch (err) {
      this.usageCache[provider] = { at: now, data: null };
      return null;
    }
  }

  /**
   * Validates per-model quotas verifying exact active headspace limits remain available.
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
    const stem = raw.replace('-thinking', '').replace('-preview', '').replace(/-/g, '');

    for (const [key, q] of Object.entries(data.quotas)) {
      if (!q || typeof q !== 'object') continue;
      const qObj = q as any;
      const kl = key.toLowerCase();
      const dn = (qObj.displayName || '').toLowerCase().replace(/ /g, '-');

      if (stem && (kl.includes(stem) || raw.includes(kl) || dn.includes(stem))) {
        if (qObj.unlimited) return true;
        return (qObj.remainingPercentage || 0) >= 1;
      }
    }
    return true; // fail-open
  }

  /**
   * Automatically discovers the functional pool of models dynamically from 9router.
   * @returns List of active valid model ids.
   */
  private async discoverModels(force: boolean = false): Promise<string[]> {
    const now = Date.now();
    if (!force && this.modelsCache.ids.length > 0 && now - this.modelsCache.at < 60000) {
      return this.modelsCache.ids;
    }
    try {
      const res = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return this.modelsCache.ids;
      const data = (await res.json()) as any;
      const ids: string[] = [];
      if (data && Array.isArray(data.data)) {
        for (const item of data.data) {
          if (item && item.id) ids.push(item.id);
        }
      }
      if (ids.length > 0) {
        this.modelsCache = { at: now, ids };
      }
      return ids.length > 0 ? ids : this.modelsCache.ids;
    } catch (e) {
      return this.modelsCache.ids;
    }
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

  /**
   * End-to-end Proxy and Streaming wrapper.
   * Constructs the Dynamic Route Ladder, validates live availability usage logic sequentially,
   * and executes direct stream connections ensuring 429/402 fallbacks gracefully.
   * @returns Express Request Proxy Output Generator Context.
   */
  public proxy() {
    return async (req: any, res: any, next: any) => {
      const { decision } = req.llmRouter || { decision: { tier: 0 } };

      const ladder = await this.buildDynamicLadder(decision.tier);
      const isStream = req.body?.stream === true;
      let lastError = null;

      for (const candidateModel of ladder) {
        let fetchStart = Date.now();
        try {
          const payload = { ...req.body, model: candidateModel };
          // @ts-ignore
          const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(payload),
          });

          if (response.status === 402 || response.status === 429 || response.status === 404) {
            console.warn(
              `[LLM-Gate] Model ${candidateModel} flagged ${response.status}. Falling back...`
            );
            continue;
          }
          if (!response.ok) {
            throw new Error(`Upstream error: ${response.status} ${response.statusText}`);
          }

          res.status(response.status);
          response.headers.forEach((value, key) => res.setHeader(key, value));

          if (isStream && response.body) {
            const reader = response.body.getReader();
            const pump = async () => {
              let done, value;
              while ((({ done, value } = await reader.read()), !done)) {
                res.write(value);
              }
              res.end();
            };
            pump().catch(next);
            return;
          } else {
            const data = await response.json();
            return res.json(data);
          }
        } catch (err) {
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
