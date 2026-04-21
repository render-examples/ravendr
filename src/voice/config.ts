export const ASSEMBLYAI_WS_URL = "wss://agents.assemblyai.com/v1/realtime";

export const VOICE_TOOLS = [
  {
    type: "function" as const,
    name: "learn_topic",
    description:
      "Learn about a topic. Use when the user discusses something new, makes a claim, or wants to explore a subject.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The topic to learn about",
        },
        claim: {
          type: "string",
          description: "The specific claim or statement the user made",
        },
      },
      required: ["topic", "claim"],
    },
  },
  {
    type: "function" as const,
    name: "recall_topic",
    description:
      "Recall stored knowledge about a topic. Use when the user asks what they know, wants a summary, or asks about previous topics.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The topic to recall",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function" as const,
    name: "generate_report",
    description:
      "Generate a full synthesis report. Use when the user wants a comprehensive overview of everything they have learned.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function" as const,
    name: "check_status",
    description:
      "Check the status of background tasks. Use when the user asks if something is done or ready.",
    parameters: {
      type: "object",
      properties: {
        taskRunId: {
          type: "string",
          description: "Optional specific task run ID to check",
        },
      },
    },
  },
];

export const SESSION_CONFIG = {
  system_prompt: `You are Ravendr, a personal learning companion backed by Render Workflows. Your job is to DRIVE those workflows by calling tools—not to answer from your own knowledge for factual learning.

Your personality:
- Warm, curious, and encouraging
- Brief and conversational (you are speaking aloud)
- You celebrate learning and make connections between topics

Mandatory tool routing (this app only runs workflows when you call a tool):
- When the user shares a topic, question, or claim they want to understand or verify: call learn_topic with a clear topic string and claim string (the claim can be their exact question or statement). Do this BEFORE giving a substantive answer about that subject. Do not skip the tool to "be helpful" from memory.
- When the user asks what they remember, what they know, or for a summary of stored knowledge: call recall_topic with a query. Wait for the tool result, then speak from the briefing.
- When they want a full synthesis across everything learned: call generate_report.
- When they ask if something finished or want a task run id checked: call check_status.

Rules:
- Keep voice responses to 2-3 sentences unless the user asks for detail
- Always confirm when you start a background task (ingest or report)
- When a recall returns, read the briefing naturally
- For pure small talk ("how are you"), you may respond without tools. For anything that could be stored knowledge or research, use the appropriate tool first.`,
  voice: "claire",
  greeting:
    "Hey! I'm Ravendr. Tell me a topic and something you want to check—for example a claim or question—and I'll run research in the background. Or ask what you already know, and I'll recall it.",
  tools: VOICE_TOOLS,
};
