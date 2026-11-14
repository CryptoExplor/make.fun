// Local Test Suite for Wire Adapters & Quality Routing
// free-model-aggregator-01

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBrief, type Probe, type Requirement } from '../lib/providers.ts';
import { ModelRouter } from '../lib/router.ts';
import {
  anthropicToOpenAIResponse,
  geminiToAnthropicResponse,
  geminiToOpenAIResponse,
  normalizeRequest,
  openAIToAnthropic,
  toAnthropicRequest,
  toGeminiRequest,
  toOpenAIRequest,
} from '../lib/wire.ts';

const promptPath = join(
  process.cwd(),
  'free-model-aggregator-kit',
  'free-model-aggregator-01-kit',
  'practice',
  'trial-0',
  'input',
  'prompt.txt'
);

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runTests(): Promise<void> {
  console.log('Running free-model-aggregator-01 test suite...\n');

  // 1. Brief Loading Test
  const brief = readBrief(promptPath);
  assert(brief.error === null, `Brief loading failed: ${brief.error}`);
  assert(brief.directory.providers.length === 10, 'Expected 10 providers in directory');
  assert(brief.ratings !== null && brief.ratings.ratings.length > 0, 'Expected ratings to be loaded');
  assert(brief.workload !== null && brief.workload.manifest.length === 20, 'Expected 20 workload requests');
  console.log('✓ Brief loaded: 10 providers, 20 workload requests, full quality table');

  // 2. Mock Probes from Ratings table
  const mockProbes: Probe[] = brief.directory.providers.map((p) => {
    const models = (brief.ratings?.ratings ?? [])
      .filter((r) => r.provider === p.id)
      .map((r) => ({
        id: r.model,
        display_name: r.model,
        free: r.free,
        context_length: r.context_length,
        tools: r.tools,
        vision: r.vision,
        json: r.json,
      }));
    return {
      provider: p,
      ok: true,
      status: 200,
      models,
      error: null,
    };
  });

  // 3. Router Quality Selection Test
  const router = new ModelRouter(mockProbes, brief.ratings);

  // Test r01 (requires tools: true, vision: true, weight 2)
  const c01 = router.getCandidates({ tools: true, vision: true });
  assert(c01.length > 0, 'Expected candidates for r01 (tools+vision)');
  assert(c01[0].model.id === 'gemini-3.8-flash', `Expected gemini-3.8-flash for r01, got ${c01[0].model.id}`);
  assert(c01[0].rating_milli === 1458, `Expected rating 1458, got ${c01[0].rating_milli}`);
  console.log('✓ r01/r02 (tools+vision) routes to highest-rated model: gemini-3.8-flash (1458)');

  // Test r03 (requires tools: true, weight 2)
  const c03 = router.getCandidates({ tools: true });
  assert(c03.length > 0, 'Expected candidates for r03 (tools)');
  assert(c03[0].rating_milli === 1475, `Expected top rating 1475 for r03, got ${c03[0].rating_milli}`);
  console.log(`✓ r03 (tools) routes to highest-rated model: ${c03[0].model.id} (${c03[0].rating_milli})`);

  // Test r10 (requires min_context: 200,000)
  const c10 = router.getCandidates({ min_context: 200000 });
  assert(c10.length > 0, 'Expected candidates for r10 (min_context 200k)');
  assert(c10[0].rating_milli === 1475, `Expected top rating 1475 for r10, got ${c10[0].rating_milli}`);
  console.log(`✓ r10 (200k context) routes to highest-rated model: ${c10[0].model.id} (${c10[0].rating_milli})`);

  // 4. Wire Conversion Tests
  // A. OpenAI -> Gemini
  const openAiReq = {
    model: 'auto',
    messages: [
      { role: 'system', content: 'You are an assistant' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } },
        ],
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { location: { type: 'string' } } },
        },
      },
    ],
    max_tokens: 1024,
  };

  const norm = normalizeRequest('openai', openAiReq, 'gemini-3.8-flash');
  const geminiReq = toGeminiRequest(norm);
  assert(Array.isArray((geminiReq as any).contents), 'Gemini request must have contents array');
  assert((geminiReq as any).systemInstruction?.parts[0]?.text === 'You are an assistant', 'Gemini systemInstruction missing');
  assert(Array.isArray((geminiReq as any).tools), 'Gemini tools missing');
  console.log('✓ OpenAI -> Gemini wire conversion verified');

  // B. Gemini Response -> OpenAI Response
  const mockGeminiResp = {
    candidates: [
      {
        content: { parts: [{ text: 'Here is the analysis.' }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 10, totalTokenCount: 25 },
  };
  const openAiResp = geminiToOpenAIResponse(mockGeminiResp, 'gemini-3.8-flash');
  assert((openAiResp as any).choices[0]?.message?.content === 'Here is the analysis.', 'OpenAI content mismatch');
  assert((openAiResp as any).choices[0]?.finish_reason === 'stop', 'Finish reason mismatch');
  assert((openAiResp as any).usage?.prompt_tokens === 15, 'Prompt tokens mismatch');
  console.log('✓ Gemini Response -> OpenAI Client response verified');

  // C. Anthropic Response -> OpenAI Response
  const mockAnthropicResp = {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'glm-4.7-flash',
    content: [{ type: 'text', text: 'Anthropic reply.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 20, output_tokens: 8 },
  };
  const openAiFromAnthropic = anthropicToOpenAIResponse(mockAnthropicResp, 'glm-4.7-flash');
  assert((openAiFromAnthropic as any).choices[0]?.message?.content === 'Anthropic reply.', 'OpenAI from Anthropic content mismatch');
  assert((openAiFromAnthropic as any).choices[0]?.finish_reason === 'stop', 'Finish reason mismatch');
  console.log('✓ Anthropic Response -> OpenAI Client response verified');

  // D. Failover test
  router.markExhausted('openrouter');
  const cAfterExhaust = router.getCandidates({ tools: true });
  assert(cAfterExhaust[0].provider.id !== 'openrouter', 'Exhausted provider should be deprioritized in failover');
  console.log(`✓ Failover verified: After exhausting openrouter, routes to ${cAfterExhaust[0].provider.id} (${cAfterExhaust[0].model.id})`);

  console.log('\nAll wire and router tests PASSED successfully!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
