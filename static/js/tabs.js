import { $, $$ } from "./utils.js";

export function initTabs(onChange) {
  // Sidebar nav items drive .page visibility
  $$(".nav-item[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.tab;
      $$(".nav-item[data-tab]").forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
      $$(".page[data-panel]").forEach((p) => {
        const show = p.dataset.panel === name;
        p.hidden = !show;
      });
      if (onChange) onChange(name);
    });
  });
}

export function initSegmented(rootSel, onChange) {
  const root = $(rootSel);
  if (!root) return;
  root.querySelectorAll(".seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.cloneMode;
      root.querySelectorAll(".seg").forEach((b) => b.classList.toggle("active", b === btn));
      $$(".clone-mode").forEach((p) => p.classList.toggle("active", p.dataset.clonePanel === name));
      if (onChange) onChange(name);
    });
  });
}
