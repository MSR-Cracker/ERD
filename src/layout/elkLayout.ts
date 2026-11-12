import type { Entity, Relationship, RoutePoint, Specialization } from '../model/types';

export type DiagramLayout = 'layered' | 'force' | 'radial';

export interface DiagramPosition {
  x: number;
  y: number;
}

export interface DiagramLayoutResult {
  positions: Record<string, DiagramPosition>;
  routes: Record<string, RoutePoint[]>;
}

interface ElkSection {
  startPoint?: RoutePoint;
  endPoint?: RoutePoint;
  bendPoints?: RoutePoint[];
}

interface ElkResultNode {
  id: string;
  x?: number;
  y?: number;
  children?: ElkResultNode[];
  edges?: ElkResultEdge[];
}

interface ElkResultEdge {
  id: string;
  sections?: ElkSection[];
}

async function createElkRuntime() {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  return new ELK();
}

type ElkRuntime = Awaited<ReturnType<typeof createElkRuntime>>;
let elkRuntime: ElkRuntime | undefined;
const NODE_WIDTH = 310;

export function specializationEdgeId(parentId: string, childId: string): string {
  return `specialization:${parentId}:${childId}`;
}

function nodeHeight(entity: Entity, expandedIds: ReadonlySet<string>, compact: boolean): number {
  const maxVisible = compact ? 6 : 14;
  const count = expandedIds.has(entity.id)
    ? entity.attributes.reduce((total, attr) => total + 1 + (attr.children?.length ?? 0), 0)
    : Math.min(entity.attributes.length, maxVisible);
  return 76 + count * (compact ? 26 : 30) + (entity.attributes.length > count ? 28 : 0) + (!compact && entity.notes ? 28 : 0);
}

export async function layoutSchema(
  entities: Entity[],
  relationships: Relationship[],
  mode: DiagramLayout,
  expandedIds: ReadonlySet<string>,
  compact: boolean,
  specializations: Specialization[] = [],
): Promise<DiagramLayoutResult> {
  if (entities.length === 0) return { positions: {}, routes: {} };
  const algorithm = mode === 'force' ? 'force' : mode === 'radial' ? 'radial' : 'layered';
  const layoutEdges = [
    ...relationships.map((relation) => ({ id: relation.id, from: relation.from, to: relation.to, label: relation.label })),
    ...specializations.flatMap((specialization) => specialization.children.map((childId) => ({
      id: specializationEdgeId(specialization.parent, childId),
      from: specialization.parent,
      to: childId,
      label: `ISA · ${specialization.disjointness} · ${specialization.completeness}`,
    }))),
  ];
  const graph = {
    id: 'erdforge-root',
    layoutOptions: {
      'elk.algorithm': algorithm,
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '84',
      'elk.spacing.edgeNode': '36',
      'elk.layered.spacing.nodeNodeBetweenLayers': '148',
      'elk.layered.spacing.edgeNodeBetweenLayers': '46',
      'elk.radial.compactor': 'ROTATION',
    },
    children: entities.map((entity) => ({
      id: entity.id,
      width: NODE_WIDTH,
      height: nodeHeight(entity, expandedIds, compact),
      layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
      ports: [
        { id: `${entity.id}-in`, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'WEST' } },
        { id: `${entity.id}-out`, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'EAST' } },
      ],
    })),
    edges: layoutEdges.filter((edge) => entities.some((entity) => entity.id === edge.from) && entities.some((entity) => entity.id === edge.to)).map((edge) => ({
      id: edge.id,
      sources: [`${edge.from}-out`],
      targets: [`${edge.to}-in`],
      labels: [{ id: `${edge.id}-label`, text: edge.label, width: 168, height: 18 }],
    })),
  };
  elkRuntime ??= await createElkRuntime();
  const result = await elkRuntime.layout(graph) as unknown as ElkResultNode;
  const positions: Record<string, DiagramPosition> = {};
  for (const node of result.children ?? []) positions[node.id] = { x: node.x ?? 0, y: node.y ?? 0 };
  const routes: Record<string, RoutePoint[]> = {};
  for (const edge of result.edges ?? []) {
    const section = edge.sections?.[0];
    if (!section?.startPoint || !section.endPoint) continue;
    routes[edge.id] = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
  }
  return { positions, routes };
}
