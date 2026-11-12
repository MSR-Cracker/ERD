import { describe, expect, it } from 'vitest';
import { pharmacySchema } from './fixtures/pharmacy';
import { layoutSchema, specializationEdgeId } from '../src/layout/elkLayout';

describe('ELK layout adapter', () => {
  it('returns a stable position for every pharmacy entity and routes the explicit relationships orthogonally', async () => {
    const result = await layoutSchema(pharmacySchema.entities, pharmacySchema.relationships, 'layered', new Set(), false, pharmacySchema.specializations);
    expect(Object.keys(result.positions).sort()).toEqual(pharmacySchema.entities.map((entity) => entity.id).sort());
    const expectedRouteIds = [...pharmacySchema.relationships.map((relationship) => relationship.id), ...pharmacySchema.specializations.flatMap((specialization) => specialization.children.map((childId) => specializationEdgeId(specialization.parent, childId)))];
    expect(Object.keys(result.routes).sort()).toEqual(expectedRouteIds.sort());
    expect(result.routes[specializationEdgeId('item', 'drug')]).toBeDefined();
    expect(Object.values(result.positions).every((position) => Number.isFinite(position.x) && Number.isFinite(position.y))).toBe(true);
    for (const route of Object.values(result.routes)) {
      expect(route.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < route.length; index += 1) {
        expect(route[index]!.x === route[index - 1]!.x || route[index]!.y === route[index - 1]!.y).toBe(true);
      }
    }
  });

  it.each(['layered', 'force', 'radial'] as const)('supports the %s layout mode over the same pharmacy model', async (mode) => {
    const result = await layoutSchema(pharmacySchema.entities, pharmacySchema.relationships, mode, new Set(), false, pharmacySchema.specializations);
    expect(Object.keys(result.positions).length).toBe(pharmacySchema.entities.length);
  });

  it('returns finite positions and orthogonal routes for 120 entities', async () => {
    const templateEntity = pharmacySchema.entities[0]!;
    const entities = Array.from({ length: 120 }, (_, index) => {
      const entity = structuredClone(templateEntity);
      entity.id = `stress-${index}`;
      entity.name = `StressEntity${index}`;
      entity.attributes = entity.attributes.map((attribute, attributeIndex) => ({ ...attribute, id: `stress-${index}-attribute-${attributeIndex}` }));
      return entity;
    });
    const templateRelationship = pharmacySchema.relationships[0]!;
    const relationships = Array.from({ length: 119 }, (_, index) => ({
      ...structuredClone(templateRelationship),
      id: `stress-edge-${index}`,
      from: `stress-${index}`,
      to: `stress-${index + 1}`,
      attributes: [],
    }));
    const result = await layoutSchema(entities, relationships, 'layered', new Set(), true);
    expect(Object.keys(result.positions)).toHaveLength(120);
    expect(Object.keys(result.routes)).toHaveLength(119);
    expect(Object.values(result.positions).every((position) => Number.isFinite(position.x) && Number.isFinite(position.y))).toBe(true);
    for (const route of Object.values(result.routes)) {
      for (let index = 1; index < route.length; index += 1) {
        expect(route[index]!.x === route[index - 1]!.x || route[index]!.y === route[index - 1]!.y).toBe(true);
      }
    }
  }, 15000);
});
