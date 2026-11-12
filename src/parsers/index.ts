import { parseProjectFile } from '../model/io';
import { schemaModelSchema } from '../model/schema';
import { ModelBuilder } from './common';
import { resolveFormat } from './detect';
import { parseDbml } from './dbml';
import { parseJsonSource } from './json';
import { parseMermaid } from './mermaid';
import { parsePhpSource } from './php';
import { parseSqlDdl } from './sql';
import { parseStructuredText } from './text';
import { LOCAL_SCHEMA_INPUT_LIMIT } from './constants';
import type { ParseOptions, ParseResult, ResolvedParserFormat } from './types';

export { LOCAL_SCHEMA_INPUT_LIMIT } from './constants';
export { detectFormat, resolveFormat } from './detect';
export type { DiagnosticSeverity, ParseDiagnostic, ParseOptions, ParseResult, ParserFormat, ResolvedParserFormat, SqlDialect } from './types';
export { parseDbml } from './dbml';
export { parseJsonSource } from './json';
export { parseMermaid } from './mermaid';
export { parsePhpSource } from './php';
export { parseSqlDdl } from './sql';
export { parseStructuredText } from './text';

function failure(source: string, format: ResolvedParserFormat, name: string, message: string): ParseResult {
  const builder = new ModelBuilder(source, name);
  builder.addDiagnostic('error', message, undefined, 'parse.input.error');
  return builder.finish(format);
}

export function parseSource(source: string, options: ParseOptions = {}): ParseResult {
  const name = options.name ?? '';
  const format = resolveFormat(source, options.format ?? 'auto');
  if (source.length > LOCAL_SCHEMA_INPUT_LIMIT) return failure(source, format, name, `Input exceeds the ${LOCAL_SCHEMA_INPUT_LIMIT.toLocaleString()} character local parser limit.`);
  if (!source.trim()) return failure(source, format, name, 'Paste a schema or choose a supported file before parsing.');
  try {
    switch (format) {
      case 'sql': return parseSqlDdl(source, options.dialect ?? 'auto', name);
      case 'php': return parsePhpSource(source, name);
      case 'json': return parseJsonSource(source, name);
      case 'dbml': return parseDbml(source, name);
      case 'mermaid': return parseMermaid(source, name);
      case 'text': return parseStructuredText(source, name);
      case 'erdforge': {
        const schema = parseProjectFile(source);
        const parsed = schemaModelSchema.parse(schema);
        return { format, model: parsed, diagnostics: [], partial: false };
      }
      default: return failure(source, format, name, `Unsupported parser format: ${format}.`);
    }
  } catch (error) {
    return failure(source, format, name, `Import failed safely: ${error instanceof Error ? error.message : 'unrecognized structure'}`);
  }
}
