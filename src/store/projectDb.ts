import Dexie, { type Table } from 'dexie';
import type { ProjectRecord } from '../model/types';

interface SettingRecord {
  key: string;
  value: string;
}

export class ERDForgeDatabase extends Dexie {
  projects!: Table<ProjectRecord, string>;
  settings!: Table<SettingRecord, string>;

  constructor(name = 'erdforge-local-v1') {
    super(name);
    this.version(1).stores({
      projects: 'id, name, updatedAt',
    });
    this.version(2).stores({
      projects: 'id, name, updatedAt',
      settings: 'key',
    });
  }
}

export const projectDb = new ERDForgeDatabase();

export async function saveProjectRecord(record: ProjectRecord): Promise<void> {
  await projectDb.projects.put(record);
}

export async function getProjectRecord(id: string): Promise<ProjectRecord | undefined> {
  return projectDb.projects.get(id);
}

export async function listProjectRecords(): Promise<ProjectRecord[]> {
  return projectDb.projects.orderBy('updatedAt').reverse().toArray();
}

export async function deleteProjectRecord(id: string): Promise<void> {
  await projectDb.projects.delete(id);
}

export async function saveActiveProjectId(id: string): Promise<void> {
  await projectDb.settings.put({ key: 'activeProjectId', value: id });
}

export async function getActiveProjectId(): Promise<string | undefined> {
  return (await projectDb.settings.get('activeProjectId'))?.value;
}
