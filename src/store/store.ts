import { create } from 'zustand';
import { assertSchemaModel } from '../model/schema';
import { applyPatchOperations, applySchemaPatch, schemaPatchSchema } from '../model/patch';
import type { NamedSnapshot, ProjectRecord, SchemaModel, SchemaPatch, SchemaPatchOperation } from '../model/types';
import { deleteProjectRecord, getActiveProjectId, getProjectRecord, listProjectRecords, saveActiveProjectId, saveProjectRecord } from './projectDb';

export const MAX_NAMED_SNAPSHOTS = 50;
let saveQueue: Promise<void> = Promise.resolve();

export interface PatchReviewState {
  patch: SchemaPatch;
  itemStates: Array<'pending' | 'accepted' | 'rejected'>;
  expectedSchema: SchemaModel;
}

export function flushStorePersistence(): Promise<void> {
  return saveQueue;
}

function enqueuePersist(record: ProjectRecord): void {
  const safeRecord = structuredClone(record);
  saveQueue = saveQueue.then(async () => {
    await saveProjectRecord(safeRecord);
    await saveActiveProjectId(safeRecord.id);
  }).catch((error: unknown) => {
    console.error('Local project autosave failed.', error instanceof Error ? error.message : 'Unknown storage error');
  });
}

function blankModel(id: string, name: string): SchemaModel {
  return { version: 1, id, name, entities: [], relationships: [], specializations: [], subjectAreas: [], notes: [] };
}

const initialBlankModel = blankModel('initial-project', 'Untitled project');

export interface SchemaStore {
  projects: ProjectRecord[];
  activeProjectId: string;
  schema: SchemaModel;
  snapshots: NamedSnapshot[];
  past: SchemaModel[];
  future: SchemaModel[];
  patchReview: PatchReviewState | null;
  toast: string | null;
  lastError: string | null;
  initialize: () => Promise<void>;
  newProject: (name: string) => Promise<string>;
  switchProject: (id: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  renameProject: (name: string) => void;
  replaceSchema: (model: SchemaModel) => void;
  applyOperations: (operations: SchemaPatchOperation[]) => void;
  applyPatch: (patch: SchemaPatch) => void;
  previewPatch: (patch: SchemaPatch) => void;
  acceptPatchItem: (index: number) => void;
  rejectPatchItem: (index: number) => void;
  clearPatchReview: () => void;
  undo: () => void;
  redo: () => void;
  saveSnapshot: (name: string) => string;
  restoreSnapshot: (snapshotId: string) => void;
  deleteSnapshot: (snapshotId: string) => void;
  clearToast: () => void;
  clearError: () => void;
}

function toRecord(state: Pick<SchemaStore, 'activeProjectId' | 'schema' | 'snapshots'>): ProjectRecord {
  return {
    id: state.activeProjectId,
    name: state.schema.name,
    updatedAt: new Date().toISOString(),
    schema: structuredClone(state.schema),
    snapshots: structuredClone(state.snapshots),
  };
}

function saveState(get: () => SchemaStore): void {
  const state = get();
  enqueuePersist(toRecord(state));
}

export const useSchemaStore = create<SchemaStore>((set, get) => ({
  projects: [],
  activeProjectId: initialBlankModel.id,
  schema: structuredClone(initialBlankModel),
  snapshots: [],
  past: [],
  future: [],
  patchReview: null,
  toast: null,
  lastError: null,

  initialize: async () => {
    // Remove the old bundled demo project from existing browser databases.
    // Real user-created projects are kept untouched.
    await deleteProjectRecord('pharmacy-chain-v1');
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem('erdforge-canvas-positions:pharmacy-chain-v1');
    } catch {
      // Removing an obsolete demo layout must not block startup.
    }
    const records = (await listProjectRecords()).filter((record) => record.id !== 'pharmacy-chain-v1');
    if (records.length === 0) {
      const id = crypto.randomUUID();
      const schema = blankModel(id, 'Untitled project');
      const initial: ProjectRecord = {
        id,
        name: schema.name,
        updatedAt: new Date().toISOString(),
        schema,
        snapshots: [],
      };
      await saveProjectRecord(initial);
      await saveActiveProjectId(initial.id);
      set({ projects: [initial], activeProjectId: initial.id, schema: initial.schema, snapshots: [], past: [], future: [], patchReview: null, lastError: null });
      return;
    }
    const storedActiveId = await getActiveProjectId();
    const active = records.find((record) => record.id === storedActiveId) ?? records[0]!;
    const schema = assertSchemaModel(active.schema);
    await saveActiveProjectId(active.id);
    set({ projects: records, activeProjectId: active.id, schema, snapshots: active.snapshots, past: [], future: [], patchReview: null, lastError: null });
  },

  newProject: async (name) => {
    const id = crypto.randomUUID();
    const schema = blankModel(id, name.trim() || 'Untitled project');
    const record: ProjectRecord = { id, name: schema.name, updatedAt: new Date().toISOString(), schema, snapshots: [] };
    await saveProjectRecord(record);
    await saveActiveProjectId(id);
    const projects = [record, ...get().projects.filter((project) => project.id !== id)];
    set({ projects, activeProjectId: id, schema, snapshots: [], past: [], future: [], patchReview: null, toast: 'New local project created.', lastError: null });
    return id;
  },

  switchProject: async (id) => {
    const project = await getProjectRecord(id);
    if (!project) {
      set({ lastError: 'That local project could not be found.' });
      return;
    }
    await saveActiveProjectId(id);
    set({ activeProjectId: id, schema: assertSchemaModel(project.schema), snapshots: project.snapshots, past: [], future: [], patchReview: null, lastError: null });
  },

  removeProject: async (id) => {
    await deleteProjectRecord(id);
    const projects = get().projects.filter((project) => project.id !== id);
    if (id === get().activeProjectId) {
      if (projects[0]) {
        const next = await getProjectRecord(projects[0].id);
        if (next) {
          await saveActiveProjectId(next.id);
          set({ projects, activeProjectId: next.id, schema: next.schema, snapshots: next.snapshots, past: [], future: [] });
        } else {
          const nextId = crypto.randomUUID();
          const model = blankModel(nextId, 'Untitled project');
          const record: ProjectRecord = { id: nextId, name: model.name, updatedAt: new Date().toISOString(), schema: model, snapshots: [] };
          await saveProjectRecord(record);
          await saveActiveProjectId(nextId);
          set({ projects: [record], activeProjectId: nextId, schema: model, snapshots: [], past: [], future: [] });
        }
      } else {
        const nextId = crypto.randomUUID();
        const model = blankModel(nextId, 'Untitled project');
        const record: ProjectRecord = { id: nextId, name: model.name, updatedAt: new Date().toISOString(), schema: model, snapshots: [] };
        await saveProjectRecord(record);
        await saveActiveProjectId(nextId);
        set({ projects: [record], activeProjectId: nextId, schema: model, snapshots: [], past: [], future: [] });
      }
    } else set({ projects });
  },

  renameProject: (name) => {
    const safeName = name.trim();
    if (!safeName) return;
    const schema = { ...get().schema, name: safeName };
    const state = { ...get(), schema };
    set({ schema, projects: get().projects.map((project) => project.id === state.activeProjectId ? { ...project, name: safeName } : project) });
    saveState(get);
  },

  replaceSchema: (input) => {
    try {
      const current = get();
      const validated = assertSchemaModel(input);
      const schema = { ...validated, id: current.activeProjectId };
      const previous = structuredClone(current.schema);
      set({ schema, activeProjectId: schema.id, past: [...current.past, previous], future: [], patchReview: null, lastError: null });
      saveState(get);
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : 'Schema validation failed.' });
    }
  },

  applyOperations: (operations) => {
    try {
      const current = get();
      const schema = applyPatchOperations(current.schema, operations);
      set({ schema, past: [...current.past, structuredClone(current.schema)], future: [], lastError: null });
      saveState(get);
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : 'Schema change was rejected.' });
    }
  },

  applyPatch: (patch) => {
    get().previewPatch(patch);
  },

  previewPatch: (patch) => {
    const result = schemaPatchSchema.safeParse(patch);
    if (!result.success) {
      set({ lastError: `Patch preview is invalid: ${result.error.issues.map((issue) => issue.message).join('; ')}` });
      return;
    }
    try {
      applySchemaPatch(get().schema, result.data);
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : 'This proposed patch cannot be applied.' });
      return;
    }
    set({ patchReview: { patch: result.data, itemStates: result.data.operations.map(() => 'pending'), expectedSchema: structuredClone(get().schema) }, lastError: null });
  },

  acceptPatchItem: (index) => {
    const current = get();
    const review = current.patchReview;
    if (!review || index < 0 || index >= review.patch.operations.length || review.itemStates[index] !== 'pending') return;
    try {
      if (JSON.stringify(current.schema) !== JSON.stringify(review.expectedSchema)) throw new Error('The schema changed after this preview. Generate a fresh proposal before accepting changes.');
      const schema = applyPatchOperations(current.schema, [review.patch.operations[index]!]);
      const itemStates = [...review.itemStates];
      itemStates[index] = 'accepted';
      set({ schema, past: [...current.past, structuredClone(current.schema)], future: [], patchReview: { ...review, itemStates, expectedSchema: structuredClone(schema) }, lastError: null });
      saveState(get);
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : 'This proposed change could not be applied.' });
    }
  },

  rejectPatchItem: (index) => {
    const review = get().patchReview;
    if (!review || index < 0 || index >= review.patch.operations.length || review.itemStates[index] !== 'pending') return;
    const itemStates = [...review.itemStates];
    itemStates[index] = 'rejected';
    set({ patchReview: { ...review, itemStates }, lastError: null });
  },

  clearPatchReview: () => set({ patchReview: null }),

  undo: () => {
    const current = get();
    const previous = current.past.at(-1);
    if (!previous) return;
    set({ schema: previous, past: current.past.slice(0, -1), future: [structuredClone(current.schema), ...current.future], patchReview: null, lastError: null });
    saveState(get);
  },

  redo: () => {
    const current = get();
    const next = current.future[0];
    if (!next) return;
    set({ schema: next, past: [...current.past, structuredClone(current.schema)], future: current.future.slice(1), patchReview: null, lastError: null });
    saveState(get);
  },

  saveSnapshot: (name) => {
    const state = get();
    const snapshot: NamedSnapshot = { id: crypto.randomUUID(), name: name.trim() || `Snapshot ${state.snapshots.length + 1}`, createdAt: new Date().toISOString(), schema: structuredClone(state.schema) };
    const all = [...state.snapshots, snapshot];
    const pruned = all.length > MAX_NAMED_SNAPSHOTS;
    const snapshots = pruned ? all.slice(all.length - MAX_NAMED_SNAPSHOTS) : all;
    set({ snapshots, toast: pruned ? 'Snapshot limit reached. The oldest snapshot was removed; your newest 50 are kept.' : 'Snapshot saved.', lastError: null });
    saveState(get);
    return snapshot.id;
  },

  restoreSnapshot: (snapshotId) => {
    const current = get();
    const snapshot = current.snapshots.find((item) => item.id === snapshotId);
    if (!snapshot) {
      set({ lastError: 'That snapshot could not be found.' });
      return;
    }
    const schema = assertSchemaModel(snapshot.schema);
    set({ schema: structuredClone(schema), past: [...current.past, structuredClone(current.schema)], future: [], patchReview: null, toast: `Restored “${snapshot.name}”.`, lastError: null });
    saveState(get);
  },

  deleteSnapshot: (snapshotId) => {
    set({ snapshots: get().snapshots.filter((snapshot) => snapshot.id !== snapshotId), toast: 'Snapshot removed.' });
    saveState(get);
  },

  clearToast: () => set({ toast: null }),
  clearError: () => set({ lastError: null }),
}));
