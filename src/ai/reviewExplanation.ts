export interface ReviewExplanationInput {
  privacyAcknowledged: true;
  finding: {
    ruleId: string;
    title: string;
    explanation: string;
    entityName?: string;
    attributeName?: string;
  };
}

export async function requestReviewExplanation(input: ReviewExplanationInput, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/ai/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new Error('ERDForge could not reach its AI Worker. Try again.');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== 'object') {
    const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
      ? body.message
      : `AI explanation failed with status ${response.status}.`;
    throw new Error(message);
  }
  const explanation = (body as { explanation?: unknown }).explanation;
  if (typeof explanation !== 'string' || !explanation.trim()) throw new Error('The AI Worker returned no explanation.');
  return explanation.trim();
}
