import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectFormat, LOCAL_SCHEMA_INPUT_LIMIT, parseSource } from '../src/parsers';
import type { ParseResult, ParserFormat } from '../src/parsers/types';
import { validateSchemaModel } from '../src/model/schema';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/parsers/fixtures/${name}`, import.meta.url)), 'utf8');
}

function entity(result: ParseResult, name: string) {
  const found = result.model.entities.find((item) => item.name.toLowerCase() === name.toLowerCase());
  expect(found, `expected entity ${name}; got ${result.model.entities.map((item) => item.name).join(', ')}`).toBeDefined();
  return found!;
}

function attribute(result: ParseResult, entityName: string, attributeName: string) {
  const found = entity(result, entityName).attributes.find((item) => item.name.toLowerCase() === attributeName.toLowerCase());
  expect(found, `expected ${entityName}.${attributeName}`).toBeDefined();
  return found!;
}

function parse(input: string, format: ParserFormat = 'auto'): ParseResult {
  return parseSource(input, { format });
}

function expectValidModel(result: ParseResult): void {
  const validation = validateSchemaModel(result.model);
  expect(validation.success, validation.success ? '' : validation.errors.join('\n')).toBe(true);
}

describe('deterministic parser adapters', () => {
  it('auto-detects all supported fixture formats before parsing', () => {
    expect(detectFormat(fixture('mysql.sql'))).toBe('sql');
    expect(detectFormat(fixture('laravel.php'))).toBe('php');
    expect(detectFormat(fixture('php-array.php'))).toBe('php');
    expect(detectFormat(fixture('tables.json'))).toBe('json');
    expect(detectFormat(fixture('openapi.json'))).toBe('json');
    expect(detectFormat(fixture('schema.dbml'))).toBe('dbml');
    expect(detectFormat(fixture('schema.mmd'))).toBe('mermaid');
    expect(detectFormat(fixture('pharmacy.md'))).toBe('text');
  });

  it('produces the same normalized model for every real fixture on repeated parses', () => {
    const cases: Array<{ file: string; options: Parameters<typeof parseSource>[1] }> = [
      { file: 'mysql.sql', options: { dialect: 'mysql' } },
      { file: 'postgres.sql', options: { dialect: 'postgresql' } },
      { file: 'laravel.php', options: {} },
      { file: 'php-array.php', options: {} },
      { file: 'tables.json', options: {} },
      { file: 'openapi.json', options: {} },
      { file: 'schema.dbml', options: {} },
      { file: 'schema.mmd', options: {} },
      { file: 'pharmacy.md', options: {} },
    ];
    for (const { file, options } of cases) {
      const source = fixture(file);
      const first = parseSource(source, options);
      const second = parseSource(source, options);
      expect(first.model, `unstable parser output for ${file}`).toEqual(second.model);
      expectValidModel(first);
    }
  });

  it('lazy-loads the selected browser parser without changing normalized results', async () => {
    const { parseSourceAsync } = await import('../src/parsers/browser');
    const source = fixture('pharmacy.md');
    const lazyResult = await parseSourceAsync(source);
    const deterministicResult = parseSource(source);
    expect(lazyResult).toEqual(deterministicResult);
    const malformed = await parseSourceAsync('CREATE TABLE broken (');
    expect(malformed.model.entities).toEqual([]);
    expect(malformed.diagnostics.length).toBeGreaterThan(0);
  });

  it('parses MySQL DDL with stable entity IDs, keys, defaults and foreign-key actions', () => {
    const source = fixture('mysql.sql');
    const first = parseSource(source, { format: 'sql', dialect: 'mysql' });
    const second = parseSource(source, { format: 'sql', dialect: 'mysql' });
    expect(first.format).toBe('sql');
    expect(entity(first, 'clients').id).toBe(entity(second, 'clients').id);
    expect(attribute(first, 'clients', 'client_id').isPK).toBe(true);
    expect(attribute(first, 'orders', 'client_id').isFK).toBe(true);
    expect(first.model.relationships.some((item) => item.from === entity(first, 'clients').id && item.to === entity(first, 'orders').id && item.onDelete === 'CASCADE')).toBe(true);
    expectValidModel(first);
  });

  it('parses PostgreSQL composite primary keys and referenced tables', () => {
    const result = parseSource(fixture('postgres.sql'), { format: 'sql', dialect: 'postgresql' });
    expect(attribute(result, 'staff', 'staff_id').isPK).toBe(true);
    expect(attribute(result, 'staff', 'branch_id').isPK).toBe(true);
    expect(attribute(result, 'staff', 'branch_id').isFK).toBe(true);
    expect(result.model.relationships.some((item) => item.label.includes('staff_branch_id_fk'))).toBe(true);
    expectValidModel(result);
  });

  it('parses Laravel migrations and Eloquent belongsTo/hasMany relations', () => {
    const result = parse(fixture('laravel.php'), 'php');
    expect(result.format).toBe('php');
    expect(attribute(result, 'staff', 'id').isPK).toBe(true);
    expect(attribute(result, 'staff', 'branch_id').isFK).toBe(true);
    expect(attribute(result, 'staff', 'day_shift').defaultValue).toBe('false');
    expect(result.model.relationships.some((item) => item.from === entity(result, 'branches').id && item.to === entity(result, 'staff').id)).toBe(true);
    expectValidModel(result);
  });

  it('parses plain PHP associative-array schemas', () => {
    const result = parse(fixture('php-array.php'), 'php');
    expect(attribute(result, 'suppliers', 'supplier_id').isPK).toBe(true);
    expect(attribute(result, 'stock_payment_orders', 'supplier_id').isFK).toBe(true);
    expect(attribute(result, 'stock_payment_orders', 'total_price').kind).toBe('derived');
    expectValidModel(result);
  });

  it('parses custom table JSON and resolves references after all entities exist', () => {
    const result = parse(fixture('tables.json'), 'json');
    expect(attribute(result, 'stock', 'branch_id').isFK).toBe(true);
    expect(attribute(result, 'stock', 'item_barcode').isFK).toBe(true);
    expect(attribute(result, 'stock', 'count').defaultValue).toBe('0');
    expect(result.model.relationships.length).toBeGreaterThanOrEqual(2);
    expectValidModel(result);
  });

  it('parses OpenAPI component schemas, enums, nested composites and array references', () => {
    const result = parse(fixture('openapi.json'), 'json');
    expect(attribute(result, 'Branch', 'address').kind).toBe('composite');
    expect(attribute(result, 'Branch', 'address').children?.map((item) => item.name)).toEqual(['street', 'city']);
    expect(attribute(result, 'Branch', 'status').enumValues).toEqual(['open', 'closed']);
    expect(attribute(result, 'Item', 'branches').kind).toBe('multivalued');
    expect(result.model.relationships.some((item) => item.fromCardinality === 'M:N' && item.toCardinality === 'M:N')).toBe(true);
    expectValidModel(result);
  });

  it('parses DBML enums, key constraints, indexes and references without duplicate edges', () => {
    const result = parse(fixture('schema.dbml'), 'dbml');
    expect(attribute(result, 'orders', 'order_id').isPK).toBe(true);
    expect(attribute(result, 'orders', 'client_id').isFK).toBe(true);
    expect(attribute(result, 'orders', 'payment_method').enumValues).toEqual(['cash', 'visa', 'wallet']);
    expect(result.model.relationships.filter((item) => item.from === entity(result, 'clients').id && item.to === entity(result, 'orders').id)).toHaveLength(1);
    expectValidModel(result);
  });

  it('parses Mermaid ERD Crow’s Foot markers and resolves a marked foreign key', () => {
    const result = parse(fixture('schema.mmd'), 'mermaid');
    expect(attribute(result, 'STAFF', 'branch_id').isFK).toBe(true);
    expect(result.model.relationships.some((item) => item.label === 'employs' && item.fromCardinality === '1' && item.toCardinality === '0..N')).toBe(true);
    expect(result.model.relationships.some((item) => item.label === 'manages' && item.fromCardinality === '1' && item.toCardinality === '0..1')).toBe(true);
    expectValidModel(result);
  });

  it('builds the pharmacy chain including specialization, stock junction, line items and semantic flags', () => {
    const source = fixture('pharmacy.md');
    const result = parseSource(source);
    expect(result.format).toBe('text');
    expect(result.model.entities.map((item) => item.name)).toEqual(expect.arrayContaining(['Item', 'Drug', 'Stock', 'Client', 'Staff', 'Suppliers', 'Branch', 'Order', 'StockPaymentOrder', 'OrderLine', 'StockPaymentOrderLine']));
    expect(entity(result, 'Drug').isSpecializationOf).toBe(entity(result, 'Item').id);
    expect(result.model.specializations.some((item) => item.parent === entity(result, 'Item').id && item.children.includes(entity(result, 'Drug').id))).toBe(true);
    expect(result.model.relationships.some((item) => item.from === entity(result, 'Item').id && item.to === entity(result, 'Stock').id)).toBe(true);
    expect(result.model.relationships.some((item) => item.from === entity(result, 'Branch').id && item.to === entity(result, 'Stock').id)).toBe(true);
    expect(attribute(result, 'Client', 'phone').kind).toBe('multivalued');
    expect(attribute(result, 'Staff', 'phone').kind).toBe('multivalued');
    expect(attribute(result, 'Suppliers', 'phone').kind).toBe('multivalued');
    expect(attribute(result, 'Branch', 'phone').kind).toBe('multivalued');
    expect(attribute(result, 'Item', 'total_price').kind).toBe('derived');
    expect(attribute(result, 'Order', 'total_price').kind).toBe('derived');
    expect(attribute(result, 'StockPaymentOrder', 'total_price').kind).toBe('derived');
    expect(result.model.relationships.some((item) => item.from === entity(result, 'Staff').id && item.to === entity(result, 'Branch').id && /managed by/i.test(item.label))).toBe(true);
    expect(result.model.relationships.some((item) => item.from === entity(result, 'Branch').id && item.to === entity(result, 'Staff').id)).toBe(true);
    expectValidModel(result);
  });

  it('returns readable partial diagnostics for malformed JSON and oversized input', () => {
    const malformed = parseSource('{"tables": [', { format: 'json' });
    expect(malformed.partial).toBe(true);
    expect(malformed.diagnostics.some((item) => item.severity === 'error' && /Invalid JSON/.test(item.message))).toBe(true);
    const oversized = parseSource('x'.repeat(LOCAL_SCHEMA_INPUT_LIMIT + 1), { format: 'text' });
    expect(oversized.partial).toBe(true);
    expect(oversized.diagnostics[0]?.message).toContain('100,000');
  });

  it('preserves partial parser results and reports unresolved references or syntax errors', () => {
    const sql = parseSource('CREATE TABLE broken (', { format: 'sql', dialect: 'mysql' });
    expect(sql.partial).toBe(true);
    expect(sql.diagnostics.some((item) => item.severity === 'error')).toBe(true);

    const php = parseSource("<?php Schema::create('users', function ($table) { $table->id();", { format: 'php' });
    expect(php.partial).toBe(true);
    expect(php.diagnostics.some((item) => item.severity === 'error')).toBe(true);

    const dbml = parseSource('Table orders {\n  order_id bigint [pk]\n}\nRef: orders.client_id > missing.client_id', { format: 'dbml' });
    expect(dbml.partial).toBe(true);
    expect(dbml.model.entities.some((item) => item.name === 'missing')).toBe(false);
    expect(dbml.diagnostics.some((item) => /could not be fully resolved/i.test(item.message))).toBe(true);

    const text = parseSource('## Item\n- item_id: bigint primary key\n- supplier_id: bigint references UndeclaredSupplier.supplier_id', { format: 'text' });
    expect(text.partial).toBe(true);
    expect(text.model.entities.some((item) => item.name === 'UndeclaredSupplier')).toBe(false);
    expect(text.diagnostics.some((item) => /no entity was invented/i.test(item.message))).toBe(true);
  });
});
