// Single API client for the frontend. All HTTP / WS URLs go through here.

export async function startSession() {
  const res = await fetch("/api/start", { method: "POST" });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.data.sessionId;
}

export async function fetchBriefing(briefingId) {
  const res = await fetch(`/api/briefings/${briefingId}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.data;
}

export function openEventStream(sessionId, onEvent) {
  const es = new EventSource(`/api/sessions/${sessionId}/events`);
  es.addEventListener("phase", (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {}
  });
  return () => es.close();
}

/**
 * Browser audio WebSocket — connects to the web service broker which
 * pipes to the voiceSession workflow task over the reverse WS.
 */
export function openClientSocket(sessionId, handlers) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${scheme}//${location.host}/ws/client?sessionId=${encodeURIComponent(sessionId)}`
  );
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "audio" && typeof msg.audio === "string") {
      handlers.onAudio?.(msg.audio);
    } else if (msg.type === "transcript") {
      handlers.onTranscript?.(msg);
    } else if (msg.type === "ready") {
      handlers.onReady?.();
    } else if (msg.type === "error") {
      handlers.onError?.(msg.message);
    }
  });
  ws.addEventListener("close", () => handlers.onClose?.());
  return {
    send(payload) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    },
    close() {
      ws.close();
    },
  };
}
