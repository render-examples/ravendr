import type {
  ResearchProvider,
  ResearchInput,
  ResearchResult,
} from "../shared/ports.js";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

export interface YouComConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}

interface YouComRawSource {
  url: string;
  title: string;
  snippets?: string[];
  snippet?: string;
}

interface YouComRawResponse {
  output: {
    content: string;
    content_type: string;
    sources: YouComRawSource[];
  };
}

// Tier → effort name per You.com docs (lite / standard / deep / exhaustive).
// We expose only lite / standard / deep; exhaustive can be added later.
const EFFORT: Record<string, string> = {
  lite: "lite",
  standard: "standard",
  deep: "deep",
};

export function createYouComResearch(config: YouComConfig): ResearchProvider {
  const timeoutMs = config.timeoutMs ?? 300_000;

  return {
    async research(input: ResearchInput): Promise<ResearchResult> {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      input.signal?.addEventListener("abort", () => controller.abort(), {
        once: true,
      });

      try {
        const res = await fetch(`${config.baseUrl}/research`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            input: input.query,
            research_effort: EFFORT[input.tier] ?? "lite",
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new AppError(
            "UPSTREAM_RESEARCH",
            `You.com returned ${res.status}: ${body.slice(0, 200)}`
          );
        }

        const raw = (await res.json()) as YouComRawResponse;
        const sources = (raw.output.sources ?? []).map((s) => ({
          url: s.url,
          title: s.title,
          snippet: s.snippet ?? s.snippets?.[0],
        }));

        return {
          content: raw.output.content,
          sources,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error({ err, query: input.query }, "youcom.research failed");
        throw new AppError("UPSTREAM_RESEARCH", "Research call failed", {
          cause: err,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
