import { handleAIRequest, type AIWorkerEnvironment } from './ai';
import { generateServerVectorSvg, type DiagramRenderPayload } from '../src/exporters/vectorDiagram';

export interface Env extends AIWorkerEnvironment {
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Gemini-Api-Key, X-Gemini-Model',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: CORS_HEADERS,
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED', message: 'Use GET for the health route.' }, 405);
      return json({
        ok: true,
        service: 'erdforge',
        model: env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash',
        configured: Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim().length >= 20),
      });
    }
    if (url.pathname === '/api/export') {
      if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED', message: 'Use POST for export.' }, 405);
      try {
        const payload = (await request.json()) as DiagramRenderPayload;
        if (!payload || !payload.schema || !Array.isArray(payload.schema.entities)) {
          return json({ error: 'INVALID_PAYLOAD', message: 'Missing schema payload.' }, 400);
        }
        const rendered = generateServerVectorSvg({
          schema: payload.schema,
          positions: payload.positions ?? {},
          dark: Boolean(payload.dark),
        });
        return json({ ok: true, ...rendered }, 200);
      } catch {
        return json({ error: 'EXPORT_FAILED', message: 'Server export failed.' }, 500);
      }
    }
    if (url.pathname === '/api/parse' || url.pathname === '/api/ai/patch' || url.pathname === '/api/ai/explain') {
      return handleAIRequest(request, env, url.pathname);
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'NOT_FOUND', message: 'API route not found.' }, 404);
    }
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      const response = await env.ASSETS.fetch(request);
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html') && url.origin !== 'https://erdforge.pages.dev') {
        const html = await response.text();
        const rewritten = html.replace(/https:\/\/erdforge\.pages\.dev/g, url.origin);
        return new Response(rewritten, {
          status: response.status,
          headers: response.headers,
        });
      }
      return response;
    }
    return json({ ok: true, service: 'erdforge-worker', message: 'ERDForge Worker is running. Static assets binding is not attached.' }, 200);
  },
};
