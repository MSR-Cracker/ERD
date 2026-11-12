import type { Attribute, Entity, Relationship, SchemaModel } from '../../src/model/types';

const simple = (id: string, name: string, dataType: string, options: Partial<Attribute> = {}): Attribute => ({
  id,
  name,
  dataType,
  isPK: false,
  isFK: false,
  isUnique: false,
  isNullable: false,
  kind: 'simple',
  notes: '',
  ...options,
});

const composite = (id: string, name: string, children: Attribute[], notes = '', kind: Attribute['kind'] = 'composite'): Attribute => ({
  id,
  name,
  dataType: 'composite',
  isPK: false,
  isFK: false,
  isUnique: false,
  isNullable: false,
  kind,
  children,
  notes,
});

const fk = (id: string, name: string, dataType: string, entityId: string, attributeId: string, nullable = false, notes = ''): Attribute => simple(id, name, dataType, {
  isFK: true,
  isNullable: nullable,
  foreignKeyRef: { entityId, attributeId },
  notes,
});

const pk = (id: string, name: string, dataType = 'BIGINT'): Attribute => simple(id, name, dataType, { isPK: true, isUnique: true });

const entity = (id: string, name: string, attributes: Attribute[], options: Partial<Entity> = {}): Entity => ({
  id,
  name,
  kind: 'strong',
  attributes,
  notes: '',
  ...options,
});

const relation = (id: string, from: string, to: string, label: string, fromCardinality: Relationship['fromCardinality'], toCardinality: Relationship['toCardinality'], options: Partial<Relationship> = {}): Relationship => ({
  id,
  from,
  to,
  label,
  fromCardinality,
  toCardinality,
  identifying: false,
  participation: 'partial',
  attributes: [],
  onDelete: 'NO ACTION',
  onUpdate: 'CASCADE',
  notes: '',
  ...options,
});

const item = entity('item', 'Item', [
  pk('item.id', 'item_id'),
  simple('item.name', 'name', 'VARCHAR(200)'),
  simple('item.barcode', 'barcode', 'VARCHAR(64)', { isUnique: true, notes: 'Natural reference key used by stock and order lines.' }),
  simple('item.batch-ref', 'batch_number_ref', 'VARCHAR(64)', { isNullable: true, notes: 'Source lists a possible item-level batch reference; Stock owns the canonical batch number. Confirm whether this optional reference is needed.' }),
  simple('item.manufacturer', 'manufacturer', 'VARCHAR(200)'),
  simple('item.type', 'type', 'VARCHAR(80)'),
  simple('item.price', 'price_per_strip_or_package', 'DECIMAL(12,2)', { notes: 'Unit is per strip or per package; confirm per item.' }),
  simple('item.discount', 'discount', 'DECIMAL(8,2)', { notes: 'Whether the value is a percentage or fixed amount must be confirmed.' }),
  simple('item.total-price', 'total_price', 'DECIMAL(12,2)', { kind: 'derived', derivationFormula: 'price_per_strip_or_package - discount', notes: 'Derived display value; discount arithmetic (percentage vs fixed) must be confirmed. Excluded from DDL by default.' }),
]);

const drug = entity('drug', 'Drug', [
  simple('drug.item-id', 'item_id', 'BIGINT', { isPK: true, isUnique: true, isFK: true, foreignKeyRef: { entityId: 'item', attributeId: 'item.id' }, notes: 'Shared primary key and foreign key implementing the Item→Drug subtype.' }),
  simple('drug.drug-type', 'drug_type', 'VARCHAR(80)'),
  simple('drug.prescription', 'prescription', 'BOOLEAN', { notes: 'false means over-the-counter (OTC).' }),
  composite('drug.apis', 'active_pharmaceutical_ingredients', [
    simple('drug.apis.name', 'ingredient_name', 'VARCHAR(200)'),
    simple('drug.apis.strength', 'strength', 'VARCHAR(80)'),
  ], 'Multivalued composite: each active ingredient carries its strength.', 'multivalued'),
  simple('drug.physical-type', 'physical_type', 'VARCHAR(80)', { enumValues: ['tablet', 'liquid', 'capsule', 'ointment', 'injection'] }),
  simple('drug.procedure', 'procedural_specifications', 'VARCHAR(40)', { kind: 'multivalued', enumValues: ['oral', 'topical', 'IV', 'IM'], notes: 'Multivalued route/specification.' }),
  simple('drug.strips', 'strips_per_package', 'INTEGER'),
  simple('drug.stock-count', 'main_stock_count', 'INTEGER', { kind: 'derived', derivationFormula: 'SUM(Stock.count) grouped by Item across branches and batches', notes: 'Confirm whether the requested main count is an all-branch total or a branch-specific value.' }),
], { kind: 'strong', isSpecializationOf: 'item', notes: 'Item subtype. One known subtype is represented; disjointness/completeness remain reviewable assumptions.' });

const branch = entity('branch', 'Branch', [
  pk('branch.id', 'branch_id'),
  simple('branch.name', 'name', 'VARCHAR(160)'),
  simple('branch.phone', 'phone', 'VARCHAR(32)', { kind: 'multivalued', notes: 'Multivalued; separate relation can be produced by normalization/export.' }),
  composite('branch.address', 'address', [
    simple('branch.address.line1', 'line1', 'VARCHAR(240)'),
    simple('branch.address.city', 'city', 'VARCHAR(120)'),
    simple('branch.address.governorate', 'governorate', 'VARCHAR(120)'),
    simple('branch.address.postal', 'postal_code', 'VARCHAR(32)'),
  ], 'Address components are a provisional breakdown; required fields must be confirmed.'),
  fk('branch.manager', 'managed_by_staff_id', 'BIGINT', 'staff', 'staff.id', true, 'A branch may have at most one assigned manager; whether a manager is mandatory is not specified.'),
]);

const stock = entity('stock', 'Stock', [
  pk('stock.id', 'stock_id'),
  fk('stock.item-barcode', 'item_barcode', 'VARCHAR(64)', 'item', 'item.barcode'),
  fk('stock.branch-id', 'branch_id', 'BIGINT', 'branch', 'branch.id'),
  simple('stock.batch-number', 'batch_number', 'VARCHAR(80)', { notes: 'Batch/lot identity is scoped by item and branch unless the business rule says otherwise.' }),
  simple('stock.count', 'count', 'INTEGER'),
], { kind: 'associative', notes: 'Associative Item/Branch/Batch stock record. Proposed natural grouping: item_barcode + branch_id + batch_number; exact uniqueness remains reviewable.' });

const client = entity('client', 'Client', [
  pk('client.id', 'client_id'),
  composite('client.name', 'name', [simple('client.name.given', 'given_name', 'VARCHAR(120)'), simple('client.name.family', 'family_name', 'VARCHAR(120)')], 'Composite name; confirm locale-specific name parts.'),
  simple('client.phone', 'phone', 'VARCHAR(32)', { kind: 'multivalued' }),
]);

const staff = entity('staff', 'Staff', [
  pk('staff.id', 'staff_id'),
  composite('staff.name', 'name', [simple('staff.name.given', 'given_name', 'VARCHAR(120)'), simple('staff.name.family', 'family_name', 'VARCHAR(120)')], 'Composite name; confirm locale-specific name parts.'),
  simple('staff.phone', 'phone', 'VARCHAR(32)', { kind: 'multivalued' }),
  simple('staff.role', 'role', 'VARCHAR(100)'),
  simple('staff.dob', 'date_of_birth', 'DATE'),
  simple('staff.salary', 'salary', 'DECIMAL(12,2)'),
  simple('staff.start-date', 'start_date', 'DATE'),
  simple('staff.day-shift', 'day_shift', 'BOOLEAN', { notes: 'Source indicates a day-shift field; confirm whether boolean or a time-range/shift entity.' }),
]);

const supplier = entity('supplier', 'Suppliers', [
  pk('supplier.id', 'supplier_id'),
  composite('supplier.name', 'name', [simple('supplier.name.given', 'given_name', 'VARCHAR(120)'), simple('supplier.name.family', 'family_name', 'VARCHAR(120)')], 'Composite name; confirm whether supplier is a person or organization.'),
  simple('supplier.phone', 'phone', 'VARCHAR(32)', { kind: 'multivalued' }),
  simple('supplier.partner-company', 'partner_company', 'VARCHAR(200)'),
  simple('supplier.origin', 'supply_origin', 'VARCHAR(40)', { enumValues: ['Egyptian', 'Chinese', 'Russian', 'other'] }),
]);

const order = entity('customer-order', 'Order', [
  pk('order.id', 'order_id'),
  fk('order.client', 'client_id', 'BIGINT', 'client', 'client.id'),
  simple('order.datetime', 'date_time', 'TIMESTAMP'),
  simple('order.price', 'price', 'DECIMAL(12,2)', { kind: 'derived', derivationFormula: 'SUM(OrderLine.quantity * OrderLine.unit_price_snapshot)', notes: 'Quantity and price snapshot were not specified in the source and are explicitly provisional. Excluded from DDL by default.' }),
  simple('order.payment-method', 'payment_method', 'VARCHAR(24)', { enumValues: ['cash', 'visa', 'phone_wallet', 'instapay'] }),
  simple('order.payment-info', 'payment_info', 'VARCHAR(80)', { isNullable: true, notes: 'Null for cash; last four card digits for Visa; phone number for phone wallet/Instapay. Never model/store full card details.' }),
]);

const orderLine = entity('order-line', 'OrderLine', [
  simple('order-line.order-id', 'order_id', 'BIGINT', { isPK: true, isUnique: true, isFK: true, foreignKeyRef: { entityId: 'customer-order', attributeId: 'order.id' } }),
  simple('order-line.line-number', 'line_number', 'INTEGER', { isPK: true }),
  fk('order-line.item-barcode', 'item_barcode', 'VARCHAR(64)', 'item', 'item.barcode'),
  simple('order-line.quantity', 'quantity', 'DECIMAL(10,2)', { isNullable: true, notes: 'Required for meaningful totals; not specified in source, so left nullable pending confirmation.' }),
  simple('order-line.unit-price', 'unit_price_snapshot', 'DECIMAL(12,2)', { isNullable: true, notes: 'Price-at-sale snapshot is a provisional field; confirm whether historical prices must be preserved.' }),
], { kind: 'associative', notes: 'Order line-item entity; composite key is order_id + line_number.' });

const stockPayment = entity('stock-payment-order', 'StockPaymentOrder', [
  pk('stock-payment.id', 'stock_payment_order_id'),
  fk('stock-payment.supplier', 'supplier_id', 'BIGINT', 'supplier', 'supplier.id'),
  simple('stock-payment.datetime', 'date_time', 'TIMESTAMP'),
  simple('stock-payment.price', 'price', 'DECIMAL(12,2)', { kind: 'derived', derivationFormula: 'SUM(StockPaymentOrderLine.quantity * StockPaymentOrderLine.unit_price_snapshot)', notes: 'Line quantity/unit-cost details were not fully specified; confirm before using financial totals.' }),
]);

const stockPaymentLine = entity('stock-payment-line', 'StockPaymentOrderLine', [
  simple('stock-payment-line.order-id', 'stock_payment_order_id', 'BIGINT', { isPK: true, isUnique: true, isFK: true, foreignKeyRef: { entityId: 'stock-payment-order', attributeId: 'stock-payment.id' } }),
  simple('stock-payment-line.line-number', 'line_number', 'INTEGER', { isPK: true }),
  fk('stock-payment-line.item-barcode', 'item_barcode', 'VARCHAR(64)', 'item', 'item.barcode'),
  simple('stock-payment-line.batch-number', 'batch_number', 'VARCHAR(80)', { notes: 'Batch link is currently a simple value; a composite reference to Stock needs a confirmed stock key.' }),
  simple('stock-payment-line.quantity', 'quantity', 'DECIMAL(10,2)', { isNullable: true, notes: 'Not supplied by source; confirm.' }),
  simple('stock-payment-line.unit-price', 'unit_price_snapshot', 'DECIMAL(12,2)', { isNullable: true, notes: 'Not supplied by source; confirm.' }),
], { kind: 'associative', notes: 'Stock-payment line item; composite key is stock_payment_order_id + line_number.' });

const relationships: Relationship[] = [
  relation('stock-item', 'item', 'stock', 'held in stock', '1', '0..N', { participation: 'total' }),
  relation('stock-branch', 'branch', 'stock', 'stores stock', '1', '0..N', { participation: 'total' }),
  relation('branch-manager', 'staff', 'branch', 'manages / managed by', '0..N', '0..1', { notes: 'Branch-to-manager cardinality is provisionally optional; confirm if every branch needs a manager.' }),
  relation('staff-works-at-branch', 'branch', 'staff', 'works at branch', '1', '0..N', { participation: 'total' }),
  relation('client-orders', 'client', 'customer-order', 'places', '1', '0..N', { participation: 'total' }),
  relation('order-lines', 'customer-order', 'order-line', 'contains lines', '1', '1..N', { participation: 'total', identifying: true }),
  relation('line-item', 'item', 'order-line', 'ordered as', '1', '0..N', { participation: 'total' }),
  relation('supplier-payments', 'supplier', 'stock-payment-order', 'supplies', '1', '0..N', { participation: 'total' }),
  relation('payment-lines', 'stock-payment-order', 'stock-payment-line', 'contains lines', '1', '1..N', { participation: 'total', identifying: true }),
  relation('payment-line-item', 'item', 'stock-payment-line', 'received as', '1', '0..N', { participation: 'total' }),
];

export const pharmacySchema: SchemaModel = {
  version: 1,
  id: 'pharmacy-chain-v1',
  name: 'Pharmacy Chain',
  entities: [item, drug, stock, client, staff, supplier, branch, order, orderLine, stockPayment, stockPaymentLine],
  relationships,
  specializations: [{
    parent: 'item',
    children: ['drug'],
    disjointness: 'disjoint',
    completeness: 'partial',
    notes: 'Disjoint/partial is a provisional specialization choice: only Drug is specified as an Item subtype; confirm future item types.',
  }],
  subjectAreas: [
    { id: 'catalog', name: 'Catalog & inventory', color: '#0E8A83', entityIds: ['item', 'drug', 'stock', 'branch'] },
    { id: 'people', name: 'People & suppliers', color: '#6478B3', entityIds: ['client', 'staff', 'supplier'] },
    { id: 'orders', name: 'Sales & procurement', color: '#B98238', entityIds: ['customer-order', 'order-line', 'stock-payment-order', 'stock-payment-line'] },
  ],
  notes: [
    'Item.discount arithmetic (percentage versus fixed amount) is unresolved.',
    'Item batch-number reference is optional in the source; Stock is the canonical batch/branch record.',
    'Order and procurement line quantities and price snapshots are explicit provisional fields because the source asks for derived prices but omits line arithmetic.',
    'Branch address parts, branch-manager requiredness, stock natural-key uniqueness and specialization completeness need domain confirmation.',
  ],
};
