import express, { Request, Response } from 'express';
import request from 'supertest';
import {
  LlmGateNode,
  OpenAIChatCompletionRequestSchema,
  OpenAIChatCompletionResponseSchema,
  RoutingDecisionSchema,
} from '../src';

const validRequest = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Summarize this document' }],
  temperature: 0.4,
  top_p: 0.9,
  max_tokens: 256,
  stream: false,
  user: 'agent-1',
};

const validResponse = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1_720_000_000,
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Done' },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
  },
};

function createApp() {
  const app = express();
  const gateway = new LlmGateNode('cc/claude-opus-4-8');

  app.use(express.json());
  app.post(
    '/v1/chat/completions',
    gateway.middleware(),
    (req: Request & { llmRouter?: unknown }, res: Response) => {
      res.status(200).json({ llmRouter: req.llmRouter, body: req.body });
    }
  );

  return app;
}

describe('LLM Gate Node Router', () => {
  it('instantiates gateway with default primary model when no argument is provided', () => {
    const defaultGateway = new LlmGateNode();
    expect((defaultGateway as any).primaryModel).toBe('cc/claude-opus-4-8');
  });

  it('handles missing req.body gracefully by falling back to empty object serialization', async () => {
    const app = express();
    const gateway = new LlmGateNode('custom/model-1');

    // Intentionally omit express.json() to leave req.body undefined
    app.post(
      '/v1/chat/completions',
      gateway.middleware(),
      (req: Request & { llmRouter?: unknown }, res: Response) => {
        res.status(200).json({ llmRouter: req.llmRouter });
      }
    );

    const response = await request(app)
      .post('/v1/chat/completions')
      .type('json')
      .send() // no body
      .expect(200);

    expect(response.body.llmRouter.decision).toMatchObject({
      model: 'evaluating-dynamic-ladder',
      provider: 'dynamic-ladder',
      tier: 3,
    });
  });

  describe('Express middleware via supertest', () => {
    it('attaches validated tier-2 routing metadata for non-critical OpenAI calls', async () => {
      const response = await request(createApp())
        .post('/v1/chat/completions')
        .send(validRequest)
        .expect(200);

      expect(response.body.body).toEqual(validRequest);
      expect(response.body.llmRouter.decision).toMatchObject({
        model: 'evaluating-dynamic-ladder',
        provider: 'dynamic-ladder',
        tier: 3,
        reason: 'Evaluated dynamically to Tier 3',
      });
      expect(RoutingDecisionSchema.safeParse(response.body.llmRouter.decision).success).toBe(true);
    });

    it.each([
      ['live_order', 'Process a live_order payload'],
      ['whitelist', 'Debug whitelist auth failure'],
      ['signal_gate', 'Review signal_gate timeline'],
      ['money-path', 'Deploy money-path rollback plan'],
    ])('routes %s-sensitive prompts to the primary model', async (_keyword, content) => {
      const response = await request(createApp())
        .post('/v1/chat/completions')
        .send({ ...validRequest, messages: [{ role: 'user', content }] })
        .expect(200);

      expect(response.body.llmRouter.decision).toMatchObject({
        model: 'evaluating-dynamic-ladder',
        provider: 'primary',
        tier: 0,
      });
      expect(RoutingDecisionSchema.safeParse(response.body.llmRouter.decision).success).toBe(true);
    });

    it.each([
      [
        'circular reference',
        (req: Request) => {
          req.body = {};
          req.body.self = req.body;
        },
      ],
      [
        'BigInt which has no default serialization',
        (req: Request) => {
          req.body = { value: BigInt(42) };
        },
      ],
      [
        'object with throwing getter',
        (req: Request) => {
          req.body = {};
          Object.defineProperty(req.body, 'prop', {
            get: () => {
              throw new Error('Poisoned');
            },
            enumerable: true,
          });
        },
      ],
    ])('falls back to primary model (fail-open strategy) for %s', async (_name, setupFn) => {
      const app = express();
      const gateway = new LlmGateNode('cc/claude-opus-4-8');

      app.use(express.json());
      app.use((req, res, next) => {
        setupFn(req as Request);
        next();
      });

      app.post(
        '/v1/chat/completions',
        gateway.middleware(),
        (req: Request & { llmRouter?: unknown }, res: Response) => {
          res.status(200).json({ llmRouter: req.llmRouter });
        }
      );

      const response = await request(app).post('/v1/chat/completions').send({}).expect(200);

      expect(response.body.llmRouter.decision).toMatchObject({
        model: 'cc/claude-opus-4-8',
        provider: 'primary',
        tier: 0,
        reason: 'Fail-open',
      });
      expect(RoutingDecisionSchema.safeParse(response.body.llmRouter.decision).success).toBe(true);
    });

    it('returns a JSON parse error before middleware execution for malformed JSON', async () => {
      const response = await request(createApp())
        .post('/v1/chat/completions')
        .set('Content-Type', 'application/json')
        .send('{"model":"gpt-4o-mini","messages":')
        .expect(400);

      expect(response.text).toContain('SyntaxError');
    });
  });

  describe('OpenAI chat completion request parser', () => {
    it('accepts a valid request', () => {
      expect(OpenAIChatCompletionRequestSchema.safeParse(validRequest).success).toBe(true);
    });

    it.each([
      ['missing model', (({ model: _model, ...rest }) => rest)(validRequest)],
      ['empty model', { ...validRequest, model: '' }],
      ['numeric model', { ...validRequest, model: 42 }],
      ['missing messages', (({ messages: _messages, ...rest }) => rest)(validRequest)],
      ['messages is object', { ...validRequest, messages: { role: 'user', content: 'hi' } }],
      ['messages is empty', { ...validRequest, messages: [] }],
      ['message missing role', { ...validRequest, messages: [{ content: 'hi' }] }],
      ['message unknown role', { ...validRequest, messages: [{ role: 'critic', content: 'hi' }] }],
      ['message numeric content', { ...validRequest, messages: [{ role: 'user', content: 7 }] }],
      [
        'message has extra field',
        { ...validRequest, messages: [{ role: 'user', content: 'hi', extra: true }] },
      ],
      ['temperature below range', { ...validRequest, temperature: -0.1 }],
      ['temperature above range', { ...validRequest, temperature: 2.1 }],
      ['temperature as string', { ...validRequest, temperature: '0.5' }],
      ['top_p below range', { ...validRequest, top_p: -0.01 }],
      ['top_p above range', { ...validRequest, top_p: 1.01 }],
      ['max_tokens is zero', { ...validRequest, max_tokens: 0 }],
      ['max_tokens is float', { ...validRequest, max_tokens: 1.5 }],
      ['stream is string', { ...validRequest, stream: 'false' }],
      ['user is empty', { ...validRequest, user: '' }],
      ['unknown top-level key', { ...validRequest, logprobs: true }],
      [
        'prototype pollution via __proto__',
        JSON.parse(
          '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"__proto__":{"admin":true}}'
        ),
      ],
      ['constructor poisoning', { ...validRequest, constructor: { prototype: { admin: true } } }],
      ['NoSQL injection in model', { ...validRequest, model: { $gt: '' } }],
      [
        'SQL injection attempt in messages (should normally pass unless strict schema prevents types, but if structured it fails)',
        { ...validRequest, messages: { $where: 'sleep(10)' } },
      ],
      ['deeply nested object for model', { ...validRequest, model: { a: { b: { c: 'd' } } } }],
      [
        'array with null prototype',
        Object.assign(Object.create(null), validRequest, { extras: true }),
      ],
      ['function as user', { ...validRequest, user: function () {} }],
    ])('rejects incorrect OpenAI request JSON: %s', (_name, payload) => {
      const result = OpenAIChatCompletionRequestSchema.safeParse(payload);

      expect(result.success).toBe(false);
    });
  });

  describe('OpenAI chat completion response parser', () => {
    it('accepts a valid response', () => {
      expect(OpenAIChatCompletionResponseSchema.safeParse(validResponse).success).toBe(true);
    });

    it.each([
      ['missing id', (({ id: _id, ...rest }) => rest)(validResponse)],
      ['empty id', { ...validResponse, id: '' }],
      ['wrong object', { ...validResponse, object: 'chat.completion.chunk' }],
      ['created as string', { ...validResponse, created: '1720000000' }],
      ['negative created', { ...validResponse, created: -1 }],
      ['missing response model', (({ model: _model, ...rest }) => rest)(validResponse)],
      ['choices is empty', { ...validResponse, choices: [] }],
      ['choices is object', { ...validResponse, choices: { index: 0 } }],
      [
        'choice missing index',
        {
          ...validResponse,
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        },
      ],
      [
        'choice negative index',
        { ...validResponse, choices: [{ ...validResponse.choices[0], index: -1 }] },
      ],
      [
        'choice float index',
        { ...validResponse, choices: [{ ...validResponse.choices[0], index: 0.5 }] },
      ],
      [
        'choice missing message',
        { ...validResponse, choices: [{ index: 0, finish_reason: 'stop' }] },
      ],
      [
        'choice invalid message role',
        {
          ...validResponse,
          choices: [{ ...validResponse.choices[0], message: { role: 'bot', content: 'ok' } }],
        },
      ],
      [
        'choice invalid finish reason',
        { ...validResponse, choices: [{ ...validResponse.choices[0], finish_reason: 'done' }] },
      ],
      [
        'usage negative prompt tokens',
        { ...validResponse, usage: { ...validResponse.usage, prompt_tokens: -1 } },
      ],
      [
        'usage float completion tokens',
        { ...validResponse, usage: { ...validResponse.usage, completion_tokens: 1.25 } },
      ],
      [
        'usage missing total tokens',
        { ...validResponse, usage: { prompt_tokens: 1, completion_tokens: 2 } },
      ],
      [
        'usage extra field',
        { ...validResponse, usage: { ...validResponse.usage, cached_tokens: 1 } },
      ],
      ['unknown top-level key', { ...validResponse, system_fingerprint: 'fp_test' }],
      [
        'prototype pollution in response',
        JSON.parse(
          '{"id":"1","object":"chat.completion","created":1,"model":"gpt-4","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"__proto__":{"admin":true}}'
        ),
      ],
      [
        'function as choice index',
        { ...validResponse, choices: [{ ...validResponse.choices[0], index: function () {} }] },
      ],
    ])('rejects incorrect OpenAI response JSON: %s', (_name, payload) => {
      const result = OpenAIChatCompletionResponseSchema.safeParse(payload);

      expect(result.success).toBe(false);
    });
  });
});
