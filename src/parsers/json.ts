import { parseProjectFile } from '../model/io';
import { schemaModelSchema } from '../model/schema';
import type { Attribute, Entity, Relationship, SchemaModel } from '../model/types';
import { ModelBuilder, normalizeName, slugify } from './common';
import type { ParseResult } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asName(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function dataType(raw: Record<string, unknown>): string {
  const value = raw.dataType ?? raw.type ?? raw.format ?? raw.$ref;
  if (Array.isArray(value)) return value.filter((item) => item !== 'null').map((item) => text(item)).join('|') || 'UNKNOWN';
  if (typeof value === 'string') {
    if (value.startsWith('#/')) return `REF(${value.split('/').at(-1)})`;
    return value.toUpperCase() === 'STRING' ? 'VARCHAR' : value.toUpperCase();
  }
  return 'UNKNOWN';
}

function defaultValue(raw: Record<string, unknown>): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(raw, 'default')) return undefined;
  const value = raw.default;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function makeNestedAttribute(
  id: string,
  name: string,
  type: string,
  options: Partial<Attribute> = {},
): Attribute {
  return {
    id,
    name,
    dataType: type || 'UNKNOWN',
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
}

function jsonError(source: string, name: string, message: string): ParseResult {
  const builder = new ModelBuilder(source, name);
  builder.addDiagnostic('error', message, undefined, 'json.invalid');
  return builder.finish('json');
}

function directModelResult(source: string, model: SchemaModel): ParseResult {
  const parsed = schemaModelSchema.safeParse(model);
  if (!parsed.success) return jsonError(source, model.name || 'Imported schema', `The normalized schema is invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  return { format: 'json', model: parsed.data, diagnostics: [], partial: false };
}

function parseGenericTables(root: Record<string, unknown>, source: string, name = ''): ParseResult | undefined {
  const rawTables = root.tables ?? root.entities;
  const tables = Array.isArray(rawTables)
    ? rawTables.map((entry, index) => [text(isRecord(entry) ? entry.name : '', `Table ${index + 1}`), entry] as const)
    : isRecord(rawTables)
      ? Object.entries(rawTables)
      : [];
  if (!tables.length) return undefined;
  const builder = new ModelBuilder(source, name || text(root.name, text(root.title, 'Imported tables')));
  const pending: Array<{ child: Entity; localName: string; parentName: string; parentColumn: string; label: string; nullable: boolean; unique: boolean; identifying: boolean }> = [];

  for (const [key, raw] of tables) {
    if (!isRecord(raw)) {
      builder.addDiagnostic('warning', `Skipped table entry "${key}" because it is not an object.`, undefined, 'partial.json.table');
      continue;
    }
    const tableName = asName(raw.name, key);
    const entity = builder.addEntity(tableName, { ...(text(raw.id) ? { id: text(raw.id) } : {}), kind: raw.kind === 'weak' || raw.kind === 'associative' ? raw.kind : 'strong', notes: text(raw.description, text(raw.notes)) });
    const columns = array(raw.columns ?? raw.attributes);
    const declaredPrimaryKeys = new Set<string>([
      ...array(raw.primaryKey ?? raw.primary_key).map((item) => text(item)),
      ...columns.filter((column) => isRecord(column) && bool(column.isPK ?? column.primaryKey ?? column.primary_key, false)).map((column) => text(isRecord(column) ? column.name : '')),
    ].map(normalizeName));
    for (const columnRaw of columns) {
      if (!isRecord(columnRaw)) continue;
      const columnName = asName(columnRaw.name ?? columnRaw.column, '');
      if (!columnName) { builder.addDiagnostic('warning', `Skipped unnamed column in ${tableName}.`, undefined, 'partial.json.column'); continue; }
      const references = isRecord(columnRaw.references) ? columnRaw.references : isRecord(columnRaw.foreignKey) ? columnRaw.foreignKey : undefined;
      const isPk = declaredPrimaryKeys.has(normalizeName(columnName));
      const columnDefault = defaultValue(columnRaw);
      const attribute = builder.addAttribute(entity, columnName, dataType(columnRaw), {
        ...(text(columnRaw.id) ? { id: text(columnRaw.id) } : {}),
        isPK: isPk,
        isUnique: bool(columnRaw.isUnique ?? columnRaw.unique, false) || isPk,
        isNullable: bool(columnRaw.isNullable ?? columnRaw.nullable, !isPk),
        ...(columnDefault !== undefined ? { defaultValue: columnDefault } : {}),
        kind: ['simple', 'composite', 'multivalued', 'derived'].includes(text(columnRaw.kind)) ? text(columnRaw.kind) as Attribute['kind'] : 'simple',
        ...(text(columnRaw.derivationFormula) ? { derivationFormula: text(columnRaw.derivationFormula) } : {}),
        ...(array(columnRaw.enumValues ?? columnRaw.enum).length ? { enumValues: array(columnRaw.enumValues ?? columnRaw.enum).map((item) => text(item)) } : {}),
        notes: text(columnRaw.description, text(columnRaw.notes)),
      });
      if (references && attribute) {
        pending.push({ child: entity, localName: columnName, parentName: text(references.table ?? references.entity ?? references.model), parentColumn: text(references.column ?? references.attribute, 'id'), label: text(references.name, `references ${text(references.table ?? references.entity)}`), nullable: attribute.isNullable, unique: attribute.isUnique, identifying: attribute.isPK });
      }
    }
    const foreignKeys = array(raw.foreignKeys ?? raw.foreign_keys);
    for (const foreignKey of foreignKeys) {
      if (!isRecord(foreignKey)) continue;
      const localNames = array(foreignKey.columns ?? foreignKey.column).map((value) => text(value)).filter(Boolean);
      const parentName = text(foreignKey.referencedTable ?? foreignKey.referencesTable ?? foreignKey.table ?? (isRecord(foreignKey.references) ? foreignKey.references.table : undefined));
      const parentColumns = array(foreignKey.referencedColumns ?? foreignKey.referencesColumns ?? (isRecord(foreignKey.references) ? foreignKey.references.columns : undefined)).map((value) => text(value));
      if (localNames.length && parentName) for (let index = 0; index < localNames.length; index += 1) {
        pending.push({ child: entity, localName: localNames[index]!, parentName, parentColumn: parentColumns[index] ?? 'id', label: text(foreignKey.name, `references ${parentName}`), nullable: builder.findAttribute(entity, localNames[index]!)?.isNullable ?? true, unique: builder.findAttribute(entity, localNames[index]!)?.isUnique ?? false, identifying: builder.findAttribute(entity, localNames[index]!)?.isPK ?? false });
      }
    }
  }

  for (const relationshipRaw of array(root.relationships)) {
    if (!isRecord(relationshipRaw)) continue;
    const from = builder.getEntity(text(relationshipRaw.from ?? relationshipRaw.source));
    const to = builder.getEntity(text(relationshipRaw.to ?? relationshipRaw.target));
    if (!from || !to) { builder.addDiagnostic('warning', `Skipped JSON relationship "${text(relationshipRaw.name)}" with an unresolved endpoint.`, undefined, 'partial.json.relationship'); continue; }
    builder.addRelationship(from, to, text(relationshipRaw.label ?? relationshipRaw.name, 'related to'), {
      ...(text(relationshipRaw.id) ? { id: text(relationshipRaw.id) } : {}),
      fromCardinality: ['1', '0..1', '1..N', '0..N', 'M:N'].includes(text(relationshipRaw.fromCardinality)) ? text(relationshipRaw.fromCardinality) as Relationship['fromCardinality'] : '1',
      toCardinality: ['1', '0..1', '1..N', '0..N', 'M:N'].includes(text(relationshipRaw.toCardinality)) ? text(relationshipRaw.toCardinality) as Relationship['toCardinality'] : '0..N',
      identifying: bool(relationshipRaw.identifying, false),
      participation: relationshipRaw.participation === 'total' ? 'total' : 'partial',
      notes: text(relationshipRaw.notes),
    });
  }

  for (const reference of pending) {
    const parent = builder.getEntity(reference.parentName);
    const local = builder.findAttribute(reference.child, reference.localName);
    const target = parent ? builder.findAttribute(parent, reference.parentColumn) : undefined;
    if (!parent || !local || !target) {
      builder.addDiagnostic('warning', `JSON reference ${reference.child.name}.${reference.localName} → ${reference.parentName}.${reference.parentColumn} could not be resolved.`, undefined, 'partial.json.unresolved-reference');
      continue;
    }
    local.isFK = true;
    local.foreignKeyRef = { entityId: parent.id, attributeId: target.id };
    builder.addRelationship(parent, reference.child, reference.label, { fromCardinality: reference.nullable ? '0..1' : '1', toCardinality: reference.unique ? '0..1' : '0..N', identifying: reference.identifying, participation: reference.nullable ? 'partial' : 'total' });
  }
  return builder.finish('json');
}

function jsonType(raw: Record<string, unknown>): string {
  const type = raw.type;
  if (Array.isArray(type)) return type.filter((item) => item !== 'null').map((item) => text(item)).join('|') || 'UNKNOWN';
  if (typeof type === 'string') return type.toUpperCase() === 'STRING' ? text(raw.format, 'VARCHAR').toUpperCase() : type.toUpperCase();
  if (raw.$ref) return `REF(${text(raw.$ref).split('/').at(-1)})`;
  return 'UNKNOWN';
}

function resolveRef(ref: string): string {
  return ref.split('/').at(-1)?.replace(/~1/g, '/').replace(/~0/g, '~') ?? ref;
}

function parseJsonSchema(root: Record<string, unknown>, source: string, name = ''): ParseResult | undefined {
  const components = isRecord(root.components) ? root.components : undefined;
  const openApiSchemas = components && isRecord(components.schemas) ? components.schemas : undefined;
  const defs = isRecord(root.$defs) ? root.$defs : isRecord(root.definitions) ? root.definitions : undefined;
  let schemaEntries: Array<[string, unknown]> = [];
  if (openApiSchemas) schemaEntries = Object.entries(openApiSchemas);
  else if (defs) schemaEntries = Object.entries(defs);
  else if (root.type === 'object' || isRecord(root.properties)) schemaEntries = [[text(root.title, name || 'Root'), root]];
  if (!schemaEntries.length) return undefined;

  const builder = new ModelBuilder(source, name || text(root.info && isRecord(root.info) ? root.info.title : undefined, text(root.title, 'JSON schema')));
  const entities = new Map<string, Entity>();
  for (const [schemaName, rawSchema] of schemaEntries) {
    if (!isRecord(rawSchema)) { builder.addDiagnostic('warning', `Skipped schema ${schemaName}; its definition is not an object.`, undefined, 'partial.json.schema'); continue; }
    const entity = builder.addEntity(schemaName, { notes: text(rawSchema.description) });
    entities.set(schemaName, entity);
  }
  const pendingRelations: Array<{ from: Entity; toName: string; property: string; many: boolean; required: boolean }> = [];

  for (const [schemaName, rawSchema] of schemaEntries) {
    if (!isRecord(rawSchema)) continue;
    const entity = entities.get(schemaName);
    if (!entity) continue;
    const required = new Set(array(rawSchema.required).map((item) => text(item)));
    const properties = isRecord(rawSchema.properties) ? rawSchema.properties : {};
    const declaredPK = new Set(array(rawSchema['x-primary-key']).map((item) => text(item)));
    if (typeof rawSchema['x-primary-key'] === 'string') declaredPK.add(text(rawSchema['x-primary-key']));
    for (const [propertyName, rawPropertyValue] of Object.entries(properties)) {
      if (!isRecord(rawPropertyValue)) { builder.addDiagnostic('warning', `Skipped ${schemaName}.${propertyName}; property definition is not an object.`, undefined, 'partial.json.property'); continue; }
      const rawProperty = rawPropertyValue;
      const isArray = rawProperty.type === 'array';
      const items = isRecord(rawProperty.items) ? rawProperty.items : undefined;
      const propertyType = isArray && items ? jsonType(items) : jsonType(rawProperty);
      const rawRef = text(isArray && items ? items.$ref : rawProperty.$ref);
      const resolvedName = rawRef ? resolveRef(rawRef) : '';
      const isRequired = required.has(propertyName);
      const isPK = declaredPK.has(propertyName) || bool(rawProperty['x-primary-key'], false);
      const kind: Attribute['kind'] = rawProperty['x-derived'] || rawProperty.derived ? 'derived' : isArray ? 'multivalued' : rawProperty.type === 'object' ? 'composite' : 'simple';
      let children: Attribute[] | undefined;
      const nestedProperties = isRecord(rawProperty.properties) ? rawProperty.properties : undefined;
      if (kind === 'composite' && nestedProperties) {
        const nestedRequired = new Set(array(rawProperty.required).map((item) => text(item)));
        children = Object.entries(nestedProperties).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])).map(([childName, child]) => makeNestedAttribute(`${entity.id}.${slugify(propertyName)}.${slugify(childName)}`, childName, jsonType(child), { isNullable: !nestedRequired.has(childName), ...(Array.isArray(child.enum) ? { enumValues: child.enum.map((item) => text(item)) } : {}), notes: text(child.description) }));
      }
      const itemEnum = isArray && items && Array.isArray(items.enum) ? items.enum.map((item) => text(item)) : undefined;
      const enumValues = Array.isArray(rawProperty.enum) ? rawProperty.enum.map((item) => text(item)) : itemEnum;
      const propertyDefault = defaultValue(rawProperty);
      const attribute = builder.addAttribute(entity, propertyName, propertyType, {
        isPK,
        isUnique: bool(rawProperty['x-unique'] ?? rawProperty.unique, false) || isPK,
        isNullable: !isRequired,
        kind,
        ...(children ? { children } : {}),
        ...(rawProperty['x-derived'] || rawProperty.derived ? { derivationFormula: text(rawProperty['x-derived'] ?? rawProperty.derivationFormula, 'Derived; formula not declared.') } : {}),
        ...(enumValues ? { enumValues } : {}),
        ...(propertyDefault !== undefined ? { defaultValue: propertyDefault } : {}),
        notes: text(rawProperty.description, rawRef ? `JSON Schema reference: ${rawRef}.` : ''),
      });
      if (attribute && !isPK && attribute.dataType === 'UNKNOWN') builder.addDiagnostic('info', `No primary key or type was declared for ${schemaName}.${propertyName}; it remains editable.`, undefined, 'json.schema.inference');
      if (resolvedName) pendingRelations.push({ from: entity, toName: resolvedName, property: propertyName, many: isArray, required: isRequired });
    }
    const allOf = array(rawSchema.allOf);
    for (const branch of allOf) {
      if (!isRecord(branch) || typeof branch.$ref !== 'string') continue;
      pendingRelations.push({ from: entity, toName: resolveRef(branch.$ref), property: 'extends', many: false, required: true });
    }
    if (array(rawSchema.oneOf ?? rawSchema.anyOf).length) builder.addDiagnostic('warning', `Union variants on ${schemaName} were retained as review notes, not expanded into speculative entities.`, undefined, 'partial.json.union');
  }

  for (const relation of pendingRelations) {
    const target = entities.get(relation.toName) ?? builder.getEntity(relation.toName);
    if (!target) { builder.addDiagnostic('warning', `JSON reference ${relation.from.name}.${relation.property} points to unresolved schema ${relation.toName}.`, undefined, 'partial.json.unresolved-reference'); continue; }
    if (relation.many) builder.addRelationship(relation.from, target, relation.property, { fromCardinality: 'M:N', toCardinality: 'M:N', notes: 'Array reference inferred from JSON Schema; review junction/ownership semantics.' });
    else builder.addRelationship(target, relation.from, relation.property, { fromCardinality: relation.required ? '1' : '0..1', toCardinality: '0..N', participation: relation.required ? 'total' : 'partial' });
  }

  return builder.finish('json');
}

function inferPrimitiveType(key: string, val: unknown): string {
  if (typeof val === 'number') return Number.isInteger(val) ? (/id$/i.test(key) ? 'BIGINT' : 'INTEGER') : 'DECIMAL(10, 2)';
  if (typeof val === 'boolean') return 'BOOLEAN';
  if (typeof val === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(val)) return 'TIMESTAMP';
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return 'DATE';
    const upper = val.trim().toUpperCase();
    if (/^(?:BIGINT|INT|INTEGER|SMALLINT|TINYINT|VARCHAR|CHAR|TEXT|DECIMAL|NUMERIC|FLOAT|DOUBLE|BOOLEAN|BOOL|DATE|DATETIME|TIMESTAMP|UUID|JSON|ENUM)\b/.test(upper)) {
      return upper.split(/\s+PK\b|\s+FK\b|\s+UNIQUE\b/)[0]!.trim();
    }
    return 'VARCHAR(255)';
  }
  return 'VARCHAR(255)';
}

function singularizeName(name: string): string {
  if (/ies$/i.test(name)) return `${name.slice(0, -3)}y`;
  if (/(?:ches|shes|xes|zes|ses)$/i.test(name)) return name.slice(0, -2);
  if (/s$/i.test(name) && !/ss$/i.test(name)) return name.slice(0, -1);
  return name;
}

/**
 * Infers an ERD schema from arbitrary JSON collections/documents (e.g., {"users": [{...}], "orders": [{...}]}
 * or {"users": {"id": "INT PK", "name": "VARCHAR"}}).
 */
function parseSampleJsonCollections(root: Record<string, unknown> | unknown[], source: string, name = ''): ParseResult | undefined {
  const builder = new ModelBuilder(source, name || 'JSON Schema');
  const entries: Array<[string, Record<string, unknown>]> = [];

  if (Array.isArray(root)) {
    const firstObj = root.find(isRecord);
    if (!firstObj) return undefined;
    entries.push([name || 'Record', firstObj]);
  } else {
    for (const [key, val] of Object.entries(root)) {
      if (Array.isArray(val) && val.length > 0 && isRecord(val[0])) {
        const merged: Record<string, unknown> = {};
        for (const item of val.slice(0, 10)) {
          if (isRecord(item)) Object.assign(merged, item);
        }
        entries.push([key, merged]);
      } else if (isRecord(val) && Object.keys(val).length > 0) {
        entries.push([key, val]);
      }
    }
  }

  if (entries.length === 0) return undefined;

  const populateEntityFromObject = (entityName: string, obj: Record<string, unknown>): Entity => {
    const entity = builder.addEntity(entityName);
    for (const [colName, colVal] of Object.entries(obj)) {
      if (Array.isArray(colVal) && colVal.length > 0 && isRecord(colVal[0])) {
        const childEntity = populateEntityFromObject(colName, colVal[0]);
        const parentPk = entity.attributes.find((a) => a.isPK) ?? builder.addAttribute(entity, 'id', 'BIGINT', { isPK: true, isUnique: true, isNullable: false });
        const fkColName = `${singularizeName(entity.name).toLowerCase()}_id`;
        if (parentPk && !builder.findAttribute(childEntity, fkColName)) {
          builder.addAttribute(childEntity, fkColName, parentPk.dataType, {
            isFK: true,
            isNullable: false,
            foreignKeyRef: { entityId: entity.id, attributeId: parentPk.id },
          });
        }
        builder.addRelationship(entity, childEntity, `has ${colName}`, { fromCardinality: '1', toCardinality: '0..N', participation: 'total' });
        continue;
      }
      if (isRecord(colVal)) {
        // Check if it looks like a column descriptor {"type": "VARCHAR", "primaryKey": true}
        if (typeof colVal.type === 'string' || typeof colVal.dataType === 'string') {
          const isPK = Boolean(colVal.primaryKey ?? colVal.isPK ?? colVal.pk);
          builder.addAttribute(entity, colName, dataType(colVal), {
            isPK,
            isUnique: Boolean(colVal.unique ?? colVal.isUnique) || isPK,
            isNullable: colVal.nullable !== undefined ? Boolean(colVal.nullable) : !isPK,
          });
        } else {
          const childEntity = populateEntityFromObject(colName, colVal);
          const childPk = childEntity.attributes.find((a) => a.isPK);
          const fkColName = `${singularizeName(colName).toLowerCase()}_id`;
          if (childPk && !builder.findAttribute(entity, fkColName)) {
            builder.addAttribute(entity, fkColName, childPk.dataType, {
              isFK: true,
              isNullable: true,
              foreignKeyRef: { entityId: childEntity.id, attributeId: childPk.id },
            });
          }
          builder.addRelationship(childEntity, entity, `referenced as ${colName}`, { fromCardinality: '0..1', toCardinality: '0..N' });
        }
        continue;
      }
      const strVal = typeof colVal === 'string' ? colVal : '';
      const isPK = colName.toLowerCase() === 'id' || colName.toLowerCase() === `${singularizeName(entityName).toLowerCase()}_id` || /\bPK\b/i.test(strVal);
      const isUnique = isPK || /\bUNIQUE\b/i.test(strVal) || /email|username|code|slug/i.test(colName);
      builder.addAttribute(entity, colName, inferPrimitiveType(colName, colVal), {
        isPK,
        isUnique,
        isNullable: isPK ? false : colVal === null || !/\bNOT\s+NULL\b/i.test(strVal),
      });
    }
    if (!entity.attributes.some((a) => a.isPK)) {
      entity.attributes.unshift({
        id: `${entity.id}.id`,
        name: 'id',
        dataType: 'BIGINT',
        isPK: true,
        isFK: false,
        isUnique: true,
        isNullable: false,
        kind: 'simple',
        notes: 'Primary key',
      });
    }
    return entity;
  };

  for (const [entityName, obj] of entries) {
    populateEntityFromObject(entityName, obj);
  }

  // Link implicit foreign keys (e.g. customer_id -> customers.id)
  for (const child of builder.model.entities) {
    for (const attr of child.attributes) {
      if (attr.isPK || attr.isFK) continue;
      const match = attr.name.match(/^(.+)_id$/i);
      if (!match) continue;
      const base = match[1]!.toLowerCase();
      const parent = builder.model.entities.find(
        (candidate) =>
          candidate.id !== child.id &&
          (candidate.name.toLowerCase() === base ||
            singularizeName(candidate.name.toLowerCase()) === singularizeName(base)),
      );
      const parentPk = parent?.attributes.find((a) => a.isPK);
      if (parent && parentPk) {
        attr.isFK = true;
        attr.foreignKeyRef = { entityId: parent.id, attributeId: parentPk.id };
        if (!builder.model.relationships.some((r) => r.from === parent.id && r.to === child.id)) {
          builder.addRelationship(parent, child, `${parent.name} → ${child.name}`, {
            fromCardinality: attr.isNullable ? '0..1' : '1',
            toCardinality: attr.isUnique ? '0..1' : '0..N',
            participation: attr.isNullable ? 'partial' : 'total',
          });
        }
      }
    }
  }

  return builder.model.entities.length > 0 ? builder.finish('json') : undefined;
}

export function parseJsonSource(source: string, name = ''): ParseResult {
  let raw: unknown;
  try { raw = JSON.parse(source); }
  catch (error) { return jsonError(source, name, `Invalid JSON: ${error instanceof Error ? error.message.split('\n')[0] : 'unexpected token'}`); }
  if (Array.isArray(raw)) {
    const inferred = parseSampleJsonCollections(raw, source, name);
    if (inferred) return inferred;
    return jsonError(source, name, 'JSON schema input must be a top-level object.');
  }
  if (!isRecord(raw)) return jsonError(source, name, 'JSON schema input must be a top-level object.');

  if (raw.format === 'erdforge') {
    try { return directModelResult(source, parseProjectFile(source)); }
    catch (error) { return jsonError(source, name, error instanceof Error ? error.message : 'Invalid ERDForge project file.'); }
  }
  if (raw.version === 1 && Array.isArray(raw.entities) && Array.isArray(raw.relationships) && Array.isArray(raw.specializations) && Array.isArray(raw.subjectAreas)) {
    return directModelResult(source, raw as unknown as SchemaModel);
  }
  const generic = parseGenericTables(raw, source, name);
  if (generic) return generic;
  const schema = parseJsonSchema(raw, source, name);
  if (schema) return schema;
  const sampleCollections = parseSampleJsonCollections(raw, source, name);
  if (sampleCollections) return sampleCollections;
  const builder = new ModelBuilder(source, name || text(raw.title, 'JSON schema'));
  builder.addDiagnostic('error', 'JSON was valid but contains no ERDForge model, tables/entities, JSON Schema properties, definitions or OpenAPI components.schemas.', undefined, 'json.unsupported');
  return builder.finish('json');
}
