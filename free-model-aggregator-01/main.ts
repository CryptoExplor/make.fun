// Free AI Model Aggregator - Server Entrypoint
// free-model-aggregator-01

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  authHeaders,
  buildCatalog,
  isRecord,
  joinBase,
  modelFree,
  probeProvider,
  ratingOfModel,
  readBrief,
  type CatalogReport,
  type Json,
  type Probe,
  type ProbedModel,
  type Requirement,
} from './lib/providers.ts';
import { ModelRouter, type RouteCandidate } from './lib/router.ts';
import {
  anthropicError,
  anthropicModelList,
  anthropicToOpenAIResponse,
  geminiToAnthropicResponse,
  geminiToOpenAIResponse,
  normalizeRequest,
  openAIError,
  openAIModelList,
  openAIToAnthropic,
  pipeDirectStream,
  streamAnthropicToOpenAI,
  streamGeminiToAnthropic,
  streamGeminiToOpenAI,
  streamOpenAIToAnthropic,
  toAnthropicRequest,
  toGeminiRequest,
  toOpenAIRequest,
  type ServedModel,
} from './lib/wire.ts';

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

const brief = readBrief(PROMPT_FILE);
let probes: Probe[] = [];
let catalog: CatalogReport = { providers: [] };
let router: ModelRouter;
let manifestIndex = 0;

function log(message: string): void {
  process.stderr.write(`[aggregator] ${message}\n`);
}

async function load(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  probes = await Promise.all(
    brief.directory.providers.map((provider) => probeProvider(ENV_URL, provider, PROBE_TIMEOUT_MS))
  );
  catalog = buildCatalog(ENV_URL, probes, brief.ratings, brief.directory.providers);
  router = new ModelRouter(probes, brief.ratings);
}

function servedModels(): ServedModel[] {
  const out: ServedModel[] = [];
  const byId = (a: ProbedModel, b: ProbedModel): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const probe of probes) {
    if (!probe.ok) continue;
    for (const model of [...probe.models].sort(byId)) {
      const row = ratingOfModel(brief.ratings, probe.provider.id, model.id);
      if (!modelFree(model, row)) continue;
      out.push({ id: model.id, provider: probe.provider.id, display_name: model.display_name });
    }
  }
  return out;
}

function requirementsFor(body: Json): Requirement {
  const manifest = brief.workload?.manifest ?? [];
  const entry = manifest[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;

  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/**
 * Execute call to target provider in its native wire format.
 */
async function callTargetProvider(
  route: RouteCandidate,
  clientApi: 'openai' | 'anthropic',
  body: Json
): Promise<Response> {
  const base = joinBase(ENV_URL, route.provider.base);
  const norm = normalizeRequest(clientApi, body, route.model.id);
  const targetWire = route.provider.wire;

  let url: string;
  let headers: Record<string, string> = {
    'content-type': 'application/json',
    ...authHeaders(route.provider.auth, route.provider.key),
  };
  let requestBody: Json;

  if (targetWire === 'openai') {
    url = `${base}/v1/chat/completions`;
    if (norm.stream) headers.accept = 'text/event-stream';
    requestBody = toOpenAIRequest(norm);
  } else if (targetWire === 'anthropic') {
    url = `${base}/v1/messages`;
    headers['anthropic-version'] = '2023-06-01';
    if (norm.stream) headers.accept = 'text/event-stream';
    requestBody = toAnthropicRequest(norm);
  } else {
    // gemini wire
    const action = norm.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    url = `${base}/v1beta/models/${encodeURIComponent(route.model.id)}:${action}`;
    requestBody = toGeminiRequest(norm);
  }

  router.recordCallStart(route.provider.id);
  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
  } finally {
    router.recordCallEnd(route.provider.id);
  }
}

/**
 * Handle incoming client request with multi-tier failover.
 */
async function handleInference(
  clientApi: 'openai' | 'anthropic',
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  if (body === null) {
    return sendError(res, clientApi, 400, 'invalid_request_error', 'the request body is not one JSON object');
  }

  const requires = requirementsFor(body);
  const candidates = router.getCandidates(requires);

  if (candidates.length === 0) {
    return sendError(res, clientApi, 503, 'no_free_model', 'no free model on the directory meets this request');
  }

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const response = await callTargetProvider(candidate, clientApi, body);

      // Check for rate limit or payment required (429 or 402)
      if (response.status === 429 || response.status === 402 || response.status >= 500) {
        log(`Provider ${candidate.provider.id} answered ${response.status}. Initiating failover.`);
        router.markExhausted(candidate.provider.id);
        continue;
      }

      if (!response.ok) {
        log(`Provider ${candidate.provider.id} returned status ${response.status}. Failing over.`);
        continue;
      }

      // Success: Stream or JSON response translation
      if (body.stream === true && response.body) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });

        const targetWire = candidate.provider.wire;
        if (targetWire === 'openai') {
          if (clientApi === 'openai') {
            await pipeDirectStream(response.body, res);
          } else {
            await streamOpenAIToAnthropic(response.body, res, candidate.model.id);
          }
        } else if (targetWire === 'anthropic') {
          if (clientApi === 'anthropic') {
            await pipeDirectStream(response.body, res);
          } else {
            await streamAnthropicToOpenAI(response.body, res, candidate.model.id);
          }
        } else {
          // gemini
          if (clientApi === 'openai') {
            await streamGeminiToOpenAI(response.body, res, candidate.model.id);
          } else {
            await streamGeminiToAnthropic(response.body, res, candidate.model.id);
          }
        }
        return;
      }

      // Non-streaming JSON response
      const providerJson: unknown = await response.json();
      if (!isRecord(providerJson)) {
        log(`Provider ${candidate.provider.id} non-JSON response. Failing over.`);
        continue;
      }

      const targetWire = candidate.provider.wire;
      let finalJson: Json;

      if (targetWire === 'openai') {
        if (clientApi === 'openai') {
          finalJson = { ...providerJson, model: candidate.model.id };
        } else {
          finalJson = openAIToAnthropic(providerJson, candidate.model.id);
        }
      } else if (targetWire === 'anthropic') {
        if (clientApi === 'anthropic') {
          finalJson = { ...providerJson, model: candidate.model.id };
        } else {
          finalJson = anthropicToOpenAIResponse(providerJson, candidate.model.id);
        }
      } else {
        // gemini
        if (clientApi === 'openai') {
          finalJson = geminiToOpenAIResponse(providerJson, candidate.model.id);
        } else {
          finalJson = geminiToAnthropicResponse(providerJson, candidate.model.id);
        }
      }

      return sendJson(res, 200, finalJson);
    } catch (err) {
      log(`Error calling ${candidate.provider.id}: ${(err as Error).message}. Failing over.`);
      continue;
    }
  }

  // If all candidates in chain failed
  return sendError(res, clientApi, 503, 'service_unavailable', 'all eligible model providers failed to answer');
}

async function registerWithEnv(port: number): Promise<void> {
  const url = `${ENV_URL}/register`;
  const body = { protocol_version: PROTOCOL_VERSION, port, catalog };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} answered HTTP ${res.status}: ${await res.text()}`);
  }
}

async function pollWork(server: Server): Promise<void> {
  const url = `${ENV_URL}/work`;
  const timer = setInterval(async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (isRecord(data) && data.done === true) {
        clearInterval(timer);
        server.close(() => {
          process.exit(0);
        });
      }
    } catch {
      // transient poll error
    }
  }, POLL_INTERVAL_MS);
}

export async function runServer(): Promise<void> {
  await load();

  if (process.argv.includes('--list')) {
    process.stdout.write(JSON.stringify(catalog));
    process.exit(0);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (url.pathname === '/v1/models' && method === 'GET') {
      return models(req, res);
    }
    if (url.pathname === '/v1/chat/completions' && method === 'POST') {
      return handleInference('openai', req, res);
    }
    if (url.pathname === '/v1/messages' && method === 'POST') {
      return handleInference('anthropic', req, res);
    }

    sendJson(res, 404, { error: 'not_found', message: `no route ${method} ${url.pathname}` });
  });

  server.listen(0, '0.0.0.0', async () => {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server address is invalid');
    log(`listening on port ${address.port}`);
    try {
      await registerWithEnv(address.port);
      log(`registered with env at ${ENV_URL}`);
      await pollWork(server);
    } catch (err) {
      log(`registration failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });
}

// Direct execution entrypoint
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('main.ts')) {
  runServer().catch((err) => {
    process.stderr.write(`fatal: ${(err as Error).stack ?? (err as Error).message}\n`);
    process.exit(1);
  });
}
