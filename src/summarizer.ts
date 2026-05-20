import { estimateTokens } from "./tokens.js";

const DEFAULT_BUDGET_TOKENS = 2000;
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export type SummarizeMethod = "inline" | "llm" | "truncated";

export interface SummarizeResult {
  /** The text to place into the model's context. */
  text: string;
  /** True when the original was reduced (by LLM or truncation). */
  reduced: boolean;
  method: SummarizeMethod;
  originalTokens: number;
}

export interface SummarizerOptions {
  /** Results estimated above this many tokens get reduced. */
  budgetTokens?: number;
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY. */
  apiKey?: string;
  model?: string;
  /** Override the LLM call — used for testing and to keep the path injectable. */
  llmSummarize?: (content: string) => Promise<string>;
}

/**
 * Reduce an oversized tool result.
 *
 * Under budget: returned unchanged. Over budget with an LLM available:
 * summarized by Claude Haiku. Over budget with no LLM (or on LLM failure):
 * head/tail truncation. The call never fails because summarization failed.
 */
export async function summarize(
  content: string,
  options: SummarizerOptions = {},
): Promise<SummarizeResult> {
  const budget = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const originalTokens = estimateTokens(content);

  if (originalTokens <= budget) {
    return { text: content, reduced: false, method: "inline", originalTokens };
  }

  const llm = resolveLlm(options);
  if (llm) {
    try {
      const text = await llm(content);
      return { text, reduced: true, method: "llm", originalTokens };
    } catch {
      // fall through to deterministic truncation
    }
  }

  return {
    text: truncate(content, budget),
    reduced: true,
    method: "truncated",
    originalTokens,
  };
}

function resolveLlm(
  options: SummarizerOptions,
): ((content: string) => Promise<string>) | undefined {
  if (options.llmSummarize) return options.llmSummarize;
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  const model = options.model ?? DEFAULT_MODEL;
  return (content: string) => anthropicSummarize(content, apiKey, model);
}

/** Head/tail truncation that keeps both ends of the result. */
function truncate(content: string, budgetTokens: number): string {
  const budgetChars = budgetTokens * 4;
  if (content.length <= budgetChars) return content;
  const half = Math.floor(budgetChars / 2);
  const head = content.slice(0, half);
  const tail = content.slice(content.length - half);
  const omitted = content.length - head.length - tail.length;
  return (
    `${head}\n\n` +
    `...[truncated ${omitted} chars — full result available via read_result]...\n\n` +
    `${tail}`
  );
}

async function anthropicSummarize(
  content: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content:
          "Summarize this MCP tool result concisely. Preserve key facts, " +
          "IDs, names, counts, and any error text. Output only the summary.\n\n" +
          content,
      },
    ],
  });
  const block = message.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("No text block in summary response");
  }
  return block.text;
}
