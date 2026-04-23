// Orchestrator: connects the mic button to the WebSocket + SSE + ribbon.

import {
  createSession,
  openEventStream,
  openVoiceSocket,
  fetchBriefing,
} from "/api-client.js";
import { startCapture, createPlayer } from "/mic.js";
import { createRibbon } from "/chain-ribbon.js";

const micEl = document.getElementById("mic");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const briefingEl = document.getElementById("briefing");
const briefingTopic = document.getElementById("briefing-topic");
const briefingBody = document.getElementById("briefing-body");
const briefingSources = document.getElementById("briefing-sources");
const ribbon = createRibbon(document.getElementById("ribbon"));

let active = false;
let stopCapture = null;
let ws = null;
let closeEvents = null;
const player = createPlayer();

function setStatus(text) {
  statusEl.textContent = text;
}

function log(line, event) {
  const el = document.createElement("div");
  el.className = "line";
  const stamp = new Date(event?.at ?? Date.now()).toLocaleTimeString();
  el.innerHTML = `<b>${stamp}</b> · ${line}`;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

function handleEvent(event) {
  ribbon.onEvent(event);
  const summary = summarize(event);
  if (summary) log(summary, event);
  if (event.kind === "briefing.ready") {
    showBriefing(event.briefingId);
  } else if (event.kind === "workflow.failed") {
    setStatus("Something went wrong");
  }
}

function summarize(e) {
  switch (e.kind) {
    case "session.started": return `session.started — ${e.topic}`;
    case "workflow.dispatched": return `workflow.dispatched — ${e.runId}`;
    case "workflow.started": return `workflow.started — ${e.runId}`;
    case "workflow.completed": return `workflow.completed — briefing ${e.briefingId}`;
    case "workflow.failed": return `workflow.failed — ${e.message}`;
    case "agent.planning": return `agent.planning — ${e.step}`;
    case "agent.synthesizing": return "agent.synthesizing";
    case "youcom.call.started": return `youcom.call.started — ${e.tier} — ${e.query.slice(0, 48)}`;
    case "youcom.call.completed": return `youcom.call.completed — ${e.sourceCount} sources — ${e.latencyMs}ms`;
    case "briefing.ready": return `briefing.ready — ${e.sourceCount} sources`;
    case "narrator.speech": return `narrator: ${e.text}`;
    default: return null;
  }
}

async function showBriefing(briefingId) {
  try {
    const { briefing, sources } = await fetchBriefing(briefingId);
    briefingTopic.textContent = briefing.topic;
    briefingBody.textContent = briefing.content ?? "";
    briefingSources.innerHTML = "";
    for (const s of sources) {
      const row = document.createElement("div");
      row.className = "source";
      row.innerHTML = `<a href="${s.url}" target="_blank" rel="noopener">${escape(s.title)}</a>${
        s.snippet ? ` — <span style="color:var(--muted)">${escape(s.snippet.slice(0, 200))}</span>` : ""
      }`;
      briefingSources.appendChild(row);
    }
    briefingEl.classList.add("show");
    setStatus("Done. Scroll to read.");
  } catch (err) {
    setStatus(`Failed to load briefing: ${err.message}`);
  }
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function start() {
  if (active) return;
  active = true;
  micEl.classList.add("active");
  setStatus("Connecting…");
  ribbon.reset();
  logEl.innerHTML = "";
  briefingEl.classList.remove("show");

  const sessionId = await createSession();
  closeEvents = openEventStream(sessionId, handleEvent);
  ws = openVoiceSocket(sessionId, {
    onReady: () => setStatus("Listening — tell me what to research."),
    onAudio: (b64) => player.enqueue(b64),
    onEvent: handleEvent,
    onError: (msg) => setStatus(`Voice error: ${msg}`),
    onClose: () => active && stop(),
  });

  try {
    stopCapture = await startCapture((audio) => ws.send({ type: "audio", audio }));
  } catch (err) {
    setStatus(`Mic denied: ${err.message}`);
    await stop();
  }
}

async function stop() {
  if (!active) return;
  active = false;
  micEl.classList.remove("active");
  setStatus("Stopped");
  stopCapture?.();
  ws?.close();
  closeEvents?.();
  stopCapture = null; ws = null; closeEvents = null;
}

micEl.addEventListener("click", () => (active ? stop() : start()));
