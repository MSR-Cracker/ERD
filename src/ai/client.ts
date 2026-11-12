import { schemaPatchSchema } from '../model/patch';
import type { SchemaModel, SchemaPatch } from '../model/types';
import type { AIProgress } from './types';

export type { AIProgress };

export const DEFAULT_CLIENT_GEMINI_MODEL = 'gemini-3.8-flash';

export class AIRequestError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = 'AIRequestError';
  }
}

export interface AIClientOptions {
  signal?: AbortSignal;
  onProgress?: (progress: AIProgress) => void;
  apiKey?: string;
  model?: string;
}

export interface ParseProposalInput {
  source: string;
  currentSchema: SchemaModel;
  partialModel?: SchemaModel;
  parserDiagnostics?: Array<{ severity: string; message: string; line?: number }>;
  detectedFormat?: string;
  privacyAcknowledged: true;
}

export interface EditProposalInput {
  instruction: string;
  schema: SchemaModel;
  privacyAcknowledged: true;
}

export function getStoredAIConfig(): { apiKey: string; model: string } {
  try {
    if (typeof localStorage === 'undefined') return { apiKey: '', model: DEFAULT_CLIENT_GEMINI_MODEL };
    return {
      apiKey: localStorage.getItem('erdforge-gemini-key')?.trim() ?? '',
      model: localStorage.getItem('erdforge-gemini-model')?.trim() || DEFAULT_CLIENT_GEMINI_MODEL,
    };
  } catch {
    return { apiKey: '', model: DEFAULT_CLIENT_GEMINI_MODEL };
  }
}

export function saveStoredAIConfig(apiKey: string, model: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (apiKey.trim()) localStorage.setItem('erdforge-gemini-key', apiKey.trim());
    else localStorage.removeItem('erdforge-gemini-key');
    localStorage.setItem('erdforge-gemini-model', model.trim() || DEFAULT_CLIENT_GEMINI_MODEL);
  } catch {
    // Ignore storage errors in private browsing
  }
}

async function responseError(response: Response): Promise<AIRequestError> {
  let body: { error?: unknown; message?: unknown } = {};
  try {
    body = await response.json() as typeof body;
  } catch {
    // Keep the error local and avoid exposing an unstructured proxy response.
  }
  const code = typeof body.error === 'string' ? body.error : 'AI_REQUEST_FAILED';
  const message = typeof body.message === 'string' ? body.message : `AI request failed with status ${response.status}.`;
  return new AIRequestError(code, response.status, message);
}

function readEventData(frame: string): { eventName: string; data: unknown } | undefined {
  const lines = frame.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  if (!data) return undefined;
  try {
    return { eventName, data: JSON.parse(data) as unknown };
  } catch {
    throw new AIRequestError('AI_STREAM_INVALID', 502, 'The AI response stream was unreadable. No changes were applied.');
  }
}

async function consumeProposalStream(response: Response, options: AIClientOptions): Promise<SchemaPatch> {
  if (!response.body) throw new AIRequestError('AI_STREAM_EMPTY', 502, 'The AI response stream was empty. No changes were applied.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let patch: SchemaPatch | undefined;
  let streamError: AIRequestError | undefined;

  const handleFrame = (frame: string): void => {
    const event = readEventData(frame);
    if (!event || !event.data || typeof event.data !== 'object') return;
    const body = event.data as { patch?: unknown; phase?: string; message?: string; chunksReceived?: number; code?: string; status?: number };
    if (event.eventName === 'progress' && options.onProgress && typeof body.phase === 'string' && typeof body.message === 'string') {
      options.onProgress({
        phase: body.phase as AIProgress['phase'],
        message: body.message,
        ...(typeof body.chunksReceived === 'number' ? { chunksReceived: body.chunksReceived } : {}),
      });
    } else if (event.eventName === 'result') {
      const validated = schemaPatchSchema.safeParse(body.patch);
      if (!validated.success) throw new AIRequestError('AI_PATCH_INVALID', 502, 'The AI proposal did not pass client-side validation. No changes were applied.');
      patch = validated.data;
    } else if (event.eventName === 'error') {
      streamError = new AIRequestError(
        typeof body.code === 'string' ? body.code : 'AI_REQUEST_FAILED',
        typeof body.status === 'number' ? body.status : 502,
        typeof body.message === 'string' ? body.message : 'The AI request failed. No changes were applied.',
      );
    }
  };

  try {
    while (true) {
      if (options.signal?.aborted) throw new AIRequestError('AI_CANCELLED', 499, 'The AI request was cancelled.');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.search(/\r?\n\r?\n/);
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        const separatorLength = buffer.slice(separator).startsWith('\r\n\r\n') ? 4 : 2;
        buffer = buffer.slice(separator + separatorLength);
        handleFrame(frame);
        separator = buffer.search(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleFrame(buffer);
  } finally {
    reader.releaseLock();
  }

  if (streamError) throw streamError;
  if (!patch) throw new AIRequestError('AI_NO_RESULT', 502, 'The AI response ended without a proposal. No changes were applied.');
  return patch;
}

async function requestProposal<TBody extends ParseProposalInput | EditProposalInput>(path: string, body: TBody, options: AIClientOptions = {}): Promise<SchemaPatch> {
  const stored = getStoredAIConfig();
  const apiKey = options.apiKey ?? stored.apiKey;
  const model = options.model ?? stored.model;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
  };
  if (apiKey) headers['X-Gemini-Api-Key'] = apiKey;
  if (model && model !== DEFAULT_CLIENT_GEMINI_MODEL) headers['X-Gemini-Model'] = model;

  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    if (options.signal?.aborted) throw new AIRequestError('AI_CANCELLED', 499, 'The AI request was cancelled.');
    throw new AIRequestError('AI_NETWORK', 503, 'ERDForge could not reach its AI Worker. Try again.');
  }

  if (!response.ok) throw await responseError(response);
  return consumeProposalStream(response, options);
}

export function requestParseProposal(input: ParseProposalInput, options?: AIClientOptions): Promise<SchemaPatch> {
  return requestProposal('/api/parse', input, options);
}

export function requestEditProposal(input: EditProposalInput, options?: AIClientOptions): Promise<SchemaPatch> {
  return requestProposal('/api/ai/patch', input, options);
}
