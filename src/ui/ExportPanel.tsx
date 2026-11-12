import { useEffect, useState } from 'react';
import { ArrowDownToLine, Check, CheckCircle2, FileCode2, FileImage, FileText, LoaderCircle, Lock, X } from 'lucide-react';
import type { SchemaModel } from '../model/types';
import { serializeProject } from '../model/io';
import { generateDBML, generateLaravelMigrations, generateMermaid, generatePrismaSchema } from '../exporters/code';
import { generateMySQLDDL, generatePostgreSQLDDL, generateSQLiteDDL } from '../exporters/ddl';
import { downloadBlob, safeFilename, type DiagramExportOptions, type DiagramExporter } from '../exporters/diagram';

interface Props {
  schema: SchemaModel;
  locale: 'en' | 'ar';
  onClose: () => void;
  diagramExporter: DiagramExporter | null;
  onBusyChange?: (busy: boolean) => void;
}

const COPY = {
  en: {
    title: 'Export Diagram & Code',
    subtitle: 'Download your diagram as an image, PDF, or database code.',
    diagram: 'Diagram Image & PDF',
    code: 'Database SQL & Code',
    png: 'PNG Image (.png)',
    svg: 'SVG Vector (.svg)',
    pdfA4: 'PDF Document · A4',
    pdfA3: 'PDF Document · A3',
    mysql: 'MySQL DDL (.sql)',
    postgres: 'PostgreSQL DDL (.sql)',
    sqlite: 'SQLite DDL (.sql)',
    laravel: 'Laravel Migrations (.php)',
    prisma: 'Prisma Schema (.prisma)',
    dbml: 'DBML (.dbml)',
    mermaid: 'Mermaid ER (.mmd)',
    json: 'ERDForge Project (.json)',
    close: 'Close',
    done: 'File exported and downloaded successfully!',
    failure: 'Export failed. Please try again.',
    noDiagram: 'Switch to the Diagram view first to export images or PDF.',
    stage1: '1. Processing diagram on server…',
    stage2: '2. Rendering tables and relationships…',
    stage3: '3. Saving file for download…',
    lockedNotice: 'Export in progress — cancellation is disabled until completion',
  },
  ar: {
    title: 'تصدير المخطط والأكواد',
    subtitle: 'حمّل المخطط كصورة أو ملف PDF أو صدّر كود قاعدة البيانات.',
    diagram: 'تصدير المخطط (صورة / PDF)',
    code: 'تصدير أكواد قاعدة البيانات (SQL / Code)',
    png: 'صورة PNG',
    svg: 'ملف SVG',
    pdfA4: 'ملف PDF · A4',
    pdfA3: 'ملف PDF · A3',
    mysql: 'كود MySQL (.sql)',
    postgres: 'كود PostgreSQL (.sql)',
    sqlite: 'كود SQLite (.sql)',
    laravel: 'ملفات Laravel Migration (.php)',
    prisma: 'مخطط Prisma (.prisma)',
    dbml: 'كود DBML (.dbml)',
    mermaid: 'كود Mermaid ER (.mmd)',
    json: 'مشروع ERDForge (.json)',
    close: 'إغلاق',
    done: 'تم تصدير وتحميل الملف بنجاح!',
    failure: 'تعذر التصدير. يرجى المحاولة مرة أخرى.',
    noDiagram: 'يرجى فتح شاشة المخطط أولاً لتصدير الصور أو PDF.',
    stage1: '١. معالجة وتجهيز المخطط على السيرفر…',
    stage2: '٢. رسم الجداول والروابط…',
    stage3: '٣. حفظ وتجهيز الملف للتحميل…',
    lockedNotice: 'جاري التصدير الآن — لا يمكن الإلغاء أو الإغلاق لحين اكتمال العملية',
  },
} as const;

type TextFormat = 'mysql' | 'postgres' | 'sqlite' | 'laravel' | 'prisma' | 'dbml' | 'mermaid' | 'json';

export default function ExportPanel({ schema, locale, onClose, diagramExporter, onBusyChange }: Props) {
  const labels = COPY[locale];
  const [busy, setBusy] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressStage, setProgressStage] = useState<1 | 2 | 3>(1);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const name = safeFilename(schema.name);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => {
      onBusyChange?.(false);
    };
  }, [busy, onBusyChange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (busy) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onClose]);

  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy]);

  const saveText = (text: string, extension: string, mimeType = 'text/plain;charset=utf-8') => {
    downloadBlob(new Blob([text], { type: mimeType }), `${name}.${extension}`);
  };

  const exportText = (format: TextFormat): void => {
    if (format === 'mysql') saveText(generateMySQLDDL(schema), 'mysql.sql', 'application/sql;charset=utf-8');
    else if (format === 'postgres') saveText(generatePostgreSQLDDL(schema), 'postgresql.sql', 'application/sql;charset=utf-8');
    else if (format === 'sqlite') saveText(generateSQLiteDDL(schema), 'sqlite.sql', 'application/sql;charset=utf-8');
    else if (format === 'laravel') saveText(generateLaravelMigrations(schema), 'migration.php', 'text/x-php;charset=utf-8');
    else if (format === 'prisma') saveText(generatePrismaSchema(schema), 'schema.prisma', 'text/plain;charset=utf-8');
    else if (format === 'dbml') saveText(generateDBML(schema), 'schema.dbml', 'text/plain;charset=utf-8');
    else if (format === 'mermaid') saveText(generateMermaid(schema), 'schema.mmd', 'text/plain;charset=utf-8');
    else saveText(serializeProject(schema), 'erdforge.json', 'application/json;charset=utf-8');
  };

  const run = async (action: TextFormat | DiagramExportOptions) => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setIsError(false);
    setProgressPercent(20);
    setProgressStage(1);

    try {
      if (typeof action === 'string') {
        await new Promise((r) => window.setTimeout(r, 180));
        setProgressPercent(65);
        setProgressStage(2);
        await new Promise((r) => window.setTimeout(r, 180));
        exportText(action);
        setProgressPercent(100);
        setProgressStage(3);
      } else {
        if (!diagramExporter) throw new Error(labels.noDiagram);
        await diagramExporter(action, schema.name, `${name}-diagram`, (pct, stg) => {
          setProgressPercent(pct);
          setProgressStage(stg);
        });
        setProgressPercent(100);
        setProgressStage(3);
        await new Promise((r) => window.setTimeout(r, 160));
      }
      setMessage(labels.done);
      setIsError(false);
    } catch (err) {
      setMessage(err instanceof Error && err.message ? err.message : labels.failure);
      setIsError(true);
    } finally {
      setBusy(false);
    }
  };

  const actionButton = (key: keyof typeof labels, action: TextFormat | DiagramExportOptions, Icon = FileCode2) => (
    <button key={key} className="export-option-card" type="button" disabled={busy} onClick={() => void run(action)}>
      <span className="export-option-icon"><Icon size={16} /></span>
      <span className="export-option-label">{labels[key]}</span>
      <ArrowDownToLine size={14} className="export-download-mark" />
    </button>
  );

  return (
    <div
      className="privacy-backdrop export-backdrop"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <section className="privacy-dialog export-dialog-card" role="dialog" aria-modal="true" aria-labelledby="export-title" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
        <header className="settings-dialog-header">
          <div className="settings-title-group">
            <span className="settings-badge-icon"><ArrowDownToLine size={18} /></span>
            <div>
              <span className="eyebrow">ERDFORGE · EXPORT</span>
              <h3 id="export-title">{labels.title}</h3>
              <p className="export-subtitle">{labels.subtitle}</p>
            </div>
          </div>
          {!busy ? (
            <button className="icon-button dialog-close-btn" type="button" aria-label={labels.close} onClick={onClose}>
              <X size={16} />
            </button>
          ) : (
            <span className="operation-lock-pill" title={labels.lockedNotice}>
              <Lock size={13} />
              <span>{locale === 'ar' ? 'قيد التنفيذ' : 'Busy'}</span>
            </span>
          )}
        </header>

        {/* ANIMATED MULTI-STEP EXPORT PROGRESS BAR (NON-CANCELABLE) */}
        {busy && (
          <div className="ai-progress-card export-progress-box" role="status" aria-live="polite">
            <div className="ai-progress-top">
              <span className="ai-progress-title">
                <LoaderCircle size={16} className="spinning" />
                <strong>{progressStage === 1 ? labels.stage1 : progressStage === 2 ? labels.stage2 : labels.stage3}</strong>
              </span>
              <span className="ai-progress-pct">{progressPercent}%</span>
            </div>
            <div className="ai-progress-bar-track">
              <div className="ai-progress-bar-fill" style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="ai-progress-steps">
              <span className={`ai-step-item ${progressStage >= 1 ? 'is-done' : ''}`}>
                <CheckCircle2 size={12} /> {locale === 'ar' ? 'معالجة السيرفر' : 'Server Process'}
              </span>
              <span className={`ai-step-item ${progressStage >= 2 ? 'is-done' : ''}`}>
                <CheckCircle2 size={12} /> {locale === 'ar' ? 'رسم الجداول' : 'Render Tables'}
              </span>
              <span className={`ai-step-item ${progressStage >= 3 ? 'is-done' : ''}`}>
                <CheckCircle2 size={12} /> {locale === 'ar' ? 'حفظ الملف' : 'Save File'}
              </span>
            </div>
            <div className="operation-locked-banner">
              <Lock size={12} />
              <span>{labels.lockedNotice}</span>
            </div>
          </div>
        )}

        {message && !busy && (
          <div className={isError ? 'ai-error' : 'ai-info'} role={isError ? 'alert' : 'status'}>
            <Check size={15} />
            <span>{message}</span>
          </div>
        )}

        <div className="export-groups">
          <section className="export-group" aria-label={labels.diagram}>
            <h4><FileImage size={14} /> {labels.diagram}</h4>
            <div className="export-options-grid">
              {actionButton('png', { kind: 'png', scale: 2 }, FileImage)}
              {actionButton('pdfA4', { kind: 'pdf', page: 'a4' }, FileText)}
              {actionButton('pdfA3', { kind: 'pdf', page: 'a3' }, FileText)}
              {actionButton('svg', { kind: 'svg' }, FileImage)}
            </div>
          </section>

          <section className="export-group" aria-label={labels.code}>
            <h4><FileCode2 size={14} /> {labels.code}</h4>
            <div className="export-options-grid">
              {actionButton('mysql', 'mysql')}
              {actionButton('postgres', 'postgres')}
              {actionButton('sqlite', 'sqlite')}
              {actionButton('laravel', 'laravel')}
              {actionButton('prisma', 'prisma')}
              {actionButton('dbml', 'dbml')}
              {actionButton('mermaid', 'mermaid')}
              {actionButton('json', 'json')}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
