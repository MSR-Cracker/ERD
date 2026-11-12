import { z } from 'zod';
import type { Attribute, Entity, Relationship, SchemaModel, Specialization, SubjectArea } from './types';

const referenceSchema = z.object({ entityId: z.string().min(1), attributeId: z.string().min(1) }).strict();

const attributeBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  dataType: z.string().min(1),
  isPK: z.boolean(),
  isFK: z.boolean(),
  isUnique: z.boolean(),
  isNullable: z.boolean(),
  isIndexed: z.boolean().optional(),
  isStored: z.boolean().optional(),
  defaultValue: z.string().nullable().optional(),
  kind: z.enum(['simple', 'composite', 'multivalued', 'derived']),
  derivationFormula: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
  foreignKeyRef: referenceSchema.optional(),
  notes: z.string(),
}).strict();

export const attributeSchema: z.ZodType<Attribute> = z.lazy(() => attributeBaseSchema.extend({
  children: z.array(attributeSchema).optional(),
}));

export const entitySchema: z.ZodType<Entity> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['strong', 'weak', 'associative']),
  attributes: z.array(attributeSchema),
  isSpecializationOf: z.string().min(1).optional(),
  subjectAreaId: z.string().min(1).optional(),
  notes: z.string(),
}).strict();

export const relationshipSchema: z.ZodType<Relationship> = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  fromCardinality: z.enum(['1', '0..1', '1..N', '0..N', 'M:N']),
  toCardinality: z.enum(['1', '0..1', '1..N', '0..N', 'M:N']),
  identifying: z.boolean(),
  participation: z.enum(['total', 'partial']),
  label: z.string(),
  attributes: z.array(attributeSchema),
  onDelete: z.enum(['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL']),
  onUpdate: z.enum(['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL']),
  notes: z.string(),
}).strict();

export const specializationSchema: z.ZodType<Specialization> = z.object({
  parent: z.string().min(1),
  children: z.array(z.string().min(1)).min(1),
  disjointness: z.enum(['disjoint', 'overlapping']),
  completeness: z.enum(['total', 'partial']),
  notes: z.string(),
}).strict();

export const subjectAreaSchema: z.ZodType<SubjectArea> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  entityIds: z.array(z.string().min(1)),
}).strict();

const modelShape = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  entities: z.array(entitySchema),
  relationships: z.array(relationshipSchema),
  specializations: z.array(specializationSchema),
  subjectAreas: z.array(subjectAreaSchema),
  notes: z.array(z.string()),
}).strict();

function addUniqueIssue(ctx: z.RefinementCtx, message: string, path: (string | number)[] = []): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
}

function walkAttributes(items: Attribute[], visitor: (attribute: Attribute) => void): void {
  for (const attribute of items) {
    visitor(attribute);
    if (attribute.children) walkAttributes(attribute.children, visitor);
  }
}

export const schemaModelSchema: z.ZodType<SchemaModel> = modelShape.superRefine((model, ctx) => {
  const entityIds = new Set<string>();
  for (const [index, entity] of model.entities.entries()) {
    if (entityIds.has(entity.id)) addUniqueIssue(ctx, `Duplicate entity id: ${entity.id}`, ['entities', index, 'id']);
    entityIds.add(entity.id);
    const ids = new Set<string>();
    const checkSiblingNames = (items: Attribute[]) => {
      const siblingNames = new Set<string>();
      for (const attribute of items) {
        const key = attribute.name.trim().toLowerCase();
        if (siblingNames.has(key)) addUniqueIssue(ctx, `Duplicate attribute name "${attribute.name}" in ${entity.name}.`, ['entities', index, 'attributes']);
        siblingNames.add(key);
        if (attribute.children) checkSiblingNames(attribute.children);
      }
    };
    checkSiblingNames(entity.attributes);
    walkAttributes(entity.attributes, (attribute) => {
      if (ids.has(attribute.id)) addUniqueIssue(ctx, `Duplicate attribute id: ${attribute.id}`, ['entities', index, 'attributes']);
      ids.add(attribute.id);
      if (attribute.isFK && !attribute.foreignKeyRef) addUniqueIssue(ctx, `Foreign key ${entity.name}.${attribute.name} has no target reference.`, ['entities', index, 'attributes']);
      if (!attribute.isFK && attribute.foreignKeyRef) addUniqueIssue(ctx, `Attribute ${entity.name}.${attribute.name} has a target reference but is not marked as a foreign key.`, ['entities', index, 'attributes']);
    });
  }
  const relationshipIds = new Set<string>();
  for (const [index, relationship] of model.relationships.entries()) {
    if (relationshipIds.has(relationship.id)) addUniqueIssue(ctx, `Duplicate relationship id: ${relationship.id}`, ['relationships', index, 'id']);
    relationshipIds.add(relationship.id);
    if (!entityIds.has(relationship.from)) addUniqueIssue(ctx, `Relationship ${relationship.label} has a missing source entity.`, ['relationships', index, 'from']);
    if (!entityIds.has(relationship.to)) addUniqueIssue(ctx, `Relationship ${relationship.label} has a missing target entity.`, ['relationships', index, 'to']);
  }
  const allAttributeIds = new Set<string>();
  for (const entity of model.entities) walkAttributes(entity.attributes, (attribute) => allAttributeIds.add(`${entity.id}:${attribute.id}`));
  for (const [index, entity] of model.entities.entries()) {
    if (entity.isSpecializationOf && !entityIds.has(entity.isSpecializationOf)) addUniqueIssue(ctx, `Specialization parent for ${entity.name} does not exist.`, ['entities', index, 'isSpecializationOf']);
    for (const attribute of entity.attributes) {
      walkAttributes([attribute], (child) => {
        if (child.foreignKeyRef && !allAttributeIds.has(`${child.foreignKeyRef.entityId}:${child.foreignKeyRef.attributeId}`)) {
          addUniqueIssue(ctx, `Foreign key target ${child.foreignKeyRef.entityId}.${child.foreignKeyRef.attributeId} does not exist.`, ['entities', index, 'attributes']);
        }
      });
    }
  }
  for (const [index, specialization] of model.specializations.entries()) {
    if (!entityIds.has(specialization.parent)) addUniqueIssue(ctx, `Specialization parent ${specialization.parent} does not exist.`, ['specializations', index, 'parent']);
    for (const child of specialization.children) {
      if (!entityIds.has(child)) addUniqueIssue(ctx, `Specialization child ${child} does not exist.`, ['specializations', index, 'children']);
      if (child === specialization.parent) addUniqueIssue(ctx, 'An entity cannot specialize itself.', ['specializations', index, 'children']);
    }
  }
  const subjectAreaIds = new Set(model.subjectAreas.map((area) => area.id));
  for (const [index, entity] of model.entities.entries()) {
    if (entity.subjectAreaId && !subjectAreaIds.has(entity.subjectAreaId)) addUniqueIssue(ctx, `Subject area for ${entity.name} does not exist.`, ['entities', index, 'subjectAreaId']);
  }
  for (const [index, area] of model.subjectAreas.entries()) {
    for (const entityId of area.entityIds) if (!entityIds.has(entityId)) addUniqueIssue(ctx, `Subject area ${area.name} refers to missing entity ${entityId}.`, ['subjectAreas', index, 'entityIds']);
  }
});

export function validateSchemaModel(input: unknown): { success: true; data: SchemaModel } | { success: false; errors: string[] } {
  const parsed = schemaModelSchema.safeParse(input);
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'schema'}: ${issue.message}`),
  };
}

export class SchemaIntegrityError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join('\n'));
    this.name = 'SchemaIntegrityError';
  }
}

export function assertSchemaModel(input: unknown): SchemaModel {
  const result = validateSchemaModel(input);
  if (!result.success) throw new SchemaIntegrityError(result.errors);
  return result.data;
}
