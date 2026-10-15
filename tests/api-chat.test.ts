import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { ApiChatService, ANTIGRAVITY_AGENT_ID } from '../src/main/api-chat';
import { ChatServiceError, type ChatEvent } from '../src/main/chat';

const temporaryDirectories: string[] = [];

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-api-chat-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    const pathInsideTemp = relative(resolve(tmpdir()), target);
    assert.ok(pathInsideTemp && !pathInsideTemp.startsWith('..') && !pathInsideTemp.includes('..\\'));
    assert.ok(basename(target).startsWith('switchboard-api-chat-test-'));
    await rm(target, { recursive: true, force: true });
  }
});

function sseResponse(events: unknown[], headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + 7));
      offset += 7;
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', ...headers } });
}

test('Claude model listing uses the official API with a workspace header', async () => {
  let capturedUrl = '';
  let capturedHeaders = new Headers();
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedHeaders = new Headers(init?.headers);
    return Response.json({ data: [
      { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
      { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
    ] });
  }) as typeof fetch;
  const service = new ApiChatService({ dataDir: await testDirectory(), fetch: fetchMock });

  assert.deepEqual(await service.listModels({ provider: 'claude_api', apiKey: 'secret', workspaceId: 'wrkspc_123' }), [
    { slug: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
    { slug: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
  ]);
  assert.equal(capturedUrl, 'https://api.anthropic.com/v1/models?limit=100');
  assert.equal(capturedHeaders.get('x-api-key'), 'secret');
  assert.equal(capturedHeaders.get('anthropic-version'), '2023-06-01');
  assert.equal(capturedHeaders.get('anthropic-workspace-id'), 'wrkspc_123');
});

test('Claude streams text, persists per-connection history and usage, and exposes approximate rate remaining', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'there.' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ], {
      'anthropic-ratelimit-tokens-remaining': '12000',
      'anthropic-ratelimit-tokens-reset': '2026-10-04T10:00:00Z',
    });
  }) as typeof fetch;
  const dataDir = await testDirectory();
  const service = new ApiChatService({ dataDir, fetch: fetchMock });
  const events: ChatEvent[] = [];

  const first = await service.sendMessage({ accountId: 'claude-1', provider: 'claude_api', apiKey: 'secret', model: 'claude-sonnet-5', content: 'Hi' }, (event) => events.push(event));
  assert.equal(first.content, 'Hello there.');
  assert.deepEqual(first.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  assert.deepEqual(events.map((event) => event.type), ['delta', 'delta', 'usage', 'completed']);
  assert.equal(bodies[0]?.stream, true);
  assert.deepEqual(bodies[0]?.messages, [{ role: 'user', content: 'Hi' }]);
  assert.deepEqual(service.getRateLimit('claude-1'), { remainingTokens: 12000, resetsAt: '2026-10-04T10:00:00.000Z' });

  await service.sendMessage({ accountId: 'claude-1', provider: 'claude_api', apiKey: 'secret', model: 'claude-sonnet-5', content: 'Again' });
  assert.deepEqual(bodies[1]?.messages, [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello there.' },
    { role: 'user', content: 'Again' },
  ]);
  const reloaded = new ApiChatService({ dataDir, fetch: fetchMock });
  assert.deepEqual((await reloaded.getConversation('claude-1')).usage, { inputTokens: 20, outputTokens: 8, totalTokens: 28 });
  assert.deepEqual((await reloaded.getConversation('other')).messages, []);
  await reloaded.clearConversation('claude-1');
  assert.equal((await reloaded.getConversation('claude-1')).messages.length, 0);
  assert.equal((await reloaded.getConversation('claude-1')).usage.totalTokens, 28);
  await reloaded.deleteAccountData('claude-1');
  assert.equal((await reloaded.getConversation('claude-1')).usage.totalTokens, 0);
});

test('Antigravity uses only a Gemini API key and a remote agent environment, preserving thought-inclusive usage', async () => {
  const requests: Array<{ url: string; headers: Headers; body?: Record<string, unknown> }> = [];
  let turn = 0;
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
    if (String(url).endsWith('/models?pageSize=1')) return Response.json({ models: [] });
    turn += 1;
    return Response.json({
      id: `interaction-${turn}`,
      environment_id: 'remote-environment-1',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: `Answer ${turn}` }] }],
      usage: { total_input_tokens: 20, total_output_tokens: 10, total_thought_tokens: 90, total_tokens: 120 },
    });
  }) as typeof fetch;
  const service = new ApiChatService({ dataDir: await testDirectory(), fetch: fetchMock });
  assert.deepEqual(await service.listModels({ provider: 'antigravity_api', apiKey: 'gemini-key' }), [
    { slug: ANTIGRAVITY_AGENT_ID, displayName: 'Antigravity agent (Gemini API)' },
  ]);
  assert.ok(requests[0]?.url.endsWith('/models?pageSize=1'));
  assert.equal(requests[0]?.headers.get('x-goog-api-key'), 'gemini-key');
  assert.ok(!requests[0]?.url.includes('gemini-key'));

  const options = { accountId: 'google-1', provider: 'antigravity_api' as const, apiKey: 'gemini-key', model: ANTIGRAVITY_AGENT_ID };
  await service.sendMessage({ ...options, content: 'Hello' });
  await service.sendMessage({ ...options, content: 'Again' });
  assert.deepEqual(requests[1]?.body, {
    agent: ANTIGRAVITY_AGENT_ID,
    input: 'Hello',
    store: true,
    environment: 'remote',
    agent_config: { type: 'antigravity', max_total_tokens: 50000 },
  });
  assert.equal(requests[2]?.body?.previous_interaction_id, 'interaction-1');
  assert.equal(requests[2]?.body?.environment, 'remote-environment-1');
  assert.deepEqual((await service.getConversation('google-1')).usage, { inputTokens: 40, outputTokens: 20, totalTokens: 240 });
  await service.clearConversation('google-1');
  await service.sendMessage({ ...options, content: 'Fresh' });
  assert.equal(requests[3]?.body?.previous_interaction_id, undefined);
  assert.equal(requests[3]?.body?.environment, 'remote');
});

test('provider auth errors hide keys and 429 pauses one connection without saving a partial turn', async () => {
  const key = 'private-api-key';
  let calls = 0;
  const fetchMock = (async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json({ error: { type: 'authentication_error', message: `Bad key ${key}` } }, { status: 401 });
    }
    return Response.json({ error: { type: 'rate_limit_error', message: `Too many uses ${key}` } }, {
      status: 429,
      headers: { 'anthropic-ratelimit-tokens-remaining': '0' },
    });
  }) as typeof fetch;
  const service = new ApiChatService({ dataDir: await testDirectory(), fetch: fetchMock });
  const options = { accountId: 'claude-1', provider: 'claude_api' as const, apiKey: key, model: 'claude-sonnet-5', content: 'Hi' };
  await assert.rejects(service.sendMessage(options), (error: unknown) => error instanceof ChatServiceError
    && error.kind === 'auth' && !error.message.includes(key));
  await assert.rejects(service.sendMessage(options), (error: unknown) => error instanceof ChatServiceError
    && error.kind === 'limit' && !error.message.includes(key));
  assert.equal(service.isPaused('claude-1'), true);
  assert.equal(service.isPaused('claude-2'), false);
  assert.deepEqual(service.getRateLimit('claude-1'), { remainingTokens: 0, resetsAt: null });
  assert.deepEqual((await service.getConversation('claude-1')).messages, []);
  await assert.rejects(service.sendMessage(options), (error: unknown) => error instanceof ChatServiceError && error.kind === 'limit');
  assert.equal(calls, 2);
  service.resumeAccount('claude-1');
  assert.equal(service.isPaused('claude-1'), false);
});

test('clearing an unused Antigravity connection does not create Claude history', async () => {
  const fetchMock = (async () => Response.json({
    id: 'interaction-1', environment_id: 'env-1', status: 'completed',
    output_text: 'Ready', usage: { total_input_tokens: 2, total_output_tokens: 1, total_tokens: 5 },
  })) as typeof fetch;
  const service = new ApiChatService({ dataDir: await testDirectory(), fetch: fetchMock });
  await service.clearConversation('new-google');
  await service.sendMessage({ accountId: 'new-google', provider: 'antigravity_api', apiKey: 'key', model: ANTIGRAVITY_AGENT_ID, content: 'Hi' });
  assert.equal((await service.getConversation('new-google')).messages.length, 2);
});

test('aborting a Claude stream drops the partial turn and releases the connection', async () => {
  const abortController = new AbortController();
  const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n'));
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  const service = new ApiChatService({ dataDir: await testDirectory(), fetch: fetchMock });
  let resolveDelta!: () => void;
  const sawDelta = new Promise<void>((resolve) => { resolveDelta = resolve; });
  const send = service.sendMessage({
    accountId: 'claude-1', provider: 'claude_api', apiKey: 'key', model: 'claude-sonnet-5', content: 'Hi', signal: abortController.signal,
  }, (event) => {
    if (event.type === 'delta') resolveDelta();
  });
  await sawDelta;
  assert.equal(service.isBusy('claude-1'), true);
  abortController.abort();
  await assert.rejects(send, (error: unknown) => error instanceof ChatServiceError && error.kind === 'interrupted');
  assert.equal(service.isBusy('claude-1'), false);
  assert.deepEqual((await service.getConversation('claude-1')).messages, []);
});
