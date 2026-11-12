import {
  generateServerVectorSvg,
  renderDiagramToSafeCanvas,
  type DiagramRenderPayload,
} from './vectorDiagram';

export type DiagramExportOptions =
  | { kind: 'png'; scale: 2 | 4 }
  | { kind: 'svg' }
  | { kind: 'pdf'; page: 'a4' | 'a3' };

export type DiagramExportProgressCallback = (percent: number, stage: 1 | 2 | 3) => void;

export type DiagramExporter = (
  options: DiagramExportOptions,
  title: string,
  filename: string,
  onProgress?: DiagramExportProgressCallback,
) => Promise<void>;

function filterCanvasElements(node: HTMLElement): boolean {
  const excluded = ['react-flow__controls', 'react-flow__minimap', 'react-flow__attribution', 'react-flow__panel', 'alignment-guide'];
  return !excluded.some((className) => node.classList?.contains(className));
}

async function diagramPng(element: HTMLElement, scale = 2): Promise<string> {
  const { toPng } = await import('html-to-image');
  return toPng(element, {
    pixelRatio: scale,
    backgroundColor: getComputedStyle(element).backgroundColor || '#f7f8fa',
    filter: filterCanvasElements,
    cacheBust: false,
  });
}

/**
 * Legacy DOM-based export helper retained for unit test compatibility (tests/exporters.test.ts).
 */
export async function createDiagramExportBlob(
  element: HTMLElement,
  options: DiagramExportOptions,
  title: string,
  date = new Date(),
): Promise<Blob> {
  if (options.kind === 'svg') {
    const { toSvg } = await import('html-to-image');
    const dataUrl = await toSvg(element, {
      backgroundColor: getComputedStyle(element).backgroundColor || '#f7f8fa',
      filter: filterCanvasElements,
      cacheBust: false,
    });
    const response = await fetch(dataUrl);
    return response.blob();
  }
  const image = await diagramPng(element, options.kind === 'png' ? options.scale : 2);
  if (options.kind === 'png') {
    const response = await fetch(image);
    return response.blob();
  }
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: options.page === 'a3' ? 'a3' : 'a4', compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = options.page === 'a3' ? 13 : 11;
  const headerHeight = 20;
  const footerHeight = 13;
  const availableWidth = pageWidth - margin * 2;
  const availableHeight = pageHeight - margin * 2 - headerHeight - footerHeight;
  const properties = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const imageElement = new Image();
    imageElement.onload = () => resolve({ width: imageElement.naturalWidth, height: imageElement.naturalHeight });
    imageElement.onerror = reject;
    imageElement.src = image;
  });
  const scale = Math.min(availableWidth / properties.width, availableHeight / properties.height);
  const imageWidth = properties.width * scale;
  const imageHeight = properties.height * scale;
  const imageX = (pageWidth - imageWidth) / 2;
  const imageY = margin + headerHeight + (availableHeight - imageHeight) / 2;
  pdf.setFillColor(248, 250, 251);
  pdf.rect(0, 0, pageWidth, pageHeight, 'F');
  pdf.setTextColor(28, 42, 52);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(options.page === 'a3' ? 18 : 15);
  pdf.text(title || 'ERDForge diagram', margin, margin + 7);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(93, 108, 118);
  pdf.text(`ERDForge · ${date.toISOString().slice(0, 10)}`, margin, margin + 13);
  pdf.addImage(image, 'PNG', imageX, imageY, imageWidth, imageHeight, undefined, 'FAST');
  pdf.setDrawColor(204, 214, 220);
  pdf.line(margin, pageHeight - margin - footerHeight + 1, pageWidth - margin, pageHeight - margin - footerHeight + 1);
  pdf.setFontSize(7);
  pdf.text('Powered by MSR_Coder', margin, pageHeight - margin - 3);
  return pdf.output('blob');
}

/**
 * Server-Assisted + Lightweight 2D Canvas Exporter for production mobile & desktop browsers.
 * Never clones DOM via html-to-image and never exceeds mobile GPU memory limits (zero Aw Snap crashes).
 */
export async function createServerAndCanvasExportBlob(
  payload: DiagramRenderPayload,
  options: DiagramExportOptions,
  title: string,
  onProgress?: DiagramExportProgressCallback,
): Promise<Blob> {
  onProgress?.(25, 1);

  // 1. Offload vector layout & SVG synthesis to Cloudflare Worker /api/export first
  let serverSvg: { svg: string; width: number; height: number } | null = null;
  try {
    const resp = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { svg?: string; width?: number; height?: number };
      if (data.svg && data.width && data.height) {
        serverSvg = { svg: data.svg, width: data.width, height: data.height };
      }
    }
  } catch {
    // Fallback to local generator if offline
  }

  if (options.kind === 'svg') {
    onProgress?.(75, 2);
    const rendered = serverSvg ?? generateServerVectorSvg(payload);
    onProgress?.(95, 3);
    return new Blob([rendered.svg], { type: 'image/svg+xml;charset=utf-8' });
  }

  onProgress?.(55, 2);
  // Yield to browser UI thread so progress bar updates smoothly
  await new Promise((r) => window.setTimeout(r, 60));

  const canvas = await renderDiagramToSafeCanvas(payload, options.kind === 'png' ? options.scale : 2);
  onProgress?.(85, 3);

  if (options.kind === 'png') {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas PNG export failed.'));
      }, 'image/png');
    });
  }

  const { jsPDF } = await import('jspdf');
  const isPortraitDiagram = canvas.height > canvas.width * 1.08;
  const orientation = isPortraitDiagram ? 'portrait' : 'landscape';

  const pdf = new jsPDF({
    orientation,
    unit: 'mm',
    format: options.page === 'a3' ? 'a3' : 'a4',
    compress: true,
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = options.page === 'a3' ? 10 : 8;
  const headerHeight = 14;
  const availableWidth = pageWidth - margin * 2;
  const availableHeight = pageHeight - margin * 2 - headerHeight;

  const scale = Math.min(availableWidth / canvas.width, availableHeight / canvas.height);
  const imageWidth = canvas.width * scale;
  const imageHeight = canvas.height * scale;
  const imageX = (pageWidth - imageWidth) / 2;
  const imageY = margin + headerHeight + (availableHeight - imageHeight) / 2;

  if (payload.dark) {
    pdf.setFillColor(11, 17, 32);
    pdf.rect(0, 0, pageWidth, pageHeight, 'F');
    pdf.setTextColor(241, 245, 249);
  } else {
    pdf.setFillColor(241, 245, 249);
    pdf.rect(0, 0, pageWidth, pageHeight, 'F');
    pdf.setTextColor(15, 23, 42);
  }

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(options.page === 'a3' ? 16 : 13);
  pdf.text(title || 'ERDForge Diagram', margin, margin + 6);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(100, 116, 139);
  pdf.text(`ERDForge · ${new Date().toISOString().slice(0, 10)}`, margin, margin + 11);

  // Note: "Powered by MSR_Coder" is already rendered once inside the diagram canvas corner,
  // so we do NOT duplicate it in the PDF footer margin.
  const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.95);
  pdf.addImage(jpegDataUrl, 'JPEG', imageX, imageY, imageWidth, imageHeight, undefined, 'FAST');
  onProgress?.(98, 3);
  return pdf.output('blob');
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_500);
}

export function safeFilename(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'erdforge-schema';
}
