import type { Attribute, SchemaModel } from '../model/types';
import { buildPhysicalSchema, type PhysicalColumn, sqlIdentifier } from './physicalModel';

function escapeString(value: string): string { return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function pascalCase(value: string): string { return sqlIdentifier(value).split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('') || 'Entity'; }
function prismaName(value: string): string { const name = pascalCase(value); return /^[0-9]/.test(name) ? `Model${name}` : name; }

function laravelColumn(column: PhysicalColumn): string {
  const type = column.dataType.toUpperCase();
  let expression: string;
  const sizes = type.match(/\((\d+)(?:\s*,\s*(\d+))?\)/);
  if (/^(BIGINT|BIGSERIAL)/.test(type)) expression = `$table->bigInteger('${escapeString(column.name)}')`;
  else if (/^(SMALLINT|TINYINT)/.test(type)) expression = `$table->smallInteger('${escapeString(column.name)}')`;
  else if (/^(INT|INTEGER|SERIAL)/.test(type)) expression = `$table->integer('${escapeString(column.name)}')`;
  else if (/^(DECIMAL|NUMERIC)/.test(type)) expression = `$table->decimal('${escapeString(column.name)}', ${sizes?.[1] ?? '10'}, ${sizes?.[2] ?? '0'})`;
  else if (/^(BOOL|BOOLEAN)/.test(type)) expression = `$table->boolean('${escapeString(column.name)}')`;
  else if (/^DATE\b/.test(type) && !/TIME/.test(type)) expression = `$table->date('${escapeString(column.name)}')`;
  else if (/^(DATETIME|TIMESTAMP)/.test(type)) expression = `$table->dateTime('${escapeString(column.name)}')`;
  else if (/^(JSON|JSONB)/.test(type)) expression = `$table->json('${escapeString(column.name)}')`;
  else if (/^(TEXT|CLOB)/.test(type)) expression = `$table->text('${escapeString(column.name)}')`;
  else if (/^(BLOB|BYTEA|BINARY)/.test(type)) expression = `$table->binary('${escapeString(column.name)}')`;
  else if (/^ENUM/.test(type) && column.enumValues?.length) expression = `$table->enum('${escapeString(column.name)}', [${column.enumValues.map((value) => `'${escapeString(value)}'`).join(', ')}])`;
  else expression = `$table->string('${escapeString(column.name)}', ${sizes?.[1] ?? '255'})`;
  if (column.isNullable) expression += '->nullable()';
  if (column.isUnique && !column.isPK) expression += '->unique()';
  if (column.isIndexed && !column.isPK && !column.isUnique) expression += '->index()';
  if (column.defaultValue !== undefined && column.defaultValue !== null) expression += `->default('${escapeString(column.defaultValue)}')`;
  return expression + ';';
}

export function generateLaravelMigrations(model: SchemaModel): string {
  const physical = buildPhysicalSchema(model);
  const blocks = physical.tables.map((table) => {
    const lines = [`Schema::create('${escapeString(table.name)}', function (Blueprint $table) {`];
    for (const column of table.columns) lines.push(`    ${laravelColumn(column)}`);
    const primary = table.columns.filter((column) => column.isPK).map((column) => `'${escapeString(column.name)}'`);
    if (primary.length) lines.push(`    $table->primary([${primary.join(', ')}]);`);
    for (const foreignKey of table.foreignKeys) {
      const local = foreignKey.columns.map((name) => `'${escapeString(name)}'`).join(', ');
      const target = foreignKey.targetColumns.map((name) => `'${escapeString(name)}'`).join(', ');
      const targetTable = physical.entityTableNames.get(foreignKey.targetEntityId) ?? sqlIdentifier(foreignKey.targetEntityId);
      lines.push(`    $table->foreign([${local}])->references([${target}])->on('${escapeString(targetTable)}')->onDelete('${foreignKey.onDelete.toLowerCase()}')->onUpdate('${foreignKey.onUpdate.toLowerCase()}');`);
    }
    lines.push(`    // ${table.notes.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /')}`);
    lines.push('});');
    return lines.join('\n');
  });
  return `<?php\n// Powered by MSR_Coder\n\nuse Illuminate\\Database\\Migrations\\Migration;\nuse Illuminate\\Database\\Schema\\Blueprint;\nuse Illuminate\\Support\\Facades\\Schema;\n\nreturn new class extends Migration {\n    public function up(): void\n    {\n${blocks.map((block) => block.split('\n').map((line) => `        ${line}`).join('\n')).join('\n\n')}\n    }\n\n    public function down(): void\n    {\n${physical.tables.slice().reverse().map((table) => `        Schema::dropIfExists('${escapeString(table.name)}');`).join('\n')}\n    }\n};\n`;
}

function prismaType(column: PhysicalColumn): string {
  const type = column.dataType.toUpperCase();
  if (/^(BIGINT|BIGSERIAL)/.test(type)) return 'BigInt';
  if (/^(SMALLINT|TINYINT|INT|INTEGER|SERIAL)/.test(type)) return 'Int';
  if (/^(DECIMAL|NUMERIC)/.test(type)) return 'Decimal';
  if (/^(FLOAT|DOUBLE|REAL)/.test(type)) return 'Float';
  if (/^(BOOL|BOOLEAN)/.test(type)) return 'Boolean';
  if (/^(DATE|DATETIME|TIMESTAMP)/.test(type)) return 'DateTime';
  if (/^(JSON|JSONB)/.test(type)) return 'Json';
  if (/^(BLOB|BYTEA|BINARY)/.test(type)) return 'Bytes';
  return 'String';
}

function prismaAction(action: string): string {
  return ({ 'NO ACTION': 'NoAction', CASCADE: 'Cascade', RESTRICT: 'Restrict', 'SET NULL': 'SetNull' } as Record<string, string>)[action] ?? 'NoAction';
}

export function generatePrismaSchema(model: SchemaModel): string {
  const physical = buildPhysicalSchema(model);
  const modelNames = new Map(physical.tables.map((table) => [table.id, prismaName(table.name)]));
  const blocks = physical.tables.map((table) => {
    const name = modelNames.get(table.id) ?? prismaName(table.name);
    const lines = [`model ${name} {`];
    for (const column of table.columns) {
      const optional = column.isNullable ? '?' : '';
      const directives: string[] = [];
      if (column.isPK && table.columns.filter((item) => item.isPK).length === 1) directives.push('@id');
      if (column.isUnique && !column.isPK) directives.push('@unique');
      if (column.defaultValue !== undefined && column.defaultValue !== null) directives.push(`@default(${JSON.stringify(column.defaultValue)})`);
      if (column.enumValues?.length) directives.push(`// enum values: ${column.enumValues.join(', ')}`);
      lines.push(`  ${sqlIdentifier(column.name)} ${prismaType(column)}${optional}${directives.length ? ` ${directives.join(' ')}` : ''}`);
    }
    const primary = table.columns.filter((column) => column.isPK).map((column) => sqlIdentifier(column.name));
    if (primary.length > 1) lines.push(`  @@id([${primary.join(', ')}])`);
    for (const column of table.columns.filter((item) => item.isIndexed && !item.isPK && !item.isUnique)) lines.push(`  @@index([${sqlIdentifier(column.name)}])`);
    for (const [index, foreignKey] of table.foreignKeys.entries()) {
      const targetModel = modelNames.get(foreignKey.targetEntityId);
      if (!targetModel) continue;
      const targetTable = physical.tables.find((candidate) => candidate.id === foreignKey.targetEntityId);
      const targetAttributes = foreignKey.targetColumns.map((columnName) => targetTable?.columns.find((candidate) => candidate.name === columnName)).filter((column): column is PhysicalColumn => Boolean(column));
      if (!targetAttributes.length) continue;
      const targetFields = targetAttributes.map((column) => sqlIdentifier(column.name));
      const relationName = sqlIdentifier(foreignKey.name);
      const fields = foreignKey.columns.map((column) => sqlIdentifier(column));
      const optional = foreignKey.columns.some((columnName) => table.columns.find((column) => column.name === columnName)?.isNullable) ? '?' : '';
      const deleteAction = prismaAction(foreignKey.onDelete);
      const updateAction = prismaAction(foreignKey.onUpdate);
      lines.push(`  ${sqlIdentifier(`${targetModel.charAt(0).toLowerCase()}${targetModel.slice(1)}_${index}`)} ${targetModel}${optional} @relation("${relationName}", fields: [${fields.join(', ')}], references: [${targetFields.join(', ')}], onDelete: ${deleteAction}, onUpdate: ${updateAction})`);
    }
    lines.push(`  @@map("${table.name}")`, '}');
    return lines.join('\n');
  });
  for (const table of physical.tables) {
    for (const [index, foreignKey] of table.foreignKeys.entries()) {
      const target = physical.tables.find((item) => item.id === foreignKey.targetEntityId);
      if (!target) continue;
      const sourceName = modelNames.get(table.id) ?? prismaName(table.name);
      const targetName = modelNames.get(target.id) ?? prismaName(target.name);
      const relationName = sqlIdentifier(foreignKey.name);
      const relationField = sqlIdentifier(`${sourceName.charAt(0).toLowerCase()}${sourceName.slice(1)}_${index}_rows`);
      const targetBlock = blocks.findIndex((block) => block.startsWith(`model ${targetName} {`));
      const currentBlock = blocks[targetBlock];
      if (targetBlock >= 0 && currentBlock) blocks[targetBlock] = currentBlock.replace(/\n}\s*$/, `\n  ${relationField} ${sourceName}[] @relation("${relationName}")\n}`);
    }
  }
  return `// Powered by MSR_Coder\n${blocks.join('\n\n')}\n`;
}

function dbmlType(column: PhysicalColumn): string {
  return column.dataType.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_(),]/g, '') || 'varchar';
}

export function generateDBML(model: SchemaModel): string {
  const physical = buildPhysicalSchema(model);
  const blocks = physical.tables.map((table) => {
    const lines = [`Table ${table.name} {`];
    for (const column of table.columns) {
      const flags = [column.isPK ? 'pk' : '', column.isUnique && !column.isPK ? 'unique' : '', column.isNullable ? 'null' : 'not null', column.isIndexed ? 'index' : ''].filter(Boolean);
      lines.push(`  ${column.name} ${dbmlType(column)}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
    }
    lines.push('}');
    return lines.join('\n');
  });
  const refs = physical.tables.flatMap((table) => table.foreignKeys.map((foreignKey) => {
    const target = physical.entityTableNames.get(foreignKey.targetEntityId);
    if (!target) return '';
    return `Ref: ${table.name}.${foreignKey.columns.join(', ')} > ${target}.${foreignKey.targetColumns.join(', ')}`;
  })).filter(Boolean);
  return `// Powered by MSR_Coder\n${blocks.join('\n\n')}${refs.length ? `\n\n${refs.join('\n')}` : ''}\n`;
}

function mermaidCardinality(value: string): string {
  if (value === '1') return '||';
  if (value === '0..1') return 'o|';
  if (value === '1..N') return '|{';
  if (value === '0..N') return 'o{';
  return '}o';
}

function mermaidIdentifier(value: string): string { return sqlIdentifier(value); }
function mermaidAttributeType(column: PhysicalColumn): string { return column.dataType.toUpperCase().replace(/[^A-Z0-9_]/g, '') || 'STRING'; }

export function generateMermaid(model: SchemaModel): string {
  const physical = buildPhysicalSchema(model);
  const entityNames = new Map(physical.tables.filter((table) => model.entities.some((entity) => entity.id === table.id)).map((table) => [table.id, mermaidIdentifier(table.name)]));
  const lines = ['%% Powered by MSR_Coder', 'erDiagram'];
  for (const table of physical.tables) {
    lines.push(`  ${mermaidIdentifier(table.name)} {`);
    for (const column of table.columns) {
      const flags = [column.isPK ? ' PK' : '', column.isFK ? ' FK' : '', column.isUnique ? ' UK' : ''].join('');
      lines.push(`    ${mermaidAttributeType(column)} ${mermaidIdentifier(column.name)}${flags}`);
    }
    lines.push('  }');
  }
  for (const relationship of model.relationships) {
    const from = entityNames.get(relationship.from);
    const to = entityNames.get(relationship.to);
    if (!from || !to) continue;
    const label = relationship.label.replace(/["\r\n]+/g, ' ').trim() || 'relates to';
    lines.push(`  ${from} ${mermaidCardinality(relationship.fromCardinality)}--${mermaidCardinality(relationship.toCardinality)} ${to} : "${label}"`);
  }
  for (const specialization of model.specializations) {
    const parent = entityNames.get(specialization.parent);
    if (!parent) continue;
    for (const childId of specialization.children) {
      const child = entityNames.get(childId);
      if (child) lines.push(`  ${parent} ||--|| ${child} : "ISA"`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function findNestedAttribute(entityAttributes: Attribute[], attributeId: string): Attribute | undefined {
  for (const attribute of entityAttributes) {
    if (attribute.id === attributeId) return attribute;
    const child = findNestedAttribute(attribute.children ?? [], attributeId);
    if (child) return child;
  }
  return undefined;
}
