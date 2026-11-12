import { describe, expect, it } from 'vitest';
import { applyPatchOperations } from '../src/model/patch';
import { pharmacySchema } from './fixtures/pharmacy';
import type { Attribute, Entity, Relationship, SchemaModel } from '../src/model/types';
import { buildReviewFixPreview } from '../src/model/fixes';
import { analyzeSchema } from '../src/model/rules';

const attr = (id: string, name: string, options: Partial<Attribute> = {}): Attribute => ({
  id, name, dataType: 'VARCHAR(80)', isPK: false, isFK: false, isUnique: false, isNullable: false, kind: 'simple', notes: '', ...options,
});
const entity = (id: string, name: string, attributes: Attribute[], kind: Entity['kind'] = 'strong'): Entity => ({ id, name, kind, attributes, notes: '' });
const relation = (id: string, from: string, to: string, fromCardinality: Relationship['fromCardinality'], toCardinality: Relationship['toCardinality']): Relationship => ({
  id, from, to, fromCardinality, toCardinality, identifying: false, participation: 'partial', label: `${from} to ${to}`, attributes: [], onDelete: 'NO ACTION', onUpdate: 'NO ACTION', notes: '',
});
const model = (entities: Entity[], relationships: Relationship[] = []): SchemaModel => ({ version: 1, id: 'review-test', name: 'Review test', entities, relationships, specializations: [], subjectAreas: [], notes: [] });

function fixture(): SchemaModel {
  return model([
    entity('owner', 'Owner', [
      attr('owner.id', 'owner_id', { isPK: true, isUnique: true }),
      attr('owner.tags', 'tags', { kind: 'multivalued', children: [attr('tags.name', 'tag_name'), attr('tags.source', 'source')] }),
      attr('owner.total', 'total', { kind: 'derived', isStored: true, derivationFormula: 'SUM(values)' }),
      attr('owner.target', 'target_id', { isFK: true, foreignKeyRef: { entityId: 'target', attributeId: 'target.id' } }),
    ]),
    entity('target', 'Target', [attr('target.id', 'target_id', { isPK: true, isUnique: true })]),
    entity('orphan', 'Orphan', [attr('orphan.value', 'value')]),
  ], [relation('owner-target', 'owner', 'target', 'M:N', 'M:N')]);
}

describe('deterministic Schema Review engine', () => {
  it('accepts the pharmacy-chain fixture structure while reporting its explicit multivalued fields and unindexed foreign keys', () => {
    const report = analyzeSchema(pharmacySchema);
    expect(report.issues.some((item) => item.ruleId === 'missing-primary-key')).toBe(false);
    expect(report.issues.some((item) => item.ruleId === 'orphan-entity')).toBe(false);
    expect(report.issues.some((item) => item.ruleId === 'many-to-many-without-junction')).toBe(false);
    expect(report.issues.some((item) => item.ruleId === '1nf-multivalued-attribute')).toBe(true);
    expect(report.issues.some((item) => item.ruleId === 'foreign-key-without-index')).toBe(true);
    expect(pharmacySchema.entities.find((item) => item.id === 'drug')?.isSpecializationOf).toBe('item');
    expect(pharmacySchema.entities.some((item) => item.id === 'order-line' && item.kind === 'associative')).toBe(true);
    expect(pharmacySchema.entities.some((item) => item.id === 'stock' && item.kind === 'associative')).toBe(true);
  });

  it('finds missing keys, orphan entities, M:N links, multivalued attributes, stored derived values and unindexed foreign keys', () => {
    const report = analyzeSchema(fixture());
    const rules = new Set(report.issues.map((item) => item.ruleId));
    expect(rules).toContain('missing-primary-key');
    expect(rules).toContain('orphan-entity');
    expect(rules).toContain('many-to-many-without-junction');
    expect(rules).toContain('1nf-multivalued-attribute');
    expect(rules).toContain('stored-derived-attribute');
    expect(rules).toContain('foreign-key-without-index');
  });

  it('marks 2NF and 3NF as risks only when explicit notes say so; otherwise dependency-based checks remain unknown', () => {
    const entityWithKeys = entity('line', 'Line', [
      attr('line.order', 'order_id', { isPK: true }),
      attr('line.number', 'line_number', { isPK: true }),
      attr('line.price', 'price', { notes: 'partial dependency: depends only on line_number; transitive dependency through another non-key attribute' }),
    ], 'associative');
    const report = analyzeSchema(model([entityWithKeys]));
    expect(report.issues.some((item) => item.ruleId === '2nf-partial-dependency')).toBe(true);
    expect(report.issues.some((item) => item.ruleId === '3nf-transitive-dependency')).toBe(true);
    expect(report.normalForms.second.status).toBe('risk');
    expect(report.normalForms.third.status).toBe('risk');
    const unknown = analyzeSchema(fixture());
    expect(unknown.normalForms.second.status).toBe('unknown');
    expect(unknown.normalForms.third.status).toBe('unknown');
  });

  it('reports FK cycles, duplicate relationships, mixed naming and explicit ambiguous assumptions', () => {
    const a = entity('a', 'A', [
      attr('a.id', 'id', { isPK: true }),
      attr('a.b', 'bId', { isFK: true, foreignKeyRef: { entityId: 'b', attributeId: 'b.id' } }),
      attr('a.created', 'created_at'),
    ]);
    const b = entity('b', 'B', [
      attr('b.id', 'id', { isPK: true }),
      attr('b.a', 'a_id', { isFK: true, foreignKeyRef: { entityId: 'a', attributeId: 'a.id' }, notes: 'Target is provisional; confirm it.' }),
    ]);
    const link = relation('ab', 'a', 'b', '1', '0..N');
    const input = model([a, b], [link, { ...link, id: 'ab-copy' }]);
    input.notes.push('Discount semantics are unresolved.');
    const report = analyzeSchema(input);
    const rules = new Set(report.issues.map((item) => item.ruleId));
    expect(rules).toContain('circular-foreign-key-dependency');
    expect(rules).toContain('redundant-relationship');
    expect(rules).toContain('inconsistent-attribute-naming');
    expect(rules).toContain('ambiguous-input');
  });

  it('previews and applies an atomic 1NF decomposition preserving owner key and composite values', () => {
    const input = fixture();
    const issue = analyzeSchema(input).issues.find((item) => item.ruleId === '1nf-multivalued-attribute');
    expect(issue?.fix).toBeDefined();
    const preview = buildReviewFixPreview(input, issue!.fix!);
    expect(preview?.operations).toHaveLength(3);
    const result = applyPatchOperations(input, preview!.operations);
    expect(result.entities.find((item) => item.id === 'owner')?.attributes.some((attribute) => attribute.id === 'owner.tags')).toBe(false);
    const child = result.entities.find((item) => item.name === 'OwnerTags');
    expect(child?.kind).toBe('associative');
    expect(child?.attributes.filter((attribute) => attribute.isPK)).toHaveLength(3);
    expect(child?.attributes.some((attribute) => attribute.foreignKeyRef?.entityId === 'owner')).toBe(true);
    expect(result.relationships.some((item) => item.to === child?.id)).toBe(true);
    expect(input.entities.find((item) => item.id === 'owner')?.attributes.some((attribute) => attribute.id === 'owner.tags')).toBe(true);
  });

  it('previews an M:N junction that preserves endpoint primary keys and removes the direct relationship', () => {
    const input = fixture();
    const issue = analyzeSchema(input).issues.find((item) => item.ruleId === 'many-to-many-without-junction');
    const preview = buildReviewFixPreview(input, issue!.fix!);
    const result = applyPatchOperations(input, preview!.operations);
    const junction = result.entities.find((item) => item.kind === 'associative' && item.id !== 'owner' && item.id !== 'target');
    expect(junction?.attributes.filter((attribute) => attribute.isPK)).toHaveLength(2);
    expect(junction?.attributes.filter((attribute) => attribute.isFK)).toHaveLength(2);
    expect(result.relationships.some((item) => item.id === 'owner-target')).toBe(false);
    expect(result.relationships.filter((item) => item.from === junction?.id || item.to === junction?.id)).toHaveLength(2);
    expect(analyzeSchema(result).issues.some((item) => item.ruleId === 'many-to-many-without-junction')).toBe(false);
  });

  it('previews metadata-only fixes for a missing FK index and a stored derived value', () => {
    const input = fixture();
    const report = analyzeSchema(input);
    const indexIssue = report.issues.find((item) => item.ruleId === 'foreign-key-without-index')!;
    const derivedIssue = report.issues.find((item) => item.ruleId === 'stored-derived-attribute')!;
    const indexPreview = buildReviewFixPreview(input, indexIssue.fix!)!;
    const indexed = applyPatchOperations(input, indexPreview.operations);
    expect(indexed.entities.find((item) => item.id === 'owner')?.attributes.find((item) => item.id === 'owner.target')?.isIndexed).toBe(true);
    const virtualPreview = buildReviewFixPreview(input, derivedIssue.fix!)!;
    const virtual = applyPatchOperations(input, virtualPreview.operations);
    expect(virtual.entities.find((item) => item.id === 'owner')?.attributes.find((item) => item.id === 'owner.total')?.isStored).toBe(false);
  });
});
