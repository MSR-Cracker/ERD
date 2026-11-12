import { applySchemaPatch } from '../src/model/patch';
import type { SchemaModel, SchemaPatch } from '../src/model/types';
import type { AIProgress } from '../src/ai/types';
import { MAX_MODEL_CONTEXT_CHARS } from './prompt';
import { GEMINI_PATCH_RESPONSE_SCHEMA, parseGeminiJsonText, repairAndNormalizePatch } from './responseSchema';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PROVIDER_TIMEOUT_MS = 40_000;
const MAX_ATTEMPTS = 3;
const MAX_PROVIDER_ERROR_CHARS = 2_000;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

const FALLBACK_UPSTREAM_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
  'gemini-1.5-flash',
];

export type { AIProgress };

export interface GeminiEnvironment {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

export class AIServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AIServiceError';
  }
}

export function validateGeminiConfiguration(env: GeminiEnvironment): { apiKey: string; model: string } {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new AIServiceError('AI_NOT_CONFIGURED', 503, 'AI is not configured. Set GEMINI_API_KEY as a Cloudflare Secret.');
  if (apiKey.length < 20) throw new AIServiceError('AI_KEY_INVALID', 401, 'The AI key is invalid or still a placeholder. Update GEMINI_API_KEY in Cloudflare.');

  const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) throw new AIServiceError('AI_MODEL_INVALID', 503, 'The configured Gemini model name is invalid. Update GEMINI_MODEL in Wrangler.');
  return { apiKey, model };
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay)) return Math.max(0, Math.min(2_000, delay));
  }
  return Math.min(1_500, 250 * 2 ** attempt);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new AIServiceError('AI_CANCELLED', 499, 'The AI request was cancelled.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AIServiceError('AI_CANCELLED', 499, 'The AI request was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as { error?: { message?: unknown; status?: unknown; code?: unknown } };
  const raw = record.error?.message;
  return typeof raw === 'string' ? raw.slice(0, MAX_PROVIDER_ERROR_CHARS) : '';
}

function providerError(status: number, payload: unknown): AIServiceError {
  const detail = errorText(payload);
  if (status === 401 || status === 403 || /api key (?:is )?not valid|invalid api key|api_key_invalid/i.test(detail)) {
    return new AIServiceError('AI_KEY_INVALID', 401, 'The AI key is invalid or still a placeholder. Update GEMINI_API_KEY in Cloudflare.');
  }
  if (status === 429) {
    return new AIServiceError('AI_QUOTA', 429, 'Gemini free-tier quota or rate limit reached. Check the live Google AI Studio limits and try again.');
  }
  if (status >= 500) return new AIServiceError('AI_PROVIDER_UNAVAILABLE', 503, 'Gemini is temporarily unavailable. Try again shortly.');
  if (status === 400 && /api key|credential/i.test(detail)) {
    return new AIServiceError('AI_KEY_INVALID', 401, 'The AI key is invalid or still a placeholder. Update GEMINI_API_KEY in Cloudflare.');
  }
  return new AIServiceError('AI_PROVIDER_REJECTED', 502, 'Gemini rejected the request. Check the model setting or retry with a simpler schema request.');
}

function streamProviderError(error: { message?: string; status?: number; code?: string } | undefined): AIServiceError {
  const status = error?.status ?? 0;
  const detail = `${error?.code ?? ''} ${error?.message ?? ''}`;
  if (status === 401 || status === 403 || /api key (?:is )?not valid|invalid api key|api_key_invalid/i.test(detail)) {
    return new AIServiceError('AI_KEY_INVALID', 401, 'The AI key is invalid or still a placeholder. Update GEMINI_API_KEY in Cloudflare.');
  }
  if (status === 429 || /quota|resource_exhausted|daily quota|rate limit/i.test(detail)) {
    return new AIServiceError('AI_QUOTA', 429, 'Gemini free-tier quota or rate limit reached. Check the live Google AI Studio limits and try again.');
  }
  if (status >= 500) return new AIServiceError('AI_PROVIDER_UNAVAILABLE', 503, 'Gemini is temporarily unavailable. Try again shortly.');
  return new AIServiceError('AI_PROVIDER_STREAM_ERROR', 502, 'Gemini ended the response with an error. No changes were applied.');
}

function makeProviderController(parentSignal: AbortSignal): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Gemini request timed out.', 'TimeoutError')), PROVIDER_TIMEOUT_MS);
  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abortFromParent);
    },
  };
}

async function readGeminiEventStream(response: Response, signal: AbortSignal, onProgress: (progress: AIProgress) => void | Promise<void>): Promise<string> {
  if (!response.body) throw new AIServiceError('AI_EMPTY_STREAM', 502, 'Gemini returned an empty response stream. No changes were applied.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let generated = '';
  let chunksReceived = 0;
  let sawCompletion = false;

  const processFrame = async (frame: string): Promise<void> => {
    const trimmedFrame = frame.trim();
    if (!trimmedFrame) return;
    const dataLines = trimmedFrame.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    const data = dataLines.length > 0
      ? dataLines.map((line) => line.slice(5).trimStart()).join('\n')
      : trimmedFrame;
    if (!data || data === '[DONE]') return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new AIServiceError('AI_STREAM_INVALID', 502, 'Gemini returned an unreadable streaming event. No changes were applied.');
    }
    if (!event || typeof event !== 'object') return;
    const item = event as {
      event_type?: string;
      error?: { message?: string; status?: number; code?: string };
      delta?: { type?: string; text?: string };
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    };
    if (item.event_type === 'error' || (item.error && !item.candidates && !item.delta)) throw streamProviderError(item.error);
    if (item.event_type === 'step.delta' && item.delta?.type === 'text' && typeof item.delta.text === 'string') {
      generated += item.delta.text;
      chunksReceived += 1;
      await onProgress({ phase: 'generating', message: 'Gemini is preparing a structured proposal…', chunksReceived });
    }
    if (Array.isArray(item.candidates)) {
      for (const candidate of item.candidates) {
        const partText = candidate.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
        if (partText) {
          generated += partText;
          chunksReceived += 1;
          await onProgress({ phase: 'generating', message: 'Gemini is preparing a structured proposal…', chunksReceived });
        }
        if (candidate.finishReason) sawCompletion = true;
      }
    }
    if (item.event_type === 'interaction.completed') sawCompletion = true;
  };

  try {
    while (true) {
      if (signal.aborted) throw new AIServiceError('AI_CANCELLED', 499, 'The AI request was cancelled.');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.search(/\r?\n\r?\n/);
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        const separatorLength = buffer.slice(separator).startsWith('\r\n\r\n') ? 4 : 2;
        buffer = buffer.slice(separator + separatorLength);
        await processFrame(frame);
        separator = buffer.search(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await processFrame(buffer);
  } catch (error) {
    try { await reader.cancel(); } catch { /* Reader may already be closed. */ }
    if (signal.aborted) throw new AIServiceError('AI_TIMEOUT', 504, 'The Gemini request timed out or was cancelled. Try again.');
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (!generated.trim()) throw new AIServiceError('AI_EMPTY_OUTPUT', 502, 'Gemini returned no proposal. No changes were applied.');
  if (!sawCompletion) await onProgress({ phase: 'validating', message: 'Validating the complete response…', chunksReceived });
  return generated;
}

export async function generateValidatedPatch(input: {
  env: GeminiEnvironment;
  currentSchema: SchemaModel;
  systemInstruction: string;
  prompt: string;
  signal: AbortSignal;
  onProgress: (progress: AIProgress) => void | Promise<void>;
}): Promise<SchemaPatch> {
  const { apiKey, model } = validateGeminiConfiguration(input.env);
  const contextLength = JSON.stringify(input.currentSchema).length + input.prompt.length;
  if (contextLength > MAX_MODEL_CONTEXT_CHARS) throw new AIServiceError('AI_CONTEXT_TOO_LARGE', 413, 'The current schema is too large for an AI proposal. Continue with local parsing or reduce the schema context.');

  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: input.systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseJsonSchema: GEMINI_PATCH_RESPONSE_SCHEMA,
    },
  });
  let lastTransient: AIServiceError | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (input.signal.aborted) throw new AIServiceError('AI_CANCELLED', 499, 'The AI request was cancelled.');
    const { controller, cleanup } = makeProviderController(input.signal);
    try {
      await input.onProgress({ phase: attempt ? 'retrying' : 'connecting', message: attempt ? `Retrying Gemini (${attempt + 1}/${MAX_ATTEMPTS})…` : 'Connecting securely to Gemini…' });
      let response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, Accept: 'text/event-stream' },
        body: requestBody,
        signal: controller.signal,
      });

      // If the upstream v1beta endpoint returns 404 (e.g. model alias like gemini-3.8-flash)
      // or 400 (because responseJsonSchema is too complex for v1beta), fall back seamlessly to
      // live free-tier models with responseMimeType: 'application/json'
      if (!response.ok && (response.status === 404 || response.status === 400)) {
        const fallbackBody = JSON.stringify({
          systemInstruction: { parts: [{ text: input.systemInstruction }] },
          contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
          },
        });
        for (const candidateModel of FALLBACK_UPSTREAM_MODELS) {
          if (controller.signal.aborted) break;
          const fallbackUrl = `${GEMINI_API_BASE}/${encodeURIComponent(candidateModel)}:streamGenerateContent?alt=sse`;
          const candidateResp = await fetch(fallbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, Accept: 'text/event-stream' },
            body: fallbackBody,
            signal: controller.signal,
          });
          if (candidateResp.ok) {
            response = candidateResp;
            break;
          }
        }
      }

      if (!response.ok) {
        let providerPayload: unknown = null;
        let providerBody = '';
        try {
          providerBody = (await response.text()).slice(0, MAX_PROVIDER_ERROR_CHARS);
          providerPayload = JSON.parse(providerBody);
        } catch {
          providerPayload = null;
        }
        const failure = providerError(response.status, providerPayload);
        if (response.status >= 500 && attempt < MAX_ATTEMPTS - 1) {
          lastTransient = failure;
          await sleep(retryDelay(response.headers.get('Retry-After'), attempt), input.signal);
          continue;
        }
        if (response.status === 429) {
          const detail = errorText(providerPayload).toLowerCase();
          const isQuota = /quota|resource_exhausted|daily/.test(detail);
          const retryAfter = response.headers.get('Retry-After');
          if (!isQuota && retryAfter && attempt < MAX_ATTEMPTS - 1) {
            lastTransient = failure;
            await sleep(retryDelay(retryAfter, attempt), input.signal);
            continue;
          }
        }
        throw failure;
      }

      const generatedText = await readGeminiEventStream(response, controller.signal, input.onProgress);
      await input.onProgress({ phase: 'validating', message: 'Checking the proposal against the current schema…' });
      let patch: SchemaPatch;
      try {
        const rawPatch = parseGeminiJsonText(generatedText);
        patch = repairAndNormalizePatch(input.currentSchema, rawPatch);
        applySchemaPatch(input.currentSchema, patch);
      } catch {
        throw new AIServiceError('AI_PATCH_INVALID', 502, 'Gemini returned a proposal that did not pass strict schema validation. No changes were applied. Retry or clarify the request.');
      }
      return patch;
    } catch (error) {
      if (input.signal.aborted) throw new AIServiceError('AI_CANCELLED', 499, 'The AI request was cancelled.');
      if (controller.signal.aborted) {
        const timeout = new AIServiceError('AI_TIMEOUT', 504, 'The Gemini request timed out. Try again.');
        if (attempt < MAX_ATTEMPTS - 1) {
          lastTransient = timeout;
          await sleep(retryDelay(null, attempt), input.signal);
          continue;
        }
        throw timeout;
      }
      if (error instanceof AIServiceError) {
        if (input.signal.aborted || error.code === 'AI_KEY_INVALID' || error.code === 'AI_QUOTA' || error.code === 'AI_PROVIDER_REJECTED' || error.code === 'AI_PATCH_INVALID' || error.code === 'AI_EMPTY_OUTPUT' || error.code === 'AI_EMPTY_STREAM' || error.code === 'AI_STREAM_INVALID' || error.code === 'AI_PROVIDER_STREAM_ERROR') throw error;
        if (error.code === 'AI_CANCELLED') throw error;
        if (error.code === 'AI_TIMEOUT' && attempt < MAX_ATTEMPTS - 1) {
          lastTransient = error;
          await sleep(retryDelay(null, attempt), input.signal);
          continue;
        }
        if (error.code === 'AI_PROVIDER_UNAVAILABLE' && attempt < MAX_ATTEMPTS - 1) {
          lastTransient = error;
          await sleep(retryDelay(null, attempt), input.signal);
          continue;
        }
        throw error;
      }
      if (input.signal.aborted) throw new AIServiceError('AI_CANCELLED', 499, 'The AI request was cancelled.');
      if (attempt < MAX_ATTEMPTS - 1) {
        lastTransient = new AIServiceError('AI_NETWORK', 503, 'The Gemini network request failed temporarily.');
        await sleep(retryDelay(null, attempt), input.signal);
        continue;
      }
      throw new AIServiceError('AI_NETWORK', 503, 'Gemini could not be reached after bounded retries. Try again shortly.');
    } finally {
      cleanup();
    }
  }
  throw lastTransient ?? new AIServiceError('AI_PROVIDER_UNAVAILABLE', 503, 'Gemini is temporarily unavailable. Try again shortly.');
}

export async function generateReviewExplanation(input: {
  env: GeminiEnvironment;
  prompt: string;
  signal: AbortSignal;
}): Promise<string> {
  const { apiKey, model } = validateGeminiConfiguration(input.env);
  if (input.prompt.length > 4_000) throw new AIServiceError('AI_CONTEXT_TOO_LARGE', 413, 'The review explanation context exceeds 4,000 characters.');
  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const systemInstruction = 'Explain one database-design review finding in plain language. Preserve uncertainty, never claim a functional dependency that is not supplied, do not edit or invent schema, and keep the response under 120 words.';
  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 220 },
  });
  let lastTransient: AIServiceError | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (input.signal.aborted) throw new AIServiceError('AI_CANCELLED', 499, 'The AI request was cancelled.');
    const { controller, cleanup } = makeProviderController(input.signal);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, Accept: 'text/event-stream' },
        body: requestBody,
        signal: controller.signal,
      });
      if (!response.ok) {
        let payload: unknown = null;
        try { payload = JSON.parse((await response.text()).slice(0, MAX_PROVIDER_ERROR_CHARS)) as unknown; } catch { payload = null; }
        const failure = providerError(response.status, payload);
        if (response.status >= 500 && attempt < MAX_ATTEMPTS - 1) {
          lastTransient = failure;
          await sleep(retryDelay(response.headers.get('Retry-After'), attempt), input.signal);
          continue;
        }
        if (response.status === 429 && response.headers.has('Retry-After') && !/quota|resource_exhausted|daily/i.test(errorText(payload)) && attempt < MAX_ATTEMPTS - 1) {
          lastTransient = failure;
          await sleep(retryDelay(response.headers.get('Retry-After'), attempt), input.signal);
          continue;
        }
        throw failure;
      }
      const text = await readGeminiEventStream(response, controller.signal, () => undefined);
      const bounded = text.trim().slice(0, 2_000);
      if (!bounded) throw new AIServiceError('AI_EMPTY_OUTPUT', 502, 'Gemini returned no review explanation.');
      return bounded;
    } catch (error) {
      if (input.signal.aborted) throw new AIServiceError('AI_CANCELLED', 499, 'The AI request was cancelled.');
      if (controller.signal.aborted) {
        const timeout = new AIServiceError('AI_TIMEOUT', 504, 'The Gemini review explanation timed out. Try again.');
        if (attempt < MAX_ATTEMPTS - 1) { lastTransient = timeout; await sleep(retryDelay(null, attempt), input.signal); continue; }
        throw timeout;
      }
      if (error instanceof AIServiceError && ['AI_KEY_INVALID', 'AI_QUOTA', 'AI_PROVIDER_REJECTED', 'AI_PROVIDER_STREAM_ERROR', 'AI_EMPTY_OUTPUT', 'AI_STREAM_INVALID'].includes(error.code)) throw error;
      if (attempt < MAX_ATTEMPTS - 1) {
        lastTransient = error instanceof AIServiceError ? error : new AIServiceError('AI_NETWORK', 503, 'The Gemini network request failed temporarily.');
        await sleep(retryDelay(null, attempt), input.signal);
        continue;
      }
      throw error instanceof AIServiceError ? error : new AIServiceError('AI_NETWORK', 503, 'Gemini could not be reached after bounded retries. Try again shortly.');
    } finally {
      cleanup();
    }
  }
  throw lastTransient ?? new AIServiceError('AI_PROVIDER_UNAVAILABLE', 503, 'Gemini is temporarily unavailable. Try again shortly.');
}
