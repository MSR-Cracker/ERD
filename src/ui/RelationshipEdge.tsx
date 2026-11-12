import { memo, useEffect, useRef, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, Position, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { Cardinality, Relationship, RoutePoint } from '../model/types';
import { CROW_FOOT_RENDERER } from './notation';

export type { RoutePoint };

export interface RelationshipEdgeData extends Record<string, unknown> {
  relation: Relationship;
  routePoints?: RoutePoint[];
  highlighted: boolean;
  dimmed: boolean;
  onHover: (relationshipId: string | null) => void;
  onEditLabel: (relationshipId: string, nextLabel: string) => void;
}

export type RelationshipFlowEdge = Edge<RelationshipEdgeData, 'relationship'>;

function markerGlyph(cardinality: Cardinality) {
  const fork = 'M1 8 L12 1.5 M1 8 L12 8 M1 8 L12 14.5';
  const oneBar = 'M12.5 1.5 L12.5 14.5';
  const innerBar = 'M9 1.5 L9 14.5';
  switch (CROW_FOOT_RENDERER.cardinalityGlyph(cardinality)) {
    case 'one':
      return <><path d={oneBar} /><path d={innerBar} /></>;
    case 'optional-one':
      return <><circle cx="4.2" cy="8" r="3" fill="#0f172a" /><path d={oneBar} /></>;
    case 'one-many':
      return <><path d={fork} /><path d={oneBar} /></>;
    case 'optional-many':
      return <><circle cx="4.2" cy="8" r="3" fill="#0f172a" /><path d="M7.2 8 L14 1.5 M7.2 8 L14 8 M7.2 8 L14 14.5" /></>;
    case 'many':
      return <path d={fork} />;
  }
}

function RelationshipEdgeView(props: EdgeProps<RelationshipFlowEdge>) {
  const {
    id,
    data,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition = Position.Right,
    targetPosition = Position.Left,
    selected,
  } = props;
  const relation = data?.relation;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(relation?.label ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const safeId = id.replace(/[^A-Za-z0-9_-]/g, '_');
  const startMarker = `crowfoot-start-${safeId}`;
  const endMarker = `crowfoot-end-${safeId}`;

  // Always compute path dynamically from live node handle coordinates so edges stay glued while dragging
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 10,
    offset: 28,
  });

  useEffect(() => setDraft(relation?.label ?? ''), [relation?.label]);
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);
  if (!relation || !data) return null;

  const isActive = Boolean(selected || data.highlighted);
  const lineColor = isActive ? '#2563eb' : relation.identifying ? '#0284c7' : '#64748b';
  const opacity = data.dimmed ? 0.2 : 1;
  // MySQL Workbench convention: Identifying relationships are solid lines, Non-Identifying are dashed lines
  const dashArray = relation.identifying ? undefined : '6 4';

  const finishEditing = () => {
    const nextLabel = draft.trim().slice(0, 160);
    if (nextLabel && nextLabel !== relation.label) data.onEditLabel(relation.id, nextLabel);
    setEditing(false);
  };

  return (
    <>
      <defs>
        <marker id={startMarker} viewBox="0 0 16 16" markerWidth="16" markerHeight="16" refX="1.5" refY="8" orient="auto-start-reverse" markerUnits="userSpaceOnUse" className="crowfoot-marker">
          <g fill="none" stroke={lineColor} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{markerGlyph(relation.fromCardinality)}</g>
        </marker>
        <marker id={endMarker} viewBox="0 0 16 16" markerWidth="16" markerHeight="16" refX="14.5" refY="8" orient="auto-start-reverse" markerUnits="userSpaceOnUse" className="crowfoot-marker">
          <g fill="none" stroke={lineColor} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{markerGlyph(relation.toCardinality)}</g>
        </marker>
      </defs>
      <g opacity={opacity} onMouseEnter={() => data.onHover(relation.id)} onMouseLeave={() => data.onHover(null)}>
        <BaseEdge
          id={id}
          path={path}
          markerStart={`url(#${startMarker})`}
          markerEnd={`url(#${endMarker})`}
          style={{
            stroke: lineColor,
            strokeWidth: isActive ? 3 : 2.1,
            ...(dashArray ? { strokeDasharray: dashArray } : {}),
            transition: 'stroke .15s ease, stroke-width .15s ease, opacity .15s ease',
          }}
        />
        <path d={path} className="relationship-edge-hit" fill="none" stroke="transparent" strokeWidth={22} aria-hidden="true" />
      </g>
      <EdgeLabelRenderer>
        <div
          className={`relationship-edge-label nodrag nopan ${selected ? 'is-selected' : ''} ${data.highlighted ? 'is-highlighted' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity }}
          onMouseEnter={() => data.onHover(relation.id)}
          onMouseLeave={() => data.onHover(null)}
        >
          <span className="edge-cardinality" aria-label={`From cardinality ${relation.fromCardinality}`}>{relation.fromCardinality}</span>
          {editing ? (
            <input
              ref={inputRef}
              className="relationship-label-editor"
              value={draft}
              maxLength={160}
              aria-label={`Edit relationship label: ${relation.label}`}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={finishEditing}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') { event.preventDefault(); finishEditing(); }
                if (event.key === 'Escape') { event.preventDefault(); setDraft(relation.label); setEditing(false); }
              }}
            />
          ) : (
            <button
              type="button"
              className="relationship-label-button"
              onDoubleClick={(event) => { event.stopPropagation(); setEditing(true); }}
              onKeyDown={(event) => {
                if (event.key === 'F2') { event.preventDefault(); event.stopPropagation(); setEditing(true); }
              }}
              aria-label={`${relation.label}; press F2 or double-click to rename`}
              title="Double-click or press F2 to edit this relationship label"
            >
              {relation.label}
            </button>
          )}
          <span className="edge-cardinality" aria-label={`To cardinality ${relation.toCardinality}`}>{relation.toCardinality}</span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const RelationshipEdge = memo(RelationshipEdgeView);
