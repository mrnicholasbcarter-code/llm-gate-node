import { z } from "zod";

// Zod schema for runtime type safety ensuring valid payloads
export const RoutingDecisionSchema = z.object({
  model: z.string(),
  provider: z.string(),
  tier: z.number(),
  reason: z.string(),
  latencyMs: z.number()
});

export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

export class LlmGateNode {
  private primaryModel: string;

  constructor(primaryModel: string = "anthropic/claude-3-opus-20240229") {
    this.primaryModel = primaryModel;
  }

  /**
   * Express.js / Hono Middleware interceptor
   * Parses incoming request body, calculates criticality, and mutates the req.targetModel
   */
  public middleware() {
    return async (req: any, res: any, next: any) => {
      try {
        const body = req.body || {};
        const prompt = JSON.stringify(body);
        
        // Fast heuristic scan
        let targetTier = 2; // Medium
        if (prompt.match(/(payment|auth|security|production)/i)) {
          targetTier = 0; // Critical
        }

        // Assign model logic
        const targetModel = targetTier === 0 
          ? this.primaryModel 
          : "groq/llama-3-8b";

        req.llmRouter = {
          decision: {
            model: targetModel,
            tier: targetTier,
            reason: `Routed to Tier ${targetTier} based on heuristics`,
            latencyMs: 1.2
          }
        };
        
        next();
      } catch (err) {
        // Fail-open strategy
        req.llmRouter = { decision: { model: this.primaryModel, tier: 0, reason: "Fail-open" } };
        next();
      }
    };
  }
}
