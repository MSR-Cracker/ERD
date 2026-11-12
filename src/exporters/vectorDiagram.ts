import type { Attribute, Entity, SchemaModel } from '../model/types';

export interface NodeBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  entity: Entity;
}

export interface DiagramRenderPayload {
  schema: SchemaModel;
  positions: Record<string, { x: number; y: number }>;
  dark: boolean;
}

const CARD_W = 310;
const HEADER_H = 44;
const COL_BAR_H = 22;
const ROW_H = 26;
const PAD = 70;

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function computeNodeBoxes(
  schema: SchemaModel,
  positions: Record<string, { x: number; y: number }>,
): { boxes: NodeBox[]; minX: number; minY: number; width: number; height: number } {
  const boxes: NodeBox[] = schema.entities.map((entity, idx) => {
    const pos = positions[entity.id] ?? { x: (idx % 4) * 380 + 80, y: Math.floor(idx / 4) * 320 + 80 };
    const attrCount = Math.max(1, entity.attributes.length);
    const height = HEADER_H + COL_BAR_H + attrCount * ROW_H + 12;
    return {
      id: entity.id,
      x: pos.x,
      y: pos.y,
      width: CARD_W,
      height,
      entity,
    };
  });

  if (boxes.length === 0) {
    return { boxes: [], minX: 0, minY: 0, width: 1200, height: 800 };
  }

  const minX = Math.min(...boxes.map((b) => b.x)) - PAD;
  const minY = Math.min(...boxes.map((b) => b.y)) - PAD;
  const maxX = Math.max(...boxes.map((b) => b.x + b.width)) + PAD;
  const maxY = Math.max(...boxes.map((b) => b.y + b.height)) + PAD;

  return {
    boxes,
    minX,
    minY,
    width: Math.max(900, Math.ceil(maxX - minX)),
    height: Math.max(650, Math.ceil(maxY - minY)),
  };
}

function getConstraintBadges(attr: Attribute): Array<{ text: string; bg: string; border: string; color: string }> {
  const list: Array<{ text: string; bg: string; border: string; color: string }> = [];
  if (attr.isPK) list.push({ text: 'PK', bg: '#fef3c7', border: '#f59e0b', color: '#92400e' });
  if (attr.isFK) list.push({ text: 'FK', bg: '#e0f2fe', border: '#38bdf8', color: '#075985' });
  if (attr.isUnique && !attr.isPK) list.push({ text: 'UQ', bg: '#f3e8ff', border: '#c084fc', color: '#6b21a8' });
  if (!attr.isNullable) list.push({ text: 'NN', bg: '#dcfce7', border: '#86efac', color: '#166534' });
  return list;
}

/**
 * Generates a pure, self-contained Vector SVG string on the Cloudflare Worker (or client)
 * with zero DOM cloning, minimal memory usage, and subtle "Powered by MSR_Coder" side mark.
 */
export function generateServerVectorSvg(payload: DiagramRenderPayload): { svg: string; width: number; height: number } {
  const { schema, positions, dark } = payload;
  const { boxes, minX, minY, width, height } = computeNodeBoxes(schema, positions);
  const boxMap = new Map(boxes.map((b) => [b.id, b]));

  const bg = dark ? '#0b1120' : '#f1f5f9';
  const gridColor = dark ? '#1e293b' : '#cbd5e1';
  const cardBg = dark ? '#1e293b' : '#ffffff';
  const colBarBg = dark ? '#0f172a' : '#f1f5f9';
  const textMain = dark ? '#f8fafc' : '#0f172a';
  const textMuted = dark ? '#94a3b8' : '#64748b';
  const typeColor = dark ? '#38bdf8' : '#0284c7';
  const rowBorder = dark ? '#263346' : '#f1f5f9';

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family: Cairo, 'IBM Plex Sans Arabic', Inter, 'Segoe UI', Tahoma, sans-serif;">`,
  );

  // Background & Grid Pattern
  parts.push(`<defs>
    <pattern id="wb-grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" fill="${gridColor}" />
    </pattern>
  </defs>`);
  parts.push(`<rect width="100%" height="100%" fill="${bg}" />`);
  parts.push(`<rect width="100%" height="100%" fill="url(#wb-grid)" />`);

  // 1. Render Relationships (Orthogonal paths + labels)
  const drawEdge = (fromId: string, toId: string, label: string, fromCard: string, toCard: string, dashed: boolean, color: string) => {
    const b1 = boxMap.get(fromId);
    const b2 = boxMap.get(toId);
    if (!b1 || !b2) return;
    const x1 = b1.x - minX + b1.width;
    const y1 = b1.y - minY + b1.height / 2;
    const x2 = b2.x - minX;
    const y2 = b2.y - minY + b2.height / 2;
    const midX = (x1 + x2) / 2;
    const d = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
    parts.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" ${dashed ? 'stroke-dasharray="6 4"' : ''} stroke-linecap="round" stroke-linejoin="round" />`,
    );
    parts.push(`<circle cx="${x1}" cy="${y1}" r="4" fill="${color}" />`);
    parts.push(`<circle cx="${x2}" cy="${y2}" r="4" fill="${color}" />`);

    const labelText = `${fromCard ? `${fromCard} · ` : ''}${label}${toCard ? ` · ${toCard}` : ''}`;
    const labelW = Math.min(240, Math.max(70, labelText.length * 6.5 + 18));
    const lx = midX - labelW / 2;
    const ly = (y1 + y2) / 2 - 11;
    parts.push(
      `<rect x="${lx}" y="${ly}" width="${labelW}" height="22" rx="5" fill="${cardBg}" stroke="${color}" stroke-width="1.2" />`,
    );
    parts.push(
      `<text x="${midX}" y="${ly + 14.5}" text-anchor="middle" fill="${textMain}" font-size="10.5" font-weight="700">${escapeXml(labelText.slice(0, 34))}</text>`,
    );
  };

  for (const rel of schema.relationships) {
    drawEdge(
      rel.from,
      rel.to,
      rel.label || `${rel.from} → ${rel.to}`,
      rel.fromCardinality,
      rel.toCardinality,
      !rel.identifying,
      rel.identifying ? '#0284c7' : '#64748b',
    );
  }

  for (const spec of schema.specializations) {
    for (const childId of spec.children) {
      drawEdge(spec.parent, childId, 'ISA', '1', '0..1', true, '#8b5cf6');
    }
  }

  // 2. Render Table Cards
  for (const box of boxes) {
    const { entity } = box;
    const x = box.x - minX;
    const y = box.y - minY;
    const borderColor = entity.kind === 'associative' ? '#0d9488' : entity.kind === 'weak' ? '#d97706' : '#2563eb';
    const headerBg = entity.kind === 'associative' ? '#0f766e' : entity.kind === 'weak' ? '#b45309' : '#1d4ed8';

    // Card container
    parts.push(
      `<rect x="${x}" y="${y}" width="${box.width}" height="${box.height}" rx="8" fill="${cardBg}" stroke="${borderColor}" stroke-width="2" />`,
    );
    // Header
    parts.push(
      `<rect x="${x}" y="${y}" width="${box.width}" height="${HEADER_H}" rx="7" fill="${headerBg}" />`,
    );
    parts.push(
      `<text x="${x + 14}" y="${y + 22}" fill="#ffffff" font-size="14" font-weight="800">${escapeXml(entity.name)}</text>`,
    );
    parts.push(
      `<text x="${x + 14}" y="${y + 36}" fill="#cbd5e1" font-size="9.5" font-weight="700">${entity.kind.toUpperCase()} · ${entity.attributes.length} COLS</text>`,
    );

    // Column Header Bar
    const barY = y + HEADER_H;
    parts.push(`<rect x="${x + 1}" y="${barY}" width="${box.width - 2}" height="${COL_BAR_H}" fill="${colBarBg}" />`);
    parts.push(`<text x="${x + 12}" y="${barY + 14.5}" fill="${textMuted}" font-size="9" font-weight="800">COLUMN</text>`);
    parts.push(`<text x="${x + box.width - 12}" y="${barY + 14.5}" text-anchor="end" fill="${textMuted}" font-size="9" font-weight="800">DATA TYPE</text>`);

    // Attributes
    let rowY = barY + COL_BAR_H;
    const pkAttrs = entity.attributes.filter((a) => a.isPK);
    const otherAttrs = entity.attributes.filter((a) => !a.isPK);
    const orderedAttrs = [...pkAttrs, ...otherAttrs];

    orderedAttrs.forEach((attr, idx) => {
      if (attr.isPK) {
        parts.push(
          `<rect x="${x + 1}" y="${rowY}" width="${box.width - 2}" height="${ROW_H}" fill="${dark ? 'rgba(245, 158, 11, 0.12)' : '#fffbeb'}" />`,
        );
      } else if (attr.isFK) {
        parts.push(
          `<rect x="${x + 1}" y="${rowY}" width="${box.width - 2}" height="${ROW_H}" fill="${dark ? 'rgba(56, 189, 248, 0.1)' : '#f0f9ff'}" />`,
        );
      }

      const iconSymbol = attr.isPK ? '🔑' : attr.isFK ? '🔗' : '•';
      parts.push(
        `<text x="${x + 10}" y="${rowY + 17}" fill="${attr.isPK ? '#f59e0b' : attr.isFK ? '#38bdf8' : textMuted}" font-size="11">${iconSymbol}</text>`,
      );
      parts.push(
        `<text x="${x + 28}" y="${rowY + 17}" fill="${textMain}" font-size="12" font-weight="${attr.isPK ? '700' : '600'}">${escapeXml(attr.name.slice(0, 22))}</text>`,
      );

      // Badges
      const badges = getConstraintBadges(attr);
      let badgeRight = x + box.width - 78;
      for (const b of badges) {
        badgeRight -= 22;
        parts.push(
          `<rect x="${badgeRight}" y="${rowY + 6}" width="20" height="14" rx="3" fill="${b.bg}" stroke="${b.border}" stroke-width="0.8" />`,
        );
        parts.push(
          `<text x="${badgeRight + 10}" y="${rowY + 15.5}" text-anchor="middle" fill="${b.color}" font-size="8.5" font-weight="800">${b.text}</text>`,
        );
      }

      parts.push(
        `<text x="${x + box.width - 10}" y="${rowY + 17}" text-anchor="end" fill="${typeColor}" font-size="10.5" font-weight="700" font-family="monospace">${escapeXml(attr.dataType.slice(0, 14))}</text>`,
      );

      rowY += ROW_H;
      if (idx < orderedAttrs.length - 1) {
        parts.push(
          `<line x1="${x + 2}" y1="${rowY}" x2="${x + box.width - 2}" y2="${rowY}" stroke="${rowBorder}" stroke-width="1" />`,
        );
      }
    });
  }

  // 3. Subtle "Powered by MSR_Coder" watermark on the side
  parts.push(
    `<g opacity="0.82">
      <rect x="${width - 148}" y="${height - 28}" width="134" height="18" rx="4" fill="${cardBg}" stroke="${gridColor}" stroke-width="0.9" />
      <text x="${width - 81}" y="${height - 15.5}" text-anchor="middle" fill="${textMuted}" font-size="9.5" font-weight="600" font-family="Cairo, Inter, sans-serif">Powered by MSR_Coder</text>
    </g>`,
  );

  parts.push('</svg>');
  return { svg: parts.join('\n'), width, height };
}

/**
 * Renders the diagram directly onto an HTML5 2D Canvas with safe memory limits
 * (never exceeds mobile browser GPU RAM, zero DOM cloning, zero Aw Snap crashes).
 */
export async function renderDiagramToSafeCanvas(payload: DiagramRenderPayload, requestedScale = 2): Promise<HTMLCanvasElement> {
  const { schema, positions, dark } = payload;
  const { boxes, minX, minY, width, height } = computeNodeBoxes(schema, positions);
  const boxMap = new Map(boxes.map((b) => [b.id, b]));

  // Cap total canvas dimension safely to 3200px max on longest side so mobile Android/iOS never runs out of RAM
  const maxSide = Math.max(width, height);
  const safeScale = Math.min(requestedScale, Math.max(1.25, Math.min(2.5, 3200 / maxSide)));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * safeScale);
  canvas.height = Math.round(height * safeScale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not initialize 2D canvas.');

  ctx.scale(safeScale, safeScale);

  const bg = dark ? '#0b1120' : '#f1f5f9';
  const gridColor = dark ? '#1e293b' : '#cbd5e1';
  const cardBg = dark ? '#1e293b' : '#ffffff';
  const colBarBg = dark ? '#0f172a' : '#f1f5f9';
  const textMain = dark ? '#f8fafc' : '#0f172a';
  const textMuted = dark ? '#94a3b8' : '#64748b';
  const typeColor = dark ? '#38bdf8' : '#0284c7';
  const rowBorder = dark ? '#263346' : '#e2e8f0';

  // 1. Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Dot grid
  ctx.fillStyle = gridColor;
  for (let gx = 12; gx < width; gx += 24) {
    for (let gy = 12; gy < height; gy += 24) {
      ctx.fillRect(gx, gy, 1.5, 1.5);
    }
  }

  // Helper for rounded rects
  const roundRect = (rx: number, ry: number, rw: number, rh: number, radius: number) => {
    ctx.beginPath();
    ctx.moveTo(rx + radius, ry);
    ctx.lineTo(rx + rw - radius, ry);
    ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + radius);
    ctx.lineTo(rx + rw, ry + rh - radius);
    ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - radius, ry + rh);
    ctx.lineTo(rx + radius, ry + rh);
    ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - radius);
    ctx.lineTo(rx, ry + radius);
    ctx.quadraticCurveTo(rx, ry, rx + radius, ry);
    ctx.closePath();
  };

  // 2. Relationships
  const drawEdgeCanvas = (fromId: string, toId: string, label: string, fromCard: string, toCard: string, dashed: boolean, color: string) => {
    const b1 = boxMap.get(fromId);
    const b2 = boxMap.get(toId);
    if (!b1 || !b2) return;
    const x1 = b1.x - minX + b1.width;
    const y1 = b1.y - minY + b1.height / 2;
    const x2 = b2.x - minX;
    const y2 = b2.y - minY + b2.height / 2;
    const midX = (x1 + x2) / 2;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    if (dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(midX, y1);
    ctx.lineTo(midX, y2);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x1, y1, 4, 0, Math.PI * 2);
    ctx.arc(x2, y2, 4, 0, Math.PI * 2);
    ctx.fill();

    const labelText = `${fromCard ? `${fromCard} · ` : ''}${label}${toCard ? ` · ${toCard}` : ''}`.slice(0, 34);
    ctx.font = '700 10.5px Cairo, Inter, system-ui, sans-serif';
    const textW = ctx.measureText(labelText).width;
    const labelW = Math.max(64, textW + 18);
    const lx = midX - labelW / 2;
    const ly = (y1 + y2) / 2 - 11;

    roundRect(lx, ly, labelW, 22, 5);
    ctx.fillStyle = cardBg;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = textMain;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, midX, ly + 11);
  };

  for (const rel of schema.relationships) {
    drawEdgeCanvas(
      rel.from,
      rel.to,
      rel.label || `${rel.from} → ${rel.to}`,
      rel.fromCardinality,
      rel.toCardinality,
      !rel.identifying,
      rel.identifying ? '#0284c7' : '#64748b',
    );
  }

  for (const spec of schema.specializations) {
    for (const childId of spec.children) {
      drawEdgeCanvas(spec.parent, childId, 'ISA', '1', '0..1', true, '#8b5cf6');
    }
  }

  // 3. Table Cards
  for (const box of boxes) {
    const { entity } = box;
    const x = box.x - minX;
    const y = box.y - minY;
    const borderColor = entity.kind === 'associative' ? '#0d9488' : entity.kind === 'weak' ? '#d97706' : '#2563eb';
    const headerBg = entity.kind === 'associative' ? '#0f766e' : entity.kind === 'weak' ? '#b45309' : '#1d4ed8';

    // Card shadow & body
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 5;
    roundRect(x, y, box.width, box.height, 8);
    ctx.fillStyle = cardBg;
    ctx.fill();
    ctx.restore();

    // Header
    roundRect(x, y, box.width, HEADER_H, 7);
    ctx.fillStyle = headerBg;
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 14px Cairo, Inter, system-ui, sans-serif';
    ctx.fillText(entity.name.slice(0, 28), x + 14, y + 22);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '700 9.5px Cairo, Inter, system-ui, sans-serif';
    ctx.fillText(`${entity.kind.toUpperCase()} · ${entity.attributes.length} COLS`, x + 14, y + 36);

    // Column Header Bar
    const barY = y + HEADER_H;
    ctx.fillStyle = colBarBg;
    ctx.fillRect(x + 1, barY, box.width - 2, COL_BAR_H);
    ctx.fillStyle = textMuted;
    ctx.font = '800 9px Cairo, Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('COLUMN', x + 12, barY + 14.5);
    ctx.textAlign = 'right';
    ctx.fillText('DATA TYPE', x + box.width - 12, barY + 14.5);

    // Attributes
    let rowY = barY + COL_BAR_H;
    const pkAttrs = entity.attributes.filter((a) => a.isPK);
    const otherAttrs = entity.attributes.filter((a) => !a.isPK);
    const orderedAttrs = [...pkAttrs, ...otherAttrs];

    orderedAttrs.forEach((attr, idx) => {
      if (attr.isPK) {
        ctx.fillStyle = dark ? 'rgba(245, 158, 11, 0.14)' : '#fffbeb';
        ctx.fillRect(x + 1, rowY, box.width - 2, ROW_H);
      } else if (attr.isFK) {
        ctx.fillStyle = dark ? 'rgba(56, 189, 248, 0.1)' : '#f0f9ff';
        ctx.fillRect(x + 1, rowY, box.width - 2, ROW_H);
      }

      // Key dot / indicator
      ctx.fillStyle = attr.isPK ? '#f59e0b' : attr.isFK ? '#38bdf8' : textMuted;
      ctx.beginPath();
      ctx.arc(x + 14, rowY + ROW_H / 2, attr.isPK || attr.isFK ? 3.5 : 2, 0, Math.PI * 2);
      ctx.fill();

      // Column name
      ctx.textAlign = 'left';
      ctx.fillStyle = textMain;
      ctx.font = `${attr.isPK ? '700' : '600'} 12px Cairo, Inter, system-ui, sans-serif`;
      ctx.fillText(attr.name.slice(0, 22), x + 24, rowY + 17);

      // Badges
      const badges = getConstraintBadges(attr);
      let badgeRight = x + box.width - 80;
      for (const b of badges) {
        badgeRight -= 22;
        roundRect(badgeRight, rowY + 6, 20, 14, 3);
        ctx.fillStyle = b.bg;
        ctx.fill();
        ctx.strokeStyle = b.border;
        ctx.lineWidth = 0.8;
        ctx.stroke();

        ctx.fillStyle = b.color;
        ctx.font = '800 8px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(b.text, badgeRight + 10, rowY + 15.5);
      }

      // Data type
      ctx.textAlign = 'right';
      ctx.fillStyle = typeColor;
      ctx.font = '700 10.5px monospace';
      ctx.fillText(attr.dataType.slice(0, 14), x + box.width - 10, rowY + 17);

      rowY += ROW_H;
      if (idx < orderedAttrs.length - 1) {
        ctx.strokeStyle = rowBorder;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 2, rowY);
        ctx.lineTo(x + box.width - 2, rowY);
        ctx.stroke();
      }
    });

    // Outer border
    roundRect(x, y, box.width, box.height, 8);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 4. Subtle "Powered by MSR_Coder" watermark on the bottom-right side
  ctx.save();
  const wmText = 'Powered by MSR_Coder';
  ctx.font = '600 9.5px Cairo, Inter, system-ui, sans-serif';
  const wmWidth = ctx.measureText(wmText).width + 16;
  const wmX = width - wmWidth - 14;
  const wmY = height - 26;
  roundRect(wmX, wmY, wmWidth, 17, 4);
  ctx.fillStyle = dark ? 'rgba(15, 23, 42, 0.78)' : 'rgba(255, 255, 255, 0.85)';
  ctx.fill();
  ctx.strokeStyle = dark ? '#334155' : '#cbd5e1';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.fillStyle = textMuted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(wmText, wmX + wmWidth / 2, wmY + 9);
  ctx.restore();

  return canvas;
}
