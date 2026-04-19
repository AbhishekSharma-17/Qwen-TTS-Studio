import { $, $$, toast, fmtTime, fmtBytes, fmtDuration, fillSelect, icon } from "./utils.js";
import { getInfo, getTasks, uploadVoice } from "./api.js";
import { initTabs, initSegmented } from "./tabs.js";
import { PcmStreamPlayer } from "./pcm_player.js";
import {
  refreshVoices, renderLibraryList, syncLibrarySelect, getCache,
} from "./voice_library.js";
import {
  refreshModels, renderModelsList, wireModelsTab, startModelsPolling,
} from "./models.js";
import { enhanceAllSelects } from "./cselect.js";

const state = {
  info: null,
  tasks: null,
  clone: { mode: "upload", file: null },
  // Per-tab generation lock.
  inflight: { preset: null, design: null, clone: null },
};

// =========================================================================
// health polling + task-gate overlay
// =========================================================================
async function pollHealth() {
  try {
    const info = await getInfo();
    state.info = info;
    for (const el of $$(".status-chip[data-backend]")) {
      const tt = el.dataset.backend;
      const s = info.models?.[tt]?.status || "down";
      el.classList.remove("up", "down", "starting", "stopped", "fatal", "degraded", "unhealthy");
      el.classList.add(s);
    }
    applyTaskGates();
  } catch {
    for (const el of $$(".status-chip[data-backend]")) {
      el.classList.remove("up", "starting");
      el.classList.add("down");
    }
  }
}

function applyTaskGates() {
  const byTask = { CustomVoice: "preset", VoiceDesign: "design", Base: "clone" };
  const statuses = state.info?.models || {};
  for (const [task, panelKey] of Object.entries(byTask)) {
    const page = document.querySelector(`.page[data-panel="${panelKey}"]`);
    if (!page) continue;
    const s = statuses[task]?.status;
    const prev = page.querySelector(".task-gate");
    if (s === "up") {
      if (prev) prev.remove();
      page.querySelectorAll(".primary, textarea, input, select, .chip, .toggle input").forEach(
        (el) => el.removeAttribute("disabled"));
    } else {
      if (!prev) {
        const gate = document.createElement("div");
        gate.className = "task-gate";
        gate.dataset.task = task;
        const nice = { CustomVoice: "Preset voice", VoiceDesign: "Design voice", Base: "Clone voice" }[task];
        gate.innerHTML = `
          <h3>${nice} model is not loaded</h3>
          <p>This tab uses the <code>${task}</code> backend. Load it to generate speech.
             Cold start takes about 30–60 seconds.</p>
          <button class="primary" data-load-task="${task}">${icon("play")}<span>Load ${nice} now</span></button>
        `;
        // Insert after the page-header so it replaces the split area visually
        const header = page.querySelector(".page-header");
        if (header) header.after(gate); else page.prepend(gate);
      }
      page.querySelectorAll(".primary:not([data-load-task]), textarea, input, select, .chip").forEach(
        (el) => el.setAttribute("disabled", ""));
    }
  }
}

// Click handler for the gate's "Load" button (delegated).
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-load-task]");
  if (!btn) return;
  const task = btn.dataset.loadTask;
  btn.setAttribute("disabled", "");
  btn.innerHTML = `<span class="btn-wave"><span></span><span></span><span></span></span><span>Loading ${task}… (~30–60 s)</span>`;
  try {
    const r = await fetch(`/v1/admin/models/${encodeURIComponent(task)}/load?wait=true`, { method: "POST" });
    const data = await r.json();
    if (data.success) toast(`${task} loaded`, "ok");
    else toast(`${task} load failed: ${data.error || data.status}`, "err");
  } catch (err) {
    toast(err.message, "err");
  }
  await pollHealth();
  refreshModels().then(() => renderModelsList($("#models-list")));
});

// =========================================================================
// dropdowns
// =========================================================================
function populateDropdowns() {
  const languages = state.info.languages;
  for (const sel of ["#preset-language", "#design-language", "#clone-language"]) {
    fillSelect($(sel), languages, { selected: "English" });
  }

  const custom = state.tasks.tasks.find((t) => t.task_type === "CustomVoice");
  const speakers = custom?.speakers || [];
  fillSelect(
    $("#preset-speaker"),
    speakers.map((s) => ({ value: s.name, label: `${s.name} — ${s.desc}` })),
    { selected: "vivian" },
  );
  const syncDesc = () => {
    const s = speakers.find((x) => x.name === $("#preset-speaker").value);
    $("#preset-speaker-desc").textContent = s ? `Native: ${s.native}` : "";
  };
  $("#preset-speaker").addEventListener("change", syncDesc);
  syncDesc();
}

// =========================================================================
// Output card (generation result) — modern, state-machine driven
// =========================================================================
function buildCard(task, title) {
  const container = $(`[data-output="${task}"]`);
  // Hide the empty-state placeholder if this is the first card
  const emptyEl = container.querySelector(".output-empty");
  if (emptyEl) emptyEl.remove();
  const card = document.createElement("div");
  card.className = "output-card streaming";
  card.innerHTML = `
    <div class="oc-progress"><div class="bar"></div></div>
    <div class="oc-header">
      <div class="oc-title">
        <span class="spinner" aria-hidden="true"></span>
        <span class="title">${title}</span>
        <span class="state">· Generating…</span>
      </div>
      <div class="oc-meta">
        <span class="ttfa">—</span><span class="dur">0:00</span><span class="bytes">0 KB</span>
      </div>
    </div>
    <div class="oc-actions">
      <button class="danger-btn stop-btn" aria-label="Stop generation">${icon("stop")}<span>Stop</span></button>
      <button class="primary-outline download-btn" aria-label="Download audio" disabled>${icon("download")}<span>Download WAV</span></button>
    </div>
    <details class="oc-relisten">
      <summary>Re-listen / scrub</summary>
      <audio controls preload="none"></audio>
    </details>
    <div class="oc-footer"></div>
  `;
  container.prepend(card);
  // keep only 5 recent cards per tab
  while (container.children.length > 5) container.removeChild(container.lastChild);

  return {
    card,
    progressBar: card.querySelector(".oc-progress .bar"),
    stateLbl: card.querySelector(".state"),
    spinner: card.querySelector(".spinner"),
    ttfa: card.querySelector(".ttfa"),
    dur: card.querySelector(".dur"),
    bytes: card.querySelector(".bytes"),
    stopBtn: card.querySelector(".stop-btn"),
    dlBtn: card.querySelector(".download-btn"),
    relisten: card.querySelector(".oc-relisten"),
    audio: card.querySelector("audio"),
    footer: card.querySelector(".oc-footer"),
  };
}

function markCardDone(ui, t0) {
  ui.card.classList.remove("streaming");
  ui.card.classList.add("done");
  ui.stateLbl.textContent = "· Done";
  ui.spinner.remove();
  ui.stopBtn.remove();
  ui.footer.textContent = `Total ${fmtTime(performance.now() - t0)}`;
}

function markCardError(ui, msg) {
  ui.card.classList.remove("streaming");
  ui.card.classList.add("error");
  ui.stateLbl.textContent = `· ${msg}`;
  ui.spinner.remove();
  ui.stopBtn.remove();
  ui.dlBtn.remove();
}

function markCardStopped(ui, t0) {
  ui.card.classList.remove("streaming");
  ui.card.classList.add("done");
  ui.stateLbl.textContent = "· Stopped";
  ui.spinner.remove();
  ui.stopBtn.remove();
  ui.footer.textContent = `Stopped after ${fmtTime(performance.now() - t0)}`;
}

// =========================================================================
// generate() — unified streaming + non-streaming, with AbortController, Stop,
// prominent Download (available mid-stream), and concurrency lock.
// =========================================================================
async function generate(task, body, { stream }) {
  // Concurrency lock: if a generation is in flight for this tab, bounce.
  if (state.inflight[task]) {
    toast("Generation already in progress — Stop it first or wait.", "err");
    return;
  }

  const generateBtn = { preset: "#preset-generate", design: "#design-generate", clone: "#clone-generate" }[task];
  const btn = $(generateBtn);
  const originalBtnHTML = btn.innerHTML;
  btn.setAttribute("disabled", "");
  btn.innerHTML = `<span class="btn-wave"><span></span><span></span><span></span></span><span>Generating…</span>`;

  const title = {
    preset: `${body.voice} · ${body.language}`,
    design: `Design · ${body.language}`,
    clone: `Clone · ${body.language}`,
  }[task] || task;

  const ui = buildCard(task, title);
  const t0 = performance.now();
  const controller = new AbortController();
  let player = null;
  let stoppedByUser = false;

  // Wire the card's Stop button
  ui.stopBtn.addEventListener("click", () => {
    stoppedByUser = true;
    controller.abort();
    if (player) player.stop();
  });

  // Release the generation lock + rearm the button
  const release = () => {
    state.inflight[task] = null;
    btn.removeAttribute("disabled");
    btn.innerHTML = originalBtnHTML;
  };
  state.inflight[task] = { controller, release };

  try {
    if (stream) {
      body.stream = true;
      body.response_format = "pcm";
    }

    const r = await fetch("/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try { const j = await r.json(); if (j?.detail) msg += ` · ${j.detail}`; } catch {}
      throw new Error(msg);
    }

    if (stream) {
      player = new PcmStreamPlayer(24000);

      // Enable download as soon as the first chunk lands
      let downloadWired = false;
      const wireDownload = () => {
        if (downloadWired) return;
        downloadWired = true;
        ui.dlBtn.removeAttribute("disabled");
        ui.dlBtn.addEventListener("click", () => {
          const blob = player.toWavBlob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `qwentts_${task}_${Date.now()}.wav`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        });
      };

      player.onFirstAudio = () => {
        ui.ttfa.textContent = `TTFA ${fmtTime(performance.now() - t0)}`;
        wireDownload();
      };
      player.onBytes = (n, sec) => {
        ui.bytes.textContent = fmtBytes(n);
        ui.dur.textContent = fmtDuration(sec);
        // Approximate progress from bytes received vs a rough expected ceiling.
        // We don't know final duration; use a soft cap that grows with received bytes.
        const expectedSec = Math.max(sec * 1.4, 3); // heuristic
        const pct = Math.min(95, (sec / expectedSec) * 100);
        ui.progressBar.style.width = pct + "%";
      };
      player.onDone = () => { ui.progressBar.style.width = "100%"; };

      await player.playStream(r);

      if (stoppedByUser) {
        markCardStopped(ui, t0);
        // Download button still works with whatever we captured
      } else {
        // Expose re-listen <audio> with the final blob
        const blob = player.toWavBlob();
        ui.audio.src = URL.createObjectURL(blob);
        markCardDone(ui, t0);
      }
    } else {
      // Non-streaming: buffered WAV
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      ui.audio.src = url;
      ui.relisten.open = true; // expand by default in non-streaming mode
      ui.ttfa.textContent = `Gen ${fmtTime(performance.now() - t0)}`;
      ui.bytes.textContent = fmtBytes(blob.size);
      ui.progressBar.style.width = "100%";
      ui.dlBtn.removeAttribute("disabled");
      ui.dlBtn.addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = url;
        a.download = `qwentts_${task}_${Date.now()}.${body.response_format || "wav"}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
      markCardDone(ui, t0);
    }
  } catch (err) {
    if (stoppedByUser || err?.name === "AbortError") {
      // Partial audio may still exist from the player buffers
      markCardStopped(ui, t0);
      // In streaming mode, if the player captured bytes, enable download of partial
      if (player && player.totalBytes > 44) {
        ui.dlBtn.removeAttribute("disabled");
        ui.dlBtn.addEventListener("click", () => {
          const blob = player.toWavBlob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `qwentts_${task}_partial_${Date.now()}.wav`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        });
      } else {
        ui.dlBtn.remove();
      }
    } else {
      markCardError(ui, err.message);
      toast(err.message, "err");
    }
  } finally {
    release();
  }
}

// =========================================================================
// tab wiring
// =========================================================================
function wirePreset() {
  $("#preset-generate").addEventListener("click", (e) => {
    if (e.currentTarget.hasAttribute("disabled")) return;
    const text = $("#preset-text").value.trim();
    if (!text) return toast("Enter some text first.", "err");
    generate("preset", {
      task_type: "CustomVoice",
      input: text,
      voice: $("#preset-speaker").value,
      language: $("#preset-language").value,
      instructions: $("#preset-instruct").value || undefined,
      speed: parseFloat($("#preset-speed").value) || 1.0,
      response_format: $("#preset-format").value,
    }, { stream: $("#preset-stream").checked });
  });
}

function wireDesign() {
  $("#design-generate").addEventListener("click", (e) => {
    if (e.currentTarget.hasAttribute("disabled")) return;
    const text = $("#design-text").value.trim();
    const instr = $("#design-instruct").value.trim();
    if (!text) return toast("Enter some text first.", "err");
    if (!instr) return toast("Describe the voice first.", "err");
    generate("design", {
      task_type: "VoiceDesign",
      input: text,
      language: $("#design-language").value,
      instructions: instr,
      speed: parseFloat($("#design-speed").value) || 1.0,
      response_format: $("#design-format").value,
    }, { stream: $("#design-stream").checked });
  });
}

function wireClone() {
  initSegmented(".segmented", (mode) => { state.clone.mode = mode; });

  const dz = $("#clone-dropzone");
  const fileIn = $("#clone-file");
  const preview = $("#clone-preview");
  const hint = dz.querySelector(".drop-hint");
  const originalHint = hint ? hint.textContent : "";

  const clearFile = () => {
    state.clone.file = null;
    fileIn.value = "";
    preview.hidden = true;
    preview.removeAttribute("src");
    dz.classList.remove("has-file");
    const chip = dz.querySelector(".file-chip");
    if (chip) chip.remove();
    if (hint) hint.textContent = originalHint;
  };

  const showFileChip = (file) => {
    let chip = dz.querySelector(".file-chip");
    if (!chip) {
      chip = document.createElement("div");
      chip.className = "file-chip";
      dz.appendChild(chip);
    }
    chip.innerHTML = `
      <span class="fname">${file.name}</span>
      <span class="fsize">${fmtBytes(file.size)}</span>
      <button type="button" class="clear" aria-label="Remove file" title="Remove">×</button>
    `;
    chip.querySelector(".clear").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      clearFile();
    });
    if (hint) hint.textContent = "File selected — drop or click to replace";
  };

  const handleFile = (file) => {
    state.clone.file = file;
    preview.hidden = false;
    preview.src = URL.createObjectURL(file);
    dz.classList.add("has-file");
    showFileChip(file);
  };

  fileIn.addEventListener("change", () => {
    if (fileIn.files?.[0]) handleFile(fileIn.files[0]);
  });
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragging"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragging"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragging");
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  });

  $("#clone-library-voice").addEventListener("change", () => {
    const name = $("#clone-library-voice").value;
    const voice = (getCache().uploaded_voices || []).find((v) => v.name === name);
    $("#clone-library-desc").textContent = voice?.speaker_description || "";
    const prev = $("#clone-library-preview");
    if (name) {
      prev.hidden = false;
      prev.src = `/v1/audio/voices/${encodeURIComponent(name)}/preview`;
    } else {
      prev.hidden = true;
    }
  });

  $("#clone-generate").addEventListener("click", async (e) => {
    if (e.currentTarget.hasAttribute("disabled")) return;
    const text = $("#clone-text").value.trim();
    if (!text) return toast("Enter some text first.", "err");

    const body = {
      task_type: "Base",
      input: text,
      language: $("#clone-language").value,
      instructions: $("#clone-instruct").value || undefined,
      response_format: $("#clone-format").value,
      x_vector_only_mode: $("#clone-xvec").checked || undefined,
    };

    if (state.clone.mode === "upload") {
      const file = state.clone.file;
      if (!file) return toast("Choose a reference audio file.", "err");
      const refText = $("#clone-ref-text").value.trim();
      const saveAs = $("#clone-save-name").value.trim();
      if (saveAs) {
        try {
          await uploadVoice({
            file, name: saveAs, refText,
            description: "", consent: `ui-${Date.now()}`,
            language: body.language,
          });
          await refreshVoices({ onUpdate: () => syncLibrarySelect($("#clone-library-voice")) });
          body.ref_voice = saveAs;
          toast(`Saved "${saveAs}" to library`);
        } catch (e) { return toast(e.message, "err"); }
      } else {
        body.ref_audio = await fileToDataURL(file);
        if (refText) body.ref_text = refText;
      }
    } else {
      const name = $("#clone-library-voice").value;
      if (!name) return toast("Pick a saved voice.", "err");
      body.ref_voice = name;
    }
    generate("clone", body, { stream: $("#clone-stream").checked });
  });
}

function wireLibrary() {
  const container = $("#library-list");
  $("#library-refresh").addEventListener("click", async () => {
    await refreshVoices();
    renderLibraryList(container);
    syncLibrarySelect($("#clone-library-voice"));
  });
}

async function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// =========================================================================
// example chips (inserts suggestion into target input)
// =========================================================================
function wireChips() {
  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip[data-target]");
    if (!btn) return;
    if (btn.hasAttribute("disabled")) return;
    const target = document.getElementById(btn.dataset.target);
    if (!target) return;
    const text = btn.textContent.trim();
    const replace = btn.hasAttribute("data-replace") || (target.tagName === "TEXTAREA" && target.value === "");
    if (replace) target.value = text;
    else target.value = (target.value && target.value.trim())
      ? `${target.value.replace(/\s+$/, "")}, ${text.toLowerCase()}`
      : text;
    target.focus();
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// =========================================================================
// bootstrap
// =========================================================================
async function main() {
  initTabs((panel) => {
    if (panel === "library") {
      refreshVoices({ showSkeleton: true }).then(() => renderLibraryList($("#library-list")));
    }
    if (panel === "models") {
      refreshModels({ showSkeleton: true }).then(() => renderModelsList($("#models-list")));
    }
  });
  try {
    state.info = await getInfo();
    state.tasks = await getTasks();
  } catch (e) {
    toast("Backend not reachable: " + e.message, "err");
    return;
  }
  populateDropdowns();
  wirePreset();
  wireDesign();
  wireClone();
  wireLibrary();
  wireChips();
  wireModelsTab();
  await refreshModels({ onUpdate: () => renderModelsList($("#models-list")) });
  startModelsPolling(5000);
  await refreshVoices({ onUpdate: () => syncLibrarySelect($("#clone-library-voice")) });
  // Upgrade every <select> to the custom dropdown component. Must run
  // AFTER populateDropdowns + syncLibrarySelect so options exist.
  enhanceAllSelects(document);
  pollHealth();
  setInterval(pollHealth, 10000);
}

main();
