import { schemaModelSchema } from './schema';
import type { SchemaModel } from './types';

export interface ERDForgeFile {
  poweredBy: 'MSR_Coder';
  format: 'erdforge';
  version: 1;
  exportedAt: string;
  schema: SchemaModel;
}

export function serializeProject(model: SchemaModel, exportedAt = new Date().toISOString()): string {
  const schema = schemaModelSchema.parse(model);
  const file: ERDForgeFile = { poweredBy: 'MSR_Coder', format: 'erdforge', version: 1, exportedAt, schema };
  return JSON.stringify(file, null, 2);
}

export function parseProjectFile(text: string): SchemaModel {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The project file is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || !('format' in raw) || !('version' in raw) || !('schema' in raw)) {
    throw new Error('This file is missing the ERDForge format/version/schema header.');
  }
  const envelope = raw as Record<string, unknown>;
  if (envelope.format !== 'erdforge') throw new Error('This file is not an ERDForge project.');
  if (envelope.version !== 1) throw new Error(`Unsupported ERDForge project version: ${String(envelope.version)}.`);
  const parsed = schemaModelSchema.safeParse(envelope.schema);
  if (!parsed.success) throw new Error(`Project schema is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}
