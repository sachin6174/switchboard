import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Options as ClaudeQueryOptions, SDKMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import {
  ChatServiceError,
  type ChatConversation,
  type ChatEvent,
  type ChatMessage,
  type ChatModel,
  type ChatUsage,
} from './chat';
import { claudeCodeBinary, claudeProcessEnv } from './claude-binary';

export interface ClaudeSubscriptionSendOptions {
  accountId: string;
  /** A unique CLAUDE_CONFIG_DIR owned by this account, supplied by the account manager. */
  configDir: string;
  model: string;
  content: string;
  signal?: AbortSignal;
}

type ClaudeQuery = AsyncIterable<SDKMessage> & { close(): void };
type QueryFactory = (params: { prompt: string; options?: ClaudeQueryOptions }) => ClaudeQuery;

export interface ClaudeSubscriptionChatServiceOptions {
  /** Electron app.getPath('userData') is a suitable parent directory. */
  dataDir: string;
  /** Test seam; production loads Anthropic's official Agent SDK. */
  queryFactory?: QueryFactory;
  /** Test seam; production resolves the SDK's bundled native executable. */
  binaryPath?: () => string;
}

export type ClaudeSubscriptionLimitType = NonNullable<SDKRateLimitInfo['rateLimitType']> | 'general';

export interface ClaudeSubscriptionUsageSnapshot {
  observedAt: string;
  /** Raw provider-reported utilization. It is not a remaining token count. */
  windows: Partial<Record<ClaudeSubscriptionLimitType, {
    status: SDKRateLimitInfo['status'];
    utilization: number | null;
    /** Raw provider timestamp; format/units may change between SDK versions. */
    resetsAt: number | null;
  }>>;
}

const EMPTY_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARACTERS = 150_000;
const MODELS: ChatModel[] = [
  { slug: 'sonnet', displayName: 'Claude Sonnet' },
  { slug: 'opus', displayName: 'Claude Opus' },
  { slug: 'haiku', displayName: 'Claude Haiku' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function cloneConversation(conversation: ChatConversation): ChatConversation {
  return {
    accountId: conversation.accountId,
    messages: conversation.messages.map((message) => ({
      ...message,
      ...(message.usage ? { usage: { ...message.usage } } : {}),
    })),
    usage: { ...conversation.usage },
  };
}

function addUsage(a: ChatUsage, b: ChatUsage): ChatUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function resultUsage(message: Extract<SDKMessage, { type: 'result' }>): ChatUsage | undefined {
  if (!isRecord(message.modelUsage)) return undefined;
  let found = false;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const value of Object.values(message.modelUsage)) {
    if (!isRecord(value)) continue;
    found = true;
    // The SDK tracks cache reads and writes separately from ordinary input.
    inputTokens += nonnegativeInteger(value.inputTokens)
      + nonnegativeInteger(value.cacheReadInputTokens)
      + nonnegativeInteger(value.cacheCreationInputTokens);
    outputTokens += nonnegativeInteger(value.outputTokens);
  }
  if (!found) return undefined;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function classifyFailure(details: string): ChatServiceError {
  const text = details.toLowerCase();
  if (/authentication_failed|oauth_org_not_allowed|account_on_hold|verification_required|cloud_credential_error|not logged in|please log in|please run \/login|sign in again|unauthori[sz]ed|token.{0,20}expir|\b401\b/.test(text)) {
    return new ChatServiceError('auth', 'This Claude account needs to sign in again.', { status: 401 });
  }
  if (/rate.limit|usage.limit|quota|too many requests|overage|\b429\b|billing_error/.test(text)) {
    return new ChatServiceError('limit', 'This Claude account reached a usage or rate limit. Check Claude settings → Usage.', { status: 429 });
  }
  if (/max.output.tokens|error_max_turns|maximum turns/.test(text)) {
    return new ChatServiceError('incomplete', 'Claude stopped before completing the response.');
  }
  if (/overloaded|server_error|unavailable|\b503\b|\b529\b/.test(text)) {
    return new ChatServiceError('unavailable', 'Claude is temporarily unavailable. Try again later.');
  }
  if (/network|econn|enotfound|fetch failed|connect timeout/.test(text)) {
    return new ChatServiceError('network', 'The Claude request could not connect.');
  }
  if (/model_not_found|invalid_request/.test(text)) {
    return new ChatServiceError('api', 'Claude rejected this model or request. Select another model.');
  }
  return new ChatServiceError('api', 'Claude could not complete the response. Try again.');
}

function recentMessages(messages: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const recent: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let characters = 0;
  for (let index = messages.length - 1; index >= 0 && recent.length < MAX_HISTORY_MESSAGES; index -= 1) {
    const message = messages[index];
    if (recent.length && characters + message.content.length > MAX_HISTORY_CHARACTERS) break;
    recent.unshift({ role: message.role, content: message.content });
    characters += message.content.length;
  }
  return recent;
}

async function loadOfficialQuery(): Promise<QueryFactory> {
  // TypeScript emits CommonJS for Electron main; a direct import() would become
  // require(), which cannot load the SDK's ESM-only entry point.
  const sdkUrl = pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href;
  const importEsm = new Function('url', 'return import(url)') as
    (url: string) => Promise<typeof import('@anthropic-ai/claude-agent-sdk')>;
  return (await importEsm(sdkUrl)).query;
}

/**
 * Claude subscription chat through Anthropic's Agent SDK and a separate
 * Claude Code login per account. No web cookies, private endpoints, project
 * files, MCP servers, plugins, skills, or built-in tools are sent to Claude.
 */
export class ClaudeSubscriptionChatService {
  private readonly chatDir: string;
  private readonly workDir: string;
  private readonly queryFactory?: QueryFactory;
  private readonly binaryPath: () => string;
  private readonly activeAccounts = new Set<string>();
  private readonly pausedAccounts = new Set<string>();
  private readonly usageSnapshots = new Map<string, ClaudeSubscriptionUsageSnapshot>();

  constructor(options: ClaudeSubscriptionChatServiceOptions) {
    if (!options.dataDir || !path.isAbsolute(options.dataDir)) {
      throw new ChatServiceError('validation', 'An absolute data directory is required.');
    }
    this.chatDir = path.join(options.dataDir, 'claude-subscription-chat');
    this.workDir = path.join(options.dataDir, 'claude-subscription-workspaces');
    this.queryFactory = options.queryFactory;
    this.binaryPath = options.binaryPath ?? claudeCodeBinary;
  }

  listModels(): ChatModel[] {
    return MODELS.map((model) => ({ ...model }));
  }

  async getConversation(accountId: string): Promise<ChatConversation> {
    this.assertAccountId(accountId);
    let raw: string;
    try {
      raw = await readFile(this.conversationPath(accountId), 'utf8');
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return { accountId, messages: [], usage: { ...EMPTY_USAGE } };
      }
      throw new ChatServiceError('storage', 'Could not read local Claude chat history.');
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ChatServiceError('storage', 'Local Claude chat history is not valid JSON.');
    }
    if (!isRecord(value) || value.accountId !== accountId || !Array.isArray(value.messages) || !isRecord(value.usage)) {
      throw new ChatServiceError('storage', 'Local Claude chat history has an unexpected shape.');
    }
    const messages: ChatMessage[] = [];
    for (const item of value.messages) {
      if (!isRecord(item) || typeof item.id !== 'string'
        || (item.role !== 'user' && item.role !== 'assistant')
        || typeof item.content !== 'string' || typeof item.createdAt !== 'string') {
        throw new ChatServiceError('storage', 'Local Claude chat history contains an invalid message.');
      }
      messages.push({
        id: item.id,
        role: item.role,
        content: item.content,
        createdAt: item.createdAt,
        ...(typeof item.model === 'string' ? { model: item.model } : {}),
        ...(isRecord(item.usage) ? {
          usage: {
            inputTokens: nonnegativeInteger(item.usage.inputTokens),
            outputTokens: nonnegativeInteger(item.usage.outputTokens),
            totalTokens: nonnegativeInteger(item.usage.totalTokens),
          },
        } : {}),
      });
    }
    return cloneConversation({
      accountId,
      messages,
      usage: {
        inputTokens: nonnegativeInteger(value.usage.inputTokens),
        outputTokens: nonnegativeInteger(value.usage.outputTokens),
        totalTokens: nonnegativeInteger(value.usage.totalTokens),
      },
    });
  }

  async sendMessage(options: ClaudeSubscriptionSendOptions, onEvent?: (event: ChatEvent) => void): Promise<ChatMessage> {
    const { accountId, configDir, model, content, signal } = options;
    this.assertAccountId(accountId);
    if (typeof configDir !== 'string' || !path.isAbsolute(configDir)) {
      throw new ChatServiceError('validation', 'A Claude account configuration directory is required.');
    }
    if (!MODELS.some((item) => item.slug === model) || typeof content !== 'string' || !content.trim()) {
      throw new ChatServiceError('validation', 'Select a Claude model and enter a message.');
    }
    if (signal?.aborted) throw new ChatServiceError('interrupted', 'The response was cancelled.');
    if (this.pausedAccounts.has(accountId)) {
      throw new ChatServiceError('limit', 'This Claude account is paused after reaching a usage limit. Resume it after the limit resets.', { status: 429 });
    }
    if (this.activeAccounts.has(accountId)) {
      throw new ChatServiceError('validation', 'A response is already in progress for this account.');
    }
    this.activeAccounts.add(accountId);
    const abortController = new AbortController();
    let sdkQuery: ClaudeQuery | undefined;
    const closeQuery = (): void => {
      try { sdkQuery?.close(); } catch { /* Cancellation still wins if cleanup fails. */ }
    };
    const cancel = (): void => { abortController.abort(); closeQuery(); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const conversation = await this.getConversation(accountId);
      const userMessage: ChatMessage = {
        id: randomUUID(), role: 'user', content, createdAt: new Date().toISOString(),
      };
      const prompt = JSON.stringify({ messages: recentMessages([...conversation.messages, userMessage]) });
      const workDir = path.join(this.workDir, this.accountHash(accountId));
      await mkdir(workDir, { recursive: true });
      if (signal?.aborted) throw new ChatServiceError('interrupted', 'The response was cancelled.');

      const runQuery = this.queryFactory ?? await loadOfficialQuery();
      sdkQuery = runQuery({
        prompt,
        options: {
          abortController,
          cwd: workDir,
          env: claudeProcessEnv(configDir),
          pathToClaudeCodeExecutable: this.binaryPath(),
          model,
          tools: [],
          allowedTools: [],
          mcpServers: {},
          plugins: [],
          skills: [],
          settingSources: [],
          permissionMode: 'dontAsk',
          permissionPrompts: 'none',
          persistSession: false,
          includePartialMessages: true,
          verbatimPrompts: true,
          maxTurns: 1,
          systemPrompt: 'You are Claude in Switchboard, a general chat assistant. The user prompt is JSON with a messages array in chronological order. Continue the conversation by answering only the latest user message. Do not assume access to files, tools, or external accounts.',
        },
      });
      if (signal?.aborted) throw new ChatServiceError('interrupted', 'The response was cancelled.');

      let streamedText = '';
      let assistantText = '';
      let assistantError: string | undefined;
      let authenticationError: string | undefined;
      let result: Extract<SDKMessage, { type: 'result' }> | undefined;
      for await (const message of sdkQuery) {
        if (signal?.aborted) throw new ChatServiceError('interrupted', 'The response was cancelled.');
        if (message.type === 'stream_event' && message.parent_tool_use_id === null
          && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
          const delta = message.event.delta.text;
          if (delta) {
            streamedText += delta;
            this.emit(onEvent, { type: 'delta', accountId, delta });
          }
        } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          if (message.error) assistantError = message.error;
          for (const block of message.message.content) {
            if (block.type === 'text') assistantText += block.text;
          }
        } else if (message.type === 'auth_status' && message.error) {
          authenticationError = message.error;
        } else if (message.type === 'rate_limit_event') {
          this.captureRateLimit(accountId, message.rate_limit_info);
        } else if (message.type === 'result') {
          result = message;
        }
      }
      if (signal?.aborted) throw new ChatServiceError('interrupted', 'The response was cancelled.');
      if (assistantError) throw classifyFailure(assistantError);
      if (authenticationError) throw new ChatServiceError('auth', 'This Claude account needs to sign in again.', { status: 401 });
      if (!result) throw new ChatServiceError('interrupted', 'Claude stopped before completing the response.');
      if (result.subtype !== 'success' || result.is_error) {
        throw classifyFailure(result.subtype === 'success' ? 'unknown' : `${result.subtype} ${result.errors.join(' ')}`);
      }
      const text = result.result || assistantText;
      if (!text) throw new ChatServiceError('api', 'Claude returned an empty response.');
      if (text.startsWith(streamedText) && text.length > streamedText.length) {
        this.emit(onEvent, { type: 'delta', accountId, delta: text.slice(streamedText.length) });
      } else if (!streamedText) {
        this.emit(onEvent, { type: 'delta', accountId, delta: text });
      }
      const usage = resultUsage(result);
      const assistantMessage: ChatMessage = {
        id: randomUUID(), role: 'assistant', content: text, createdAt: new Date().toISOString(), model,
        ...(usage ? { usage } : {}),
      };
      conversation.messages.push(userMessage, assistantMessage);
      if (usage) conversation.usage = addUsage(conversation.usage, usage);
      await this.writeConversation(conversation);
      if (usage) this.emit(onEvent, { type: 'usage', accountId, usage, totalUsage: conversation.usage });
      this.emit(onEvent, { type: 'completed', accountId, message: assistantMessage });
      return assistantMessage;
    } catch (error) {
      if (signal?.aborted) throw new ChatServiceError('interrupted', 'The response was cancelled.');
      const safeError = error instanceof ChatServiceError
        ? error
        : classifyFailure(error instanceof Error ? error.message : String(error));
      if (safeError.kind === 'limit') this.pausedAccounts.add(accountId);
      throw safeError;
    } finally {
      signal?.removeEventListener('abort', cancel);
      closeQuery();
      this.activeAccounts.delete(accountId);
    }
  }

  async clearConversation(accountId: string): Promise<void> {
    this.assertAccountId(accountId);
    this.assertNotBusy(accountId);
    this.activeAccounts.add(accountId);
    try {
      const conversation = await this.getConversation(accountId);
      // Clearing visible history does not erase already consumed local usage.
      await this.writeConversation({ ...conversation, messages: [] });
    } finally {
      this.activeAccounts.delete(accountId);
    }
  }

  async deleteAccountData(accountId: string): Promise<void> {
    this.assertAccountId(accountId);
    this.assertNotBusy(accountId);
    this.activeAccounts.add(accountId);
    try {
      const workspace = path.resolve(this.workDir, this.accountHash(accountId));
      if (!workspace.startsWith(path.resolve(this.workDir) + path.sep)) {
        throw new ChatServiceError('storage', 'Could not remove local Claude workspace.');
      }
      await rm(workspace, { recursive: true, force: true });
      await unlink(this.conversationPath(accountId));
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') {
        throw new ChatServiceError('storage', 'Could not remove local Claude chat data.');
      }
    } finally {
      this.pausedAccounts.delete(accountId);
      this.usageSnapshots.delete(accountId);
      this.activeAccounts.delete(accountId);
    }
  }

  isBusy(accountId: string): boolean {
    this.assertAccountId(accountId);
    return this.activeAccounts.has(accountId);
  }

  isPaused(accountId: string): boolean {
    this.assertAccountId(accountId);
    return this.pausedAccounts.has(accountId);
  }

  getUsageSnapshot(accountId: string): ClaudeSubscriptionUsageSnapshot | null {
    this.assertAccountId(accountId);
    const value = this.usageSnapshots.get(accountId);
    if (!value) return null;
    return {
      observedAt: value.observedAt,
      windows: Object.fromEntries(Object.entries(value.windows).map(([key, window]) => [key, { ...window }])),
    };
  }

  resumeAccount(accountId: string): void {
    this.assertAccountId(accountId);
    this.pausedAccounts.delete(accountId);
  }

  private accountHash(accountId: string): string {
    return createHash('sha256').update(accountId).digest('hex');
  }

  private conversationPath(accountId: string): string {
    return path.join(this.chatDir, `${this.accountHash(accountId)}.json`);
  }

  private assertAccountId(accountId: string): void {
    if (typeof accountId !== 'string' || !accountId.trim()) {
      throw new ChatServiceError('validation', 'An account ID is required.');
    }
  }

  private captureRateLimit(accountId: string, info: SDKRateLimitInfo): void {
    if (!info || !['allowed', 'allowed_warning', 'rejected'].includes(info.status)) return;
    const kind = info.rateLimitType ?? 'general';
    const previous = this.usageSnapshots.get(accountId);
    this.usageSnapshots.set(accountId, {
      observedAt: new Date().toISOString(),
      windows: {
        ...previous?.windows,
        [kind]: {
          status: info.status,
          utilization: typeof info.utilization === 'number' && Number.isFinite(info.utilization)
            ? info.utilization : null,
          resetsAt: typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)
            ? info.resetsAt : null,
        },
      },
    });
  }

  private assertNotBusy(accountId: string): void {
    if (this.activeAccounts.has(accountId)) {
      throw new ChatServiceError('validation', 'Wait for the current response before changing this account.');
    }
  }

  private async writeConversation(conversation: ChatConversation): Promise<void> {
    const destination = this.conversationPath(conversation.accountId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.chatDir, { recursive: true });
      await writeFile(temporary, JSON.stringify(cloneConversation(conversation)), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, destination);
    } catch {
      throw new ChatServiceError('storage', 'Could not save local Claude chat history.');
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private emit(onEvent: ((event: ChatEvent) => void) | undefined, event: ChatEvent): void {
    try {
      onEvent?.(event);
    } catch {
      // A closed renderer must not cancel an otherwise successful response.
    }
  }
}
