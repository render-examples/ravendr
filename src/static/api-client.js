/**
 * Single browser entry for JSON APIs — matches server `shared/api-envelope.ts`.
 * SSE pipeline streams are not envelopes; only the HTTP error body may be JSON envelope.
 */

export async function apiGetJson(path) {
  const res = await fetch(path, {
    headers: { Accept: "application/json" },
  });
  return parseEnvelopeResponse(res);
}

export async function apiPostJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  return parseEnvelopeResponse(res);
}

async function parseEnvelopeResponse(res) {
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    const err = new Error(res.statusText || "Invalid JSON");
    err.status = res.status;
    throw err;
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid API response");
  }
  if (parsed.error) {
    const err = new Error(parsed.error.message || "Request failed");
    err.code = parsed.error.code;
    err.details = parsed.error.details;
    err.status = res.status;
    throw err;
  }
  if (!("data" in parsed)) {
    throw new Error("Invalid API envelope");
  }
  return parsed.data;
}

/**
 * POST that returns text/event-stream. On failure, parses JSON envelope from body if present.
 */
export async function fetchSsePost(url, bodyObj, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(bodyObj ?? {}),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = res.statusText || "Request failed";
    try {
      const j = JSON.parse(text);
      if (j?.error?.message) msg = j.error.message;
    } catch {
      if (text) msg = text.slice(0, 500);
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res;
}

/** Consume an SSE response body; invokes onEvent(name, dataObj) per event. */
export async function readSseStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let eventName = "message";
      const dataParts = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataParts.push(line.slice(5).trimStart());
      }
      const raw = dataParts.join("\n");
      if (!raw) continue;
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { message: raw };
      }
      onEvent(eventName, data);
    }
  }
}
