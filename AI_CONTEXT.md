# AI_CONTEXT.md

## Project
`make.fun` Multi-Bounty Solution Monorepo (@CryptoExplor).

## Type
Server, CLI, Bot, Onchain.

## Architecture
Modular multi-bounty monorepo where each make.fun competition is housed in its own isolated subfolder, while the root `main.ts` acts as the master dispatch entrypoint for make.fun grading environments.

- **Root Dispatcher (`main.ts`)**: Detects active environment flags (`MAKEFUN_ENV_URL`, `MAKEFUN_PROMPT_FILE`, or `--list`) and delegates to the appropriate bounty module (`free-model-aggregator-01/main.ts`, etc.).
- **Bounty: `free-model-aggregator-01`**:
  - `free-model-aggregator-01/lib/wire.ts`: Bi-directional normalization between OpenAI, Anthropic, and Gemini wire protocols for JSON and SSE streaming (tool calling, vision/base64, structured JSON schema).
  - `free-model-aggregator-01/lib/router.ts`: Quality-maximizing priority router sorting candidates by `rating_milli` descending, filtering capabilities, tracking 1-call concurrency, and performing multi-tier failover on 402/429 upstream errors.
  - `free-model-aggregator-01/lib/providers.ts`: Dynamic brief parsing and fallback catalog generation covering 10 free-tier providers.
  - `free-model-aggregator-01/main.ts`: HTTP server supporting OpenAI & Anthropic client endpoints, protocol version 1 registration, and work queue polling.

## Stack
- Node.js 22+ (TypeScript / ES Modules, zero external npm dependencies).
- Solana CLI & Keypair integration for make.fun SIWS authentication and prize claims.

## Key Files
- `main.ts`: Root container entrypoint.
- `AGENTS.md`: Multi-bounty standards and agent guidelines.
- `free-model-aggregator-01/`: Autonomous free model aggregator implementation.
- `free-model-aggregator-01/test/test_wires.ts`: Unit test suite for wire adapters and routing.

## Constraints
- Zero npm package dependencies in submitted solution.
- Verifiable agent session authorship >30% on repository code.
- Strict gitignore for private claim codes, keys, and bundles (`claim-code.txt`, `claim-info.json`, `*keypair*.json`, `transcripts.tar.gz`).
- Never leak credentials or private keys.

## Current Focus
- Entry for `free-model-aggregator-01` submitted successfully (Submission ID: `01a1dabf-2edd-77e5-9ec7-16048ce3c355`, Commit `20d6083fcce9b04e9e79191980b8b35ff2f09efe`).
- Next step: Monitor round 1 intake / practice grading on make.fun.
