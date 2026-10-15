import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ChatServiceError,
  type ChatConversation,
  type ChatEvent,
  type ChatMessage,
  type ChatModel,
  type ChatUsage,
} from './chat';

export type ApiProvider = 'claude_api' | 'antigravity_api';

export interface ApiListModelsOptions {
  provider: ApiProvider;
  apiKey: string;
  workspaceId?: string;
  signal?: AbortSignal;
}

export interface ApiSendMessageOptions extends ApiListModelsOptions {
  accountId: string;
  model: string;
  content: string;
}

export interface ApiChatServiceOptions {
  /** Electron app.getPath('userData') is a suitable parent directory. */
  dataDir: string;
  fetch?: typeof fetch;
  /** For tests only; production uses the official provider endpoints. */
  claudeBaseUrl?: string;
  geminiBaseUrl?: string;
}

export interface RateLimitSnapshot {
  /** Rounded by Anthropic to the nearest thousand; not a plan or credit balance. */
  remainingTokens: number | null;
  resetsAt: string | null;
}

export const ANTIGRAVITY_AGENT_ID = 'antigravity-preview-09-2026';

interface StoredConversation extends ChatConversation {
  provider: ApiProvider;
  previousInteractionId?: string;
  environmentId?: string;
}

interface ProviderResult {
  text: string;
  usage?: ChatUsage;
  previousInteractionId?: string;
  environmentId?: string;
}

type JsonRecord = Record<string, unknown>;

const EMPTY_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const MAX_SSE_LINE_LENGTH = 1_000_000;
const MAX_HISTORY_MESSAGES = 80;

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : undefined;
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

function parseClaudeUsage(startUsage: unknown, endUsage: unknown): ChatUsage | undefined {
  if (!record(startUsage) && !record(endUsage)) return undefined;
  const first = record(startUsage) ? startUsage : {};
  const last = record(endUsage) ? endUsage : {};
  // Anthropic counts cache reads/writes separately from ordinary input_tokens.
  const inputTokens = nonnegativeInteger(first.input_tokens)
    + nonnegativeInteger(first.cache_creation_input_tokens)
    + nonnegativeInteger(first.cache_read_input_tokens);
  const outputTokens = nonnegativeInteger(last.output_tokens ?? first.output_tokens);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function parseGeminiUsage(value: unknown): ChatUsage | undefined {
  if (!record(value)) return undefined;
  if (!('total_input_tokens' in value) && !('total_output_tokens' in value)
    && !('total_tokens' in value)) return undefined;
  const inputTokens = nonnegativeInteger(value.total_input_tokens);
  const outputTokens = nonnegativeInteger(value.total_output_tokens);
  // Agent interactions also consume thought and tool tokens. Keep the API total.
  const totalTokens = nonnegativeInteger(value.total_tokens) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function extractGeminiText(value: JsonRecord): string | undefined {
  if (typeof value.output_text === 'string') return value.output_text;
  if (!Array.isArray(value.steps)) return undefined;
  const parts: string[] = [];
  for (const step of value.steps) {
    if (!record(step) || step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const content of step.content) {
      if (record(content) && content.type === 'text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  return parts.length ? parts.join('') : undefined;
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let dataLines: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length > MAX_SSE_LINE_LENGTH && !pending.includes('\n')) {
        throw new ChatServiceError('interrupted', 'The response stream contained an oversized event.');
      }
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (!line) {
          if (dataLines.length) yield dataLines.join('\n');
          dataLines = [];
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        newline = pending.indexOf('\n');
      }
      if (done) {
        if (pending.startsWith('data:')) dataLines.push(pending.slice(5).replace(/^ /, ''));
        if (dataLines.length) yield dataLines.join('\n');
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * API-key connections use provider APIs, never Claude.ai or personal Antigravity
 * web sessions. Antigravity's `remote` environment is Google's Linux sandbox;
 * this service does not mount or send local Windows files. Google stores
 * interaction state so `previous_interaction_id` can provide coherent turns.
 */
export class ApiChatService {
  private readonly chatDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly claudeBaseUrl: string;
  private readonly geminiBaseUrl: string;
  private readonly activeAccounts = new Set<string>();
  private readonly pausedAccounts = new Set<string>();
  private readonly claudeRateLimits = new Map<string, RateLimitSnapshot>();

  constructor(options: ApiChatServiceOptions) {
    if (!options.dataDir) throw new ChatServiceError('validation', 'A data directory is required.');
    this.chatDir = join(options.dataDir, 'api-chat');
    this.fetchImpl = options.fetch ?? fetch;
    this.claudeBaseUrl = (options.claudeBaseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
    this.geminiBaseUrl = (options.geminiBaseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  }

  async listModels(options: ApiListModelsOptions): Promise<ChatModel[]> {
    this.assertProviderAndKey(options.provider, options.apiKey);
    if (options.provider === 'claude_api') {
      const response = await this.request(
        `${this.claudeBaseUrl}/models?limit=100`,
        { method: 'GET', headers: this.claudeHeaders(options.apiKey, options.workspaceId), signal: options.signal },
        options.provider,
        options.apiKey,
      );
      const payload = await this.readJson(response, options.provider);
      if (!record(payload) || !Array.isArray(payload.data)) {
        throw new ChatServiceError('api', 'Claude returned an invalid model catalog.');
      }
      return payload.data.flatMap((model): ChatModel[] =>
        record(model) && typeof model.id === 'string'
          ? [{ slug: model.id, displayName: typeof model.display_name === 'string' ? model.display_name : model.id }]
          : [],
      );
    }

    // The Gemini model catalog call verifies the key. The managed Antigravity
    // agent is selected by its agent ID, not by a Gemini model ID.
    await this.request(
      `${this.geminiBaseUrl}/models?pageSize=1`,
      { method: 'GET', headers: { 'x-goog-api-key': options.apiKey }, signal: options.signal },
      options.provider,
      options.apiKey,
    );
    return [{ slug: ANTIGRAVITY_AGENT_ID, displayName: 'Antigravity agent (Gemini API)' }];
  }

  async getConversation(accountId: string): Promise<ChatConversation> {
    return cloneConversation(await this.readConversation(accountId));
  }

  async sendMessage(options: ApiSendMessageOptions, onEvent?: (event: ChatEvent) => void): Promise<ChatMessage> {
    const { accountId, provider, apiKey, model, content, signal } = options;
    this.assertAccountId(accountId);
    this.assertProviderAndKey(provider, apiKey);
    if (typeof model !== 'string' || !model.trim() || typeof content !== 'string' || !content.trim()) {
      throw new ChatServiceError('validation', 'A model and message are required.');
    }
    if (provider === 'antigravity_api' && model !== ANTIGRAVITY_AGENT_ID) {
      throw new ChatServiceError('validation', 'Select the supported Antigravity agent.');
    }
    if (this.pausedAccounts.has(accountId)) {
      throw new ChatServiceError('limit', 'This connection is paused after a provider limit. Resume it after the limit resets.', { status: 429 });
    }
    if (this.activeAccounts.has(accountId)) {
      throw new ChatServiceError('validation', 'A response is already in progress for this connection.');
    }
    this.activeAccounts.add(accountId);
    try {
      const conversation = await this.readConversation(accountId, provider);
      const userMessage: ChatMessage = {
        id: randomUUID(), role: 'user', content, createdAt: new Date().toISOString(),
      };
      const result: ProviderResult = provider === 'claude_api'
        ? await this.sendClaude(options, conversation, userMessage, onEvent)
        : await this.sendAntigravity(options, conversation, userMessage, onEvent);
      const assistantMessage: ChatMessage = {
        id: randomUUID(), role: 'assistant', content: result.text,
        createdAt: new Date().toISOString(), model,
        ...(result.usage ? { usage: result.usage } : {}),
      };
      conversation.messages.push(userMessage, assistantMessage);
      if (result.usage) conversation.usage = addUsage(conversation.usage, result.usage);
      if (result.previousInteractionId) conversation.previousInteractionId = result.previousInteractionId;
      if (result.environmentId) conversation.environmentId = result.environmentId;
      await this.writeConversation(conversation);
      if (result.usage) {
        this.emit(onEvent, { type: 'usage', accountId, usage: result.usage, totalUsage: conversation.usage });
      }
      this.emit(onEvent, { type: 'completed', accountId, message: assistantMessage });
      return assistantMessage;
    } catch (error) {
      if (error instanceof ChatServiceError && error.kind === 'limit') this.pausedAccounts.add(accountId);
      if (signal?.aborted && !(error instanceof ChatServiceError)) {
        throw new ChatServiceError('interrupted', 'The response was cancelled.');
      }
      throw error;
    } finally {
      this.activeAccounts.delete(accountId);
    }
  }

  async clearConversation(accountId: string): Promise<void> {
    this.assertAccountId(accountId);
    this.assertNotBusy(accountId);
    this.activeAccounts.add(accountId);
    try {
      try {
        await stat(this.conversationPath(accountId));
      } catch (error) {
        if (record(error) && error.code === 'ENOENT') return;
        throw new ChatServiceError('storage', 'Could not read local connection history.');
      }
      const conversation = await this.readConversation(accountId);
      await this.writeConversation({ ...conversation, messages: [], previousInteractionId: undefined, environmentId: undefined });
    } finally {
      this.activeAccounts.delete(accountId);
    }
  }

  async deleteAccountData(accountId: string): Promise<void> {
    this.assertAccountId(accountId);
    this.assertNotBusy(accountId);
    this.activeAccounts.add(accountId);
    try {
      await unlink(this.conversationPath(accountId));
    } catch (error) {
      if (!record(error) || error.code !== 'ENOENT') {
        throw new ChatServiceError('storage', 'Could not remove local connection data.');
      }
    } finally {
      this.pausedAccounts.delete(accountId);
      this.claudeRateLimits.delete(accountId);
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

  resumeAccount(accountId: string): void {
    this.assertAccountId(accountId);
    this.pausedAccounts.delete(accountId);
  }

  getRateLimit(accountId: string): RateLimitSnapshot | null {
    this.assertAccountId(accountId);
    const snapshot = this.claudeRateLimits.get(accountId);
    return snapshot ? { ...snapshot } : null;
  }

  private async sendClaude(
    options: ApiSendMessageOptions,
    conversation: StoredConversation,
    userMessage: ChatMessage,
    onEvent?: (event: ChatEvent) => void,
  ): Promise<{ text: string; usage?: ChatUsage }> {
    const { accountId, apiKey, model, workspaceId, signal } = options;
    const messages = [...conversation.messages, userMessage]
      .slice(-MAX_HISTORY_MESSAGES)
      .map(({ role, content }) => ({ role, content }));
    const response = await this.request(
      `${this.claudeBaseUrl}/messages`,
      {
        method: 'POST',
        headers: { ...this.claudeHeaders(apiKey, workspaceId), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model, max_tokens: 2048, messages, stream: true }),
        signal,
      },
      'claude_api',
      apiKey,
      accountId,
    );
    if (!response.body) throw new ChatServiceError('interrupted', 'Claude returned an empty response stream.');
    let text = '';
    let startUsage: unknown;
    let endUsage: unknown;
    let stopped = false;
    let stopReason: string | undefined;
    try {
      for await (const data of sseData(response.body)) {
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          throw new ChatServiceError('interrupted', 'Claude returned an invalid response event.');
        }
        if (!record(event)) continue;
        if (event.type === 'message_start' && record(event.message)) {
          startUsage = event.message.usage;
        } else if (event.type === 'content_block_start' && record(event.content_block)
          && event.content_block.type === 'text' && typeof event.content_block.text === 'string') {
          if (event.content_block.text) {
            text += event.content_block.text;
            this.emit(onEvent, { type: 'delta', accountId, delta: event.content_block.text });
          }
        } else if (event.type === 'content_block_delta' && record(event.delta)
          && event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
          if (event.delta.text) {
            text += event.delta.text;
            this.emit(onEvent, { type: 'delta', accountId, delta: event.delta.text });
          }
        } else if (event.type === 'message_delta') {
          endUsage = event.usage;
          if (record(event.delta) && typeof event.delta.stop_reason === 'string') stopReason = event.delta.stop_reason;
        } else if (event.type === 'message_stop') {
          stopped = true;
        } else if (event.type === 'error') {
          throw this.providerError('claude_api', 500, event.error);
        }
      }
    } catch (error) {
      if (error instanceof ChatServiceError) throw error;
      throw new ChatServiceError('interrupted', signal?.aborted
        ? 'The response was cancelled.' : 'Claude response streaming was interrupted.');
    }
    if (!stopped) throw new ChatServiceError('interrupted', 'Claude stopped before completing the response.');
    if (stopReason === 'max_tokens') throw new ChatServiceError('incomplete', 'Claude reached the response token limit.');
    return { text, usage: parseClaudeUsage(startUsage, endUsage) };
  }

  private async sendAntigravity(
    options: ApiSendMessageOptions,
    conversation: StoredConversation,
    userMessage: ChatMessage,
    onEvent?: (event: ChatEvent) => void,
  ): Promise<{ text: string; usage?: ChatUsage; previousInteractionId?: string; environmentId?: string }> {
    const { accountId, apiKey, model, signal } = options;
    const response = await this.request(
      `${this.geminiBaseUrl}/interactions`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: model,
          input: userMessage.content,
          // Google needs stored interactions for previous_interaction_id follow-ups.
          store: true,
          environment: conversation.environmentId ?? 'remote',
          ...(conversation.previousInteractionId ? { previous_interaction_id: conversation.previousInteractionId } : {}),
          agent_config: { type: 'antigravity', max_total_tokens: 50000 },
        }),
        signal,
      },
      'antigravity_api',
      apiKey,
      accountId,
    );
    const payload = await this.readJson(response, 'antigravity_api');
    if (!record(payload)) throw new ChatServiceError('api', 'The Antigravity agent returned invalid JSON.');
    if (payload.status === 'incomplete' || payload.status === 'budget_exceeded') {
      throw new ChatServiceError('incomplete', 'The Antigravity agent reached its interaction budget.');
    }
    if (payload.status !== 'completed') {
      throw new ChatServiceError('api', 'The Antigravity agent did not complete its response.');
    }
    const text = extractGeminiText(payload);
    if (text === undefined) throw new ChatServiceError('api', 'The Antigravity agent returned no text response.');
    this.emit(onEvent, { type: 'delta', accountId, delta: text });
    return {
      text,
      usage: parseGeminiUsage(payload.usage),
      previousInteractionId: typeof payload.id === 'string' ? payload.id : undefined,
      environmentId: typeof payload.environment_id === 'string' ? payload.environment_id : undefined,
    };
  }

  private async readConversation(accountId: string, provider?: ApiProvider): Promise<StoredConversation> {
    this.assertAccountId(accountId);
    let raw: string;
    try {
      raw = await readFile(this.conversationPath(accountId), 'utf8');
    } catch (error) {
      if (record(error) && error.code === 'ENOENT') {
        return { accountId, provider: provider ?? 'claude_api', messages: [], usage: { ...EMPTY_USAGE } };
      }
      throw new ChatServiceError('storage', 'Could not read local connection history.');
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ChatServiceError('storage', 'Local connection history is not valid JSON.');
    }
    if (!record(value) || value.accountId !== accountId
      || (value.provider !== 'claude_api' && value.provider !== 'antigravity_api')
      || (provider && value.provider !== provider)
      || !Array.isArray(value.messages) || !record(value.usage)) {
      throw new ChatServiceError('storage', 'Local connection history has an unexpected shape.');
    }
    const messages: ChatMessage[] = [];
    for (const item of value.messages) {
      if (!record(item) || typeof item.id !== 'string'
        || (item.role !== 'user' && item.role !== 'assistant')
        || typeof item.content !== 'string' || typeof item.createdAt !== 'string') {
        throw new ChatServiceError('storage', 'Local connection history contains an invalid message.');
      }
      messages.push({
        id: item.id, role: item.role, content: item.content, createdAt: item.createdAt,
        ...(typeof item.model === 'string' ? { model: item.model } : {}),
        ...(record(item.usage) ? {
          usage: {
            inputTokens: nonnegativeInteger(item.usage.inputTokens),
            outputTokens: nonnegativeInteger(item.usage.outputTokens),
            totalTokens: nonnegativeInteger(item.usage.totalTokens),
          },
        } : {}),
      });
    }
    return {
      accountId,
      provider: value.provider,
      messages,
      usage: {
        inputTokens: nonnegativeInteger(value.usage.inputTokens),
        outputTokens: nonnegativeInteger(value.usage.outputTokens),
        totalTokens: nonnegativeInteger(value.usage.totalTokens),
      },
      ...(typeof value.previousInteractionId === 'string' ? { previousInteractionId: value.previousInteractionId } : {}),
      ...(typeof value.environmentId === 'string' ? { environmentId: value.environmentId } : {}),
    };
  }

  private async writeConversation(conversation: StoredConversation): Promise<void> {
    const path = this.conversationPath(conversation.accountId);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.chatDir, { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(conversation), { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, path);
    } catch {
      throw new ChatServiceError('storage', 'Could not save local connection history.');
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private conversationPath(accountId: string): string {
    return join(this.chatDir, `${createHash('sha256').update(accountId).digest('hex')}.json`);
  }

  private claudeHeaders(apiKey: string, workspaceId?: string): Record<string, string> {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}),
    };
  }

  private async request(
    url: string,
    init: RequestInit,
    provider: ApiProvider,
    apiKey: string,
    accountId?: string,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch {
      if (init.signal?.aborted) throw new ChatServiceError('interrupted', 'The request was cancelled.');
      throw new ChatServiceError('network', 'The provider request could not connect.');
    }
    if (provider === 'claude_api' && accountId) this.captureClaudeRateLimit(accountId, response.headers);
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      throw this.providerError(provider, response.status, payload, apiKey, response.headers);
    }
    return response;
  }

  private async readJson(response: Response, provider: ApiProvider): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new ChatServiceError('api', `${provider === 'claude_api' ? 'Claude' : 'The Antigravity agent'} returned invalid JSON.`);
    }
  }

  private providerError(
    provider: ApiProvider,
    status: number,
    payload: unknown,
    _apiKey?: string,
    headers?: Headers,
  ): ChatServiceError {
    const detail = record(payload) && record(payload.error) ? payload.error : payload;
    const code = record(detail) ? safeCode(detail.code ?? detail.type ?? detail.status) : undefined;
    const kind = status === 401 || status === 403 || code === 'authentication_error' || code === 'permission_error'
      ? 'auth'
      : status === 429 || code === 'rate_limit_error' || code === 'quota_exceeded' || code === 'rate_limit_exceeded'
        ? 'limit'
        : status === 503 || status === 529 || code === 'overloaded_error'
          ? 'unavailable'
          : 'api';
    const label = provider === 'claude_api' ? 'Claude API' : 'Gemini API';
    const message = kind === 'auth'
      ? `${label} rejected this credential or workspace. Check the connection.`
      : kind === 'limit'
        ? `${label} reported a usage or rate limit. This connection is paused until you resume it.`
        : kind === 'unavailable'
          ? `${label} is temporarily unavailable. Try again later.`
          : `${label} request failed.`;
    return new ChatServiceError(kind, message, {
      status,
      code,
      requestId: headers?.get(provider === 'claude_api' ? 'request-id' : 'x-request-id')?.slice(0, 100) ?? undefined,
    });
  }

  private captureClaudeRateLimit(accountId: string, headers: Headers): void {
    const rawRemaining = headers.get('anthropic-ratelimit-tokens-remaining');
    const numeric = rawRemaining === null ? NaN : Number(rawRemaining);
    const remainingTokens = Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
    const rawReset = headers.get('anthropic-ratelimit-tokens-reset');
    const resetsAt = rawReset && Number.isFinite(Date.parse(rawReset)) ? new Date(rawReset).toISOString() : null;
    if (remainingTokens !== null || resetsAt !== null) {
      this.claudeRateLimits.set(accountId, { remainingTokens, resetsAt });
    }
  }

  private assertAccountId(accountId: string): void {
    if (typeof accountId !== 'string' || !accountId.trim()) {
      throw new ChatServiceError('validation', 'A connection ID is required.');
    }
  }

  private assertProviderAndKey(provider: ApiProvider, apiKey: string): void {
    if (provider !== 'claude_api' && provider !== 'antigravity_api') {
      throw new ChatServiceError('validation', 'Select a supported provider.');
    }
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new ChatServiceError('validation', 'An API key is required.');
    }
  }

  private assertNotBusy(accountId: string): void {
    if (this.activeAccounts.has(accountId)) {
      throw new ChatServiceError('validation', 'Wait for the current response before changing this connection.');
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
