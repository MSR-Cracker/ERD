import { ModelBuilder } from './common';
import type { Entity, Attribute } from '../model/types';
import type { ParseResult } from './types';

interface PendingReference {
  childName: string;
  localColumn: string;
  parentName: string;
  parentColumn: string;
  label: string;
  nullable: boolean;
  unique: boolean;
  identifying: boolean;
  onDelete: 'NO ACTION' | 'CASCADE' | 'RESTRICT' | 'SET NULL';
  onUpdate: 'NO ACTION' | 'CASCADE' | 'RESTRICT' | 'SET NULL';
}

const TYPE_MAP: Record<string, string> = {
  id: 'BIGINT', bigIncrements: 'BIGINT', increments: 'INTEGER', foreignId: 'BIGINT', unsignedBigInteger: 'BIGINT',
  bigInteger: 'BIGINT', integer: 'INTEGER', unsignedInteger: 'INTEGER', smallInteger: 'SMALLINT', tinyInteger: 'TINYINT',
  string: 'VARCHAR', char: 'CHAR', text: 'TEXT', mediumText: 'TEXT', longText: 'TEXT',
  decimal: 'DECIMAL', unsignedDecimal: 'DECIMAL', float: 'FLOAT', double: 'DOUBLE', boolean: 'BOOLEAN',
  date: 'DATE', dateTime: 'DATETIME', timestamp: 'TIMESTAMP', time: 'TIME', year: 'YEAR',
  uuid: 'UUID', ulid: 'CHAR(26)', json: 'JSON', jsonb: 'JSONB', enum: 'ENUM', binary: 'BLOB',
};

function verifyPhpSyntax(source: string): string | null {
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (ch === quote && source[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === '#') { lineComment = true; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '{') braceDepth += 1;
    else if (ch === '}') { braceDepth -= 1; if (braceDepth < 0) return 'Unmatched closing brace "}"'; }
    else if (ch === '(') parenDepth += 1;
    else if (ch === ')') { parenDepth -= 1; if (parenDepth < 0) return 'Unmatched closing parenthesis ")"'; }
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']') { bracketDepth -= 1; if (bracketDepth < 0) return 'Unmatched closing bracket "]"'; }
  }
  if (quote) return `Unterminated string literal (${quote})`;
  if (blockComment) return 'Unterminated block comment';
  if (braceDepth !== 0) return 'Unclosed brace "{" in PHP source';
  if (parenDepth !== 0) return 'Unclosed parenthesis "(" in PHP source';
  if (bracketDepth !== 0) return 'Unclosed bracket "[" in PHP source';
  return null;
}

function camelToSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/\\/g, '').toLowerCase();
}

function pluralize(value: string): string {
  if (value.endsWith('y') && !/[aeiou]y$/.test(value)) return `${value.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(value)) return `${value}es`;
  return `${value}s`;
}

function singularize(value: string): string {
  if (value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (/(ches|shes|xes|zes)$/.test(value)) return value.slice(0, -2);
  if (value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1);
  return value;
}

function quotedArgument(args: string): string | undefined {
  const match = args.trim().match(/^(['"])((?:\\.|(?!\1).)*)\1/s);
  return match?.[2]?.replace(/\\(['"\\])/g, '$1');
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index + 1] === quote) { index += 1; continue; }
      if (character === quote && value[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '[' || character === '(' || character === '{') depth += 1;
    if (character === ']' || character === ')' || character === '}') depth -= 1;
    if (character === ',' && depth === 0) { parts.push(value.slice(start, index).trim()); start = index + 1; }
  }
  const last = value.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function phpType(method: string, args: string): string {
  const base = TYPE_MAP[method] ?? 'UNKNOWN';
  if (method === 'string' || method === 'char') {
    const length = splitTopLevel(args)[1]?.trim();
    return `${base}(${/^\d+$/.test(length ?? '') ? length : '255'})`;
  }
  if (method === 'decimal' || method === 'unsignedDecimal') {
    const parts = splitTopLevel(args).slice(1, 3).map((part) => part.trim()).filter((part) => /^\d+$/.test(part));
    return `${base}(${parts.length ? parts.join(',') : '8,2'})`;
  }
  return base;
}

function ruleFromChain(chain: string, name: 'onDelete' | 'onUpdate'): PendingReference['onDelete'] {
  if (name === 'onDelete' && /->cascadeOnDelete\s*\(/i.test(chain)) return 'CASCADE';
  if (name === 'onDelete' && /->restrictOnDelete\s*\(/i.test(chain)) return 'RESTRICT';
  if (name === 'onDelete' && /->nullOnDelete\s*\(/i.test(chain)) return 'SET NULL';
  if (name === 'onUpdate' && /->cascadeOnUpdate\s*\(/i.test(chain)) return 'CASCADE';
  if (name === 'onUpdate' && /->restrictOnUpdate\s*\(/i.test(chain)) return 'RESTRICT';
  const method = name === 'onDelete' ? 'onDelete' : 'onUpdate';
  const match = chain.match(new RegExp(`->${method}\\s*\\(\\s*['"](cascade|restrict|set null|no action)['"]`, 'i'));
  const rule = match?.[1]?.toUpperCase().replace(/_/g, ' ');
  if (rule === 'CASCADE' || rule === 'RESTRICT' || rule === 'SET NULL') return rule;
  return 'NO ACTION';
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (lineComment) { if (character === '\n') lineComment = false; continue; }
    if (blockComment) { if (character === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (character === quote && next === quote) { index += 1; continue; }
      if (character === quote && source[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (character === '#') { lineComment = true; continue; }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

function extractBlocks(source: string, expression: RegExp): Array<{ match: RegExpExecArray; body: string }> {
  const blocks: Array<{ match: RegExpExecArray; body: string }> = [];
  for (const match of source.matchAll(expression)) {
    const open = match.index + match[0].lastIndexOf('{');
    const close = findMatchingBrace(source, open);
    if (close < 0) continue;
    blocks.push({ match, body: source.slice(open + 1, close) });
  }
  return blocks;
}

function addLaravelColumn(builder: ModelBuilder, entity: Entity, method: string, args: string, chain: string): void {
  const values = splitTopLevel(args);
  const first = values[0] ?? '';
  const name = ['id', 'bigIncrements', 'increments', 'timestamps', 'timestampsTz', 'softDeletes', 'softDeletesTz', 'rememberToken'].includes(method)
    ? (quotedArgument(first) ?? (method === 'id' || method === 'bigIncrements' || method === 'increments' ? 'id' : ''))
    : quotedArgument(first);
  if (method === 'timestamps' || method === 'timestampsTz') {
    builder.addAttribute(entity, 'created_at', 'TIMESTAMP', { isNullable: true, notes: 'Generated by Laravel timestamps().' });
    builder.addAttribute(entity, 'updated_at', 'TIMESTAMP', { isNullable: true, notes: 'Generated by Laravel timestamps().' });
    return;
  }
  if (method === 'softDeletes' || method === 'softDeletesTz') {
    builder.addAttribute(entity, 'deleted_at', 'TIMESTAMP', { isNullable: true, notes: 'Generated by Laravel softDeletes().' });
    return;
  }
  if (method === 'rememberToken') {
    builder.addAttribute(entity, name || 'remember_token', 'VARCHAR(100)', { isNullable: true, notes: 'Generated by Laravel rememberToken().' });
    return;
  }
  if (method === 'morphs' || method === 'nullableMorphs' || method === 'uuidMorphs' || method === 'nullableUuidMorphs') {
    const prefix = name || 'model';
    const nullable = method.startsWith('nullable');
    const idType = method.toLowerCase().includes('uuid') ? 'UUID' : 'BIGINT';
    builder.addAttribute(entity, `${prefix}_type`, 'VARCHAR(255)', { isNullable: nullable, notes: `Generated by Laravel ${method}().` });
    builder.addAttribute(entity, `${prefix}_id`, idType, { isNullable: nullable, notes: `Generated by Laravel ${method}().` });
    return;
  }
  if (!name) {
    builder.addDiagnostic('warning', `Could not determine a column name for Laravel Blueprint::${method}() in ${entity.name}.`, undefined, 'partial.php.column');
    return;
  }
  let type = phpType(method, args);
  if (method === 'enum' || method === 'set') {
    const enumArg = values[1] ?? '';
    const enumValues = [...enumArg.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]!);
    type = 'VARCHAR(255)';
    builder.addAttribute(entity, name, type, { enumValues, notes: `Laravel ${method} choices are retained as enum values.` });
  }
  const chainMethods = [...chain.matchAll(/->(\w+)\s*(?:\(([^)]*)\))?/g)].map((match) => ({ name: match[1]!, args: match[2] ?? '' }));
  const nullable = chainMethods.some((item) => item.name === 'nullable');
  const unique = chainMethods.some((item) => item.name === 'unique');
  const primary = method === 'id' || method === 'bigIncrements' || method === 'increments' || chainMethods.some((item) => item.name === 'primary');
  const defaultCall = chainMethods.find((item) => item.name === 'default');
  const defaultValue = defaultCall ? (quotedArgument(defaultCall.args) ?? defaultCall.args.trim()) : undefined;
  const attribute = builder.addAttribute(entity, name, type, {
    isPK: primary,
    isUnique: unique || primary,
    isNullable: nullable && !primary,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    notes: method === 'foreignId' ? 'Laravel foreignId; reference target resolved from constrained() or column convention.' : '',
  });
  if (method === 'foreignId' && attribute) attribute.notes = 'Laravel foreignId; reference target resolved from constrained() or column convention.';
}

function parseMigrations(source: string, builder: ModelBuilder, pending: PendingReference[]): number {
  const blockExpression = /\bSchema::(?:create|table)\s*\(\s*(['"])([^'"]+)\1\s*,\s*(?:(?:static\s+)?function)\b[^{}]*\{/g;
  let count = 0;
  for (const block of extractBlocks(source, blockExpression)) {
    const tableName = block.match[2]!.trim();
    const entity = builder.addEntity(tableName);
    count += 1;
    const columnExpression = /\$table\s*->\s*(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*((?:\s*->\s*\w+\s*(?:\([^)]*\))?)*)\s*;?/g;
    for (const column of block.body.matchAll(columnExpression)) {
      const method = column[1]!;
      const args = column[2] ?? '';
      const chain = column[3] ?? '';
      if (['primary', 'unique', 'index', 'foreign', 'dropColumn', 'dropIfExists'].includes(method)) continue;
      addLaravelColumn(builder, entity, method, args, chain);
      if (method === 'foreignId' && /->constrained\s*\(/.test(chain)) {
        const local = quotedArgument(args);
        if (!local) continue;
        const constrained = chain.match(/->constrained\s*\(\s*(['"])([^'"]+)\1/);
        const parentName = constrained?.[2] ?? `${pluralize(singularize(local.replace(/_id$/i, '')))}`;
        pending.push({ childName: tableName, localColumn: local, parentName, parentColumn: 'id', label: `constrained ${parentName}`, nullable: /->nullable\s*\(/.test(chain), unique: /->unique\s*\(/.test(chain), identifying: false, onDelete: ruleFromChain(chain, 'onDelete'), onUpdate: ruleFromChain(chain, 'onUpdate') });
        if (!constrained) builder.addDiagnostic('info', `Inferred ${tableName}.${local} → ${parentName}.id from Laravel constrained() naming convention; confirm it.`, undefined, 'php.convention.foreign-key');
      }
    }
    const explicitForeign = /\$table\s*->\s*foreign\s*\(\s*([^)]*)\)\s*((?:->\w+\s*\([^)]*\)\s*)*)\s*;?/g;
    for (const foreign of block.body.matchAll(explicitForeign)) {
      const localColumn = quotedArgument(foreign[1] ?? '');
      const chain = foreign[2] ?? '';
      const parentName = chain.match(/->on\s*\(\s*(['"])([^'"]+)\1/)?.[2];
      const parentColumn = chain.match(/->references\s*\(\s*(['"])([^'"]+)\1/)?.[2] ?? 'id';
      if (localColumn && parentName) pending.push({ childName: tableName, localColumn, parentName, parentColumn, label: `references ${parentName}`, nullable: builder.findAttribute(entity, localColumn)?.isNullable ?? false, unique: builder.findAttribute(entity, localColumn)?.isUnique ?? false, identifying: builder.findAttribute(entity, localColumn)?.isPK ?? false, onDelete: ruleFromChain(chain, 'onDelete'), onUpdate: ruleFromChain(chain, 'onUpdate') });
      else builder.addDiagnostic('warning', `Could not resolve an explicit foreign-key target in migration table ${tableName}.`, undefined, 'partial.php.foreign-key');
    }
  }
  return count;
}

function parsePhpArrays(source: string, builder: ModelBuilder, pending: PendingReference[]): number {
  const arrayPattern = /(['"])([A-Za-z_][\w.-]*)\1\s*=>\s*\[/g;
  let count = 0;
  for (const match of source.matchAll(arrayPattern)) {
    const tableName = match[2]!;
    const open = match.index + match[0].lastIndexOf('[');
    let depth = 1;
    let quote: string | null = null;
    let close = -1;
    for (let index = open + 1; index < source.length; index += 1) {
      const character = source[index]!;
      if (quote) { if (character === quote && source[index - 1] !== '\\') quote = null; continue; }
      if (character === "'" || character === '"') { quote = character; continue; }
      if (character === '[') depth += 1;
      if (character === ']' && --depth === 0) { close = index; break; }
    }
    if (close < 0) continue;
    const body = source.slice(open + 1, close);
    const pairs = [...body.matchAll(/(['"])([^'"]+)\1\s*=>\s*(['"])([^'"]*)\3/g)];
    if (!pairs.length) continue;
    const entity = builder.addEntity(tableName);
    count += 1;
    for (const pair of pairs) {
      const field = pair[2]!;
      const descriptor = pair[4]!.trim();
      const normalized = descriptor.toLowerCase();
      const type = descriptor.match(/^(?:unsigned\s+)?(?:bigint|integer|int|smallint|decimal(?:\([^)]*\))?|numeric(?:\([^)]*\))?|varchar(?:\([^)]*\))?|char(?:\([^)]*\))?|text|boolean|bool|date|datetime|timestamp|json|uuid)/i)?.[0] ?? 'UNKNOWN';
      const primary = /\bprimary\s+key\b|\bprimary\b|\bpk\b/i.test(normalized);
      const unique = /\bunique\b/i.test(normalized) || primary;
      const nullable = /\bnullable\b|\bnull\b/i.test(normalized) && !/not null/i.test(normalized);
      const attribute = builder.addAttribute(entity, field, type.toUpperCase(), {
        isPK: primary,
        isUnique: unique,
        isNullable: nullable,
        kind: /\bderived\b/i.test(normalized) ? 'derived' : /\bmultivalued\b/i.test(normalized) ? 'multivalued' : 'simple',
        ...(normalized.includes('derived') ? { derivationFormula: descriptor.replace(/^.*?derived\s*(?:from)?\s*/i, '').trim() || 'unresolved' } : {}),
        notes: descriptor === 'UNKNOWN' ? 'PHP array provides no recognizable column type; review required.' : '',
      });
      const reference = normalized.match(/\breferences?\s+([a-z_][\w.-]*)\.([a-z_][\w.-]*)/i);
      if (reference && attribute) pending.push({ childName: tableName, localColumn: field, parentName: reference[1]!, parentColumn: reference[2]!, label: `references ${reference[1]}`, nullable, unique, identifying: primary, onDelete: 'NO ACTION', onUpdate: 'CASCADE' });
      if (type === 'UNKNOWN') builder.addDiagnostic('warning', `The type of ${tableName}.${field} is not specified in the PHP array.`, undefined, 'partial.php.array-type');
    }
  }
  return count;
}

function tableNameForModel(className: string): string {
  return pluralize(camelToSnake(className.split('\\').at(-1) ?? className));
}

function ensurePrimaryKey(builder: ModelBuilder, entity: Entity, primaryKey = 'id'): Attribute {
  const existing = builder.findAttribute(entity, primaryKey);
  if (existing) { existing.isPK = true; existing.isUnique = true; return existing; }
  const key = builder.addAttribute(entity, primaryKey, 'BIGINT', { isPK: true, isUnique: true, notes: 'Conventional Eloquent primary key inferred; confirm if this model overrides the key.' });
  builder.addDiagnostic('info', `Inferred conventional primary key ${entity.name}.${primaryKey} from the Eloquent model; confirm its database column.`, undefined, 'php.convention.primary-key');
  return key!;
}

function parseEloquent(source: string, builder: ModelBuilder, pending: PendingReference[]): number {
  const classes = extractBlocks(source, /\bclass\s+(\w+)(?:\s+extends\s+[\\\w]+)?[^{}]*\{/g);
  const tableByClass = new Map<string, string>();
  const entityByClass = new Map<string, Entity>();
  for (const block of classes) {
    const className = block.match[1]!;
    const explicitTable = block.body.match(/\$table\s*=\s*(['"])([^'"]+)\1/)?.[2];
    const tableName = explicitTable ?? tableNameForModel(className);
    tableByClass.set(className, tableName);
    const entity = builder.addEntity(tableName, { notes: `Imported from Eloquent model ${className}.` });
    entityByClass.set(className, entity);
    const keyName = block.body.match(/\$primaryKey\s*=\s*(['"])([^'"]+)\1/)?.[2] ?? 'id';
    ensurePrimaryKey(builder, entity, keyName);
    const fillable = block.body.match(/\$fillable\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    for (const field of fillable.matchAll(/['"]([^'"]+)['"]/g)) builder.addAttribute(entity, field[1]!, 'UNKNOWN', { notes: 'Eloquent $fillable field; database type is not declared in the model.' });
    const casts = block.body.match(/\$casts\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    for (const cast of casts.matchAll(/['"]([^'"]+)['"]\s*=>\s*['"]([^'"]+)['"]/g)) {
      const field = builder.findAttribute(entity, cast[1]!);
      const castType = cast[2]!.toLowerCase();
      const typeMap: Record<string, string> = { integer: 'INTEGER', real: 'DECIMAL', float: 'FLOAT', double: 'DOUBLE', string: 'VARCHAR(255)', boolean: 'BOOLEAN', bool: 'BOOLEAN', date: 'DATE', datetime: 'DATETIME', immutable_date: 'DATE', immutable_datetime: 'DATETIME', array: 'JSON', json: 'JSON', object: 'JSON' };
      if (field) field.dataType = typeMap[castType] ?? field.dataType;
      else builder.addAttribute(entity, cast[1]!, typeMap[castType] ?? 'UNKNOWN', { notes: `Inferred from Eloquent cast ${castType}.` });
    }
  }
  if (!classes.length) return 0;

  for (const block of classes) {
    const className = block.match[1]!;
    const current = entityByClass.get(className)!;
    const currentTable = tableByClass.get(className)!;
    const methods = [...block.body.matchAll(/(?:public|protected|private)?\s*function\s+(\w+)\s*\([^)]*\)\s*(?::\s*[?\\\w|]+\s*)?\{([\s\S]*?)\}/g)];
    for (const method of methods) {
      const call = method[2]!.match(/\$this\s*->\s*(belongsTo|hasMany|hasOne|belongsToMany)\s*\(\s*([\\\w]+)::class\s*((?:,\s*[^)]*)?)\)/);
      if (!call) continue;
      const kind = call[1]!;
      const relatedClass = call[2]!.split('\\').at(-1)!;
      const relatedTable = tableByClass.get(relatedClass) ?? tableNameForModel(relatedClass);
      const related = entityByClass.get(relatedClass) ?? builder.addEntity(relatedTable, { notes: `Related Eloquent model ${relatedClass} is referenced but its class definition was not included.` });
      if (!entityByClass.has(relatedClass)) {
        entityByClass.set(relatedClass, related);
        tableByClass.set(relatedClass, relatedTable);
        ensurePrimaryKey(builder, related);
      }
      const extraArgs = call[3] ?? '';
      const args = splitTopLevel(extraArgs.replace(/^\s*,\s*/, ''));
      const firstExtra = quotedArgument(args[0] ?? '');
      if (kind === 'belongsTo' || kind === 'hasMany' || kind === 'hasOne') {
        const localColumn = kind === 'belongsTo' ? firstExtra ?? `${camelToSnake(relatedClass)}_id` : (args.length > 1 ? quotedArgument(args[1] ?? '') : undefined) ?? `${singularize(currentTable)}_id`;
        const child = kind === 'belongsTo' ? current : related;
        const parent = kind === 'belongsTo' ? related : current;
        const childTable = kind === 'belongsTo' ? currentTable : relatedTable;
        const nullable = builder.findAttribute(child, localColumn)?.isNullable ?? true;
        const local = builder.findAttribute(child, localColumn) ?? builder.addAttribute(child, localColumn, 'BIGINT', { isNullable: true, notes: `Inferred from Eloquent ${kind}() convention; confirm column type/optionality.` });
        const parentKeyName = kind === 'belongsTo' ? (args.length > 1 ? quotedArgument(args[1] ?? '') : undefined) ?? 'id' : (args.length > 2 ? quotedArgument(args[2] ?? '') : undefined) ?? 'id';
        const parentKey = ensurePrimaryKey(builder, parent, parentKeyName);
        if (local) { local.isFK = true; local.foreignKeyRef = { entityId: parent.id, attributeId: parentKey.id }; }
        const unique = kind === 'hasOne' || Boolean(local?.isUnique || local?.isPK);
        pending.push({ childName: childTable, localColumn, parentName: parent.name, parentColumn: parentKey.name, label: method[1]!, nullable, unique, identifying: Boolean(local?.isPK), onDelete: 'NO ACTION', onUpdate: 'CASCADE' });
      } else {
        const pivot = args.length > 0 ? firstExtra : undefined;
        const pivotName = pivot ?? [singularize(currentTable), singularize(relatedTable)].sort().join('_');
        const pivotEntity = builder.addEntity(pivotName, { kind: 'associative', notes: 'Pivot entity inferred from Eloquent belongsToMany(); confirm table name and key conventions.' });
        const currentKey = ensurePrimaryKey(builder, current);
        const relatedKey = ensurePrimaryKey(builder, related);
        const currentColumn = (args.length > 1 ? quotedArgument(args[1] ?? '') : undefined) ?? `${singularize(currentTable)}_id`;
        const relatedColumn = (args.length > 2 ? quotedArgument(args[2] ?? '') : undefined) ?? `${singularize(relatedTable)}_id`;
        const currentFk = builder.findAttribute(pivotEntity, currentColumn) ?? builder.addAttribute(pivotEntity, currentColumn, currentKey.dataType, { isFK: true, foreignKeyRef: { entityId: current.id, attributeId: currentKey.id }, notes: 'Conventional Eloquent pivot foreign key.' });
        const relatedFk = builder.findAttribute(pivotEntity, relatedColumn) ?? builder.addAttribute(pivotEntity, relatedColumn, relatedKey.dataType, { isFK: true, foreignKeyRef: { entityId: related.id, attributeId: relatedKey.id }, notes: 'Conventional Eloquent pivot foreign key.' });
        if (currentFk) currentFk.isPK = true;
        if (relatedFk) relatedFk.isPK = true;
        pending.push({ childName: pivotName, localColumn: currentColumn, parentName: current.name, parentColumn: currentKey.name, label: 'belongs to', nullable: false, unique: false, identifying: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' });
        pending.push({ childName: pivotName, localColumn: relatedColumn, parentName: related.name, parentColumn: relatedKey.name, label: 'belongs to', nullable: false, unique: false, identifying: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' });
        builder.addDiagnostic('info', `Generated pivot entity ${pivotName} from Eloquent belongsToMany(); confirm its keys and uniqueness.`, undefined, 'php.convention.pivot');
      }
    }
  }
  return classes.length;
}

function applyPendingReferences(builder: ModelBuilder, pending: PendingReference[]): void {
  for (const reference of pending) {
    const child = builder.getEntity(reference.childName);
    const parent = builder.getEntity(reference.parentName);
    if (!child || !parent) {
      builder.addDiagnostic('warning', `Reference ${reference.childName}.${reference.localColumn} → ${reference.parentName}.${reference.parentColumn} is unresolved.`, undefined, 'partial.php.unresolved-reference');
      continue;
    }
    const local = builder.findAttribute(child, reference.localColumn);
    const target = builder.findAttribute(parent, reference.parentColumn);
    if (!local || !target) {
      builder.addDiagnostic('warning', `Reference ${reference.childName}.${reference.localColumn} → ${reference.parentName}.${reference.parentColumn} could not be matched to declared columns.`, undefined, 'partial.php.unresolved-column');
      continue;
    }
    local.isFK = true;
    local.foreignKeyRef = { entityId: parent.id, attributeId: target.id };
    const fromCardinality = reference.nullable ? '0..1' : '1';
    const toCardinality = reference.unique ? '0..1' : '0..N';
    builder.addRelationship(parent, child, reference.label, { fromCardinality, toCardinality, identifying: reference.identifying, participation: reference.nullable ? 'partial' : 'total', onDelete: reference.onDelete, onUpdate: reference.onUpdate });
  }
}

export function parsePhpSource(source: string, name = ''): ParseResult {
  const builder = new ModelBuilder(source, name);
  const syntaxError = verifyPhpSyntax(source);
  if (syntaxError) {
    builder.addDiagnostic('error', `PHP syntax could not be fully parsed: ${syntaxError}. Recognized declarations are still recovered when possible.`, undefined, 'partial.php.syntax');
  }
  const pending: PendingReference[] = [];
  const migrationCount = parseMigrations(source, builder, pending);
  if (!migrationCount) parsePhpArrays(source, builder, pending);
  parseEloquent(source, builder, pending);
  applyPendingReferences(builder, pending);
  if (!builder.model.entities.length) builder.addDiagnostic('error', 'No Laravel migration, Eloquent model or structured PHP table array was found.', undefined, 'partial.php.empty');
  return builder.finish('php');
}
