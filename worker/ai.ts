import { z } from 'zod';
import { schemaModelSchema } from '../src/model/schema';
import type { SchemaModel, SchemaPatch, SchemaPatchOperation } from '../src/model/types';
import { AIServiceError, DEFAULT_GEMINI_MODEL, generateReviewExplanation, validateGeminiConfiguration, type AIProgress, type GeminiEnvironment } from './gemini';
import { geminiProvider, type SchemaAIProvider } from './provider';
import { buildEditPrompt, buildParsePrompt, MAX_MODEL_CONTEXT_CHARS, MAX_PATCH_INSTRUCTION_CHARS, MAX_SCHEMA_CHARS } from './prompt';

export const MAX_AI_BODY_BYTES = 512 * 1024;
const MAX_DIAGNOSTICS = 200;

export interface AIRateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface AIWorkerEnvironment extends GeminiEnvironment {
  AI_RATE_LIMITER?: AIRateLimiter;
}

const fallbackIpBuckets = new Map<string, { count: number; resetAt: number }>();

function defaultRateLimit(ip: string): { success: boolean } {
  const now = Date.now();
  const existing = fallbackIpBuckets.get(ip);
  if (!existing || now >= existing.resetAt) {
    fallbackIpBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return { success: true };
  }
  if (existing.count >= 30) {
    return { success: false };
  }
  existing.count += 1;
  return { success: true };
}

const diagnosticSchema = z.object({
  severity: z.string().min(1).max(20),
  message: z.string().min(1).max(1_000),
  line: z.number().int().positive().optional(),
}).strict();

const parseRequestSchema = z.object({
  privacyAcknowledged: z.literal(true),
  source: z.string().min(1).max(MAX_SCHEMA_CHARS),
  currentSchema: schemaModelSchema,
  partialModel: schemaModelSchema.optional(),
  parserDiagnostics: z.array(diagnosticSchema).max(MAX_DIAGNOSTICS).optional(),
  detectedFormat: z.string().max(80).optional(),
}).strict();

const editRequestSchema = z.object({
  privacyAcknowledged: z.literal(true),
  instruction: z.string().trim().min(1).max(MAX_PATCH_INSTRUCTION_CHARS),
  schema: schemaModelSchema,
}).strict();

const reviewExplanationRequestSchema = z.object({
  privacyAcknowledged: z.literal(true),
  finding: z.object({
    ruleId: z.string().min(1).max(80),
    title: z.string().min(1).max(300),
    explanation: z.string().min(1).max(1_000),
    entityName: z.string().max(200).optional(),
    attributeName: z.string().max(200).optional(),
  }).strict(),
}).strict();

export class AIRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'AIRequestError';
  }
}

function logRequestTelemetry(requestId: string, pathname: string, status: number, startedAt: number): void {
  const durationMs = Math.max(0, Date.now() - startedAt);
  console.info(JSON.stringify({ requestId, route: pathname, status, durationMs }));
}

function jsonResponse(body: unknown, status = 200, requestId: string = crypto.randomUUID(), extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Request-Id', requestId);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(error: AIRequestError | AIServiceError, requestId: string): Response {
  return jsonResponse({ error: error.code, message: error.message }, error.status, requestId);
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new AIRequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send this request as application/json.');

  const announcedLength = request.headers.get('Content-Length');
  if (announcedLength) {
    const parsedLength = Number(announcedLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_AI_BODY_BYTES) {
      throw new AIRequestError(413, 'BODY_TOO_LARGE', 'The AI request body exceeds the 512 KiB limit.');
    }
  }
  if (!request.body) throw new AIRequestError(400, 'EMPTY_BODY', 'The AI request body is empty.');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_AI_BODY_BYTES) {
        await reader.cancel();
        throw new AIRequestError(413, 'BODY_TOO_LARGE', 'The AI request body exceeds the 512 KiB limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AIRequestError(400, 'INVALID_ENCODING', 'The request body must be valid UTF-8 JSON.');
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new AIRequestError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
  }
}

function requestIp(request: Request): string {
  const value = request.headers.get('CF-Connecting-IP')?.trim();
  return value && value.length <= 64 ? value : 'unknown';
}

function resolveEffectiveEnv(request: Request, env: AIWorkerEnvironment): AIWorkerEnvironment {
  const headerKey = request.headers.get('X-Gemini-Api-Key')?.trim();
  const headerModel = request.headers.get('X-Gemini-Model')?.trim();
  const resolvedKey = env.GEMINI_API_KEY?.trim() || headerKey;
  return {
    ...env,
    ...(resolvedKey ? { GEMINI_API_KEY: resolvedKey } : {}),
    GEMINI_MODEL: headerModel || env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
  };
}

function buildFallbackPatchFromPartial(currentSchema: SchemaModel, partialModel?: SchemaModel): SchemaPatch | undefined {
  if (!partialModel || partialModel.entities.length === 0) return undefined;
  const existingEntityIds = new Set(currentSchema.entities.map((e) => e.id));
  const existingRelIds = new Set(currentSchema.relationships.map((r) => r.id));
  const operations: SchemaPatchOperation[] = [];

  for (const ent of partialModel.entities) {
    if (!existingEntityIds.has(ent.id)) {
      operations.push({ op: 'entity.add', entity: ent });
      existingEntityIds.add(ent.id);
    }
  }
  for (const rel of partialModel.relationships) {
    if (!existingRelIds.has(rel.id) && existingEntityIds.has(rel.from) && existingEntityIds.has(rel.to)) {
      operations.push({ op: 'relationship.add', relationship: rel });
      existingRelIds.add(rel.id);
    }
  }
  if (operations.length === 0) return undefined;
  return {
    id: `patch-${crypto.randomUUID()}`,
    title: partialModel.name || 'Generated Workbench ERD',
    summary: `Generated ${partialModel.entities.length} tables and ${partialModel.relationships.length} relationships.`,
    ambiguities: [],
    operations,
  };
}

function progressResponse(input: {
  requestId: string;
  pathname: string;
  startedAt: number;
  env: AIWorkerEnvironment;
  currentSchema: SchemaModel;
  partialModel?: SchemaModel;
  systemInstruction: string;
  prompt: string;
  provider: SchemaAIProvider<GeminiEnvironment>;
}): Response {
  const abortController = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (eventName: 'progress' | 'result' | 'error', payload: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
          abortController.abort();
        }
      };

      const onProgress = (progress: AIProgress) => emit('progress', progress);
      void input.provider.propose({
        env: input.env,
        currentSchema: input.currentSchema,
        systemInstruction: input.systemInstruction,
        prompt: input.prompt,
        signal: abortController.signal,
        onProgress,
      }).then((patch) => {
        emit('result', { patch });
        logRequestTelemetry(input.requestId, input.pathname, 200, input.startedAt);
        if (!closed) {
          closed = true;
          controller.close();
        }
      }).catch((error: unknown) => {
        if (!closed) {
          const fallbackPatch = buildFallbackPatchFromPartial(input.currentSchema, input.partialModel);
          if (fallbackPatch) {
            emit('result', { patch: fallbackPatch });
            logRequestTelemetry(input.requestId, input.pathname, 200, input.startedAt);
            closed = true;
            controller.close();
            return;
          }
          const safe = error instanceof AIServiceError
            ? { code: error.code, message: error.message }
            : { code: 'AI_INTERNAL_ERROR', message: 'The AI request failed. No changes were applied.' };
          const status = error instanceof AIServiceError ? error.status : 500;
          logRequestTelemetry(input.requestId, input.pathname, status, input.startedAt);
          emit('error', safe);
          closed = true;
          controller.close();
        }
      });
    },
    cancel() {
      closed = true;
      abortController.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': input.requestId,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function validateContextSize(schema: SchemaModel, prompt: string, partialModel?: SchemaModel): void {
  const currentSize = JSON.stringify(schema).length;
  const partialSize = partialModel ? JSON.stringify(partialModel).length : 0;
  if (currentSize > MAX_SCHEMA_CHARS || partialSize > MAX_SCHEMA_CHARS) {
    throw new AIRequestError(413, 'SCHEMA_TOO_LARGE', 'Each schema model must be at most 100,000 characters for AI requests. Local parsing and editing remain available.');
  }
  if (prompt.length + currentSize > MAX_MODEL_CONTEXT_CHARS) {
    throw new AIRequestError(413, 'AI_CONTEXT_TOO_LARGE', 'The combined schema and AI prompt exceeds the configured context limit. Reduce the input or continue with local parsing.');
  }
}

async function authorizeAndRateLimit(request: Request, env: AIWorkerEnvironment, requestId: string): Promise<Response | undefined> {
  try {
    const ip = requestIp(request);
    const result = env.AI_RATE_LIMITER
      ? await env.AI_RATE_LIMITER.limit({ key: ip })
      : defaultRateLimit(ip);
    if (!result.success) {
      return jsonResponse({ error: 'RATE_LIMITED', message: 'AI request limit reached for this IP. Wait a minute and try again.' }, 429, requestId, { 'Retry-After': '60' });
    }
  } catch {
    return jsonResponse({ error: 'RATE_LIMIT_UNAVAILABLE', message: 'AI requests are temporarily unavailable because rate limiting could not be confirmed.' }, 503, requestId);
  }
  try {
    validateGeminiConfiguration(env);
  } catch (error) {
    if (error instanceof AIServiceError) return errorResponse(error, requestId);
    return jsonResponse({ error: 'AI_NOT_CONFIGURED', message: 'AI is not configured. Set GEMINI_API_KEY as a Cloudflare Secret.' }, 503, requestId);
  }
  return undefined;
}

export async function handleAIRequest(
  request: Request,
  rawEnv: AIWorkerEnvironment,
  pathname: string,
  provider: SchemaAIProvider<GeminiEnvironment> = geminiProvider,
): Promise<Response> {
  const requestId: string = crypto.randomUUID();
  const startedAt = Date.now();
  if (request.method !== 'POST') {
    logRequestTelemetry(requestId, pathname, 405, startedAt);
    return jsonResponse({ error: 'METHOD_NOT_ALLOWED', message: 'Use POST for AI requests.' }, 405, requestId, { Allow: 'POST' });
  }
  const env = resolveEffectiveEnv(request, rawEnv);
  const denied = await authorizeAndRateLimit(request, env, requestId);
  if (denied) {
    logRequestTelemetry(requestId, pathname, denied.status, startedAt);
    return denied;
  }

  try {
    const body = await readBoundedJson(request);
    if (pathname === '/api/ai/explain') {
      const parsed = reviewExplanationRequestSchema.safeParse(body);
      if (!parsed.success) throw new AIRequestError(400, 'INVALID_EXPLANATION_REQUEST', 'Provide one review finding and explicitly acknowledge sharing that finding with Gemini.');
      const { finding } = parsed.data;
      const prompt = [
        `Rule: ${finding.ruleId}`,
        `Finding: ${finding.title}`,
        `Deterministic explanation: ${finding.explanation}`,
        finding.entityName ? `Entity: ${finding.entityName}` : '',
        finding.attributeName ? `Attribute: ${finding.attributeName}` : '',
        'Explain what to verify next. Do not infer absent functional dependencies or propose schema changes as facts.',
      ].filter(Boolean).join('\n');
      const explanation = await generateReviewExplanation({ env, prompt, signal: request.signal });
      logRequestTelemetry(requestId, pathname, 200, startedAt);
      return jsonResponse({ explanation }, 200, requestId);
    }
    if (pathname === '/api/parse') {
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const source = (body as Record<string, unknown>).source;
        if (typeof source === 'string' && source.length > MAX_SCHEMA_CHARS) {
          throw new AIRequestError(413, 'INPUT_TOO_LONG', 'Schema input is limited to 100,000 characters.');
        }
      }
      const parsed = parseRequestSchema.safeParse(body);
      if (!parsed.success) throw new AIRequestError(400, 'INVALID_PARSE_REQUEST', 'Provide a valid source, current schema, optional partial parse and explicit privacy acknowledgement.');
      const input = parsed.data;
      const prompt = buildParsePrompt({
        source: input.source,
        currentSchema: input.currentSchema,
        ...(input.partialModel ? { partialModel: input.partialModel } : {}),
        ...(input.parserDiagnostics ? { parserDiagnostics: input.parserDiagnostics.map((diagnostic) => ({
          severity: diagnostic.severity,
          message: diagnostic.message,
          ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
        })) } : {}),
        ...(input.detectedFormat === undefined ? {} : { detectedFormat: input.detectedFormat }),
      });
      validateContextSize(input.currentSchema, prompt.input, input.partialModel);
      return progressResponse({
        requestId,
        pathname,
        startedAt,
        env,
        currentSchema: input.currentSchema,
        ...(input.partialModel ? { partialModel: input.partialModel } : {}),
        systemInstruction: prompt.systemInstruction,
        prompt: prompt.input,
        provider,
      });
    }

    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const instruction = (body as Record<string, unknown>).instruction;
      if (typeof instruction === 'string' && instruction.length > MAX_PATCH_INSTRUCTION_CHARS) {
        throw new AIRequestError(413, 'INPUT_TOO_LONG', 'AI edit instructions are limited to 8,000 characters.');
      }
    }
    const parsed = editRequestSchema.safeParse(body);
    if (!parsed.success) throw new AIRequestError(400, 'INVALID_PATCH_REQUEST', 'Provide a valid edit instruction, current schema and explicit privacy acknowledgement.');
    const input = parsed.data;
    const prompt = buildEditPrompt({ instruction: input.instruction, currentSchema: input.schema });
    validateContextSize(input.schema, prompt.input);
    return progressResponse({ requestId, pathname, startedAt, env, currentSchema: input.schema, systemInstruction: prompt.systemInstruction, prompt: prompt.input, provider });
  } catch (error) {
    if (error instanceof AIRequestError || error instanceof AIServiceError) {
      logRequestTelemetry(requestId, pathname, error.status, startedAt);
      return errorResponse(error, requestId);
    }
    logRequestTelemetry(requestId, pathname, 400, startedAt);
    return jsonResponse({ error: 'AI_REQUEST_FAILED', message: 'The AI request could not be prepared. No schema changes were applied.' }, 400, requestId);
  }
}
