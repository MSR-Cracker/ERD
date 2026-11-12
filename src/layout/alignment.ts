export interface PositionedNode {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
}

export type AlignmentGuides = { x?: number; y?: number };

export function findAlignmentGuides(node: PositionedNode, peers: PositionedNode[]): AlignmentGuides {
  const width = node.measured?.width ?? 270;
  const height = node.measured?.height ?? 190;
  const ownX = [node.position.x, node.position.x + width / 2, node.position.x + width];
  const ownY = [node.position.y, node.position.y + height / 2, node.position.y + height];
  let bestX: { coordinate: number; distance: number } | undefined;
  let bestY: { coordinate: number; distance: number } | undefined;
  for (const peer of peers) {
    const peerWidth = peer.measured?.width ?? 270;
    const peerHeight = peer.measured?.height ?? 190;
    const peerX = [peer.position.x, peer.position.x + peerWidth / 2, peer.position.x + peerWidth];
    const peerY = [peer.position.y, peer.position.y + peerHeight / 2, peer.position.y + peerHeight];
    for (const from of ownX) for (const to of peerX) {
      const distance = Math.abs(from - to);
      if (distance <= 7 && (!bestX || distance < bestX.distance)) bestX = { coordinate: to, distance };
    }
    for (const from of ownY) for (const to of peerY) {
      const distance = Math.abs(from - to);
      if (distance <= 7 && (!bestY || distance < bestY.distance)) bestY = { coordinate: to, distance };
    }
  }
  return { ...(bestX ? { x: bestX.coordinate } : {}), ...(bestY ? { y: bestY.coordinate } : {}) };
}
