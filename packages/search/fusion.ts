export interface ScoreParts {
  structured?: number;
  vector?: number;
  full_text?: number;
}

// Deterministic score fusion with fixed weights.
export function fusionWeights(fullTextEnabled: boolean): Record<string, number> {
  return fullTextEnabled ? { structured: 0.25, vector: 0.55, full_text: 0.2 } : { structured: 0.3, vector: 0.7 };
}

export function fuseScores(scores: Map<string, ScoreParts>, fullTextEnabled: boolean) {
  const weights = fusionWeights(fullTextEnabled);
  const fused = new Map<string, number>();
  for (const [personId, parts] of scores) {
    let score = 0;
    for (const [part, weight] of Object.entries(weights)) score += (parts[part as keyof ScoreParts] ?? 0) * weight;
    fused.set(personId, Number(score.toFixed(4)));
  }
  return { fused, weights };
}
