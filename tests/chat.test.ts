import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ChatService, ChatServiceError, type ChatEvent } from '../src/main/chat';

const temporaryDirectories: string[] = [];

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-chat-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function sseResponse(events: unknown[], chunkSize = 13): Response {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('filters account model catalog while preserving server order', async () => {
  let requestUrl = '';
  let authorization = '';
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    authorization = new Headers(init?.headers).get('Authorization') ?? '';
    return Response.json({ models: [
      { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
      { slug: 'model-b', display_name: 'Model B', visibility: 'list' },
      { slug: 'model-a', display_name: 'Model A', visibility: 'list' },
    ] });
  }) as typeof fetch;
  const chat = new ChatService({ dataDir: await testDirectory(), fetch: fetchMock });

  assert.deepEqual(await chat.listModels('secret-token'), [
    { slug: 'model-b', displayName: 'Model B' },
    { slug: 'model-a', displayName: 'Model A' },
  ]);
  assert.equal(requestUrl, 'https://api.openai.com/v1/models');
  assert.equal(authorization, 'Bearer secret-token');
});

test('streams responses, sends full per-account history, and persists local usage', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (bodies.length === 1) {
      return sseResponse([
        { type: 'response.output_text.delta', delta: 'Hell' },
        { type: 'response.output_text.delta', delta: 'o 👋' },
        { type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 }, output: [{ content: [{ type: 'output_text', text: 'Hello 👋' }] }] } },
      ], 5);
    }
    return sseResponse([
      { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 }, output: [{ content: [{ type: 'output_text', text: 'Again.' }] }] } },
    ]);
  }) as typeof fetch;
  const dataDir = await testDirectory();
  const chat = new ChatService({ dataDir, fetch: fetchMock });
  const events: ChatEvent[] = [];

  const first = await chat.sendMessage({ accountId: 'account-a', accessToken: 'token', model: 'model-a', content: 'Hi' }, (event) => events.push(event));
  assert.equal(first.content, 'Hello 👋');
  assert.deepEqual(bodies[0], {
    model: 'model-a',
    input: [{ role: 'user', content: 'Hi' }],
    store: false,
    stream: true,
  });
  assert.deepEqual(events.map((event) => event.type), ['delta', 'delta', 'usage', 'completed']);
  assert.deepEqual(events.find((event) => event.type === 'usage'), {
    type: 'usage', accountId: 'account-a',
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    totalUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
  });

  await chat.sendMessage({ accountId: 'account-a', accessToken: 'token', model: 'model-a', content: 'More' });
  assert.deepEqual(bodies[1]?.input, [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello 👋' },
    { role: 'user', content: 'More' },
  ]);

  const reloaded = new ChatService({ dataDir, fetch: fetchMock });
  assert.deepEqual((await reloaded.getConversation('account-a')).usage, {
    inputTokens: 19, outputTokens: 7, totalTokens: 26,
  });
  assert.equal((await reloaded.getConversation('account-a')).messages.length, 4);
  assert.deepEqual(await reloaded.getConversation('account-b'), {
    accountId: 'account-b', messages: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });
  await reloaded.clearConversation('account-a');
  assert.equal((await reloaded.getConversation('account-a')).messages.length, 0);
  assert.equal((await reloaded.getConversation('account-a')).usage.totalTokens, 26);
  await reloaded.deleteAccountData('account-a');
  assert.equal((await reloaded.getConversation('account-a')).usage.totalTokens, 0);
});

test('a late usage-limit failure pauses only that account and does not save a partial turn', async () => {
  let calls = 0;
  const fetchMock = (async () => {
    calls += 1;
    return sseResponse([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit reached.' } } },
    ]);
  }) as typeof fetch;
  const chat = new ChatService({ dataDir: await testDirectory(), fetch: fetchMock });
  const send = () => chat.sendMessage({ accountId: 'account-a', accessToken: 'token', model: 'model-a', content: 'Hi' });

  await assert.rejects(send, (error: unknown) => error instanceof ChatServiceError
    && error.kind === 'limit' && error.code === 'subscription_sharing_usage_limit_exceeded');
  assert.equal(chat.isPaused('account-a'), true);
  assert.equal(chat.isPaused('account-b'), false);
  assert.deepEqual((await chat.getConversation('account-a')).messages, []);
  await assert.rejects(send, (error: unknown) => error instanceof ChatServiceError && error.kind === 'limit');
  assert.equal(calls, 1);
  chat.resumeAccount('account-a');
  assert.equal(chat.isPaused('account-a'), false);
});

test('auth failure and interrupted stream are distinct and never expose an access token', async () => {
  const token = 'very-secret-token';
  let calls = 0;
  const fetchMock = (async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json({ error: { code: 'subscription_sharing_invalid_user', message: `Bad credential ${token}` } }, {
        status: 401,
        headers: { 'x-request-id': 'req-123' },
      });
    }
    return sseResponse([{ type: 'response.output_text.delta', delta: 'partial' }]);
  }) as typeof fetch;
  const chat = new ChatService({ dataDir: await testDirectory(), fetch: fetchMock });

  await assert.rejects(
    chat.sendMessage({ accountId: 'account-a', accessToken: token, model: 'model-a', content: 'Hi' }),
    (error: unknown) => error instanceof ChatServiceError && error.kind === 'auth'
      && error.status === 401 && error.requestId === 'req-123' && !error.message.includes(token),
  );
  await assert.rejects(
    chat.sendMessage({ accountId: 'account-a', accessToken: token, model: 'model-a', content: 'Hi' }),
    (error: unknown) => error instanceof ChatServiceError && error.kind === 'interrupted',
  );
  assert.deepEqual((await chat.getConversation('account-a')).messages, []);
});

test('aborting after a streamed delta drops the partial turn and releases busy state', async () => {
  const abortController = new AbortController();
  let signalPassedToFetch: AbortSignal | null | undefined;
  const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
    signalPassedToFetch = init?.signal;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  const chat = new ChatService({ dataDir: await testDirectory(), fetch: fetchMock });
  let resolveDelta!: () => void;
  const sawDelta = new Promise<void>((resolve) => { resolveDelta = resolve; });
  const send = chat.sendMessage({
    accountId: 'account-a', accessToken: 'token', model: 'model-a', content: 'Hi', signal: abortController.signal,
  }, (event) => {
    if (event.type === 'delta') resolveDelta();
  });

  await sawDelta;
  assert.equal(signalPassedToFetch, abortController.signal);
  assert.equal(chat.isBusy('account-a'), true);
  abortController.abort();
  await assert.rejects(send, (error: unknown) => error instanceof ChatServiceError && error.kind === 'interrupted');
  assert.equal(chat.isBusy('account-a'), false);
  assert.deepEqual((await chat.getConversation('account-a')).messages, []);
  assert.equal((await chat.getConversation('account-a')).usage.totalTokens, 0);
});
