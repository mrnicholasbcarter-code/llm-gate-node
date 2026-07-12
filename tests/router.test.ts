import express, { Request, Response } from "express";
import request from "supertest";
import {
  LlmGateNode,
  OpenAIChatCompletionRequestSchema,
  OpenAIChatCompletionResponseSchema,
  RoutingDecisionSchema
} from "../src";

const validRequest = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Summarize this document" }],
  temperature: 0.4,
  top_p: 0.9,
  max_tokens: 256,
  stream: false,
  user: "agent-1"
};

const validResponse = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1_720_000_000,
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Done" },
      finish_reason: "stop"
    }
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15
  }
};

function createApp() {
  const app = express();
  const gateway = new LlmGateNode("anthropic/claude-3-opus-20240229");

  app.use(express.json());
  app.post(
    "/v1/chat/completions",
    gateway.middleware(),
    (req: Request & { llmRouter?: unknown }, res: Response) => {
      res.status(200).json({ llmRouter: req.llmRouter, body: req.body });
    }
  );

  return app;
}

describe("LLM Gate Node Router", () => {
  describe("Express middleware via supertest", () => {
    it("attaches validated tier-2 routing metadata for non-critical OpenAI calls", async () => {
      const response = await request(createApp())
        .post("/v1/chat/completions")
        .send(validRequest)
        .expect(200);

      expect(response.body.body).toEqual(validRequest);
      expect(response.body.llmRouter.decision).toMatchObject({
        model: "groq/llama-3-8b",
        provider: "groq",
        tier: 2,
        reason: "Routed to Tier 2 based on heuristics"
      });
      expect(RoutingDecisionSchema.safeParse(response.body.llmRouter.decision).success).toBe(true);
    });

    it.each([
      ["payment", "Process a customer payment reversal"],
      ["auth", "Debug auth callback failure"],
      ["security", "Review security incident timeline"],
      ["production", "Deploy production rollback plan"]
    ])("routes %s-sensitive prompts to the primary model", async (_keyword, content) => {
      const response = await request(createApp())
        .post("/v1/chat/completions")
        .send({ ...validRequest, messages: [{ role: "user", content }] })
        .expect(200);

      expect(response.body.llmRouter.decision).toMatchObject({
        model: "anthropic/claude-3-opus-20240229",
        provider: "primary",
        tier: 0
      });
      expect(RoutingDecisionSchema.safeParse(response.body.llmRouter.decision).success).toBe(true);
    });

    it("returns a JSON parse error before middleware execution for malformed JSON", async () => {
      const response = await request(createApp())
        .post("/v1/chat/completions")
        .set("Content-Type", "application/json")
        .send('{"model":"gpt-4o-mini","messages":')
        .expect(400);

      expect(response.text).toContain("SyntaxError");
    });
  });

  describe("OpenAI chat completion request parser", () => {
    it("accepts a valid request", () => {
      expect(OpenAIChatCompletionRequestSchema.safeParse(validRequest).success).toBe(true);
    });

    it.each([
      ["missing model", (({ model: _model, ...rest }) => rest)(validRequest)],
      ["empty model", { ...validRequest, model: "" }],
      ["numeric model", { ...validRequest, model: 42 }],
      ["missing messages", (({ messages: _messages, ...rest }) => rest)(validRequest)],
      ["messages is object", { ...validRequest, messages: { role: "user", content: "hi" } }],
      ["messages is empty", { ...validRequest, messages: [] }],
      ["message missing role", { ...validRequest, messages: [{ content: "hi" }] }],
      ["message unknown role", { ...validRequest, messages: [{ role: "critic", content: "hi" }] }],
      ["message numeric content", { ...validRequest, messages: [{ role: "user", content: 7 }] }],
      ["message has extra field", { ...validRequest, messages: [{ role: "user", content: "hi", extra: true }] }],
      ["temperature below range", { ...validRequest, temperature: -0.1 }],
      ["temperature above range", { ...validRequest, temperature: 2.1 }],
      ["temperature as string", { ...validRequest, temperature: "0.5" }],
      ["top_p below range", { ...validRequest, top_p: -0.01 }],
      ["top_p above range", { ...validRequest, top_p: 1.01 }],
      ["max_tokens is zero", { ...validRequest, max_tokens: 0 }],
      ["max_tokens is float", { ...validRequest, max_tokens: 1.5 }],
      ["stream is string", { ...validRequest, stream: "false" }],
      ["user is empty", { ...validRequest, user: "" }],
      ["unknown top-level key", { ...validRequest, logprobs: true }]
    ])("rejects incorrect OpenAI request JSON: %s", (_name, payload) => {
      const result = OpenAIChatCompletionRequestSchema.safeParse(payload);

      expect(result.success).toBe(false);
    });
  });

  describe("OpenAI chat completion response parser", () => {
    it("accepts a valid response", () => {
      expect(OpenAIChatCompletionResponseSchema.safeParse(validResponse).success).toBe(true);
    });

    it.each([
      ["missing id", (({ id: _id, ...rest }) => rest)(validResponse)],
      ["empty id", { ...validResponse, id: "" }],
      ["wrong object", { ...validResponse, object: "chat.completion.chunk" }],
      ["created as string", { ...validResponse, created: "1720000000" }],
      ["negative created", { ...validResponse, created: -1 }],
      ["missing response model", (({ model: _model, ...rest }) => rest)(validResponse)],
      ["choices is empty", { ...validResponse, choices: [] }],
      ["choices is object", { ...validResponse, choices: { index: 0 } }],
      ["choice missing index", { ...validResponse, choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }],
      ["choice negative index", { ...validResponse, choices: [{ ...validResponse.choices[0], index: -1 }] }],
      ["choice float index", { ...validResponse, choices: [{ ...validResponse.choices[0], index: 0.5 }] }],
      ["choice missing message", { ...validResponse, choices: [{ index: 0, finish_reason: "stop" }] }],
      ["choice invalid message role", { ...validResponse, choices: [{ ...validResponse.choices[0], message: { role: "bot", content: "ok" } }] }],
      ["choice invalid finish reason", { ...validResponse, choices: [{ ...validResponse.choices[0], finish_reason: "done" }] }],
      ["usage negative prompt tokens", { ...validResponse, usage: { ...validResponse.usage, prompt_tokens: -1 } }],
      ["usage float completion tokens", { ...validResponse, usage: { ...validResponse.usage, completion_tokens: 1.25 } }],
      ["usage missing total tokens", { ...validResponse, usage: { prompt_tokens: 1, completion_tokens: 2 } }],
      ["usage extra field", { ...validResponse, usage: { ...validResponse.usage, cached_tokens: 1 } }],
      ["unknown top-level key", { ...validResponse, system_fingerprint: "fp_test" }]
    ])("rejects incorrect OpenAI response JSON: %s", (_name, payload) => {
      const result = OpenAIChatCompletionResponseSchema.safeParse(payload);

      expect(result.success).toBe(false);
    });
  });
});
