# @verdict/node — TypeScript Middleware for Verdict Routing

[![npm](https://img.shields.io/npm/v/@verdict/node.svg)](https://www.npmjs.com/package/@verdict/node)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-139%20passing-brightgreen.svg)](<>)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> **Enterprise LLM Criticality Router middleware for Express, Next.js** — policy-gated, capability-aware routing with OpenAI-compatible upstream proxy.

---

## What is @verdict/node?

`@verdict/node` is the TypeScript gateway integration layer for the **Verdict** ecosystem. It accepts an Express/Next.js request, classifies criticality, discovers models from your configured OpenAI-compatible upstream (default: OmniRoute at `http://localhost:20128/v1`), rewrites the selected model, and forwards non-streaming SSE responses.

**Works with any OpenAI-compatible client**: Claude Code, Codex, Cursor, Cline, Hermes, Agents SDK, raw HTTP.

---

## Status

**Alpha** — not production-ready. Current implementation provides:

- Heuristic criticality classification
- Zod request/response schemas
- Model catalog discovery from configured upstream
- Bounded fallback ladder for selected HTTP/network failures
- Non-streaming SSE forwarding
- In-memory score cache (process-local)

**Missing** (tracked on release board):

- Verified Ruflo/RuVector IntelligenceService integration
- Persistent learning / cross-process state
- Reliable live quota/headroom data
- Full OpenAI field preservation
- Complete adversarial streaming/fallback contract

### Supported TypeScript toolchain

This release supports TypeScript `5.9.x` with `ts-jest@29.4.x` and Jest 30.
`ts-jest@29.4.x` declares `typescript >=4.3 <7`, so TypeScript 7 is not a
supported configuration for this package. Keep the compiler pinned to the
documented 5.9 line until a ts-jest release with an explicit TypeScript 7 peer
range is available and verified. Issue [#14](https://github.com/mrnicholasbcarter-code/verdict-node/issues/14)
tracks that upgrade; the supported ceiling is intentional rather than hidden
behind an install fallback.

---

## Install

```bash
npm install @verdict/node
# or
pnpm add @verdict/node
# or
yarn add @verdict/node
```

**Peer dependency**: `express@>=5.0.0 <6`

---

## Quick Start

```typescript
import express from 'express';
import { verdictMiddleware } from '@verdict/node/middleware';

const app = express();
app.use(express.json());

// Mount Verdict middleware
app.use(
  '/v1',
  verdictMiddleware({
    upstream: 'http://localhost:20128/v1', // OmniRoute or your proxy
    criticality: 'auto', // auto | low | medium | high | critical
  })
);

app.listen(3000, () => console.log('verdict-node listening on :3000'));
```

```bash
# Start OmniRoute (if not running)
docker run -d -p 20128:20128 omnibus/omniroute

# Start your app
node dist/index.js
```

---

## Configuration

```typescript
import { verdictMiddleware, VerdictConfig } from '@verdict/node/middleware';

const config: VerdictConfig = {
  // Upstream OpenAI-compatible endpoint
  upstream: process.env.VERDICT_UPSTREAM ?? 'http://localhost:20128/v1',

  // Criticality classification: 'auto' | 'low' | 'medium' | 'high' | 'critical'
  criticality: 'auto',

  // Optional: Custom model catalog (bypasses discovery)
  modelCatalog: [
    { id: 'anthropic/claude-3-opus-20240229', capabilities: ['tools', 'vision'] },
    { id: 'openai/gpt-4o', capabilities: ['tools', 'vision'] },
    { id: 'auto/best-coding', capabilities: ['tools', 'reasoning'] },
  ],

  // Fallback ladder (ordered)
  fallbacks: [
    { model: 'auto/best-fast', maxRetries: 2 },
    { model: 'auto/best-reasoning', maxRetries: 1 },
  ],

  // Request timeout
  timeoutMs: 30000,

  // Enable request/response logging
  debug: process.env.NODE_ENV === 'development',
};

app.use('/v1', verdictMiddleware(config));
```

---

## API

### `verdictMiddleware(config: VerdictConfig): express.RequestHandler`

Express middleware that:

1. Intercepts `POST /v1/chat/completions`
2. Classifies request criticality (heuristic or explicit header `x-verdict-criticality`)
3. Discovers/uses model catalog from upstream
4. Selects best model via Verdict Core logic (or local heuristic)
5. Rewrites `model` field in request body
6. Forwards to upstream, streams response back

### Types

```typescript
// From @verdict/node
import type {
  VerdictConfig,
  ModelInfo,
  CriticalityLevel,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '@verdict/node';
```

---

## Integration with Verdict Core

For full policy-gated routing (not just heuristic), run Verdict Core alongside:

```bash
# Terminal 1: Verdict Core API
verdict serve --host 0.0.0.0 --port 8000

# Terminal 2: Verdict Node middleware pointing to Core
export VERDICT_UPSTREAM=http://localhost:8000/v1
node dist/index.js
```

Then `@verdict/node` will use Core's `/v1/route` endpoint for model selection.

---

## Development

```bash
# Install deps
npm install

# Type-check
npm run typecheck

# Lint
npm run lint

# Test
npm test

# Build
npm run build

# Verify package
npm run verify:package
```

---

## Project Structure

```
verdict-node/
├── src/
│   ├── index.ts              # Main exports
│   ├── middleware/           # Express middleware
│   │   ├── index.ts
│   │   ├── criticality.ts    # Criticality classification
│   │   ├── catalog.ts        # Model catalog discovery
│   │   ├── routing.ts        # Model selection logic
│   │   └── proxy.ts          # SSE proxy forwarding
│   ├── types/                # Zod schemas + TS types
│   └── utils/
├── tests/                    # 139 tests
├── scripts/                  # verify-package.mjs
├── dist/                     # Build output
└── package.json
```

---

## Ecosystem

| Package                                                           | Purpose                                |
| ----------------------------------------------------------------- | -------------------------------------- |
| [`verdict-core`](https://github.com/verdict/verdict-core)         | Python control plane                   |
| `@verdict/node`                                                   | Express/Next.js middleware (this repo) |
| [`verdict-cockpit`](https://github.com/verdict/verdict-cockpit)   | Next.js dashboard                      |
| [`verdict-risk`](https://github.com/verdict/verdict-risk)         | Risk engine                            |
| [`verdict-edge`](https://github.com/verdict/verdict-edge)         | Edge mining framework                  |
| [`verdict-backtest`](https://github.com/verdict/verdict-backtest) | Monte Carlo harness                    |
| OmniRoute                                                         | 250+ providers, 90+ free tiers         |

---

## Links

- **Verdict Core**: https://github.com/verdict/verdict-core
- **Verdict Cockpit**: https://github.com/verdict/verdict-cockpit
- **Issues**: https://github.com/verdict/verdict-node/issues
- **Discord**: https://discord.gg/verdict

---

## License

MIT — see [LICENSE](LICENSE)
