import { memo, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Clock3, Copy, GripVertical, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import type { CanvasLocale } from './EntityNode';
import type { Attribute, Entity, NamedSnapshot, Relationship, SchemaModel } from '../model/types';
import { useSchemaStore } from '../store/store';

type Selection = { type: 'entity' | 'relationship'; id: string } | null;

interface ManualInspectorProps {
  selection: Selection;
  locale: CanvasLocale;
  onSelectionChange: (selection: Selection) => void;
  onCreateEntity: () => void;
  onCreateRelationship: () => void;
}

const COPY = {
  en: {
    entity: 'Table',
    relationship: 'Relationship',
    entityName: 'Table name',
    entityKind: 'Table type',
    strong: 'Primary table',
    weak: 'Sub-table (Weak)',
    associative: 'Junction table (M:N)',
    notes: 'Notes',
    attributes: 'Columns',
    addEntity: 'Add table',
    addAttribute: 'Add column',
    addChild: 'Add sub-field',
    duplicate: 'Duplicate',
    remove: 'Delete',
    type: 'Data type',
    kind: 'Column kind',
    simple: 'Standard',
    composite: 'Composite',
    multivalued: 'Multi-valued',
    derived: 'Calculated',
    primary: 'PK (Primary)',
    foreign: 'FK (Foreign)',
    unique: 'Unique',
    nullable: 'Nullable',
    reference: 'Linked table.column',
    noTarget: 'Select target…',
    formula: 'Formula',
    enumValues: 'Allowed values (comma separated)',
    defaultValue: 'Default value',
    required: 'Required',
    noSelection: 'No table selected',
    noSelectionCopy: 'Tap any table or relationship line on the diagram to edit its columns and properties.',
    createRelation: 'Link two tables',
    from: 'From table',
    to: 'To table',
    label: 'Relationship name',
    cardinality: 'Relation type',
    participation: 'Requirement',
    total: 'Required',
    partial: 'Optional',
    identifying: 'Identifying link',
    onDelete: 'On delete',
    onUpdate: 'On update',
    up: 'Move up',
    down: 'Move down',
    saveSnapshot: 'Save version',
    snapshotName: 'Version name…',
    restore: 'Restore',
    deleteSnapshot: 'Delete',
    snapshots: 'Saved versions',
    none: 'No saved versions yet',
    newEntity: 'New table',
    duplicateLabel: 'Copy',
    deleteAttribute: 'Delete column',
    editChild: 'Sub-fields',
    close: 'Clear selection',
  },
  ar: {
    entity: 'جدول',
    relationship: 'علاقة ربط',
    entityName: 'اسم الجدول',
    entityKind: 'تصنيف الجدول',
    strong: 'جدول أساسي',
    weak: 'جدول فرعي تابع',
    associative: 'جدول وسيط (فك علاقة)',
    notes: 'ملاحظات',
    attributes: 'أعمدة الجدول',
    addEntity: 'إضافة جدول جديد',
    addAttribute: 'إضافة عمود جديد',
    addChild: 'إضافة حقل فرعي',
    duplicate: 'تكرار الجدول',
    remove: 'حذف الجدول',
    type: 'نوع البيانات',
    kind: 'طبيعة العمود',
    simple: 'عمود عادي',
    composite: 'حقل مركب',
    multivalued: 'متعدد القيم',
    derived: 'حقل محسوب',
    primary: 'مفتاح أساسي PK',
    foreign: 'مفتاح أجنبي FK',
    unique: 'فريد Unique',
    nullable: 'يقبل الفراغ Null',
    reference: 'مرتبط بجدول آخر',
    noTarget: 'اختر العمود المرتبط…',
    formula: 'معادلة الحساب',
    enumValues: 'القيم المسموحة (مفصولة بفاصلة)',
    defaultValue: 'القيمة الافتراضية',
    required: 'مطلوب',
    noSelection: 'لم يتم تحديد جدول',
    noSelectionCopy: 'اضغط على أي جدول أو خط علاقة في المخطط لتعديل أعمدته وخصائصه بسهولة.',
    createRelation: 'ربط جدولين بعلاقة',
    from: 'الجدول الأول',
    to: 'الجدول الثاني',
    label: 'وصف العلاقة',
    cardinality: 'نوع الارتباط',
    participation: 'طبيعة الربط',
    total: 'إجباري',
    partial: 'اختياري',
    identifying: 'علاقة أساسية متصلة',
    onDelete: 'عند الحذف',
    onUpdate: 'عند التعديل',
    up: 'تحريك لأعلى',
    down: 'تحريك لأسفل',
    saveSnapshot: 'حفظ نسخة',
    snapshotName: 'اسم النسخة المحفوظة…',
    restore: 'استرجاع',
    deleteSnapshot: 'حذف',
    snapshots: 'النسخ المحفوظة',
    none: 'لا توجد نسخ محفوظة بعد',
    newEntity: 'جدول جديد',
    duplicateLabel: 'نسخة',
    deleteAttribute: 'حذف العمود',
    editChild: 'الحقول الفرعية',
    close: 'إلغاء التحديد',
  },
} as const;

const CARDINALITIES: Relationship['fromCardinality'][] = ['1', '0..1', '1..N', '0..N', 'M:N'];
const REFERENTIAL_RULES: Relationship['onDelete'][] = ['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL'];
const REVIEW_FLAG_COPY = { en: { indexed: 'Indexed', stored: 'Stored' }, ar: { indexed: 'مفهرس Index', stored: 'محفوظ فعلياً' } } as const;

function walkAttributes(attributes: Attribute[], visit: (attribute: Attribute) => void): void {
  for (const attribute of attributes) { visit(attribute); walkAttributes(attribute.children ?? [], visit); }
}

function targetKey(entityId: string, attributeId: string): string { return JSON.stringify([entityId, attributeId]); }
function parseTargetKey(value: string): { entityId: string; attributeId: string } | undefined {
  try {
    const decoded: unknown = JSON.parse(value);
    if (Array.isArray(decoded) && typeof decoded[0] === 'string' && typeof decoded[1] === 'string') return { entityId: decoded[0], attributeId: decoded[1] };
  } catch { return undefined; }
  return undefined;
}

function newAttribute(name = 'new_column'): Attribute {
  return { id: `attribute-${crypto.randomUUID()}`, name, dataType: 'VARCHAR(255)', isPK: false, isFK: false, isUnique: false, isNullable: false, kind: 'simple', notes: '' };
}

function duplicateEntity(entity: Entity): Entity {
  const duplicateAttribute = (attribute: Attribute): Attribute => ({ ...structuredClone(attribute), id: `attribute-${crypto.randomUUID()}`, ...(attribute.children ? { children: attribute.children.map(duplicateAttribute) } : {}) });
  return { ...structuredClone(entity), id: `entity-${crypto.randomUUID()}`, name: `${entity.name}_copy`, attributes: entity.attributes.map(duplicateAttribute), isSpecializationOf: undefined };
}

const FlagCheckbox = memo(function FlagCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className={`attribute-flag ${checked ? 'is-checked' : ''}`}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
});

function AttributeEditor({ attribute, entityId, index, total, schema, locale, nested = false, onDragStartIndex, onDropIndex }: {
  attribute: Attribute;
  entityId: string;
  index: number;
  total: number;
  schema: SchemaModel;
  locale: CanvasLocale;
  nested?: boolean;
  onDragStartIndex?: (index: number) => void;
  onDropIndex?: (targetIndex: number) => void;
}) {
  const copy = COPY[locale];
  const reviewFlagCopy = REVIEW_FLAG_COPY[locale];
  const applyOperations = useSchemaStore((state) => state.applyOperations);
  const [name, setName] = useState(attribute.name);
  const [dataType, setDataType] = useState(attribute.dataType);
  const targets = useMemo(() => schema.entities.flatMap((entity) => {
    const values: Array<{ key: string; label: string }> = [];
    walkAttributes(entity.attributes, (candidate) => {
      if (entity.id !== entityId || candidate.id !== attribute.id) values.push({ key: targetKey(entity.id, candidate.id), label: `${entity.name}.${candidate.name}` });
    });
    return values;
  }), [schema.entities, entityId, attribute.id]);
  const currentTarget = attribute.foreignKeyRef ? targetKey(attribute.foreignKeyRef.entityId, attribute.foreignKeyRef.attributeId) : '';

  useEffect(() => setName(attribute.name), [attribute.name]);
  useEffect(() => setDataType(attribute.dataType), [attribute.dataType]);
  const update = (changes: Partial<Omit<Attribute, 'id'>>) => applyOperations([{ op: 'attribute.update', entityId, attributeId: attribute.id, changes }]);
  const commitName = () => { const value = name.trim(); if (value && value !== attribute.name) update({ name: value }); else setName(attribute.name); };
  const commitType = () => { const value = dataType.trim(); if (value && value !== attribute.dataType) update({ dataType: value }); else setDataType(attribute.dataType); };
  const togglePrimary = (value: boolean) => update({ isPK: value, ...(value ? { isUnique: true, isNullable: false } : {}) });
  const selectKind = (kind: Attribute['kind']) => update({ kind, ...(kind === 'composite' ? { dataType: 'COMPOSITE' } : {}), ...(kind === 'simple' || kind === 'derived' ? { children: [] } : {}), ...(kind === 'derived' && !attribute.derivationFormula ? { derivationFormula: 'SUM(items)' } : {}) });
  const updateForeignTarget = (value: string) => {
    const target = parseTargetKey(value);
    if (!target) update({ isFK: false, foreignKeyRef: undefined });
    else update({ isFK: true, foreignKeyRef: target });
  };
  const addChild = () => update({ children: [...(attribute.children ?? []), newAttribute('sub_field')] });

  return (
    <div
      className={`attribute-editor ${nested ? 'attribute-editor-nested' : ''}`}
      draggable={!nested}
      onDragStart={() => { if (!nested && onDragStartIndex) onDragStartIndex(index); }}
      onDragOver={(event) => { if (!nested) event.preventDefault(); }}
      onDrop={(event) => { if (!nested && onDropIndex) { event.preventDefault(); onDropIndex(index); } }}
    >
      <div className="attribute-editor-head">
        {!nested && <span className="attribute-drag-handle" aria-hidden="true"><GripVertical size={12} /></span>}
        <div className="attribute-editor-name-fields" dir="ltr">
          <input
            className="attr-name-input"
            value={name}
            placeholder="column_name"
            aria-label={`${copy.attributes}: ${copy.entityName}`}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}
          />
          <input
            className="attr-type-input"
            value={dataType}
            placeholder="VARCHAR(255)"
            aria-label={copy.type}
            onChange={(event) => setDataType(event.target.value)}
            onBlur={commitType}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}
          />
        </div>
        <div className="attribute-order-actions">
          {!nested && (
            <>
              <button
                type="button"
                className="icon-button tiny"
                aria-label={copy.up}
                title={copy.up}
                disabled={index === 0}
                onClick={() => {
                  const order = schema.entities.find((entity) => entity.id === entityId)!.attributes.map((item) => item.id);
                  [order[index - 1], order[index]] = [order[index]!, order[index - 1]!];
                  applyOperations([{ op: 'attribute.reorder', entityId, attributeIds: order }]);
                }}
              >
                <ArrowUp size={12} />
              </button>
              <button
                type="button"
                className="icon-button tiny"
                aria-label={copy.down}
                title={copy.down}
                disabled={index === total - 1}
                onClick={() => {
                  const order = schema.entities.find((entity) => entity.id === entityId)!.attributes.map((item) => item.id);
                  [order[index], order[index + 1]] = [order[index + 1]!, order[index]!];
                  applyOperations([{ op: 'attribute.reorder', entityId, attributeIds: order }]);
                }}
              >
                <ArrowDown size={12} />
              </button>
            </>
          )}
          <button
            type="button"
            className="icon-button tiny danger-button"
            aria-label={copy.deleteAttribute}
            title={copy.deleteAttribute}
            onClick={() => applyOperations([{ op: 'attribute.delete', entityId, attributeId: attribute.id }])}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      <div className="attribute-flags">
        <FlagCheckbox label={copy.primary} checked={attribute.isPK} onChange={togglePrimary} />
        {!nested && (
          <FlagCheckbox
            label={copy.foreign}
            checked={attribute.isFK}
            onChange={(value) => {
              if (!value) update({ isFK: false, foreignKeyRef: undefined });
              else if (targets[0]) update({ isFK: true, foreignKeyRef: parseTargetKey(targets[0].key) });
            }}
          />
        )}
        <FlagCheckbox label={copy.unique} checked={attribute.isUnique} onChange={(value) => update({ isUnique: value })} />
        <FlagCheckbox label={copy.nullable} checked={attribute.isNullable} onChange={(value) => update({ isNullable: value })} />
        {!nested && <FlagCheckbox label={reviewFlagCopy.indexed} checked={attribute.isIndexed === true} onChange={(value) => update({ isIndexed: value })} />}
      </div>

      <div className="attribute-extra-grid">
        <label className="manual-field compact-manual-field">
          <span>{copy.kind}</span>
          <select aria-label={copy.kind} value={attribute.kind} onChange={(event) => selectKind(event.target.value as Attribute['kind'])}>
            <option value="simple">{copy.simple}</option>
            <option value="composite">{copy.composite}</option>
            <option value="multivalued">{copy.multivalued}</option>
            <option value="derived">{copy.derived}</option>
          </select>
        </label>
        <label className="manual-field compact-manual-field">
          <span>{copy.defaultValue}</span>
          <input value={attribute.defaultValue ?? ''} placeholder="NULL" onChange={(event) => update({ defaultValue: event.target.value })} />
        </label>
      </div>

      {attribute.isFK && (
        <label className="manual-field compact-manual-field">
          <span>{copy.reference}</span>
          <select value={currentTarget} onChange={(event) => updateForeignTarget(event.target.value)}>
            <option value="">{copy.noTarget}</option>
            {targets.map((target) => <option key={target.key} value={target.key}>{target.label}</option>)}
          </select>
        </label>
      )}

      {attribute.kind === 'derived' && (
        <label className="manual-field compact-manual-field">
          <span>{copy.formula}</span>
          <input value={attribute.derivationFormula ?? ''} onChange={(event) => update({ derivationFormula: event.target.value })} />
        </label>
      )}

      {(attribute.kind === 'composite' || attribute.kind === 'multivalued') && (
        <div className="attribute-children-list">
          <div className="attribute-child-heading">
            <span>{copy.editChild}</span>
            <button type="button" className="text-link" onClick={addChild}><Plus size={11} />{copy.addChild}</button>
          </div>
          {attribute.children?.map((child, childIndex) => (
            <AttributeEditor key={child.id} attribute={child} entityId={entityId} index={childIndex} total={attribute.children?.length ?? 0} schema={schema} locale={locale} nested />
          ))}
        </div>
      )}
    </div>
  );
}

function EntityEditor({ entity, schema, locale, onDuplicate, onDelete }: { entity: Entity; schema: SchemaModel; locale: CanvasLocale; onDuplicate: () => void; onDelete: () => void }) {
  const copy = COPY[locale];
  const applyOperations = useSchemaStore((state) => state.applyOperations);
  const [name, setName] = useState(entity.name);
  const [notes, setNotes] = useState(entity.notes);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  useEffect(() => { setName(entity.name); setNotes(entity.notes); }, [entity.id, entity.name, entity.notes]);
  const commitName = () => { const value = name.trim(); if (value && value !== entity.name) applyOperations([{ op: 'entity.update', entityId: entity.id, changes: { name: value } }]); else setName(entity.name); };
  const commitNotes = () => { if (notes !== entity.notes) applyOperations([{ op: 'entity.update', entityId: entity.id, changes: { notes } }]); };
  const addAttribute = () => applyOperations([{ op: 'attribute.add', entityId: entity.id, attribute: newAttribute(`col_${entity.attributes.length + 1}`), index: entity.attributes.length }]);
  const handleDropIndex = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) return;
    const order = entity.attributes.map((item) => item.id);
    const [moved] = order.splice(dragIndex, 1);
    if (!moved) return;
    order.splice(targetIndex, 0, moved);
    setDragIndex(null);
    applyOperations([{ op: 'attribute.reorder', entityId: entity.id, attributeIds: order }]);
  };
  return (
    <section className="manual-selection" aria-label={entity.name}>
      <div className="manual-object-heading">
        <span className="selection-kind-pill">{copy.entity} · {entity.name}</span>
        <div className="manual-object-actions">
          <button type="button" className="icon-button tiny" onClick={onDuplicate} aria-label={copy.duplicate} title={copy.duplicate}><Copy size={13} /></button>
          <button type="button" className="icon-button tiny danger-button" onClick={onDelete} aria-label={copy.remove} title={copy.remove}><Trash2 size={13} /></button>
        </div>
      </div>
      <label className="manual-field">
        <span>{copy.entityName}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} onBlur={commitName} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
      </label>
      <label className="manual-field">
        <span>{copy.entityKind}</span>
        <select aria-label={copy.entityKind} value={entity.kind} onChange={(event) => applyOperations([{ op: 'entity.update', entityId: entity.id, changes: { kind: event.target.value as Entity['kind'] } }])}>
          <option value="strong">{copy.strong}</option>
          <option value="weak">{copy.weak}</option>
          <option value="associative">{copy.associative}</option>
        </select>
      </label>
      <label className="manual-field">
        <span>{copy.notes}</span>
        <textarea value={notes} rows={2} onChange={(event) => setNotes(event.target.value)} onBlur={commitNotes} />
      </label>

      <div className="inspector-section-title">
        <span>{copy.attributes}</span>
        <small>{entity.attributes.length}</small>
      </div>
      <button type="button" className="primary-button add-attribute-button" onClick={addAttribute}>
        <Plus size={14} />
        <span>{copy.addAttribute}</span>
      </button>

      <div className="manual-attribute-list">
        {entity.attributes.map((attribute, index) => (
          <AttributeEditor
            key={attribute.id}
            attribute={attribute}
            entityId={entity.id}
            index={index}
            total={entity.attributes.length}
            schema={schema}
            locale={locale}
            onDragStartIndex={setDragIndex}
            onDropIndex={handleDropIndex}
          />
        ))}
      </div>
    </section>
  );
}

function RelationshipEditor({ relationship, schema, locale, onDuplicate, onDelete }: { relationship: Relationship; schema: SchemaModel; locale: CanvasLocale; onDuplicate: () => void; onDelete: () => void }) {
  const copy = COPY[locale];
  const applyOperations = useSchemaStore((state) => state.applyOperations);
  const [label, setLabel] = useState(relationship.label);
  const [notes, setNotes] = useState(relationship.notes);
  useEffect(() => { setLabel(relationship.label); setNotes(relationship.notes); }, [relationship.id, relationship.label, relationship.notes]);
  const update = (changes: Partial<Omit<Relationship, 'id'>>) => applyOperations([{ op: 'relationship.update', relationshipId: relationship.id, changes }]);
  const commitLabel = () => { const value = label.trim(); if (value && value !== relationship.label) update({ label: value }); else setLabel(relationship.label); };
  const commitNotes = () => { if (notes !== relationship.notes) update({ notes }); };
  const relationEndpoint = (field: 'from' | 'to', value: string) => {
    const other = field === 'from' ? relationship.to : relationship.from;
    if (value && value !== other) update({ [field]: value });
  };
  return (
    <section className="manual-selection" aria-label={relationship.label}>
      <div className="manual-object-heading">
        <span className="selection-kind-pill">{copy.relationship}</span>
        <div className="manual-object-actions">
          <button type="button" className="icon-button tiny" onClick={onDuplicate} aria-label={copy.duplicate} title={copy.duplicate}><Copy size={13} /></button>
          <button type="button" className="icon-button tiny danger-button" onClick={onDelete} aria-label={copy.remove} title={copy.remove}><Trash2 size={13} /></button>
        </div>
      </div>
      <label className="manual-field"><span>{copy.label}</span><input value={label} onChange={(event) => setLabel(event.target.value)} onBlur={commitLabel} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} /></label>
      <div className="relationship-options-grid inspector-relation-grid">
        <label className="manual-field"><span>{copy.from}</span><select value={relationship.from} onChange={(event) => relationEndpoint('from', event.target.value)}>{schema.entities.map((entity) => <option key={entity.id} value={entity.id} disabled={entity.id === relationship.to}>{entity.name}</option>)}</select></label>
        <label className="manual-field"><span>{copy.from} · {copy.cardinality}</span><select value={relationship.fromCardinality} onChange={(event) => update({ fromCardinality: event.target.value as Relationship['fromCardinality'] })}>{CARDINALITIES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="manual-field"><span>{copy.to}</span><select value={relationship.to} onChange={(event) => relationEndpoint('to', event.target.value)}>{schema.entities.map((entity) => <option key={entity.id} value={entity.id} disabled={entity.id === relationship.from}>{entity.name}</option>)}</select></label>
        <label className="manual-field"><span>{copy.to} · {copy.cardinality}</span><select value={relationship.toCardinality} onChange={(event) => update({ toCardinality: event.target.value as Relationship['toCardinality'] })}>{CARDINALITIES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="manual-field"><span>{copy.participation}</span><select value={relationship.participation} onChange={(event) => update({ participation: event.target.value as Relationship['participation'] })}><option value="partial">{copy.partial}</option><option value="total">{copy.total}</option></select></label>
        <label className="manual-field"><span>{copy.onDelete}</span><select value={relationship.onDelete} onChange={(event) => update({ onDelete: event.target.value as Relationship['onDelete'] })}>{REFERENTIAL_RULES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="manual-field"><span>{copy.onUpdate}</span><select value={relationship.onUpdate} onChange={(event) => update({ onUpdate: event.target.value as Relationship['onUpdate'] })}>{REFERENTIAL_RULES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>
      <label className="attribute-flag"><input type="checkbox" checked={relationship.identifying} onChange={(event) => update({ identifying: event.target.checked })} /><span>{copy.identifying}</span></label>
      <label className="manual-field"><span>{copy.notes}</span><textarea value={notes} rows={2} onChange={(event) => setNotes(event.target.value)} onBlur={commitNotes} /></label>
    </section>
  );
}

function SnapshotsPanel({ snapshots, locale }: { snapshots: NamedSnapshot[]; locale: CanvasLocale }) {
  const copy = COPY[locale];
  const saveSnapshot = useSchemaStore((state) => state.saveSnapshot);
  const restoreSnapshot = useSchemaStore((state) => state.restoreSnapshot);
  const deleteSnapshot = useSchemaStore((state) => state.deleteSnapshot);
  const [name, setName] = useState('');
  const ar = locale === 'ar';
  return (
    <section className="snapshots-panel">
      <div className="inspector-section-title"><span><Clock3 size={12} /> {copy.snapshots}</span><small>{snapshots.length}/50</small></div>
      <form className="snapshot-create-row" onSubmit={(event) => { event.preventDefault(); saveSnapshot(name); setName(''); }}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={copy.snapshotName} aria-label={copy.snapshotName} maxLength={80} />
        <button type="submit" className="icon-button dialog-close-btn" aria-label={copy.saveSnapshot} title={copy.saveSnapshot}><Save size={13} /></button>
      </form>
      {snapshots.length === 0 ? <p className="snapshot-empty">{copy.none}</p> : <ul className="snapshot-list">{[...snapshots].reverse().map((snapshot) => <li key={snapshot.id}><span title={snapshot.name}>{snapshot.name}</span><div><button type="button" className="icon-button tiny" aria-label={`${copy.restore}: ${snapshot.name}`} title={copy.restore} onClick={() => restoreSnapshot(snapshot.id)}><RotateCcw size={11} /></button><button type="button" className="icon-button tiny danger-button" aria-label={`${copy.deleteSnapshot}: ${snapshot.name}`} title={copy.deleteSnapshot} onClick={() => deleteSnapshot(snapshot.id)}><Trash2 size={11} /></button></div><time dateTime={snapshot.createdAt}>{new Date(snapshot.createdAt).toLocaleDateString(ar ? 'ar-EG' : 'en')}</time></li>)}</ul>}
    </section>
  );
}

export default function ManualInspector({ selection, locale, onSelectionChange, onCreateEntity, onCreateRelationship }: ManualInspectorProps) {
  const schema = useSchemaStore((state) => state.schema);
  const snapshots = useSchemaStore((state) => state.snapshots);
  const applyOperations = useSchemaStore((state) => state.applyOperations);
  const copy = COPY[locale];
  const entity = selection?.type === 'entity' ? schema.entities.find((candidate) => candidate.id === selection.id) : undefined;
  const relationship = selection?.type === 'relationship' ? schema.relationships.find((candidate) => candidate.id === selection.id) : undefined;

  const duplicateSelectedEntity = () => {
    if (!entity) return;
    const duplicate = duplicateEntity(entity);
    applyOperations([{ op: 'entity.add', entity: duplicate }]);
    onSelectionChange({ type: 'entity', id: duplicate.id });
  };
  const deleteSelectedEntity = () => {
    if (!entity) return;
    applyOperations([{ op: 'entity.delete', entityId: entity.id }]);
    onSelectionChange(null);
  };
  const duplicateSelectedRelationship = () => {
    if (!relationship) return;
    const duplicate = { ...structuredClone(relationship), id: `relationship-${crypto.randomUUID()}`, label: `${relationship.label} copy` };
    applyOperations([{ op: 'relationship.add', relationship: duplicate }]);
    onSelectionChange({ type: 'relationship', id: duplicate.id });
  };
  const deleteSelectedRelationship = () => {
    if (!relationship) return;
    applyOperations([{ op: 'relationship.delete', relationshipId: relationship.id }]);
    onSelectionChange(null);
  };

  return (
    <div className="manual-inspector-content">
      {entity ? <EntityEditor entity={entity} schema={schema} locale={locale} onDuplicate={duplicateSelectedEntity} onDelete={deleteSelectedEntity} />
        : relationship ? <RelationshipEditor relationship={relationship} schema={schema} locale={locale} onDuplicate={duplicateSelectedRelationship} onDelete={deleteSelectedRelationship} />
          : <div className="inspector-placeholder"><div className="inspector-icon"><Clock3 size={18} /></div><h3>{copy.noSelection}</h3><p>{copy.noSelectionCopy}</p><button className="primary-button" type="button" onClick={onCreateEntity}><Plus size={13} />{copy.addEntity}</button></div>}
      {!entity && !relationship && <button type="button" className="outline-button create-relationship-link" onClick={onCreateRelationship} disabled={schema.entities.length < 2}><Plus size={12} />{copy.createRelation}</button>}
      <SnapshotsPanel snapshots={snapshots} locale={locale} />
    </div>
  );
}
