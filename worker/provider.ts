import type { SchemaPatch } from '../src/model/types';
import { generateValidatedPatch, type GeminiEnvironment, type AIProgress } from './gemini';

export type PatchProposalRequest = Omit<Parameters<typeof generateValidatedPatch>[0], 'env'>;

export interface SchemaAIProvider<TEnvironment extends object = GeminiEnvironment> {
  readonly id: string;
  propose(input: PatchProposalRequest & { env: TEnvironment }): Promise<SchemaPatch>;
}

export const geminiProvider: SchemaAIProvider<GeminiEnvironment> = {
  id: 'gemini',
  propose: generateValidatedPatch,
};

export type { AIProgress };
