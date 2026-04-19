import { $, toast } from "./utils.js";
import { getJSON, postJSON } from "./api.js";

let _models = [];           // latest list from API
let _refreshTimer = null;

const TASK_DESCRIPTIONS = {
  CustomVoice: {
    nice: "Preset voice",
    sub: "9 built-in speakers · instruction-controlled style",
    badge: "badge-preset",
  },
  VoiceDesign: {
    nice: "Design voice",
    sub: "Invent a new voice from a description",
    badge: "badge-design",
  },
  Base: {
    nice: "Clone voice",
    sub: "Clone from a reference audio clip",
    badge: "badge-clone",
  },
};

const STATE_LABEL = {
  up: "Loaded",
  stopped: "Unloaded",
  starting: "Loading…",
  down: "Down",
  fatal: "Failed",
};

export function getModels() { return _models; }

function renderSkeletons(container, count = 3) {
  if (!container) return;
  container.replaceChildren();
  const grid = document.createElement("div");
  grid.className = "skeleton-grid cols";
  for (let i = 0; i < count; i++) {
    const s = document.createElement("div");
    s.className = "skeleton";
    s.innerHTML = `
      <div class="skeleton-line md"></div>
      <div class="skeleton-line sm"></div>
      <div class="skeleton-line lg"></div>
    `;
    grid.appendChild(s);
  }
  container.appendChild(grid);
}

export async function refreshModels({ onUpdate, showSkeleton = false } = {}) {
  if (showSkeleton) renderSkeletons($("#models-list"));
  try {
    const data = await getJSON("/v1/admin/models");
    _models = data.models || [];
    if (onUpdate) onUpdate(_models);
  } catch (e) {
    toast(`Could not list models: ${e.message}`, "err");
  }
  return _models;
}

export function renderModelsList(container) {
  container.replaceChildren();
  if (!_models.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No models registered.";
    container.appendChild(empty);
    return;
  }
  for (const m of _models) {
    const meta = TASK_DESCRIPTIONS[m.task_type] || { nice: m.task_type, sub: "", badge: "" };
    const card = document.createElement("div");
    card.className = `model-card ${stateClass(m.status)}`;
    card.innerHTML = `
      <div class="mc-head">
        <div>
          <div class="mc-title">${escapeHtml(meta.nice)}</div>
          <div class="mc-subtitle">${escapeHtml(meta.sub)}</div>
        </div>
        <span class="state-pill ${stateClass(m.status)}">${escapeHtml(STATE_LABEL[m.status] || m.status)}</span>
      </div>
      <div class="mc-detail">
        <div><strong>Task:</strong> <code>${escapeHtml(m.task_type)}</code></div>
        <div><strong>Port:</strong> ${portFromUrl(m.url)} · <strong>~${m.size_gb} GB</strong></div>
        <div><strong>Weights:</strong> <code>${escapeHtml(shortenPath(m.model_path))}</code></div>
        ${m.last_error ? `<div style="color:var(--danger);margin-top:4px"><strong>Error:</strong> ${escapeHtml(m.last_error)}</div>` : ""}
      </div>
      <div class="mc-actions">
        <button class="load" data-task="${m.task_type}" ${m.status === "up" || m.status === "starting" ? "disabled" : ""}>Load</button>
        <button class="unload" data-task="${m.task_type}" ${m.status !== "up" && m.status !== "starting" ? "disabled" : ""}>Unload</button>
      </div>
    `;
    container.appendChild(card);
  }
}

function stateClass(s) {
  return ["up", "stopped", "starting", "down", "fatal"].includes(s) ? s : "down";
}

function portFromUrl(u) {
  try { return new URL(u).port; } catch { return "?"; }
}

function shortenPath(p) {
  return p ? p.replace(/^.*\/models\//, "…/models/") : "";
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function actOnModel(taskType, action) {
  const url = `/v1/admin/models/${encodeURIComponent(taskType)}/${action}?wait=true`;
  // Optimistic UI: mark starting immediately so the user sees feedback.
  const row = _models.find((x) => x.task_type === taskType);
  if (row) row.status = action === "load" ? "starting" : "stopped";
  renderModelsList($("#models-list"));
  try {
    const r = await fetch(url, { method: "POST" });
    if (!r.ok) throw new Error(`${action} → ${r.status}: ${await r.text()}`);
    const data = await r.json();
    toast(data.success
      ? `${taskType} ${action === "load" ? "loaded" : "unloaded"}`
      : `${taskType} ${action} partial: ${data.error || data.status}`,
      data.success ? "ok" : "err", 3500);
  } catch (e) {
    toast(e.message, "err", 5000);
  } finally {
    await refreshModels();
    renderModelsList($("#models-list"));
  }
}

async function actOnAll(action) {
  const url = `/v1/admin/models/all/${action}`;
  for (const m of _models) m.status = action === "load" ? "starting" : "stopped";
  renderModelsList($("#models-list"));
  try {
    const r = await fetch(url, { method: "POST" });
    if (!r.ok) throw new Error(`${action} all → ${r.status}`);
    const data = await r.json();
    toast(data.success ? `All ${action}ed` : `${action} all: partial`, data.success ? "ok" : "err");
  } catch (e) {
    toast(e.message, "err", 5000);
  } finally {
    await refreshModels();
    renderModelsList($("#models-list"));
  }
}

export function wireModelsTab() {
  const list = $("#models-list");

  // Delegated click handling for load / unload buttons inside cards
  list.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-task]");
    if (!btn) return;
    const task = btn.dataset.task;
    const action = btn.classList.contains("load") ? "load" : "unload";
    actOnModel(task, action);
  });

  $("#models-load-all").addEventListener("click", () => actOnAll("load"));
  $("#models-unload-all").addEventListener("click", () => actOnAll("unload"));
  $("#models-refresh").addEventListener("click", async () => {
    await refreshModels();
    renderModelsList(list);
  });
}

export function startModelsPolling(intervalMs = 5000) {
  stopModelsPolling();
  _refreshTimer = setInterval(async () => {
    await refreshModels();
    // Only re-render if the Models tab is currently visible — avoids layout churn.
    if (document.querySelector('.panel[data-panel="models"]').classList.contains("active")) {
      renderModelsList($("#models-list"));
    }
  }, intervalMs);
}

export function stopModelsPolling() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}
