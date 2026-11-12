import { describe, expect, it } from 'vitest';
import { applySchemaPatch } from '../src/model/patch';
import type { SchemaModel } from '../src/model/types';
import { GEMINI_PATCH_RESPONSE_SCHEMA, parseGeminiJsonText, parseGeminiPatch } from '../worker/responseSchema';

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
} as const;

const entity = {
  id: 'category',
  name: 'Category',
  kind: 'strong',
  attributes: [attribute],
  isSpecializationOf: null,
  subjectAreaId: null,
  notes: '',
} as const;

function wirePatch() {
  return {
    id: 'patch-1',
    title: 'Add Category',
    summary: 'Add a Category entity.',
    ambiguities: [],
    operations: [{
      op: 'entity.add',
      entityId: null,
      attributeId: null,
      relationshipId: null,
      parentId: null,
      index: null,
      attributeIds: null,
      entity,
      attribute: null,
      relationship: null,
      changes: null,
      value: null,
    }],
  };
}

describe('Gemini response schema', () => {
  it('converts a strict nullable wire response into a typed, applicable SchemaPatch', () => {
    const patch = parseGeminiPatch(wirePatch());
    expect(patch.operations).toHaveLength(1);
    expect(patch.operations[0]?.op).toBe('entity.add');
    if (patch.operations[0]?.op !== 'entity.add') throw new Error('Expected an entity.add operation.');
    expect(patch.operations[0].entity.attributes[0]?.children).toBeUndefined();
    expect(patch.operations[0].entity.attributes[0]?.defaultValue).toBeNull();
    expect(applySchemaPatch(emptySchema, patch).entities[0]?.name).toBe('Category');
  });

  it('rejects unknown model and operation keys instead of silently passing them through', () => {
    const modelExtra = JSON.parse(JSON.stringify(wirePatch())) as { operations: Array<Record<string, unknown>> };
    modelExtra.operations[0]!.entity = { ...entity, hiddenField: true };
    expect(() => parseGeminiPatch(modelExtra)).toThrow();

    const operationExtra = JSON.parse(JSON.stringify(wirePatch())) as { operations: Array<Record<string, unknown>> };
    operationExtra.operations[0]!.silentlyApply = true;
    expect(() => parseGeminiPatch(operationExtra)).toThrow();
  });

  it('rejects missing payloads, invalid references and malformed JSON without applying any change', () => {
    const missingEntity = structuredClone(wirePatch());
    missingEntity.operations[0]!.entity = null as never;
    expect(() => parseGeminiPatch(missingEntity)).toThrow();
    expect(() => parseGeminiJsonText('not JSON')).toThrow('Gemini returned no JSON object.');
    expect(() => parseGeminiJsonText('{ broken}')).toThrow('Gemini returned malformed JSON. No changes were applied.');
  });

  it('publishes an explicit JSON object contract with closed operation objects', () => {
    const schema = GEMINI_PATCH_RESPONSE_SCHEMA as { type: string; additionalProperties: boolean; properties: Record<string, { additionalProperties?: boolean; items?: { additionalProperties?: boolean } }> };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.operations?.items?.additionalProperties).toBe(false);
  });
});
