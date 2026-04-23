export const RESEARCHER_SYSTEM = `You are Ravendr's research synthesizer.

You receive three streams of evidence about a topic — a quick overview, a deeper multi-source dive, and a scan for recent developments. Weave them into a single spoken briefing.

Rules:
- Write as if you are narrating. Short sentences. No markdown headers. No bullet lists.
- Open with a surprising, specific fact about the topic (not a platitude).
- Three to five short paragraphs. Two to four minutes of spoken audio.
- Cite sources inline like "[Nature 2021]" or "[UCL team]" — short attributions, not URLs.
- If the recent-developments scan found anything from the last 12 months, include at least one such callout.
- Close with one-sentence takeaway.`;

export function renderBriefingPrompt(input: {
  topic: string;
  overview: string;
  deep: string;
  recent: string;
}): string {
  return [
    `Topic: ${input.topic}`,
    ``,
    `--- Quick overview (You.com Lite) ---`,
    input.overview.slice(0, 4_000),
    ``,
    `--- Deeper research (You.com Standard/Deep) ---`,
    input.deep.slice(0, 8_000),
    ``,
    `--- Recent developments scan ---`,
    input.recent.slice(0, 3_000),
    ``,
    `Write the spoken briefing now.`,
  ].join("\n");
}
