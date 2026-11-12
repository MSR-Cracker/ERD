import type { SchemaModel } from '../model/types';

export type ParserFormat = 'auto' | 'sql' | 'php' | 'json' | 'dbml' | 'mermaid' | 'text' | 'erdforge';
export type ResolvedParserFormat = Exclude<ParserFormat, 'auto'>;
export type SqlDialect = 'auto' | 'mysql' | 'postgresql';
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface ParseDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
  line?: number;
  column?: number;
  code?: string;
}

export interface ParseOptions {
  format?: ParserFormat;
  dialect?: SqlDialect;
  name?: string;
}

export interface ParseResult {
  format: ResolvedParserFormat;
  model: SchemaModel;
  diagnostics: ParseDiagnostic[];
  partial: boolean;
}
