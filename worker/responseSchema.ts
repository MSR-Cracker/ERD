import { z } from 'zod';
import { attributeSchema, entitySchema, relationshipSchema, specializationSchema } from '../src/model/schema';
import { schemaPatchSchema } from '../src/model/patch';
import type { Attribute, Entity, Relationship, SchemaModel, SchemaPatch, SchemaPatchOperation } from '../src/model/types';

type AttributeWire = Omit<Attribute, 'defaultValue' | 'children' | 'derivationFormula' | 'enumValues' | 'foreignKeyRef' | 'isIndexed' | 'isStored'> & {
  isIndexed: boolean;
  isStored: boolean;
  defaultValue: string | null;
  children: AttributeWire[] | null;
  derivationFormula: string | null;
  enumValues: string[] | null;
  foreignKeyRef: Attribute['foreignKeyRef'] | null;
};
type EntityWire = Omit<Entity, 'attributes' | 'isSpecializationOf' | 'subjectAreaId'> & {
  attributes: AttributeWire[];
  isSpecializationOf: string | null;
  subjectAreaId: string | null;
};
type RelationshipWire = Omit<Relationship, 'attributes'> & { attributes: AttributeWire[] };

type JsonSchema = Record<string, unknown>;
const stringSchema: JsonSchema = { type: 'string' };
const booleanSchema: JsonSchema = { type: 'boolean' };
const nullableStringSchema: JsonSchema = { type: ['string', 'null'] };
const nullableBooleanSchema: JsonSchema = { type: ['boolean', 'null'] };
const nullableStringArraySchema: JsonSchema = { type: ['array', 'null'], items: stringSchema };
const nullableRefSchema: JsonSchema = {
  type: ['object', 'null'],
  properties: { entityId: stringSchema, attributeId: stringSchema },
  required: ['entityId', 'attributeId'],
  additionalProperties: false,
};

function objectSchema(properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function attributeJsonSchema(depth = 0): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    id: stringSchema,
    name: stringSchema,
    dataType: stringSchema,
    isPK: booleanSchema,
    isFK: booleanSchema,
    isUnique: booleanSchema,
    isNullable: booleanSchema,
    isIndexed: booleanSchema,
    isStored: booleanSchema,
    defaultValue: nullableStringSchema,
    kind: { type: 'string', enum: ['simple', 'composite', 'multivalued', 'derived'] },
    derivationFormula: nullableStringSchema,
    enumValues: nullableStringArraySchema,
    foreignKeyRef: nullableRefSchema,
    notes: stringSchema,
    children: depth < 2
      ? { type: ['array', 'null'], items: attributeJsonSchema(depth + 1) }
      : { type: 'null' },
  };
  return objectSchema(properties);
}

const entityJsonSchema: JsonSchema = objectSchema({
  id: stringSchema,
  name: stringSchema,
  kind: { type: 'string', enum: ['strong', 'weak', 'associative'] },
  attributes: { type: 'array', items: attributeJsonSchema() },
  isSpecializationOf: nullableStringSchema,
  subjectAreaId: nullableStringSchema,
  notes: stringSchema,
});

const relationshipJsonSchema: JsonSchema = objectSchema({
  id: stringSchema,
  from: stringSchema,
  to: stringSchema,
  fromCardinality: { type: 'string', enum: ['1', '0..1', '1..N', '0..N', 'M:N'] },
  toCardinality: { type: 'string', enum: ['1', '0..1', '1..N', '0..N', 'M:N'] },
  identifying: booleanSchema,
  participation: { type: 'string', enum: ['total', 'partial'] },
  label: stringSchema,
  attributes: { type: 'array', items: attributeJsonSchema() },
  onDelete: { type: 'string', enum: ['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL'] },
  onUpdate: { type: 'string', enum: ['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL'] },
  notes: stringSchema,
});

const specializationJsonSchema: JsonSchema = objectSchema({
  parent: stringSchema,
  children: { type: 'array', items: stringSchema },
  disjointness: { type: 'string', enum: ['disjoint', 'overlapping'] },
  completeness: { type: 'string', enum: ['total', 'partial'] },
  notes: stringSchema,
});

const attributeWireSchema: z.ZodType<AttributeWire> = z.lazy(() => z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  dataType: z.string().min(1).default('VARCHAR(255)'),
  isPK: z.boolean().default(false),
  isFK: z.boolean().default(false),
  isUnique: z.boolean().default(false),
  isNullable: z.boolean().default(true),
  isIndexed: z.boolean().default(false),
  isStored: z.boolean().default(false),
  defaultValue: z.string().nullable().default(null),
  kind: z.enum(['simple', 'composite', 'multivalued', 'derived']).default('simple'),
  children: z.array(attributeWireSchema).nullable().default(null),
  derivationFormula: z.string().nullable().default(null),
  enumValues: z.array(z.string()).nullable().default(null),
  foreignKeyRef: z.object({ entityId: z.string().min(1), attributeId: z.string().min(1) }).strict().nullable().default(null),
  notes: z.string().default(''),
}).strict() as z.ZodType<AttributeWire>);

const entityWireSchema: z.ZodType<EntityWire> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['strong', 'weak', 'associative']).default('strong'),
  attributes: z.array(attributeWireSchema).default([]),
  isSpecializationOf: z.string().nullable().default(null),
  subjectAreaId: z.string().nullable().default(null),
  notes: z.string().default(''),
}).strict();

const relationshipWireSchema: z.ZodType<RelationshipWire> = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  fromCardinality: z.enum(['1', '0..1', '1..N', '0..N', 'M:N']).default('1'),
  toCardinality: z.enum(['1', '0..1', '1..N', '0..N', 'M:N']).default('0..N'),
  identifying: z.boolean().default(false),
  participation: z.enum(['total', 'partial']).default('partial'),
  label: z.string().default('related to'),
  attributes: z.array(attributeWireSchema).default([]),
  onDelete: z.enum(['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL']).default('NO ACTION'),
  onUpdate: z.enum(['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL']).default('CASCADE'),
  notes: z.string().default(''),
}).strict();

const nullableChange = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional();
const changeWireSchema = z.object({
  name: nullableChange(z.string()),
  kind: nullableChange(z.enum(['strong', 'weak', 'associative', 'simple', 'composite', 'multivalued', 'derived'])),
  notes: nullableChange(z.string()),
  subjectAreaId: nullableChange(z.string()),
  isSpecializationOf: nullableChange(z.string()),
  dataType: nullableChange(z.string()),
  isPK: nullableChange(z.boolean()),
  isFK: nullableChange(z.boolean()),
  isUnique: nullableChange(z.boolean()),
  isNullable: nullableChange(z.boolean()),
  isIndexed: nullableChange(z.boolean()),
  isStored: nullableChange(z.boolean()),
  defaultValue: nullableChange(z.string()),
  children: nullableChange(z.array(attributeWireSchema)),
  derivationFormula: nullableChange(z.string()),
  enumValues: nullableChange(z.array(z.string())),
  foreignKeyRef: nullableChange(z.object({ entityId: z.string().min(1), attributeId: z.string().min(1) }).strict()),
  from: nullableChange(z.string()),
  to: nullableChange(z.string()),
  fromCardinality: nullableChange(z.enum(['1', '0..1', '1..N', '0..N', 'M:N'])),
  toCardinality: nullableChange(z.enum(['1', '0..1', '1..N', '0..N', 'M:N'])),
  identifying: nullableChange(z.boolean()),
  participation: nullableChange(z.enum(['total', 'partial'])),
  label: nullableChange(z.string()),
  attributes: nullableChange(z.array(attributeWireSchema)),
  onDelete: nullableChange(z.enum(['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL'])),
  onUpdate: nullableChange(z.enum(['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL'])),
}).strict();

const operationNames = [
  'entity.add', 'entity.update', 'entity.delete',
  'attribute.add', 'attribute.update', 'attribute.delete', 'attribute.reorder',
  'relationship.add', 'relationship.update', 'relationship.delete', 'specialization.set',
] as const;

const operationWireSchema = z.object({
  op: z.enum(operationNames),
  entityId: z.string().nullable().default(null),
  attributeId: z.string().nullable().default(null),
  relationshipId: z.string().nullable().default(null),
  parentId: z.string().nullable().default(null),
  index: z.number().int().nullable().default(null),
  attributeIds: z.array(z.string()).nullable().default(null),
  entity: entityWireSchema.nullable().default(null),
  attribute: attributeWireSchema.nullable().default(null),
  relationship: relationshipWireSchema.nullable().default(null),
  changes: changeWireSchema.nullable().default(null),
  value: specializationSchema.nullable().default(null),
}).strict();

export const geminiPatchWireSchema = z.object({
  id: z.string().min(1).default('ai-patch'),
  title: z.string().min(1).default('AI Schema Proposal'),
  summary: z.string().default('Generated ERD schema changes.'),
  ambiguities: z.array(z.string()).default([]),
  operations: z.array(operationWireSchema).min(1),
}).strict();

const changeJsonProperties: Record<string, JsonSchema> = {
  name: nullableStringSchema,
  kind: { type: ['string', 'null'], enum: ['strong', 'weak', 'associative', 'simple', 'composite', 'multivalued', 'derived', null] },
  notes: nullableStringSchema,
  subjectAreaId: nullableStringSchema,
  isSpecializationOf: nullableStringSchema,
  dataType: nullableStringSchema,
  isPK: nullableBooleanSchema,
  isFK: nullableBooleanSchema,
  isUnique: nullableBooleanSchema,
  isNullable: nullableBooleanSchema,
  isIndexed: nullableBooleanSchema,
  isStored: nullableBooleanSchema,
  defaultValue: nullableStringSchema,
  children: { type: ['array', 'null'], items: attributeJsonSchema(1) },
  derivationFormula: nullableStringSchema,
  enumValues: nullableStringArraySchema,
  foreignKeyRef: nullableRefSchema,
  from: nullableStringSchema,
  to: nullableStringSchema,
  fromCardinality: { type: ['string', 'null'], enum: ['1', '0..1', '1..N', '0..N', 'M:N', null] },
  toCardinality: { type: ['string', 'null'], enum: ['1', '0..1', '1..N', '0..N', 'M:N', null] },
  identifying: nullableBooleanSchema,
  participation: { type: ['string', 'null'], enum: ['total', 'partial', null] },
  label: nullableStringSchema,
  attributes: { type: ['array', 'null'], items: attributeJsonSchema() },
  onDelete: { type: ['string', 'null'], enum: ['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL', null] },
  onUpdate: { type: ['string', 'null'], enum: ['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL', null] },
};

const operationJsonSchema = objectSchema({
  op: { type: 'string', enum: operationNames },
  entityId: nullableStringSchema,
  attributeId: nullableStringSchema,
  relationshipId: nullableStringSchema,
  parentId: nullableStringSchema,
  index: { type: ['integer', 'null'] },
  attributeIds: { type: ['array', 'null'], items: stringSchema },
  entity: { ...entityJsonSchema, type: ['object', 'null'] },
  attribute: { ...attributeJsonSchema(), type: ['object', 'null'] },
  relationship: { ...relationshipJsonSchema, type: ['object', 'null'] },
  changes: { type: ['object', 'null'], properties: changeJsonProperties, additionalProperties: false },
  value: { ...specializationJsonSchema, type: ['object', 'null'] },
});

export const GEMINI_PATCH_RESPONSE_SCHEMA: JsonSchema = objectSchema({
  id: stringSchema,
  title: stringSchema,
  summary: stringSchema,
  ambiguities: { type: 'array', items: stringSchema },
  operations: { type: 'array', minItems: 1, items: operationJsonSchema },
});

function normalizeAttribute(input: AttributeWire): Attribute {
  const hasRef = input.foreignKeyRef !== null && input.foreignKeyRef !== undefined;
  return attributeSchema.parse({
    id: input.id,
    name: input.name,
    dataType: input.dataType,
    isPK: input.isPK,
    isFK: hasRef ? true : false,
    isUnique: input.isUnique || input.isPK,
    isNullable: input.isPK ? false : input.isNullable,
    isIndexed: input.isIndexed,
    isStored: input.isStored,
    defaultValue: input.defaultValue,
    kind: input.kind,
    ...(input.children === null ? {} : { children: input.children.map(normalizeAttribute) }),
    ...(input.derivationFormula === null ? {} : { derivationFormula: input.derivationFormula }),
    ...(input.enumValues === null ? {} : { enumValues: input.enumValues }),
    ...(input.foreignKeyRef === null ? {} : { foreignKeyRef: input.foreignKeyRef }),
    notes: input.notes,
  });
}

function normalizeEntity(input: EntityWire): Entity {
  return entitySchema.parse({
    id: input.id,
    name: input.name,
    kind: input.kind,
    attributes: input.attributes.map(normalizeAttribute),
    ...(input.isSpecializationOf === null ? {} : { isSpecializationOf: input.isSpecializationOf }),
    ...(input.subjectAreaId === null ? {} : { subjectAreaId: input.subjectAreaId }),
    notes: input.notes,
  });
}

function normalizeRelationship(input: RelationshipWire): Relationship {
  return relationshipSchema.parse({ ...input, attributes: input.attributes.map(normalizeAttribute) });
}

function normalizeChanges(changes: Record<string, unknown> | null, operation: string): Record<string, unknown> {
  if (!changes) throw new Error(`The ${operation} proposal is missing its changes object.`);
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      if (operation === 'attribute.update' && key === 'defaultValue') normalized[key] = null;
      else if (['subjectAreaId', 'isSpecializationOf', 'defaultValue', 'derivationFormula', 'enumValues', 'foreignKeyRef', 'children', 'isIndexed', 'isStored'].includes(key)) normalized[key] = undefined;
      continue;
    }
    if (key === 'children' && Array.isArray(value)) normalized[key] = value.map((child) => normalizeAttribute(child as AttributeWire));
    else if (key === 'attributes' && Array.isArray(value)) normalized[key] = value.map((attribute) => normalizeAttribute(attribute as AttributeWire));
    else normalized[key] = value;
  }
  return normalized;
}

function requiredId(value: string | null, operation: string, field: string): string {
  if (!value) throw new Error(`The ${operation} proposal is missing ${field}.`);
  return value;
}

function operationFromWire(item: z.infer<typeof operationWireSchema>): SchemaPatchOperation {
  switch (item.op) {
    case 'entity.add':
      if (!item.entity) throw new Error('entity.add is missing an entity.');
      return { op: item.op, entity: normalizeEntity(item.entity) };
    case 'entity.update':
      return { op: item.op, entityId: requiredId(item.entityId, item.op, 'entityId'), changes: normalizeChanges(item.changes, item.op) as Extract<SchemaPatchOperation, { op: 'entity.update' }>['changes'] };
    case 'entity.delete':
      return { op: item.op, entityId: requiredId(item.entityId, item.op, 'entityId') };
    case 'attribute.add':
      if (!item.attribute) throw new Error('attribute.add is missing an attribute.');
      return { op: item.op, entityId: requiredId(item.entityId, item.op, 'entityId'), attribute: normalizeAttribute(item.attribute), ...(item.index === null ? {} : { index: item.index }) };
    case 'attribute.update':
      return { op: item.op, entityId: requiredId(item.entityId, item.op, 'entityId'), attributeId: requiredId(item.attributeId, item.op, 'attributeId'), changes: normalizeChanges(item.changes, item.op) as Extract<SchemaPatchOperation, { op: 'attribute.update' }>['changes'] };
    case 'attribute.delete':
      return { op: item.op, entityId: requiredId(item.entityId, item.op, 'entityId'), attributeId: requiredId(item.attributeId, item.op, 'attributeId') };
    case 'attribute.reorder':
      if (!item.attributeIds) throw new Error('attribute.reorder is missing attributeIds.');
      return { op: item.op, entityId: requiredId(item.entityId, item.op, 'entityId'), attributeIds: item.attributeIds };
    case 'relationship.add':
      if (!item.relationship) throw new Error('relationship.add is missing a relationship.');
      return { op: item.op, relationship: normalizeRelationship(item.relationship) };
    case 'relationship.update':
      return { op: item.op, relationshipId: requiredId(item.relationshipId, item.op, 'relationshipId'), changes: normalizeChanges(item.changes, item.op) as Extract<SchemaPatchOperation, { op: 'relationship.update' }>['changes'] };
    case 'relationship.delete':
      return { op: item.op, relationshipId: requiredId(item.relationshipId, item.op, 'relationshipId') };
    case 'specialization.set':
      return { op: item.op, parentId: requiredId(item.parentId, item.op, 'parentId'), value: item.value };
  }
}

export function parseGeminiPatch(input: unknown): SchemaPatch {
  const wire = geminiPatchWireSchema.parse(input);
  return schemaPatchSchema.parse({ ...wire, operations: wire.operations.map(operationFromWire) });
}

function coerceFlexibleAttribute(raw: Record<string, unknown>, entityId: string, idx: number): AttributeWire {
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `col_${idx + 1}`;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `${entityId}.${name.toLowerCase()}`;
  const isPK = Boolean(raw.isPK ?? raw.primaryKey ?? raw.pk ?? false);
  const fkRaw = (raw.foreignKeyRef ?? raw.foreignKey ?? null) as Record<string, unknown> | null;
  const foreignKeyRef = fkRaw && typeof fkRaw === 'object' && typeof fkRaw.entityId === 'string' && typeof fkRaw.attributeId === 'string'
    ? { entityId: fkRaw.entityId, attributeId: fkRaw.attributeId }
    : null;
  return {
    id,
    name,
    dataType: typeof raw.dataType === 'string' && raw.dataType.trim() ? raw.dataType.trim() : (typeof raw.type === 'string' ? raw.type : 'VARCHAR(255)'),
    isPK,
    isFK: Boolean(raw.isFK ?? foreignKeyRef !== null),
    isUnique: Boolean(raw.isUnique ?? raw.unique ?? isPK),
    isNullable: isPK ? false : Boolean(raw.isNullable ?? raw.nullable ?? true),
    isIndexed: Boolean(raw.isIndexed ?? false),
    isStored: Boolean(raw.isStored ?? false),
    defaultValue: typeof raw.defaultValue === 'string' ? raw.defaultValue : null,
    kind: raw.kind === 'composite' || raw.kind === 'multivalued' || raw.kind === 'derived' ? raw.kind : 'simple',
    children: Array.isArray(raw.children) ? raw.children.map((c, i) => coerceFlexibleAttribute((c ?? {}) as Record<string, unknown>, id, i)) : null,
    derivationFormula: typeof raw.derivationFormula === 'string' ? raw.derivationFormula : null,
    enumValues: Array.isArray(raw.enumValues) ? raw.enumValues.filter((v): v is string => typeof v === 'string') : null,
    foreignKeyRef,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

function coerceFlexibleEntity(raw: Record<string, unknown>, idx: number): EntityWire {
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Table_${idx + 1}`;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : name.toLowerCase().replace(/[^a-z0-9_]+/gi, '_');
  const rawAttrs = Array.isArray(raw.attributes) ? raw.attributes : (Array.isArray(raw.columns) ? raw.columns : []);
  const attributes = rawAttrs.map((a, i) => coerceFlexibleAttribute((a ?? {}) as Record<string, unknown>, id, i));
  if (attributes.length === 0) {
    attributes.push(coerceFlexibleAttribute({ id: `${id}.id`, name: 'id', dataType: 'BIGINT', isPK: true, isNullable: false }, id, 0));
  }
  return {
    id,
    name,
    kind: raw.kind === 'weak' || raw.kind === 'associative' ? raw.kind : 'strong',
    attributes,
    isSpecializationOf: typeof raw.isSpecializationOf === 'string' ? raw.isSpecializationOf : null,
    subjectAreaId: typeof raw.subjectAreaId === 'string' ? raw.subjectAreaId : null,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

function coerceFlexibleRelationship(raw: Record<string, unknown>, idx: number): RelationshipWire {
  const from = typeof raw.from === 'string' ? raw.from : '';
  const to = typeof raw.to === 'string' ? raw.to : '';
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `rel_${from}_${to}_${idx + 1}`;
  const validCard = (c: unknown, fallback: RelationshipWire['fromCardinality']): RelationshipWire['fromCardinality'] =>
    c === '1' || c === '0..1' || c === '1..N' || c === '0..N' || c === 'M:N' ? c : fallback;
  const validAction = (a: unknown, fallback: RelationshipWire['onDelete']): RelationshipWire['onDelete'] =>
    a === 'NO ACTION' || a === 'CASCADE' || a === 'RESTRICT' || a === 'SET NULL' ? a : fallback;
  return {
    id,
    from,
    to,
    fromCardinality: validCard(raw.fromCardinality, '1'),
    toCardinality: validCard(raw.toCardinality, '0..N'),
    identifying: Boolean(raw.identifying ?? false),
    participation: raw.participation === 'total' ? 'total' : 'partial',
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : `${from} → ${to}`,
    attributes: [],
    onDelete: validAction(raw.onDelete, 'NO ACTION'),
    onUpdate: validAction(raw.onUpdate, 'CASCADE'),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

function coerceFlexibleGeminiJson(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const obj = parsed as Record<string, unknown>;
  const rawOps = Array.isArray(obj.operations) ? obj.operations : [];
  const coercedOps: Array<Record<string, unknown>> = [];

  if (rawOps.length > 0) {
    rawOps.forEach((rawOp, idx) => {
      if (!rawOp || typeof rawOp !== 'object') return;
      const item = rawOp as Record<string, unknown>;
      const op = typeof item.op === 'string' ? item.op : 'entity.add';
      coercedOps.push({
        op,
        entityId: typeof item.entityId === 'string' ? item.entityId : null,
        attributeId: typeof item.attributeId === 'string' ? item.attributeId : null,
        relationshipId: typeof item.relationshipId === 'string' ? item.relationshipId : null,
        parentId: typeof item.parentId === 'string' ? item.parentId : null,
        index: typeof item.index === 'number' ? item.index : null,
        attributeIds: Array.isArray(item.attributeIds) ? item.attributeIds : null,
        entity: item.entity && typeof item.entity === 'object' ? coerceFlexibleEntity(item.entity as Record<string, unknown>, idx) : null,
        attribute: item.attribute && typeof item.attribute === 'object' ? coerceFlexibleAttribute(item.attribute as Record<string, unknown>, String(item.entityId ?? 'entity'), idx) : null,
        relationship: item.relationship && typeof item.relationship === 'object' ? coerceFlexibleRelationship(item.relationship as Record<string, unknown>, idx) : null,
        changes: item.changes && typeof item.changes === 'object' ? item.changes : null,
        value: item.value && typeof item.value === 'object' ? item.value : null,
      });
    });
  } else if (Array.isArray(obj.entities) || Array.isArray(obj.tables)) {
    const ents = (Array.isArray(obj.entities) ? obj.entities : obj.tables) as Array<Record<string, unknown>>;
    ents.forEach((ent, idx) => {
      coercedOps.push({
        op: 'entity.add',
        entityId: null, attributeId: null, relationshipId: null, parentId: null, index: null, attributeIds: null,
        entity: coerceFlexibleEntity(ent, idx),
        attribute: null, relationship: null, changes: null, value: null,
      });
    });
    const rels = (Array.isArray(obj.relationships) ? obj.relationships : []) as Array<Record<string, unknown>>;
    rels.forEach((rel, idx) => {
      coercedOps.push({
        op: 'relationship.add',
        entityId: null, attributeId: null, relationshipId: null, parentId: null, index: null, attributeIds: null,
        entity: null, attribute: null,
        relationship: coerceFlexibleRelationship(rel, idx),
        changes: null, value: null,
      });
    });
  }

  if (coercedOps.length === 0) return parsed;
  return {
    id: typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : 'ai-patch-1',
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : 'AI ERD Proposal',
    summary: typeof obj.summary === 'string' ? obj.summary : 'Generated ERD tables and relationships.',
    ambiguities: Array.isArray(obj.ambiguities) ? obj.ambiguities.filter((a): a is string => typeof a === 'string') : [],
    operations: coercedOps,
  };
}

export function parseGeminiJsonText(text: string): SchemaPatch {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Gemini returned no JSON object.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new Error('Gemini returned malformed JSON. No changes were applied.');
  }
  try {
    return parseGeminiPatch(parsed);
  } catch {
    return parseGeminiPatch(coerceFlexibleGeminiJson(parsed));
  }
}

export function repairAndNormalizePatch(currentSchema: SchemaModel, patch: SchemaPatch): SchemaPatch {
  const cloned = structuredClone(patch);
  const entityMap = new Map<string, Entity>();

  for (const entity of currentSchema.entities) {
    entityMap.set(entity.id, structuredClone(entity));
    entityMap.set(entity.name.toLowerCase(), structuredClone(entity));
  }

  const repairedOps: SchemaPatchOperation[] = [];
  const existingEntityIds = new Set(currentSchema.entities.map((e) => e.id));
  const existingRelIds = new Set(currentSchema.relationships.map((r) => r.id));

  for (const op of cloned.operations) {
    if (op.op === 'entity.add') {
      const entity = op.entity;
      const seenNames = new Set<string>();
      const seenIds = new Set<string>();
      entity.attributes = entity.attributes.filter((attr) => {
        const lower = attr.name.trim().toLowerCase();
        if (!lower || seenNames.has(lower)) return false;
        seenNames.add(lower);
        if (seenIds.has(attr.id)) attr.id = `${entity.id}.${lower}`;
        seenIds.add(attr.id);
        return true;
      });
      if (entity.attributes.length > 0 && !entity.attributes.some((a) => a.isPK)) {
        const idAttr = entity.attributes.find((a) => a.name.toLowerCase() === 'id' || a.name.toLowerCase() === `${entity.name.toLowerCase()}_id`) ?? entity.attributes[0];
        if (idAttr) {
          idAttr.isPK = true;
          idAttr.isUnique = true;
          idAttr.isNullable = false;
        }
      }
      entityMap.set(entity.id, entity);
      entityMap.set(entity.name.toLowerCase(), entity);
      if (existingEntityIds.has(entity.id)) {
        continue;
      }
      existingEntityIds.add(entity.id);
      repairedOps.push(op);
    } else {
      repairedOps.push(op);
    }
  }

  const resolveEntityObj = (idOrName: string): Entity | undefined => {
    return entityMap.get(idOrName) ?? entityMap.get(idOrName.toLowerCase());
  };

  const resolveAttrObj = (entity: Entity, attrIdOrName: string): Attribute | undefined => {
    const lower = attrIdOrName.toLowerCase();
    return (
      entity.attributes.find((a) => a.id === attrIdOrName || a.id.toLowerCase() === lower || a.name.toLowerCase() === lower) ??
      entity.attributes.find((a) => a.isPK) ??
      entity.attributes[0]
    );
  };

  const finalOps: SchemaPatchOperation[] = [];
  for (const op of repairedOps) {
    if (op.op === 'entity.add') {
      for (const attr of op.entity.attributes) {
        if (attr.foreignKeyRef) {
          const targetEntity = resolveEntityObj(attr.foreignKeyRef.entityId);
          const targetAttr = targetEntity ? resolveAttrObj(targetEntity, attr.foreignKeyRef.attributeId) : undefined;
          if (targetEntity && targetAttr) {
            attr.isFK = true;
            attr.foreignKeyRef = { entityId: targetEntity.id, attributeId: targetAttr.id };
          } else {
            attr.isFK = false;
            delete attr.foreignKeyRef;
          }
        } else {
          attr.isFK = false;
        }
      }
      if (op.entity.isSpecializationOf) {
        const parent = resolveEntityObj(op.entity.isSpecializationOf);
        if (parent && parent.id !== op.entity.id) op.entity.isSpecializationOf = parent.id;
        else delete op.entity.isSpecializationOf;
      }
      finalOps.push(op);
    } else if (op.op === 'attribute.add') {
      const owner = resolveEntityObj(op.entityId);
      if (!owner) continue;
      op.entityId = owner.id;
      if (op.attribute.foreignKeyRef) {
        const targetEntity = resolveEntityObj(op.attribute.foreignKeyRef.entityId);
        const targetAttr = targetEntity ? resolveAttrObj(targetEntity, op.attribute.foreignKeyRef.attributeId) : undefined;
        if (targetEntity && targetAttr) {
          op.attribute.isFK = true;
          op.attribute.foreignKeyRef = { entityId: targetEntity.id, attributeId: targetAttr.id };
        } else {
          op.attribute.isFK = false;
          delete op.attribute.foreignKeyRef;
        }
      } else {
        op.attribute.isFK = false;
      }
      owner.attributes.push(op.attribute);
      finalOps.push(op);
    } else if (op.op === 'relationship.add') {
      const fromEnt = resolveEntityObj(op.relationship.from);
      const toEnt = resolveEntityObj(op.relationship.to);
      if (!fromEnt || !toEnt) continue;
      op.relationship.from = fromEnt.id;
      op.relationship.to = toEnt.id;
      if (existingRelIds.has(op.relationship.id)) {
        op.relationship.id = `${op.relationship.id}-${Math.random().toString(36).slice(2, 6)}`;
      }
      existingRelIds.add(op.relationship.id);
      finalOps.push(op);
    } else {
      finalOps.push(op);
    }
  }

  return {
    ...cloned,
    operations: finalOps.length > 0 ? finalOps : cloned.operations,
  };
}
