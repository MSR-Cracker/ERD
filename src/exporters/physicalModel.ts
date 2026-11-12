import type { Attribute, Entity, Relationship, SchemaModel } from '../model/types';

export interface PhysicalColumn {
  name: string;
  sourceAttributeId?: string;
  dataType: string;
  isPK: boolean;
  isFK: boolean;
  isUnique: boolean;
  isNullable: boolean;
  isIndexed: boolean;
  defaultValue?: string | null | undefined;
  enumValues?: string[] | undefined;
  foreignKeyRef?: Attribute['foreignKeyRef'];
  derivedFormula?: string;
  notes: string;
}

export interface PhysicalForeignKey {
  name: string;
  columns: string[];
  targetEntityId: string;
  targetColumns: string[];
  onDelete: Relationship['onDelete'];
  onUpdate: Relationship['onUpdate'];
}

export interface PhysicalTable {
  id: string;
  name: string;
  kind: Entity['kind'];
  columns: PhysicalColumn[];
  foreignKeys: PhysicalForeignKey[];
  notes: string;
}

export interface PhysicalSchema {
  tables: PhysicalTable[];
  entityTableNames: Map<string, string>;
  attributeColumnNames: Map<string, Map<string, string>>;
}

export function sqlIdentifier(value: string): string {
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  const safe = normalized || 'unnamed';
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}

function uniqueName(candidate: string, used: Set<string>): string {
  const base = sqlIdentifier(candidate);
  let value = base;
  let suffix = 2;
  while (used.has(value)) value = `${base}_${suffix++}`;
  used.add(value);
  return value;
}

function findAttribute(entity: Entity, attributeId: string): Attribute | undefined {
  const visit = (attributes: Attribute[]): Attribute | undefined => {
    for (const attribute of attributes) {
      if (attribute.id === attributeId) return attribute;
      const child = visit(attribute.children ?? []);
      if (child) return child;
    }
    return undefined;
  };
  return visit(entity.attributes);
}

function findRelationship(model: SchemaModel, from: string, to: string): Relationship | undefined {
  return model.relationships.find((relationship) => (relationship.from === from && relationship.to === to) || (relationship.from === to && relationship.to === from));
}

function flattenAttribute(attribute: Attribute, prefix: string, output: PhysicalColumn[], names: Map<string, string>, used: Set<string>, inherited: { pk?: boolean; nullable?: boolean } = {}): void {
  if (attribute.kind === 'derived' && attribute.isStored !== true) return;
  if (attribute.kind === 'multivalued') return;
  if (attribute.kind === 'composite' && (attribute.children?.length ?? 0) > 0) {
    for (const child of attribute.children ?? []) {
      flattenAttribute(child, `${prefix}${sqlIdentifier(attribute.name)}_`, output, names, used, { pk: inherited.pk || attribute.isPK, nullable: inherited.nullable || attribute.isNullable });
    }
    return;
  }
  const name = uniqueName(`${prefix}${attribute.name}`, used);
  names.set(attribute.id, name);
  output.push({
    name,
    sourceAttributeId: attribute.id,
    dataType: attribute.dataType,
    isPK: inherited.pk === true || attribute.isPK,
    isFK: attribute.isFK,
    isUnique: attribute.isUnique,
    isNullable: inherited.nullable === true || attribute.isNullable,
    isIndexed: attribute.isIndexed === true,
    ...(attribute.defaultValue === undefined ? {} : { defaultValue: attribute.defaultValue }),
    ...(attribute.enumValues ? { enumValues: [...attribute.enumValues] } : {}),
    ...(attribute.foreignKeyRef ? { foreignKeyRef: { ...attribute.foreignKeyRef } } : {}),
    ...(attribute.kind === 'derived' ? { derivedFormula: attribute.derivationFormula ?? '' } : {}),
    notes: attribute.notes,
  });
}

export function buildPhysicalSchema(model: SchemaModel): PhysicalSchema {
  const tables: PhysicalTable[] = [];
  const entityTableNames = new Map<string, string>();
  const attributeColumnNames = new Map<string, Map<string, string>>();
  const usedTableNames = new Set<string>();
  for (const entity of model.entities) entityTableNames.set(entity.id, uniqueName(entity.name, usedTableNames));
  for (const entity of model.entities) {
    const used = new Set<string>();
    const columns: PhysicalColumn[] = [];
    const names = new Map<string, string>();
    for (const attribute of entity.attributes) flattenAttribute(attribute, '', columns, names, used);
    attributeColumnNames.set(entity.id, names);
    const foreignKeys: PhysicalForeignKey[] = [];
    for (const column of columns) {
      if (!column.isFK || !column.foreignKeyRef) continue;
      const target = model.entities.find((candidate) => candidate.id === column.foreignKeyRef?.entityId);
      if (!target) continue;
      const targetName = attributeColumnNames.get(target.id)?.get(column.foreignKeyRef.attributeId);
      const reference = findAttribute(target, column.foreignKeyRef.attributeId);
      if (!targetName && !reference) continue;
      const relation = findRelationship(model, entity.id, target.id);
      foreignKeys.push({
        name: uniqueName(`fk_${entityTableNames.get(entity.id)}_${column.name}`, new Set(foreignKeys.map((foreignKey) => foreignKey.name))),
        columns: [column.name],
        targetEntityId: target.id,
        targetColumns: [targetName ?? sqlIdentifier(reference!.name)],
        onDelete: relation?.onDelete ?? 'NO ACTION',
        onUpdate: relation?.onUpdate ?? 'NO ACTION',
      });
    }
    tables.push({ id: entity.id, name: entityTableNames.get(entity.id)!, kind: entity.kind, columns, foreignKeys, notes: entity.notes });
  }
  for (const entity of model.entities) {
    const ownerTable = tables.find((table) => table.id === entity.id);
    if (!ownerTable) continue;
    const ownerKeys = ownerTable.columns.filter((column) => column.isPK);
    if (ownerKeys.length === 0) continue;
    const addMultivalued = (attribute: Attribute) => {
      if (attribute.kind !== 'multivalued') return;
      const name = uniqueName(`${ownerTable.name}_${attribute.name}`, new Set(tables.map((table) => table.name)));
      const used = new Set<string>();
      const columns: PhysicalColumn[] = ownerKeys.map((key) => {
        const columnName = uniqueName(`owner_${key.name}`, used);
        return { name: columnName, dataType: key.dataType, isPK: true, isFK: true, isUnique: false, isNullable: false, isIndexed: true, notes: `Owner key copied from ${ownerTable.name}.${key.name}.` };
      });
      const values = attribute.children?.length ? attribute.children : [{ ...attribute, id: `${attribute.id}:value`, name: `${attribute.name}_value`, kind: 'simple' as const, children: undefined }];
      for (const value of values) flattenAttribute({ ...value, kind: value.kind === 'composite' ? 'simple' : value.kind, isPK: true, isFK: false, isUnique: false, isNullable: false }, '', columns, new Map(), used);
      const child: PhysicalTable = {
        id: `multivalue:${entity.id}:${attribute.id}`, name, kind: 'associative', columns,
        foreignKeys: [{
          name: `fk_${name}_${ownerTable.name}`,
          columns: columns.slice(0, ownerKeys.length).map((column) => column.name),
          targetEntityId: entity.id,
          targetColumns: ownerKeys.map((column) => column.name),
          onDelete: 'CASCADE', onUpdate: 'CASCADE',
        }],
        notes: `Normalized from ${entity.name}.${attribute.name}.`,
      };
      tables.push(child);
    };
    for (const attribute of entity.attributes) addMultivalued(attribute);
  }
  for (const table of tables) {
    for (const foreignKey of table.foreignKeys) {
      const targetNames = attributeColumnNames.get(foreignKey.targetEntityId);
      const sourceColumn = table.columns.find((column) => column.name === foreignKey.columns[0]);
      const refId = sourceColumn?.foreignKeyRef?.attributeId;
      if (refId && targetNames?.has(refId)) foreignKey.targetColumns = [targetNames.get(refId)!];
    }
  }
  return { tables, entityTableNames, attributeColumnNames };
}
