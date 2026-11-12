import type { Attribute, Entity, Relationship } from '../model/types';
import { ModelBuilder, normalizeName } from './common';
import type { ParseResult } from './types';

interface EntityBlock {
  name: string;
  body: string;
}

interface RelationshipLine {
  fromName: string;
  fromMarker: string;
  toMarker: string;
  toName: string;
  label: string;
}

function readEntityBlocks(source: string): EntityBlock[] {
  const result: EntityBlock[] = [];
  const openPattern = /^\s*([A-Za-z_][\w.-]*)\s*\{\s*$/gm;
  for (const match of source.matchAll(openPattern)) {
    const open = match.index + match[0].lastIndexOf('{');
    let depth = 0;
    let close = -1;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}' && --depth === 0) { close = index; break; }
    }
    if (close >= 0) result.push({ name: match[1]!, body: source.slice(open + 1, close) });
  }
  return result;
}

function cardinality(marker: string): Relationship['fromCardinality'] {
  if (/[{}]/.test(marker)) return marker.includes('o') ? '0..N' : '1..N';
  if (marker.includes('o')) return '0..1';
  return '1';
}

function relationshipLines(source: string): RelationshipLine[] {
  const result: RelationshipLine[] = [];
  const marker = String.raw`(?:\|\||\|o|o\||\|\{|\|\}|o\{|\}o|\}\|)`;
  const expression = new RegExp(`^\\s*([A-Za-z_][\\w.-]*)\\s+(${marker})\\s*(?:--|\\.\\.)\\s*(${marker})\\s*([A-Za-z_][\\w.-]*)(?:\\s*:\\s*(.+?))?\\s*$`, 'gm');
  for (const match of source.matchAll(expression)) {
    result.push({ fromName: match[1]!, fromMarker: match[2]!, toMarker: match[3]!, toName: match[4]!, label: (match[5] ?? 'related to').trim().replace(/^['"]|['"]$/g, '') });
  }
  return result;
}

function attributeConstraint(line: string): { type: string; name: string; flags: Set<string>; note: string } | undefined {
  const match = line.match(/^\s*(.+?)\s+([A-Za-z_][\w.-]*)(?:\s+((?:(?:PK|FK|UK|DERIVED|MULTIVALUED|COMPOSITE)(?:\s*,\s*)?)+))?(?:\s+"([^"]+)")?\s*$/i);
  if (!match) return undefined;
  const flags = new Set((match[3] ?? '').split(/\s*,\s*/).map((item) => item.toUpperCase()).filter(Boolean));
  return { type: match[1]!.trim(), name: match[2]!, flags, note: match[4] ?? '' };
}

export function parseMermaid(source: string, name = ''): ParseResult {
  const builder = new ModelBuilder(source, name);
  if (!/^\s*erDiagram\b/m.test(source)) builder.addDiagnostic('warning', 'Only Mermaid erDiagram input is supported by this parser.', undefined, 'partial.mermaid.diagram-type');
  const fkCandidates = new Map<string, Set<string>>();
  const entities = new Map<string, Entity>();
  for (const block of readEntityBlocks(source)) {
    const entity = builder.addEntity(block.name);
    entities.set(normalizeName(block.name), entity);
    for (const rawLine of block.body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('%%') || line.startsWith('//')) continue;
      const parsed = attributeConstraint(line);
      if (!parsed) {
        builder.addDiagnostic('warning', `Could not parse Mermaid attribute in ${block.name}: ${line.slice(0, 80)}`, undefined, 'partial.mermaid.attribute');
        continue;
      }
      const kind: Attribute['kind'] = parsed.flags.has('DERIVED') ? 'derived' : parsed.flags.has('MULTIVALUED') ? 'multivalued' : parsed.flags.has('COMPOSITE') ? 'composite' : 'simple';
      const attribute = builder.addAttribute(entity, parsed.name, parsed.type, {
        isPK: parsed.flags.has('PK'),
        isUnique: parsed.flags.has('UK') || parsed.flags.has('PK'),
        isNullable: !parsed.flags.has('PK'),
        kind,
        ...(kind === 'derived' ? { derivationFormula: parsed.note || 'Derived; formula not declared.' } : {}),
        notes: parsed.note,
      });
      if (attribute && parsed.flags.has('FK')) {
        const candidates = fkCandidates.get(entity.id) ?? new Set<string>();
        candidates.add(attribute.id);
        fkCandidates.set(entity.id, candidates);
        attribute.notes = attribute.notes ? `${attribute.notes} Mermaid marks this as FK; target will be resolved from relationship lines.` : 'Mermaid marks this as FK; target will be resolved from relationship lines.';
      }
    }
  }

  const relations = relationshipLines(source);
  for (const relation of relations) {
    let from = entities.get(normalizeName(relation.fromName));
    let to = entities.get(normalizeName(relation.toName));
    if (!from) {
      from = builder.addEntity(relation.fromName, { notes: 'Entity mentioned by a Mermaid relationship but missing an attribute block.' });
      entities.set(normalizeName(relation.fromName), from);
      builder.addDiagnostic('warning', `Mermaid relationship mentions ${relation.fromName} without an attribute block.`, undefined, 'partial.mermaid.entity');
    }
    if (!to) {
      to = builder.addEntity(relation.toName, { notes: 'Entity mentioned by a Mermaid relationship but missing an attribute block.' });
      entities.set(normalizeName(relation.toName), to);
      builder.addDiagnostic('warning', `Mermaid relationship mentions ${relation.toName} without an attribute block.`, undefined, 'partial.mermaid.entity');
    }
    const fromMany = /[{}]/.test(relation.fromMarker);
    const toMany = /[{}]/.test(relation.toMarker);
    const fromCardinality = fromMany && toMany ? 'M:N' : cardinality(relation.fromMarker);
    const toCardinality = fromMany && toMany ? 'M:N' : cardinality(relation.toMarker);
    builder.addRelationship(from, to, relation.label, { fromCardinality, toCardinality });
    if (fromCardinality === 'M:N' || toCardinality === 'M:N') builder.addDiagnostic('warning', `Mermaid relationship ${from.name} ↔ ${to.name} is many-to-many and no explicit junction entity was supplied.`, undefined, 'mermaid.missing-junction');

    if (fromCardinality === 'M:N' || toCardinality === 'M:N') continue;
    const fromIsMany = fromCardinality === '0..N' || fromCardinality === '1..N';
    const toIsMany = toCardinality === '0..N' || toCardinality === '1..N';
    const child = toIsMany && !fromIsMany ? to : fromIsMany && !toIsMany ? from : to;
    const parent = child.id === from.id ? to : from;
    const targetKey = parent.attributes.find((attribute) => attribute.isPK);
    const childCandidates = [...(fkCandidates.get(child.id) ?? [])].map((id) => builder.findAttribute(child, id)).filter((item): item is Attribute => Boolean(item));
    const hinted = childCandidates.find((attribute) => normalizeName(attribute.name) === `${normalizeName(parent.name)}_id` || normalizeName(attribute.name) === `${normalizeName(parent.name).replace(/s$/, '')}_id`);
    const local = hinted ?? (childCandidates.length === 1 ? childCandidates[0] : undefined);
    if (local && targetKey) {
      local.isFK = true;
      local.foreignKeyRef = { entityId: parent.id, attributeId: targetKey.id };
      local.notes = `Mermaid FK target inferred from relationship ${relation.label}.`;
    }
  }

  for (const [entityId, candidates] of fkCandidates) {
    const entity = builder.getEntity(entityId);
    for (const candidateId of candidates) {
      const attribute = entity ? builder.findAttribute(entity, candidateId) : undefined;
      if (attribute && !attribute.isFK) builder.addDiagnostic('warning', `Mermaid marks ${entity?.name}.${attribute.name} as FK but no matching relationship/target key was found.`, undefined, 'partial.mermaid.unresolved-fk');
    }
  }
  if (!builder.model.entities.length) builder.addDiagnostic('error', 'No Mermaid erDiagram entities or relationship declarations were found.', undefined, 'partial.mermaid.empty');
  return builder.finish('mermaid');
}
