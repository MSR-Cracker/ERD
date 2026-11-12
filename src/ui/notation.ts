import type { Cardinality } from '../model/types';

export type NotationId = 'crow-foot' | 'chen' | 'uml-class' | 'idef1x';
export type CardinalityGlyph = 'one' | 'optional-one' | 'one-many' | 'optional-many' | 'many';

export interface NotationRendererAdapter {
  id: NotationId;
  name: string;
  availability: 'shipped' | 'planned';
  cardinalityGlyph: (cardinality: Cardinality) => CardinalityGlyph;
}

const crowFootGlyph = (cardinality: Cardinality): CardinalityGlyph => {
  switch (cardinality) {
    case '1': return 'one';
    case '0..1': return 'optional-one';
    case '1..N': return 'one-many';
    case '0..N': return 'optional-many';
    case 'M:N': return 'many';
  }
};

export const CROW_FOOT_RENDERER: NotationRendererAdapter = {
  id: 'crow-foot',
  name: 'Crow’s Foot',
  availability: 'shipped',
  cardinalityGlyph: crowFootGlyph,
};

/** Planned renderers share the canonical ER model; their adapters are intentionally not selectable in v1. */
export const NOTATION_RENDERER_REGISTRY: ReadonlyArray<NotationRendererAdapter> = [
  CROW_FOOT_RENDERER,
  { id: 'chen', name: 'Chen', availability: 'planned', cardinalityGlyph: crowFootGlyph },
  { id: 'uml-class', name: 'UML class', availability: 'planned', cardinalityGlyph: crowFootGlyph },
  { id: 'idef1x', name: 'IDEF1X', availability: 'planned', cardinalityGlyph: crowFootGlyph },
];

export function getNotationRenderer(id: NotationId): NotationRendererAdapter {
  const renderer = NOTATION_RENDERER_REGISTRY.find((candidate) => candidate.id === id);
  if (!renderer) throw new Error(`Unknown notation adapter: ${id}`);
  return renderer;
}
