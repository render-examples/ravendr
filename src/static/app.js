import { apiGetJson, fetchSsePost, readSseStream } from "./api-client.js";

const GITHUB_REPO = "https://github.com/ojusave/ravendr";

function renderSignupUrlWithUtms(content = "footer_link") {
  const params = new URLSearchParams({
    utm_source: "github",
    utm_medium: "referral",
    utm_campaign: "ojus_demos",
    utm_content: content,
  });
  return `https://render.com/register?${params.toString()}`;
}

document.getElementById("signup-btn").href = renderSignupUrlWithUtms("navbar_button");
document.getElementById("deploy-btn").href = `https://render.com/deploy?repo=${encodeURIComponent(GITHUB_REPO)}`;
document.getElementById("github-btn").href = GITHUB_REPO;
document.getElementById("footer-github").href = GITHUB_REPO;
document.getElementById("footer-signup").href = renderSignupUrlWithUtms("footer_link");

const statusDot = document.getElementById("status-dot");
const micBtn = document.getElementById("mic-btn");
const micLabel = document.getElementById("mic-label");
const welcome = document.getElementById("welcome");
const conversation = document.getElementById("conversation");
const controls = document.getElementById("controls");
const knowledgePanel = document.getElementById("knowledge-panel");
const workflowList = document.getElementById("workflow-list");
const reportCard = document.getElementById("report-card");
const btnKnowledge = document.getElementById("btn-knowledge");
const btnDisconnect = document.getElementById("btn-disconnect");
const pipelineFeed = document.getElementById("pipeline-feed");
const pipelineError = document.getElementById("pipeline-error");
const pipelineTimer = document.getElementById("pipeline-timer");
const btnPipeIngest = document.getElementById("btn-pipe-ingest");
const btnPipeRecall = document.getElementById("btn-pipe-recall");
const btnPipeReport = document.getElementById("btn-pipe-report");
const btnPipeCancel = document.getElementById("btn-pipe-cancel");
const pipelineDashboard = document.getElementById("pipeline-dashboard");

apiGetJson("/api/config")
  .then((cfg) => {
    if (cfg && cfg.dashboardTasksUrl && pipelineDashboard) {
      pipelineDashboard.href = cfg.dashboardTasksUrl;
    }
  })
  .catch(() => {});

let pipelineController = null;
let ws = null;
let audioContext = null;
let mediaStream = null;
let processor = null;
let connected = false;
const workflows = [];

function addMessage(text, type = "agent") {
  const div = document.createElement("div");
  div.className = `msg ${type}`;
  div.textContent = text;
  conversation.appendChild(div);
  conversation.scrollTop = conversation.scrollHeight;
}

function addWorkflow(id, type, status) {
  workflows.unshift({ id, type, status, time: new Date() });
  renderWorkflows();
}

function updateWorkflow(id, status) {
  const wf = workflows.find((w) => w.id === id);
  if (wf) wf.status = status;
  renderWorkflows();
}

function renderWorkflows() {
  workflowList.innerHTML = workflows
    .slice(0, 10)
    .map(
      (w) => `
        <div class="workflow-item">
          <div class="workflow-dot ${w.status}"></div>
          <span class="workflow-type">${w.type}</span>
          <span class="workflow-id">${w.id.slice(0, 12)}...</span>
          <span class="workflow-time">${w.time.toLocaleTimeString()}</span>
        </div>
      `
    )
    .join("");
}

async function startConversation() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/voice`);

  ws.onopen = () => {
    connected = true;
    statusDot.className = "dot live";
    micLabel.textContent = "Connecting to voice agent...";
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleEvent(data);
    } catch (e) {
      console.warn("Non-JSON WS message", e);
    }
  };

  ws.onclose = () => {
    disconnect();
  };

  ws.onerror = () => {
    addMessage("Connection error. Please try again.", "system");
    disconnect();
  };
}

function handleEvent(event) {
  const t = event.type;

  if (t === "session.ready") {
    statusDot.className = "dot recording";
    micLabel.textContent = "Listening...";
    micBtn.classList.add("active");
    welcome.style.display = "none";
    conversation.classList.add("visible");
    controls.style.display = "flex";
    startMicrophone();
  } else if (t === "input.speech.started") {
    micLabel.textContent = "Listening...";
  } else if (t === "input.speech.stopped") {
    micLabel.textContent = "Processing...";
  } else if (t === "transcript.user") {
    addMessage(event.text, "user");
  } else if (t === "pipeline") {
    appendPipelineSseEvent(event.sseEvent || "message", event.data || {});
    if (event.data?.taskRunId && event.sseEvent === "started") {
      addWorkflow(event.data.taskRunId, "workflow", "running");
    }
  } else if (t === "transcript.agent") {
    addMessage(event.text, "agent");

    if (event.text && event.text.includes("background")) {
      const idMatch = event.text.match(/trn-\w+/);
      if (idMatch) addWorkflow(idMatch[0], "ingest", "running");
    }
  } else if (t === "reply.audio") {
    playAudio(event.data);
  } else if (t === "reply.done") {
    micLabel.textContent = "Listening...";
  } else if (t === "error" || t === "session.error") {
    addMessage(`Error: ${event.message || "Unknown error"}`, "system");
  }
}

let playbackCtx = null;
let nextPlayTime = 0;

async function playAudio(base64Data) {
  if (!playbackCtx) {
    playbackCtx = new AudioContext({ sampleRate: 24000 });
    nextPlayTime = playbackCtx.currentTime;
  }
  if (playbackCtx.state === "suspended") {
    try {
      await playbackCtx.resume();
    } catch (e) {
      console.warn("AudioContext.resume failed", e);
    }
  }

  const raw = atob(base64Data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);

  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

  const buffer = playbackCtx.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);

  const source = playbackCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackCtx.destination);

  const now = playbackCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now;
  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;
}

async function startMicrophone() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 24000, channelCount: 1, echoCancellation: true },
    });

    audioContext = new AudioContext({ sampleRate: 24000 });
    const source = audioContext.createMediaStreamSource(mediaStream);

    processor = audioContext.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32768)));
      }

      const base64 = btoa(String.fromCharCode(...new Uint8Array(int16.buffer)));
      ws.send(JSON.stringify({ type: "input.audio", audio: base64 }));
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
  } catch (err) {
    addMessage("Microphone access denied. Please allow microphone access.", "system");
    disconnect();
  }
}

function disconnect() {
  connected = false;
  statusDot.className = "dot";
  micBtn.classList.remove("active");
  micLabel.textContent = "Click to start";

  if (ws) {
    ws.close();
    ws = null;
  }
  if (processor) {
    processor.disconnect();
    processor = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (playbackCtx) {
    playbackCtx.close();
    playbackCtx = null;
  }
  nextPlayTime = 0;
}

micBtn.addEventListener("click", () => {
  if (connected) {
    disconnect();
  } else {
    startConversation();
  }
});

btnDisconnect.addEventListener("click", () => {
  disconnect();
  controls.style.display = "none";
  welcome.style.display = "";
  conversation.classList.remove("visible");
});

btnKnowledge.addEventListener("click", () => {
  knowledgePanel.classList.toggle("visible");
});

function setPipelineBusy(busy) {
  btnPipeIngest.disabled = busy;
  btnPipeRecall.disabled = busy;
  btnPipeReport.disabled = busy;
  btnPipeCancel.classList.toggle("visible", busy);
}

function resetPipelineUi() {
  pipelineFeed.innerHTML = "";
  pipelineError.textContent = "";
  pipelineError.classList.remove("visible");
  pipelineTimer.textContent = "0s elapsed";
}

function appendPipelineRow(parts, variant = "") {
  const row = document.createElement("div");
  row.className = "activity-row " + variant;
  for (const p of parts) {
    if (typeof p === "string") {
      row.appendChild(document.createTextNode(p));
    } else {
      row.appendChild(p);
    }
  }
  pipelineFeed.appendChild(row);
  pipelineFeed.scrollTop = pipelineFeed.scrollHeight;
}

/** Same rows for HTTP SSE (`runSsePipeline`) and voice WebSocket `pipeline` events. */
function appendPipelineSseEvent(eventName, data) {
  if (!data || typeof data !== "object") data = {};
  if (eventName === "status") {
    const w = data.workflowStatus ? ` ${data.workflowStatus}` : "";
    const strong = document.createElement("strong");
    strong.textContent = data.phase || "status";
    appendPipelineRow([strong, document.createTextNode(`${w} (${data.elapsed ?? 0}s)`)]);
  } else if (eventName === "started") {
    if (data.dashboardUrl && pipelineDashboard) {
      pipelineDashboard.href = data.dashboardUrl;
    }
    appendPipelineRow([
      document.createTextNode("Task run "),
      (() => {
        const code = document.createElement("code");
        code.textContent = (data.taskRunId || "").slice(0, 36);
        return code;
      })(),
    ]);
  } else if (eventName === "done") {
    const pre = document.createElement("pre");
    pre.style.margin = "0.35rem 0 0";
    pre.style.fontSize = "0.65rem";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.wordBreak = "break-all";
    const text = JSON.stringify(data.result ?? {}, null, 2);
    pre.textContent = text.length > 4000 ? text.slice(0, 4000) + "\n..." : text;
    appendPipelineRow([document.createTextNode("Done "), pre], "done");
  } else if (eventName === "error") {
    const msg = typeof data === "string" ? data : data.message || JSON.stringify(data);
    pipelineError.textContent = msg;
    pipelineError.classList.add("visible");
    appendPipelineRow([document.createTextNode("Error: " + msg)], "err");
  }
}

async function runSsePipeline(url, bodyObj) {
  if (pipelineController) {
    pipelineController.abort();
  }
  pipelineController = new AbortController();
  const signal = pipelineController.signal;
  setPipelineBusy(true);
  resetPipelineUi();
  const t0 = Date.now();
  const tick = setInterval(() => {
    pipelineTimer.textContent = `${Math.floor((Date.now() - t0) / 1000)}s elapsed`;
  }, 500);
  try {
    const res = await fetchSsePost(url, bodyObj, signal);
    await readSseStream(res, appendPipelineSseEvent);
  } catch (e) {
    if (e && e.name === "AbortError") {
      appendPipelineRow([document.createTextNode("Cancelled (request aborted).")], "");
      return;
    }
    pipelineError.textContent = e && e.message ? e.message : String(e);
    pipelineError.classList.add("visible");
  } finally {
    clearInterval(tick);
    pipelineTimer.textContent = `${Math.floor((Date.now() - t0) / 1000)}s elapsed`;
    setPipelineBusy(false);
    pipelineController = null;
  }
}

btnPipeCancel.addEventListener("click", () => {
  if (pipelineController) pipelineController.abort();
});

btnPipeIngest.addEventListener("click", () => {
  const topic = document.getElementById("pipe-topic").value.trim();
  const claim = document.getElementById("pipe-claim").value.trim();
  if (!topic || !claim) {
    pipelineError.textContent = "Enter both topic and claim.";
    pipelineError.classList.add("visible");
    return;
  }
  runSsePipeline("/api/pipeline/ingest", { topic, claim });
});

btnPipeRecall.addEventListener("click", () => {
  const query = document.getElementById("pipe-query").value.trim();
  if (!query) {
    pipelineError.textContent = "Enter a recall query.";
    pipelineError.classList.add("visible");
    return;
  }
  runSsePipeline("/api/pipeline/recall", { query });
});

btnPipeReport.addEventListener("click", () => {
  runSsePipeline("/api/pipeline/report", {});
});

setInterval(async () => {
  if (!connected) return;
  const running = workflows.filter((w) => w.status === "running");
  if (running.length === 0) return;

  try {
    const data = await apiGetJson("/api/workflows/recent");
    for (const run of data) {
      const existing = workflows.find((w) => w.id === run.id);
      if (existing && existing.status !== run.status) {
        existing.status = run.status;
      }
    }
    renderWorkflows();
  } catch {
    /* ignore poll errors */
  }
}, 5000);
