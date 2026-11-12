import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SchemaModel } from '../src/model/types';
import { requestEditProposal } from '../src/ai/client';

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

const patch = {
  id: 'patch-1',
  title: 'Add Category',
  summary: 'Add a Category entity.',
  ambiguities: [],
  operations: [{
    op: 'entity.add',
    entity: {
      id: 'category', name: 'Category', kind: 'strong', attributes: [{
        id: 'category.id', name: 'id', dataType: 'INTEGER', isPK: true, isFK: false, isUnique: true, isNullable: false,
        defaultValue: null, kind: 'simple', notes: '',
      }], notes: '',
    },
  }],
};

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const text = events.join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const splitAt = Math.min(37, text.length);
      controller.enqueue(encoder.encode(text.slice(0, splitAt)));
      controller.enqueue(encoder.encode(text.slice(splitAt)));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AI browser client', () => {
  it('reads split SSE frames and validates the typed proposal before returning it', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      `event: progress\ndata: ${JSON.stringify({ phase: 'generating', message: 'Preparing…', chunksReceived: 1 })}\n\n`,
      `event: result\ndata: ${JSON.stringify({ patch })}\n\n`,
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const onProgress = vi.fn();
    const result = await requestEditProposal({ instruction: 'Add Category', schema: emptySchema, privacyAcknowledged: true }, { onProgress });
    expect(result.title).toBe('Add Category');
    expect(onProgress).toHaveBeenCalledWith({ phase: 'generating', message: 'Preparing…', chunksReceived: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/ai/patch', expect.objectContaining({ method: 'POST' }));
  });

  it('surfaces Worker JSON quota/rate responses without attempting to parse them as an SSE stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'RATE_LIMITED', message: 'Wait a minute.' }), { status: 429, headers: { 'Content-Type': 'application/json' } })));
    await expect(requestEditProposal({ instruction: 'Add Category', schema: emptySchema, privacyAcknowledged: true })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      message: 'Wait a minute.',
    });
  });

  it('rejects an invalid patch in the stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([`event: result\ndata: ${JSON.stringify({ patch: { title: 'No operations' } })}\n\n`])));
    await expect(requestEditProposal({ instruction: 'Add Category', schema: emptySchema, privacyAcknowledged: true })).rejects.toMatchObject({ code: 'AI_PATCH_INVALID' });
  });
});
