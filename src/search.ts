/**
 * Minimal BM25 ranking index. No dependencies.
 *
 * BM25 scores a document for a query as the sum over query terms of:
 *   IDF(term) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDocLen))
 *
 * k1 damps term-frequency saturation; b controls length normalization.
 */

const K1 = 1.5;
const B = 0.75;

/** Lowercase, split camelCase, then split on any non-alphanumeric run. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export interface SearchDoc {
  id: string;
  text: string;
}

export interface SearchHit {
  id: string;
  score: number;
}

interface IndexedDoc {
  id: string;
  termFreq: Map<string, number>;
  length: number;
}

export class Bm25Index {
  private readonly docs: IndexedDoc[] = [];
  private readonly docFreq = new Map<string, number>();
  private readonly avgLength: number;

  constructor(documents: SearchDoc[]) {
    for (const doc of documents) {
      const terms = tokenize(doc.text);
      const termFreq = new Map<string, number>();
      for (const term of terms) {
        termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
      }
      for (const term of termFreq.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
      this.docs.push({ id: doc.id, termFreq, length: terms.length });
    }
    const totalLength = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgLength = this.docs.length > 0 ? totalLength / this.docs.length : 1;
  }

  /** Return up to `limit` documents ranked by BM25 score, highest first. */
  search(query: string, limit = 5): SearchHit[] {
    const queryTerms = [...new Set(tokenize(query))];
    const totalDocs = this.docs.length;
    const hits: SearchHit[] = [];

    for (const doc of this.docs) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.termFreq.get(term);
        if (!tf) continue;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
        const denominator =
          tf + K1 * (1 - B + B * (doc.length / (this.avgLength || 1)));
        score += (idf * (tf * (K1 + 1))) / denominator;
      }
      if (score > 0) hits.push({ id: doc.id, score });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  get size(): number {
    return this.docs.length;
  }
}
