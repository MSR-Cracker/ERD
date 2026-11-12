import type { SchemaModel } from '../model/types';
import { buildPhysicalSchema, type PhysicalColumn, type PhysicalTable, sqlIdentifier } from './physicalModel';

export type SQLDialect = 'mysql' | 'postgresql' | 'sqlite';

function quote(identifier: string, dialect: SQLDialect): string {
  if (dialect === 'mysql') return `\`${identifier.replace(/`/g, '``')}\``;
  return `"${identifier.replace(/"/g, '""')}"`;
}

function safeType(raw: string, dialect: SQLDialect): string {
  const value = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!/^[A-Z][A-Z0-9_ ]*(?:\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\])?$/.test(value)) {
    return dialect === 'mysql' ? 'VARCHAR(255)' : 'TEXT';
  }
  if (value.startsWith('ENUM') || value.startsWith('SET')) return dialect === 'mysql' ? value : 'TEXT';
  if (dialect === 'sqlite') {
    if (/^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|SERIAL|BIGSERIAL|BOOLEAN)/.test(value)) return 'INTEGER';
    if (/^(DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL)/.test(value)) return 'NUMERIC';
    if (/^(BLOB|BINARY|VARBINARY|BYTEA)/.test(value)) return 'BLOB';
    return 'TEXT';
  }
  if (dialect === 'postgresql') {
    if (value === 'DATETIME') return 'TIMESTAMP';
    if (value === 'TINYINT' || value === 'MEDIUMINT') return 'SMALLINT';
    if (value === 'DOUBLE') return 'DOUBLE PRECISION';
    if (value === 'JSON') return 'JSONB';
  }
  if (dialect === 'mysql') {
    if (value === 'SERIAL') return 'BIGINT UNSIGNED AUTO_INCREMENT';
    if (value === 'JSONB') return 'JSON';
  }
  return value;
}

function quoteDefault(value: string | null | undefined, dialect: SQLDialect): string | undefined {
  if (value == null || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (/^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP\(\))$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
  if (dialect === 'sqlite' && /^(NOW\(\)|CURRENT_TIMESTAMP)$/i.test(trimmed)) return 'CURRENT_TIMESTAMP';
  return `'${trimmed.replace(/'/g, "''")}'`;
}

function columnSql(column: PhysicalColumn, dialect: SQLDialect): string {
  const tokens = [quote(column.name, dialect), safeType(column.dataType, dialect)];
  if (!column.isNullable && !column.isPK) tokens.push('NOT NULL');
  if (column.isUnique && !column.isPK) tokens.push('UNIQUE');
  if (column.enumValues?.length) {
    const values = column.enumValues.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
    tokens.push(`CHECK (${quote(column.name, dialect)} IN (${values}))`);
  }
  const defaultValue = quoteDefault(column.defaultValue, dialect);
  if (defaultValue) tokens.push(`DEFAULT ${defaultValue}`);
  return tokens.join(' ');
}

function createTable(table: PhysicalTable, dialect: SQLDialect, entityTableNames: Map<string, string>): string {
  const definitions = table.columns.map((column) => `  ${columnSql(column, dialect)}`);
  const primary = table.columns.filter((column) => column.isPK).map((column) => quote(column.name, dialect));
  if (primary.length) definitions.push(`  PRIMARY KEY (${primary.join(', ')})`);
  for (const foreignKey of table.foreignKeys) {
    const refTable = quote(entityTableNames.get(foreignKey.targetEntityId) ?? foreignKey.targetEntityId, dialect);
    const own = foreignKey.columns.map((column) => quote(column, dialect)).join(', ');
    const target = foreignKey.targetColumns.map((column) => quote(column, dialect)).join(', ');
    definitions.push(`  CONSTRAINT ${quote(sqlIdentifier(foreignKey.name), dialect)} FOREIGN KEY (${own}) REFERENCES ${refTable} (${target}) ON DELETE ${foreignKey.onDelete} ON UPDATE ${foreignKey.onUpdate}`);
  }
  return `CREATE TABLE ${quote(table.name, dialect)} (\n${definitions.join(',\n')}\n);`;
}

export function generateDDL(model: SchemaModel, dialect: SQLDialect): string {
  const physical = buildPhysicalSchema(model);
  const remaining = new Map(physical.tables.map((table) => [table.id, table]));
  const orderedTables: PhysicalTable[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((table) => table.foreignKeys.every((foreignKey) => foreignKey.targetEntityId === table.id || !remaining.has(foreignKey.targetEntityId)));
    if (ready.length === 0) {
      orderedTables.push(...remaining.values());
      break;
    }
    for (const table of ready) {
      orderedTables.push(table);
      remaining.delete(table.id);
    }
  }
  const statements = orderedTables.map((table) => table.columns.length === 0
    ? `-- Skipped ${table.name}: no exportable attributes were declared.`
    : createTable(table, dialect, physical.entityTableNames));
  for (const table of orderedTables) {
    for (const column of table.columns) {
      if (!column.isIndexed || column.isPK || column.isUnique) continue;
      const indexName = sqlIdentifier(`idx_${table.name}_${column.name}`);
      statements.push(`CREATE INDEX ${quote(indexName, dialect)} ON ${quote(table.name, dialect)} (${quote(column.name, dialect)});`);
    }
  }
  const preamble = dialect === 'sqlite' ? 'PRAGMA foreign_keys = ON;\n\n' : '';
  return `-- Powered by MSR_Coder\n${preamble}${statements.join('\n\n')}\n`;
}

export function generateMySQLDDL(model: SchemaModel): string { return generateDDL(model, 'mysql'); }
export function generatePostgreSQLDDL(model: SchemaModel): string { return generateDDL(model, 'postgresql'); }
export function generateSQLiteDDL(model: SchemaModel): string { return generateDDL(model, 'sqlite'); }
