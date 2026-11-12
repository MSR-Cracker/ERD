import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, Position, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { RoutePoint, Specialization } from '../model/types';

export interface SpecializationEdgeData extends Record<string, unknown> {
  specialization: Specialization;
  label: string;
  routePoints?: RoutePoint[];
  highlighted: boolean;
  dimmed: boolean;
}

export type SpecializationFlowEdge = Edge<SpecializationEdgeData, 'specialization'>;

function SpecializationEdgeView(props: EdgeProps<SpecializationFlowEdge>) {
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
  const safeId = id.replace(/[^A-Za-z0-9_-]/g, '_');
  const markerId = `isa-arrow-${safeId}`;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
    offset: 28,
  });
  if (!data) return null;
  const lineColor = data.highlighted ? '#8067b2' : '#9685ba';
  const opacity = data.dimmed ? 0.18 : 1;

  return (
    <>
      <defs>
        <marker id={markerId} viewBox="0 0 12 12" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M1 1 L10 6 L1 11" fill="none" stroke={lineColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
      <g opacity={opacity}>
        <BaseEdge id={id} path={path} markerEnd={`url(#${markerId})`} style={{ stroke: lineColor, strokeWidth: selected || data.highlighted ? 2.5 : 1.7, strokeDasharray: '5 3' }} />
        <path d={path} className="relationship-edge-hit" fill="none" stroke="transparent" strokeWidth={18} aria-hidden="true" />
      </g>
      <EdgeLabelRenderer>
        <div className={`specialization-edge-label nodrag nopan ${selected ? 'is-selected' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity }} role="note" aria-label={data.label}>
          <span className="specialization-label-text">{data.label}</span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const SpecializationEdge = memo(SpecializationEdgeView);
