import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  Check,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  FolderKanban,
  KeyRound,
  Languages,
  Layers,
  Link2,
  LoaderCircle,
  Lock,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Sun,
  Table2,
  Trash2,
  Upload,
  Wand2,
  Workflow,
  X,
} from 'lucide-react';
import { APP_COPY, type AppCopy, type CanvasLocale } from './i18n';
import DiagramCanvas, { clearCanvasPositions } from './ui/DiagramCanvas';
import { assertSchemaModel } from './model/schema';
import type { Entity, Relationship, SchemaModel } from './model/types';
import { analyzeSchema } from './model/rules';
import { generateDDL, type SQLDialect } from './exporters/ddl';
import { downloadBlob, safeFilename, type DiagramExporter } from './exporters/diagram';
import type { ParserFormat, ParseResult } from './parsers/types';
import { useSchemaStore } from './store/store';
import {
  DEFAULT_CLIENT_GEMINI_MODEL,
  getStoredAIConfig,
  saveStoredAIConfig,
} from './ai/client';

const AIProposalPanel = lazy(() => import('./ui/AIProposalPanel'));
const ManualInspector = lazy(() => import('./ui/ManualInspector'));
const RelationshipDialog = lazy(() => import('./ui/RelationshipDialog'));
const SchemaReviewPanel = lazy(() => import('./ui/SchemaReviewPanel'));
const ExportPanel = lazy(() => import('./ui/ExportPanel'));

const FORMAT_OPTIONS: Array<{ value: ParserFormat; en: string; ar: string }> = [
  { value: 'auto', en: 'Auto-detect', ar: 'تلقائي (نص / SQL / JSON)' },
  { value: 'sql', en: 'SQL DDL', ar: 'كود SQL' },
  { value: 'json', en: 'JSON / OpenAPI', ar: 'كود JSON' },
  { value: 'text', en: 'Text / Markdown', ar: 'نص وصفي / هيكل' },
  { value: 'dbml', en: 'DBML', ar: 'كود DBML' },
  { value: 'mermaid', en: 'Mermaid ER', ar: 'Mermaid ER' },
  { value: 'php', en: 'PHP / Laravel', ar: 'PHP / Laravel' },
  { value: 'erdforge', en: 'ERDForge JSON', ar: 'ERDForge JSON' },
];

function detectInitialTheme(): boolean {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('erdforge-theme');
      if (saved === 'dark') return true;
      if (saved === 'light') return false;
    }
  } catch {
    // Ignore storage error
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return true;
}

function detectInitialLocale(): CanvasLocale {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('erdforge-locale');
      if (saved === 'ar' || saved === 'en') return saved;
    }
  } catch {
    // Ignore storage error
  }
  if (typeof navigator !== 'undefined') {
    const lang = (navigator.language || navigator.languages?.[0] || '').toLowerCase();
    if (lang.startsWith('en')) return 'en';
    if (lang.startsWith('ar')) return 'ar';
  }
  return 'ar';
}

function readProjectSource(projectId: string): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(`erdforge-project-source:${projectId}`) ?? '';
  } catch {
    return '';
  }
}

function writeProjectSource(projectId: string, text: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      if (text.trim()) localStorage.setItem(`erdforge-project-source:${projectId}`, text);
      else localStorage.removeItem(`erdforge-project-source:${projectId}`);
    }
  } catch {
    // Ignore
  }
}

function readCustomModels(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem('erdforge-custom-models');
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string' && m.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function writeCustomModels(models: string[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('erdforge-custom-models', JSON.stringify(models));
    }
  } catch {
    // Ignore
  }
}

function createEntity(locale: CanvasLocale): Entity {
  return {
    id: `entity-${crypto.randomUUID()}`,
    name: locale === 'ar' ? 'جدول_جديد' : 'new_table',
    kind: 'strong',
    attributes: [
      {
        id: `attribute-${crypto.randomUUID()}`,
        name: 'id',
        dataType: 'BIGINT',
        isPK: true,
        isFK: false,
        isUnique: true,
        isNullable: false,
        kind: 'simple',
        notes: '',
      },
    ],
    notes: '',
  };
}

function mergeSchemas(current: SchemaModel, incoming: SchemaModel): SchemaModel {
  const merged = structuredClone(current);
  const existingEntityIds = new Set(merged.entities.map((e) => e.id));
  for (const ent of incoming.entities) {
    if (!existingEntityIds.has(ent.id)) {
      merged.entities.push(structuredClone(ent));
      existingEntityIds.add(ent.id);
    } else {
      const target = merged.entities.find((e) => e.id === ent.id)!;
      const attrNames = new Set(target.attributes.map((a) => a.name.toLowerCase()));
      for (const attr of ent.attributes) {
        if (!attrNames.has(attr.name.toLowerCase())) {
          target.attributes.push(structuredClone(attr));
        }
      }
    }
  }
  for (const rel of incoming.relationships) {
    const exists = merged.relationships.some(
      (r) => r.id === rel.id || (r.from === rel.from && r.to === rel.to && r.label === rel.label),
    );
    if (!exists && existingEntityIds.has(rel.from) && existingEntityIds.has(rel.to)) {
      merged.relationships.push(structuredClone(rel));
    }
  }
  for (const spec of incoming.specializations) {
    const existingSpec = merged.specializations.find((s) => s.parent === spec.parent);
    if (!existingSpec) {
      merged.specializations.push(structuredClone(spec));
    } else {
      for (const childId of spec.children) {
        if (!existingSpec.children.includes(childId)) existingSpec.children.push(childId);
      }
    }
  }
  return merged;
}

function StudioCodeEditor({
  value,
  onChange,
  placeholder,
  label,
  disabled = false,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  label: string;
  disabled?: boolean;
}) {
  const lineCount = useMemo(() => Math.max(1, value.split('\n').length), [value]);
  const gutterRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const syncScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  return (
    <div className="studio-code-editor" dir="ltr">
      <div ref={gutterRef} className="studio-code-gutter" aria-hidden="true">
        {Array.from({ length: Math.min(lineCount, 2000) }, (_, idx) => (
          <div key={idx + 1} className="studio-line-num">{idx + 1}</div>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        className="studio-code-textarea"
        aria-label={label}
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        onScroll={syncScroll}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

type StudioView = 'diagram' | 'editor' | 'projects';

export default function App() {
  const schema = useSchemaStore((state) => state.schema);
  const projects = useSchemaStore((state) => state.projects);
  const activeProjectId = useSchemaStore((state) => state.activeProjectId);
  const initialize = useSchemaStore((state) => state.initialize);
  const newProject = useSchemaStore((state) => state.newProject);
  const switchProject = useSchemaStore((state) => state.switchProject);
  const removeProject = useSchemaStore((state) => state.removeProject);
  const renameProject = useSchemaStore((state) => state.renameProject);
  const replaceSchema = useSchemaStore((state) => state.replaceSchema);
  const applyOperations = useSchemaStore((state) => state.applyOperations);
  const undo = useSchemaStore((state) => state.undo);
  const redo = useSchemaStore((state) => state.redo);
  const canUndo = useSchemaStore((state) => state.past.length > 0);
  const canRedo = useSchemaStore((state) => state.future.length > 0);
  const toast = useSchemaStore((state) => state.toast);
  const clearToast = useSchemaStore((state) => state.clearToast);
  const lastError = useSchemaStore((state) => state.lastError);

  const [studioView, setStudioView] = useState<StudioView>('diagram');
  const [dark, setDark] = useState<boolean>(detectInitialTheme);
  const [locale, setLocale] = useState<CanvasLocale>(detectInitialLocale);
  const [format, setFormat] = useState<ParserFormat>('auto');
  const [dialect, setDialect] = useState<'auto' | 'mysql' | 'postgresql'>('auto');
  const [sqlTabDialect, setSqlTabDialect] = useState<SQLDialect>('mysql');
  const [activeTab, setActiveTab] = useState<'source' | 'sql' | 'model'>('source');

  const [source, setSource] = useState<string>(() => readProjectSource(useSchemaStore.getState().activeProjectId));
  const [sqlCode, setSqlCode] = useState<string>(() => generateDDL(useSchemaStore.getState().schema, 'mysql'));
  const [sqlDirty, setSqlDirty] = useState(false);
  const [modelCode, setModelCode] = useState<string>(() => JSON.stringify(useSchemaStore.getState().schema, null, 2));
  const [modelCodeDirty, setModelCodeDirty] = useState(false);

  const [selection, setSelection] = useState<{ type: 'entity' | 'relationship'; id: string } | null>(null);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [sourceMessage, setSourceMessage] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState(false);
  const [parseBusy, setParseBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [newProjectNameInput, setNewProjectNameInput] = useState('');
  const [renameProjectInput, setRenameProjectInput] = useState('');
  const [relationshipDraft, setRelationshipDraft] = useState<{ from?: string; to?: string } | null>(null);

  // Active applied settings
  const [settingsApiKey, setSettingsApiKey] = useState(() => getStoredAIConfig().apiKey);
  const [settingsModel, setSettingsModel] = useState(() => getStoredAIConfig().model || DEFAULT_CLIENT_GEMINI_MODEL);
  const [customModels, setCustomModels] = useState<string[]>(readCustomModels);

  // Deferred Draft States inside Settings Modal (Only applied when user clicks "حفظ الإعدادات"!)
  const [draftLocale, setDraftLocale] = useState<CanvasLocale>(locale);
  const [draftDark, setDraftDark] = useState<boolean>(dark);
  const [draftDialect, setDraftDialect] = useState<'auto' | 'mysql' | 'postgresql'>(dialect);
  const [draftModel, setDraftModel] = useState<string>(settingsModel);
  const [draftApiKey, setDraftApiKey] = useState<string>(settingsApiKey);
  const [draftCustomModels, setDraftCustomModels] = useState<string[]>(customModels);
  const [newCustomModelInput, setNewCustomModelInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [settingsSavedNotice, setSettingsSavedNotice] = useState(false);

  const [pendingGeneratedModel, setPendingGeneratedModel] = useState<SchemaModel | null>(null);

  const anyOperationBusy = parseBusy || (aiDialogOpen && aiBusy) || (exportOpen && exportBusy);

  const fileInput = useRef<HTMLInputElement>(null);
  const diagramExporterRef = useRef<DiagramExporter | null>(null);
  const copy: AppCopy = APP_COPY[locale];
  const reviewCount = useMemo(() => analyzeSchema(schema).issues.length, [schema]);
  const totalRelationsCount = useMemo(
    () => schema.relationships.length + schema.specializations.reduce((s, sp) => s + sp.children.length, 0),
    [schema.relationships.length, schema.specializations],
  );
  const registerDiagramExporter = useCallback((exporter: DiagramExporter) => { diagramExporterRef.current = exporter; }, []);

  const availableDraftModels = useMemo(() => {
    const set = new Set<string>([DEFAULT_CLIENT_GEMINI_MODEL, ...draftCustomModels]);
    if (draftModel.trim()) set.add(draftModel.trim());
    return Array.from(set);
  }, [draftCustomModels, draftModel]);

  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => { setRenameProjectInput(schema.name); }, [schema.name]);
  useEffect(() => {
    const savedPrompt = readProjectSource(activeProjectId);
    setSource(savedPrompt);
  }, [activeProjectId]);
  useEffect(() => {
    if (!aiDialogOpen) setAiBusy(false);
  }, [aiDialogOpen]);
  useEffect(() => {
    if (!exportOpen) setExportBusy(false);
  }, [exportOpen]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(clearToast, 3200);
    return () => window.clearTimeout(timer);
  }, [toast, clearToast]);

  // Live Sync: Diagram (schema) -> SQL & JSON tabs
  useEffect(() => {
    if (!modelCodeDirty) {
      setModelCode(JSON.stringify(schema, null, 2));
    }
  }, [schema, modelCodeDirty]);

  useEffect(() => {
    if (!sqlDirty) {
      const effectiveSqlDialect: SQLDialect = dialect === 'postgresql' ? 'postgresql' : sqlTabDialect;
      setSqlCode(generateDDL(schema, effectiveSqlDialect));
    }
  }, [schema, sqlDirty, sqlTabDialect, dialect]);

  // Live Two-Way Sync: when user edits SQL in the SQL tab -> automatically update Diagram & JSON!
  useEffect(() => {
    if (!sqlDirty || !sqlCode.trim()) return;
    const timer = window.setTimeout(async () => {
      try {
        const { parseSourceAsync } = await import('./parsers/browser');
        const result: ParseResult = await parseSourceAsync(sqlCode, { format: 'sql', dialect: sqlTabDialect === 'postgresql' ? 'postgresql' : 'mysql', name: schema.name });
        if (result.model.entities.length > 0) {
          clearCanvasPositions(activeProjectId);
          replaceSchema({
            ...result.model,
            id: activeProjectId,
            name: schema.name || result.model.name,
          });
          setModelCodeDirty(false);
          setSourceError(false);
          setSourceMessage(null);
        }
      } catch {
        // Wait until user finishes typing valid SQL
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [sqlCode, sqlDirty, sqlTabDialect, activeProjectId, replaceSchema, schema.name]);

  // Live Two-Way Sync: when user edits JSON in the JSON tab -> automatically update Diagram & SQL!
  useEffect(() => {
    if (!modelCodeDirty || !modelCode.trim()) return;
    const timer = window.setTimeout(() => {
      try {
        const raw = JSON.parse(modelCode) as Record<string, unknown>;
        const candidate = raw && typeof raw === 'object' && 'schema' in raw ? raw.schema : raw;
        const parsed = assertSchemaModel(candidate);
        clearCanvasPositions(activeProjectId);
        replaceSchema({
          ...parsed,
          id: activeProjectId,
          name: schema.name || parsed.name,
        });
        setSqlDirty(false);
        setSourceError(false);
        setSourceMessage(null);
      } catch {
        // Wait until user finishes typing valid JSON
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [modelCode, modelCodeDirty, activeProjectId, replaceSchema, schema.name]);

  // Prevent browser tab unload when any operation is in progress
  useEffect(() => {
    if (!anyOperationBusy) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [anyOperationBusy]);

  // Open Settings Dialog and populate draft values from current active settings
  const openSettingsDialog = useCallback(() => {
    setDraftLocale(locale);
    setDraftDark(dark);
    setDraftDialect(dialect);
    setDraftModel(settingsModel);
    setDraftApiKey(settingsApiKey);
    setDraftCustomModels(customModels);
    setNewCustomModelInput('');
    setSettingsSavedNotice(false);
    setSettingsOpen(true);
  }, [locale, dark, dialect, settingsModel, settingsApiKey, customModels]);

  const handleAddDraftCustomModel = () => {
    const clean = newCustomModelInput.trim();
    if (!clean) return;
    const nextList = Array.from(new Set([...draftCustomModels, clean]));
    setDraftCustomModels(nextList);
    setDraftModel(clean);
    setNewCustomModelInput('');
  };

  // Apply all draft settings ONLY when user clicks "حفظ الإعدادات"
  const handleSaveSettings = (event: React.FormEvent) => {
    event.preventDefault();
    setLocale(draftLocale);
    try { localStorage.setItem('erdforge-locale', draftLocale); } catch { /* ignore */ }

    setDark(draftDark);
    try { localStorage.setItem('erdforge-theme', draftDark ? 'dark' : 'light'); } catch { /* ignore */ }

    setDialect(draftDialect);
    if (draftDialect === 'postgresql') setSqlTabDialect('postgresql');
    else if (draftDialect === 'mysql') setSqlTabDialect('mysql');

    setCustomModels(draftCustomModels);
    writeCustomModels(draftCustomModels);

    const finalModel = draftModel.trim() || DEFAULT_CLIENT_GEMINI_MODEL;
    setSettingsModel(finalModel);
    setSettingsApiKey(draftApiKey.trim());
    saveStoredAIConfig(draftApiKey.trim(), finalModel);

    setSettingsSavedNotice(true);
    window.setTimeout(() => {
      setSettingsSavedNotice(false);
      setSettingsOpen(false);
    }, 550);
  };

  const handleRecordAIPrompt = useCallback((promptText: string, modeUsed: 'interpret' | 'edit') => {
    setSource((prev) => {
      const next = modeUsed === 'interpret' || !prev.trim()
        ? promptText
        : `${prev.trim()}\n\n// --- ${locale === 'ar' ? 'طلب تطوير إضافي' : 'Upgrade Request'} ---\n${promptText}`;
      writeProjectSource(activeProjectId, next);
      return next;
    });
  }, [activeProjectId, locale]);

  const handleSourceChange = useCallback((val: string) => {
    setSource(val);
    writeProjectSource(activeProjectId, val);
  }, [activeProjectId]);

  const handleDownloadSql = useCallback(() => {
    const currentSql = sqlDirty ? sqlCode : generateDDL(schema, sqlTabDialect);
    const filename = `${safeFilename(schema.name)}.${sqlTabDialect}.sql`;
    downloadBlob(new Blob([currentSql], { type: 'application/sql;charset=utf-8' }), filename);
  }, [sqlDirty, sqlCode, schema, sqlTabDialect]);

  const handleDownloadJson = useCallback(() => {
    const payload = JSON.stringify({ poweredBy: 'MSR_Coder', format: 'erdforge', version: 1, exportedAt: new Date().toISOString(), schema }, null, 2);
    const filename = `${safeFilename(schema.name)}.erdforge.json`;
    downloadBlob(new Blob([payload], { type: 'application/json;charset=utf-8' }), filename);
  }, [schema]);

  const handleCanvasSelection = useCallback((nextSelection: { type: 'entity' | 'relationship'; id: string } | null) => {
    setSelection(nextSelection);
    if (nextSelection) setInspectorDrawerOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (anyOperationBusy) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('textarea, input, select, [contenteditable="true"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
        event.preventDefault();
        if (selection.type === 'entity') applyOperations([{ op: 'entity.delete', entityId: selection.id }]);
        else applyOperations([{ op: 'relationship.delete', relationshipId: selection.id }]);
        setSelection(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo, selection, applyOperations, anyOperationBusy]);

  const commitGeneratedModel = useCallback((nextModel: SchemaModel, mode: 'replace' | 'merge') => {
    setAiBusy(false);
    setParseBusy(false);
    clearCanvasPositions(activeProjectId);
    if (mode === 'replace' || schema.entities.length === 0) {
      replaceSchema({
        ...nextModel,
        id: activeProjectId,
        name: schema.name || nextModel.name,
      });
    } else {
      const merged = mergeSchemas(schema, nextModel);
      replaceSchema({
        ...merged,
        id: activeProjectId,
      });
    }
    setModelCodeDirty(false);
    setSqlDirty(false);
    setSelection(null);
    setSourceError(false);
    setSourceMessage(null);
    setPendingGeneratedModel(null);
    setStudioView('diagram');
  }, [activeProjectId, replaceSchema, schema]);

  const requestApplyOrConfirm = useCallback((nextModel: SchemaModel, preferredMode: 'replace' | 'merge' | 'ask' = 'ask') => {
    if (schema.entities.length === 0 || preferredMode === 'replace' || preferredMode === 'merge') {
      commitGeneratedModel(nextModel, preferredMode === 'merge' ? 'merge' : 'replace');
    } else {
      setPendingGeneratedModel(nextModel);
    }
  }, [commitGeneratedModel, schema.entities.length]);

  const generateDiagram = useCallback(async (customSource?: string, customFormat?: ParserFormat) => {
    if (parseBusy) return;
    const inputToParse = customSource !== undefined ? customSource : source;
    const fmtToUse = customFormat !== undefined ? customFormat : format;
    if (!inputToParse.trim()) return;

    setParseBusy(true);
    setSourceMessage(null);
    setSourceError(false);
    try {
      const { parseSourceAsync } = await import('./parsers/browser');
      const result: ParseResult = await parseSourceAsync(inputToParse, { format: fmtToUse, dialect, name: schema.name });
      if (result.model.entities.length === 0) {
        const errors = result.diagnostics.filter((d) => d.severity === 'error').map((item) => item.message);
        setSourceMessage(errors.join(' ') || copy.parseEmpty);
        setSourceError(true);
        return;
      }
      requestApplyOrConfirm(result.model, 'replace');
    } catch (error) {
      setSourceMessage(error instanceof Error ? error.message : copy.sourceError);
      setSourceError(true);
    } finally {
      setParseBusy(false);
    }
  }, [parseBusy, source, format, dialect, schema.name, requestApplyOrConfirm, copy]);

  const applySqlCodeToDiagram = useCallback(async () => {
    if (parseBusy || !sqlCode.trim()) return;
    setParseBusy(true);
    setSourceMessage(null);
    setSourceError(false);
    try {
      const { parseSourceAsync } = await import('./parsers/browser');
      const result: ParseResult = await parseSourceAsync(sqlCode, { format: 'sql', dialect: sqlTabDialect === 'postgresql' ? 'postgresql' : 'mysql', name: schema.name });
      if (result.model.entities.length === 0) {
        const errors = result.diagnostics.filter((item) => item.severity === 'error');
        setSourceMessage(`${copy.invalidDbml} ${errors.map((e) => e.message).join(' ') || copy.parseEmpty}`);
        setSourceError(true);
        return;
      }
      setSqlDirty(false);
      commitGeneratedModel(result.model, 'replace');
    } catch (error) {
      setSourceMessage(error instanceof Error ? error.message : copy.sourceError);
      setSourceError(true);
    } finally {
      setParseBusy(false);
    }
  }, [parseBusy, sqlCode, sqlTabDialect, schema.name, copy, commitGeneratedModel]);

  const applyModelCode = useCallback(() => {
    if (parseBusy) return;
    try {
      const raw = JSON.parse(modelCode) as Record<string, unknown>;
      const candidate = raw && typeof raw === 'object' && 'schema' in raw ? raw.schema : raw;
      const parsed = assertSchemaModel(candidate);
      setModelCodeDirty(false);
      commitGeneratedModel(parsed, 'replace');
    } catch (error) {
      const detail = error instanceof Error ? error.message : copy.invalidModel;
      setSourceMessage(`${copy.invalidModel} ${detail}`);
      setSourceError(true);
    }
  }, [parseBusy, modelCode, commitGeneratedModel, copy]);

  const handleImport = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (anyOperationBusy) return;
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) {
      setSourceMessage(locale === 'ar' ? 'يجب ألا يتجاوز حجم الملف 2 ميغابايت.' : 'Files must be 2 MB or smaller.');
      setSourceError(true);
      event.target.value = '';
      return;
    }
    const text = await file.text();
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    event.target.value = '';

    if (ext === 'sql' || activeTab === 'sql') {
      setSqlCode(text);
      setSqlDirty(false);
      handleSourceChange(text);
      void generateDiagram(text, 'sql');
    } else if (ext === 'json' || ext === 'jsonc' || activeTab === 'model') {
      setModelCode(text);
      setModelCodeDirty(false);
      handleSourceChange(text);
      void generateDiagram(text, 'auto');
    } else {
      handleSourceChange(text);
      setFormat('auto');
      void generateDiagram(text, 'auto');
    }
  }, [anyOperationBusy, locale, activeTab, handleSourceChange, generateDiagram]);

  const handleNewProject = useCallback(async (customName?: string) => {
    if (anyOperationBusy) return;
    setModelCodeDirty(false);
    setSqlDirty(false);
    const title = customName?.trim() || newProjectNameInput.trim() || (locale === 'ar' ? 'مشروع جديد' : 'Untitled project');
    await newProject(title);
    setNewProjectNameInput('');
    setSource('');
    setSelection(null);
    setSourceMessage(null);
    setSourceError(false);
  }, [anyOperationBusy, locale, newProject, newProjectNameInput]);

  const handleSwitchProject = useCallback(async (projectId: string) => {
    if (anyOperationBusy) return;
    setModelCodeDirty(false);
    setSqlDirty(false);
    await switchProject(projectId);
    setSource(readProjectSource(projectId));
    setSelection(null);
    setSourceMessage(null);
    setSourceError(false);
  }, [anyOperationBusy, switchProject]);

  const handleDeleteProject = useCallback(async (projectId: string) => {
    if (anyOperationBusy) return;
    clearCanvasPositions(projectId);
    writeProjectSource(projectId, '');
    await removeProject(projectId);
    setSelection(null);
  }, [anyOperationBusy, removeProject]);

  const onRenameEntity = useCallback((entityId: string, nextName: string) => {
    applyOperations([{ op: 'entity.update', entityId, changes: { name: nextName } }]);
  }, [applyOperations]);
  const onEditRelationshipLabel = useCallback((relationshipId: string, nextLabel: string) => {
    applyOperations([{ op: 'relationship.update', relationshipId, changes: { label: nextLabel } }]);
  }, [applyOperations]);
  const onCreateEntity = useCallback(() => {
    const entity = createEntity(locale);
    applyOperations([{ op: 'entity.add', entity }]);
    setSelection({ type: 'entity', id: entity.id });
    setInspectorDrawerOpen(true);
  }, [applyOperations, locale]);
  const onCreateRelationship = useCallback((from?: string, to?: string) => setRelationshipDraft({ ...(from ? { from } : {}), ...(to ? { to } : {}) }), []);
  const onAskAI = useCallback(() => {
    setAiDialogOpen(true);
  }, []);
  const createRelationshipFromInspector = useCallback(() => {
    const from = selection?.type === 'entity' ? selection.id : undefined;
    const to = schema.entities.find((entity) => entity.id !== from)?.id;
    onCreateRelationship(from, to);
  }, [onCreateRelationship, schema.entities, selection]);
  const saveRelationship = useCallback((relationship: Relationship) => {
    applyOperations([{ op: 'relationship.add', relationship }]);
    setRelationshipDraft(null);
    setSelection({ type: 'relationship', id: relationship.id });
    setSourceError(false);
  }, [applyOperations]);

  const editorValue = activeTab === 'source' ? source : activeTab === 'sql' ? sqlCode : modelCode;
  const editorLabel = activeTab === 'source' ? copy.source : activeTab === 'sql' ? copy.dbmlCode : copy.modelJson;

  return (
    <div className={dark ? 'app-shell theme-dark' : 'app-shell'} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      {/* SINGLE-LINE TOP NAVIGATION HEADER */}
      <header className="topbar">
        <div className="brand-lockup" aria-label="ERDForge studio">
          <span className="brand-mark"><Workflow size={16} strokeWidth={2.5} /></span>
          <span className="brand-name">ERD<span>Forge</span></span>
        </div>

        <nav className="studio-view-tabs" aria-label={locale === 'ar' ? 'شاشات الموقع' : 'Views'}>
          <button
            type="button"
            disabled={anyOperationBusy}
            className={`studio-view-tab ${studioView === 'diagram' ? 'is-active' : ''}`}
            onClick={() => setStudioView('diagram')}
          >
            <Workflow size={13} />
            <span>{locale === 'ar' ? 'المخطط' : 'Diagram'}</span>
            <small className="tab-count-pill">{schema.entities.length}</small>
          </button>
          <button
            type="button"
            disabled={anyOperationBusy}
            className={`studio-view-tab ${studioView === 'editor' ? 'is-active' : ''}`}
            onClick={() => setStudioView('editor')}
          >
            <FileCode2 size={13} />
            <span>{locale === 'ar' ? 'المحرر' : 'Editor'}</span>
          </button>
          <button
            type="button"
            disabled={anyOperationBusy}
            className={`studio-view-tab ${studioView === 'projects' ? 'is-active' : ''}`}
            onClick={() => setStudioView('projects')}
          >
            <FolderKanban size={13} />
            <span>{locale === 'ar' ? 'المشاريع' : 'Projects'}</span>
            <small className="tab-count-pill">{projects.length}</small>
          </button>
        </nav>

        <div className="topbar-spacer" />

        <div className="topbar-actions-group">
          <button
            className="outline-button ai-open-button"
            type="button"
            disabled={anyOperationBusy}
            onClick={() => setAiDialogOpen(true)}
          >
            <Sparkles size={13} />
            <span>{locale === 'ar' ? 'المساعد الذكي' : 'Ask AI'}</span>
          </button>
          <button
            className="outline-button export-open-button"
            type="button"
            disabled={anyOperationBusy}
            onClick={() => setExportOpen(true)}
            aria-label={locale === 'ar' ? 'تصدير المخطط' : 'Export'}
          >
            <ArrowDownToLine size={13} />
            <span>{locale === 'ar' ? 'تصدير' : 'Export'}</span>
          </button>
          <button
            className="outline-button settings-open-button"
            type="button"
            disabled={anyOperationBusy}
            onClick={openSettingsDialog}
            aria-label={locale === 'ar' ? 'الإعدادات' : 'Settings'}
          >
            <Settings size={13} />
            <span>{locale === 'ar' ? 'الإعدادات' : 'Settings'}</span>
          </button>
        </div>
      </header>

      {/* MAIN STUDIO BODY */}
      <div className="studio-body">
        {/* VIEW 1: FULL-SCREEN MYSQL WORKBENCH ERD DIAGRAM */}
        {studioView === 'diagram' && (
          <div className="diagram-fullscreen-layout">
            <div className="diagram-main-split">
              <main className="canvas-area" aria-label={copy.canvas}>
                <DiagramCanvas
                  schema={schema}
                  selection={selection}
                  onSelectionChange={handleCanvasSelection}
                  onCreateEntity={onCreateEntity}
                  onAskAI={onAskAI}
                  onUndo={undo}
                  onRedo={redo}
                  canUndo={canUndo}
                  canRedo={canRedo}
                  onRenameEntity={onRenameEntity}
                  onEditRelationshipLabel={onEditRelationshipLabel}
                  onCreateRelationship={onCreateRelationship}
                  locale={locale}
                  dark={dark}
                  onDiagramExportReady={registerDiagramExporter}
                />
              </main>

              {/* Collapsible Slide-Over Inspector Drawer */}
              {inspectorDrawerOpen && (
                <aside className="inspector-panel" aria-label={locale === 'ar' ? 'خصائص الجدول' : 'Table inspector'}>
                  <div className="inspector-heading">
                    <div>
                      <span className="eyebrow">{locale === 'ar' ? 'خصائص العنصر المحدد' : 'PROPERTIES'}</span>
                      <h2>{locale === 'ar' ? 'تعديل الجدول والأعمدة' : 'Edit Table & Columns'}</h2>
                    </div>
                    <button
                      type="button"
                      className="icon-button dialog-close-btn"
                      aria-label={copy.close}
                      onClick={() => setInspectorDrawerOpen(false)}
                    >
                      <X size={16} />
                    </button>
                  </div>

                  <Suspense fallback={<div className="editor-loading" role="status">{copy.creating}</div>}>
                    <ManualInspector
                      selection={selection}
                      locale={locale}
                      onSelectionChange={setSelection}
                      onCreateEntity={onCreateEntity}
                      onCreateRelationship={createRelationshipFromInspector}
                    />
                  </Suspense>

                  {!selection && schema.entities.length > 0 && (
                    <section className="workbench-catalog-section" aria-label={locale === 'ar' ? 'قائمة الجداول' : 'Tables list'}>
                      <div className="inspector-section-title">
                        <span><Table2 size={12} /> {locale === 'ar' ? 'جداول المخطط (اضغط للتعديل)' : 'Tables in Diagram'}</span>
                        <small>{schema.entities.length}</small>
                      </div>
                      <div className="workbench-catalog-list">
                        {schema.entities.map((ent) => {
                          const pks = ent.attributes.filter((a) => a.isPK).length;
                          const fks = ent.attributes.filter((a) => a.isFK).length;
                          return (
                            <button
                              key={ent.id}
                              type="button"
                              className="workbench-catalog-item"
                              onClick={() => setSelection({ type: 'entity', id: ent.id })}
                            >
                              <span className="catalog-item-name"><Database size={12} /> {ent.name}</span>
                              <span className="catalog-item-badges">
                                <small className="cat-badge">{ent.attributes.length}</small>
                                {pks > 0 && <small className="cat-badge pk"><KeyRound size={9} /> {pks}</small>}
                                {fks > 0 && <small className="cat-badge fk"><Link2 size={9} /> {fks}</small>}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  <div className="review-card">
                    <div className="review-top">
                      <span className="review-symbol"><Activity size={15} /></span>
                      <span className="review-label">{copy.review}</span>
                      <span className="review-count">{reviewCount}</span>
                    </div>
                    <button className="text-link" type="button" onClick={() => setReviewOpen(true)}>{copy.review} <span>→</span></button>
                  </div>
                </aside>
              )}
            </div>
          </div>
        )}

        {/* VIEW 2: DEDICATED FULL-SCREEN CODE & LIVE BIDIRECTIONAL SQL/JSON STUDIO */}
        {studioView === 'editor' && (
          <section className="dedicated-editor-view" aria-label={copy.source}>
            <div className="editor-view-container">
              <div className="editor-view-header">
                <div>
                  <span className="eyebrow">{locale === 'ar' ? 'محرر النصوص والأكواد (مزامنة ثنائية فورية)' : 'LIVE BIDIRECTIONAL CODE & SQL STUDIO'}</span>
                  <h1>
                    {locale === 'ar'
                      ? 'طلبات الذكاء الاصطناعي وكود SQL الجاهز للتنزيل وملف JSON (محدث تلقائياً مع المخطط)'
                      : 'Saved AI Prompts, Ready-to-Download SQL DDL & Live JSON Sync'}
                  </h1>
                </div>
              </div>

              <div className="editor-view-toolbar">
                <div className="input-tabs" role="tablist">
                  <button
                    role="tab"
                    type="button"
                    disabled={parseBusy}
                    aria-selected={activeTab === 'source'}
                    className={activeTab === 'source' ? 'input-tab selected' : 'input-tab'}
                    onClick={() => setActiveTab('source')}
                  >
                    {copy.tabSource}
                  </button>
                  <button
                    role="tab"
                    type="button"
                    disabled={parseBusy}
                    aria-selected={activeTab === 'sql'}
                    className={activeTab === 'sql' ? 'input-tab selected' : 'input-tab'}
                    onClick={() => setActiveTab('sql')}
                  >
                    {copy.tabDbml}
                  </button>
                  <button
                    role="tab"
                    type="button"
                    disabled={parseBusy}
                    aria-selected={activeTab === 'model'}
                    className={activeTab === 'model' ? 'input-tab selected' : 'input-tab'}
                    onClick={() => setActiveTab('model')}
                  >
                    {copy.tabModel}
                  </button>
                </div>

                <div className="source-tools">
                  {activeTab === 'source' && (
                    <label className="format-select-label">
                      <span>{copy.format}</span>
                      <select disabled={parseBusy} value={format} aria-label={copy.format} onChange={(event) => setFormat(event.target.value as ParserFormat)}>
                        {FORMAT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{locale === 'ar' ? option.ar : option.en}</option>)}
                      </select>
                    </label>
                  )}

                  {activeTab === 'sql' && (
                    <>
                      <label className="format-select-label dialect-select">
                        <span>{copy.dialect}</span>
                        <select
                          disabled={parseBusy}
                          value={sqlTabDialect}
                          aria-label={copy.dialect}
                          onChange={(event) => {
                            const nextDialect = event.target.value as SQLDialect;
                            setSqlTabDialect(nextDialect);
                            setSqlDirty(false);
                          }}
                        >
                          <option value="mysql">MySQL / MariaDB</option>
                          <option value="postgresql">PostgreSQL</option>
                          <option value="sqlite">SQLite</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={parseBusy || schema.entities.length === 0}
                        className="primary-button sql-download-inline-btn"
                        onClick={handleDownloadSql}
                      >
                        <ArrowDownToLine size={14} />
                        <span>{locale === 'ar' ? 'تنزيل كود SQL' : 'Download SQL'}</span>
                      </button>
                    </>
                  )}

                  {activeTab === 'model' && (
                    <button
                      type="button"
                      disabled={parseBusy || schema.entities.length === 0}
                      className="primary-button sql-download-inline-btn"
                      onClick={handleDownloadJson}
                    >
                      <ArrowDownToLine size={14} />
                      <span>{locale === 'ar' ? 'تنزيل ملف JSON' : 'Download JSON'}</span>
                    </button>
                  )}

                  <button type="button" disabled={parseBusy} className="quiet-button import-button" onClick={() => fileInput.current?.click()}>
                    <Upload size={14} />
                    <span>{locale === 'ar' ? 'رفع ملف (SQL / JSON / نص)' : 'Upload File'}</span>
                  </button>
                  <input ref={fileInput} type="file" accept=".sql,.php,.json,.jsonc,.dbml,.mmd,.md,.txt" hidden onChange={(event) => void handleImport(event)} />
                </div>
              </div>

              <div className="source-editor-frame" aria-label={editorLabel}>
                <StudioCodeEditor
                  label={editorLabel}
                  disabled={parseBusy}
                  value={editorValue}
                  placeholder={
                    activeTab === 'source'
                      ? (locale === 'ar'
                          ? 'يُحفظ هنا تلقائياً كل ما تطلبه من المساعد الذكي، ويمكنك أيضاً كتابة أو لصق أي وصف أو كود SQL أو JSON لتحويله إلى مخطط ERD...'
                          : 'Your AI prompts are automatically saved here. You can also write or paste descriptions, SQL DDL, or JSON...')
                      : activeTab === 'sql'
                        ? '-- Powered by MSR_Coder\n-- الصق أو عدّل كود SQL هنا ليتم تحديث مخطط ERD تلقائياً...'
                        : '{\n  "poweredBy": "MSR_Coder"\n}'
                  }
                  onChange={(val) => {
                    if (activeTab === 'model') {
                      setModelCode(val);
                      setModelCodeDirty(true);
                    } else if (activeTab === 'sql') {
                      setSqlCode(val);
                      setSqlDirty(true);
                    } else {
                      handleSourceChange(val);
                    }
                  }}
                />
              </div>

              {parseBusy && (
                <div className="operation-locked-banner" role="status">
                  <Lock size={13} />
                  <span>{locale === 'ar' ? 'جاري بناء المخطط الآن — لا يمكن الإلغاء لحين اكتمال العملية' : 'Generating diagram — cannot be cancelled until finished'}</span>
                </div>
              )}

              {/* Live Accurate Schema Status Banner */}
              {sourceError && sourceMessage ? (
                <div className="source-message is-error" role="alert">{sourceMessage}</div>
              ) : schema.entities.length > 0 ? (
                <div className="source-message" role="status">
                  {locale === 'ar'
                    ? `✅ مخطط ERD الحالي جاهز ومُحدّث تلقائياً (${schema.entities.length} جدول و ${totalRelationsCount} علاقة) — متزامن مع SQL و JSON`
                    : `✅ Active ERD is live and synchronized (${schema.entities.length} tables · ${totalRelationsCount} relations)`}
                </div>
              ) : null}

              {lastError && <div className="source-message is-error" role="alert">{lastError}</div>}

              <div className="editor-view-actions">
                <button
                  type="button"
                  className="primary-button generate-button"
                  disabled={parseBusy || (activeTab === 'source' && !source.trim()) || (activeTab === 'sql' && !sqlCode.trim()) || (activeTab === 'model' && !modelCode.trim())}
                  onClick={() => {
                    if (activeTab === 'source') void generateDiagram();
                    else if (activeTab === 'sql') void applySqlCodeToDiagram();
                    else applyModelCode();
                  }}
                >
                  {parseBusy ? <LoaderCircle size={15} className="spinning" /> : <Workflow size={16} />}
                  <span>
                    {parseBusy
                      ? copy.parsing
                      : activeTab === 'sql'
                        ? (locale === 'ar' ? '⚡ تحديث المخطط من كود SQL وعرضه' : '⚡ Sync SQL & Open ERD')
                        : activeTab === 'model'
                          ? (locale === 'ar' ? '⚡ تحديث المخطط من JSON وعرضه' : '⚡ Sync JSON & Open ERD')
                          : (locale === 'ar' ? '⚡ تحويل النص/الكود وعرض مخطط ERD' : '⚡ Generate & Open Workbench ERD')}
                  </span>
                </button>

                {activeTab === 'sql' && schema.entities.length > 0 && (
                  <button type="button" className="outline-button dialog-cancel-btn" onClick={handleDownloadSql}>
                    <ArrowDownToLine size={15} />
                    <span>{locale === 'ar' ? 'تنزيل ملف SQL مع حقوق المطور' : 'Download .sql File'}</span>
                  </button>
                )}
              </div>
            </div>
          </section>
        )}

        {/* VIEW 3: DEDICATED PROJECTS MANAGER */}
        {studioView === 'projects' && (
          <section className="dedicated-projects-view" aria-label={copy.project}>
            <div className="projects-view-container">
              <div className="projects-header">
                <div>
                  <span className="eyebrow">{locale === 'ar' ? 'إدارة المشاريع' : 'PROJECTS MANAGER'}</span>
                  <h1>{locale === 'ar' ? 'إنشاء، تعديل، وحذف المشاريع' : 'Create, Rename, Switch & Delete Projects'}</h1>
                </div>
              </div>

              <div className="project-manager-card">
                <h3><Plus size={16} /> {locale === 'ar' ? 'إنشاء مشروع جديد' : 'Create a New Project'}</h3>
                <form
                  className="project-action-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleNewProject(newProjectNameInput);
                  }}
                >
                  <input
                    value={newProjectNameInput}
                    onChange={(event) => setNewProjectNameInput(event.target.value)}
                    placeholder={locale === 'ar' ? 'اكتب اسم المشروع الجديد…' : 'Enter new project name…'}
                  />
                  <button type="submit" className="primary-button">
                    <Plus size={15} />
                    <span>{locale === 'ar' ? 'إنشاء مشروع جديد' : 'Create Project'}</span>
                  </button>
                </form>
              </div>

              <div className="project-manager-card">
                <h3><Pencil size={15} /> {locale === 'ar' ? 'تعديل اسم المشروع الحالي' : 'Rename Current Project'}</h3>
                <form
                  className="project-action-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (renameProjectInput.trim()) renameProject(renameProjectInput.trim());
                  }}
                >
                  <input
                    value={renameProjectInput}
                    onChange={(event) => setRenameProjectInput(event.target.value)}
                    placeholder={locale === 'ar' ? 'اسم المشروع الحالي…' : 'Current project name…'}
                  />
                  <button type="submit" className="outline-button">
                    <Check size={15} />
                    <span>{locale === 'ar' ? 'حفظ الاسم' : 'Save Name'}</span>
                  </button>
                </form>
              </div>

              <div className="project-manager-card">
                <h3><FolderKanban size={16} /> {locale === 'ar' ? `جميع المشاريع المحفوظة (${projects.length})` : `Saved Projects (${projects.length})`}</h3>
                <div className="saved-projects-grid">
                  {projects.map((proj) => {
                    const isCurrent = proj.id === activeProjectId;
                    return (
                      <div key={proj.id} className={`saved-project-item ${isCurrent ? 'is-active' : ''}`}>
                        <div className="saved-project-info">
                          <strong>
                            <Database size={14} />
                            <span>{proj.name}</span>
                            {isCurrent && <small className="active-proj-badge">{locale === 'ar' ? 'نشط الآن' : 'Active'}</small>}
                          </strong>
                          <span>
                            {proj.schema.entities.length} {locale === 'ar' ? 'جداول' : 'tables'} · {proj.schema.relationships.length} {locale === 'ar' ? 'علاقات' : 'relations'}
                          </span>
                        </div>
                        <div className="saved-project-actions">
                          {!isCurrent && (
                            <button
                              type="button"
                              className="outline-button"
                              onClick={() => {
                                void handleSwitchProject(proj.id);
                                setStudioView('diagram');
                              }}
                            >
                              {locale === 'ar' ? 'فتح المشروع' : 'Open'}
                            </button>
                          )}
                          {isCurrent && (
                            <button
                              type="button"
                              className="primary-button"
                              onClick={() => setStudioView('diagram')}
                            >
                              {locale === 'ar' ? 'عرض المخطط' : 'View ERD'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="danger-project-button"
                            title={locale === 'ar' ? 'حذف المشروع نهائياً' : 'Delete project'}
                            onClick={() => void handleDeleteProject(proj.id)}
                          >
                            <Trash2 size={14} />
                            <span>{locale === 'ar' ? 'حذف' : 'Delete'}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* BOTTOM STATUS BAR: PROJECT STATS + CLEAN MSR_CODER LINK */}
      <footer className="statusbar">
        <span className="statusbar-project">
          <span className="status-light" />
          <strong className="statusbar-project-name">{schema.name}</strong>
          <span className="statusbar-sep">·</span>
          <span>{schema.entities.length} {locale === 'ar' ? 'جداول' : 'tables'} · {totalRelationsCount} {locale === 'ar' ? 'علاقات' : 'relations'}</span>
        </span>

        <a
          href="https://msr-coder.pages.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="msr-coder-footer-link"
          title="MSR_Coder"
        >
          <strong className="msr-footer-brand">MSR_Coder</strong>
          <span className="msr-footer-cta">
            {locale === 'ar' ? 'للتواصل' : 'Contact'}
            <ExternalLink size={10} />
          </span>
        </a>
      </footer>

      {toast && <div className="toast-message" role="status"><Check size={14} />{toast}</div>}

      {/* ASK AI MODAL DIALOG (NON-CANCELABLE WHILE BUSY) */}
      {aiDialogOpen && (
        <div
          className="privacy-backdrop"
          onMouseDown={(event) => {
            if (!aiBusy && event.target === event.currentTarget) setAiDialogOpen(false);
          }}
        >
          <div className="ai-dialog-modal-shell">
            <Suspense fallback={<div className="privacy-dialog" role="status">{locale === 'ar' ? 'جارٍ التحميل…' : 'Loading…'}</div>}>
              <AIProposalPanel
                locale={locale}
                onBusyChange={setAiBusy}
                onRecordPrompt={handleRecordAIPrompt}
                onClose={() => {
                  setAiBusy(false);
                  setAiDialogOpen(false);
                }}
                onOpenSettings={() => {
                  if (!aiBusy) {
                    setAiDialogOpen(false);
                    openSettingsDialog();
                  }
                }}
                onRequestApplyModel={(nextModel, strategy) => {
                  setAiBusy(false);
                  commitGeneratedModel(nextModel, strategy === 'merge' ? 'merge' : 'replace');
                  setAiDialogOpen(false);
                }}
              />
            </Suspense>
          </div>
        </div>
      )}

      {/* DEDICATED SETTINGS MODAL (NO TOP 'X' BUTTON; CHANGES APPLY ONLY ON SAVE) */}
      {settingsOpen && (
        <div className="privacy-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <section className="privacy-dialog settings-dialog-card" role="dialog" aria-modal="true" aria-labelledby="settings-title" dir={draftLocale === 'ar' ? 'rtl' : 'ltr'}>
            <header className="settings-dialog-header">
              <div className="settings-title-group">
                <span className="settings-badge-icon"><Settings size={18} /></span>
                <div>
                  <span className="eyebrow">{draftLocale === 'ar' ? 'إعدادات التطبيق' : 'SETTINGS'}</span>
                  <h3 id="settings-title">{draftLocale === 'ar' ? 'الإعدادات العامة والذكاء الاصطناعي' : 'General & AI Settings'}</h3>
                </div>
              </div>
            </header>

            <form className="settings-dialog-form" onSubmit={handleSaveSettings}>
              <div className="settings-two-col">
                <label className="manual-field">
                  <span><Languages size={13} /> {draftLocale === 'ar' ? 'اللغة' : 'Language'}</span>
                  <select value={draftLocale} onChange={(event) => setDraftLocale(event.target.value as CanvasLocale)}>
                    <option value="ar">العربية</option>
                    <option value="en">English</option>
                  </select>
                </label>

                <label className="manual-field">
                  <span>{draftDark ? <Moon size={13} /> : <Sun size={13} />} {draftLocale === 'ar' ? 'المظهر' : 'Theme'}</span>
                  <select value={draftDark ? 'dark' : 'light'} onChange={(event) => setDraftDark(event.target.value === 'dark')}>
                    <option value="dark">{draftLocale === 'ar' ? 'الوضع الليلي' : 'Dark Mode'}</option>
                    <option value="light">{draftLocale === 'ar' ? 'الوضع النهاري' : 'Light Mode'}</option>
                  </select>
                </label>
              </div>

              <label className="manual-field">
                <span><Wand2 size={13} /> {draftLocale === 'ar' ? 'نموذج الذكاء الاصطناعي' : 'AI Model'}</span>
                <select value={draftModel} onChange={(event) => setDraftModel(event.target.value)}>
                  {availableDraftModels.map((m) => (
                    <option key={m} value={m}>
                      {m === DEFAULT_CLIENT_GEMINI_MODEL
                        ? (draftLocale === 'ar' ? 'النموذج الافتراضي السريع (تلقائي)' : 'Default Fast AI Model (Auto)')
                        : m}
                    </option>
                  ))}
                </select>
              </label>

              <div className="manual-field">
                <span><Plus size={13} /> {draftLocale === 'ar' ? 'إضافة نموذج يدوياً' : 'Add Custom Model'}</span>
                <div className="api-key-input-row" dir="ltr">
                  <input
                    type="text"
                    value={newCustomModelInput}
                    onChange={(event) => setNewCustomModelInput(event.target.value)}
                    placeholder={draftLocale === 'ar' ? 'اكتب اسم النموذج هنا...' : 'Enter model name...'}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        handleAddDraftCustomModel();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="outline-button dialog-cancel-btn"
                    onClick={handleAddDraftCustomModel}
                  >
                    <Plus size={13} />
                    <span>{draftLocale === 'ar' ? 'إضافة' : 'Add'}</span>
                  </button>
                </div>
              </div>

              <label className="manual-field">
                <span><KeyRound size={13} /> {draftLocale === 'ar' ? 'مفتاح التوكن (API Token)' : 'API Token'}</span>
                <div className="api-key-input-row" dir="ltr">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={draftApiKey}
                    onChange={(event) => setDraftApiKey(event.target.value)}
                    placeholder={draftLocale === 'ar' ? 'أضف التوكن هنا' : 'Add token here'}
                  />
                  <button
                    type="button"
                    className="icon-button dialog-close-btn"
                    onClick={() => setShowApiKey((v) => !v)}
                    title={showApiKey ? 'Hide' : 'Show'}
                  >
                    {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </label>

              <label className="manual-field">
                <span><Database size={13} /> {draftLocale === 'ar' ? 'قاعدة البيانات الافتراضية' : 'Default SQL Dialect'}</span>
                <select value={draftDialect} onChange={(event) => setDraftDialect(event.target.value as 'auto' | 'mysql' | 'postgresql')}>
                  <option value="auto">{draftLocale === 'ar' ? 'تلقائي' : 'Auto'}</option>
                  <option value="mysql">MySQL / MariaDB</option>
                  <option value="postgresql">PostgreSQL</option>
                </select>
              </label>

              {/* Clean Developer Card inside Settings */}
              <div className="msr-settings-credit-card">
                <div className="msr-settings-credit-info">
                  <strong>MSR_Coder</strong>
                </div>
                <a
                  href="https://msr-coder.pages.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="msr-settings-contact-btn"
                >
                  <span>{draftLocale === 'ar' ? 'للتواصل' : 'Contact'}</span>
                  <ExternalLink size={13} />
                </a>
              </div>

              {settingsSavedNotice && (
                <div className="ai-info" role="status">
                  <Check size={14} />
                  <span>{draftLocale === 'ar' ? 'تم حفظ وتطبيق الإعدادات بنجاح!' : 'Settings saved and applied!'}</span>
                </div>
              )}

              <div className="settings-dialog-actions">
                <button type="button" className="outline-button dialog-cancel-btn" onClick={() => setSettingsOpen(false)}>
                  {draftLocale === 'ar' ? 'إغلاق' : 'Close'}
                </button>
                <button type="submit" className="primary-button">
                  <Check size={14} />
                  <span>{draftLocale === 'ar' ? 'حفظ الإعدادات' : 'Save Settings'}</span>
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {/* REPLACE VS. MERGE CONFIRMATION MODAL */}
      {pendingGeneratedModel && (
        <div className="privacy-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingGeneratedModel(null); }}>
          <section className="privacy-dialog replace-merge-dialog" role="dialog" aria-modal="true" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
            <header className="settings-dialog-header">
              <div className="settings-title-group">
                <span className="settings-badge-icon"><Layers size={18} /></span>
                <div>
                  <span className="eyebrow">{locale === 'ar' ? 'تحديث المخطط' : 'UPDATE DIAGRAM'}</span>
                  <h3>{locale === 'ar' ? 'هل تريد استبدال المخطط القديم أم الدمج معه؟' : 'Replace Existing Diagram or Merge?'}</h3>
                </div>
              </div>
              <button className="icon-button dialog-close-btn" type="button" onClick={() => setPendingGeneratedModel(null)}>
                <X size={16} />
              </button>
            </header>

            <p className="replace-merge-desc">
              {locale === 'ar'
                ? `يحتوي المشروع الحالي على (${schema.entities.length} جدول). تم استخراج (${pendingGeneratedModel.entities.length} جدول و ${pendingGeneratedModel.relationships.length + pendingGeneratedModel.specializations.reduce((s, sp) => s + sp.children.length, 0)} رابط) من الكود الجديد.`
                : `Your current diagram has ${schema.entities.length} tables. The new input produced ${pendingGeneratedModel.entities.length} tables and ${pendingGeneratedModel.relationships.length} relationships.`}
            </p>

            <div className="replace-merge-choices">
              <button
                type="button"
                className="primary-button replace-choice-btn"
                onClick={() => commitGeneratedModel(pendingGeneratedModel, 'replace')}
              >
                <RefreshCw size={15} />
                <div>
                  <strong>{locale === 'ar' ? 'استبدال المخطط القديم بالكامل' : 'Replace Old Diagram Completely'}</strong>
                  <small>{locale === 'ar' ? 'مسح الجداول القديمة وعرض الجداول والعلاقات الجديدة فقط' : 'Clear old tables and show only the newly generated ERD'}</small>
                </div>
              </button>

              <button
                type="button"
                className="outline-button merge-choice-btn"
                onClick={() => commitGeneratedModel(pendingGeneratedModel, 'merge')}
              >
                <Plus size={15} />
                <div>
                  <strong>{locale === 'ar' ? 'دمج وإضافة على المخطط الحالي' : 'Merge & Add to Current Diagram'}</strong>
                  <small>{locale === 'ar' ? 'الإبقاء على الجداول القديمة وإضافة الجداول والروابط الجديدة إليها' : 'Keep existing tables and add the new tables and relationships'}</small>
                </div>
              </button>
            </div>

            <div className="settings-dialog-actions">
              <button type="button" className="quiet-button" onClick={() => setPendingGeneratedModel(null)}>
                {locale === 'ar' ? 'إلغاء' : 'Cancel'}
              </button>
            </div>
          </section>
        </div>
      )}

      {relationshipDraft && <Suspense fallback={null}><RelationshipDialog open entities={schema.entities} {...(relationshipDraft.from ? { initialFrom: relationshipDraft.from } : {})} {...(relationshipDraft.to ? { initialTo: relationshipDraft.to } : {})} locale={locale} onClose={() => setRelationshipDraft(null)} onSave={saveRelationship} /></Suspense>}
      {reviewOpen && <Suspense fallback={<div className="privacy-backdrop"><div className="privacy-dialog" role="status">{copy.creating}</div></div>}><SchemaReviewPanel locale={locale} onClose={() => setReviewOpen(false)} /></Suspense>}
      {exportOpen && (
        <Suspense fallback={<div className="privacy-backdrop"><div className="privacy-dialog" role="status">{copy.creating}</div></div>}>
          <ExportPanel
            schema={schema}
            locale={locale}
            onBusyChange={setExportBusy}
            onClose={() => {
              setExportBusy(false);
              setExportOpen(false);
            }}
            diagramExporter={diagramExporterRef.current}
          />
        </Suspense>
      )}
    </div>
  );
}
