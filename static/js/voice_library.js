import { $, toast, fmtBytes, fillSelect } from "./utils.js";
import { listVoices, del } from "./api.js";

let _cache = { voices: [], uploaded_voices: [], builtin_by_task: {} };

export function getCache() { return _cache; }

function renderLibrarySkeleton(container, count = 3) {
  if (!container) return;
  container.replaceChildren();
  for (let i = 0; i < count; i++) {
    const s = document.createElement("div");
    s.className = "skeleton";
    s.innerHTML = `
      <div class="skeleton-line md"></div>
      <div class="skeleton-line sm"></div>
    `;
    container.appendChild(s);
  }
}

export async function refreshVoices({ onUpdate, showSkeleton = false } = {}) {
  if (showSkeleton) renderLibrarySkeleton($("#library-list"));
  try {
    _cache = await listVoices();
  } catch (e) {
    toast(`Failed to list voices: ${e.message}`, "err");
    return _cache;
  }
  if (onUpdate) onUpdate(_cache);
  return _cache;
}

export function renderLibraryList(container) {
  container.replaceChildren();
  const uploaded = _cache.uploaded_voices || [];
  if (!uploaded.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No cloned voices yet. Upload one from the Clone voice tab.";
    container.appendChild(empty);
    return;
  }
  for (const v of uploaded) {
    const card = document.createElement("div");
    card.className = "voice-card";
    card.innerHTML = `
      <div class="row">
        <div>
          <div class="name">${escapeHtml(v.name)}</div>
          <div class="desc">${escapeHtml(v.speaker_description || "")} · ${fmtBytes(v.file_size || 0)}</div>
        </div>
        <div class="actions">
          <button class="ghost" data-action="use">Use in Clone</button>
          <button class="ghost" data-action="delete">Delete</button>
        </div>
      </div>
      <audio controls preload="none" src="/v1/audio/voices/${encodeURIComponent(v.name)}/preview"></audio>
      ${v.ref_text ? `<div class="desc">"${escapeHtml(v.ref_text)}"</div>` : ""}
    `;
    card.querySelector("[data-action=use]").addEventListener("click", () => {
      document.querySelector('[data-tab="clone"]').click();
      document.querySelector('[data-clone-mode="library"]').click();
      const sel = document.querySelector("#clone-library-voice");
      if (sel) {
        sel.value = v.name;
        sel.dispatchEvent(new Event("change"));
      }
    });
    card.querySelector("[data-action=delete]").addEventListener("click", async () => {
      if (!confirm(`Delete voice "${v.name}"?`)) return;
      try {
        await del(`/v1/audio/voices/${encodeURIComponent(v.name)}`);
        toast(`Deleted ${v.name}`);
        await refreshVoices();
        renderLibraryList(container);
        syncLibrarySelect(document.querySelector("#clone-library-voice"));
      } catch (e) {
        toast(e.message, "err");
      }
    });
    container.appendChild(card);
  }
}

export function syncLibrarySelect(selectEl) {
  if (!selectEl) return;
  const uploaded = _cache.uploaded_voices || [];
  if (!uploaded.length) {
    selectEl.replaceChildren();
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No voices in library — upload first";
    opt.disabled = true;
    selectEl.appendChild(opt);
    return;
  }
  fillSelect(selectEl, uploaded.map((v) => ({ value: v.name, label: v.name })));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
