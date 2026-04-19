// Custom dropdown that enhances a native <select> while keeping it in the DOM
// for form submission / progressive enhancement. Supports:
//   - mouse + keyboard (Enter/Space/Arrow/Escape/Home/End/typeahead)
//   - dynamic option updates (MutationObserver on the <select>)
//   - disabled sync
//   - external value changes (updates the trigger label automatically)

const SVG_CHEV = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;
const SVG_CHECK = `<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>`;

let _closeAllRegistered = false;
function _registerDocumentClose() {
  if (_closeAllRegistered) return;
  _closeAllRegistered = true;
  document.addEventListener("click", (e) => {
    document.querySelectorAll(".cselect.open").forEach((w) => {
      if (!w.contains(e.target)) w.classList.remove("open");
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".cselect.open").forEach((w) => w.classList.remove("open"));
    }
  });
}

export function enhanceSelect(selectEl) {
  if (selectEl.dataset.cselectEnhanced === "1") return;
  selectEl.dataset.cselectEnhanced = "1";
  _registerDocumentClose();

  const wrap = document.createElement("div");
  wrap.className = "cselect";
  // Wrap the select in-place (same position in DOM)
  selectEl.parentNode.insertBefore(wrap, selectEl);
  wrap.appendChild(selectEl);

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cselect-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = `<span class="label"></span>${SVG_CHEV}`;
  wrap.appendChild(trigger);

  const menu = document.createElement("div");
  menu.className = "cselect-menu";
  menu.setAttribute("role", "listbox");
  wrap.appendChild(menu);

  let focusIdx = -1;

  const syncLabel = () => {
    const label = trigger.querySelector(".label");
    const sel = selectEl.options[selectEl.selectedIndex];
    if (sel && sel.textContent) {
      label.textContent = sel.textContent;
      label.classList.remove("placeholder");
    } else {
      label.textContent = "Select…";
      label.classList.add("placeholder");
    }
  };

  const renderMenu = () => {
    menu.replaceChildren();
    for (let i = 0; i < selectEl.options.length; i++) {
      const opt = selectEl.options[i];
      const item = document.createElement("div");
      item.className = "cselect-opt";
      item.dataset.value = opt.value;
      item.dataset.index = String(i);
      item.setAttribute("role", "option");
      item.innerHTML = `<span class="t">${escapeHtml(opt.textContent)}</span>${SVG_CHECK}`;
      if (opt.value === selectEl.value) item.classList.add("active");
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        selectValue(opt.value, i);
        close();
      });
      item.addEventListener("mousemove", () => setFocus(i));
      menu.appendChild(item);
    }
    syncLabel();
  };

  const setFocus = (idx) => {
    focusIdx = Math.max(0, Math.min(selectEl.options.length - 1, idx));
    menu.querySelectorAll(".cselect-opt").forEach((el, i) => {
      el.classList.toggle("focus", i === focusIdx);
    });
    const focused = menu.querySelectorAll(".cselect-opt")[focusIdx];
    if (focused) focused.scrollIntoView({ block: "nearest" });
  };

  const selectValue = (value, index) => {
    if (selectEl.value === value) { syncLabel(); return; }
    selectEl.value = value;
    selectEl.selectedIndex = index;
    menu.querySelectorAll(".cselect-opt").forEach((el) => {
      el.classList.toggle("active", el.dataset.value === value);
    });
    syncLabel();
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const open = () => {
    if (trigger.disabled) return;
    document.querySelectorAll(".cselect.open").forEach((w) => {
      if (w !== wrap) w.classList.remove("open");
    });
    wrap.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    // Focus the currently-selected option (or first)
    focusIdx = Math.max(0, selectEl.selectedIndex);
    setFocus(focusIdx);
  };

  const close = () => {
    wrap.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    focusIdx = -1;
    trigger.focus();
  };

  const toggle = () => wrap.classList.contains("open") ? close() : open();

  // Trigger interactions
  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });

  trigger.addEventListener("keydown", (e) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      if (!wrap.classList.contains("open")) {
        open();
        return;
      }
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setFocus(focusIdx + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocus(focusIdx - 1); }
    else if (e.key === "Home") { e.preventDefault(); setFocus(0); }
    else if (e.key === "End") { e.preventDefault(); setFocus(selectEl.options.length - 1); }
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (focusIdx >= 0) {
        const opt = selectEl.options[focusIdx];
        selectValue(opt.value, focusIdx);
        close();
      }
    } else if (e.key === "Escape") {
      close();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Typeahead: jump to next option whose label starts with the typed char
      const ch = e.key.toLowerCase();
      const opts = [...selectEl.options];
      const start = (focusIdx + 1) % opts.length;
      const idx = opts.slice(start).findIndex(o => o.textContent.trim().toLowerCase().startsWith(ch));
      const found = idx >= 0 ? idx + start
        : opts.findIndex(o => o.textContent.trim().toLowerCase().startsWith(ch));
      if (found >= 0) setFocus(found);
    }
  });

  // Disabled sync
  const syncDisabled = () => {
    trigger.disabled = selectEl.disabled;
    wrap.classList.toggle("disabled", selectEl.disabled);
    if (selectEl.disabled) close();
  };
  new MutationObserver(syncDisabled).observe(selectEl, { attributes: true, attributeFilter: ["disabled"] });
  syncDisabled();

  // Options changes (fillSelect, etc.) and programmatic value changes
  new MutationObserver(renderMenu).observe(selectEl, { childList: true });
  selectEl.addEventListener("change", () => {
    menu.querySelectorAll(".cselect-opt").forEach((el) => {
      el.classList.toggle("active", el.dataset.value === selectEl.value);
    });
    syncLabel();
  });

  renderMenu();
}

export function enhanceAllSelects(root = document) {
  root.querySelectorAll("select:not([data-cselect-enhanced])").forEach(enhanceSelect);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
