# AI Agent Constraints & Architectural Context (.claude.md)

**Target Ecosystem:** Express.js Middleware / Next.js Routing
**Language:** TypeScript / Zod
**Primary Directive:** Strict LLM Route Fallback enforcement.

## System Boundaries

- **Zod Validation:** All incoming LLM `chat/completions` objects must be strictly validated by Zod at the Express endpoint edge before interacting with internal AST routers.
- **Dependency Sandboxing:** This SDK must remain framework-indepedent. Do not tightly couple code to `NextRequest/NextResponse` unless mapping via an agnostic wrapper, as this is used primarily in Express.

## TDD Constraints

If an agent edits the core routing engine or heuristic tiers, it must update `tests/router.test.ts`. `npm test` requires 100% logic coverage to merge.
