// Bi-directional Wire Translations for OpenAI, Anthropic, and Gemini
// free-model-aggregator-01

import type { ServerResponse } from 'node:http';
import { isRecord, type Json } from './providers.ts';

export interface ServedModel {
  id: string;
  provider: string;
  display_name: string;
}

const FIXED_OPENAI_CREATED = 1767225600;
const FIXED_ANTHROPIC_CREATED_AT = '2026-01-01T00:00:00Z';

export function openAIModelList(models: readonly ServedModel[]): Json {
  return {
    object: 'list',
    data: models.map((m) => ({ id: m.id, object: 'model', created: FIXED_OPENAI_CREATED, owned_by: m.provider })),
  };
}

export function anthropicModelList(models: readonly ServedModel[]): Json {
  return {
    data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: FIXED_ANTHROPIC_CREATED_AT })),
    has_more: false,
  };
}

export function anthropicError(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

export function openAIError(message: string, type: string, code: string | null): Json {
  return { error: { message, type, code } };
}

export function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
}

function argumentsOf(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // not json
    }
  }
  return {};
}

export function stopReasonOf(finish: unknown): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

export function finishReasonOf(stop: unknown): string {
  if (stop === 'max_tokens') return 'length';
  if (stop === 'tool_use') return 'tool_calls';
  if (stop === 'refusal') return 'content_filter';
  return 'stop';
}

function partOf(block: Json): Json | null {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'image' && isRecord(block.source)) {
    const source = block.source;
    if (source.type === 'base64' && typeof source.data === 'string') {
      const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
      return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } };
    }
    if (source.type === 'url' && typeof source.url === 'string') return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = textOf(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

// -------------------------------------------------------------
// Request Normalization & Translation
// -------------------------------------------------------------

export interface NormalizedRequest {
  model: string;
  system: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string | Json[];
    tool_calls?: Json[];
    tool_call_id?: string;
  }>;
  tools?: Array<{
    name: string;
    description: string;
    parameters: Json;
  }>;
  jsonMode: boolean;
  maxTokens?: number;
  stops?: string[];
  stream: boolean;
}

export function normalizeRequest(clientApi: 'openai' | 'anthropic', body: Json, model: string): NormalizedRequest {
  if (clientApi === 'openai') {
    const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
    let system = '';
    const normMsgs: NormalizedRequest['messages'] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        const sysText = typeof m.content === 'string' ? m.content : textOf(m.content);
        system = system === '' ? sysText : `${system}\n${sysText}`;
      } else if (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') {
        normMsgs.push({
          role: m.role as any,
          content: m.content as any,
          tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls : undefined,
          tool_call_id: typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined,
        });
      }
    }
    const tools = Array.isArray(body.tools)
      ? body.tools.flatMap((t) => {
          if (!isRecord(t) || !isRecord(t.function) || typeof t.function.name !== 'string') return [];
          return [
            {
              name: t.function.name,
              description: typeof t.function.description === 'string' ? t.function.description : '',
              parameters: isRecord(t.function.parameters) ? t.function.parameters : { type: 'object', properties: {} },
            },
          ];
        })
      : undefined;

    const format = isRecord(body.response_format) ? body.response_format.type : undefined;
    const jsonMode = format === 'json_object' || format === 'json_schema';
    const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined;
    const stops = Array.isArray(body.stop) ? body.stop.filter((s): s is string => typeof s === 'string') : typeof body.stop === 'string' ? [body.stop] : undefined;

    return {
      model,
      system,
      messages: normMsgs,
      tools: tools && tools.length > 0 ? tools : undefined,
      jsonMode,
      maxTokens,
      stops,
      stream: body.stream === true,
    };
  } else {
    // Anthropic
    const system = typeof body.system === 'string' ? body.system : textOf(body.system);
    const sourceMsgs = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
    const normMsgs: NormalizedRequest['messages'] = [];

    for (const m of sourceMsgs) {
      const assistant = m.role === 'assistant';
      const content = m.content;
      if (typeof content === 'string') {
        normMsgs.push({ role: assistant ? 'assistant' : 'user', content });
        continue;
      }
      if (!Array.isArray(content)) continue;

      if (assistant) {
        const toolCalls: Json[] = [];
        for (const block of content) {
          if (!isRecord(block) || block.type !== 'tool_use') continue;
          toolCalls.push({
            id: typeof block.id === 'string' ? block.id : '',
            type: 'function',
            function: {
              name: typeof block.name === 'string' ? block.name : '',
              arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
            },
          });
        }
        const text = textOf(content);
        normMsgs.push({
          role: 'assistant',
          content: text !== '' ? text : '',
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      } else {
        const parts: Json[] = [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === 'tool_result') {
            normMsgs.push({
              role: 'tool',
              tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
              content: toolResultText(block.content),
            });
            continue;
          }
          const part = partOf(block);
          if (part !== null) parts.push(part);
        }
        if (parts.length > 0) normMsgs.push({ role: 'user', content: parts });
      }
    }

    const tools = Array.isArray(body.tools)
      ? body.tools.flatMap((t) => {
          if (!isRecord(t) || typeof t.name !== 'string') return [];
          return [
            {
              name: t.name,
              description: typeof t.description === 'string' ? t.description : '',
              parameters: isRecord(t.input_schema) ? t.input_schema : { type: 'object', properties: {} },
            },
          ];
        })
      : undefined;

    const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : undefined;
    const stops = Array.isArray(body.stop_sequences) ? body.stop_sequences.filter((s): s is string => typeof s === 'string') : undefined;

    return {
      model,
      system,
      messages: normMsgs,
      tools: tools && tools.length > 0 ? tools : undefined,
      jsonMode: false,
      maxTokens,
      stops,
      stream: body.stream === true,
    };
  }
}

// Convert NormalizedRequest to Target Provider Wire
export function toOpenAIRequest(norm: NormalizedRequest): Json {
  const messages: Json[] = [];
  if (norm.system !== '') {
    messages.push({ role: 'system', content: norm.system });
  }
  for (const m of norm.messages) {
    const outM: Json = { role: m.role, content: m.content };
    if (m.tool_calls) outM.tool_calls = m.tool_calls;
    if (m.tool_call_id) outM.tool_call_id = m.tool_call_id;
    messages.push(outM);
  }

  const out: Json = { model: norm.model, messages };
  if (norm.tools && norm.tools.length > 0) {
    out.tools = norm.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (norm.jsonMode) {
    out.response_format = { type: 'json_object' };
  }
  if (norm.maxTokens !== undefined) out.max_tokens = norm.maxTokens;
  if (norm.stops && norm.stops.length > 0) out.stop = norm.stops;
  if (norm.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

export function toAnthropicRequest(norm: NormalizedRequest): Json {
  const messages: Json[] = [];
  for (const m of norm.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const content: Json[] = [];
      const text = typeof m.content === 'string' ? m.content : '';
      if (text !== '') content.push({ type: 'text', text });
      for (const tc of m.tool_calls) {
        if (!isRecord(tc) || !isRecord(tc.function)) continue;
        content.push({
          type: 'tool_use',
          id: typeof tc.id === 'string' ? tc.id : 'toolu_call',
          name: typeof tc.function.name === 'string' ? tc.function.name : '',
          input: argumentsOf(tc.function.arguments),
        });
      }
      messages.push({ role: 'assistant', content });
      continue;
    }

    if (Array.isArray(m.content)) {
      const blocks: Json[] = [];
      for (const p of m.content) {
        if (!isRecord(p)) continue;
        if (p.type === 'text') blocks.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url' && isRecord(p.image_url) && typeof p.image_url.url === 'string') {
          const match = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url);
          if (match) {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: match[1], data: match[2] },
            });
          }
        }
      }
      messages.push({ role: m.role, content: blocks.length > 0 ? blocks : '' });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  const out: Json = {
    model: norm.model,
    messages,
    max_tokens: norm.maxTokens ?? 4096,
  };
  if (norm.system !== '') out.system = norm.system;
  if (norm.tools && norm.tools.length > 0) {
    out.tools = norm.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  if (norm.stops && norm.stops.length > 0) out.stop_sequences = norm.stops;
  if (norm.stream) out.stream = true;
  return out;
}

export function toGeminiRequest(norm: NormalizedRequest): Json {
  const contents: Json[] = [];
  for (const m of norm.messages) {
    if (m.role === 'system') continue;
    const parts: Json[] = [];
    if (typeof m.content === 'string' && m.content !== '') {
      parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!isRecord(p)) continue;
        if (p.type === 'text' && typeof p.text === 'string') {
          parts.push({ text: p.text });
        } else if (p.type === 'image_url' && isRecord(p.image_url) && typeof p.image_url.url === 'string') {
          const match = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url);
          if (match) {
            parts.push({
              inlineData: { mimeType: match[1], data: match[2] },
            });
          } else {
            parts.push({
              fileData: { fileUri: p.image_url.url },
            });
          }
        }
      }
    }
    if (parts.length > 0) {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }
  }

  const body: Json = { contents };
  if (norm.system !== '') {
    body.systemInstruction = {
      parts: [{ text: norm.system }],
    };
  }
  if (norm.tools && norm.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: norm.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  const config: Json = {};
  if (norm.maxTokens !== undefined) config.maxOutputTokens = norm.maxTokens;
  if (norm.stops && norm.stops.length > 0) config.stopSequences = norm.stops;
  if (norm.jsonMode) config.responseMimeType = 'application/json';
  if (Object.keys(config).length > 0) body.generationConfig = config;

  return body;
}

// -------------------------------------------------------------
// Provider Response -> Client Response (JSON)
// -------------------------------------------------------------

export function openAIToAnthropic(body: Json, model: string): Json {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content: Json[] = [];
  const text = typeof message.content === 'string' ? message.content : textOf(message.content);
  if (text !== '') content.push({ type: 'text', text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    content.push({
      type: 'tool_use',
      id: typeof call.id === 'string' ? call.id : 'toolu_unknown',
      name: typeof call.function.name === 'string' ? call.function.name : '',
      input: argumentsOf(call.function.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    id: `msg_${typeof body.id === 'string' ? body.id : 'aggregator'}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReasonOf(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: numberOrZero(usage.prompt_tokens), output_tokens: numberOrZero(usage.completion_tokens) },
  };
}

export function anthropicToOpenAIResponse(body: Json, model: string): Json {
  const content = Array.isArray(body.content) ? body.content : [];
  let text = '';
  const toolCalls: Json[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : 'call_unknown',
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : '',
          arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
        },
      });
    }
  }
  const usage = isRecord(body.usage) ? body.usage : {};
  const finish = finishReasonOf(body.stop_reason);
  const msgObj: Json = { role: 'assistant', content: text !== '' ? text : null };
  if (toolCalls.length > 0) msgObj.tool_calls = toolCalls;

  return {
    id: typeof body.id === 'string' ? body.id : 'chatcmpl-aggregator',
    object: 'chat.completion',
    created: FIXED_OPENAI_CREATED,
    model,
    choices: [
      {
        index: 0,
        message: msgObj,
        finish_reason: finish,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: numberOrZero(usage.input_tokens),
      completion_tokens: numberOrZero(usage.output_tokens),
      total_tokens: numberOrZero(usage.input_tokens) + numberOrZero(usage.output_tokens),
    },
  };
}

export function geminiToOpenAIResponse(body: Json, model: string): Json {
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const cand = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(cand.content) ? cand.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  let text = '';
  for (const p of parts) {
    if (isRecord(p) && typeof p.text === 'string') text += p.text;
  }
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  const input = numberOrZero(usage.promptTokenCount);
  const output = numberOrZero(usage.candidatesTokenCount);

  return {
    id: 'chatcmpl-gemini-agg',
    object: 'chat.completion',
    created: FIXED_OPENAI_CREATED,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: cand.finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
    },
  };
}

export function geminiToAnthropicResponse(body: Json, model: string): Json {
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const cand = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(cand.content) ? cand.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  let text = '';
  for (const p of parts) {
    if (isRecord(p) && typeof p.text === 'string') text += p.text;
  }
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};

  return {
    id: 'msg_gemini_agg',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: cand.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: numberOrZero(usage.promptTokenCount),
      output_tokens: numberOrZero(usage.candidatesTokenCount),
    },
  };
}

// -------------------------------------------------------------
// Streaming Translations
// -------------------------------------------------------------

export async function pipeDirectStream(stream: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

// Helper: parse SSE data chunks from stream
export async function* parseSseLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = stream.getReader();
  let buffer = '';
  const decoder = new TextDecoder();

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        if (!frame.trim()) continue;
        let event: string | null = null;
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += (data === '' ? '' : '\n') + line.slice(5).trim();
        }
        if (data !== '') yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Stream OpenAI SSE -> Anthropic Client
export async function streamOpenAIToAnthropic(stream: ReadableStream<Uint8Array>, res: ServerResponse, model: string): Promise<void> {
  let started = false;
  let textStarted = false;
  let promptTokens = 0;
  let completionTokens = 0;
  let stopReason = 'end_turn';

  try {
    for await (const { data } of parseSseLines(stream)) {
      if (data === '[DONE]') break;
      let chunk: Json;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;

      if (isRecord(chunk.usage)) {
        promptTokens = numberOrZero(chunk.usage.prompt_tokens);
        completionTokens = numberOrZero(chunk.usage.completion_tokens);
      }

      if (!started) {
        started = true;
        res.write(
          sseEvent('message_start', {
            type: 'message_start',
            message: {
              id: 'msg_stream_agg',
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: promptTokens, output_tokens: 0 },
            },
          })
        );
      }

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      if (choices.length > 0 && isRecord(choices[0])) {
        const choice = choices[0];
        if (typeof choice.finish_reason === 'string') {
          stopReason = stopReasonOf(choice.finish_reason);
        }
        if (isRecord(choice.delta) && typeof choice.delta.content === 'string' && choice.delta.content !== '') {
          if (!textStarted) {
            textStarted = true;
            res.write(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
          }
          res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: choice.delta.content } }));
        }
      }
    }

    if (!started) {
      res.write(
        sseEvent('message_start', {
          type: 'message_start',
          message: { id: 'msg_stream_agg', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        })
      );
    }
    if (textStarted) {
      res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    }
    res.write(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: completionTokens } }));
    res.write(sseEvent('message_stop', { type: 'message_stop' }));
  } finally {
    res.end();
  }
}

// Stream Gemini SSE -> OpenAI Client
export async function streamGeminiToOpenAI(stream: ReadableStream<Uint8Array>, res: ServerResponse, model: string): Promise<void> {
  let sawFirst = false;
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    for await (const { data } of parseSseLines(stream)) {
      let chunk: Json;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;

      if (isRecord(chunk.usageMetadata)) {
        promptTokens = numberOrZero(chunk.usageMetadata.promptTokenCount);
        completionTokens = numberOrZero(chunk.usageMetadata.candidatesTokenCount);
      }

      const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
      if (candidates.length === 0 || !isRecord(candidates[0])) continue;
      const cand = candidates[0];
      const content = isRecord(cand.content) ? cand.content : {};
      const parts = Array.isArray(content.parts) ? content.parts : [];
      let deltaText = '';
      for (const p of parts) {
        if (isRecord(p) && typeof p.text === 'string') deltaText += p.text;
      }

      if (!sawFirst) {
        sawFirst = true;
        res.write(sseEvent(null, { id: 'chatcmpl-gemini', object: 'chat.completion.chunk', created: FIXED_OPENAI_CREATED, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
      }

      if (deltaText !== '') {
        res.write(sseEvent(null, { id: 'chatcmpl-gemini', object: 'chat.completion.chunk', created: FIXED_OPENAI_CREATED, model, choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }] }));
      }

      if (cand.finishReason === 'STOP' || cand.finishReason === 'MAX_TOKENS') {
        const finish = cand.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';
        res.write(sseEvent(null, { id: 'chatcmpl-gemini', object: 'chat.completion.chunk', created: FIXED_OPENAI_CREATED, model, choices: [{ index: 0, delta: {}, finish_reason: finish }] }));
      }
    }

    if (completionTokens > 0 || promptTokens > 0) {
      res.write(sseEvent(null, { id: 'chatcmpl-gemini', object: 'chat.completion.chunk', created: FIXED_OPENAI_CREATED, model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } }));
    }
    res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
}

// Stream Gemini SSE -> Anthropic Client
export async function streamGeminiToAnthropic(stream: ReadableStream<Uint8Array>, res: ServerResponse, model: string): Promise<void> {
  let started = false;
  let textStarted = false;
  let promptTokens = 0;
  let completionTokens = 0;
  let stopReason = 'end_turn';

  try {
    for await (const { data } of parseSseLines(stream)) {
      let chunk: Json;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;

      if (isRecord(chunk.usageMetadata)) {
        promptTokens = numberOrZero(chunk.usageMetadata.promptTokenCount);
        completionTokens = numberOrZero(chunk.usageMetadata.candidatesTokenCount);
      }

      const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
      if (candidates.length === 0 || !isRecord(candidates[0])) continue;
      const cand = candidates[0];
      const content = isRecord(cand.content) ? cand.content : {};
      const parts = Array.isArray(content.parts) ? content.parts : [];
      let deltaText = '';
      for (const p of parts) {
        if (isRecord(p) && typeof p.text === 'string') deltaText += p.text;
      }

      if (!started) {
        started = true;
        res.write(
          sseEvent('message_start', {
            type: 'message_start',
            message: { id: 'msg_gemini_stream', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: promptTokens, output_tokens: 0 } },
          })
        );
      }

      if (deltaText !== '') {
        if (!textStarted) {
          textStarted = true;
          res.write(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        }
        res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: deltaText } }));
      }

      if (cand.finishReason === 'STOP' || cand.finishReason === 'MAX_TOKENS') {
        stopReason = cand.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
      }
    }

    if (!started) {
      res.write(
        sseEvent('message_start', {
          type: 'message_start',
          message: { id: 'msg_gemini_stream', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        })
      );
    }
    if (textStarted) {
      res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    }
    res.write(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: completionTokens } }));
    res.write(sseEvent('message_stop', { type: 'message_stop' }));
  } finally {
    res.end();
  }
}

// Stream Anthropic SSE -> OpenAI Client
export async function streamAnthropicToOpenAI(stream: ReadableStream<Uint8Array>, res: ServerResponse, model: string): Promise<void> {
  let sawFirst = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = 'stop';

  try {
    for await (const { event, data } of parseSseLines(stream)) {
      let chunk: Json;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;

      if (event === 'message_start' && isRecord(chunk.message) && isRecord(chunk.message.usage)) {
        inputTokens = numberOrZero(chunk.message.usage.input_tokens);
      } else if (event === 'content_block_delta' && isRecord(chunk.delta) && typeof chunk.delta.text === 'string') {
        if (!sawFirst) {
          sawFirst = true;
          res.write(sseEvent(null, { id: 'chatcmpl-anth', object: 'chat.completion.chunk', created: FIXED_OPENAI_CREATED, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
        }
        res.write(sseEvent(null, { id: 'chatcmpl-anth', object: 'chat.completion.chunk', created: FIXED_OPENAI_CREATED, model, choices: [{ index: 0, delta: { content: chunk.delta.text }, finish_reason: null }] }));
      } else if (event === 'message_delta') {
        if (isRecord(chunk.delta) && typeof chunk.delta.stop_reason === 'string') {
          finishReason = finishReasonOf(chunk.delta.stop_reason);
        }
        if (isRecord(chunk.usage)) outputTokens = numberOrZero(chunk.usage.output_tokens);
      } else if (event === 'message_stop') {
        res.write(sseEvent(null, { id: 'chatcmpl-anth', object: 'chat.completion.chunk', created: FIXED_OPENAI_CREATED, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }));
        res.write(sseEvent(null, { id: 'chatcmpl-anth', object: 'chat.completion.chunk', created: FIXED_OPENAI_CREATED, model, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }));
        res.write('data: [DONE]\n\n');
      }
    }
  } finally {
    res.end();
  }
}
