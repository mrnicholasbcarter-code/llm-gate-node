import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express, { Request, Response as ExpressResponse } from 'express';
import request from 'supertest';
import {
  LlmGateNode,
  OpenAIChatCompletionChunkSchema,
  OpenAIChatCompletionRequestSchema,
  OpenAIChatCompletionResponseSchema,
  ProxyRequestLike,
  ProxyResponseLike,
  RoutingDecisionSchema,
} from '../src';

const validRequest = {
  model: 'gpt-4o-mini',
  messages: [
    { role: 'developer', content: 'Be concise' },
    { role: 'user', content: 'Summarize this document' },
  ],
  temperature: 0.4,
  top_p: 0.9,
  max_tokens: 256,
  max_completion_tokens: 256,
  n: 1,
  stop: ['END'],
  presence_penalty: 0,
  frequency_penalty: 0,
  logit_bias: { '42': -0.5 },
  logprobs: true,
  top_logprobs: 2,
  seed: 7,
  tools: [
    {
      type: 'function',
      function: {
        name: 'lookup_weather',
        description: 'Get the forecast',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string' },
          },
          required: ['city'],
        },
        strict: true,
      },
    },
  ],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'summary_response',
      description: 'Structured summary',
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
        },
        required: ['summary'],
      },
      strict: true,
    },
  },
  stream: false,
  stream_options: { include_usage: true },
  metadata: { traceId: 'trace-1', retryCount: 0, cacheHit: false, note: null },
  user: 'agent-1',
  store: true,
  reasoning_effort: 'medium',
  modalities: ['text'],
  prediction: { type: 'content', content: 'Predicted summary' },
  'x-forward-compatible': { future: true },
};

const validResponse = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1_720_000_000,
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'Done',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup_weather', arguments: '{"city":"Paris"}' },
          },
        ],
        refusal: null,
      },
      logprobs: { content: null, refusal: null },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
  system_fingerprint: 'fp_123',
  service_tier: 'default',
  'x-upstream-extra': { trace: 'abc123' },
};

afterEach(() => {
  jest.restoreAllMocks();
});

const validChunk = {
  id: 'chatcmpl-test',
  object: 'chat.completion.chunk',
  created: 1_720_000_000,
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      delta: {
        role: 'assistant',
        content: 'Hel',
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup_weather', arguments: '{"city":"Par' },
          },
        ],
      },
      logprobs: null,
      finish_reason: null,
    },
  ],
  usage: null,
  system_fingerprint: 'fp_123',
  service_tier: 'default',
  'x-chunk-extra': { shard: 1 },
};

function createApp() {
  const app = express();
  const gateway = new LlmGateNode('cc/claude-opus-4-8');

  app.use(express.json());
  app.post(
    '/v1/chat/completions',
    gateway.middleware(),
    (req: Request & { llmRouter?: unknown }, res: ExpressResponse) => {
      res.status(200).json({ llmRouter: req.llmRouter, body: req.body });
    }
  );

  return app;
}

describe('LlmGateNode', () => {
  const createGatewayForProxyTests = () => {
    const gateway = new LlmGateNode({ apiKey: 'secret-token' });
    jest.spyOn(gateway as any, 'buildDynamicLadder').mockResolvedValue(['fallback-model']);
    return gateway;
  };

  const createProxyResponseRecorder = (): {
    res: ProxyResponseLike;
    statusCode: number | null;
    jsonPayload: unknown;
    headers: Map<string, string | string[]>;
    writes: Array<string | Uint8Array>;
    ended: boolean;
    flushHeaders: jest.Mock;
  } => {
    let statusCode: number | null = null;
    let jsonPayload: unknown;
    const headers = new Map<string, string | string[]>();
    const writes: Array<string | Uint8Array> = [];
    let ended = false;
    const flushHeaders = jest.fn();

    const res: ProxyResponseLike = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        jsonPayload = payload;
        return payload;
      },
      setHeader(name: string, value: string | string[]) {
        headers.set(name, value);
      },
      write(chunk: Uint8Array | string) {
        writes.push(chunk);
        return true;
      },
      end(chunk?: Uint8Array | string) {
        if (chunk !== undefined) {
          writes.push(chunk);
        }
        ended = true;
      },
      flushHeaders,
    };

    return {
      res,
      get statusCode() {
        return statusCode;
      },
      get jsonPayload() {
        return jsonPayload;
      },
      headers,
      writes,
      get ended() {
        return ended;
      },
      flushHeaders,
    };
  };

  const createSseResponse = (
    chunks: string[],
    options?: { status?: number; headers?: Record<string, string> }
  ): Response => {
    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      }),
      {
        status: options?.status ?? 200,
        headers: options?.headers,
      }
    );
  };

  it('rejects malformed proxy requests before calling upstream', async () => {
    const gateway = createGatewayForProxyTests();
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const recorder = createProxyResponseRecorder();
    const next = jest.fn();

    await gateway.proxy()(
      {
        body: { messages: validRequest.messages },
        llmRouter: { decision: { tier: 0 } },
      } as ProxyRequestLike,
      recorder.res,
      next
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recorder.statusCode).toBe(400);
    expect(recorder.jsonPayload).toMatchObject({
      error: 'Invalid OpenAI chat completion request.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards validated JSON responses with copied headers', async () => {
    const gateway = createGatewayForProxyTests();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(validResponse), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-upstream': 'ok',
        },
      })
    );
    const recorder = createProxyResponseRecorder();

    await gateway.proxy()(
      {
        body: validRequest,
        headers: { accept: 'application/json' },
        llmRouter: { decision: { tier: 0 } },
      } as ProxyRequestLike,
      recorder.res,
      jest.fn()
    );

    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:20132/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-token',
        Accept: 'application/json',
      },
      body: JSON.stringify({ ...validRequest, model: 'fallback-model' }),
    });
    expect(recorder.statusCode).toBe(200);
    expect(recorder.headers.get('content-type')).toBe('application/json');
    expect(recorder.headers.get('x-upstream')).toBe('ok');
    expect(recorder.jsonPayload).toEqual(validResponse);
  });

  it('preserves unknown request fields while replacing only the routed model', async () => {
    const gateway = createGatewayForProxyTests();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(validResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const recorder = createProxyResponseRecorder();

    await gateway.proxy()(
      {
        body: { ...validRequest, model: 'client-requested-model' },
        llmRouter: { decision: { tier: 0 } },
      } as ProxyRequestLike,
      recorder.res,
      jest.fn()
    );

    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:20132/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-token',
      },
      body: JSON.stringify({ ...validRequest, model: 'fallback-model' }),
    });
  });

  it('returns 502 when upstream JSON is malformed', async () => {
    const gateway = createGatewayForProxyTests();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ nope: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const recorder = createProxyResponseRecorder();

    await gateway.proxy()(
      {
        body: validRequest,
        llmRouter: { decision: { tier: 0 } },
      } as ProxyRequestLike,
      recorder.res,
      jest.fn()
    );

    expect(recorder.statusCode).toBe(502);
    expect(recorder.jsonPayload).toMatchObject({
      error: 'Upstream returned malformed chat completion JSON.',
    });
  });

  it('streams validated SSE payloads while preserving framing across chunk boundaries', async () => {
    const gateway = createGatewayForProxyTests();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      createSseResponse(
        [
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1720000000,',
          '"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"Hel"},"logprobs":null,"finish_reason":null}]}\n\n',
          'data: [DONE]\n\n',
        ],
        {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
        }
      )
    );
    const recorder = createProxyResponseRecorder();

    await gateway.proxy()(
      {
        body: { ...validRequest, stream: true },
        headers: { accept: 'text/event-stream' },
        llmRouter: { decision: { tier: 0 } },
      } as ProxyRequestLike,
      recorder.res,
      jest.fn()
    );

    expect(recorder.statusCode).toBe(200);
    expect(recorder.flushHeaders).toHaveBeenCalled();
    expect(recorder.headers.get('content-type')).toBe('text/event-stream');
    expect(recorder.headers.get('cache-control')).toBe('no-cache');
    expect(recorder.ended).toBe(true);
    expect(recorder.writes.map(chunk => chunk.toString()).join('')).toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1720000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"Hel"},"logprobs":null,"finish_reason":null}]}\n\n' +
        'data: [DONE]\n\n'
    );
  });

  it('passes malformed SSE chunks to next and does not silently forward them', async () => {
    const gateway = createGatewayForProxyTests();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      createSseResponse(['data: {"bad":true}\n\n'], {
        headers: { 'content-type': 'text/event-stream' },
      })
    );
    const recorder = createProxyResponseRecorder();
    const next = jest.fn();

    await gateway.proxy()(
      {
        body: { ...validRequest, stream: true },
        llmRouter: { decision: { tier: 0 } },
      } as ProxyRequestLike,
      recorder.res,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(String(next.mock.calls[0]?.[0])).toContain('Malformed upstream SSE chunk');
    expect(recorder.writes).toEqual([]);
  });

  it('normalizes documented transport adapter defaults', () => {
    const defaultGateway = new LlmGateNode();
    expect((defaultGateway as any).primaryModel).toBe('cc/claude-opus-4-8');
  });

  it('uses the filtered OmniRoute defaults without inventing credentials', () => {
    const defaultGateway = new LlmGateNode();
    expect((defaultGateway as any).baseUrl).toBe('http://127.0.0.1:20132/v1');
    expect((defaultGateway as any).usageUrl).toBe('http://127.0.0.1:20132/api');
    expect((defaultGateway as any).apiKey).toBe(
      process.env.OMNIROUTE_API_KEY || process.env.OPENAI_API_KEY || ''
    );
  });

  it('configures the documented OmniRoute transport adapter and provider connection ids', () => {
    const gateway = new LlmGateNode({
      apiKey: 'secret-token',
      providerConnIds: { openai: 'conn-openai' },
      transportAdapter: {
        kind: 'omniroute-documented',
        modelListPath: '/models',
        usagePathTemplate: '/usage/{connectionId}',
        timeoutMs: 1234,
      },
    });

    expect((gateway as any).getProviderConnIds()).toEqual({ openai: 'conn-openai' });
    expect((gateway as any).transportAdapter).toMatchObject({
      kind: 'omniroute-documented',
      modelListPath: '/models',
      usagePathTemplate: '/usage/{connectionId}',
      timeoutMs: 1234,
    });
    expect((gateway as any).buildAdapterHeaders()).toEqual({
      Authorization: 'Bearer secret-token',
    });
  });

  it('discovers capabilities through the documented transport adapter', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'openai/gpt-4o-mini' }, { id: 'anthropic/claude-3-5-haiku' }],
      }),
    }));
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);

    const gateway = new LlmGateNode({
      apiKey: 'secret-token',
      transportAdapter: { kind: 'omniroute-documented' },
    });

    const ids = await (gateway as any).discoverCapabilities(true);

    expect(ids).toEqual(['openai/gpt-4o-mini', 'anthropic/claude-3-5-haiku']);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:20132/v1/models', {
      headers: { Authorization: 'Bearer secret-token' },
      signal: expect.any(AbortSignal),
    });
  });

  it('fails open when capability discovery returns malformed JSON', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [{ id: 'wrong/shape' }] }),
    }));
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);

    const gateway = new LlmGateNode({
      transportAdapter: { kind: 'omniroute-documented' },
    });

    const ids = await (gateway as any).discoverCapabilities(true);

    expect(ids).toEqual([]);
  });

  it('fails open when capability discovery is unauthorized', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'unauthorized' }),
    }));
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);

    const gateway = new LlmGateNode({
      apiKey: 'bad-token',
      transportAdapter: { kind: 'omniroute-documented' },
    });

    const ids = await (gateway as any).discoverCapabilities(true);

    expect(ids).toEqual([]);
  });

  it('fails open when capability discovery times out or is unavailable', async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error('timeout');
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);

    const gateway = new LlmGateNode({
      transportAdapter: { kind: 'omniroute-documented', timeoutMs: 10 },
    });

    await expect((gateway as any).discoverCapabilities(true)).resolves.toEqual([]);
  });

  it('checks documented usage adapter headroom when configured', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/models')) {
        return {
          ok: true,
          json: async () => ({ data: [{ id: 'openai/gpt-4o-mini' }] }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          quotas: [
            {
              modelKey: 'gpt-4o-mini',
              remainingPercentage: 0,
              unlimited: false,
              displayName: 'GPT 4o Mini',
            },
          ],
        }),
      };
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);

    const gateway = new LlmGateNode({
      apiKey: 'secret-token',
      providerConnIds: { openai: 'conn-openai' },
      transportAdapter: { kind: 'omniroute-documented' },
    });

    await expect((gateway as any).modelHasHeadroom('openai/gpt-4o-mini')).resolves.toBe(false);
  });

  it('skips usage lookups when using a generic openai-compatible transport adapter', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const gateway = new LlmGateNode({
      providerConnIds: { openai: 'conn-openai' },
      transportAdapter: { kind: 'openai-compatible' },
    });

    await expect((gateway as any).getUsageForProvider('openai')).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('handles missing req.body gracefully by falling back to empty object serialization', async () => {
    const app = express();
    const gateway = new LlmGateNode('custom/model-1');

    // Intentionally omit express.json() to leave req.body undefined
    app.post(
      '/v1/chat/completions',
      gateway.middleware(),
      (req: Request & { llmRouter?: unknown }, res: ExpressResponse) => {
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
        (req: Request & { llmRouter?: unknown }, res: ExpressResponse) => {
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
      ['temperature below range', { ...validRequest, temperature: -0.1 }],
      ['temperature above range', { ...validRequest, temperature: 2.1 }],
      ['temperature as string', { ...validRequest, temperature: '0.5' }],
      ['top_p below range', { ...validRequest, top_p: -0.01 }],
      ['top_p above range', { ...validRequest, top_p: 1.01 }],
      ['max_tokens is zero', { ...validRequest, max_tokens: 0 }],
      ['max_tokens is float', { ...validRequest, max_tokens: 1.5 }],
      ['max_completion_tokens is zero', { ...validRequest, max_completion_tokens: 0 }],
      ['n is zero', { ...validRequest, n: 0 }],
      ['presence_penalty below range', { ...validRequest, presence_penalty: -2.1 }],
      ['frequency_penalty above range', { ...validRequest, frequency_penalty: 2.1 }],
      ['logit_bias has string value', { ...validRequest, logit_bias: { '42': 'bad' } }],
      ['logprobs is string', { ...validRequest, logprobs: 'true' }],
      ['top_logprobs above range', { ...validRequest, top_logprobs: 21 }],
      ['seed is float', { ...validRequest, seed: 0.5 }],
      ['tool missing function', { ...validRequest, tools: [{ type: 'function' }] }],
      [
        'tool has wrong type',
        { ...validRequest, tools: [{ type: 'search', function: { name: 'x' } }] },
      ],
      ['tool_choice invalid string', { ...validRequest, tool_choice: 'always' }],
      [
        'tool_choice missing function name',
        { ...validRequest, tool_choice: { type: 'function', function: {} } },
      ],
      ['parallel_tool_calls is string', { ...validRequest, parallel_tool_calls: 'true' }],
      [
        'response_format json_schema missing json_schema',
        { ...validRequest, response_format: { type: 'json_schema' } },
      ],
      [
        'stream_options invalid shape',
        { ...validRequest, stream_options: { include_usage: 'yes' } },
      ],
      ['metadata contains nested object', { ...validRequest, metadata: { trace: { id: 'bad' } } }],
      ['stream is string', { ...validRequest, stream: 'false' }],
      ['user is empty', { ...validRequest, user: '' }],
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

    it('preserves forward-compatible message and response-format fields', () => {
      const payload = {
        ...validRequest,
        messages: [{ role: 'user', content: 'hi', 'x-message-extra': true }],
        response_format: { type: 'text', 'x-format-extra': 'kept' },
      };

      const result = OpenAIChatCompletionRequestSchema.safeParse(payload);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.messages[0]['x-message-extra']).toBe(true);
        expect(result.data.response_format?.['x-format-extra']).toBe('kept');
      }
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
        'choice invalid logprobs shape',
        {
          ...validResponse,
          choices: [{ ...validResponse.choices[0], logprobs: { content: [{}], extra: true } }],
        },
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
        'usage total tokens missing',
        { ...validResponse, usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ],
      [
        'usage details negative',
        {
          ...validResponse,
          usage: { ...validResponse.usage, prompt_tokens_details: { cached_tokens: -1 } },
        },
      ],
      ['system_fingerprint empty', { ...validResponse, system_fingerprint: '' }],
      ['service_tier empty', { ...validResponse, service_tier: '' }],
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

  describe('OpenAI chat completion chunk parser', () => {
    it('accepts a valid SSE chunk payload', () => {
      expect(OpenAIChatCompletionChunkSchema.safeParse(validChunk).success).toBe(true);
    });

    it.each([
      ['missing id', (({ id: _id, ...rest }) => rest)(validChunk)],
      ['wrong object', { ...validChunk, object: 'chat.completion' }],
      ['negative created', { ...validChunk, created: -1 }],
      ['choices is object', { ...validChunk, choices: { index: 0 } }],
      ['delta missing', { ...validChunk, choices: [{ index: 0, finish_reason: null }] }],
      [
        'delta tool call invalid type',
        {
          ...validChunk,
          choices: [
            {
              ...validChunk.choices[0],
              delta: {
                ...validChunk.choices[0].delta,
                tool_calls: [{ index: 0, type: 'search' }],
              },
            },
          ],
        },
      ],
      [
        'finish_reason invalid',
        { ...validChunk, choices: [{ ...validChunk.choices[0], finish_reason: 'done' }] },
      ],
      ['usage invalid', { ...validChunk, usage: { prompt_tokens: 1, completion_tokens: 1 } }],
      [
        'prototype pollution in chunk',
        JSON.parse(
          '{"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"gpt-4","choices":[],"__proto__":{"admin":true}}'
        ),
      ],
    ])('rejects incorrect OpenAI chunk JSON: %s', (_name, payload) => {
      const result = OpenAIChatCompletionChunkSchema.safeParse(payload);

      expect(result.success).toBe(false);
    });

    it('preserves forward-compatible streaming delta fields', () => {
      const payload = {
        ...validChunk,
        choices: [
          {
            ...validChunk.choices[0],
            delta: { content: 'x', 'x-delta-extra': true },
          },
        ],
      };

      const result = OpenAIChatCompletionChunkSchema.safeParse(payload);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.choices[0].delta['x-delta-extra']).toBe(true);
      }
    });
  });
});
