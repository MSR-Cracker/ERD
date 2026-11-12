import { parseProjectFile } from '../model/io';
import { schemaModelSchema } from '../model/schema';
import { ModelBuilder } from './common';
import { LOCAL_SCHEMA_INPUT_LIMIT } from './constants';
import { resolveFormat } from './detect';
import type { ParseOptions, ParseResult, ResolvedParserFormat } from './types';

function parserFailure(source: string, format: ResolvedParserFormat, name: string, message: string): ParseResult {
  const builder = new ModelBuilder(source, name);
  builder.addDiagnostic('error', message, undefined, 'parse.input.error');
  return builder.finish(format);
}

export async function parseSourceAsync(source: string, options: ParseOptions = {}): Promise<ParseResult> {
  const name = options.name ?? '';
  const format = resolveFormat(source, options.format ?? 'auto');
  if (source.length > LOCAL_SCHEMA_INPUT_LIMIT) return parserFailure(source, format, name, `Input exceeds the ${LOCAL_SCHEMA_INPUT_LIMIT.toLocaleString()} character local parser limit.`);
  if (!source.trim()) return parserFailure(source, format, name, 'Paste a schema or choose a supported file before parsing.');
  try {
    switch (format) {
      case 'sql': {
        const { parseSqlDdl } = await import('./sql');
        return parseSqlDdl(source, options.dialect ?? 'auto', name);
      }
      case 'php': {
        const { parsePhpSource } = await import('./php');
        return parsePhpSource(source, name);
      }
      case 'json': {
        const { parseJsonSource } = await import('./json');
        return parseJsonSource(source, name);
      }
      case 'dbml': {
        const { parseDbml } = await import('./dbml');
        return parseDbml(source, name);
      }
      case 'mermaid': {
        const { parseMermaid } = await import('./mermaid');
        return parseMermaid(source, name);
      }
      case 'text': {
        const { parseStructuredText } = await import('./text');
        return parseStructuredText(source, name);
      }
      case 'erdforge': {
        const parsed = schemaModelSchema.parse(parseProjectFile(source));
        return { format, model: parsed, diagnostics: [], partial: false };
      }
      default: return parserFailure(source, format, name, `Unsupported parser format: ${format}.`);
    }
  } catch (error) {
    return parserFailure(source, format, name, `Import failed safely: ${error instanceof Error ? error.message : 'unrecognized structure'}`);
  }
}
