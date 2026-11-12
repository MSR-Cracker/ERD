import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronUp, Database, Diamond, KeyRound, Link2, ListTree, Lock, Sigma, Square } from 'lucide-react';
import type { Attribute, Entity } from '../model/types';
import type { CanvasLocale } from '../i18n';

export type { CanvasLocale };

export interface EntityNodeData extends Record<string, unknown> {
  entity: Entity;
  compact: boolean;
  expanded: boolean;
  locked: boolean;
  highlighted: boolean;
  dimmed: boolean;
  locale: CanvasLocale;
  groupName?: string | undefined;
  onToggleExpanded: (entityId: string) => void;
  onRenameEntity?: ((entityId: string, nextName: string) => void) | undefined;
}

export type EntityFlowNode = Node<EntityNodeData, 'entity'>;

function AttributeKindIcon({ attribute }: { attribute: Attribute }) {
  if (attribute.isPK && attribute.isFK) {
    return <KeyRound size={13} className="node-kind-icon pk-fk-icon" aria-label="Primary foreign key" />;
  }
  if (attribute.isPK) {
    return <KeyRound size={13} className="node-kind-icon pk-icon" aria-label="Primary key" />;
  }
  if (attribute.isFK) {
    return <Link2 size={13} className="node-kind-icon fk-icon" aria-label="Foreign key" />;
  }
  if (attribute.kind === 'multivalued') {
    return <ListTree size={12} className="node-kind-icon multi-icon" aria-label="Multivalued" />;
  }
  if (attribute.kind === 'composite') {
    return <Square size={11} className="node-kind-icon composite-icon" aria-label="Composite" />;
  }
  if (attribute.kind === 'derived') {
    return <Sigma size={12} className="node-kind-icon derived-icon" aria-label="Derived" />;
  }
  return (
    <Diamond
      size={9}
      className={`node-kind-icon diamond-col-icon ${attribute.isNullable ? 'is-nullable-diamond' : 'is-nn-diamond'}`}
      aria-hidden="true"
    />
  );
}

function AttributeRow({ attribute, nested = false }: { attribute: Attribute; nested?: boolean }) {
  const constraints = [
    attribute.isPK ? 'PK' : null,
    attribute.isFK ? 'FK' : null,
    attribute.isUnique && !attribute.isPK ? 'UQ' : null,
    !attribute.isNullable ? 'NN' : null,
    attribute.isIndexed ? 'IDX' : null,
  ].filter((constraint): constraint is string => constraint !== null);

  const fkTooltip = attribute.foreignKeyRef
    ? ` → ${attribute.foreignKeyRef.entityId}.${attribute.foreignKeyRef.attributeId.split('.').pop()}`
    : '';

  return (
    <div
      className={`entity-attribute-row ${nested ? 'nested-attribute-row' : ''} ${attribute.isPK ? 'is-pk-row' : ''} ${attribute.isFK ? 'is-fk-row' : ''} attr-kind-${attribute.kind}`}
      title={attribute.notes || `${attribute.name}: ${attribute.dataType}${fkTooltip}`}
    >
      <span className="attribute-kind-mark">
        <AttributeKindIcon attribute={attribute} />
      </span>
      <span className="entity-attribute-name">
        {attribute.name}
        {attribute.isFK && attribute.foreignKeyRef && (
          <small className="fk-target-inline" title={`References ${attribute.foreignKeyRef.entityId}`}>
            → {attribute.foreignKeyRef.entityId}
          </small>
        )}
      </span>
      <span className="entity-attribute-constraints">
        {constraints.map((constraint) => (
          <small key={constraint} className={`constraint-badge constraint-${constraint.toLowerCase()}`}>
            {constraint}
          </small>
        ))}
      </span>
      <span className="entity-attribute-type">{attribute.dataType}</span>
    </div>
  );
}

function EntityNodeView({ data, selected }: NodeProps<EntityFlowNode>) {
  const { entity, compact, expanded, locked, highlighted, dimmed, locale, groupName, onToggleExpanded, onRenameEntity } = data;
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(entity.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const visibleCount = compact ? 6 : 14;
  const visibleAttributes = expanded ? entity.attributes : entity.attributes.slice(0, visibleCount);
  const pkAttributes = visibleAttributes.filter((attr) => attr.isPK);
  const nonPkAttributes = visibleAttributes.filter((attr) => !attr.isPK);
  const hiddenCount = entity.attributes.length - visibleAttributes.length;
  const isArabic = locale === 'ar';

  useEffect(() => { setDraftName(entity.name); }, [entity.name]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const finishRename = () => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== entity.name && onRenameEntity) {
      onRenameEntity(entity.id, trimmed);
    } else {
      setDraftName(entity.name);
    }
    setEditing(false);
  };

  const kindLabel = isArabic
    ? ({ strong: 'جدول أساسي', weak: 'كيان ضعيف', associative: 'جدول ربط' } as const)[entity.kind]
    : ({ strong: 'TABLE', weak: 'WEAK', associative: 'JUNCTION' } as const)[entity.kind];

  return (
    <article
      className={`entity-node-card kind-${entity.kind} ${selected ? 'is-selected' : ''} ${highlighted ? 'is-highlighted' : ''} ${dimmed ? 'is-dimmed' : ''} ${compact ? 'is-compact' : ''} ${locked ? 'is-locked' : ''}`}
      aria-label={`${entity.name} entity`}
    >
      <Handle type="target" position={Position.Left} id="in" className="entity-handle target-handle" aria-label={isArabic ? 'مدخل العلاقة' : 'Relationship input'} />

      <header className={`entity-node-header header-${entity.kind}`}>
        <span className={`entity-type-glyph glyph-${entity.kind}`} aria-hidden="true">
          <Database size={14} strokeWidth={2.3} />
        </span>
        <div className="entity-node-title-wrap">
          {editing ? (
            <input
              ref={inputRef}
              className="entity-title-editor nodrag nopan"
              value={draftName}
              aria-label={`Rename ${entity.name}`}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={finishRename}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') { event.preventDefault(); finishRename(); }
                if (event.key === 'Escape') { event.preventDefault(); setDraftName(entity.name); setEditing(false); }
              }}
            />
          ) : (
            <strong
              className="entity-node-title"
              tabIndex={0}
              title={isArabic ? 'انقر مرتين أو اضغط F2 لإعادة التسمية' : 'Double-click or press F2 to rename'}
              onDoubleClick={(event) => { event.stopPropagation(); setEditing(true); }}
              onKeyDown={(event) => {
                if (event.key === 'F2') { event.preventDefault(); event.stopPropagation(); setEditing(true); }
              }}
            >
              {entity.name}
            </strong>
          )}
          <div className="entity-node-meta">
            <span className="entity-node-kind">{kindLabel}</span>
            <span className="entity-col-count">{entity.attributes.length} {isArabic ? 'حقل' : 'cols'}</span>
            {groupName && <span className="entity-group-label">{groupName}</span>}
          </div>
        </div>
        {locked && (
          <span className="entity-locked-mark" title={isArabic ? 'مقفل' : 'Locked'} aria-label={isArabic ? 'مقفل' : 'Locked'}>
            <Lock size={12} />
          </span>
        )}
      </header>

      <div className="entity-workbench-columns-bar">
        <span>{isArabic ? 'العمود / المفتاح' : 'COLUMN'}</span>
        <span>{isArabic ? 'القيود' : 'KEYS'}</span>
        <span>{isArabic ? 'النوع' : 'DATA TYPE'}</span>
      </div>

      <div className="entity-node-attributes" role="list" aria-label={isArabic ? `سمات ${entity.name}` : `${entity.name} attributes`}>
        {pkAttributes.length > 0 && (
          <div className="workbench-pk-group">
            {pkAttributes.map((attribute) => (
              <div key={attribute.id} role="listitem">
                <AttributeRow attribute={attribute} />
                {expanded && attribute.children?.map((child) => <AttributeRow key={child.id} attribute={child} nested />)}
              </div>
            ))}
          </div>
        )}
        {pkAttributes.length > 0 && nonPkAttributes.length > 0 && <div className="workbench-pk-divider" />}
        {nonPkAttributes.map((attribute) => (
          <div key={attribute.id} role="listitem">
            <AttributeRow attribute={attribute} />
            {expanded && attribute.children?.map((child) => <AttributeRow key={child.id} attribute={child} nested />)}
          </div>
        ))}
      </div>

      {entity.attributes.length > visibleCount && (
        <button
          type="button"
          className="entity-expand-button nodrag nopan"
          onClick={(event) => { event.stopPropagation(); onToggleExpanded(entity.id); }}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded
            ? (isArabic ? 'طي الحقول الإضافية' : 'Show fewer columns')
            : `${isArabic ? 'عرض' : 'Show'} ${hiddenCount} ${isArabic ? 'حقول إضافية' : 'more columns'}`}
        </button>
      )}
      {!compact && entity.notes && <footer className="entity-node-note" title={entity.notes}>{entity.notes}</footer>}
      <Handle type="source" position={Position.Right} id="out" className="entity-handle source-handle" aria-label={isArabic ? 'مخرج العلاقة' : 'Relationship output'} />
    </article>
  );
}

export const EntityNode = memo(EntityNodeView);
