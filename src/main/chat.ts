import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Usage reported by completed Responses requests made in this app. This is not plan balance. */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatModel {
  slug: string;
  displayName: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  model?: string;
  usage?: ChatUsage;
}

export interface ChatConversation {
  accountId: string;
  messages: ChatMessage[];
  usage: ChatUsage;
}

export type ChatEvent =
  | { type: 'delta'; accountId: string; delta: string }
  | { type: 'completed'; accountId: string; message: ChatMessage }
  | { type: 'usage'; accountId: string; usage: ChatUsage; totalUsage: ChatUsage };

export type ChatErrorKind =
  | 'auth'
  | 'limit'
  | 'unavailable'
  | 'api'
  | 'interrupted'
  | 'incomplete'
  | 'network'
  | 'storage'
  | 'validation';

export class ChatServiceError extends Error {
  readonly kind: ChatErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly param?: string;
  readonly requestId?: string;

  constructor(
    kind: ChatErrorKind,
    message: string,
    details: { status?: number; code?: string; param?: string; requestId?: string } = {},
  ) {
    super(message);
    this.name = 'ChatServiceError';
    this.kind = kind;
    this.status = details.status;
    this.code = details.code;
    this.param = details.param;
    this.requestId = details.requestId;
  }
}

export interface SendMessageOptions {
  accountId: string;
  accessToken: string;
  model: string;
  content: string;
  signal?: AbortSignal;
}

export interface ChatServiceOptions {
  /** Electron app.getPath('userData') is a suitable parent directory. */
  dataDir: string;
  fetch?: typeof fetch;
  /** Useful for isolated tests; production should use the default OpenAI endpoint. */
  apiBaseUrl?: string;
}

type ResponseError = { code?: string; message?: string; param?: string };
type JsonRecord = Record<string, unknown>;

const EMPTY_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const MAX_SSE_LINE_LENGTH = 1_000_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function parseUsage(value: unknown): ChatUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = nonnegativeInteger(value.input_tokens);
  const outputTokens = nonnegativeInteger(value.output_tokens);
  const totalTokens = nonnegativeInteger(value.total_tokens);
  if (!('input_tokens' in value) && !('output_tokens' in value) && !('total_tokens' in value)) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
  };
}

function addUsage(a: ChatUsage, b: ChatUsage): ChatUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function responseError(value: unknown): ResponseError {
  if (!isRecord(value)) return {};
  const error = isRecord(value.error) ? value.error : value;
  return {
    code: typeof error.code === 'string' ? error.code : undefined,
    message: typeof error.message === 'string' ? error.message : undefined,
    param: typeof error.param === 'string' ? error.param : undefined,
  };
}

function errorKind(status: number | undefined, code: string | undefined): ChatErrorKind {
  if (code === 'subscription_sharing_usage_limit_exceeded') return 'limit';
  if (status === 401 || code === 'subscription_sharing_invalid_user') return 'auth';
  if (status === 503 || code === 'subscription_sharing_usage_unavailable') return 'unavailable';
  return 'api';
}

function safeMessage(value: string | undefined, accessToken: string): string | undefined {
  // API error text is useful for a bad model or unsupported input, but must not leak a credential.
  return value?.replaceAll(accessToken, '[redacted]').slice(0, 500);
}

function extractOutputText(response: unknown): string | undefined {
  if (!isRecord(response) || !Array.isArray(response.output)) return undefined;
  const parts: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
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
        if (line === '') {
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

export class ChatService {
  private readonly chatDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly activeAccounts = new Set<string>();
  private readonly pausedAccounts = new Set<string>();

  constructor(options: ChatServiceOptions) {
    if (!options.dataDir) throw new ChatServiceError('validation', 'A data directory is required.');
    this.chatDir = join(options.dataDir, 'chat');
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  async listModels(accessToken: string, signal?: AbortSignal): Promise<ChatModel[]> {
    if (!accessToken) throw new ChatServiceError('validation', 'An access token is required.');
    const response = await this.request(`${this.apiBaseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    }, accessToken);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ChatServiceError('api', 'The model catalog was not valid JSON.', {
        status: response.status,
        requestId: response.headers.get('x-request-id') ?? undefined,
      });
    }
    if (!isRecord(payload) || !Array.isArray(payload.models)) {
      throw new ChatServiceError('api', 'The model catalog had an unexpected shape.', {
        status: response.status,
        requestId: response.headers.get('x-request-id') ?? undefined,
      });
    }
    return payload.models.flatMap((model): ChatModel[] =>
      isRecord(model) && model.visibility === 'list'
        && typeof model.slug === 'string' && typeof model.display_name === 'string'
        ? [{ slug: model.slug, displayName: model.display_name }]
        : [],
    );
  }

  async getConversation(accountId: string): Promise<ChatConversation> {
    this.assertAccountId(accountId);
    const path = this.conversationPath(accountId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return { accountId, messages: [], usage: { ...EMPTY_USAGE } };
      }
      throw new ChatServiceError('storage', 'Could not read local chat history.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ChatServiceError('storage', 'Local chat history is not valid JSON.');
    }
    if (!isRecord(parsed) || parsed.accountId !== accountId || !Array.isArray(parsed.messages)
      || !isRecord(parsed.usage)) {
      throw new ChatServiceError('storage', 'Local chat history has an unexpected shape.');
    }
    const messages: ChatMessage[] = [];
    for (const value of parsed.messages) {
      if (!isRecord(value) || typeof value.id !== 'string'
        || (value.role !== 'user' && value.role !== 'assistant')
        || typeof value.content !== 'string' || typeof value.createdAt !== 'string') {
        throw new ChatServiceError('storage', 'Local chat history contains an invalid message.');
      }
      const message: ChatMessage = {
        id: value.id,
        role: value.role,
        content: value.content,
        createdAt: value.createdAt,
      };
      if (typeof value.model === 'string') message.model = value.model;
      if (isRecord(value.usage)) {
        message.usage = {
          inputTokens: nonnegativeInteger(value.usage.inputTokens),
          outputTokens: nonnegativeInteger(value.usage.outputTokens),
          totalTokens: nonnegativeInteger(value.usage.totalTokens),
        };
      }
      messages.push(message);
    }
    return {
      accountId,
      messages,
      usage: {
        inputTokens: nonnegativeInteger(parsed.usage.inputTokens),
        outputTokens: nonnegativeInteger(parsed.usage.outputTokens),
        totalTokens: nonnegativeInteger(parsed.usage.totalTokens),
      },
    };
  }

  async sendMessage(options: SendMessageOptions, onEvent?: (event: ChatEvent) => void): Promise<ChatMessage> {
    const { accountId, accessToken, model, content, signal } = options;
    this.assertAccountId(accountId);
    if (!accessToken || !model?.trim() || !content?.trim()) {
      throw new ChatServiceError('validation', 'Account, access token, model, and message are required.');
    }
    if (this.pausedAccounts.has(accountId)) {
      throw new ChatServiceError('limit', 'This account is paused after reaching a usage limit.', {
        status: 429,
        code: 'subscription_sharing_usage_limit_exceeded',
      });
    }
    if (this.activeAccounts.has(accountId)) {
      throw new ChatServiceError('validation', 'A response is already in progress for this account.');
    }
    this.activeAccounts.add(accountId);
    try {
      const conversation = await this.getConversation(accountId);
      const requestMessage: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
      };
      const input = [...conversation.messages, requestMessage].map(({ role, content: text }) => ({
        role,
        content: text,
      }));
      const response = await this.request(`${this.apiBaseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ model, input, store: false, stream: true }),
        signal,
      }, accessToken);
      if (!response.body) {
        throw new ChatServiceError('interrupted', 'The response stream was empty.', {
          status: response.status,
          requestId: response.headers.get('x-request-id') ?? undefined,
        });
      }
      let text = '';
      let completed = false;
      let usage: ChatUsage | undefined;
      for await (const data of sseData(response.body)) {
        if (data === '[DONE]') continue;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          throw new ChatServiceError('interrupted', 'The response stream contained invalid JSON.', {
            status: response.status,
            requestId: response.headers.get('x-request-id') ?? undefined,
          });
        }
        if (!isRecord(event)) continue;
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          text += event.delta;
          this.emit(onEvent, { type: 'delta', accountId, delta: event.delta });
        } else if (event.type === 'response.completed') {
          completed = true;
          const finalText = extractOutputText(event.response);
          if (finalText !== undefined) text = finalText;
          usage = isRecord(event.response) ? parseUsage(event.response.usage) : undefined;
        } else if (event.type === 'response.failed') {
          const apiError = responseError(isRecord(event.response) ? event.response.error : event.error);
          throw this.toServiceError(apiError, response.status, accessToken, response.headers.get('x-request-id') ?? undefined);
        } else if (event.type === 'response.incomplete') {
          throw new ChatServiceError('incomplete', 'The model did not complete its response.', {
            status: response.status,
            requestId: response.headers.get('x-request-id') ?? undefined,
          });
        } else if (event.type === 'error') {
          const apiError = responseError(event.error ?? event);
          throw this.toServiceError(apiError, response.status, accessToken, response.headers.get('x-request-id') ?? undefined);
        }
      }
      if (!completed) {
        throw new ChatServiceError('interrupted', 'The response stream ended before completion.', {
          status: response.status,
          requestId: response.headers.get('x-request-id') ?? undefined,
        });
      }
      const assistantMessage: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: text,
        createdAt: new Date().toISOString(),
        model,
        ...(usage ? { usage } : {}),
      };
      conversation.messages.push(requestMessage, assistantMessage);
      if (usage) conversation.usage = addUsage(conversation.usage, usage);
      await this.writeConversation(conversation);
      if (usage) this.emit(onEvent, { type: 'usage', accountId, usage, totalUsage: conversation.usage });
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
    if (this.activeAccounts.has(accountId)) {
      throw new ChatServiceError('validation', 'Wait for the current response before clearing chat history.');
    }
    this.activeAccounts.add(accountId);
    try {
      const conversation = await this.getConversation(accountId);
      // Clearing visible history must not erase already consumed local usage.
      await this.writeConversation({ ...conversation, messages: [] });
    } finally {
      this.activeAccounts.delete(accountId);
    }
  }

  async deleteAccountData(accountId: string): Promise<void> {
    this.assertAccountId(accountId);
    if (this.activeAccounts.has(accountId)) {
      throw new ChatServiceError('validation', 'Wait for the current response before removing account data.');
    }
    this.activeAccounts.add(accountId);
    try {
      await unlink(this.conversationPath(accountId));
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') {
        throw new ChatServiceError('storage', 'Could not remove local account chat data.');
      }
    } finally {
      this.pausedAccounts.delete(accountId);
      this.activeAccounts.delete(accountId);
    }
  }

  isPaused(accountId: string): boolean {
    return this.pausedAccounts.has(accountId);
  }

  isBusy(accountId: string): boolean {
    this.assertAccountId(accountId);
    return this.activeAccounts.has(accountId);
  }

  resumeAccount(accountId: string): void {
    this.assertAccountId(accountId);
    this.pausedAccounts.delete(accountId);
  }

  private assertAccountId(accountId: string): void {
    if (typeof accountId !== 'string' || !accountId.trim()) {
      throw new ChatServiceError('validation', 'An account ID is required.');
    }
  }

  private conversationPath(accountId: string): string {
    // Hashing keeps untrusted account IDs from becoming paths or Windows-reserved filenames.
    return join(this.chatDir, `${createHash('sha256').update(accountId).digest('hex')}.json`);
  }

  private async writeConversation(conversation: ChatConversation): Promise<void> {
    const path = this.conversationPath(conversation.accountId);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.chatDir, { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(cloneConversation(conversation)), { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, path);
    } catch {
      throw new ChatServiceError('storage', 'Could not save local chat history.');
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async request(url: string, init: RequestInit, accessToken: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch {
      if (init.signal?.aborted) throw new ChatServiceError('interrupted', 'The request was cancelled.');
      throw new ChatServiceError('network', 'The request could not reach OpenAI.');
    }
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = JSON.parse(await response.text());
      } catch {
        payload = undefined;
      }
      const apiError = responseError(payload);
      if (!apiError.message && isRecord(payload) && typeof payload.detail === 'string') {
        apiError.message = payload.detail;
      }
      throw this.toServiceError(apiError, response.status, accessToken, response.headers.get('x-request-id') ?? undefined);
    }
    return response;
  }

  private toServiceError(
    error: ResponseError,
    status: number | undefined,
    accessToken: string,
    requestId: string | undefined,
  ): ChatServiceError {
    const kind = errorKind(status, error.code);
    const defaultMessage = kind === 'limit'
      ? 'This account reached a ChatGPT plan usage limit. Check ChatGPT settings → Usage.'
      : kind === 'auth'
        ? 'This account needs to sign in again or grant permission.'
        : kind === 'unavailable'
          ? 'ChatGPT plan usage is temporarily unavailable. Try again later.'
          : 'The model request failed.';
    return new ChatServiceError(kind, safeMessage(error.message, accessToken) ?? defaultMessage, {
      status,
      code: error.code,
      param: error.param,
      requestId,
    });
  }

  private emit(onEvent: ((event: ChatEvent) => void) | undefined, event: ChatEvent): void {
    try {
      onEvent?.(event);
    } catch {
      // A closed renderer must not cancel an otherwise successful response.
    }
  }
}
