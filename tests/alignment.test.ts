import { describe, expect, it } from 'vitest';
import { findAlignmentGuides, type PositionedNode } from '../src/layout/alignment';

const node = (id: string, x: number, y: number): PositionedNode => ({ id, position: { x, y }, measured: { width: 270, height: 190 } });

describe('canvas alignment guides', () => {
  it('finds the closest vertical and horizontal alignment within the 7px tolerance', () => {
    expect(findAlignmentGuides(node('active', 106, 194), [node('peer', 100, 200)])).toEqual({ x: 100, y: 200 });
  });

  it('does not draw guides when no peer is near an edge or center line', () => {
    expect(findAlignmentGuides(node('active', 0, 0), [node('peer', 400, 400)])).toEqual({});
    expect(findAlignmentGuides(node('alone', 0, 0), [])).toEqual({});
  });
});
