/**
 * Map a final user transcript to a pipeline action. Used when the speech model
 * answers without emitting tool.call — workflows would otherwise never start.
 */
export type TranscriptPipelineIntent =
  | { kind: "recall"; query: string }
  | { kind: "report" }
  | { kind: "learn"; topic: string; claim: string };

export function matchTranscriptPipelineIntent(
  text: string
): TranscriptPipelineIntent | null {
  const t = text.trim();
  if (t.length < 4) return null;

  if (
    /\b(full\s+)?knowledge\s+report\b|\bgenerate\s+(a\s+)?report\b|\bsynthesis\s+report\b|\beverything\s+i(?:'ve| have)\s+learned\b/i.test(
      t
    )
  ) {
    return { kind: "report" };
  }

  if (
    /\bwhat\s+(do\s+)?i\s+know\b|\brecall\b|\bwhat\s+(have\s+)?i\s+(learned|stored)\b|\bsummarize\s+(my\s+)?(stored\s+)?knowledge\b|\bwhat(?:'s|s| is)\s+in\s+my\s+knowledge\b/i.test(
      t
    )
  ) {
    const about = t.match(/\babout\s+(.+)/i);
    const query = (about ? about[1] : t).trim();
    return { kind: "recall", query: query || t };
  }

  if (
    /\blearn\s+about\b|\bresearch\b|\bverify\b|\bfact[- ]?check\b|\btell\s+me\s+about\b/i.test(
      t
    )
  ) {
    const m =
      t.match(/\b(?:learn\s+about|tell\s+me\s+about)\s+(.+)/i) ??
      t.match(/\b(?:research|verify|fact[- ]?check)\s+(.+)/i);
    const rest = (m ? m[1] : t).trim();
    const slice = rest.slice(0, 500);
    return { kind: "learn", topic: slice.slice(0, 200), claim: slice };
  }

  return null;
}

let lastDispatch: { key: string; at: number } | null = null;

/** Suppress duplicate dispatches from partial retries or model+server both firing. */
export function shouldSkipDuplicateDispatch(intent: TranscriptPipelineIntent): boolean {
  const key =
    intent.kind === "recall"
      ? `recall:${intent.query.toLowerCase()}`
      : intent.kind === "report"
        ? "report"
        : `learn:${intent.topic.toLowerCase()}`;
  const now = Date.now();
  if (
    lastDispatch &&
    lastDispatch.key === key &&
    now - lastDispatch.at < 12_000
  ) {
    return true;
  }
  lastDispatch = { key, at: now };
  return false;
}
