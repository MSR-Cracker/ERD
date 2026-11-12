import type { Attribute, Entity } from '../model/types';
import { ModelBuilder, normalizeName } from './common';
import type { ParseResult } from './types';

interface PendingRef {
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
  operator: '>' | '<' | '-' | '<>';
  label: string;
}

function extractBlocks(source: string, keyword: 'Table' | 'Enum'): Array<{ name: string; body: string; start: number }> {
  const blocks: Array<{ name: string; body: string; start: number }> = [];
  const expression = new RegExp(`\\b${keyword}\\s+(?:"([^"]+)"|\\x60([^\\x60]+)\\x60|([\\w.-]+))(?:\\s*\\[[^\\]]*\\])?\\s*\\{`, 'g');
  for (const match of source.matchAll(expression)) {
    const name = match[1] ?? match[2] ?? match[3] ?? '';
    const open = match.index + match[0].lastIndexOf('{');
    let depth = 0;
    let quote: string | null = null;
    let close = -1;
    for (let index = open; index < source.length; index += 1) {
      const character = source[index]!;
      if (quote) { if (character === quote && source[index - 1] !== '\\') quote = null; continue; }
      if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
      if (character === '{') depth += 1;
      if (character === '}' && --depth === 0) { close = index; break; }
    }
    if (close >= 0) blocks.push({ name, body: source.slice(open + 1, close), start: match.index });
  }
  return blocks;
}

function splitNameAndOptions(line: string): { name: string; type: string; options: string } | undefined {
  const trimmed = line.trim().replace(/,$/, '');
  const match = trimmed.match(/^(?:"([^"]+)"|`([^`]+)`|([\w.-]+))\s+([^\[]+?)(?:\s*\[([\s\S]*)\])?$/);
  if (!match) return undefined;
  return { name: (match[1] ?? match[2] ?? match[3] ?? '').trim(), type: match[4]!.trim(), options: match[5] ?? '' };
}

function parseDefault(options: string): string | undefined {
  const match = options.match(/\bdefault\s*:\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)"|([^,]+))/i);
  return match ? (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim() : undefined;
}

function parseRef(options: string): { operator: PendingRef['operator']; target: string } | undefined {
  const match = options.match(/\bref\s*:\s*([<>-]{1,2})\s*(?:"([^"]+)"|`([^`]+)`|([\w.-]+))\s*\.\s*(?:"([^"]+)"|`([^`]+)`|([\w.-]+))/i);
  if (!match) return undefined;
  return { operator: match[1] as PendingRef['operator'], target: `${match[2] ?? match[3] ?? match[4]}.${match[5] ?? match[6] ?? match[7]}` };
}

function applyKeyConstraint(builder: ModelBuilder, entity: Entity, columnNames: string[], mode: 'pk' | 'unique'): void {
  if (mode === 'unique' && columnNames.length > 1) {
    for (const name of columnNames) {
      const attribute = builder.findAttribute(entity, name);
      if (attribute) attribute.notes = [attribute.notes, `Member of composite unique constraint (${columnNames.join(', ')}); per-column uniqueness is not implied.`].filter(Boolean).join(' ');
    }
    builder.addDiagnostic('info', `Composite unique constraint on ${entity.name} (${columnNames.join(', ')}) is retained as an attribute note because the model has no explicit index-constraint object.`, undefined, 'dbml.constraint.composite-unique');
    return;
  }
  for (const name of columnNames) {
    const attribute = builder.findAttribute(entity, name);
    if (attribute) {
      if (mode === 'pk') { attribute.isPK = true; attribute.isUnique = true; }
      else attribute.isUnique = true;
    }
  }
}

function tableEntities(source: string, builder: ModelBuilder, enums: Map<string, string[]>): Map<string, Entity> {
  const entities = new Map<string, Entity>();
  for (const table of extractBlocks(source, 'Table')) {
    const entity = builder.addEntity(table.name);
    entities.set(normalizeName(table.name), entity);
    const lines = table.body.split(/\r?\n/);
    let inIndexBlock = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) continue;
      if (/^(?:Indexes|indexes)\s*\{/.test(line)) { inIndexBlock = true; continue; }
      if (inIndexBlock) {
        if (line.includes('}')) inIndexBlock = false;
        continue;
      }
      if (line === '}') continue;
      const parsed = splitNameAndOptions(line);
      if (!parsed) {
        builder.addDiagnostic('warning', `Could not parse DBML declaration in ${table.name}: ${line.slice(0, 90)}`, undefined, 'partial.dbml.line');
        continue;
      }
      const options = parsed.options;
      const typeText = parsed.type.replace(/\s+\/\/.*$/, '').trim();
      const enumName = typeText.startsWith('enum') ? typeText.match(/enum\s+([\w.-]+)/)?.[1] : enums.has(normalizeName(typeText)) ? typeText : undefined;
      const kind = /\bderived\b/i.test(options) ? 'derived' : /\bmultivalued\b/i.test(options) ? 'multivalued' : 'simple';
      const ref = parseRef(options);
      const refTarget = ref?.target.split('.') ?? [];
      const defaultLiteral = parseDefault(options);
      const attribute = builder.addAttribute(entity, parsed.name, enumName ? 'ENUM' : typeText || 'UNKNOWN', {
        isPK: /\bpk\b/i.test(options),
        isUnique: /\bunique\b/i.test(options) || /\bpk\b/i.test(options),
        isNullable: !/\bnot\s+null\b/i.test(options) && !/\bpk\b/i.test(options),
        ...(defaultLiteral !== undefined ? { defaultValue: defaultLiteral } : {}),
        kind,
        ...(enumName && enums.has(normalizeName(enumName)) ? { enumValues: enums.get(normalizeName(enumName))! } : {}),
        ...(kind === 'derived' ? { derivationFormula: options.match(/formula\s*:\s*([^,\]]+)/i)?.[1]?.trim() ?? 'Derived; formula not declared.' } : {}),
        notes: /\bpk\b/i.test(options) ? 'DBML primary-key declaration.' : '',
      });
      if (attribute && /\bindex\b/i.test(options)) attribute.isIndexed = true;
      if (ref && refTarget.length >= 2 && attribute) {
        const [targetTable, targetColumn] = refTarget;
        builder.addDiagnostic('info', `DBML reference ${table.name}.${parsed.name} → ${targetTable}.${targetColumn} will be resolved after all tables are read.`, undefined, 'dbml.reference.pending');
        const targetTableName = targetTable!;
        const targetColumnName = targetColumn!;
        (attribute as Attribute & { __pendingRef?: string }).__pendingRef = `${ref.operator}|${targetTableName}|${targetColumnName}`;
      }
    }
    const indexLines = table.body.match(/(?:Indexes|indexes)\s*\{([\s\S]*?)\}/)?.[1];
    if (indexLines) {
      for (const indexLine of indexLines.split(/\r?\n/)) {
        const columns = indexLine.match(/\(([^)]+)\)/)?.[1]?.split(',').map((item) => item.trim().replace(/^[`"']|[`"']$/g, '')) ?? [];
        const opts = indexLine.match(/\[([^\]]+)\]/)?.[1] ?? '';
        if (/\bpk\b/i.test(opts)) applyKeyConstraint(builder, entity, columns, 'pk');
        else if (/\bunique\b/i.test(opts)) applyKeyConstraint(builder, entity, columns, 'unique');
      }
    }
  }
  return entities;
}

export function parseDbml(source: string, name = ''): ParseResult {
  const builder = new ModelBuilder(source, name);
  const enums = new Map<string, string[]>();
  for (const enumBlock of extractBlocks(source, 'Enum')) {
    enums.set(normalizeName(enumBlock.name), enumBlock.body.split(/\r?\n/).map((line) => line.trim().replace(/[,;]/g, '').match(/^(?:"([^"]+)"|`([^`]+)`|([\w.-]+))/)?.slice(1).find(Boolean) ?? '').filter(Boolean));
  }
  const entities = tableEntities(source, builder, enums);
  const pending: PendingRef[] = [];
  for (const entity of builder.model.entities) {
    for (const attribute of entity.attributes) {
      const marker = (attribute as Attribute & { __pendingRef?: string }).__pendingRef;
      if (!marker) continue;
      delete (attribute as Attribute & { __pendingRef?: string }).__pendingRef;
      const [operator, parentName, parentColumn] = marker.split('|');
      if (operator && parentName && parentColumn) pending.push({ leftTable: entity.name, leftColumn: attribute.name, rightTable: parentName, rightColumn: parentColumn, operator: operator as PendingRef['operator'], label: `${attribute.name} references ${parentName}.${parentColumn}` });
    }
  }
  const refs = /\bRef\s*:\s*(?:"([^"]+)"|`([^`]+)`|([\w.-]+))\s*\.\s*(?:"([^"]+)"|`([^`]+)`|([\w.-]+))\s*(<>|>|<|-)\s*(?:"([^"]+)"|`([^`]+)`|([\w.-]+))\s*\.\s*(?:"([^"]+)"|`([^`]+)`|([\w.-]+))/g;
  for (const match of source.matchAll(refs)) {
    const leftTable = match[1] ?? match[2] ?? match[3] ?? '';
    const leftColumn = match[4] ?? match[5] ?? match[6] ?? '';
    const operator = match[7] as PendingRef['operator'];
    const rightTable = match[8] ?? match[9] ?? match[10] ?? '';
    const rightColumn = match[11] ?? match[12] ?? match[13] ?? '';
    if (!pending.some((item) => normalizeName(item.leftTable) === normalizeName(leftTable) && normalizeName(item.leftColumn) === normalizeName(leftColumn) && normalizeName(item.rightTable) === normalizeName(rightTable) && item.operator === operator)) {
      pending.push({ leftTable, leftColumn, rightTable, rightColumn, operator, label: `${leftColumn} ${operator} ${rightColumn}` });
    }
  }
  for (const reference of pending) {
    const left = entities.get(normalizeName(reference.leftTable));
    const right = entities.get(normalizeName(reference.rightTable));
    const leftAttribute = left ? builder.findAttribute(left, reference.leftColumn) : undefined;
    const rightAttribute = right ? builder.findAttribute(right, reference.rightColumn) : undefined;
    if (!left || !right || !leftAttribute || !rightAttribute) {
      builder.addDiagnostic('warning', `DBML reference ${reference.leftTable}.${reference.leftColumn} ${reference.operator} ${reference.rightTable}.${reference.rightColumn} could not be fully resolved.`, undefined, 'partial.dbml.reference');
      continue;
    }
    if (reference.operator === '<>') {
      builder.addRelationship(left, right, reference.label, { fromCardinality: 'M:N', toCardinality: 'M:N', notes: 'DBML M:N reference is conceptual; a physical junction table was not supplied.' });
      builder.addDiagnostic('warning', `Many-to-many DBML reference ${left.name} ↔ ${right.name} has no explicit junction table.`, undefined, 'dbml.missing-junction');
      continue;
    }
    let parent: Entity;
    let child: Entity;
    let parentAttribute: Attribute;
    let childAttribute: Attribute;
    if (reference.operator === '>') {
      child = left; childAttribute = leftAttribute; parent = right; parentAttribute = rightAttribute;
    } else {
      parent = left; parentAttribute = leftAttribute; child = right; childAttribute = rightAttribute;
    }
    childAttribute.isFK = true;
    childAttribute.foreignKeyRef = { entityId: parent.id, attributeId: parentAttribute.id };
    const oneToOne = reference.operator === '-' || childAttribute.isUnique || childAttribute.isPK;
    builder.addRelationship(parent, child, reference.label, {
      fromCardinality: childAttribute.isNullable ? '0..1' : '1',
      toCardinality: oneToOne ? '0..1' : '0..N',
      identifying: childAttribute.isPK,
      participation: childAttribute.isNullable ? 'partial' : 'total',
    });
  }
  if (!builder.model.entities.length) builder.addDiagnostic('error', 'No DBML Table declarations were found.', undefined, 'partial.dbml.empty');
  if (!source.trim()) builder.addDiagnostic('error', 'DBML input is empty.', undefined, 'partial.dbml.empty');
  return builder.finish('dbml');
}
