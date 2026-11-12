import { useMemo, useState } from 'react';
import { Activity, Check, CircleAlert, CircleHelp, LoaderCircle, ShieldCheck, Sparkles, Wrench, X } from 'lucide-react';
import { requestReviewExplanation } from '../ai/reviewExplanation';
import { useSchemaStore } from '../store/store';
import { buildReviewFixPreview, type ReviewFixPreview } from '../model/fixes';
import { analyzeSchema, type NormalFormAssessment, type ReviewSeverity, type SchemaReviewIssue } from '../model/rules';
import type { CanvasLocale } from './EntityNode';

interface Props {
  locale: CanvasLocale;
  onClose: () => void;
}

const COPY = {
  en: {
    title: 'Schema Review', subtitle: 'Deterministic findings · no schema changes are made automatically', close: 'Close review', all: 'All', error: 'Errors', warning: 'Warnings', info: 'Risks & notes', findings: 'Findings', clean: 'No findings for the current rules.', first: '1NF · Atomic values', second: '2NF · Full dependency', third: '3NF · Non-transitive dependency', pass: 'No structural concern detected', risk: 'Review risk', unknown: 'Needs dependency data', previewFix: 'Preview fix', fixTitle: 'Review proposed fix', before: 'Before', after: 'After', cancel: 'Cancel', apply: 'Apply fix', aiExplain: 'Explain with AI', aiTitle: 'Share this finding with AI?', aiBody: 'Only the selected rule, finding text, and optional entity/attribute names will be sent. Your schema, source text, and other findings are not included. No schema changes can be made by this request.', send: 'Send selected finding', loading: 'Connecting…', aiLabel: 'Optional explanation', genericError: 'The request could not be completed.', fixError: 'The fix could not be applied.', high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence', safe: 'Deterministic fix available', aiUnavailable: 'AI explanation is optional. Local review works without an API key.',
  },
  ar: {
    title: 'مراجعة المخطط', subtitle: 'نتائج حتمية · لا تُجرى أي تغييرات تلقائياً', close: 'إغلاق المراجعة', all: 'الكل', error: 'أخطاء', warning: 'تحذيرات', info: 'مخاطر وملاحظات', findings: 'النتائج', clean: 'لا توجد نتائج وفق القواعد الحالية.', first: '1NF · القيم الذرية', second: '2NF · الاعتماد الكامل', third: '3NF · الاعتماد غير الانتقالي', pass: 'لم تُكتشف مشكلة بنيوية', risk: 'مخاطر للمراجعة', unknown: 'تحتاج إلى بيانات الاعتمادية', previewFix: 'معاينة الإصلاح', fixTitle: 'مراجعة الإصلاح المقترح', before: 'قبل', after: 'بعد', cancel: 'إلغاء', apply: 'تطبيق الإصلاح', aiExplain: 'اشرح بالمساعد الذكي', aiTitle: 'مشاركة هذه النتيجة مع المساعد الذكي؟', aiBody: 'سيُرسل فقط اسم القاعدة ونص النتيجة وأسماء الكيان/السمة اختيارياً. لن يُرسل المخطط أو النص المصدر أو النتائج الأخرى. لا يستطيع هذا الطلب تغيير المخطط.', send: 'إرسال النتيجة المحددة', loading: 'جاري الاتصال…', aiLabel: 'شرح إضافي', genericError: 'تعذر إكمال الطلب.', fixError: 'تعذر تطبيق الإصلاح.', high: 'ثقة عالية', medium: 'ثقة متوسطة', low: 'ثقة منخفضة', safe: 'يتوفر إصلاح حتمي', aiUnavailable: 'الشرح بالذكاء الاصطناعي اختياري. تعمل المراجعة المحلية دون مفتاح API.',
  },
} as const;

type Filter = 'all' | ReviewSeverity;

function NormalFormCard({ title, assessment }: { title: string; assessment: NormalFormAssessment }) {
  const Icon = assessment.status === 'pass' ? ShieldCheck : assessment.status === 'risk' ? CircleAlert : CircleHelp;
  return <article className={`normal-form-card normal-${assessment.status}`}><div className="normal-form-heading"><Icon size={14} /><strong>{title}</strong><span>{assessment.status}</span></div><p>{assessment.summary}</p>{assessment.evidence.length > 0 && <ul>{assessment.evidence.map((value) => <li key={value}>{value}</li>)}</ul>}</article>;
}

function IssueCard({ issue, locale, aiText, onFix, onExplain }: {
  issue: SchemaReviewIssue;
  locale: CanvasLocale;
  aiText?: string | undefined;
  onFix: (issue: SchemaReviewIssue) => void;
  onExplain: (issue: SchemaReviewIssue) => void;
}) {
  const labels = COPY[locale];
  const confidence = issue.confidence === 'high' ? labels.high : issue.confidence === 'medium' ? labels.medium : labels.low;
  return <article className={`review-issue review-${issue.severity}`} data-testid={`review-${issue.ruleId}`}>
    <div className="review-issue-top"><span className={`review-severity ${issue.severity}`}>{issue.severity === 'error' ? <CircleAlert size={12} /> : issue.severity === 'warning' ? <Activity size={12} /> : <CircleHelp size={12} />}{labels[issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info']}</span><span className="review-confidence">{confidence}</span></div>
    <h3>{issue.title}</h3><p>{issue.explanation}</p>
    {issue.fix && <button className="review-action-button" type="button" onClick={() => onFix(issue)}><Wrench size={12} />{labels.previewFix}</button>}
    <button className="review-ai-button" type="button" onClick={() => onExplain(issue)}><Sparkles size={12} />{labels.aiExplain}</button>
    {aiText && <div className="review-ai-answer"><strong>{labels.aiLabel}</strong><p>{aiText}</p></div>}
  </article>;
}

export default function SchemaReviewPanel({ locale, onClose }: Props) {
  const schema = useSchemaStore((state) => state.schema);
  const report = useMemo(() => analyzeSchema(schema), [schema]);
  const [filter, setFilter] = useState<Filter>('all');
  const [preview, setPreview] = useState<ReviewFixPreview | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [consentIssue, setConsentIssue] = useState<SchemaReviewIssue | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiAnswers, setAiAnswers] = useState<Record<string, string>>({});
  const labels = COPY[locale];
  const visibleIssues = report.issues.filter((issue) => filter === 'all' || issue.severity === filter);

  const beginFix = (issue: SchemaReviewIssue) => {
    if (!issue.fix) return;
    const value = buildReviewFixPreview(schema, issue.fix);
    if (!value) { setFixError(labels.fixError); return; }
    setFixError(null);
    setPreview(value);
  };

  const applyFix = () => {
    if (!preview) return;
    const before = useSchemaStore.getState().schema;
    useSchemaStore.getState().applyOperations(preview.operations);
    const current = useSchemaStore.getState();
    if (current.schema === before) {
      setFixError(current.lastError || labels.fixError);
      return;
    }
    setPreview(null);
    setFixError(null);
  };

  const requestExplanation = async () => {
    if (!consentIssue || aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    const entityName = consentIssue.entityId ? schema.entities.find((entity) => entity.id === consentIssue.entityId)?.name : undefined;
    const entity = consentIssue.entityId ? schema.entities.find((item) => item.id === consentIssue.entityId) : undefined;
    const attributeName = entity && consentIssue.attributeId ? entity.attributes.find((attribute) => attribute.id === consentIssue.attributeId)?.name : undefined;
    try {
      const explanation = await requestReviewExplanation({
        privacyAcknowledged: true,
        finding: {
          ruleId: consentIssue.ruleId,
          title: consentIssue.title,
          explanation: consentIssue.explanation,
          ...(entityName ? { entityName } : {}),
          ...(attributeName ? { attributeName } : {}),
        },
      });
      setAiAnswers((current) => ({ ...current, [consentIssue.id]: explanation }));
      setConsentIssue(null);
    } catch (error) {
      const msg = error instanceof Error ? error.message.replace(/gemini[\s-]*[0-9.]*[a-z-]*/gi, 'AI') : labels.genericError;
      setAiError(msg);
    } finally {
      setAiBusy(false);
    }
  };

  return <div className="privacy-backdrop review-backdrop" onMouseDown={(event) => { if (!aiBusy && event.target === event.currentTarget) onClose(); }}>
    <section className="review-dialog" role="dialog" aria-modal="true" aria-labelledby="schema-review-title" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="review-dialog-header"><div><span className="eyebrow">ERDFORGE · VALIDATION</span><h2 id="schema-review-title">{labels.title}</h2><p>{labels.subtitle}</p></div>{!aiBusy && <button type="button" className="icon-button" aria-label={labels.close} onClick={onClose}><X size={17} /></button>}</header>
      <div className="normal-form-grid"><NormalFormCard title={labels.first} assessment={report.normalForms.first} /><NormalFormCard title={labels.second} assessment={report.normalForms.second} /><NormalFormCard title={labels.third} assessment={report.normalForms.third} /></div>
      <div className="review-findings-heading"><div><h3>{labels.findings}</h3><span>{report.issues.length}</span></div><div className="review-filters" role="group" aria-label={labels.findings}>{(['all', 'error', 'warning', 'info'] as const).map((value) => <button key={value} className={filter === value ? 'is-selected' : ''} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{labels[value === 'all' ? 'all' : value === 'error' ? 'error' : value === 'warning' ? 'warning' : 'info']}</button>)}</div></div>
      <div className="review-findings-list" aria-live="polite">{visibleIssues.length === 0 ? <div className="review-empty"><ShieldCheck size={18} /><span>{labels.clean}</span></div> : visibleIssues.map((issue) => <IssueCard key={issue.id} issue={issue} locale={locale} aiText={aiAnswers[issue.id]} onFix={beginFix} onExplain={(item) => { setAiError(null); setConsentIssue(item); }} />)}</div>
    </section>

    {preview && <div className="privacy-backdrop review-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}><section className="privacy-dialog review-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="review-fix-title" dir={locale === 'ar' ? 'rtl' : 'ltr'}><button type="button" className="icon-button privacy-close" aria-label={labels.cancel} onClick={() => setPreview(null)}><X size={16} /></button><span className="privacy-warning-icon"><Wrench size={16} /></span><span className="eyebrow">{labels.safe}</span><h3 id="review-fix-title">{preview.title}</h3><p>{preview.summary}</p><div className="fix-preview-columns"><div><strong>{labels.before}</strong><ul>{preview.before.map((line) => <li key={line}>{line}</li>)}</ul></div><div><strong>{labels.after}</strong><ul>{preview.after.map((line) => <li key={line}>{line}</li>)}</ul></div></div>{fixError && <div className="ai-error" role="alert">{fixError}</div>}<div className="privacy-dialog-actions"><button type="button" className="quiet-button" onClick={() => setPreview(null)}>{labels.cancel}</button><button type="button" className="primary-button" onClick={applyFix}><Check size={13} />{labels.apply}</button></div></section></div>}

    {consentIssue && <div className="privacy-backdrop review-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !aiBusy) setConsentIssue(null); }}><section className="privacy-dialog review-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-review-title" dir={locale === 'ar' ? 'rtl' : 'ltr'}>{!aiBusy && <button type="button" className="icon-button privacy-close" aria-label={labels.cancel} onClick={() => setConsentIssue(null)}><X size={16} /></button>}<span className="privacy-warning-icon"><Sparkles size={17} /></span><span className="eyebrow">AI · OPTIONAL</span><h3 id="ai-review-title">{labels.aiTitle}</h3><p>{labels.aiBody}</p><blockquote className="review-consent-quote">{consentIssue.title} — {consentIssue.explanation}</blockquote>{aiError && <div className="ai-error" role="alert">{aiError}</div>}<div className="privacy-dialog-actions">{!aiBusy && <button type="button" className="quiet-button" onClick={() => setConsentIssue(null)}>{labels.cancel}</button>}<button type="button" className="primary-button" disabled={aiBusy} onClick={() => void requestExplanation()}>{aiBusy ? <LoaderCircle size={13} className="spinning" /> : <Sparkles size={13} />}{aiBusy ? labels.loading : labels.send}</button></div></section></div>}
  </div>;
}
