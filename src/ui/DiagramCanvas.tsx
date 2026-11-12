import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeTypes,
  type NodeTypes,
} from '@xyflow/react';
import { Activity, Check, Command, Focus, LayoutGrid, Link2, Lock, LockOpen, Maximize2, Minimize2, Plus, Redo2, Search, Shapes, Sparkles, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import type { Entity, SchemaModel, SubjectArea } from '../model/types';
import { EntityNode, type CanvasLocale, type EntityFlowNode } from './EntityNode';
import { RelationshipEdge, type RelationshipEdgeData, type RelationshipFlowEdge } from './RelationshipEdge';
import { layoutSchema, type DiagramLayout, type DiagramPosition } from '../layout/elkLayout';
import { findAlignmentGuides, type AlignmentGuides } from '../layout/alignment';
import { SpecializationEdge, type SpecializationFlowEdge } from './SpecializationEdge';
import { createServerAndCanvasExportBlob, downloadBlob, type DiagramExporter } from '../exporters/diagram';

const nodeTypes: NodeTypes = { entity: EntityNode };
type DiagramFlowEdge = RelationshipFlowEdge | SpecializationFlowEdge;
const edgeTypes: EdgeTypes = { relationship: RelationshipEdge, specialization: SpecializationEdge };
const snapGrid: [number, number] = [16, 16];

export function canvasPositionStorageKey(projectId: string): string {
  return `erdforge-canvas-positions:${projectId}`;
}

export function clearCanvasPositions(projectId: string): void {
  try {
    localStorage.removeItem(canvasPositionStorageKey(projectId));
  } catch {
    // Ignore storage errors
  }
}

function readCanvasPositions(projectId: string): Record<string, DiagramPosition> {
  try {
    const raw = localStorage.getItem(canvasPositionStorageKey(projectId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
      if (!value || typeof value !== 'object') return [];
      const position = value as { x?: unknown; y?: unknown };
      return typeof position.x === 'number' && Number.isFinite(position.x) && typeof position.y === 'number' && Number.isFinite(position.y)
        ? [[id, { x: position.x, y: position.y } satisfies DiagramPosition]]
        : [];
    }));
  } catch {
    return {};
  }
}

function writeCanvasPositions(projectId: string, positions: Record<string, DiagramPosition>): void {
  try {
    localStorage.setItem(canvasPositionStorageKey(projectId), JSON.stringify(positions));
  } catch {
    // Ignore storage quota errors
  }
}

const COPY = {
  en: {
    diagram: 'Diagram',
    addTable: 'Add Table',
    addRelation: 'Link Tables',
    createWithAI: 'Ask AI',
    entities: 'tables',
    relations: 'relations',
    filter: 'Show',
    all: 'All tables',
    strong: 'Primary tables',
    weak: 'Sub-tables',
    associative: 'Junction tables',
    compact: 'Compact view',
    lock: 'Lock position',
    unlock: 'Unlock position',
    palette: 'Quick search',
    searchPlaceholder: 'Search tables or actions…',
    noResults: 'No matching tables found',
    fit: 'Fit to screen',
    relayout: 'Auto-arrange tables',
    toggleCompact: 'Toggle compact view',
    lockCommand: 'Lock selected tables',
    unlockCommand: 'Unlock selected tables',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    noEntities: 'No tables in this project yet',
    generate: 'Tap "Ask AI" to describe any database or paste your schema to build a professional ERD automatically.',
    layoutError: 'Auto-layout could not run; you can drag tables manually.',
    close: 'Close search',
    loading: 'Arranging tables…',
    area: 'Group',
    undo: 'Undo',
    redo: 'Redo',
  },
  ar: {
    diagram: 'المخطط',
    addTable: 'إضافة جدول',
    addRelation: 'ربط جدولين',
    createWithAI: 'إنشاء بالمساعد الذكي (Ask AI)',
    entities: 'جداول',
    relations: 'علاقات',
    filter: 'عرض',
    all: 'كل الجداول',
    strong: 'الجداول الأساسية',
    weak: 'الجداول الفرعية',
    associative: 'جداول الربط',
    compact: 'عرض مختصر',
    lock: 'تثبيت المكان',
    unlock: 'إلغاء التثبيت',
    palette: 'بحث سريع',
    searchPlaceholder: 'ابحث عن جدول أو أمر…',
    noResults: 'لا توجد جداول مطابقة',
    fit: 'ملاءمة الشاشة',
    relayout: 'إعادة ترتيب الجداول',
    toggleCompact: 'تبديل العرض المختصر',
    lockCommand: 'تثبيت الجداول',
    unlockCommand: 'تحرير الجداول',
    zoomIn: 'تكبير',
    zoomOut: 'تصغير',
    noEntities: 'لا توجد جداول في هذا المشروع بعد',
    generate: 'اضغط على "المساعد الذكي (Ask AI)" واكتب وصف النظام أو الصق الهيكل النصي أو SQL لبناء مخطط ERD فوراً.',
    layoutError: 'يمكنك سحب وتحريك الجداول يدوياً.',
    close: 'إغلاق البحث',
    loading: 'جارٍ ترتيب الجداول…',
    area: 'مجموعة',
    undo: 'تراجع',
    redo: 'التالي',
  },
} as const;
const PRESENTATION_COPY = { en: { enter: 'Fullscreen', exit: 'Exit Fullscreen' }, ar: { enter: 'ملء الشاشة', exit: 'إنهاء ملء الشاشة' } } as const;

type EntityFilter = 'all' | Entity['kind'];
type Selection = { type: 'entity' | 'relationship'; id: string } | null;

interface DiagramCanvasProps {
  schema: SchemaModel;
  selection: Selection;
  onSelectionChange: (selection: Selection) => void;
  onRenameEntity?: ((entityId: string, nextName: string) => void) | undefined;
  onEditRelationshipLabel: (relationshipId: string, nextLabel: string) => void;
  onCreateRelationship: (fromEntityId?: string, toEntityId?: string) => void;
  onCreateEntity: () => void;
  onAskAI: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  locale: CanvasLocale;
  dark: boolean;
  onDiagramExportReady?: ((exporter: DiagramExporter) => void) | undefined;
}

function getVisibleModel(schema: SchemaModel, filter: EntityFilter) {
  const entities = filter === 'all' ? schema.entities : schema.entities.filter((entity) => entity.kind === filter);
  const visibleIds = new Set(entities.map((entity) => entity.id));
  const relationships = schema.relationships.filter((relationship) => visibleIds.has(relationship.from) && visibleIds.has(relationship.to));
  const specializations = schema.specializations.filter((specialization) => visibleIds.has(specialization.parent) && specialization.children.every((childId) => visibleIds.has(childId)));
  return { entities, relationships, specializations };
}

function SubjectAreaZones({ areas, nodes, visible }: { areas: SubjectArea[]; nodes: EntityFlowNode[]; visible: boolean }) {
  if (!visible || areas.length === 0 || nodes.length === 0) return null;
  const zones = areas.flatMap((area) => {
    const members = nodes.filter((node) => area.entityIds.includes(node.id));
    if (members.length === 0) return [];
    const left = Math.min(...members.map((node) => node.position.x)) - 22;
    const top = Math.min(...members.map((node) => node.position.y)) - 42;
    const right = Math.max(...members.map((node) => node.position.x + (node.measured?.width ?? 270))) + 22;
    const bottom = Math.max(...members.map((node) => node.position.y + (node.measured?.height ?? 190))) + 22;
    return [{ area, left, top, width: right - left, height: bottom - top }];
  });
  return (
    <ViewportPortal>
      {zones.map(({ area, left, top, width, height }) => (
        <div key={area.id} className="subject-area-zone" style={{ left, top, width, height, '--zone-color': area.color } as CSSProperties} aria-label={`${area.name} ${COPY.en.area}`}>
          <span className="subject-area-zone-title"><i />{area.name}</span>
        </div>
      ))}
    </ViewportPortal>
  );
}

function AlignmentGuideLayer({ guides }: { guides: AlignmentGuides }) {
  if (guides.x === undefined && guides.y === undefined) return null;
  return (
    <ViewportPortal>
      {guides.x !== undefined && <div className="alignment-guide alignment-guide-vertical" style={{ left: guides.x, top: -10000, height: 20000 }} aria-hidden="true" />}
      {guides.y !== undefined && <div className="alignment-guide alignment-guide-horizontal" style={{ left: -10000, top: guides.y, width: 20000 }} aria-hidden="true" />}
    </ViewportPortal>
  );
}

function CanvasInner({
  schema,
  selection,
  onSelectionChange,
  onRenameEntity,
  onEditRelationshipLabel,
  onCreateRelationship,
  onCreateEntity,
  onAskAI,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  locale,
  dark,
  onDiagramExportReady,
}: DiagramCanvasProps) {
  const flow = useReactFlow<EntityFlowNode, DiagramFlowEdge>();
  const [nodes, setNodes, onNodesChange] = useNodesState<EntityFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DiagramFlowEdge>([]);
  const [layoutMode] = useState<DiagramLayout>('layered');
  const [filter, setFilter] = useState<EntityFilter>('all');
  const [compact, setCompact] = useState(false);
  const [presentationMode, setPresentationMode] = useState(false);
  const [showAreas] = useState(true);
  const [snapEnabled] = useState(true);
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [hoveredRelationship, setHoveredRelationship] = useState<string | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutError, setLayoutError] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [activeCommand, setActiveCommand] = useState(0);
  const requestId = useRef(0);
  const currentProjectId = useRef(schema.id);
  const lockedIdsRef = useRef(lockedIds);
  const localeRef = useRef(locale);
  const groupByNode = useRef(new Map<string, string>());
  const dragStartPositions = useRef(new Map<string, DiagramPosition>());
  const [guides, setGuides] = useState<AlignmentGuides>({});
  lockedIdsRef.current = lockedIds;
  localeRef.current = locale;
  const copy = COPY[locale];
  const visibleModel = useMemo(() => getVisibleModel(schema, filter), [schema, filter]);
  const activeRelationId = hoveredRelationship ?? (selection?.type === 'relationship' ? selection.id : null);
  const activeRelation = useMemo(() => schema.relationships.find((relation) => relation.id === activeRelationId), [schema.relationships, activeRelationId]);
  const connected = useMemo(() => new Set(activeRelation ? [activeRelation.from, activeRelation.to] : []), [activeRelation]);
  const selectedNodes = useMemo(() => nodes.filter((node) => node.selected), [nodes]);

  const toggleFullscreen = useCallback(() => {
    setPresentationMode((prev) => {
      const next = !prev;
      try {
        if (next && typeof document !== 'undefined' && document.documentElement.requestFullscreen && !document.fullscreenElement) {
          void document.documentElement.requestFullscreen().catch(() => {});
        } else if (!next && typeof document !== 'undefined' && document.fullscreenElement && document.exitFullscreen) {
          void document.exitFullscreen().catch(() => {});
        }
      } catch {
        // CSS fixed fullscreen (.presentation-mode) works on all mobile/desktop browsers
      }
      window.setTimeout(() => {
        void flow.fitView({ padding: 0.14, duration: 240, minZoom: 0.08, maxZoom: 1.35 });
      }, 100);
      return next;
    });
  }, [flow]);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (typeof document !== 'undefined' && !document.fullscreenElement) {
        setPresentationMode(false);
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const runLayout = useCallback(async (preservePositions = true) => {
    const currentRequest = ++requestId.current;
    const savedPositions = preservePositions ? readCanvasPositions(schema.id) : {};
    const isSameProject = currentProjectId.current === schema.id;
    const existingNodeMap = preservePositions && isSameProject
      ? new Map(flow.getNodes().map((node) => [node.id, node.position] as const))
      : new Map<string, DiagramPosition>();

    const allHaveSaved = visibleModel.entities.length > 0 && visibleModel.entities.every(
      (ent) => existingNodeMap.has(ent.id) || Boolean(savedPositions[ent.id]),
    );

    setLayoutBusy(true);
    setLayoutError(false);
    try {
      const result = await layoutSchema(visibleModel.entities, visibleModel.relationships, layoutMode, expandedIds, compact, visibleModel.specializations);
      if (currentRequest !== requestId.current) return;
      const flowNodes: EntityFlowNode[] = visibleModel.entities.map((entity) => ({
        id: entity.id,
        type: 'entity',
        selected: false,
        position: allHaveSaved
          ? (existingNodeMap.get(entity.id) ?? savedPositions[entity.id] ?? result.positions[entity.id] ?? { x: 80, y: 80 })
          : (result.positions[entity.id] ?? { x: 80, y: 80 }),
        draggable: !lockedIdsRef.current.has(entity.id),
        data: {
          entity,
          compact,
          expanded: expandedIds.has(entity.id),
          locked: lockedIdsRef.current.has(entity.id),
          highlighted: false,
          dimmed: false,
          locale: localeRef.current,
          groupName: groupByNode.current.get(entity.id),
          onToggleExpanded: (id: string) => setExpandedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }),
          onRenameEntity,
        },
      }));
      const specializationCopy = localeRef.current === 'ar' ? { isa: 'جدول فرعي' } : { isa: 'Subtype' };
      const flowEdges: DiagramFlowEdge[] = [
        ...visibleModel.relationships.map((relation) => ({
          id: relation.id,
          type: 'relationship' as const,
          selected: false,
          source: relation.from,
          sourceHandle: 'out',
          target: relation.to,
          targetHandle: 'in',
          data: { relation, highlighted: false, dimmed: false, onHover: setHoveredRelationship, onEditLabel: onEditRelationshipLabel } as RelationshipEdgeData,
        })),
        ...visibleModel.specializations.flatMap((specialization) => specialization.children.map((childId) => ({
          id: `specialization:${specialization.parent}:${childId}`,
          type: 'specialization' as const,
          selected: false,
          source: specialization.parent,
          sourceHandle: 'out',
          target: childId,
          targetHandle: 'in',
          data: {
            specialization,
            label: `${specializationCopy.isa}`,
            highlighted: false,
            dimmed: false,
          },
        }))),
      ];
      setNodes(flowNodes);
      setEdges(flowEdges);
      currentProjectId.current = schema.id;
      requestAnimationFrame(() => { void flow.fitView({ padding: 0.17, duration: 280, minZoom: 0.12, maxZoom: 1.35 }); });
    } catch {
      if (currentRequest === requestId.current) setLayoutError(true);
    } finally {
      if (currentRequest === requestId.current) setLayoutBusy(false);
    }
  }, [visibleModel, layoutMode, expandedIds, compact, setNodes, setEdges, flow, onRenameEntity, onEditRelationshipLabel, schema.id]);

  useEffect(() => {
    void runLayout();
    return () => { requestId.current += 1; };
  }, [runLayout]);

  useEffect(() => {
    setNodes((current) => current.map((node) => ({ ...node, draggable: !lockedIds.has(node.id), data: { ...node.data, locked: lockedIds.has(node.id) } })));
  }, [lockedIds, setNodes]);

  useEffect(() => {
    setNodes((current) => current.map((node) => {
      const selected = selection?.type === 'entity' && selection.id === node.id;
      return node.selected === selected ? node : { ...node, selected };
    }));
    setEdges((current) => current.map((edge) => {
      const selected = selection?.type === 'relationship' && selection.id === edge.id;
      return edge.selected === selected ? edge : { ...edge, selected };
    }));
  }, [selection, setNodes, setEdges]);

  useEffect(() => {
    setNodes((current) => current.map((node) => node.data.locale === locale ? node : { ...node, data: { ...node.data, locale } }));
  }, [locale, setNodes]);

  useEffect(() => {
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, highlighted: connected.has(node.id), dimmed: Boolean(activeRelation && !connected.has(node.id)) } })));
    setEdges((current) => current.map((edge) => {
      const highlighted = edge.id === activeRelationId;
      const dimmed = Boolean(activeRelationId && !highlighted);
      if (edge.type === 'relationship' && edge.data) return { ...edge, data: { ...edge.data, highlighted, dimmed } };
      if (edge.type === 'specialization' && edge.data) return { ...edge, data: { ...edge.data, highlighted, dimmed } };
      return edge;
    }));
  }, [activeRelationId, activeRelation, connected, setNodes, setEdges]);

  const openPalette = useCallback(() => { setPaletteQuery(''); setActiveCommand(0); setPaletteOpen(true); }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen((open) => !open); setPaletteQuery(''); }
      if (event.key === 'Escape') { setPaletteOpen(false); setPresentationMode(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const fitDiagram = useCallback(() => { void flow.fitView({ padding: 0.17, duration: 280, minZoom: 0.12, maxZoom: 1.35 }); }, [flow]);

  // SERVER-ASSISTED + LIGHTWEIGHT 2D CANVAS EXPORT (Zero DOM cloning, zero Aw Snap mobile crashes!)
  const exportDiagram = useCallback<DiagramExporter>(async (options, title, filename, onProgress) => {
    const currentPositions = Object.fromEntries(
      flow.getNodes().map((node) => [node.id, { x: node.position.x, y: node.position.y }]),
    );
    const blob = await createServerAndCanvasExportBlob(
      { schema, positions: currentPositions, dark },
      options,
      title,
      onProgress,
    );
    downloadBlob(blob, `${filename}.${options.kind === 'pdf' ? 'pdf' : options.kind}`);
  }, [flow, schema, dark]);

  useEffect(() => { onDiagramExportReady?.(exportDiagram); }, [exportDiagram, onDiagramExportReady]);

  const toggleLocks = useCallback(() => {
    const selectedIds = nodes.filter((node) => node.selected).map((node) => node.id);
    const targetIds = selectedIds.length > 0 ? selectedIds : nodes.map((node) => node.id);
    setLockedIds((current) => {
      const shouldUnlock = targetIds.every((id) => current.has(id));
      const next = new Set(current);
      for (const id of targetIds) { if (shouldUnlock) next.delete(id); else next.add(id); }
      return next;
    });
  }, [nodes]);

  const beginNodeDrag = useCallback((node: EntityFlowNode) => {
    const members = node.data.groupName ? nodes.filter((candidate) => candidate.data.groupName === node.data.groupName) : [node];
    dragStartPositions.current = new Map(members.map((member) => [member.id, { x: member.position.x, y: member.position.y }]));
  }, [nodes]);

  const updateNodeDrag = useCallback((node: EntityFlowNode) => {
    const origin = dragStartPositions.current.get(node.id);
    if (origin && node.data.groupName) {
      const deltaX = node.position.x - origin.x;
      const deltaY = node.position.y - origin.y;
      const groupName = node.data.groupName;
      setNodes((current) => current.map((member) => {
        if (member.id === node.id || member.data.groupName !== groupName) return member;
        const memberOrigin = dragStartPositions.current.get(member.id);
        return memberOrigin ? { ...member, position: { x: memberOrigin.x + deltaX, y: memberOrigin.y + deltaY } } : member;
      }));
    }
    setGuides(findAlignmentGuides(node, nodes.filter((candidate) => candidate.id !== node.id)));
  }, [nodes, setNodes]);

  const finishNodeDrag = useCallback(() => {
    dragStartPositions.current.clear();
    setGuides({});
    const previous = readCanvasPositions(schema.id);
    const current = Object.fromEntries(flow.getNodes().map((node) => [node.id, node.position]));
    writeCanvasPositions(schema.id, { ...previous, ...current });
  }, [flow, schema.id]);

  const commandItems = useMemo(() => {
    const actions = [
      { id: 'fit', label: copy.fit, run: fitDiagram },
      { id: 'layout', label: copy.relayout, run: () => { writeCanvasPositions(schema.id, {}); void runLayout(false); } },
      { id: 'compact', label: copy.toggleCompact, run: () => setCompact((value) => !value) },
      { id: 'lock', label: copy.lockCommand, run: toggleLocks },
    ];
    const query = paletteQuery.trim().toLocaleLowerCase();
    const entityItems = nodes.filter((node) => !query || node.data.entity.name.toLocaleLowerCase().includes(query) || node.data.entity.attributes.some((attribute) => attribute.name.toLocaleLowerCase().includes(query))).map((node) => ({ id: `entity-${node.id}`, label: node.data.entity.name, run: () => { onSelectionChange({ type: 'entity', id: node.id }); void flow.setCenter(node.position.x + 135, node.position.y + 80, { zoom: 1.05, duration: 320 }); } }));
    const actionItems = actions.filter((action) => !query || action.label.toLocaleLowerCase().includes(query));
    return [...entityItems, ...actionItems];
  }, [nodes, paletteQuery, copy, fitDiagram, runLayout, toggleLocks, onSelectionChange, flow, schema.id]);

  const selectCommand = useCallback((index: number) => {
    const action = commandItems[index];
    if (!action) return;
    action.run();
    setPaletteOpen(false);
  }, [commandItems]);

  const isArabic = locale === 'ar';
  const lockTargets = selectedNodes.length > 0 ? selectedNodes : nodes;
  const activeLockLabel = lockTargets.length > 0 && lockTargets.every((node) => lockedIds.has(node.id)) ? copy.unlock : copy.lock;

  return (
    <div className={`diagram-stage ${presentationMode ? 'presentation-mode' : ''}`} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <div className="diagram-toolbar">
        <div className="diagram-title-block">
          <span className="diagram-title-mark"><Shapes size={14} /></span>
          <div>
            <strong>{schema.name || copy.diagram}</strong>
            <span>{visibleModel.entities.length} {copy.entities} · {visibleModel.relationships.length} {copy.relations}</span>
          </div>
        </div>

        <div className="diagram-toolbar-controls">
          {onUndo && (
            <button
              type="button"
              className="diagram-tool-button"
              disabled={!canUndo}
              onClick={onUndo}
              title={copy.undo}
              aria-label={copy.undo}
            >
              <Undo2 size={13} />
              <span>{copy.undo}</span>
            </button>
          )}
          {onRedo && (
            <button
              type="button"
              className="diagram-tool-button"
              disabled={!canRedo}
              onClick={onRedo}
              title={copy.redo}
              aria-label={copy.redo}
            >
              <Redo2 size={13} />
              <span>{copy.redo}</span>
            </button>
          )}
          <button
            type="button"
            className="diagram-tool-button diagram-add-table-button"
            onClick={onCreateEntity}
            title={copy.addTable}
            aria-label={copy.addTable}
          >
            <Plus size={13} />
            <span>{copy.addTable}</span>
          </button>
          <button
            type="button"
            className="diagram-tool-button"
            disabled={schema.entities.length < 2}
            onClick={() => onCreateRelationship()}
            title={copy.addRelation}
            aria-label={copy.addRelation}
          >
            <Link2 size={13} />
            <span>{copy.addRelation}</span>
          </button>
          <label className="diagram-toolbar-field filter-field">
            <span>{copy.filter}</span>
            <select aria-label={copy.filter} value={filter} onChange={(event) => setFilter(event.target.value as EntityFilter)}>
              <option value="all">{copy.all}</option>
              <option value="strong">{copy.strong}</option>
              <option value="weak">{copy.weak}</option>
              <option value="associative">{copy.associative}</option>
            </select>
          </label>
          <button
            type="button"
            className={`diagram-tool-button ${compact ? 'is-active' : ''}`}
            onClick={() => setCompact((value) => !value)}
            aria-pressed={compact}
            title={copy.compact}
          >
            <LayoutGrid size={13} />
            <span>{copy.compact}</span>
          </button>
          <button type="button" className="diagram-tool-button" onClick={toggleLocks} title={activeLockLabel}>
            {activeLockLabel === copy.unlock ? <LockOpen size={13} /> : <Lock size={13} />}
          </button>
          <button type="button" className="diagram-tool-button command-shortcut" onClick={openPalette} aria-label={copy.palette} title={copy.palette}>
            <Search size={13} />
          </button>
          <button
            type="button"
            className={`diagram-tool-button presentation-toggle ${presentationMode ? 'is-active' : ''}`}
            onClick={toggleFullscreen}
            aria-label={PRESENTATION_COPY[locale][presentationMode ? 'exit' : 'enter']}
            aria-pressed={presentationMode}
            title={PRESENTATION_COPY[locale][presentationMode ? 'exit' : 'enter']}
          >
            {presentationMode ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            <span>{PRESENTATION_COPY[locale][presentationMode ? 'exit' : 'enter']}</span>
          </button>
        </div>
      </div>

      <div className="diagram-flow-shell" role="application" aria-label={`${schema.name} ${copy.diagram}`}>
        <ReactFlow<EntityFlowNode, DiagramFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(connection: Connection) => { if (connection.source && connection.target && connection.source !== connection.target) onCreateRelationship(connection.source, connection.target); }}
          onNodeClick={(event, node) => { if ('shiftKey' in event && event.shiftKey === true) return; onSelectionChange({ type: 'entity', id: node.id }); }}
          onEdgeClick={(_event, edge) => { if (edge.type === 'specialization' && edge.data) onSelectionChange({ type: 'entity', id: edge.data.specialization.parent }); else onSelectionChange({ type: 'relationship', id: edge.id }); }}
          onPaneClick={() => onSelectionChange(null)}
          onNodeDragStart={(_event, node) => beginNodeDrag(node)}
          onNodeDrag={(_event, node) => updateNodeDrag(node)}
          onNodeDragStop={finishNodeDrag}
          onlyRenderVisibleElements
          fitView
          fitViewOptions={{ padding: 0.17, minZoom: 0.12, maxZoom: 1.35 }}
          minZoom={0.08}
          maxZoom={2}
          snapToGrid={snapEnabled}
          snapGrid={snapGrid}
          nodesConnectable
          elementsSelectable
          nodesDraggable
          multiSelectionKeyCode="Shift"
          colorMode={dark ? 'dark' : 'light'}
          defaultEdgeOptions={{ type: 'relationship' }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color={dark ? '#344452' : '#dce2e6'} />
          <SubjectAreaZones areas={schema.subjectAreas} nodes={nodes} visible={showAreas} />
          <AlignmentGuideLayer guides={guides} />
          <Controls showInteractive={false} position={locale === 'ar' ? 'bottom-right' : 'bottom-left'}>
            <button type="button" className="react-flow__controls-button" aria-label={copy.zoomIn} title={copy.zoomIn} onClick={() => flow.zoomIn({ duration: 180 })}><ZoomIn size={13} /></button>
            <button type="button" className="react-flow__controls-button" aria-label={copy.zoomOut} title={copy.zoomOut} onClick={() => flow.zoomOut({ duration: 180 })}><ZoomOut size={13} /></button>
            <button type="button" className="react-flow__controls-button" aria-label={copy.fit} title={copy.fit} onClick={fitDiagram}><Focus size={13} /></button>
          </Controls>
          <MiniMap
            className="workbench-minimap"
            pannable
            zoomable
            position={locale === 'ar' ? 'bottom-left' : 'bottom-right'}
            nodeBorderRadius={4}
            nodeStrokeWidth={2}
            nodeStrokeColor={(node) => (node.selected ? '#1d4ed8' : dark ? '#0f172a' : '#1e3a8a')}
            nodeColor={(node) => {
              const area = schema.subjectAreas.find((candidate) => candidate.entityIds.includes(node.id));
              return area?.color ?? (node.type === 'entity' ? '#2563eb' : '#64748b');
            }}
            maskColor={dark ? 'rgba(15, 23, 42, 0.68)' : 'rgba(226, 232, 240, 0.65)'}
          />
          {layoutBusy && <Panel position="top-center"><span className="layout-progress" role="status"><Activity size={12} className="spin-icon" />{copy.loading}</span></Panel>}
          {layoutError && <Panel position="top-center"><span className="layout-error" role="alert">{copy.layoutError}</span></Panel>}
          {nodes.length === 0 && !layoutBusy && (
            <Panel position="top-center">
              <div className="diagram-empty-state">
                <Sparkles size={20} />
                <strong>{copy.noEntities}</strong>
                <span>{copy.generate}</span>
                <div className="diagram-empty-actions">
                  <button type="button" className="primary-button" onClick={onAskAI}>
                    <Sparkles size={13} />
                    <span>{copy.createWithAI}</span>
                  </button>
                  <button type="button" className="outline-button dialog-cancel-btn" onClick={onCreateEntity}>
                    <Plus size={13} />
                    <span>{copy.addTable}</span>
                  </button>
                </div>
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>
      {paletteOpen && (
        <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaletteOpen(false); }}>
          <section className="command-palette" role="dialog" aria-modal="true" aria-label={copy.palette}>
            <div className="command-palette-search"><Search size={16} /><input autoFocus value={paletteQuery} onChange={(event) => { setPaletteQuery(event.target.value); setActiveCommand(0); }} placeholder={copy.searchPlaceholder} aria-label={copy.searchPlaceholder} onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setActiveCommand((index) => Math.min(index + 1, commandItems.length - 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActiveCommand((index) => Math.max(0, index - 1)); }
              if (event.key === 'Enter') { event.preventDefault(); selectCommand(activeCommand); }
              if (event.key === 'Escape') setPaletteOpen(false);
            }} /><kbd>ESC</kbd></div>
            <div className="command-palette-list" role="listbox" aria-label={copy.palette}>
              {commandItems.length === 0 ? <p className="command-no-results">{copy.noResults}</p> : commandItems.map((item, index) => (
                <button type="button" role="option" aria-selected={index === activeCommand} className={`command-palette-item ${index === activeCommand ? 'is-active' : ''}`} key={item.id} onMouseEnter={() => setActiveCommand(index)} onClick={() => selectCommand(index)}>
                  {item.id.startsWith('entity-') ? <Shapes size={13} /> : <Command size={13} />}<span>{item.label}</span>{index === activeCommand && <Check size={13} />}
                </button>
              ))}
            </div>
            <footer><span>{isArabic ? 'للتنقل' : 'Navigate'} <kbd>↑</kbd><kbd>↓</kbd></span><span>{isArabic ? 'للتحديد' : 'Select'} <kbd>↵</kbd></span></footer>
          </section>
        </div>
      )}
    </div>
  );
}

export default function DiagramCanvas(props: DiagramCanvasProps) {
  return <ReactFlowProvider><CanvasInner {...props} /></ReactFlowProvider>;
}
