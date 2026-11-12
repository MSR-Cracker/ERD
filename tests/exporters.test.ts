import { afterEach, describe, expect, it, vi } from 'vitest';
import { pharmacySchema } from './fixtures/pharmacy';
import { serializeProject } from '../src/model/io';
import { createDiagramExportBlob, safeFilename } from '../src/exporters/diagram';
import { generateDataDictionaryHtml, generateDataDictionaryMarkdown, generateDataDictionaryPdf } from '../src/exporters/dictionary';
import { generateDBML, generateLaravelMigrations, generateMermaid, generatePrismaSchema } from '../src/exporters/code';
import { generateMySQLDDL, generatePostgreSQLDDL, generateSQLiteDDL } from '../src/exporters/ddl';

const { pngMock, svgMock, canvasMock } = vi.hoisted(() => ({
  pngMock: vi.fn(async () => 'data:image/png;base64,AA=='),
  svgMock: vi.fn(async () => 'data:image/svg+xml,%3Csvg%20xmlns="http://www.w3.org/2000/svg"%3E%3C/svg%3E'),
  canvasMock: vi.fn(async () => ({ width: 920, height: 720, toDataURL: () => 'data:image/png;base64,AA==' })),
}));

vi.mock('html-to-image', () => ({ toPng: pngMock, toSvg: svgMock, toCanvas: canvasMock }));
vi.mock('jspdf', () => ({
  jsPDF: class {
    internal = { pageSize: { getWidth: () => 297, getHeight: () => 210 } };
    addPage() { return this; }
    addImage() { return this; }
    setFillColor() { return this; }
    rect() { return this; }
    setTextColor() { return this; }
    setFont() { return this; }
    setFontSize() { return this; }
    text() { return this; }
    setDrawColor() { return this; }
    line() { return this; }
    output() { return new Blob(['%PDF-mock'], { type: 'application/pdf' }); }
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ERDForge exporters on the pharmacy-chain fixture', () => {
  it('generates MySQL DDL with stable tables, references, a junction and normalized multivalued fields', () => {
    const output = generateMySQLDDL(pharmacySchema);
    expect(output.indexOf('CREATE TABLE `staff`')).toBeLessThan(output.indexOf('CREATE TABLE `branch`'));
    expect(output).toContain('CREATE TABLE `item`');
    expect(output).toContain('CREATE TABLE `stock`');
    expect(output).toContain('REFERENCES `item` (`barcode`)');
    expect(output).toContain('REFERENCES `staff` (`staff_id`)');
    expect(output).toContain('CREATE TABLE `order_line`');
    expect(output).toContain('CREATE TABLE `drug_active_pharmaceutical_ingredients`');
    expect(output).toContain('PRIMARY KEY (`order_id`, `line_number`)');
    expect(output).not.toContain('`total_price`');
    expect(output).not.toContain('`main_stock_count`');
  });

  it('generates PostgreSQL and SQLite DDL with dialect-appropriate quoting and type mapping', () => {
    const postgres = generatePostgreSQLDDL(pharmacySchema);
    const sqlite = generateSQLiteDDL(pharmacySchema);
    expect(postgres).toContain('CREATE TABLE "stock"');
    expect(postgres).toContain('REFERENCES "item" ("barcode")');
    expect(postgres).not.toContain('`stock`');
    expect(sqlite).toContain('CREATE TABLE "order_line"');
    expect(sqlite).toContain('PRAGMA foreign_keys = ON;');
    expect(sqlite).toContain('"count" INTEGER');
    expect(sqlite).toContain('REFERENCES "branch" ("branch_id")');
  });

  it('includes explicitly stored derived values and requested indexes but excludes virtual values', () => {
    const schema = structuredClone(pharmacySchema);
    const item = schema.entities.find((entity) => entity.id === 'item')!;
    item.attributes.find((attribute) => attribute.id === 'item.total-price')!.isStored = true;
    const stock = schema.entities.find((entity) => entity.id === 'stock')!;
    stock.attributes.find((attribute) => attribute.id === 'stock.item-barcode')!.isIndexed = true;
    const output = generateMySQLDDL(schema);
    expect(output).toContain('`total_price` DECIMAL(12,2)');
    expect(output).toContain('CREATE INDEX `idx_stock_item_barcode`');
  });

  it('generates Laravel migration source with explicit types, composite keys, FK rules and child tables', () => {
    const output = generateLaravelMigrations(pharmacySchema);
    expect(output).toContain("Schema::create('order_line'");
    expect(output).toContain("$table->primary(['order_id', 'line_number'])");
    expect(output).toContain("->on('item')");
    expect(output).toContain("Schema::create('client_phone'");
    expect(output).toContain('public function down(): void');
  });

  it('generates Prisma models and relations while omitting virtual derived fields', () => {
    const output = generatePrismaSchema(pharmacySchema);
    expect(output).toContain('model Item');
    expect(output).toContain('model OrderLine');
    expect(output).toContain('@relation("fk_order_line_order_id"');
    expect(output).toContain('@@id([order_id, line_number])');
    expect(output).not.toContain('total_price');
  });

  it('generates DBML and Mermaid with junction tables, FK references, notation and specialization', () => {
    const dbml = generateDBML(pharmacySchema);
    const mermaid = generateMermaid(pharmacySchema);
    expect(dbml).toContain('Table stock {');
    expect(dbml).toContain('Ref: stock.item_barcode > item.barcode');
    expect(dbml).toContain('Table order_line {');
    expect(mermaid).toContain('erDiagram');
    expect(mermaid).toContain('item ||--o{ stock');
    expect(mermaid).toContain('item ||--|| drug : "ISA"');
  });

  it('exports a versioned JSON project and bilingual Markdown/HTML dictionaries safely', () => {
    const json = serializeProject(pharmacySchema);
    expect(JSON.parse(json)).toMatchObject({ format: 'erdforge', version: 1, schema: { id: 'pharmacy-chain-v1' } });
    const markdown = generateDataDictionaryMarkdown(pharmacySchema, 'en', new Date('2026-01-02T00:00:00.000Z'));
    const html = generateDataDictionaryHtml(pharmacySchema, 'ar', new Date('2026-01-02T00:00:00.000Z'));
    expect(markdown).toContain('# ERDForge Data Dictionary');
    expect(markdown).toContain('client_phone');
    expect(html).toContain('lang="ar" dir="rtl"');
    expect(html).toContain('قاموس بيانات ERDForge');
    const escaped = generateDataDictionaryHtml({ ...pharmacySchema, name: '<script>alert(1)</script>' }, 'en');
    expect(escaped).not.toContain('<script>alert(1)</script>');
    expect(escaped).toContain('&lt;script&gt;');
  });

  it('creates diagram PNG, SVG, and PDF blobs with the requested variants', async () => {
    vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: '#fff' }));
    class ImageStub {
      naturalWidth = 1200;
      naturalHeight = 800;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', ImageStub);
    const element = { classList: { contains: () => false } } as unknown as HTMLElement;
    const png = await createDiagramExportBlob(element, { kind: 'png', scale: 4 }, 'Pharmacy');
    const svg = await createDiagramExportBlob(element, { kind: 'svg' }, 'Pharmacy');
    const pdf = await createDiagramExportBlob(element, { kind: 'pdf', page: 'a3' }, 'Pharmacy');
    expect(png.type).toBe('image/png');
    expect(svg.type).toContain('image/svg+xml');
    expect(pdf.type).toBe('application/pdf');
    expect(pngMock).toHaveBeenCalledWith(element, expect.objectContaining({ pixelRatio: 4 }));
    expect(svgMock).toHaveBeenCalled();
  });

  it('creates a browser-rendered PDF dictionary with RTL-capable HTML content', async () => {
    const host = { style: { cssText: '' }, innerHTML: '', firstElementChild: {}, remove: vi.fn() };
    vi.stubGlobal('document', { createElement: () => host, body: { append: vi.fn() }, fonts: { ready: Promise.resolve() } });
    const pdf = await generateDataDictionaryPdf(pharmacySchema, 'ar', new Date('2026-01-02T00:00:00.000Z'));
    expect(pdf.type).toBe('application/pdf');
    expect(canvasMock).toHaveBeenCalled();
    expect(host.innerHTML).toContain('dir="rtl"');
  });

  it('creates deterministic safe download names from schema titles', () => {
    expect(safeFilename('My Pharmacy / Chain')).toBe('my-pharmacy-chain');
    expect(safeFilename('')).toBe('erdforge-schema');
  });
});
