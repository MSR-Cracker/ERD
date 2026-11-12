import { z } from 'zod';
import { assertSchemaModel, attributeSchema, entitySchema, relationshipSchema, specializationSchema } from './schema';
import type { Attribute, Entity, Relationship, SchemaModel, SchemaPatch, SchemaPatchOperation, Specialization } from './types';

const entityChangesSchema = z.object({
  name: z.string().min(1).optional(),
  kind: z.enum(['strong', 'weak', 'associative']).optional(),
  notes: z.string().optional(),
  subjectAreaId: z.string().min(1).optional(),
  isSpecializationOf: z.string().min(1).optional(),
}).strict();

const attributeChangesSchema = z.object({
  name: z.string().min(1).optional(),
  dataType: z.string().min(1).optional(),
  isPK: z.boolean().optional(),
  isFK: z.boolean().optional(),
  isUnique: z.boolean().optional(),
  isNullable: z.boolean().optional(),
  isIndexed: z.boolean().optional(),
  isStored: z.boolean().optional(),
  defaultValue: z.string().nullable().optional(),
  kind: z.enum(['simple', 'composite', 'multivalued', 'derived']).optional(),
  children: z.array(attributeSchema).optional(),
  derivationFormula: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
  foreignKeyRef: z.object({ entityId: z.string().min(1), attributeId: z.string().min(1) }).strict().optional(),
  notes: z.string().optional(),
}).strict();

const relationshipChangesSchema = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  fromCardinality: z.enum(['1', '0..1', '1..N', '0..N', 'M:N']).optional(),
  toCardinality: z.enum(['1', '0..1', '1..N', '0..N', 'M:N']).optional(),
  identifying: z.boolean().optional(),
  participation: z.enum(['total', 'partial']).optional(),
  label: z.string().optional(),
  attributes: z.array(attributeSchema).optional(),
  onDelete: z.enum(['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL']).optional(),
  onUpdate: z.enum(['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL']).optional(),
  notes: z.string().optional(),
}).strict();

export const patchOperationSchema: z.ZodType<SchemaPatchOperation> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('entity.add'), entity: entitySchema }).strict(),
  z.object({ op: z.literal('entity.update'), entityId: z.string().min(1), changes: entityChangesSchema }).strict(),
  z.object({ op: z.literal('entity.delete'), entityId: z.string().min(1) }).strict(),
  z.object({ op: z.literal('attribute.add'), entityId: z.string().min(1), attribute: attributeSchema, index: z.number().int().nonnegative().optional() }).strict(),
  z.object({ op: z.literal('attribute.update'), entityId: z.string().min(1), attributeId: z.string().min(1), changes: attributeChangesSchema }).strict(),
  z.object({ op: z.literal('attribute.delete'), entityId: z.string().min(1), attributeId: z.string().min(1) }).strict(),
  z.object({ op: z.literal('attribute.reorder'), entityId: z.string().min(1), attributeIds: z.array(z.string().min(1)) }).strict(),
  z.object({ op: z.literal('relationship.add'), relationship: relationshipSchema }).strict(),
  z.object({ op: z.literal('relationship.update'), relationshipId: z.string().min(1), changes: relationshipChangesSchema }).strict(),
  z.object({ op: z.literal('relationship.delete'), relationshipId: z.string().min(1) }).strict(),
  z.object({ op: z.literal('specialization.set'), parentId: z.string().min(1), value: specializationSchema.nullable() }).strict(),
]) as z.ZodType<SchemaPatchOperation>;

export const schemaPatchSchema: z.ZodType<SchemaPatch> = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  operations: z.array(patchOperationSchema).min(1),
  ambiguities: z.array(z.string()),
}).strict();

const clone = <T>(value: T): T => structuredClone(value);

function requireEntity(model: SchemaModel, id: string): Entity {
  const found = model.entities.find((entity) => entity.id === id);
  if (!found) throw new Error(`Entity "${id}" was not found.`);
  return found;
}

function updateAttribute(attributes: Attribute[], id: string, update: (attribute: Attribute) => Attribute): boolean {
  const index = attributes.findIndex((attribute) => attribute.id === id);
  if (index >= 0) {
    attributes[index] = update(attributes[index]!);
    return true;
  }
  for (const attribute of attributes) if (attribute.children && updateAttribute(attribute.children, id, update)) return true;
  return false;
}

function removeAttribute(attributes: Attribute[], id: string): boolean {
  const index = attributes.findIndex((attribute) => attribute.id === id);
  if (index >= 0) {
    attributes.splice(index, 1);
    return true;
  }
  for (const attribute of attributes) if (attribute.children && removeAttribute(attribute.children, id)) return true;
  return false;
}

function applyOperation(model: SchemaModel, operation: SchemaPatchOperation): void {
  switch (operation.op) {
    case 'entity.add': {
      if (model.entities.some((entity) => entity.id === operation.entity.id)) throw new Error(`Entity id "${operation.entity.id}" already exists.`);
      model.entities.push(clone(operation.entity));
      return;
    }
    case 'entity.update': {
      const entity = requireEntity(model, operation.entityId);
      Object.assign(entity, clone(operation.changes));
      return;
    }
    case 'entity.delete': {
      requireEntity(model, operation.entityId);
      model.entities = model.entities.filter((entity) => entity.id !== operation.entityId);
      model.relationships = model.relationships.filter((relationship) => relationship.from !== operation.entityId && relationship.to !== operation.entityId);
      model.specializations = model.specializations
        .filter((specialization) => specialization.parent !== operation.entityId)
        .map((specialization) => ({ ...specialization, children: specialization.children.filter((id) => id !== operation.entityId) }))
        .filter((specialization) => specialization.children.length > 0);
      model.subjectAreas = model.subjectAreas.map((area) => ({ ...area, entityIds: area.entityIds.filter((id) => id !== operation.entityId) }));
      return;
    }
    case 'attribute.add': {
      const entity = requireEntity(model, operation.entityId);
      if (entity.attributes.some((attribute) => attribute.id === operation.attribute.id)) throw new Error(`Attribute id "${operation.attribute.id}" already exists.`);
      const index = Math.min(operation.index ?? entity.attributes.length, entity.attributes.length);
      entity.attributes.splice(index, 0, clone(operation.attribute));
      return;
    }
    case 'attribute.update': {
      const entity = requireEntity(model, operation.entityId);
      const found = updateAttribute(entity.attributes, operation.attributeId, (attribute) => ({ ...attribute, ...clone(operation.changes) }));
      if (!found) throw new Error(`Attribute "${operation.attributeId}" was not found.`);
      return;
    }
    case 'attribute.delete': {
      const entity = requireEntity(model, operation.entityId);
      if (!removeAttribute(entity.attributes, operation.attributeId)) throw new Error(`Attribute "${operation.attributeId}" was not found.`);
      return;
    }
    case 'attribute.reorder': {
      const entity = requireEntity(model, operation.entityId);
      const existing = new Map(entity.attributes.map((attribute) => [attribute.id, attribute]));
      if (operation.attributeIds.length !== existing.size || new Set(operation.attributeIds).size !== existing.size || operation.attributeIds.some((id) => !existing.has(id))) {
        throw new Error('Attribute reordering must name every top-level attribute exactly once.');
      }
      entity.attributes = operation.attributeIds.map((id) => existing.get(id)!);
      return;
    }
    case 'relationship.add': {
      if (model.relationships.some((relationship) => relationship.id === operation.relationship.id)) throw new Error(`Relationship id "${operation.relationship.id}" already exists.`);
      model.relationships.push(clone(operation.relationship));
      return;
    }
    case 'relationship.update': {
      const relationship: Relationship | undefined = model.relationships.find((candidate) => candidate.id === operation.relationshipId);
      if (!relationship) throw new Error(`Relationship "${operation.relationshipId}" was not found.`);
      Object.assign(relationship, clone(operation.changes));
      return;
    }
    case 'relationship.delete': {
      const before = model.relationships.length;
      model.relationships = model.relationships.filter((relationship) => relationship.id !== operation.relationshipId);
      if (model.relationships.length === before) throw new Error(`Relationship "${operation.relationshipId}" was not found.`);
      return;
    }
    case 'specialization.set': {
      requireEntity(model, operation.parentId);
      model.specializations = model.specializations.filter((specialization) => specialization.parent !== operation.parentId);
      const childIds = operation.value?.children ?? [];
      for (const childId of childIds) {
        const child = requireEntity(model, childId);
        if (operation.value) child.isSpecializationOf = operation.parentId;
      }
      if (operation.value) model.specializations.push(clone(operation.value as Specialization));
      for (const entity of model.entities) if (entity.isSpecializationOf === operation.parentId && !childIds.includes(entity.id)) delete entity.isSpecializationOf;
      return;
    }
    default: {
      const exhaustive: never = operation;
      throw new Error(`Unsupported patch operation: ${String(exhaustive)}`);
    }
  }
}

export function applyPatchOperations(model: SchemaModel, operations: SchemaPatchOperation[]): SchemaModel {
  const candidate = clone(model);
  for (const operation of operations) {
    const parsed = patchOperationSchema.safeParse(operation);
    if (!parsed.success) throw new Error(`Invalid ${operation.op} operation: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    applyOperation(candidate, parsed.data);
  }
  return assertSchemaModel(candidate);
}

export function applySchemaPatch(model: SchemaModel, patch: SchemaPatch): SchemaModel {
  const parsed = schemaPatchSchema.safeParse(patch);
  if (!parsed.success) throw new Error(`Invalid schema patch: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  return applyPatchOperations(model, parsed.data.operations);
}
