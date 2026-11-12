import { ModelBuilder, normalizeName } from './common';
import type { ParseResult, SqlDialect } from './types';

interface PendingForeignKey {
  childName: string;
  columns: string[];
  parentName: string;
  parentColumns: string[];
  constraintName: string;
  onDelete: 'NO ACTION' | 'CASCADE' | 'RESTRICT' | 'SET NULL';
  onUpdate: 'NO ACTION' | 'CASCADE' | 'RESTRICT' | 'SET NULL';
}

const IDENTIFIER_WRAPPER = /^[`"\[]|[`"\]]$/g;

function cleanIdent(raw: string): string {
  const parts = raw.trim().split('.');
  const last = parts[parts.length - 1] ?? raw;
  return last.trim().replace(IDENTIFIER_WRAPPER, '').trim();
}

function splitTopLevelCommas(input: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote && input[i + 1] === quote) { i += 1; continue; }
      if (ch === quote && input[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      const slice = input.slice(start, i).trim();
      if (slice) result.push(slice);
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let blockComment = false;
  let lineComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (char === quote && next === quote) { index += 1; continue; }
      if (char === quote && source[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '-' && next === '-') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === '#' && index === 0) { lineComment = true; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === ';') {
      const statement = source.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  const remainder = source.slice(start).trim();
  if (remainder) statements.push(remainder);
  return statements;
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
}

function parseAction(clause: string, kind: 'DELETE' | 'UPDATE'): PendingForeignKey['onDelete'] {
  const match = clause.match(new RegExp(`\\bON\\s+${kind}\\s+(CASCADE|RESTRICT|SET\\s+NULL|NO\\s+ACTION)`, 'i'));
  const raw = match?.[1]?.toUpperCase().replace(/\s+/g, ' ');
  if (raw === 'CASCADE' || raw === 'RESTRICT' || raw === 'SET NULL') return raw;
  return 'NO ACTION';
}

function parseColumnList(raw: string): string[] {
  return splitTopLevelCommas(raw)
    .map((item) => cleanIdent(item.trim().split(/\s+/)[0] ?? ''))
    .filter(Boolean);
}

export function parseSqlDdl(source: string, _dialect: SqlDialect = 'auto', name = ''): ParseResult {
  const builder = new ModelBuilder(source, name);
  const statements = splitStatements(source);
  const pending: PendingForeignKey[] = [];
  const tableAttributes = new Map<string, Map<string, { id: string; name: string; isNullable: boolean; isUnique: boolean; isPK: boolean }>>();

  for (const rawStmt of statements) {
    const stmt = stripComments(rawStmt);
    if (!stmt) continue;

    // Support ALTER TABLE ... ADD [CONSTRAINT ...] FOREIGN KEY (...) REFERENCES ...
    const alterFkMatch = stmt.match(/^ALTER\s+TABLE\s+(?:ONLY\s+)?([^\s]+)\s+ADD\s+(?:CONSTRAINT\s+([^\s]+)\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*(?:\(([^)]+)\))?([\s\S]*)$/i);
    if (alterFkMatch) {
      const childTable = cleanIdent(alterFkMatch[1]!);
      const constraintName = alterFkMatch[2] ? cleanIdent(alterFkMatch[2]) : '';
      const localColumns = parseColumnList(alterFkMatch[3]!);
      const parentName = cleanIdent(alterFkMatch[4]!);
      const parentColumns = alterFkMatch[5] ? parseColumnList(alterFkMatch[5]) : localColumns.map(() => 'id');
      const rest = alterFkMatch[6] ?? '';
      if (childTable && parentName && localColumns.length) {
        pending.push({
          childName: childTable,
          columns: localColumns,
          parentName,
          parentColumns,
          constraintName: constraintName || `${childTable}_${localColumns.join('_')}_fk`,
          onDelete: parseAction(rest, 'DELETE'),
          onUpdate: parseAction(rest, 'UPDATE'),
        });
      }
      continue;
    }

    if (!/^CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(stmt)) {
      if (/^(?:ALTER|DROP|INSERT|UPDATE|DELETE|SELECT|PRAGMA|SET|CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+DATABASE|USE)\b/i.test(stmt)) {
        builder.addDiagnostic('warning', 'Only CREATE TABLE DDL is mapped to entities; another statement was left unchanged.', undefined, 'partial.sql.unsupported');
      } else {
        const line = source.slice(0, source.indexOf(rawStmt)).split('\n').length;
        builder.addDiagnostic('error', `Could not parse SQL statement: ${stmt.slice(0, 80)}`, line, 'partial.sql.syntax');
      }
      continue;
    }

    const headerMatch = stmt.match(/^CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(/i);
    const openParen = stmt.indexOf('(');
    const closeParen = stmt.lastIndexOf(')');
    if (!headerMatch || openParen < 0 || closeParen <= openParen) {
      const line = source.slice(0, source.indexOf(rawStmt)).split('\n').length;
      builder.addDiagnostic('error', 'Could not parse SQL CREATE TABLE statement: unbalanced parentheses or missing table name.', line, 'partial.sql.syntax');
      continue;
    }

    let depth = 0;
    let quote: string | null = null;
    for (let i = openParen; i < stmt.length; i += 1) {
      const ch = stmt[i]!;
      if (quote) {
        if (ch === quote && stmt[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    if (depth !== 0) {
      const line = source.slice(0, source.indexOf(rawStmt)).split('\n').length;
      builder.addDiagnostic('error', 'Could not parse SQL CREATE TABLE statement: unbalanced parentheses.', line, 'partial.sql.syntax');
      continue;
    }

    const tableName = cleanIdent(headerMatch[1]!);
    if (!tableName) {
      builder.addDiagnostic('error', 'A CREATE TABLE statement has no recognizable table name.', undefined, 'partial.sql.table');
      continue;
    }

    const entity = builder.addEntity(tableName);
    const columns = new Map<string, { id: string; name: string; isNullable: boolean; isUnique: boolean; isPK: boolean }>();
    tableAttributes.set(normalizeName(tableName), columns);

    const body = stmt.slice(openParen + 1, closeParen);
    const definitions = splitTopLevelCommas(body);

    for (const def of definitions) {
      const trimmed = def.trim();
      if (!trimmed) continue;

      // Table-level constraints
      const pkConstraint = trimmed.match(/^(?:CONSTRAINT\s+([^\s]+)\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i);
      if (pkConstraint) {
        const localColumns = parseColumnList(pkConstraint[2]!);
        for (const colName of localColumns) {
          const found = columns.get(normalizeName(colName));
          const attribute = found ? builder.findAttribute(entity, found.id) : undefined;
          if (attribute && found) {
            attribute.isPK = true;
            attribute.isUnique = true;
            attribute.isNullable = false;
            found.isPK = true;
            found.isUnique = true;
            found.isNullable = false;
          } else {
            builder.addDiagnostic('warning', `Primary-key column "${colName}" is missing from ${tableName}.`, undefined, 'partial.sql.primary-key');
          }
        }
        continue;
      }

      const uqConstraint = trimmed.match(/^(?:CONSTRAINT\s+([^\s]+)\s+)?UNIQUE(?:\s+(?:KEY|INDEX))?(?:\s+[^\s(]+)?\s*\(([^)]+)\)/i);
      if (uqConstraint) {
        const localColumns = parseColumnList(uqConstraint[2]!);
        for (const colName of localColumns) {
          const found = columns.get(normalizeName(colName));
          const attribute = found ? builder.findAttribute(entity, found.id) : undefined;
          if (attribute && found) {
            attribute.isUnique = true;
            found.isUnique = true;
          }
        }
        continue;
      }

      const fkConstraint = trimmed.match(/^(?:CONSTRAINT\s+([^\s]+)\s+)?FOREIGN\s+KEY(?:\s+[^\s(]+)?\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*(?:\(([^)]+)\))?([\s\S]*)$/i);
      if (fkConstraint) {
        const constraintName = fkConstraint[1] ? cleanIdent(fkConstraint[1]) : '';
        const localColumns = parseColumnList(fkConstraint[2]!);
        const parentName = cleanIdent(fkConstraint[3]!);
        const parentColumns = fkConstraint[4] ? parseColumnList(fkConstraint[4]) : localColumns.map(() => 'id');
        const rest = fkConstraint[5] ?? '';
        if (parentName && localColumns.length) {
          pending.push({
            childName: tableName,
            columns: localColumns,
            parentName,
            parentColumns,
            constraintName: constraintName || `${tableName}_${localColumns.join('_')}_fk`,
            onDelete: parseAction(rest, 'DELETE'),
            onUpdate: parseAction(rest, 'UPDATE'),
          });
        } else {
          builder.addDiagnostic('warning', `Could not resolve a foreign-key definition in ${tableName}.`, undefined, 'partial.sql.foreign-key');
        }
        continue;
      }

      if (/^(?:CONSTRAINT\s+[^\s]+\s+)?CHECK\s*\(/i.test(trimmed) || /^(?:KEY|INDEX|FULLTEXT|SPATIAL)\b/i.test(trimmed)) {
        continue;
      }

      // Column definition
      const colMatch = trimmed.match(/^(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][\w$]*))\s+([\s\S]+)$/);
      if (!colMatch) {
        builder.addDiagnostic('warning', `Skipped unrecognized definition in ${tableName}: ${trimmed.slice(0, 60)}`, undefined, 'partial.sql.column');
        continue;
      }
      const columnName = (colMatch[1] ?? colMatch[2] ?? colMatch[3] ?? colMatch[4] ?? '').trim();
      const rest = colMatch[5]!.trim();

      const typeMatch = rest.match(/^([A-Za-z][A-Za-z0-9_]*(?:\s+PRECISION|\s+VARYING|\s+WITHOUT\s+TIME\s+ZONE|\s+WITH\s+TIME\s+ZONE)?(?:\s*\([^)]*\))?(?:\s+UNSIGNED)?)/i);
      const rawType = typeMatch?.[1]?.trim() ?? 'UNKNOWN';
      const normalizedType = rawType.replace(/\s+UNSIGNED$/i, '').replace(/\s+/g, ' ').toUpperCase();
      const modifiers = rest.slice(rawType.length);

      const notNull = /\bNOT\s+NULL\b/i.test(modifiers);
      const primary = /\bPRIMARY\s+KEY\b/i.test(modifiers) || /\b(?:SERIAL|BIGSERIAL)\b/i.test(normalizedType);
      const unique = /\bUNIQUE\b/i.test(modifiers) || primary;

      let defaultVal: string | null | undefined;
      const defaultMatch = modifiers.match(/\bDEFAULT\s+(?:'((?:''|[^'])*)'|"((?:""|[^"])*)"|([^\s,]+))/i);
      if (defaultMatch) {
        const rawDef = defaultMatch[1] ?? defaultMatch[2] ?? defaultMatch[3] ?? '';
        defaultVal = /^NULL$/i.test(rawDef) ? null : rawDef.replace(/''/g, "'");
      }

      const attribute = builder.addAttribute(entity, columnName, normalizedType, {
        isPK: primary,
        isUnique: unique,
        isNullable: !notNull && !primary,
        ...(defaultVal !== undefined ? { defaultValue: defaultVal } : {}),
      });
      if (attribute) {
        columns.set(normalizeName(columnName), {
          id: attribute.id,
          name: attribute.name,
          isNullable: attribute.isNullable,
          isUnique: attribute.isUnique,
          isPK: attribute.isPK,
        });
      }

      const inlineRef = modifiers.match(/\bREFERENCES\s+([^\s(]+)\s*(?:\(([^)]+)\))?([\s\S]*)$/i);
      if (inlineRef) {
        const parentTable = cleanIdent(inlineRef[1]!);
        const parentCol = inlineRef[2] ? parseColumnList(inlineRef[2])[0] ?? 'id' : 'id';
        const actionTail = inlineRef[3] ?? '';
        pending.push({
          childName: tableName,
          columns: [columnName],
          parentName: parentTable,
          parentColumns: [parentCol],
          constraintName: `${tableName}_${columnName}_fk`,
          onDelete: parseAction(actionTail, 'DELETE'),
          onUpdate: parseAction(actionTail, 'UPDATE'),
        });
      }
    }
  }

  for (const foreignKey of pending) {
    const child = builder.getEntity(foreignKey.childName);
    const parent = builder.getEntity(foreignKey.parentName);
    if (!child || !parent) {
      builder.addDiagnostic('warning', `Foreign key ${foreignKey.constraintName} points to unresolved table "${foreignKey.parentName}".`, undefined, 'partial.sql.unresolved-reference');
      continue;
    }
    const childColumns = tableAttributes.get(normalizeName(foreignKey.childName));
    const parentColumns = tableAttributes.get(normalizeName(foreignKey.parentName));
    const resolved: Array<{ local: NonNullable<ReturnType<typeof builder.findAttribute>>; target: NonNullable<ReturnType<typeof builder.findAttribute>> }> = [];
    for (let index = 0; index < foreignKey.columns.length; index += 1) {
      const localName = foreignKey.columns[index]!;
      const targetName = foreignKey.parentColumns[index] ?? 'id';
      const localMetadata = childColumns?.get(normalizeName(localName));
      const targetMetadata = parentColumns?.get(normalizeName(targetName)) ?? (
        parent.attributes.find((a) => a.isPK)
          ? { id: parent.attributes.find((a) => a.isPK)!.id, name: parent.attributes.find((a) => a.isPK)!.name, isNullable: false, isUnique: true, isPK: true }
          : undefined
      );
      const local = localMetadata ? builder.findAttribute(child, localMetadata.id) : undefined;
      const target = targetMetadata ? builder.findAttribute(parent, targetMetadata.id) : undefined;
      if (!local || !target) {
        builder.addDiagnostic('warning', `Foreign key ${foreignKey.constraintName} could not match ${foreignKey.childName}.${localName} to ${foreignKey.parentName}.${targetName}.`, undefined, 'partial.sql.unresolved-column');
        continue;
      }
      local.isFK = true;
      local.foreignKeyRef = { entityId: parent.id, attributeId: target.id };
      local.notes = local.notes ? `${local.notes} Foreign key: ${parent.name}.${target.name}.` : `Foreign key: ${parent.name}.${target.name}.`;
      resolved.push({ local, target });
    }
    if (resolved.length) {
      const optional = resolved.some(({ local }) => local.isNullable);
      const unique = resolved.every(({ local }) => local.isUnique || local.isPK);
      builder.addRelationship(parent, child, foreignKey.constraintName || `${parent.name} to ${child.name}`, {
        fromCardinality: optional ? '0..1' : '1',
        toCardinality: unique ? '0..1' : '0..N',
        identifying: resolved.some(({ local }) => local.isPK),
        participation: optional ? 'partial' : 'total',
        onDelete: foreignKey.onDelete,
        onUpdate: foreignKey.onUpdate,
      });
    }
  }

  if (!builder.model.entities.length) builder.addDiagnostic('error', 'No CREATE TABLE definitions were found in this input.', undefined, 'partial.sql.empty');
  return builder.finish('sql');
}
