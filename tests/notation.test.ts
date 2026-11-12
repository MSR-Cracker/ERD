import { describe, expect, it } from 'vitest';
import { CROW_FOOT_RENDERER, NOTATION_RENDERER_REGISTRY } from '../src/ui/notation';

describe('notation renderer registry', () => {
  it('keeps all four renderers on the shared adapter registry but ships Crow’s Foot only in v1', () => {
    expect(NOTATION_RENDERER_REGISTRY.map((renderer) => renderer.id)).toEqual(['crow-foot', 'chen', 'uml-class', 'idef1x']);
    expect(NOTATION_RENDERER_REGISTRY.filter((renderer) => renderer.availability === 'shipped').map((renderer) => renderer.id)).toEqual(['crow-foot']);
  });

  it('maps each canonical cardinality to the correct Crow’s Foot glyph', () => {
    expect(CROW_FOOT_RENDERER.cardinalityGlyph('1')).toBe('one');
    expect(CROW_FOOT_RENDERER.cardinalityGlyph('0..1')).toBe('optional-one');
    expect(CROW_FOOT_RENDERER.cardinalityGlyph('1..N')).toBe('one-many');
    expect(CROW_FOOT_RENDERER.cardinalityGlyph('0..N')).toBe('optional-many');
    expect(CROW_FOOT_RENDERER.cardinalityGlyph('M:N')).toBe('many');
  });
});
