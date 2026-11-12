import type { ParserFormat, ResolvedParserFormat } from './types';

export function detectFormat(source: string): ResolvedParserFormat {
  const text = source.trimStart().replace(/^(?:\uFEFF)?(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/g, '');
  if (!text) return 'text';
  if (/^erDiagram\b/m.test(text)) return 'mermaid';
  if (/^Table\s+[\w."`-]+\s*\{/im.test(text) || /^Ref\s*:/im.test(text)) return 'dbml';
  if (/^(?:CREATE\s+(?:TEMPORARY\s+)?TABLE|ALTER\s+TABLE|--\s*SQL)/i.test(text) || /\bCREATE\s+TABLE\b/i.test(text)) return 'sql';
  if (/<\?php\b|Schema::(?:create|table)\s*\(|\$table\s*->|\bbelongsToMany\s*\(/i.test(text)) return 'php';
  if (/^(?:\{|\[)/.test(text)) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'format' in parsed && (parsed as { format?: unknown }).format === 'erdforge') return 'erdforge';
    } catch {
      // A malformed JSON-like input remains a JSON parse candidate so the user receives a JSON error.
    }
    return 'json';
  }
  return 'text';
}

export function resolveFormat(source: string, format: ParserFormat = 'auto'): ResolvedParserFormat {
  return format === 'auto' ? detectFormat(source) : format;
}
