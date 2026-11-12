import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { CanvasLocale } from './EntityNode';
import type { Entity, Relationship } from '../model/types';

const CARDINALITIES = ['1', '0..1', '1..N', '0..N', 'M:N'] as const;
const RULES = ['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL'] as const;

interface RelationshipDialogProps {
  open: boolean;
  entities: Entity[];
  initialFrom?: string;
  initialTo?: string;
  locale: CanvasLocale;
  onClose: () => void;
  onSave: (relationship: Relationship) => void;
}

export default function RelationshipDialog({ open, entities, initialFrom, initialTo, locale, onClose, onSave }: RelationshipDialogProps) {
  const ar = locale === 'ar';
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [label, setLabel] = useState('');
  const [fromCardinality, setFromCardinality] = useState<Relationship['fromCardinality']>('1');
  const [toCardinality, setToCardinality] = useState<Relationship['toCardinality']>('0..N');
  const [participation, setParticipation] = useState<Relationship['participation']>('partial');
  const [identifying, setIdentifying] = useState(false);
  const [onDelete, setOnDelete] = useState<Relationship['onDelete']>('CASCADE');
  const [onUpdate, setOnUpdate] = useState<Relationship['onUpdate']>('CASCADE');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open) return;
    const fromId = entities.some((entity) => entity.id === initialFrom) ? initialFrom! : entities[0]?.id ?? '';
    const toId = entities.some((entity) => entity.id === initialTo && entity.id !== fromId) ? initialTo! : entities.find((entity) => entity.id !== fromId)?.id ?? '';
    setFrom(fromId);
    setTo(toId);
    setLabel('');
    setFromCardinality('1');
    setToCardinality('0..N');
    setParticipation('partial');
    setIdentifying(false);
    setOnDelete('CASCADE');
    setOnUpdate('CASCADE');
    setNotes('');
  }, [open, entities, initialFrom, initialTo]);

  if (!open) return null;
  const canSave = entities.length > 1 && from && to && from !== to;
  const copy = ar ? {
    title: 'ربط جدولين بعلاقة جديدة',
    from: 'الجدول الأول (الرئيسي)',
    to: 'الجدول الثاني (المرتبط)',
    label: 'وصف العلاقة (اختياري)',
    fromCardinality: 'نوع ارتباط الطرف الأول',
    toCardinality: 'نوع ارتباط الطرف الثاني',
    participation: 'طبيعة الربط',
    partial: 'اختياري',
    total: 'إجباري',
    identifying: 'علاقة أساسية متصلة',
    onDelete: 'عند حذف السجل',
    onUpdate: 'عند تعديل السجل',
    notes: 'ملاحظات إضافية',
    cancel: 'إلغاء',
    save: 'حفظ العلاقة',
    required: 'اختر جدولين مختلفين لربطهما.',
    close: 'إغلاق',
  } : {
    title: 'Link Two Tables',
    from: 'Primary Table (From)',
    to: 'Related Table (To)',
    label: 'Relationship label',
    fromCardinality: 'From cardinality',
    toCardinality: 'To cardinality',
    participation: 'Requirement',
    partial: 'Optional',
    total: 'Required',
    identifying: 'Identifying relationship (solid line)',
    onDelete: 'On delete',
    onUpdate: 'On update',
    notes: 'Notes',
    cancel: 'Cancel',
    save: 'Create Link',
    required: 'Choose two different tables.',
    close: 'Close',
  };

  const entityName = (id: string) => entities.find((entity) => entity.id === id)?.name ?? id;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    const relationship: Relationship = {
      id: `relationship-${crypto.randomUUID()}`,
      from,
      to,
      fromCardinality,
      toCardinality,
      identifying,
      participation,
      label: label.trim() || `${entityName(from)} → ${entityName(to)}`,
      attributes: [],
      onDelete,
      onUpdate,
      notes: notes.trim(),
    };
    onSave(relationship);
  };

  return (
    <div className="privacy-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="privacy-dialog relationship-dialog" role="dialog" aria-modal="true" aria-labelledby="relationship-dialog-title" dir={ar ? 'rtl' : 'ltr'}>
        <header className="settings-dialog-header">
          <div>
            <span className="eyebrow">ERDFORGE · ERD</span>
            <h3 id="relationship-dialog-title">{copy.title}</h3>
          </div>
          <button className="icon-button dialog-close-btn" type="button" aria-label={copy.close} onClick={onClose}><X size={16} /></button>
        </header>
        <form className="settings-dialog-form" onSubmit={submit}>
          <div className="relationship-endpoints">
            <label className="manual-field"><span>{copy.from}</span><select value={from} onChange={(event) => setFrom(event.target.value)}>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></label>
            <label className="manual-field"><span>{copy.to}</span><select value={to} onChange={(event) => setTo(event.target.value)}>{entities.map((entity) => <option key={entity.id} value={entity.id} disabled={entity.id === from}>{entity.name}</option>)}</select></label>
          </div>
          <label className="manual-field"><span>{copy.label}</span><input autoFocus value={label} onChange={(event) => setLabel(event.target.value)} maxLength={160} placeholder={ar ? `${entityName(from)} ← ${entityName(to)}` : `${entityName(from)} → ${entityName(to)}`} /></label>
          <div className="relationship-options-grid">
            <label className="manual-field"><span>{copy.fromCardinality}</span><select value={fromCardinality} onChange={(event) => setFromCardinality(event.target.value as Relationship['fromCardinality'])}>{CARDINALITIES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label className="manual-field"><span>{copy.toCardinality}</span><select value={toCardinality} onChange={(event) => setToCardinality(event.target.value as Relationship['toCardinality'])}>{CARDINALITIES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label className="manual-field"><span>{copy.participation}</span><select value={participation} onChange={(event) => setParticipation(event.target.value as Relationship['participation'])}><option value="partial">{copy.partial}</option><option value="total">{copy.total}</option></select></label>
            <label className="manual-field"><span>{copy.onDelete}</span><select value={onDelete} onChange={(event) => setOnDelete(event.target.value as Relationship['onDelete'])}>{RULES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          </div>
          <label className="attribute-flag"><input type="checkbox" checked={identifying} onChange={(event) => setIdentifying(event.target.checked)} /><span>{copy.identifying}</span></label>
          {!canSave && <p className="manual-form-hint" role="status">{copy.required}</p>}
          <footer className="settings-dialog-actions"><button type="button" className="outline-button dialog-cancel-btn" onClick={onClose}>{copy.cancel}</button><button type="submit" className="primary-button" disabled={!canSave}>{copy.save}</button></footer>
        </form>
      </section>
    </div>
  );
}
