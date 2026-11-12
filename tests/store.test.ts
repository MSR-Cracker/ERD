import { beforeEach, describe, expect, it } from 'vitest';
import { pharmacySchema } from './fixtures/pharmacy';
import { projectDb, getActiveProjectId, getProjectRecord, saveActiveProjectId, saveProjectRecord } from '../src/store/projectDb';
import { flushStorePersistence, useSchemaStore } from '../src/store/store';

const testSchema = () => ({ ...structuredClone(pharmacySchema), id: 'test-pharmacy-fixture' });

const resetStore = async (): Promise<void> => {
  await flushStorePersistence();
  await projectDb.projects.clear();
  await projectDb.settings.clear();
  useSchemaStore.setState({
    projects: [],
    activeProjectId: 'initial-project',
    schema: { version: 1, id: 'initial-project', name: 'Untitled project', entities: [], relationships: [], specializations: [], subjectAreas: [], notes: [] },
    snapshots: [],
    past: [],
    future: [],
    patchReview: null,
    toast: null,
    lastError: null,
  });
};

const initializeWithFixture = async (): Promise<string> => {
  const schema = testSchema();
  const record = { id: schema.id, name: schema.name, updatedAt: new Date().toISOString(), schema, snapshots: [] };
  await saveProjectRecord(record);
  await saveActiveProjectId(record.id);
  await useSchemaStore.getState().initialize();
  return record.id;
};

beforeEach(async () => resetStore());

describe('local multi-project persistence and history', () => {
  it('starts with a blank project instead of the bundled pharmacy demo', async () => {
    await useSchemaStore.getState().initialize();
    const state = useSchemaStore.getState();
    expect(state.schema.name).toBe('Untitled project');
    expect(state.schema.entities).toEqual([]);
    expect(state.schema.relationships).toEqual([]);
    expect(state.projects).toHaveLength(1);
  });

  it('removes the old auto-seeded pharmacy demo but preserves real local projects', async () => {
    const legacy = structuredClone(pharmacySchema);
    await saveProjectRecord({ id: legacy.id, name: legacy.name, updatedAt: new Date().toISOString(), schema: legacy, snapshots: [] });
    const realSchema = { ...structuredClone(pharmacySchema), id: 'real-project', name: 'My database' };
    await saveProjectRecord({ id: realSchema.id, name: realSchema.name, updatedAt: new Date().toISOString(), schema: realSchema, snapshots: [] });
    await saveActiveProjectId(legacy.id);

    await useSchemaStore.getState().initialize();

    expect(await getProjectRecord(pharmacySchema.id)).toBeUndefined();
    expect(useSchemaStore.getState().activeProjectId).toBe('real-project');
    expect(useSchemaStore.getState().schema.name).toBe('My database');
  });

  it('autosaves edits and restores the active project after reload', async () => {
    await useSchemaStore.getState().initialize();
    const projectId = await useSchemaStore.getState().newProject('Scratchpad');
    useSchemaStore.getState().applyOperations([{ op: 'entity.add', entity: { id: 'note', name: 'Note', kind: 'strong', attributes: [], notes: '' } }]);
    await flushStorePersistence();

    const persisted = await getProjectRecord(projectId);
    expect(persisted?.schema.entities.map((entity) => entity.id)).toEqual(['note']);
    expect(await getActiveProjectId()).toBe(projectId);

    useSchemaStore.setState({ projects: [], activeProjectId: 'initial-project', schema: { version: 1, id: 'initial-project', name: 'Untitled project', entities: [], relationships: [], specializations: [], subjectAreas: [], notes: [] }, snapshots: [], past: [], future: [], patchReview: null, toast: null, lastError: null });
    await useSchemaStore.getState().initialize();
    expect(useSchemaStore.getState().activeProjectId).toBe(projectId);
    expect(useSchemaStore.getState().schema.entities[0]?.name).toBe('Note');
    expect(useSchemaStore.getState().projects).toHaveLength(2);
  });

  it('undoes and redoes a valid edit while preserving the exact schema', async () => {
    await initializeWithFixture();
    const before = structuredClone(useSchemaStore.getState().schema);
    useSchemaStore.getState().applyOperations([{ op: 'attribute.update', entityId: 'item', attributeId: 'item.name', changes: { name: 'display_name' } }]);
    await flushStorePersistence();
    expect(useSchemaStore.getState().schema.entities.find((entity) => entity.id === 'item')?.attributes[1]?.name).toBe('display_name');
    useSchemaStore.getState().undo();
    expect(useSchemaStore.getState().schema).toEqual(before);
    useSchemaStore.getState().redo();
    expect(useSchemaStore.getState().schema.entities.find((entity) => entity.id === 'item')?.attributes[1]?.name).toBe('display_name');
    await flushStorePersistence();
  });

  it('previews patch items without mutation and accepts or rejects each item independently', async () => {
    await initializeWithFixture();
    const before = structuredClone(useSchemaStore.getState().schema);
    useSchemaStore.getState().previewPatch({
      id: 'review-1', title: 'Clarify fields', summary: 'Two proposed attribute renames.', ambiguities: [],
      operations: [
        { op: 'attribute.update', entityId: 'item', attributeId: 'item.name', changes: { name: 'display_name' } },
        { op: 'attribute.update', entityId: 'item', attributeId: 'item.manufacturer', changes: { name: 'maker_name' } },
      ],
    });
    expect(useSchemaStore.getState().schema).toEqual(before);
    expect(useSchemaStore.getState().patchReview?.itemStates).toEqual(['pending', 'pending']);
    useSchemaStore.getState().acceptPatchItem(0);
    useSchemaStore.getState().rejectPatchItem(1);
    const current = useSchemaStore.getState();
    expect(current.patchReview?.itemStates).toEqual(['accepted', 'rejected']);
    expect(current.schema.entities.find((entity) => entity.id === 'item')?.attributes[1]?.name).toBe('display_name');
    expect(current.schema.entities.find((entity) => entity.id === 'item')?.attributes[4]?.name).toBe('manufacturer');
    current.undo();
    expect(useSchemaStore.getState().schema).toEqual(before);
  });

  it('saves, restores and persists named snapshots', async () => {
    const projectId = await initializeWithFixture();
    const original = structuredClone(useSchemaStore.getState().schema);
    const snapshotId = useSchemaStore.getState().saveSnapshot('Before edit');
    useSchemaStore.getState().applyOperations([{ op: 'attribute.update', entityId: 'item', attributeId: 'item.name', changes: { name: 'renamed_item' } }]);
    useSchemaStore.getState().restoreSnapshot(snapshotId);
    expect(useSchemaStore.getState().schema).toEqual(original);
    expect(useSchemaStore.getState().toast).toContain('Restored');
    await flushStorePersistence();
    const record = await getProjectRecord(projectId);
    expect(record?.snapshots[0]?.name).toBe('Before edit');
    expect(record?.schema).toEqual(original);
  });

  it('keeps the newest 50 snapshots, removes only the oldest and shows the pruning notice', async () => {
    const projectId = await initializeWithFixture();
    for (let index = 1; index <= 51; index += 1) useSchemaStore.getState().saveSnapshot(`Snapshot ${index}`);
    const snapshots = useSchemaStore.getState().snapshots;
    expect(snapshots).toHaveLength(50);
    expect(snapshots.map((snapshot) => snapshot.name)).toEqual(Array.from({ length: 50 }, (_, index) => `Snapshot ${index + 2}`));
    expect(snapshots[0]?.name).toBe('Snapshot 2');
    expect(snapshots.at(-1)?.name).toBe('Snapshot 51');
    expect(useSchemaStore.getState().toast).toContain('oldest snapshot was removed');
    await flushStorePersistence();
    const record = await getProjectRecord(projectId);
    expect(record?.snapshots).toHaveLength(50);
    expect(record?.snapshots[0]?.name).toBe('Snapshot 2');
  });
});
