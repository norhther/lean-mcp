/**
 * Fast, dependency-free token estimate.
 *
 * Uses the ~4-chars-per-token heuristic. Accurate enough for runtime budget
 * decisions (is this result too big?). The benchmark uses a real tokenizer
 * via the Anthropic API for its headline numbers.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for an arbitrary value once serialized to JSON. */
export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value) ?? "");
}
