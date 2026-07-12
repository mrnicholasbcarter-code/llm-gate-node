import { z } from "zod";

export const OpenAIChatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool", "function"]),
    content: z.union([z.string(), z.null()]).optional(),
    name: z.string().min(1).optional(),
    tool_call_id: z.string().min(1).optional()
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
    user: z.string().min(1).optional()
  })
  .strict();

export const OpenAIChatCompletionChoiceSchema = z
  .object({
    index: z.number().int().nonnegative(),
    message: OpenAIChatMessageSchema,
    finish_reason: z.union([
      z.enum(["stop", "length", "tool_calls", "content_filter", "function_call"]),
      z.null()
    ])
  })
  .strict();

export const OpenAIChatCompletionResponseSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("chat.completion"),
    created: z.number().int().nonnegative(),
    model: z.string().min(1),
    choices: z.array(OpenAIChatCompletionChoiceSchema).min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative()
      })
      .strict()
      .optional()
  })
  .strict();

// Zod schema for runtime type safety ensuring valid routing metadata.
export const RoutingDecisionSchema = z
  .object({
    model: z.string().min(1),
    provider: z.string().min(1),
    tier: z.number().int().min(0).max(3),
    reason: z.string().min(1),
    latencyMs: z.number().nonnegative()
  })
  .strict();

export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;
export type OpenAIChatCompletionRequest = z.infer<typeof OpenAIChatCompletionRequestSchema>;
export type OpenAIChatCompletionResponse = z.infer<typeof OpenAIChatCompletionResponseSchema>;

export class LlmGateNode {
  private primaryModel: string;

  constructor(primaryModel: string = "anthropic/claude-3-opus-20240229") {
    this.primaryModel = primaryModel;
  }

  /**
   * Express.js / Hono Middleware interceptor.
   * Parses incoming request body, calculates criticality, and stores routing metadata on req.llmRouter.
   */
  public middleware() {
    return async (req: any, res: any, next: any) => {
      const start = Date.now();

      try {
        const body = req.body || {};
        const prompt = JSON.stringify(body);

        // Fast heuristic scan.
        const targetTier = prompt.match(/(payment|auth|security|production)/i) ? 0 : 2;
        const provider = targetTier === 0 ? "primary" : "groq";
        const targetModel = targetTier === 0 ? this.primaryModel : "groq/llama-3-8b";

        req.llmRouter = {
          decision: RoutingDecisionSchema.parse({
            model: targetModel,
            provider,
            tier: targetTier,
            reason: `Routed to Tier ${targetTier} based on heuristics`,
            latencyMs: Date.now() - start
          })
        };

        next();
      } catch (err) {
        // Fail-open strategy.
        req.llmRouter = {
          decision: RoutingDecisionSchema.parse({
            model: this.primaryModel,
            provider: "primary",
            tier: 0,
            reason: "Fail-open",
            latencyMs: Date.now() - start
          })
        };
        next();
      }
    };
  }
}

export { LlmGateNode as LLMGateway };
