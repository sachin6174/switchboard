import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSubscriptionChatService } from '../src/main/claude-subscription-chat';
import { ChatServiceError, type ChatEvent } from '../src/main/chat';

const temporaryDirectories: string[] = [];

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-claude-chat-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    const inside = relative(resolve(tmpdir()), target);
    assert.ok(inside && !inside.startsWith('..') && !inside.includes('..\\'));
    assert.ok(basename(target).startsWith('switchboard-claude-chat-test-'));
    await rm(target, { recursive: true, force: true });
  }
});

function streamDelta(text: string): SDKMessage {
  return {
    type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  } as SDKMessage;
}

function success(text: string): SDKMessage {
  return {
    type: 'result', subtype: 'success', is_error: false, result: text,
    modelUsage: {
      sonnet: {
        inputTokens: 4, cacheReadInputTokens: 3, cacheCreationInputTokens: 2,
        outputTokens: 5,
      },
    },
  } as SDKMessage;
}

test('Claude subscription chat streams and stores usage per isolated account', async () => {
  const dataDir = await testDirectory();
  const calls: Array<{ prompt: string; options?: Options }> = [];
  let closed = 0;
  const service = new ClaudeSubscriptionChatService({
    dataDir,
    binaryPath: () => 'C:\\bundled\\claude.exe',
    queryFactory: (params) => {
      calls.push(params);
      return {
        async *[Symbol.asyncIterator]() {
          yield streamDelta('Hello ');
          yield streamDelta('there.');
          yield {
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'allowed_warning', rateLimitType: 'five_hour',
              utilization: 74, resetsAt: 1_790_000_000,
            },
          } as SDKMessage;
          yield success('Hello there.');
        },
        close() { closed += 1; },
      };
    },
  });
  const events: ChatEvent[] = [];
  const first = await service.sendMessage({
    accountId: 'claude-1', configDir: join(dataDir, 'profile-1'), model: 'sonnet', content: 'Hi',
  }, (event) => events.push(event));
  assert.equal(first.content, 'Hello there.');
  assert.deepEqual(first.usage, { inputTokens: 9, outputTokens: 5, totalTokens: 14 });
  assert.deepEqual(events.map((event) => event.type), ['delta', 'delta', 'usage', 'completed']);
  assert.equal(closed, 1);
  assert.deepEqual(calls[0]?.options?.tools, []);
  assert.deepEqual(calls[0]?.options?.mcpServers, {});
  assert.deepEqual(calls[0]?.options?.settingSources, []);
  assert.deepEqual(calls[0]?.options?.skills, []);
  assert.equal(calls[0]?.options?.persistSession, false);
  assert.equal(calls[0]?.options?.verbatimPrompts, true);
  assert.equal(calls[0]?.options?.env?.CLAUDE_CONFIG_DIR, join(dataDir, 'profile-1'));
  assert.equal(calls[0]?.options?.env?.ANTHROPIC_API_KEY, undefined);
  assert.equal(calls[0]?.options?.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(JSON.parse(calls[0]!.prompt), { messages: [{ role: 'user', content: 'Hi' }] });
  assert.deepEqual(service.getUsageSnapshot('claude-1')?.windows.five_hour, {
    status: 'allowed_warning', utilization: 74, resetsAt: 1_790_000_000,
  });

  await service.sendMessage({
    accountId: 'claude-1', configDir: join(dataDir, 'profile-1'), model: 'sonnet', content: 'Again',
  });
  assert.deepEqual(JSON.parse(calls[1]!.prompt).messages.map((message: { content: string }) => message.content),
    ['Hi', 'Hello there.', 'Again']);

  await service.sendMessage({
    accountId: 'claude-2', configDir: join(dataDir, 'profile-2'), model: 'sonnet', content: 'Private',
  });
  assert.deepEqual(JSON.parse(calls[2]!.prompt), { messages: [{ role: 'user', content: 'Private' }] });
  assert.equal(calls[2]?.options?.env?.CLAUDE_CONFIG_DIR, join(dataDir, 'profile-2'));
  assert.deepEqual((await service.getConversation('claude-1')).usage,
    { inputTokens: 18, outputTokens: 10, totalTokens: 28 });
  assert.deepEqual((await service.getConversation('claude-2')).usage,
    { inputTokens: 9, outputTokens: 5, totalTokens: 14 });

  await service.clearConversation('claude-1');
  assert.equal((await service.getConversation('claude-1')).messages.length, 0);
  assert.equal((await service.getConversation('claude-1')).usage.totalTokens, 28);
  await service.deleteAccountData('claude-1');
  assert.equal((await service.getConversation('claude-1')).usage.totalTokens, 0);
  assert.equal(service.getUsageSnapshot('claude-1'), null);
});

test('Claude authentication and rate limits are distinguished for account recovery', async () => {
  const dataDir = await testDirectory();
  let failure: 'authentication_failed' | 'rate_limit' = 'authentication_failed';
  const service = new ClaudeSubscriptionChatService({
    dataDir,
    binaryPath: () => 'C:\\bundled\\claude.exe',
    queryFactory: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', parent_tool_use_id: null, error: failure, message: { content: [] } } as SDKMessage;
        yield { type: 'result', subtype: 'error_during_execution', errors: [failure], modelUsage: {} } as SDKMessage;
      },
      close() {},
    }),
  });
  const send = () => service.sendMessage({
    accountId: 'claude-1', configDir: join(dataDir, 'profile-1'), model: 'sonnet', content: 'Hi',
  });
  await assert.rejects(send, (error: unknown) => error instanceof ChatServiceError && error.kind === 'auth');
  assert.equal(service.isPaused('claude-1'), false);
  assert.equal((await service.getConversation('claude-1')).messages.length, 0);

  failure = 'rate_limit';
  await assert.rejects(send, (error: unknown) => error instanceof ChatServiceError && error.kind === 'limit');
  assert.equal(service.isPaused('claude-1'), true);
  await assert.rejects(send, (error: unknown) => error instanceof ChatServiceError && error.kind === 'limit');
  service.resumeAccount('claude-1');
  assert.equal(service.isPaused('claude-1'), false);
});

test('Cancellation stops the SDK query and never stores a partial answer', async () => {
  const dataDir = await testDirectory();
  const controller = new AbortController();
  let closed = 0;
  const service = new ClaudeSubscriptionChatService({
    dataDir,
    binaryPath: () => 'C:\\bundled\\claude.exe',
    queryFactory: () => ({
      async *[Symbol.asyncIterator]() {
        yield streamDelta('Partial');
        yield success('Partial answer');
      },
      close() { closed += 1; },
    }),
  });
  await assert.rejects(
    service.sendMessage({
      accountId: 'claude-1', configDir: join(dataDir, 'profile-1'), model: 'sonnet', content: 'Hi',
      signal: controller.signal,
    }, (event) => { if (event.type === 'delta') controller.abort(); }),
    (error: unknown) => error instanceof ChatServiceError && error.kind === 'interrupted',
  );
  assert.ok(closed >= 1);
  assert.equal((await service.getConversation('claude-1')).messages.length, 0);
});
