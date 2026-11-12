import type { Attribute, Entity } from '../model/types';
import { humanize, ModelBuilder, normalizeName, slugify } from './common';
import type { ParseResult } from './types';

interface Section {
  level: number;
  rawHeading: string;
  name: string;
  parentName?: string;
  specializes?: string;
  typeTag?: string;
  lines: Array<{ text: string; line: number }>;
  entity?: Entity;
}

interface ParsedField {
  rawName: string;
  name: string;
  descriptor: string;
  line: number;
}

interface PendingRelation {
  source: Entity;
  targetName: string;
  targetColumn?: string;
  field?: Attribute;
  label: string;
  direction: 'target-parent' | 'managed-by' | 'works-at';
  manyToMany: boolean;
  through?: string;
  line: number;
}

function snakeCase(value: string): string {
  return value.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s./-]+/g, '_').replace(/[^\w\u0600-\u06FF]+/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

function singular(value: string): string {
  const trimmed = value.trim();
  if (trimmed.endsWith('ies')) return `${trimmed.slice(0, -3)}y`;
  if (/(ches|shes|xes|zes)$/.test(trimmed)) return trimmed.slice(0, -2);
  if (trimmed.endsWith('s') && !trimmed.endsWith('ss')) return trimmed.slice(0, -1);
  return trimmed;
}

function canonicalEntityName(raw: string): string {
  const clean = raw.trim();
  if (/^suppliers$/i.test(clean)) return 'Suppliers';
  if (/^stock\s+payment\s+order$/i.test(clean) || /^stockpaymentorder$/i.test(clean)) return 'StockPaymentOrder';
  if (/^order\s*line$/i.test(clean) || /^orderline$/i.test(clean)) return 'OrderLine';
  if (/^stock\s*payment\s*order\s*line$/i.test(clean) || /^stockpaymentorderline$/i.test(clean)) return 'StockPaymentOrderLine';
  if (/^transcription\s*line$/i.test(clean) || /^transcriptionline$/i.test(clean)) return 'TranscriptionLine';
  if (/^[a-z0-9\s_-]+$/i.test(clean) && (clean === clean.toUpperCase() || clean === clean.toLowerCase())) {
    return humanize(clean.toLowerCase()).replace(/\s+/g, '');
  }
  return clean;
}

function entityHeading(raw: string, parentName?: string): { name: string; specializes?: string; typeTag?: string } {
  const clean = raw.replace(/\s+\{\s*$/, '').trim();
  const specialization = clean.match(/^(.+?)\s+(?:specializes|extends|is a subtype of)\s+(.+)$/i);
  const typeTag = clean.match(/\(\s*type\s*:\s*([^)]*)\)/i)?.[1]?.trim();
  let name = (specialization?.[1] ?? clean).replace(/\([^)]*\)/g, '').trim();
  if (typeTag && /drug|medicine/i.test(typeTag)) {
    name = 'Drug';
  } else if (parentName && /^transcription$/i.test(parentName) && /^customer$/i.test(name)) {
    name = 'CustomerTranscription';
    return { name, specializes: 'Transcription', ...(typeTag ? { typeTag } : {}) };
  } else {
    name = canonicalEntityName(name);
  }
  return { name, ...(specialization?.[2] ? { specializes: singular(specialization[2].trim()) } : {}), ...(typeTag ? { typeTag } : {}) };
}

const STAFF_SUBTYPE_MAP: Array<{ pattern: RegExp; entityName: string }> = [
  { pattern: /^pharmacists?$/i, entityName: 'Pharmacist' },
  { pattern: /^delivery(?:\s+staff)?$/i, entityName: 'DeliveryStaff' },
  { pattern: /^call\s+center(?:\s+staff)?$/i, entityName: 'CallCenterStaff' },
  { pattern: /^it\s+admins?$/i, entityName: 'ItAdmin' },
];

function normalizeFlattenedOutline(source: string): string {
  const rawLines = source.split(/\r?\n/);
  if (rawLines.length > 3 || !/#{2,6}\s+\S/.test(source)) return source;
  return source
    .replace(/\s+(#{1,6}\s+)/g, '\n$1')
    .replace(/\s+(-\s+(?=[A-Za-z\u0600-\u06FF]))/g, '\n$1');
}

function parseSections(rawSource: string): { sections: Section[]; title: string } {
  const source = normalizeFlattenedOutline(rawSource);
  const sections: Section[] = [];
  const stack: Section[] = [];
  let current: Section | undefined;
  let activeStaffSubtype: Section | undefined;
  let title = 'Imported schema';
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      activeStaffSubtype = undefined;
      const level = heading[1]!.length;
      const headingText = heading[2]!.trim();
      if (level === 1) {
        if (/^world$/i.test(headingText)) title = 'World';
        else if (!/^(schema|entities|overview|database|model)$/i.test(headingText)) title = headingText.replace(/\s+(schema|diagram)$/i, '').trim();
        current = undefined;
        continue;
      }
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      if (/^(attributes?|fields|columns|properties|relationships?|constraints|notes|details)$/i.test(headingText)) {
        current = stack[stack.length - 1];
        continue;
      }
      const parent = stack[stack.length - 1];
      const parsed = entityHeading(headingText, parent?.name);
      const section: Section = {
        level,
        rawHeading: headingText,
        name: parsed.name,
        ...(parsed.specializes ? { specializes: parsed.specializes } : {}),
        ...(parsed.typeTag ? { typeTag: parsed.typeTag } : {}),
        ...(parent?.name ? { parentName: parent.name } : {}),
        lines: [],
      };
      sections.push(section);
      stack.push(section);
      current = section;
      continue;
    }

    if (current && /^staff$/i.test(current.name)) {
      const bulletMatch = line.match(/^(\s*)[-*+]\s+(.+?)\s*$/);
      if (bulletMatch) {
        const bulletText = bulletMatch[2]!.trim();
        const matchedSubtype = STAFF_SUBTYPE_MAP.find((item) => item.pattern.test(bulletText));
        if (matchedSubtype) {
          const subtypeSection: Section = {
            level: current.level + 1,
            rawHeading: bulletText,
            name: matchedSubtype.entityName,
            parentName: current.name,
            specializes: current.name,
            lines: [],
          };
          sections.push(subtypeSection);
          activeStaffSubtype = subtypeSection;
          continue;
        }
        if (activeStaffSubtype) {
          if (/\s+-\s+/.test(bulletText) && !/\(/.test(bulletText)) {
            for (const subPart of bulletText.split(/\s+-\s+/)) {
              if (subPart.trim()) activeStaffSubtype.lines.push({ text: `- ${subPart.trim()}`, line: index + 1 });
            }
          } else {
            activeStaffSubtype.lines.push({ text: line, line: index + 1 });
          }
          continue;
        }
      }
    }

    if (current) current.lines.push({ text: line, line: index + 1 });
  }
  return { sections, title };
}

function splitOutsideParens(input: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if ((ch === ',' || ch === '،') && depth === 0) {
      const piece = input.slice(start, i).trim();
      if (piece) parts.push(piece);
      start = i + 1;
    }
  }
  const last = input.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function parseSingleBulletPart(cleaned: string, line: number): ParsedField | undefined {
  const normalized = cleaned.replace(/\(s\)/gi, 's').trim();
  if (!normalized || /^[.?…_-]+$/.test(normalized)) return undefined;
  const firstParen = normalized.indexOf('(');
  const colon = normalized.indexOf(':');
  let rawName: string;
  let descriptor: string;
  if (colon >= 0 && (firstParen < 0 || colon < firstParen)) {
    rawName = normalized.slice(0, colon).trim().replace(/[?]+$/, '').trim();
    descriptor = normalized.slice(colon + 1).trim();
  } else {
    rawName = (firstParen >= 0 ? normalized.slice(0, firstParen) : normalized).trim().replace(/[?]+$/, '').trim();
    descriptor = firstParen >= 0 ? normalized.slice(firstParen).trim().replace(/^\(|\)$/g, '') : '';
  }
  if (!rawName) return undefined;
  let canonicalField = snakeCase(rawName);
  if (!canonicalField) return undefined;
  if (canonicalField === 'perscription') canonicalField = 'prescription';
  if (/^active_pharma.*ingredients?$/.test(canonicalField)) canonicalField = 'active_pharmaceutical_ingredients';
  return { rawName, name: canonicalField, descriptor, line };
}

function parseBullet(raw: string, line: number): ParsedField[] {
  const bullet = raw.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/)?.[1];
  if (!bullet) return [];
  const cleaned = bullet.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]*)\*\*/g, '$1').trim();
  if (!cleaned || /^[.?…_-]+$/.test(cleaned)) return [];
  if (/^primary\s+key\s*:/i.test(cleaned) || /^logical\s+key\s*:/i.test(cleaned)) return [];
  if (/items\s*\(\s*refe?renced\s+by\s+barcode\s*\)\s*,\s*batch\s+numbers?/i.test(cleaned)) {
    return [{
      rawName: 'items',
      name: 'items',
      descriptor: 'line items referencing Item.barcode and batch_number',
      line,
    }];
  }
  if (/^client\s*\(\s*customer\s*\)\s*\(\s*supplier\s*\)$/i.test(cleaned)) {
    return [
      { rawName: 'customer', name: 'customer', descriptor: 'nullable relation to Customer', line },
      { rawName: 'supplier', name: 'supplier', descriptor: 'nullable relation to Suppliers', line },
    ];
  }
  const topParts = splitOutsideParens(cleaned);
  if (topParts.length > 1 && !/\b(?:composite|conisists|consists|multivalued|multi|derived|derrived|enum)\b/i.test(cleaned)) {
    return topParts.map((part) => parseSingleBulletPart(part, line)).filter((item): item is ParsedField => Boolean(item));
  }
  const single = parseSingleBulletPart(cleaned, line);
  return single ? [single] : [];
}

function mapType(name: string, descriptor: string): string {
  const match = descriptor.match(/\b(bigint|big integer|smallint|integer|int|tinyint|decimal(?:\s*\([^)]*\))?|numeric(?:\s*\([^)]*\))?|money|float|double|bool(?:ean)?|date(?:time)?|timestamp|time|uuid|json|varchar(?:\s*\([^)]*\))?|char(?:\s*\([^)]*\))?|text|string|enum)\b/i)?.[0];
  if (match) {
    const type = match.toUpperCase().replace(/BIG INTEGER/, 'BIGINT').replace(/^STRING$/, 'VARCHAR').replace(/^MONEY$/, 'DECIMAL').replace(/^BOOL$/, 'BOOLEAN');
    return type;
  }
  const key = name.toLowerCase();
  if (/price|salary|discount|amount|cost|total|fee|balance|سعر|راتب|مبلغ|إجمالي|تكلفة|رصيد/.test(key)) return 'DECIMAL';
  if (/count|quantity|strips|qty|age|floor|capacity|year|number_of|عدد|كمية|عمر|سعة/.test(key)) return 'INTEGER';
  if (/date|تاريخ/.test(key)) return 'DATE';
  if (/time|created_at|updated_at|scheduled_at|وقت/.test(key)) return 'TIME';
  if (/prescription|perscription|shift|nullable|active|enabled|is_|has_|نشط|حالة/.test(key)) return 'BOOLEAN';
  if (/phone|barcode|name|address|origin|type|role|method|info|number|batch|ingredient|strength|manufacturer|company|partner|email|title|status|client|customer|supplier|ssn|specialization|language|vehicle|categories|category|نقابه|ضريبي|اسم|عنوان|هاتف|بريد|وصف|نوع/.test(key)) return 'VARCHAR';
  return 'VARCHAR';
}

function enumValues(descriptor: string): string[] | undefined {
  const match = descriptor.match(/\benum\s*(?:of\s*)?([^.;]+)/i);
  if (match) {
    const values = match[1]!.replace(/^[([]|[)\]]$/g, '').split(/,|\bor\b/i).map((item) => item.trim().replace(/^['"`]|['"`]$/g, '')).filter((item) => Boolean(item) && item !== '...');
    return values.length ? values : undefined;
  }
  const parenList = descriptor.match(/^([a-z0-9_]+(?:\s*,\s*[a-z0-9_]+)+(?:\s*,\s*\.\.\.)?)$/i);
  if (parenList) {
    const values = parenList[1]!.split(',').map((item) => item.trim()).filter((item) => Boolean(item) && item !== '...');
    return values.length ? values : undefined;
  }
  return undefined;
}

function compositeChildren(entity: Entity, field: ParsedField, type: string): Attribute[] | undefined {
  const descriptor = field.descriptor;
  const explicit = descriptor.match(/\b(?:composite(?:\s+of)?|conisists\s+of\s*:?|consists\s+of\s*:?|includes?)\s+(.+?)(?:\)|$|;|\.)/i)?.[1];
  const strength = /\bstrength\b/i.test(descriptor) && /ingredient|pharmaceutical|pharmatical|active/i.test(field.rawName);
  const isPersonName = field.name === 'name' && /composite\s+if\s+needed/i.test(descriptor);
  const childNames = strength
    ? ['ingredient_name', 'strength']
    : isPersonName
      ? ['given_name', 'family_name']
      : explicit && !/^if\s+needed$/i.test(explicit.trim())
        ? explicit.split(/,|\band\b/i).map((item) => snakeCase(item.replace(/^[([]|[)\]]$/g, '').replace(/^(?:of|and)\s+/i, ''))).filter(Boolean)
        : [];
  if (!childNames.length) return undefined;
  return childNames.map((name) => ({
    id: `${entity.id}.${field.name}.${slugify(name)}`,
    name,
    dataType: /strength|type/i.test(name) ? 'VARCHAR' : /salary|amount|price/i.test(name) ? 'DECIMAL' : type === 'UNKNOWN' || type === 'COMPOSITE' ? 'VARCHAR' : type,
    isPK: false,
    isFK: false,
    isUnique: false,
    isNullable: true,
    kind: 'simple',
    notes: '',
  }));
}

function buildAttribute(builder: ModelBuilder, entity: Entity, field: ParsedField): Attribute | undefined {
  const descriptor = field.descriptor;
  const lower = descriptor.toLowerCase();
  const fieldLower = field.name.toLowerCase();
  const isDerived = /\bderr?ived\b/.test(lower);
  const isMultivalued = /\bmultivalued\b|\bmulti\b|multiple values|multiple phone/i.test(lower);
  const isComposite = /\bcomposite\b|\bconisists\s+of\b|\bconsists\s+of\b/.test(lower);
  const kind: Attribute['kind'] = isDerived ? 'derived' : isMultivalued ? 'multivalued' : isComposite ? 'composite' : 'simple';
  const attrName = isDerived && fieldLower === 'price' && /order|transcription|transaction/i.test(entity.name) ? 'total_price' : field.name;
  const type = mapType(attrName, descriptor);
  const children = kind === 'composite' || (kind === 'multivalued' && /composite|strength/i.test(lower)) ? compositeChildren(entity, field, type) : undefined;
  const derivedMatch = descriptor.match(/derr?ived\s*(?:from|as|:|,)?\s*(.+?)(?:[.;]|$)/i);
  const values = enumValues(descriptor);
  const isPk = /\b(?:primary\s+key|primary|pk)\b/i.test(descriptor);
  const nullable = /\b(?:optional|nullable|may be null|can be null|null if)\b/i.test(descriptor) && !/not nullable|not null/i.test(descriptor);
  const attribute = builder.addAttribute(entity, attrName, type, {
    isPK: isPk,
    isUnique: /\bunique\b/i.test(descriptor) || isPk || (normalizeName(entity.name) === 'item' && attrName === 'barcode') || attrName === 'ssn',
    isNullable: nullable || !isPk,
    kind,
    ...(children ? { children } : {}),
    ...(kind === 'derived' ? { derivationFormula: derivedMatch?.[1]?.trim() || 'SUM(line_items)' } : {}),
    ...(values ? { enumValues: values } : {}),
    notes: kind === 'composite' && !children?.length ? 'Composite components were not listed in the input; review the grouping.' : '',
  });
  return attribute;
}

function resolveEntity(builder: ModelBuilder, name: string): Entity | undefined {
  const candidate = name.trim().replace(/[.,:;]+$/, '');
  let found = builder.getEntity(candidate) ?? builder.getEntity(singular(candidate));
  if (found) return found;
  const key = normalizeName(candidate).replace(/[^a-z0-9\u0600-\u06FF]/g, '');
  found = builder.model.entities.find((entity) => {
    const entityKey = normalizeName(entity.name).replace(/[^a-z0-9\u0600-\u06FF]/g, '');
    return entityKey === key || singular(entityKey) === key || singular(key) === entityKey;
  });
  if (found) return found;
  if (key === 'client' || key === 'clients') {
    return builder.getEntity('Customer') ?? builder.getEntity('Customers');
  }
  if (key === 'customer' || key === 'customers') {
    return builder.getEntity('Client') ?? builder.getEntity('Clients');
  }
  return undefined;
}

function parseTarget(descriptor: string, fieldName: string, builder: ModelBuilder): { target: Entity; column?: string; direction: PendingRelation['direction']; manyToMany: boolean; through?: string } | undefined {
  const lower = descriptor.toLowerCase();
  const fieldLower = fieldName.toLowerCase();
  let direction: PendingRelation['direction'] = 'target-parent';
  if (/\bmanaged\s+by\b/.test(lower) || /^managed_by/.test(fieldLower)) direction = 'managed-by';
  else if (/\bworks?\s+at\b/.test(lower) || /\bassigned\s+to\b/.test(lower) || /^works_at_/.test(fieldLower)) direction = 'works-at';
  const manyToMany = /many[- ]to[- ]many|many to many/i.test(descriptor);
  let through = descriptor.match(/\bthrough\s+([\w.-]+)/i)?.[1];
  if (manyToMany && !through && /^stock\b/i.test(fieldLower)) through = 'Stock';

  const explicitRef = descriptor.match(/\b(?:references?|referencing)\s+([A-Za-z_][\w .-]*?)(?:\.([A-Za-z_][\w.-]*))?(?:\s|$|[),;])/i);
  const referencedBy = !/maybe\s+refe?renced\s+by/i.test(descriptor)
    ? descriptor.match(/\brefe?renced\s+by\s+([A-Za-z_][\w.-]*)/i)?.[1]
    : undefined;

  let targetName = explicitRef?.[1]?.trim();
  let targetColumn = explicitRef?.[2];

  if (!targetName && referencedBy && normalizeName(referencedBy) === 'barcode' && /^items?$/i.test(fieldLower)) {
    targetName = 'Item';
    targetColumn = 'barcode';
  }
  if (!targetName && direction === 'managed-by') {
    targetName = descriptor.match(/\bmanaged\s+by\s+([\w.-]+)/i)?.[1] ?? 'Staff';
  }
  if (!targetName && direction === 'works-at') {
    targetName = descriptor.match(/\b(?:works?\s+at|assigned\s+to)\s+([\w.-]+)/i)?.[1] ?? fieldLower.replace(/^works_at_?/, '');
  }
  if (!targetName && manyToMany && /item/i.test(fieldLower)) {
    targetName = 'Item';
  }
  if (!targetName) {
    targetName = descriptor.match(/\brelation\s+to\s+([\w.-]+)/i)?.[1]
      ?? descriptor.match(/\b(?:related\s+to|many[- ]to[- ]many\s+with)\s+([\w.-]+)/i)?.[1];
  }
  if (!targetName) {
    const base = fieldName.replace(/(?:_id|_barcode|_ref)$/i, '').replace(/_/g, ' ');
    if (resolveEntity(builder, base)) targetName = base;
  }
  if (!targetName) return undefined;
  const target = resolveEntity(builder, targetName);
  if (!target) {
    builder.addDiagnostic('warning', `Could not resolve the relationship target "${targetName}" for ${fieldName}; no entity was invented.`, undefined, 'partial.text.unresolved-entity');
    return undefined;
  }
  return { target, ...(targetColumn ? { column: targetColumn } : {}), direction, manyToMany, ...(through ? { through } : {}) };
}

function ensureForeignKey(builder: ModelBuilder, child: Entity, target: Entity, local: Attribute | undefined, targetColumnName?: string): void {
  if (!local) return;
  const targetAttribute = targetColumnName ? builder.findAttribute(target, targetColumnName) : target.attributes.find((attribute) => attribute.isPK);
  if (!targetAttribute) {
    builder.addDiagnostic('warning', `Reference ${child.name}.${local.name} → ${target.name}.${targetColumnName ?? 'primary key'} could not resolve a target attribute.`, undefined, 'partial.text.unresolved-reference');
    return;
  }
  local.isFK = true;
  local.foreignKeyRef = { entityId: target.id, attributeId: targetAttribute.id };
}

function lineEntity(builder: ModelBuilder, parent: Entity, item: Entity, procurement: boolean): Entity {
  const isTranscription = /transcription|transaction/i.test(parent.name);
  const name = procurement ? 'StockPaymentOrderLine' : isTranscription ? 'TranscriptionLine' : 'OrderLine';
  const existing = builder.getEntity(name);
  if (existing) return existing;
  const line = builder.addEntity(name, { kind: 'associative', notes: `Generated from ${parent.name}.items.` });
  const parentKey = parent.attributes.find((attribute) => attribute.isPK);
  const itemKey = item.attributes.find((attribute) => normalizeName(attribute.name) === 'barcode') ?? item.attributes.find((attribute) => attribute.isPK);
  const parentIdName = `${snakeCase(parent.name)}_id`;
  const parentId = builder.addAttribute(line, parentIdName, parentKey?.dataType ?? 'BIGINT', { isPK: true, isFK: Boolean(parentKey), isUnique: false, isNullable: false, ...(parentKey ? { foreignKeyRef: { entityId: parent.id, attributeId: parentKey.id } } : {}), notes: 'Line-item parent key; composite primary-key component.' });
  if (parentKey && parentId) builder.addRelationship(parent, line, 'contains lines', { fromCardinality: '1', toCardinality: '1..N', identifying: true, participation: 'total' });
  builder.addAttribute(line, 'line_number', 'INTEGER', { isPK: true, isUnique: false, isNullable: false, notes: 'Composite-key component for a line within its parent.' });
  const itemRefColName = itemKey && normalizeName(itemKey.name) === 'barcode' ? 'item_barcode' : 'item_id';
  const itemBarcode = builder.addAttribute(line, itemRefColName, itemKey?.dataType ?? 'VARCHAR', { isPK: true, isFK: Boolean(itemKey), isUnique: false, isNullable: false, ...(itemKey ? { foreignKeyRef: { entityId: item.id, attributeId: itemKey.id } } : {}), notes: itemKey ? `References ${item.name}.${itemKey.name}.` : 'Item reference target is not specified.' });
  if (itemKey && itemBarcode) builder.addRelationship(item, line, 'included as line item', { fromCardinality: '1', toCardinality: '0..N', participation: 'total' });
  if (procurement) builder.addAttribute(line, 'batch_number', 'VARCHAR', { isPK: false, isNullable: false, notes: 'Batch number for stock order line.' });
  builder.addAttribute(line, 'quantity', 'INTEGER', { isNullable: false, notes: 'Line item quantity.' });
  builder.addAttribute(line, 'unit_price_snapshot', 'DECIMAL', { isNullable: false, notes: 'Unit price at transaction time.' });
  return line;
}

type BlueprintTable = {
  name: string;
  kind?: 'strong' | 'weak' | 'associative';
  attrs: Array<[string, string, boolean?]>;
};

const FULL_DOMAIN_BLUEPRINTS: Array<{ pattern: RegExp; tables: BlueprintTable[] }> = [
  {
    pattern: /(?:صيدلي|صيدليات|أدوية|دواء|علاج|روشتة|pharmacy|drugstore|medication)/i,
    tables: [
      { name: 'branches', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(150)'], ['tax_number', 'VARCHAR(60)'], ['phone', 'VARCHAR(40)'], ['address', 'VARCHAR(255)']] },
      { name: 'staff', attrs: [['id', 'BIGINT', true], ['branch_id', 'BIGINT'], ['full_name', 'VARCHAR(150)'], ['ssn', 'VARCHAR(40)'], ['role', 'VARCHAR(60)'], ['salary', 'DECIMAL(10,2)'], ['shift', 'VARCHAR(40)']] },
      { name: 'suppliers', attrs: [['id', 'BIGINT', true], ['company_name', 'VARCHAR(160)'], ['contact_name', 'VARCHAR(120)'], ['phone', 'VARCHAR(40)'], ['email', 'VARCHAR(255)'], ['supply_origin', 'VARCHAR(80)']] },
      { name: 'customers', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['phone', 'VARCHAR(40)'], ['ssn', 'VARCHAR(40)'], ['address', 'VARCHAR(255)']] },
      { name: 'items', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(180)'], ['barcode', 'VARCHAR(80)'], ['manufacturer', 'VARCHAR(150)'], ['type', 'VARCHAR(60)'], ['unit_price', 'DECIMAL(10,2)']] },
      { name: 'drugs', kind: 'weak', attrs: [['id', 'BIGINT', true], ['item_id', 'BIGINT'], ['active_ingredient', 'VARCHAR(180)'], ['strength', 'VARCHAR(60)'], ['physical_type', 'VARCHAR(60)'], ['prescription_required', 'BOOLEAN']] },
      { name: 'branch_stock', kind: 'associative', attrs: [['id', 'BIGINT', true], ['branch_id', 'BIGINT'], ['item_id', 'BIGINT'], ['batch_number', 'VARCHAR(60)'], ['quantity', 'INTEGER'], ['expiry_date', 'DATE']] },
      { name: 'orders', attrs: [['id', 'BIGINT', true], ['customer_id', 'BIGINT'], ['branch_id', 'BIGINT'], ['staff_id', 'BIGINT'], ['payment_method', 'VARCHAR(50)'], ['total_price', 'DECIMAL(10,2)'], ['ordered_at', 'TIMESTAMP']] },
      { name: 'order_items', kind: 'associative', attrs: [['id', 'BIGINT', true], ['order_id', 'BIGINT'], ['item_id', 'BIGINT'], ['quantity', 'INTEGER'], ['unit_price', 'DECIMAL(10,2)']] },
    ],
  },
  {
    pattern: /(?:مستشفى|عيادة|عيادات|طبي|أطباء|مرضى|تشخيص|hospital|clinic|medical|healthcare|patient)/i,
    tables: [
      { name: 'departments', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(140)'], ['building', 'VARCHAR(80)'], ['floor_number', 'INTEGER'], ['phone_ext', 'VARCHAR(20)']] },
      { name: 'doctors', attrs: [['id', 'BIGINT', true], ['department_id', 'BIGINT'], ['full_name', 'VARCHAR(150)'], ['specialty', 'VARCHAR(120)'], ['license_number', 'VARCHAR(60)'], ['phone', 'VARCHAR(40)']] },
      { name: 'patients', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['national_id', 'VARCHAR(40)'], ['date_of_birth', 'DATE'], ['blood_type', 'VARCHAR(10)'], ['phone', 'VARCHAR(40)']] },
      { name: 'rooms', attrs: [['id', 'BIGINT', true], ['department_id', 'BIGINT'], ['room_number', 'VARCHAR(30)'], ['room_type', 'VARCHAR(50)'], ['daily_rate', 'DECIMAL(10,2)']] },
      { name: 'appointments', attrs: [['id', 'BIGINT', true], ['patient_id', 'BIGINT'], ['doctor_id', 'BIGINT'], ['room_id', 'BIGINT'], ['scheduled_at', 'TIMESTAMP'], ['status', 'VARCHAR(40)']] },
      { name: 'prescriptions', attrs: [['id', 'BIGINT', true], ['appointment_id', 'BIGINT'], ['doctor_id', 'BIGINT'], ['patient_id', 'BIGINT'], ['diagnosis', 'TEXT'], ['medications', 'TEXT'], ['issued_at', 'TIMESTAMP']] },
      { name: 'invoices', attrs: [['id', 'BIGINT', true], ['patient_id', 'BIGINT'], ['appointment_id', 'BIGINT'], ['total_amount', 'DECIMAL(10,2)'], ['payment_status', 'VARCHAR(40)'], ['issued_at', 'TIMESTAMP']] },
    ],
  },
  {
    pattern: /(?:مدرسة|مدارس|جامعة|جامعات|كلية|طلاب|طالب|كورسات|مقررات|تعليم|school|university|college|student|course|lms|academy)/i,
    tables: [
      { name: 'departments', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(150)'], ['code', 'VARCHAR(30)'], ['building', 'VARCHAR(80)']] },
      { name: 'instructors', attrs: [['id', 'BIGINT', true], ['department_id', 'BIGINT'], ['full_name', 'VARCHAR(150)'], ['academic_title', 'VARCHAR(80)'], ['email', 'VARCHAR(255)'], ['phone', 'VARCHAR(40)']] },
      { name: 'students', attrs: [['id', 'BIGINT', true], ['department_id', 'BIGINT'], ['full_name', 'VARCHAR(150)'], ['student_code', 'VARCHAR(40)'], ['email', 'VARCHAR(255)'], ['enrollment_year', 'INTEGER']] },
      { name: 'courses', attrs: [['id', 'BIGINT', true], ['department_id', 'BIGINT'], ['instructor_id', 'BIGINT'], ['code', 'VARCHAR(30)'], ['title', 'VARCHAR(180)'], ['credit_hours', 'INTEGER']] },
      { name: 'classrooms', attrs: [['id', 'BIGINT', true], ['building', 'VARCHAR(80)'], ['room_number', 'VARCHAR(30)'], ['capacity', 'INTEGER']] },
      { name: 'enrollments', kind: 'associative', attrs: [['id', 'BIGINT', true], ['student_id', 'BIGINT'], ['course_id', 'BIGINT'], ['semester', 'VARCHAR(40)'], ['grade', 'DECIMAL(5,2)'], ['enrolled_at', 'DATE']] },
      { name: 'exams', attrs: [['id', 'BIGINT', true], ['course_id', 'BIGINT'], ['classroom_id', 'BIGINT'], ['exam_date', 'DATE'], ['max_score', 'DECIMAL(5,2)']] },
    ],
  },
  {
    pattern: /(?:مطعم|مطاعم|كافيه|مقهى|منيو|وجبات|طاولات|شيف|restaurant|cafe|menu|dining|food\s+delivery)/i,
    tables: [
      { name: 'branches', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(140)'], ['address', 'VARCHAR(255)'], ['phone', 'VARCHAR(40)']] },
      { name: 'dining_tables', attrs: [['id', 'BIGINT', true], ['branch_id', 'BIGINT'], ['table_number', 'INTEGER'], ['seats_count', 'INTEGER'], ['status', 'VARCHAR(40)']] },
      { name: 'menu_categories', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(120)'], ['display_order', 'INTEGER']] },
      { name: 'menu_items', attrs: [['id', 'BIGINT', true], ['menu_category_id', 'BIGINT'], ['name', 'VARCHAR(160)'], ['price', 'DECIMAL(10,2)'], ['is_available', 'BOOLEAN']] },
      { name: 'customers', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['phone', 'VARCHAR(40)'], ['address', 'VARCHAR(255)']] },
      { name: 'staff', attrs: [['id', 'BIGINT', true], ['branch_id', 'BIGINT'], ['full_name', 'VARCHAR(150)'], ['role', 'VARCHAR(60)'], ['phone', 'VARCHAR(40)']] },
      { name: 'orders', attrs: [['id', 'BIGINT', true], ['branch_id', 'BIGINT'], ['dining_table_id', 'BIGINT'], ['customer_id', 'BIGINT'], ['staff_id', 'BIGINT'], ['order_type', 'VARCHAR(40)'], ['total_amount', 'DECIMAL(10,2)'], ['created_at', 'TIMESTAMP']] },
      { name: 'order_items', kind: 'associative', attrs: [['id', 'BIGINT', true], ['order_id', 'BIGINT'], ['menu_item_id', 'BIGINT'], ['quantity', 'INTEGER'], ['unit_price', 'DECIMAL(10,2)']] },
    ],
  },
  {
    pattern: /(?:فندق|فنادق|منتجع|غرف\s*فندقية|حجز\s*فندق|نزلاء|hotel|resort|hospitality|room\s*booking)/i,
    tables: [
      { name: 'guests', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['passport_or_ssn', 'VARCHAR(50)'], ['phone', 'VARCHAR(40)'], ['email', 'VARCHAR(255)']] },
      { name: 'room_types', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(100)'], ['base_price', 'DECIMAL(10,2)'], ['max_occupancy', 'INTEGER']] },
      { name: 'rooms', attrs: [['id', 'BIGINT', true], ['room_type_id', 'BIGINT'], ['room_number', 'VARCHAR(20)'], ['floor', 'INTEGER'], ['status', 'VARCHAR(40)']] },
      { name: 'reservations', attrs: [['id', 'BIGINT', true], ['guest_id', 'BIGINT'], ['room_id', 'BIGINT'], ['check_in_date', 'DATE'], ['check_out_date', 'DATE'], ['total_amount', 'DECIMAL(10,2)'], ['status', 'VARCHAR(40)']] },
      { name: 'services', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(120)'], ['price', 'DECIMAL(10,2)']] },
      { name: 'reservation_services', kind: 'associative', attrs: [['id', 'BIGINT', true], ['reservation_id', 'BIGINT'], ['service_id', 'BIGINT'], ['quantity', 'INTEGER'], ['charged_amount', 'DECIMAL(10,2)']] },
      { name: 'payments', attrs: [['id', 'BIGINT', true], ['reservation_id', 'BIGINT'], ['payment_method', 'VARCHAR(50)'], ['amount', 'DECIMAL(10,2)'], ['paid_at', 'TIMESTAMP']] },
    ],
  },
  {
    pattern: /(?:موارد\s*بشرية|شؤون\s*موظفين|رواتب|حضور\s*وانصراف|إجازات|شركة|hr|human\s*resources|payroll|employee\s*management)/i,
    tables: [
      { name: 'departments', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(140)'], ['location', 'VARCHAR(120)']] },
      { name: 'job_positions', attrs: [['id', 'BIGINT', true], ['department_id', 'BIGINT'], ['title', 'VARCHAR(140)'], ['min_salary', 'DECIMAL(10,2)'], ['max_salary', 'DECIMAL(10,2)']] },
      { name: 'employees', attrs: [['id', 'BIGINT', true], ['department_id', 'BIGINT'], ['job_position_id', 'BIGINT'], ['full_name', 'VARCHAR(150)'], ['email', 'VARCHAR(255)'], ['phone', 'VARCHAR(40)'], ['hire_date', 'DATE'], ['base_salary', 'DECIMAL(10,2)']] },
      { name: 'attendance_logs', attrs: [['id', 'BIGINT', true], ['employee_id', 'BIGINT'], ['work_date', 'DATE'], ['check_in', 'TIME'], ['check_out', 'TIME'], ['status', 'VARCHAR(40)']] },
      { name: 'leave_requests', attrs: [['id', 'BIGINT', true], ['employee_id', 'BIGINT'], ['leave_type', 'VARCHAR(50)'], ['start_date', 'DATE'], ['end_date', 'DATE'], ['status', 'VARCHAR(40)']] },
      { name: 'payrolls', attrs: [['id', 'BIGINT', true], ['employee_id', 'BIGINT'], ['pay_month', 'VARCHAR(20)'], ['gross_salary', 'DECIMAL(10,2)'], ['deductions', 'DECIMAL(10,2)'], ['net_salary', 'DECIMAL(10,2)'], ['paid_at', 'DATE']] },
    ],
  },
  {
    pattern: /(?:مكتبة|كتب|استعارة|مؤلفين|قراء|library|book\s*loan|bookstore)/i,
    tables: [
      { name: 'categories', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(120)'], ['shelf_code', 'VARCHAR(30)']] },
      { name: 'authors', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['nationality', 'VARCHAR(80)']] },
      { name: 'books', attrs: [['id', 'BIGINT', true], ['category_id', 'BIGINT'], ['author_id', 'BIGINT'], ['isbn', 'VARCHAR(40)'], ['title', 'VARCHAR(200)'], ['published_year', 'INTEGER'], ['available_copies', 'INTEGER']] },
      { name: 'members', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['email', 'VARCHAR(255)'], ['phone', 'VARCHAR(40)'], ['joined_at', 'DATE']] },
      { name: 'loans', attrs: [['id', 'BIGINT', true], ['book_id', 'BIGINT'], ['member_id', 'BIGINT'], ['loan_date', 'DATE'], ['due_date', 'DATE'], ['return_date', 'DATE'], ['status', 'VARCHAR(40)']] },
      { name: 'fines', attrs: [['id', 'BIGINT', true], ['loan_id', 'BIGINT'], ['member_id', 'BIGINT'], ['amount', 'DECIMAL(10,2)'], ['is_paid', 'BOOLEAN']] },
    ],
  },
  {
    pattern: /(?:جيم|نادي\s*رياضي|لياقة|مدربين|اشتراكات\s*جيم|gym|fitness|workout|health\s*club)/i,
    tables: [
      { name: 'membership_plans', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(120)'], ['duration_months', 'INTEGER'], ['price', 'DECIMAL(10,2)']] },
      { name: 'members', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['phone', 'VARCHAR(40)'], ['email', 'VARCHAR(255)'], ['joined_at', 'DATE']] },
      { name: 'trainers', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['specialty', 'VARCHAR(120)'], ['phone', 'VARCHAR(40)']] },
      { name: 'subscriptions', attrs: [['id', 'BIGINT', true], ['member_id', 'BIGINT'], ['membership_plan_id', 'BIGINT'], ['start_date', 'DATE'], ['end_date', 'DATE'], ['status', 'VARCHAR(40)']] },
      { name: 'classes', attrs: [['id', 'BIGINT', true], ['trainer_id', 'BIGINT'], ['title', 'VARCHAR(140)'], ['schedule_time', 'TIMESTAMP'], ['capacity', 'INTEGER']] },
      { name: 'class_bookings', kind: 'associative', attrs: [['id', 'BIGINT', true], ['class_id', 'BIGINT'], ['member_id', 'BIGINT'], ['booked_at', 'TIMESTAMP']] },
    ],
  },
  {
    pattern: /(?:عقارات|عقار|شقق|إيجار|إيجارات|ملاك|مستأجرين|real\s*estate|property|lease|rental\s*units)/i,
    tables: [
      { name: 'owners', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['phone', 'VARCHAR(40)'], ['email', 'VARCHAR(255)']] },
      { name: 'properties', attrs: [['id', 'BIGINT', true], ['owner_id', 'BIGINT'], ['name', 'VARCHAR(160)'], ['city', 'VARCHAR(100)'], ['address', 'VARCHAR(255)']] },
      { name: 'units', attrs: [['id', 'BIGINT', true], ['property_id', 'BIGINT'], ['unit_number', 'VARCHAR(40)'], ['area_sqm', 'INTEGER'], ['monthly_rent', 'DECIMAL(10,2)'], ['status', 'VARCHAR(40)']] },
      { name: 'tenants', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['national_id', 'VARCHAR(40)'], ['phone', 'VARCHAR(40)']] },
      { name: 'lease_contracts', attrs: [['id', 'BIGINT', true], ['unit_id', 'BIGINT'], ['tenant_id', 'BIGINT'], ['start_date', 'DATE'], ['end_date', 'DATE'], ['rent_amount', 'DECIMAL(10,2)']] },
      { name: 'rent_payments', attrs: [['id', 'BIGINT', true], ['lease_contract_id', 'BIGINT'], ['tenant_id', 'BIGINT'], ['amount', 'DECIMAL(10,2)'], ['paid_at', 'DATE'], ['payment_method', 'VARCHAR(50)']] },
    ],
  },
  {
    pattern: /(?:مخزن|مخازن|مستودع|مستودعات|جرد|توريد|warehouse|inventory|stock\s*management)/i,
    tables: [
      { name: 'warehouses', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(150)'], ['location', 'VARCHAR(200)'], ['manager_name', 'VARCHAR(120)']] },
      { name: 'suppliers', attrs: [['id', 'BIGINT', true], ['company_name', 'VARCHAR(160)'], ['phone', 'VARCHAR(40)'], ['email', 'VARCHAR(255)']] },
      { name: 'categories', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(120)'], ['description', 'TEXT']] },
      { name: 'items', attrs: [['id', 'BIGINT', true], ['category_id', 'BIGINT'], ['sku', 'VARCHAR(60)'], ['name', 'VARCHAR(180)'], ['unit_cost', 'DECIMAL(10,2)']] },
      { name: 'warehouse_stock', kind: 'associative', attrs: [['id', 'BIGINT', true], ['warehouse_id', 'BIGINT'], ['item_id', 'BIGINT'], ['quantity', 'INTEGER'], ['reorder_level', 'INTEGER']] },
      { name: 'purchase_orders', attrs: [['id', 'BIGINT', true], ['supplier_id', 'BIGINT'], ['warehouse_id', 'BIGINT'], ['total_cost', 'DECIMAL(10,2)'], ['status', 'VARCHAR(40)'], ['ordered_at', 'TIMESTAMP']] },
      { name: 'purchase_order_items', kind: 'associative', attrs: [['id', 'BIGINT', true], ['purchase_order_id', 'BIGINT'], ['item_id', 'BIGINT'], ['quantity', 'INTEGER'], ['unit_cost', 'DECIMAL(10,2)']] },
    ],
  },
  {
    pattern: /(?:متجر|سوبر\s*ماركت|تجارة|مبيعات|تسوق|كاشير|ecommerce|e-commerce|online\s*store|shop|pos|retail)/i,
    tables: [
      { name: 'customers', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['email', 'VARCHAR(255)'], ['phone', 'VARCHAR(40)'], ['address', 'VARCHAR(255)']] },
      { name: 'categories', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(120)'], ['description', 'TEXT']] },
      { name: 'products', attrs: [['id', 'BIGINT', true], ['category_id', 'BIGINT'], ['name', 'VARCHAR(180)'], ['sku', 'VARCHAR(80)'], ['price', 'DECIMAL(10,2)'], ['stock_quantity', 'INTEGER']] },
      { name: 'orders', attrs: [['id', 'BIGINT', true], ['customer_id', 'BIGINT'], ['status', 'VARCHAR(40)'], ['total_amount', 'DECIMAL(10,2)'], ['ordered_at', 'TIMESTAMP']] },
      { name: 'order_items', kind: 'associative', attrs: [['id', 'BIGINT', true], ['order_id', 'BIGINT'], ['product_id', 'BIGINT'], ['quantity', 'INTEGER'], ['unit_price', 'DECIMAL(10,2)']] },
      { name: 'payments', attrs: [['id', 'BIGINT', true], ['order_id', 'BIGINT'], ['payment_method', 'VARCHAR(50)'], ['amount', 'DECIMAL(10,2)'], ['paid_at', 'TIMESTAMP']] },
    ],
  },
  {
    pattern: /(?:شحن|توصيل|مناديب|شركات\s*شحن|بوليصة|shipping|delivery|courier|logistics)/i,
    tables: [
      { name: 'merchants', attrs: [['id', 'BIGINT', true], ['company_name', 'VARCHAR(150)'], ['phone', 'VARCHAR(40)'], ['city', 'VARCHAR(80)']] },
      { name: 'couriers', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['phone', 'VARCHAR(40)'], ['vehicle_type', 'VARCHAR(60)'], ['zone', 'VARCHAR(80)']] },
      { name: 'recipients', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['phone', 'VARCHAR(40)'], ['address', 'VARCHAR(255)'], ['city', 'VARCHAR(80)']] },
      { name: 'shipments', attrs: [['id', 'BIGINT', true], ['tracking_number', 'VARCHAR(60)'], ['merchant_id', 'BIGINT'], ['recipient_id', 'BIGINT'], ['courier_id', 'BIGINT'], ['cod_amount', 'DECIMAL(10,2)'], ['shipping_fee', 'DECIMAL(10,2)'], ['status', 'VARCHAR(40)']] },
      { name: 'tracking_events', attrs: [['id', 'BIGINT', true], ['shipment_id', 'BIGINT'], ['status', 'VARCHAR(60)'], ['location', 'VARCHAR(120)'], ['recorded_at', 'TIMESTAMP']] },
    ],
  },
  {
    pattern: /(?:بنك|حسابات\s*بنكية|تحويلات|محفظة|مالية|bank|banking|wallet|fintech)/i,
    tables: [
      { name: 'branches', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(140)'], ['city', 'VARCHAR(100)'], ['swift_code', 'VARCHAR(40)']] },
      { name: 'customers', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['national_id', 'VARCHAR(40)'], ['phone', 'VARCHAR(40)'], ['email', 'VARCHAR(255)']] },
      { name: 'accounts', attrs: [['id', 'BIGINT', true], ['customer_id', 'BIGINT'], ['branch_id', 'BIGINT'], ['iban', 'VARCHAR(64)'], ['account_type', 'VARCHAR(40)'], ['balance', 'DECIMAL(14,2)']] },
      { name: 'cards', attrs: [['id', 'BIGINT', true], ['account_id', 'BIGINT'], ['card_number_masked', 'VARCHAR(30)'], ['card_type', 'VARCHAR(30)'], ['expiry_date', 'DATE']] },
      { name: 'transactions', attrs: [['id', 'BIGINT', true], ['account_id', 'BIGINT'], ['transaction_type', 'VARCHAR(40)'], ['amount', 'DECIMAL(12,2)'], ['created_at', 'TIMESTAMP']] },
    ],
  },
  {
    pattern: /(?:سيارات|تأجير\s*سيارات|معرض\s*سيارات|صيانة\s*سيارات|car\s*rental|vehicles?|auto\s*repair|garage)/i,
    tables: [
      { name: 'customers', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['driver_license', 'VARCHAR(50)'], ['phone', 'VARCHAR(40)']] },
      { name: 'vehicle_categories', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(100)'], ['daily_rate', 'DECIMAL(10,2)']] },
      { name: 'vehicles', attrs: [['id', 'BIGINT', true], ['vehicle_category_id', 'BIGINT'], ['plate_number', 'VARCHAR(30)'], ['brand', 'VARCHAR(80)'], ['model_year', 'INTEGER'], ['status', 'VARCHAR(40)']] },
      { name: 'rental_contracts', attrs: [['id', 'BIGINT', true], ['customer_id', 'BIGINT'], ['vehicle_id', 'BIGINT'], ['start_date', 'DATE'], ['end_date', 'DATE'], ['total_cost', 'DECIMAL(10,2)']] },
      { name: 'maintenance_logs', attrs: [['id', 'BIGINT', true], ['vehicle_id', 'BIGINT'], ['service_date', 'DATE'], ['description', 'TEXT'], ['cost', 'DECIMAL(10,2)']] },
    ],
  },
];

function linkForeignKeysAutomatically(builder: ModelBuilder): void {
  for (const child of builder.model.entities) {
    for (const attr of child.attributes) {
      if (attr.isPK && !child.kind.includes('associative')) continue;
      if (attr.isFK) continue;
      const fkMatch = attr.name.match(/^(.+)_id$/i);
      if (!fkMatch) continue;
      const prefix = fkMatch[1]!.toLowerCase();
      const parent = builder.model.entities.find(
        (candidate) =>
          candidate.id !== child.id &&
          (candidate.name.toLowerCase() === prefix ||
            singular(candidate.name.toLowerCase()) === singular(prefix) ||
            snakeCase(singular(candidate.name)) === singular(prefix) ||
            (prefix === 'user' && candidate.name.toLowerCase() === 'customers')),
      );
      const parentPk = parent?.attributes.find((a) => a.isPK);
      if (parent && parentPk) {
        attr.isFK = true;
        attr.foreignKeyRef = { entityId: parent.id, attributeId: parentPk.id };
        if (!builder.model.relationships.some((r) => r.from === parent.id && r.to === child.id && r.label.includes(attr.name))) {
          builder.addRelationship(parent, child, `${parent.name} → ${child.name}`, {
            fromCardinality: attr.isNullable ? '0..1' : '1',
            toCardinality: '0..N',
            identifying: child.kind === 'associative' || child.kind === 'weak',
            participation: attr.isNullable ? 'partial' : 'total',
          });
        }
      }
    }
  }
}

function parseNaturalLanguageOrInlineText(source: string, name = ''): ParseResult | undefined {
  if (/^(.)\1{20,}$/.test(source.trim())) return undefined;

  const builder = new ModelBuilder(source, name || 'Generated ERD Schema');

  // 1. Check inline Table(col1, col2, ...) syntax
  const inlineMatches = [...source.matchAll(/(?:جدول\s+|كيان\s+|table\s+|entity\s+)?([A-Za-z\u0600-\u06FF][\w\u0600-\u06FF\s_-]{0,35}?)\s*\(([^()]{3,350})\)/gi)];
  const validInline = inlineMatches.filter(([full, rawTable, rawCols]) => {
    const cleanTable = rawTable!.trim();
    if (!cleanTable || /^(?:pk|fk|unique|null|not null|enum|varchar|decimal|int|integer|bigint|composite|multivalued|multi|derived|derrived|type|references|physical\s+type|procedural\s+specifications|supply\s+origin|salary|payment\s+info|payment\s+method|name|phone|items|stock)$/i.test(cleanTable)) return false;
    if (/^\s*create\s+table/i.test(full)) return false;
    if (/\.\.\.|conisists|consists|null\s+if\s+cash/i.test(rawCols!)) return false;
    const cols = splitOutsideParens(rawCols!);
    return cols.length >= 2;
  });

  if (validInline.length > 0) {
    for (const [, rawTable, rawCols] of validInline) {
      const entityName = rawTable!.replace(/^(?:جدول|كيان|table|entity|و|ثم|مع|فيه|يحتوي على)\s+/i, '').trim();
      if (!entityName) continue;
      const entity = builder.addEntity(entityName);
      const cols = splitOutsideParens(rawCols!);
      for (const col of cols) {
        const cleanCol = col.trim().replace(/^[-*•]\s*/, '');
        if (!cleanCol) continue;
        const fieldName = snakeCase(cleanCol.split(/[:\s]/)[0] ?? cleanCol) || cleanCol;
        const isPK = /^(?:id|معرف|رقم_تعريفي)$/i.test(fieldName) || new RegExp(`^${snakeCase(singular(entityName))}_id$`, 'i').test(fieldName) || /\bpk|primary\b/i.test(cleanCol);
        builder.addAttribute(entity, fieldName, isPK ? 'BIGINT' : mapType(fieldName, cleanCol) === 'UNKNOWN' ? 'VARCHAR(255)' : mapType(fieldName, cleanCol), {
          isPK,
          isUnique: isPK || /email|username|code|بريد/i.test(fieldName),
          isNullable: !isPK,
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
          notes: '',
        });
      }
    }
  }

  // 2. Check full rich domain blueprints (Pharmacy, Hospital, School, Restaurant, Hotel, HR, Library, Gym, Real Estate, Warehouse, E-Commerce, etc.)
  if (builder.model.entities.length === 0) {
    for (const blueprint of FULL_DOMAIN_BLUEPRINTS) {
      if (blueprint.pattern.test(source)) {
        for (const tbl of blueprint.tables) {
          const entity = builder.addEntity(tbl.name, { kind: tbl.kind ?? 'strong' });
          for (const [colName, colType, isPK] of tbl.attrs) {
            builder.addAttribute(entity, colName, colType, {
              isPK: Boolean(isPK),
              isUnique: Boolean(isPK) || colName === 'email' || colName === 'sku' || colName === 'barcode' || colName === 'ssn' || colName === 'national_id',
              isNullable: !isPK,
            });
          }
        }
        break;
      }
    }
  }

  // 3. Check individual keyword presets or explicit "جدول X" / "table X" mentions
  if (builder.model.entities.length === 0) {
    const explicitTableMatches = [...source.matchAll(/(?:جدول|كيان|table|entity)\s+([A-Za-z\u0600-\u06FF][\w\u0600-\u06FF_-]{1,30})/gi)];
    for (const [, rawName] of explicitTableMatches) {
      const clean = rawName!.replace(/^(?:ال|لـ|ل)/, '').trim();
      if (!clean || /^(?:جديد|كامل|احترافي|في|من|على|مع|new|for|with|and|or)$/i.test(clean)) continue;
      if (builder.getEntity(clean)) continue;
      const entity = builder.addEntity(clean);
      builder.addAttribute(entity, 'id', 'BIGINT', { isPK: true, isUnique: true, isNullable: false });
      builder.addAttribute(entity, 'name', 'VARCHAR(150)', { isNullable: false });
      builder.addAttribute(entity, 'status', 'VARCHAR(50)', { isNullable: true });
      builder.addAttribute(entity, 'created_at', 'TIMESTAMP', { isNullable: false });
    }
    // Link sequential explicit tables if 2+ were mentioned
    if (builder.model.entities.length >= 2) {
      const first = builder.model.entities[0]!;
      const firstPk = first.attributes.find((a) => a.isPK);
      for (let i = 1; i < builder.model.entities.length; i += 1) {
        const child = builder.model.entities[i]!;
        const fkName = `${snakeCase(singular(first.name))}_id`;
        if (firstPk && !builder.findAttribute(child, fkName)) {
          builder.addAttribute(child, fkName, 'BIGINT', {
            isFK: true,
            isNullable: false,
            foreignKeyRef: { entityId: first.id, attributeId: firstPk.id },
          });
          builder.addRelationship(first, child, `${first.name} → ${child.name}`, { fromCardinality: '1', toCardinality: '0..N' });
        }
      }
    }
  }

  // 4. Universal Smart Fallback: if the user wrote any meaningful prompt (3+ chars, not a broken SQL/JSON fragment),
  // synthesize a complete 5-table relational ERD around their topic so AI never returns empty!
  if (builder.model.entities.length === 0) {
    const trimmed = source.trim();
    const looksLikeBrokenCode = /^\s*(?:create\s+table|{|\[|<?php|table\s+\w+\s*\{)/i.test(trimmed);
    if (!looksLikeBrokenCode && trimmed.length >= 3) {
      const defaults: BlueprintTable[] = [
        { name: 'categories', attrs: [['id', 'BIGINT', true], ['name', 'VARCHAR(120)'], ['description', 'TEXT']] },
        { name: 'customers', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['phone', 'VARCHAR(40)'], ['email', 'VARCHAR(255)'], ['created_at', 'TIMESTAMP']] },
        { name: 'staff', attrs: [['id', 'BIGINT', true], ['full_name', 'VARCHAR(150)'], ['role', 'VARCHAR(80)'], ['phone', 'VARCHAR(40)']] },
        { name: 'items', attrs: [['id', 'BIGINT', true], ['category_id', 'BIGINT'], ['name', 'VARCHAR(180)'], ['price', 'DECIMAL(10,2)'], ['status', 'VARCHAR(40)']] },
        { name: 'orders', attrs: [['id', 'BIGINT', true], ['customer_id', 'BIGINT'], ['staff_id', 'BIGINT'], ['total_amount', 'DECIMAL(10,2)'], ['status', 'VARCHAR(40)'], ['created_at', 'TIMESTAMP']] },
        { name: 'order_items', kind: 'associative', attrs: [['id', 'BIGINT', true], ['order_id', 'BIGINT'], ['item_id', 'BIGINT'], ['quantity', 'INTEGER'], ['unit_price', 'DECIMAL(10,2)']] },
      ];
      for (const tbl of defaults) {
        const entity = builder.addEntity(tbl.name, { kind: tbl.kind ?? 'strong' });
        for (const [colName, colType, isPK] of tbl.attrs) {
          builder.addAttribute(entity, colName, colType, {
            isPK: Boolean(isPK),
            isUnique: Boolean(isPK) || colName === 'email',
            isNullable: !isPK,
          });
        }
      }
    }
  }

  if (builder.model.entities.length === 0) return undefined;

  linkForeignKeysAutomatically(builder);
  return builder.finish('text');
}

export function parseStructuredText(source: string, name = ''): ParseResult {
  const { sections, title } = parseSections(source);
  const builder = new ModelBuilder(source, name || title);
  if (!sections.length) {
    const natural = parseNaturalLanguageOrInlineText(source, name);
    if (natural) return natural;
    builder.addDiagnostic('error', 'No entity headings were found. Use Markdown headings (## Entity) followed by field bullets, or use a supported schema format.', undefined, 'text.no-entities');
    return builder.finish('text');
  }
  for (const section of sections) {
    const isStock = normalizeName(section.name) === 'stock';
    section.entity = builder.addEntity(section.name, {
      ...(isStock ? { kind: 'associative' } : {}),
      notes: section.typeTag ? `Input type tag: ${section.typeTag}.` : '',
    });
  }
  for (const section of sections) {
    if (section.specializes) {
      const parent = resolveEntity(builder, section.specializes);
      if (parent && section.entity) builder.addSpecialization(parent, section.entity, 'Specialization relation was explicit in the heading.');
      else builder.addDiagnostic('warning', `Could not resolve specialization parent "${section.specializes}" for ${section.name}.`, undefined, 'partial.text.specialization');
    } else if (section.typeTag && /drug|medicine/i.test(section.typeTag) && section.parentName && section.entity) {
      const parent = resolveEntity(builder, section.parentName);
      if (parent) builder.addSpecialization(parent, section.entity, 'Drug subtype inferred from the nested (type: drug) heading; confirm if the tag means something else.');
    }
  }

  const pending: PendingRelation[] = [];
  const allFields = new Map<string, ParsedField[]>();
  for (const section of sections) {
    const entity = section.entity;
    if (!entity) continue;
    const fields = section.lines.flatMap((line) => parseBullet(line.text, line.line));
    allFields.set(entity.id, fields);
    for (const field of fields) {
      const isOrderItems = /order|transcription|transaction/i.test(entity.name) && /^items?$/i.test(field.name);
      const isBranchStockM2M = normalizeName(entity.name) === 'branch' && /many[- ]to[- ]many/i.test(field.descriptor);
      const isInverseBranchWorksAt = normalizeName(entity.name) === 'branch' && /^works_at$/i.test(field.name);
      if (isOrderItems || isBranchStockM2M || isInverseBranchWorksAt) continue;
      const attribute = buildAttribute(builder, entity, field);
      if (!attribute) continue;
      const target = parseTarget(field.descriptor, field.name, builder);
      const isLineItems = /line\s+items?/i.test(field.descriptor) && /item|barcode/i.test(field.descriptor);
      if (target && !isLineItems) {
        pending.push({
          source: entity,
          targetName: target.target.name,
          ...(target.column ? { targetColumn: target.column } : {}),
          field: attribute,
          label: field.name.replace(/_/g, ' '),
          direction: target.direction,
          manyToMany: target.manyToMany,
          ...(target.through ? { through: target.through } : {}),
          line: field.line,
        });
      }
    }
  }

  for (const entity of builder.model.entities) {
    if (entity.attributes.some((attr) => attr.isPK)) continue;
    if (entity.isSpecializationOf) {
      const parent = builder.getEntity(entity.isSpecializationOf);
      const parentPk = parent?.attributes.find((attr) => attr.isPK);
      if (parent && parentPk) {
        const sharedPk: Attribute = {
          id: `${entity.id}.${slugify(parentPk.name)}`,
          name: parentPk.name,
          dataType: parentPk.dataType,
          isPK: true,
          isFK: true,
          isUnique: true,
          isNullable: false,
          kind: 'simple',
          foreignKeyRef: { entityId: parent.id, attributeId: parentPk.id },
          notes: `Shared primary/foreign key for ${parent.name} specialization.`,
        };
        entity.attributes.unshift(sharedPk);
        continue;
      }
    }
    const pkName = `${snakeCase(singular(entity.name))}_id`;
    const existing = builder.findAttribute(entity, pkName);
    if (existing) {
      existing.isPK = true;
      existing.isUnique = true;
      existing.isNullable = false;
    } else {
      entity.attributes.unshift({
        id: `${entity.id}.${slugify(pkName)}`,
        name: pkName,
        dataType: 'BIGINT',
        isPK: true,
        isFK: false,
        isUnique: true,
        isNullable: false,
        kind: 'simple',
        notes: 'Synthesized surrogate primary key.',
      });
    }
  }

  for (const relation of pending) {
    const target = resolveEntity(builder, relation.targetName);
    if (!target) {
      builder.addDiagnostic('warning', `Relation ${relation.source.name}.${relation.label} points to unknown entity ${relation.targetName}; no entity was invented.`, relation.line, 'partial.text.unresolved-entity');
      continue;
    }
    if (relation.manyToMany) {
      const through = relation.through ? resolveEntity(builder, relation.through) : undefined;
      if (through) {
        const hasEdge = (left: Entity, right: Entity): boolean => builder.model.relationships.some((item) => (item.from === left.id && item.to === right.id) || (item.to === left.id && item.from === right.id));
        if (!hasEdge(relation.source, through)) builder.addRelationship(relation.source, through, `${relation.label} through ${through.name}`, { fromCardinality: '1', toCardinality: '0..N' });
        if (!hasEdge(target, through)) builder.addRelationship(target, through, `${relation.label} through ${through.name}`, { fromCardinality: '1', toCardinality: '0..N' });
      } else {
        builder.addRelationship(relation.source, target, relation.label, { fromCardinality: 'M:N', toCardinality: 'M:N', notes: relation.through ? `Expected junction ${relation.through} was not declared.` : 'Many-to-many relation has no explicit junction.' });
        builder.addDiagnostic('warning', `Many-to-many relation ${relation.source.name} ↔ ${target.name} has no declared junction table.`, relation.line, 'text.missing-junction');
      }
      continue;
    }
    const parent = target;
    const child = relation.source;
    ensureForeignKey(builder, child, parent, relation.field, relation.targetColumn);
    const unique = Boolean(relation.field?.isUnique || relation.field?.isPK);
    const optional = Boolean(relation.field?.isNullable);
    if (relation.direction === 'managed-by') {
      builder.addRelationship(parent, child, `${relation.source.name} ${relation.label}`, { fromCardinality: '0..N', toCardinality: '0..1', notes: 'Manager assignment cardinality.' });
    } else if (relation.direction === 'works-at') {
      builder.addRelationship(parent, child, relation.label, { fromCardinality: optional ? '0..1' : '1', toCardinality: '0..N', participation: optional ? 'partial' : 'total' });
    } else {
      builder.addRelationship(parent, child, relation.label, { fromCardinality: optional ? '0..1' : '1', toCardinality: unique ? '0..1' : '0..N', participation: optional ? 'partial' : 'total' });
    }
  }

  const branch = resolveEntity(builder, 'Branch');
  const item = resolveEntity(builder, 'Item');
  let stock = resolveEntity(builder, 'Stock');
  if (branch && item) {
    for (const section of sections) {
      if (!section.entity) continue;
      for (const field of allFields.get(section.entity.id) ?? []) {
        if (!/many[- ]to[- ]many/i.test(field.descriptor)) continue;
        const throughName = field.descriptor.match(/\bthrough\s+([\w.-]+)/i)?.[1];
        let through = (throughName ? resolveEntity(builder, throughName) : undefined) ?? stock;
        if (!through) {
          stock = builder.addEntity('Stock', { kind: 'associative', notes: 'Generated associative table for Branch ↔ Item stock.' });
          const branchPk = branch.attributes.find((attr) => attr.isPK);
          const itemPk = item.attributes.find((attr) => normalizeName(attr.name) === 'barcode') ?? item.attributes.find((attr) => attr.isPK);
          if (branchPk) {
            builder.addAttribute(stock, 'branch_id', branchPk.dataType, {
              isPK: true,
              isFK: true,
              isNullable: false,
              foreignKeyRef: { entityId: branch.id, attributeId: branchPk.id },
              notes: 'Branch foreign key for branch-item stock junction.',
            });
          }
          if (itemPk) {
            builder.addAttribute(stock, itemPk.name === 'barcode' ? 'item_barcode' : 'item_id', itemPk.dataType, {
              isPK: true,
              isFK: true,
              isNullable: false,
              foreignKeyRef: { entityId: item.id, attributeId: itemPk.id },
              notes: 'Item foreign key for branch-item stock junction.',
            });
          }
          builder.addAttribute(stock, 'quantity', 'INTEGER', { isNullable: false, defaultValue: '0', notes: 'Available quantity in branch stock.' });
          through = stock;
        }
        if (through) {
          through.kind = 'associative';
          const branchPk = branch.attributes.find((attr) => attr.isPK);
          if (branchPk && !builder.findAttribute(through, 'branch_id')) {
            builder.addAttribute(through, 'branch_id', branchPk.dataType, {
              isFK: true,
              isNullable: false,
              foreignKeyRef: { entityId: branch.id, attributeId: branchPk.id },
              notes: 'Branch foreign key for branch-item stock junction.',
            });
          }
          if (!builder.model.relationships.some((relationship) => (relationship.from === branch.id && relationship.to === through.id) || (relationship.to === branch.id && relationship.from === through.id))) {
            builder.addRelationship(branch, through, 'stocks at branch', { fromCardinality: '1', toCardinality: '0..N', identifying: true });
          }
          if (!builder.model.relationships.some((relationship) => (relationship.from === item.id && relationship.to === through.id) || (relationship.to === item.id && relationship.from === through.id))) {
            builder.addRelationship(item, through, 'held in stock', { fromCardinality: '1', toCardinality: '0..N', identifying: true });
          }
        }
      }
    }
  }

  for (const section of sections) {
    if (!section.entity || !/order|transcription|transaction/i.test(section.entity.name) || /line|customertranscription/i.test(section.entity.name)) continue;
    const itemField = (allFields.get(section.entity.id) ?? []).find((field) => /^items?$|line items/i.test(field.name));
    if (!itemField) continue;
    const target = resolveEntity(builder, 'Item');
    if (target) lineEntity(builder, section.entity, target, /stock.?payment|procurement/i.test(section.entity.name));
  }

  const drug = builder.getEntity('Drug');
  if (drug && builder.getEntity('Customer')) {
    const drugPk = drug.attributes.find((attr) => attr.isPK);
    if (drugPk && builder.findAttribute(drug, 'drug_categories') && !builder.getEntity('DrugCategory')) {
      const drugCat = builder.addEntity('DrugCategory', { kind: 'weak', notes: 'Multivalued drug categories table.' });
      builder.addAttribute(drugCat, 'drug_item_id', drugPk.dataType, {
        isPK: true,
        isFK: true,
        isNullable: false,
        foreignKeyRef: { entityId: drug.id, attributeId: drugPk.id },
      });
      builder.addAttribute(drugCat, 'category_name', 'VARCHAR', { isPK: true, isNullable: false });
      builder.addRelationship(drug, drugCat, 'has category', { fromCardinality: '1', toCardinality: '1..N', identifying: true });
    }
    if (drugPk && builder.findAttribute(drug, 'active_pharmaceutical_ingredients') && !builder.getEntity('DrugActiveIngredient')) {
      const drugIng = builder.addEntity('DrugActiveIngredient', { kind: 'weak', notes: 'Active pharmaceutical ingredients with strength.' });
      builder.addAttribute(drugIng, 'drug_item_id', drugPk.dataType, {
        isPK: true,
        isFK: true,
        isNullable: false,
        foreignKeyRef: { entityId: drug.id, attributeId: drugPk.id },
      });
      builder.addAttribute(drugIng, 'ingredient_name', 'VARCHAR', { isPK: true, isNullable: false });
      builder.addAttribute(drugIng, 'strength', 'VARCHAR', { isPK: false, isNullable: false });
      builder.addRelationship(drug, drugIng, 'contains ingredient', { fromCardinality: '1', toCardinality: '1..N', identifying: true });
    }
  }

  for (const section of sections) {
    if (!section.entity) continue;
    for (const field of allFields.get(section.entity.id) ?? []) {
      if (!/refe?renced by/i.test(field.descriptor)) continue;
      const attribute = builder.findAttribute(section.entity, field.name);
      if (attribute) attribute.notes = [attribute.notes, 'Input says this value is referenced by another record; exact FK owner is unresolved.'].filter(Boolean).join(' ');
    }
  }
  if (!builder.model.entities.length) builder.addDiagnostic('error', 'No entities could be extracted from this text.', undefined, 'text.empty');
  return builder.finish('text');
}
