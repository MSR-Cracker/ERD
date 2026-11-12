export type EntityKind = 'strong' | 'weak' | 'associative';
export type AttributeKind = 'simple' | 'composite' | 'multivalued' | 'derived';
export type Cardinality = '1' | '0..1' | '1..N' | '0..N' | 'M:N';
export type Participation = 'total' | 'partial';
export type DeleteRule = 'NO ACTION' | 'CASCADE' | 'RESTRICT' | 'SET NULL';
export type UpdateRule = DeleteRule;

export interface RoutePoint {
  x: number;
  y: number;
}

export interface AttributeReference {
  entityId: string;
  attributeId: string;
}

export interface Attribute {
  id: string;
  name: string;
  dataType: string;
  isPK: boolean;
  isFK: boolean;
  isUnique: boolean;
  isNullable: boolean;
  isIndexed?: boolean | undefined;
  isStored?: boolean | undefined;
  defaultValue?: string | null | undefined;
  kind: AttributeKind;
  children?: Attribute[] | undefined;
  derivationFormula?: string | undefined;
  enumValues?: string[] | undefined;
  foreignKeyRef?: AttributeReference | undefined;
  notes: string;
}

export interface Entity {
  id: string;
  name: string;
  kind: EntityKind;
  attributes: Attribute[];
  isSpecializationOf?: string | undefined;
  subjectAreaId?: string | undefined;
  notes: string;
}

export interface Relationship {
  id: string;
  from: string;
  to: string;
  fromCardinality: Cardinality;
  toCardinality: Cardinality;
  identifying: boolean;
  participation: Participation;
  label: string;
  attributes: Attribute[];
  onDelete: DeleteRule;
  onUpdate: UpdateRule;
  notes: string;
}

export interface Specialization {
  parent: string;
  children: string[];
  disjointness: 'disjoint' | 'overlapping';
  completeness: 'total' | 'partial';
  notes: string;
}

export interface SubjectArea {
  id: string;
  name: string;
  color: string;
  entityIds: string[];
}

export interface SchemaModel {
  version: 1;
  id: string;
  name: string;
  entities: Entity[];
  relationships: Relationship[];
  specializations: Specialization[];
  subjectAreas: SubjectArea[];
  notes: string[];
}

export interface SchemaPatch {
  id: string;
  title: string;
  summary: string;
  operations: SchemaPatchOperation[];
  ambiguities: string[];
}

export type SchemaPatchOperation =
  | { op: 'entity.add'; entity: Entity }
  | { op: 'entity.update'; entityId: string; changes: Partial<Pick<Entity, 'name' | 'kind' | 'notes' | 'subjectAreaId' | 'isSpecializationOf'>> }
  | { op: 'entity.delete'; entityId: string }
  | { op: 'attribute.add'; entityId: string; attribute: Attribute; index?: number }
  | { op: 'attribute.update'; entityId: string; attributeId: string; changes: Partial<Omit<Attribute, 'id'>> }
  | { op: 'attribute.delete'; entityId: string; attributeId: string }
  | { op: 'attribute.reorder'; entityId: string; attributeIds: string[] }
  | { op: 'relationship.add'; relationship: Relationship }
  | { op: 'relationship.update'; relationshipId: string; changes: Partial<Omit<Relationship, 'id'>> }
  | { op: 'relationship.delete'; relationshipId: string }
  | { op: 'specialization.set'; parentId: string; value: Specialization | null };

export interface NamedSnapshot {
  id: string;
  name: string;
  createdAt: string;
  schema: SchemaModel;
}

export interface ProjectRecord {
  id: string;
  name: string;
  updatedAt: string;
  schema: SchemaModel;
  snapshots: NamedSnapshot[];
}
