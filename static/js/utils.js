export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- toast (single-slot; new message replaces the previous) ----
let _toastTimer = null;
export function toast(msg, kind = "ok", ms) {
  const el = $("#toast");
  if (!el) return;
  const duration = ms ?? (kind === "err" ? 4500 : 2200);
  el.textContent = msg;
  el.classList.remove("err", "ok", "show");
  el.classList.add(kind);
  // reflow so re-add triggers slide-in animation even if already shown
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), duration);
}

// ---- formatters ----
export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
export function fmtTime(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
export function fmtDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---- debounce ----
export function debounce(fn, ms = 200) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ---- select helpers ----
export function fillSelect(selectEl, items, { valueKey, labelKey, selected } = {}) {
  selectEl.replaceChildren();
  for (const item of items) {
    const opt = document.createElement("option");
    if (typeof item === "string") {
      opt.value = item;
      opt.textContent = item;
    } else {
      opt.value = valueKey ? item[valueKey] : item.value;
      opt.textContent = labelKey ? item[labelKey] : item.label;
      if (item.dataset) for (const [k, v] of Object.entries(item.dataset)) opt.dataset[k] = v;
    }
    if (selected && opt.value === selected) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

// ---- tiny inline icons (clean sharp SVG) ----
export function icon(name, cls = "") {
  const paths = {
    stop: '<path d="M6 6h12v12H6z"/>',
    download: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/>',
    check: '<path d="M4 12l5 5L20 6"/>',
    x: '<path d="M6 6l12 12M18 6l-12 12"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    refresh: '<path d="M4 12a8 8 0 0114-5l2-2M20 4v6h-6M20 12a8 8 0 01-14 5l-2 2M4 20v-6h6"/>',
  };
  return `<svg class="icn ${cls}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ""}</svg>`;
}
