import type { Attribute, Entity, SchemaModel } from '../model/types';
import { buildPhysicalSchema } from './physicalModel';

export type DictionaryLocale = 'en' | 'ar';

const LABELS = {
  en: { title: 'ERDForge Data Dictionary', generated: 'Generated', entity: 'Entity', type: 'Kind', attributes: 'Attributes', name: 'Name', dataType: 'Data type', constraints: 'Constraints', notes: 'Notes', relation: 'Relationships', primary: 'Primary key', foreign: 'Foreign key', unique: 'Unique', nullable: 'Nullable', indexed: 'Indexed', stored: 'Stored derived', derived: 'Derived', multivalued: 'Multivalued', composite: 'Composite', yes: 'Yes', no: 'No', strong: 'Strong', weak: 'Weak', associative: 'Associative', formula: 'Formula', specialization: 'Specializes', subjectArea: 'Subject area' },
  ar: { title: 'قاموس بيانات ERDForge', generated: 'تاريخ الإنشاء', entity: 'الكيان', type: 'النوع', attributes: 'السمات', name: 'الاسم', dataType: 'نوع البيانات', constraints: 'القيود', notes: 'ملاحظات', relation: 'العلاقات', primary: 'مفتاح أساسي', foreign: 'مفتاح خارجي', unique: 'فريد', nullable: 'يقبل قيمة فارغة', indexed: 'مفهرس', stored: 'قيمة مشتقة مخزنة', derived: 'مشتق', multivalued: 'متعدد القيم', composite: 'مركب', yes: 'نعم', no: 'No', strong: 'قوي', weak: 'ضعيف', associative: 'ترابطي', formula: 'الصيغة', specialization: 'متخصص من', subjectArea: 'مجال الموضوع' },
} as const;

function walkAttributes(attributes: Attribute[], prefix = ''): Array<{ attribute: Attribute; name: string }> {
  return attributes.flatMap((attribute) => {
    const name = prefix ? `${prefix}.${attribute.name}` : attribute.name;
    const own = [{ attribute, name }];
    return [...own, ...walkAttributes(attribute.children ?? [], name)];
  });
}

function constraints(attribute: Attribute, labels: typeof LABELS[DictionaryLocale]): string[] {
  const result: string[] = [];
  if (attribute.isPK) result.push(labels.primary);
  if (attribute.isFK) result.push(labels.foreign);
  if (attribute.isUnique) result.push(labels.unique);
  if (attribute.isNullable) result.push(labels.nullable);
  if (attribute.isIndexed) result.push(labels.indexed);
  if (attribute.kind === 'derived') result.push(labels.derived, attribute.isStored ? labels.stored : '');
  if (attribute.kind === 'multivalued') result.push(labels.multivalued);
  if (attribute.kind === 'composite') result.push(labels.composite);
  return result.filter(Boolean);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeMarkdown(value: string): string { return value.replace(/([\\`*_{}\[\]()#+.!|>~-])/g, '\\$1').replace(/\r?\n/g, ' '); }

function kindLabel(entity: Entity, labels: typeof LABELS[DictionaryLocale]): string {
  return entity.kind === 'strong' ? labels.strong : entity.kind === 'weak' ? labels.weak : labels.associative;
}

export function generateDataDictionaryMarkdown(model: SchemaModel, locale: DictionaryLocale = 'en', date = new Date()): string {
  const labels = LABELS[locale];
  const physical = buildPhysicalSchema(model);
  const lines = [`# ${labels.title}`, '', `**${labels.generated}:** ${date.toISOString().slice(0, 10)}`, `**Schema:** ${escapeMarkdown(model.name)}`, ''];
  for (const entity of model.entities) {
    lines.push(`## ${escapeMarkdown(entity.name)}`, '', `- **${labels.type}:** ${kindLabel(entity, labels)}`);
    if (entity.isSpecializationOf) lines.push(`- **${labels.specialization}:** ${escapeMarkdown(model.entities.find((item) => item.id === entity.isSpecializationOf)?.name ?? entity.isSpecializationOf)}`);
    const area = model.subjectAreas.find((item) => item.id === entity.subjectAreaId);
    if (area) lines.push(`- **${labels.subjectArea}:** ${escapeMarkdown(area.name)}`);
    if (entity.notes) lines.push(`- **${labels.notes}:** ${escapeMarkdown(entity.notes)}`);
    lines.push('', `| ${labels.name} | ${labels.dataType} | ${labels.constraints} | ${labels.notes} |`, '|---|---|---|---|');
    for (const { attribute, name } of walkAttributes(entity.attributes)) {
      const flags = constraints(attribute, labels).join(', ');
      const note = [attribute.notes, attribute.kind === 'derived' && attribute.derivationFormula ? `${labels.formula}: ${attribute.derivationFormula}` : ''].filter(Boolean).join('; ');
      lines.push(`| ${escapeMarkdown(name)} | ${escapeMarkdown(attribute.dataType || '—')} | ${escapeMarkdown(flags || '—')} | ${escapeMarkdown(note || '—')} |`);
    }
    const physicalTables = physical.tables.filter((table) => table.id === entity.id || table.id.startsWith(`multivalue:${entity.id}:`));
    if (physicalTables.length > 1) lines.push('', `**Relational tables:** ${physicalTables.map((table) => table.name).join(', ')}`);
    lines.push('');
  }
  if (model.relationships.length) {
    lines.push(`## ${labels.relation}`, '');
    for (const relationship of model.relationships) {
      const from = model.entities.find((entity) => entity.id === relationship.from)?.name ?? relationship.from;
      const to = model.entities.find((entity) => entity.id === relationship.to)?.name ?? relationship.to;
      lines.push(`- **${escapeMarkdown(relationship.label || 'Relationship')}:** ${escapeMarkdown(from)} (${relationship.fromCardinality}) → ${escapeMarkdown(to)} (${relationship.toCardinality}); ${relationship.participation} participation; delete ${relationship.onDelete}; update ${relationship.onUpdate}${relationship.notes ? ` — ${escapeMarkdown(relationship.notes)}` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function entitySectionHtml(model: SchemaModel, entity: Entity, locale: DictionaryLocale, date: string): string {
  const labels = LABELS[locale];
  const physical = buildPhysicalSchema(model);
  const area = model.subjectAreas.find((item) => item.id === entity.subjectAreaId);
  const rows = walkAttributes(entity.attributes).map(({ attribute, name }) => {
    const flags = constraints(attribute, labels).join(', ') || '—';
    const note = [attribute.notes, attribute.kind === 'derived' && attribute.derivationFormula ? `${labels.formula}: ${attribute.derivationFormula}` : ''].filter(Boolean).join('; ') || '—';
    return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(attribute.dataType || '—')}</td><td>${escapeHtml(flags)}</td><td>${escapeHtml(note)}</td></tr>`;
  }).join('');
  const tables = physical.tables.filter((table) => table.id === entity.id || table.id.startsWith(`multivalue:${entity.id}:`)).map((table) => table.name).join(', ');
  return `<section class="dictionary-page" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"><header><small>ERDFORGE</small><h1>${escapeHtml(labels.title)}</h1><p>${escapeHtml(model.name)} · ${escapeHtml(date)}</p></header><h2>${escapeHtml(entity.name)}</h2><p><strong>${escapeHtml(labels.type)}:</strong> ${escapeHtml(kindLabel(entity, labels))}${area ? ` · <strong>${escapeHtml(labels.subjectArea)}:</strong> ${escapeHtml(area.name)}` : ''}</p>${entity.notes ? `<p><strong>${escapeHtml(labels.notes)}:</strong> ${escapeHtml(entity.notes)}</p>` : ''}<h3>${escapeHtml(labels.attributes)}</h3><table><thead><tr><th>${escapeHtml(labels.name)}</th><th>${escapeHtml(labels.dataType)}</th><th>${escapeHtml(labels.constraints)}</th><th>${escapeHtml(labels.notes)}</th></tr></thead><tbody>${rows || `<tr><td colspan="4">—</td></tr>`}</tbody></table>${entity.isSpecializationOf ? `<p><strong>${escapeHtml(labels.specialization)}:</strong> ${escapeHtml(model.entities.find((item) => item.id === entity.isSpecializationOf)?.name ?? entity.isSpecializationOf)}</p>` : ''}<p class="physical"><strong>Relational tables:</strong> ${escapeHtml(tables)}</p></section>`;
}

export function generateDataDictionaryHtml(model: SchemaModel, locale: DictionaryLocale = 'en', date = new Date()): string {
  const labels = LABELS[locale];
  const pages = model.entities.map((entity) => entitySectionHtml(model, entity, locale, date.toISOString().slice(0, 10))).join('');
  return `<!doctype html><html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(labels.title)}</title><style>body{margin:0;padding:26px;background:#f3f5f6;color:#1d2a34;font:14px/1.55 Arial,sans-serif}.dictionary-page{max-width:900px;margin:0 auto 24px;padding:30px;background:#fff;border:1px solid #dce3e7;border-radius:10px;box-shadow:0 8px 22px #10203010}header{border-bottom:2px solid #15877c;padding-bottom:14px;margin-bottom:22px}header small{letter-spacing:.14em;color:#15877c;font-weight:700}h1{font-size:24px;margin:5px 0}h2{font-size:19px}h3{font-size:13px;margin-top:22px}header p,.physical{color:#60717d;font-size:12px}table{border-collapse:collapse;width:100%;font-size:11px}th,td{border:1px solid #dce3e7;padding:8px;text-align:start;vertical-align:top}th{background:#eff5f4;color:#31434d}@media print{body{padding:0;background:#fff}.dictionary-page{box-shadow:none;border:0;border-radius:0;margin:0 auto 0;page-break-after:always}}</style></head><body>${pages}</body></html>`;
}

export async function generateDataDictionaryPdf(model: SchemaModel, locale: DictionaryLocale = 'en', date = new Date()): Promise<Blob> {
  if (typeof document === 'undefined') throw new Error('PDF export requires a browser document.');
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')]);
  const labels = LABELS[locale];
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const dateText = date.toISOString().slice(0, 10);
  const entities = model.entities.length ? model.entities : [{ id: 'empty', name: model.name || labels.title, kind: 'strong' as const, attributes: [], notes: '' }];
  for (const [index, entity] of entities.entries()) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `position:fixed;left:-12000px;top:0;width:920px;z-index:-1;background:#fff;color:#1d2a34;font:16px/1.55 Arial,sans-serif;`;
    wrapper.innerHTML = entitySectionHtml(model, entity, locale, dateText);
    document.body.append(wrapper);
    try {
      await document.fonts?.ready;
      const canvas = await toCanvas(wrapper.firstElementChild as HTMLElement, { pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: false });
      const maxWidth = pageWidth - margin * 2;
      const maxHeight = pageHeight - margin * 2;
      const scale = Math.min(maxWidth / canvas.width, maxHeight / canvas.height);
      const imageWidth = canvas.width * scale;
      const imageHeight = canvas.height * scale;
      if (index > 0) doc.addPage();
      doc.addImage(canvas.toDataURL('image/png'), 'PNG', (pageWidth - imageWidth) / 2, margin, imageWidth, imageHeight, undefined, 'FAST');
      doc.setFontSize(8);
      doc.setTextColor(120, 132, 141);
      doc.text(`${index + 1} / ${entities.length}`, pageWidth - margin, pageHeight - 5, { align: 'right' });
    } finally {
      wrapper.remove();
    }
  }
  return doc.output('blob');
}
