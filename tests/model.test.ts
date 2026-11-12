import { describe, expect, it } from 'vitest';
import { pharmacySchema } from './fixtures/pharmacy';
import { applyPatchOperations, applySchemaPatch } from '../src/model/patch';
import { validateSchemaModel } from '../src/model/schema';
import { parseProjectFile, serializeProject } from '../src/model/io';
import type { Attribute, SchemaModel } from '../src/model/types';

const cloneSeed = (): SchemaModel => structuredClone(pharmacySchema);
const makeAttribute = (id: string, name: string): Attribute => ({
  id, name, dataType: 'VARCHAR(100)', isPK: false, isFK: false, isUnique: false, isNullable: true, kind: 'simple', notes: '',
});

describe('normalized model integrity', () => {
  it('accepts the pharmacy chain seed and retains its required topology', () => {
    const result = validateSchemaModel(pharmacySchema);
    expect(result.success).toBe(true);
    expect(pharmacySchema.entities.map((entity) => entity.name)).toContain('StockPaymentOrderLine');
    expect(pharmacySchema.specializations[0]).toMatchObject({ parent: 'item', children: ['drug'] });
    expect(pharmacySchema.entities.find((entity) => entity.id === 'stock')?.kind).toBe('associative');
    expect(pharmacySchema.entities.find((entity) => entity.id === 'customer-order')?.attributes.find((attribute) => attribute.name === 'price')?.kind).toBe('derived');
    const activeIngredients = pharmacySchema.entities.find((entity) => entity.id === 'drug')?.attributes.find((attribute) => attribute.name === 'active_pharmaceutical_ingredients');
    expect(activeIngredients?.kind).toBe('multivalued');
    expect(activeIngredients?.children?.map((attribute) => attribute.name)).toEqual(['ingredient_name', 'strength']);
    expect(pharmacySchema.entities.find((entity) => entity.id === 'drug')?.attributes[0]).toMatchObject({ isPK: true, isFK: true });
    expect(pharmacySchema.entities.find((entity) => entity.id === 'branch')?.attributes.find((attribute) => attribute.name === 'managed_by_staff_id')?.foreignKeyRef?.entityId).toBe('staff');
  });

  it('reports dangling relationships and foreign-key targets', () => {
    const model = cloneSeed();
    model.relationships.push({
      id: 'broken', from: 'not-an-entity', to: 'item', fromCardinality: '1', toCardinality: '0..N', identifying: false, participation: 'partial', label: 'broken', attributes: [], onDelete: 'NO ACTION', onUpdate: 'NO ACTION', notes: '',
    });
    const result = validateSchemaModel(model);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.join(' ')).toContain('missing source entity');
  });
});

describe('typed schema patches', () => {
  it('applies multiple operations atomically and accepts a patch envelope', () => {
    const model = cloneSeed();
    const patch = {
      id: 'patch-1', title: 'Clarify item label', summary: 'Rename one attribute.', ambiguities: [],
      operations: [{ op: 'attribute.update' as const, entityId: 'item', attributeId: 'item.name', changes: { name: 'display_name' } }],
    };
    const result = applySchemaPatch(model, patch);
    expect(result.entities.find((entity) => entity.id === 'item')?.attributes[1]?.name).toBe('display_name');
    const extended = applyPatchOperations(result, [{ op: 'attribute.add', entityId: 'item', attribute: makeAttribute('item.note', 'note') }]);
    expect(extended.entities.find((entity) => entity.id === 'item')?.attributes.some((attribute) => attribute.id === 'item.note')).toBe(true);
    expect(model.entities.find((entity) => entity.id === 'item')?.attributes[1]?.name).toBe('name');
  });

  it('reorders every top-level attribute and rejects incomplete ordering without mutating source', () => {
    const model = cloneSeed();
    const original = structuredClone(model);
    const ids = model.entities.find((entity) => entity.id === 'item')!.attributes.map((attribute) => attribute.id).reverse();
    const result = applyPatchOperations(model, [{ op: 'attribute.reorder', entityId: 'item', attributeIds: ids }]);
    expect(result.entities.find((entity) => entity.id === 'item')!.attributes[0]!.id).toBe(ids[0]);
    expect(() => applyPatchOperations(model, [{ op: 'attribute.reorder', entityId: 'item', attributeIds: ['item.id'] }])).toThrow(/every top-level attribute/);
    expect(model).toEqual(original);
  });

  it('rejects a multi-operation patch as a whole if its final model is invalid', () => {
    const model = cloneSeed();
    const original = structuredClone(model);
    expect(() => applyPatchOperations(model, [
      { op: 'entity.add', entity: { id: 'temporary', name: 'Temporary', kind: 'strong', attributes: [], notes: '' } },
      { op: 'relationship.add', relationship: { id: 'invalid', from: 'temporary', to: 'missing', fromCardinality: '1', toCardinality: '0..N', identifying: false, participation: 'partial', label: 'bad ref', attributes: [], onDelete: 'NO ACTION', onUpdate: 'NO ACTION', notes: '' } },
    ])).toThrow(/missing target entity/);
    expect(model).toEqual(original);
  });
});

describe('ERDForge project file', () => {
  it('round-trips a versioned JSON project', () => {
    const file = serializeProject(pharmacySchema, '2026-11-10T00:00:00.000Z');
    const parsed = parseProjectFile(file);
    expect(parsed).toEqual(pharmacySchema);
    expect(JSON.parse(file)).toMatchObject({ format: 'erdforge', version: 1 });
  });

  it('gives friendly errors for malformed JSON and unsupported versions', () => {
    expect(() => parseProjectFile('{')).toThrow('not valid JSON');
    expect(() => parseProjectFile(JSON.stringify({ format: 'erdforge', version: 2, schema: pharmacySchema }))).toThrow('Unsupported ERDForge project version');
  });

  it('does not change the model on malformed import', () => {
    const model = cloneSeed();
    expect(() => parseProjectFile(JSON.stringify({ format: 'erdforge', version: 1, schema: { ...model, entities: [{ ...model.entities[0], id: '' }] } }))).toThrow(/Project schema is invalid/);
    expect(model).toEqual(pharmacySchema);
  });
});
