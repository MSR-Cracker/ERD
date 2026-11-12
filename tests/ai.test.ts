import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SchemaModel } from '../src/model/types';
import { handleAIRequest, MAX_AI_BODY_BYTES, type AIWorkerEnvironment } from '../worker/ai';
import { DEFAULT_GEMINI_MODEL, validateGeminiConfiguration } from '../worker/gemini';

const emptySchema: SchemaModel = {
  version: 1,
  id: 'test-project',
  name: 'Test project',
  entities: [],
  relationships: [],
  specializations: [],
  subjectAreas: [],
  notes: [],
};

const attribute = {
  id: 'category.id',
  name: 'id',
  dataType: 'INTEGER',
  isPK: true,
  isFK: false,
  isUnique: true,
  isNullable: false,
  isIndexed: false,
  isStored: false,
  defaultValue: null,
  kind: 'simple',
  children: null,
  derivationFormula: null,
  enumValues: null,
  foreignKeyRef: null,
  notes: '',
};

const wirePatch = {
  id: 'patch-1',
  title: 'Add Category',
  summary: 'Add a Category entity.',
  ambiguities: [],
  operations: [{
    op: 'entity.add', entityId: null, attributeId: null, relationshipId: null, parentId: null,
    index: null, attributeIds: null,
    entity: { id: 'category', name: 'Category', kind: 'strong', attributes: [attribute], isSpecializationOf: null, subjectAreaId: null, notes: '' },
    attribute: null, relationship: null, changes: null, value: null,
  }],
};

function env(options: { key?: string; limited?: boolean; limiter?: AIWorkerEnvironment['AI_RATE_LIMITER'] } = {}): AIWorkerEnvironment {
  return {
    ...(options.key === undefined ? {} : { GEMINI_API_KEY: options.key }),
    GEMINI_MODEL: 'gemini-3.8-flash',
    AI_RATE_LIMITER: options.limiter ?? { limit: vi.fn(async () => ({ success: !options.limited })) },
  };
}

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://erdforge.test/api/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers },
    body: JSON.stringify(body),
  });
}

function parseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { privacyAcknowledged: true, source: 'Category(id)', currentSchema: emptySchema, ...overrides };
}

function upstreamStream(): Response {
  const events = [
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: JSON.stringify(wirePatch) }] } }] },
    { candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }] },
  ];
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function upstreamError(error: { message: string; status?: number; code?: string }): Response {
  const body = `data: ${JSON.stringify({ event_type: 'error', error })}\n\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Worker AI routes', () => {
  it('defaults to gemini-3.8-flash when GEMINI_MODEL is omitted', () => {
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.8-flash');
    const cfg = validateGeminiConfiguration({ GEMINI_API_KEY: 'k'.repeat(32) });
    expect(cfg.model).toBe('gemini-3.8-flash');
  });

  it('returns the explicit missing-key error and never contacts Gemini', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleAIRequest(makeRequest(parseRequest()), env(), '/api/parse');
    const body = await response.json() as { error: string; message: string };
    expect(response.status).toBe(503);
    expect(body.error).toBe('AI_NOT_CONFIGURED');
    expect(body.message).toContain('GEMINI_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the exact invalid-key message for a short configured placeholder', async () => {
    const response = await handleAIRequest(makeRequest(parseRequest()), env({ key: 'short-key' }), '/api/parse');
    const body = await response.json() as { error: string; message: string };
    expect(response.status).toBe(401);
    expect(body.error).toBe('AI_KEY_INVALID');
    expect(body.message).toBe('The AI key is invalid or still a placeholder. Update GEMINI_API_KEY in Cloudflare.');
  });

  it('applies the Cloudflare limiter using the connecting client IP before reading an AI body', async () => {
    const limiter = { limit: vi.fn(async () => ({ success: false })) };
    const response = await handleAIRequest(makeRequest(parseRequest()), env({ key: 'k'.repeat(32), limiter }), '/api/parse');
    expect(response.status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledWith({ key: '203.0.113.9' });
    expect((await response.json() as { error: string }).error).toBe('RATE_LIMITED');
  });

  it('enforces the hard request-body byte limit even if the content-length header is supplied', async () => {
    const request = makeRequest(parseRequest(), { 'Content-Length': String(MAX_AI_BODY_BYTES + 1) });
    const response = await handleAIRequest(request, env({ key: 'k'.repeat(32) }), '/api/parse');
    expect(response.status).toBe(413);
    expect((await response.json() as { error: string }).error).toBe('BODY_TOO_LARGE');
  });

  it('requires explicit acknowledgement before any schema can be sent to Gemini', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleAIRequest(makeRequest({ source: 'Category', currentSchema: emptySchema }), env({ key: 'k'.repeat(32) }), '/api/parse');
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('INVALID_PARSE_REQUEST');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires explicit finding-level consent and streams an explanation without sending the complete schema', async () => {
    const fetchMock = vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as {
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
        systemInstruction?: { parts?: Array<{ text?: string }> };
        generationConfig?: { maxOutputTokens?: number };
      };
      const prompt = sent.contents?.[0]?.parts?.[0]?.text ?? '';
      expect(sent.systemInstruction?.parts?.[0]?.text).toContain('Explain one database-design review finding');
      expect(sent.generationConfig?.maxOutputTokens).toBe(220);
      expect(prompt).toContain('2nf-partial-dependency');
      expect(prompt).toContain('Line');
      expect(prompt).not.toContain('secret_schema_value');
      const events = [
        { event_type: 'step.delta', delta: { type: 'text', text: 'Review the functional dependencies before decomposing this table.' } },
        { event_type: 'interaction.completed' },
      ];
      const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const denied = await handleAIRequest(makeRequest({ finding: { ruleId: 'x', title: 'x', explanation: 'x' } }), env({ key: 'k'.repeat(32) }), '/api/ai/explain');
    expect(denied.status).toBe(400);
    const response = await handleAIRequest(makeRequest({
      privacyAcknowledged: true,
      finding: { ruleId: '2nf-partial-dependency', title: 'Review 2NF', explanation: 'Check a partial dependency.', entityName: 'Line', attributeName: 'unit_price' },
    }), env({ key: 'k'.repeat(32) }), '/api/ai/explain');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ explanation: 'Review the functional dependencies before decomposing this table.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('enforces the 100,000-character input cap before contacting Gemini', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleAIRequest(makeRequest(parseRequest({ source: 'x'.repeat(100_001) })), env({ key: 'k'.repeat(32) }), '/api/parse');
    expect(response.status).toBe(413);
    expect((await response.json() as { error: string }).error).toBe('INPUT_TOO_LONG');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns provider quota errors as a clear SSE event without retrying non-transient quota exhaustion', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Daily quota exceeded.' } }), { status: 429, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleAIRequest(makeRequest(parseRequest()), env({ key: 'k'.repeat(32) }), '/api/parse');
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('event: error');
    expect(body).toContain('AI_QUOTA');
    expect(body).toContain('Gemini free-tier quota or rate limit reached');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps provider quota errors emitted inside the SSE body to the same clear message', async () => {
    const fetchMock = vi.fn(async () => upstreamError({ status: 429, code: 'RESOURCE_EXHAUSTED', message: 'Daily quota exceeded.' }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleAIRequest(makeRequest(parseRequest()), env({ key: 'k'.repeat(32) }), '/api/parse');
    const body = await response.text();
    expect(body).toContain('AI_QUOTA');
    expect(body).toContain('Gemini free-tier quota or rate limit reached');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps invalid credentials reported in a stream to the explicit Cloudflare secret message', async () => {
    const fetchMock = vi.fn(async () => upstreamError({ status: 401, code: 'API_KEY_INVALID', message: 'API key not valid.' }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleAIRequest(makeRequest(parseRequest()), env({ key: 'k'.repeat(32) }), '/api/parse');
    const body = await response.text();
    expect(body).toContain('AI_KEY_INVALID');
    expect(body).toContain('The AI key is invalid or still a placeholder. Update GEMINI_API_KEY in Cloudflare.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient provider 5xx response and succeeds with a valid stream', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      return attempts === 1 ? new Response('temporarily unavailable', { status: 503 }) : upstreamStream();
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleAIRequest(makeRequest(parseRequest()), env({ key: 'k'.repeat(32) }), '/api/parse');
    const body = await response.text();
    expect(body).toContain('event: result');
    expect(body).toContain('Retrying Gemini');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out a hung fetch, performs only bounded retries and returns a clear timeout error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: Request | string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('Expected an abort signal.'));
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleAIRequest(makeRequest(parseRequest()), env({ key: 'k'.repeat(32) }), '/api/parse');
    const bodyPromise = response.text();
    await vi.runAllTimersAsync();
    const body = await bodyPromise;
    expect(body).toContain('AI_TIMEOUT');
    expect(body).toContain('The Gemini request timed out. Try again.');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('streams progress and a typed patch after Gemini JSON-schema output passes Zod and model-integrity validation', async () => {
    const fetchMock = vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as {
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
        systemInstruction?: { parts?: Array<{ text?: string }> };
        generationConfig?: { temperature?: number; maxOutputTokens?: number; responseMimeType?: string; responseJsonSchema?: { additionalProperties?: boolean } };
      };
      expect(sent.contents?.[0]?.parts?.[0]?.text).toContain('Category');
      expect(sent.systemInstruction?.parts?.[0]?.text).toContain('schema-diff component');
      expect(sent.generationConfig?.temperature).toBe(0.1);
      expect(sent.generationConfig?.maxOutputTokens).toBe(8192);
      expect(sent.generationConfig?.responseMimeType).toBe('application/json');
      expect(sent.generationConfig?.responseJsonSchema?.additionalProperties).toBe(false);
      return upstreamStream();
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleAIRequest(makeRequest(parseRequest()), env({ key: 'k'.repeat(32) }), '/api/parse');
    const body = await response.text();
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    expect(body).toContain('event: progress');
    expect(body).toContain('event: result');
    expect(body).toContain('"name":"Category"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
