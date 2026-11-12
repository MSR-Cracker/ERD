import { validateSchemaModel } from '../model/schema';
import type { Attribute, AttributeKind, Cardinality, Entity, EntityKind, Participation, Relationship, SchemaModel } from '../model/types';
import type { ParseDiagnostic, ParseResult, ResolvedParserFormat } from './types';

export interface AttributeOptions {
  id?: string;
  isPK?: boolean;
  isFK?: boolean;
  isUnique?: boolean;
  isNullable?: boolean;
  defaultValue?: string | null;
  kind?: AttributeKind;
  children?: Attribute[];
  derivationFormula?: string;
  enumValues?: string[];
  notes?: string;
  foreignKeyRef?: Attribute['foreignKeyRef'];
}

export interface EntityOptions {
  id?: string;
  kind?: EntityKind;
  notes?: string;
  isSpecializationOf?: string;
}

export interface RelationshipOptions {
  id?: string;
  fromCardinality?: Cardinality;
  toCardinality?: Cardinality;
  identifying?: boolean;
  participation?: Participation;
  notes?: string;
  onDelete?: Relationship['onDelete'];
  onUpdate?: Relationship['onUpdate'];
}

export function slugify(value: string): string {
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return normalized.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'field';
}

export function normalizeName(value: string): string {
  return value.trim().replace(/["'`[\]]/g, '').replace(/\\/g, '').toLowerCase();
}

export function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function stableHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function emptyModel(name: string, source: string): SchemaModel {
  const safeName = name.trim() || 'Imported schema';
  return { version: 1, id: `schema-${stableHash(source)}`, name: safeName, entities: [], relationships: [], specializations: [], subjectAreas: [], notes: [] };
}

export class ModelBuilder {
  readonly model: SchemaModel;
  readonly diagnostics: ParseDiagnostic[] = [];
  private readonly entityByKey = new Map<string, Entity>();
  private readonly entityById = new Map<string, Entity>();
  private readonly relationshipIds = new Set<string>();

  constructor(readonly source: string, name = '') {
    this.model = emptyModel(name || inferTitle(source), source);
  }

  addDiagnostic(severity: ParseDiagnostic['severity'], message: string, line?: number, code?: string): void {
    const item: ParseDiagnostic = { severity, message, ...(line !== undefined ? { line } : {}), ...(code ? { code } : {}) };
    this.diagnostics.push(item);
  }

  addEntity(name: string, options: EntityOptions = {}): Entity {
    const displayName = name.trim().replace(/^[`"'\[]|[`"'\]]$/g, '');
    const key = normalizeName(displayName);
    const existing = this.entityByKey.get(key);
    if (existing) return existing;
    let id = options.id?.trim() || slugify(displayName);
    const base = id;
    let suffix = 2;
    while (this.entityById.has(id)) id = `${base}-${suffix++}`;
    const entity: Entity = {
      id,
      name: displayName || 'Untitled entity',
      kind: options.kind ?? 'strong',
      attributes: [],
      notes: options.notes ?? '',
      ...(options.isSpecializationOf ? { isSpecializationOf: options.isSpecializationOf } : {}),
    };
    this.model.entities.push(entity);
    this.entityByKey.set(key, entity);
    this.entityById.set(entity.id, entity);
    return entity;
  }

  getEntity(nameOrId: string): Entity | undefined {
    return this.entityById.get(nameOrId) ?? this.entityByKey.get(normalizeName(nameOrId));
  }

  findAttribute(entity: Entity, nameOrId: string): Attribute | undefined {
    const key = normalizeName(nameOrId);
    const visit = (items: Attribute[]): Attribute | undefined => {
      for (const attribute of items) {
        if (attribute.id === nameOrId || normalizeName(attribute.name) === key) return attribute;
        const child = attribute.children ? visit(attribute.children) : undefined;
        if (child) return child;
      }
      return undefined;
    };
    return visit(entity.attributes);
  }

  addAttribute(entity: Entity, name: string, dataType = 'UNKNOWN', options: AttributeOptions = {}): Attribute | undefined {
    const displayName = name.trim().replace(/^[`"'\[]|[`"'\]]$/g, '');
    if (!displayName) {
      this.addDiagnostic('warning', `Skipped an unnamed attribute in ${entity.name}.`, undefined, 'attribute.unnamed');
      return undefined;
    }
    const existing = this.findAttribute(entity, displayName);
    if (existing) {
      this.addDiagnostic('warning', `Skipped duplicate attribute "${displayName}" in ${entity.name}.`, undefined, 'attribute.duplicate');
      return existing;
    }
    let id = options.id?.trim() || `${entity.id}.${slugify(displayName)}`;
    const base = id;
    let suffix = 2;
    while (this.findAttribute(entity, id)) id = `${base}-${suffix++}`;
    const attribute: Attribute = {
      id,
      name: displayName,
      dataType: dataType.trim() || 'UNKNOWN',
      isPK: options.isPK ?? false,
      isFK: options.isFK ?? false,
      isUnique: options.isUnique ?? false,
      isNullable: options.isNullable ?? true,
      kind: options.kind ?? 'simple',
      notes: options.notes ?? '',
      ...(options.defaultValue !== undefined ? { defaultValue: options.defaultValue } : {}),
      ...(options.children ? { children: options.children } : {}),
      ...(options.derivationFormula ? { derivationFormula: options.derivationFormula } : {}),
      ...(options.enumValues ? { enumValues: options.enumValues } : {}),
      ...(options.foreignKeyRef ? { foreignKeyRef: options.foreignKeyRef } : {}),
    };
    entity.attributes.push(attribute);
    return attribute;
  }

  addRelationship(from: Entity | string, to: Entity | string, label: string, options: RelationshipOptions = {}): Relationship | undefined {
    const fromEntity = typeof from === 'string' ? this.getEntity(from) : from;
    const toEntity = typeof to === 'string' ? this.getEntity(to) : to;
    if (!fromEntity || !toEntity) {
      this.addDiagnostic('warning', `Could not connect "${typeof from === 'string' ? from : from.name}" to "${typeof to === 'string' ? to : to.name}" because an endpoint is unresolved.`, undefined, 'relationship.unresolved');
      return undefined;
    }
    const labelText = label.trim() || 'related to';
    let id = options.id?.trim() || slugify(`${fromEntity.id}-${toEntity.id}-${labelText}`);
    const base = id;
    let suffix = 2;
    while (this.relationshipIds.has(id)) id = `${base}-${suffix++}`;
    this.relationshipIds.add(id);
    const relationship: Relationship = {
      id,
      from: fromEntity.id,
      to: toEntity.id,
      fromCardinality: options.fromCardinality ?? '1',
      toCardinality: options.toCardinality ?? '0..N',
      identifying: options.identifying ?? false,
      participation: options.participation ?? 'partial',
      label: labelText,
      attributes: [],
      onDelete: options.onDelete ?? 'NO ACTION',
      onUpdate: options.onUpdate ?? 'CASCADE',
      notes: options.notes ?? '',
    };
    this.model.relationships.push(relationship);
    return relationship;
  }

  addSpecialization(parent: Entity, child: Entity, notes = ''): void {
    child.isSpecializationOf = parent.id;
    const current = this.model.specializations.find((item) => item.parent === parent.id);
    if (current) {
      if (!current.children.includes(child.id)) current.children.push(child.id);
    } else {
      this.model.specializations.push({ parent: parent.id, children: [child.id], disjointness: 'disjoint', completeness: 'partial', notes });
    }
  }

  finish(format: ResolvedParserFormat): ParseResult {
    const validation = validateSchemaModel(this.model);
    if (!validation.success) {
      for (const error of validation.errors) this.addDiagnostic('error', error, undefined, 'model.invalid');
    }
    const hasErrors = this.diagnostics.some((item) => item.severity === 'error');
    const partial = hasErrors || this.diagnostics.some((item) => item.severity === 'warning' || item.code?.startsWith('partial.'));
    return { format, model: this.model, diagnostics: [...this.diagnostics], partial };
  }
}

function inferTitle(source: string): string {
  const heading = source.match(/^\s*#{1,2}\s+(.+?)\s*$/m)?.[1];
  if (heading) return heading.replace(/\s+(schema|diagram)$/i, '').trim();
  return 'Imported schema';
}
