import { You } from "@youdotcom-oss/sdk";

const apiKey = process.env.YOU_API_KEY ?? "";
if (!apiKey) {
  console.warn("[you-client] YOU_API_KEY is not set - research calls will fail");
}

const you = new You({ apiKeyAuth: apiKey });

export type ResearchEffort = "lite" | "standard" | "deep" | "exhaustive";

export interface ResearchResult {
  content: string;
  sources: { url: string; title: string; snippet: string }[];
}

export async function research(
  query: string,
  effort: ResearchEffort = "standard"
): Promise<ResearchResult> {
  console.log(`[you-client] research(${effort}): ${query.slice(0, 80)}...`);
  
  if (!apiKey) {
    console.error("[you-client] Cannot call You.com API - YOU_API_KEY is not set");
    return { content: "", sources: [] };
  }

  try {
    const result = await you.research({
      input: query,
      researchEffort: effort,
    });

    const output = result.output as {
      content?: string;
      sources?: { url?: string; title?: string; snippet?: string }[];
    };

    const res = {
      content: output.content ?? "",
      sources: (output.sources ?? []).map((s) => ({
        url: s.url ?? "",
        title: s.title ?? "",
        snippet: s.snippet ?? "",
      })),
    };

    console.log(`[you-client] research(${effort}) returned ${res.content.length} chars, ${res.sources.length} sources`);
    return res;
  } catch (err) {
    console.error(`[you-client] research(${effort}) failed:`, err);
    throw err;
  }
}

export async function quickSearch(query: string): Promise<ResearchResult> {
  return research(query, "lite");
}

export async function deepResearch(query: string): Promise<ResearchResult> {
  return research(query, "deep");
}
