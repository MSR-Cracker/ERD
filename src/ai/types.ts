export interface AIProgress {
  phase: 'connecting' | 'generating' | 'validating' | 'retrying';
  message: string;
  chunksReceived?: number;
}
