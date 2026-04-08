import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SECTIONS = [
  { key: "clip",       label: "Clip",       short: "clip" },
  { key: "timeline",   label: "Timeline",   short: "tl" },
  { key: "pre_group",  label: "Pre Group",  short: "pre" },
  { key: "post_group", label: "Post Group", short: "post" },
];
const MAX_SLOTS = 9;

const ALWAYS_LABEL_TOOLS = new Set(["OFX: DCTL"]);
const BUILTIN_TOOLS = new Set([
  "Corrector", "HDR Palette", "ColorCorrector", "SplitterCombiner",
  "MediaIn", "MediaOut", "Background", "Merge", "Transform", "Layer Mixer",
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let config = { slots: {} };
let stateData = {};
let graphsCache = {};   // section -> { context, num_nodes }
let nodesCache = {};    // section -> [node, ...]
let flashTimer = null;
let registeredShortcuts = new Map();  // shortcut string -> { section, slot }
let hotkeyModalState = null;          // { section, slot, resolve, reject }
let toggleBusy = {};                  // "section::slot" -> true while toggle in-flight
const TOGGLE_DEBOUNCE_MS = 250;       // ignore repeat triggers within this window
let toggleLastFired = {};             // "section::slot" -> timestamp of last toggle

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $statusDot   = document.getElementById("status-dot");
const $statusText  = document.getElementById("status-text");
const $clipName    = document.getElementById("clip-name");
const $sections    = document.getElementById("sections-container");
const $flashMsg    = document.getElementById("flash-msg");
const $activeProf  = document.getElementById("active-profile");
const $hotkeyLeg   = document.getElementById("hotkey-legend");

// ---------------------------------------------------------------------------
// Flash message
// ---------------------------------------------------------------------------
function flash(msg, ms = 3000) {
  $flashMsg.textContent = msg;
  $flashMsg.style.opacity = "1";
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $flashMsg.style.opacity = "0"; }, ms);
}

// ---------------------------------------------------------------------------
// State key (matches Python version for compatibility)
// ---------------------------------------------------------------------------
function stateKey(section, tool, label, context) {
  // Use :: separators to avoid ambiguity with tool names containing colons
  // (e.g. "OFX: DCTL").  Matches the original Python version's format.
  const toolPart = label ? `${tool}:${label}` : tool;
  return `${section}::${toolPart}::${context}`;
}

// ---------------------------------------------------------------------------
// Tool display names (matches Python version logic)
// ---------------------------------------------------------------------------
function makeDisplayName(tool, label, idx) {
  if (label) return `${tool} — ${label} [#${idx}]`;
  return `${tool} [#${idx}]`;
}

function parseDisplayName(display) {
  display = display.replace(" ⚠", "");
  if (display.includes(" — ") && display.includes(" [#")) {
    const [toolPart, rest] = display.split(" — ", 2);
    const labelPart = rest.replace(/\s*\[#\d+\]$/, "");
    return { tool: toolPart.trim(), label: labelPart.trim() };
  }
  if (display.includes(" [#")) {
    const toolPart = display.replace(/\s*\[#\d+\]$/, "");
    return { tool: toolPart.trim(), label: "" };
  }
  return { tool: display.trim(), label: "" };
}

function getToolOptions(sectionKey) {
  const nodes = nodesCache[sectionKey] || [];
  if (!nodes.length) return ["(no tools available)"];

  const toolCounts = {};
  for (const n of nodes) {
    for (const t of (n.tools || [])) {
      if (!toolCounts[t]) toolCounts[t] = [];
      toolCounts[t].push({ index: n.index, label: n.label });
    }
  }

  const options = [];
  const seen = new Set();
  for (const n of nodes) {
    for (const t of (n.tools || [])) {
      const occurrences = toolCounts[t] || [];
      const needsLabel = occurrences.length > 1 || ALWAYS_LABEL_TOOLS.has(t);
      if (!needsLabel) {
        if (!seen.has(t)) {
          seen.add(t);
          options.push(t);
        }
      } else {
        const key = `${t}:${n.index}`;
        if (!seen.has(key)) {
          seen.add(key);
          options.push(makeDisplayName(t, n.label, n.index));
        }
      }
    }
  }
  return options.length ? options : ["(no tools available)"];
}

// ---------------------------------------------------------------------------
// Build UI
// ---------------------------------------------------------------------------
function buildSections() {
  $sections.innerHTML = "";
  for (const sec of SECTIONS) {
    const div = document.createElement("div");
    div.className = "section";
    div.dataset.section = sec.key;
    div.innerHTML = `
      <div class="section-header">
        <div class="section-accent"></div>
        <span class="section-title">${sec.label}</span>
        <span class="section-info"></span>
        <div class="section-actions">
          <button class="btn btn-section-toggle btn-danger" data-action="section-toggle">All OFF</button>
          <button class="btn btn-add" data-action="add-slot">+ Add Slot</button>
        </div>
      </div>
      <div class="section-slots">
        <div class="section-empty">Click '+ Add Slot' to configure a node toggle</div>
      </div>
    `;

    div.querySelector('[data-action="add-slot"]').addEventListener("click", () => addSlot(sec.key));
    div.querySelector('[data-action="section-toggle"]').addEventListener("click", () => sectionToggle(sec.key));

    $sections.appendChild(div);
  }
}

function getSectionEl(sectionKey) {
  return $sections.querySelector(`.section[data-section="${sectionKey}"]`);
}

function buildSlotRow(sectionKey, slotNum, savedTool = "", savedLabel = "") {
  const sec = SECTIONS.find(s => s.key === sectionKey);
  const options = getToolOptions(sectionKey);

  const row = document.createElement("div");
  row.className = "slot-row";
  row.dataset.slot = slotNum;

  // Badge
  const badge = document.createElement("span");
  badge.className = "slot-badge";
  badge.textContent = slotNum;
  row.appendChild(badge);

  // CLI hint
  const hint = document.createElement("span");
  hint.className = "slot-hint";
  hint.textContent = `--slot ${sec.short}:${slotNum}`;
  row.appendChild(hint);

  // Dropdown
  const select = document.createElement("select");
  select.className = "slot-dropdown";
  const emptyOpt = document.createElement("option");
  emptyOpt.value = "";
  emptyOpt.textContent = "— select tool —";
  select.appendChild(emptyOpt);

  let matched = false;
  for (const opt of options) {
    if (opt.startsWith("(")) continue;
    const el = document.createElement("option");
    el.value = opt;
    el.textContent = opt;
    select.appendChild(el);

    // Match saved config
    if (savedTool) {
      const parsed = parseDisplayName(opt);
      if (parsed.tool === savedTool && (!savedLabel || parsed.label === savedLabel)) {
        el.selected = true;
        matched = true;
      }
    }
  }

  // If tool not in current graph, show with warning
  if (savedTool && !matched) {
    const display = savedLabel ? `${savedTool} — ${savedLabel} ⚠` : `${savedTool} ⚠`;
    const el = document.createElement("option");
    el.value = display;
    el.textContent = display;
    el.selected = true;
    select.insertBefore(el, select.children[1]);
  }

  select.addEventListener("change", () => onToolChange(sectionKey, slotNum, select));
  row.appendChild(select);

  // Toggle button
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "toggle-btn unknown";
  toggleBtn.textContent = " — ";
  toggleBtn.addEventListener("click", () => doToggle(sectionKey, slotNum, toggleBtn));
  row.appendChild(toggleBtn);

  // Hotkey button
  const savedHotkey = config.slots[sectionKey]?.[String(slotNum)]?.hotkey;
  const hotkeyBtn = document.createElement("button");
  hotkeyBtn.className = "hotkey-btn" + (savedHotkey ? " has-hotkey" : "");
  hotkeyBtn.textContent = savedHotkey ? formatShortcutDisplay(savedHotkey) : "⌨";
  hotkeyBtn.title = savedHotkey ? `Hotkey: ${savedHotkey}` : "Click to set hotkey";
  hotkeyBtn.addEventListener("click", () => openHotkeyModal(sectionKey, slotNum, hotkeyBtn));
  row.appendChild(hotkeyBtn);

  // Remove button
  const removeBtn = document.createElement("button");
  removeBtn.className = "remove-btn";
  removeBtn.textContent = "✕";
  removeBtn.addEventListener("click", () => removeSlot(sectionKey, slotNum, row));
  row.appendChild(removeBtn);

  // Set initial state
  updateToggleBtnState(sectionKey, slotNum, toggleBtn);

  return row;
}

// ---------------------------------------------------------------------------
// Slot operations
// ---------------------------------------------------------------------------
function onToolChange(sectionKey, slotNum, select) {
  const raw = select.value;
  if (!raw) return;
  const { tool, label } = parseDisplayName(raw);
  if (!tool) return;

  if (!config.slots[sectionKey]) config.slots[sectionKey] = {};
  const existing = config.slots[sectionKey][String(slotNum)] || {};
  config.slots[sectionKey][String(slotNum)] = { tool, label, hotkey: existing.hotkey || undefined };
  saveConfig();

  const sec = SECTIONS.find(s => s.key === sectionKey);
  const display = label ? `${tool} — ${label}` : tool;
  flash(`Slot ${sec.short}:${slotNum} → ${display}`);

  // Update button state
  const row = getSectionEl(sectionKey)?.querySelector(`.slot-row[data-slot="${slotNum}"]`);
  const btn = row?.querySelector(".toggle-btn");
  if (btn) updateToggleBtnState(sectionKey, slotNum, btn);
}

function addSlot(sectionKey) {
  const slotsContainer = getSectionEl(sectionKey)?.querySelector(".section-slots");
  if (!slotsContainer) return;

  const existingNums = [...slotsContainer.querySelectorAll(".slot-row")]
    .map(r => parseInt(r.dataset.slot));
  if (existingNums.length >= MAX_SLOTS) {
    flash(`Max ${MAX_SLOTS} slots per section`);
    return;
  }

  let nextNum = 1;
  for (let i = 1; i <= MAX_SLOTS; i++) {
    if (!existingNums.includes(i)) { nextNum = i; break; }
  }

  // Hide empty message
  const empty = slotsContainer.querySelector(".section-empty");
  if (empty) empty.style.display = "none";

  if (!config.slots[sectionKey]) config.slots[sectionKey] = {};
  config.slots[sectionKey][String(nextNum)] = { tool: "", label: "" };
  saveConfig();

  const row = buildSlotRow(sectionKey, nextNum);
  slotsContainer.appendChild(row);

  const sec = SECTIONS.find(s => s.key === sectionKey);
  flash(`Added slot ${sec.short}:${nextNum} — select a tool ↓`);
}

function removeSlot(sectionKey, slotNum, rowEl) {
  rowEl.remove();
  if (config.slots[sectionKey]) {
    delete config.slots[sectionKey][String(slotNum)];
    saveConfig();
  }

  // Show empty message if no slots left
  const slotsContainer = getSectionEl(sectionKey)?.querySelector(".section-slots");
  if (slotsContainer && !slotsContainer.querySelector(".slot-row")) {
    const empty = slotsContainer.querySelector(".section-empty");
    if (empty) empty.style.display = "";
  }

  const sec = SECTIONS.find(s => s.key === sectionKey);
  flash(`Removed slot ${sec.short}:${slotNum}`);
}

// ---------------------------------------------------------------------------
// Toggle logic
// ---------------------------------------------------------------------------
function updateToggleBtnState(sectionKey, slotNum, btn) {
  const slotCfg = config.slots[sectionKey]?.[String(slotNum)];
  if (!slotCfg || (!slotCfg.tool && !slotCfg.label)) {
    btn.className = "toggle-btn unknown";
    btn.textContent = " — ";
    return;
  }

  const graphInfo = graphsCache[sectionKey];
  if (!graphInfo) {
    btn.className = "toggle-btn unknown";
    btn.textContent = " — ";
    return;
  }

  // Check if node exists in cache
  const nodes = nodesCache[sectionKey] || [];
  const found = findNodeInCache(nodes, slotCfg.tool, slotCfg.label);
  if (!found) {
    btn.className = "toggle-btn missing";
    btn.textContent = " ✗ ";
    return;
  }

  const context = graphInfo.context || "";
  const sk = stateKey(sectionKey, slotCfg.tool, slotCfg.label, context);
  const tracked = stateData[sk];

  if (tracked === true) {
    btn.className = "toggle-btn on";
    btn.textContent = "  ON  ";
  } else if (tracked === false) {
    btn.className = "toggle-btn off";
    btn.textContent = " OFF ";
  } else {
    btn.className = "toggle-btn unknown";
    btn.textContent = " ? ";
  }
}

function findNodeInCache(nodes, tool, label) {
  // Exact tool + exact label
  if (tool && label) {
    for (const n of nodes) {
      if (n.tools?.includes(tool) && n.label === label) return n;
    }
    for (const n of nodes) {
      if (n.tools?.includes(tool) && n.label?.toLowerCase().includes(label.toLowerCase())) return n;
    }
  }
  if (label) {
    for (const n of nodes) {
      if (n.label === label) return n;
    }
  }
  if (tool) {
    for (const n of nodes) {
      if (n.tools?.includes(tool)) return n;
    }
  }
  return null;
}

async function doToggle(sectionKey, slotNum, btn) {
  const toggleKey = `${sectionKey}::${slotNum}`;

  // Debounce: ignore if a toggle is already in-flight for this slot
  if (toggleBusy[toggleKey]) return;

  // Debounce: ignore rapid re-triggers (Windows key repeat / double-click)
  const now = Date.now();
  if (toggleLastFired[toggleKey] && (now - toggleLastFired[toggleKey]) < TOGGLE_DEBOUNCE_MS) return;
  toggleLastFired[toggleKey] = now;

  const slotCfg = config.slots[sectionKey]?.[String(slotNum)];
  if (!slotCfg || (!slotCfg.tool && !slotCfg.label)) {
    flash("Select a tool from the dropdown first");
    return;
  }

  const graphInfo = graphsCache[sectionKey];
  if (!graphInfo) {
    flash(`No graph for ${sectionKey}`);
    return;
  }

  const context = graphInfo.context || "";
  const sk = stateKey(sectionKey, slotCfg.tool, slotCfg.label, context);
  const current = stateData[sk] ?? false;
  const newVal = !current;

  toggleBusy[toggleKey] = true;
  try {
    const result = await invoke("bridge_set_node_enabled", {
      section: sectionKey,
      tool: slotCfg.tool,
      label: slotCfg.label,
      enabled: newVal,
    });

    if (result.success) {
      stateData[sk] = newVal;
      if (newVal) {
        btn.className = "toggle-btn on";
        btn.textContent = "  ON  ";
        flash(`✓ ${result.node_label || `#${result.node_index}`} → ON`);
      } else {
        btn.className = "toggle-btn off";
        btn.textContent = " OFF ";
        flash(`✓ ${result.node_label || `#${result.node_index}`} → OFF`);
      }
      updateSectionToggleBtn(sectionKey);
    } else {
      flash(result.error || "Toggle failed");
      btn.className = "toggle-btn missing";
      btn.textContent = " ✗ ";
    }
  } catch (e) {
    flash(`Error: ${e}`);
  } finally {
    toggleBusy[toggleKey] = false;
  }
}

// ---------------------------------------------------------------------------
// Section toggle (All ON / All OFF)
// ---------------------------------------------------------------------------
function updateSectionToggleBtn(sectionKey) {
  const secEl = getSectionEl(sectionKey);
  if (!secEl) return;
  const btn = secEl.querySelector('[data-action="section-toggle"]');
  if (!btn) return;

  const graphInfo = graphsCache[sectionKey];
  if (!graphInfo) return;
  const context = graphInfo.context || "";

  let allOff = true;
  let hasConfigured = false;

  const sectionSlots = config.slots[sectionKey] || {};
  for (const [, slotCfg] of Object.entries(sectionSlots)) {
    if (!slotCfg.tool && !slotCfg.label) continue;
    hasConfigured = true;
    const sk = stateKey(sectionKey, slotCfg.tool, slotCfg.label, context);
    if (stateData[sk] === true) { allOff = false; break; }
  }

  if (hasConfigured && allOff) {
    btn.textContent = "All ON";
    btn.className = "btn btn-section-toggle";
    btn.style.color = "var(--green)";
    btn.style.borderColor = "rgba(76,175,80,0.3)";
  } else {
    btn.textContent = "All OFF";
    btn.className = "btn btn-section-toggle btn-danger";
    btn.style.color = "";
    btn.style.borderColor = "";
  }
}

async function sectionToggle(sectionKey) {
  const graphInfo = graphsCache[sectionKey];
  if (!graphInfo) return;
  const context = graphInfo.context || "";

  // Determine target state
  let allOff = true;
  const sectionSlots = config.slots[sectionKey] || {};
  for (const [, slotCfg] of Object.entries(sectionSlots)) {
    if (!slotCfg.tool && !slotCfg.label) continue;
    const sk = stateKey(sectionKey, slotCfg.tool, slotCfg.label, context);
    if (stateData[sk] === true) { allOff = false; break; }
  }
  const newState = allOff;

  let count = 0;
  for (const [numStr, slotCfg] of Object.entries(sectionSlots)) {
    if (!slotCfg.tool && !slotCfg.label) continue;
    const sk = stateKey(sectionKey, slotCfg.tool, slotCfg.label, context);
    const current = stateData[sk] ?? false;
    if (current !== newState) {
      try {
        const result = await invoke("bridge_set_node_enabled", {
          section: sectionKey,
          tool: slotCfg.tool,
          label: slotCfg.label,
          enabled: newState,
        });
        if (result.success) {
          stateData[sk] = newState;
          count++;
          // Update the slot's toggle button
          const row = getSectionEl(sectionKey)?.querySelector(`.slot-row[data-slot="${numStr}"]`);
          const btn = row?.querySelector(".toggle-btn");
          if (btn) {
            if (newState) {
              btn.className = "toggle-btn on";
              btn.textContent = "  ON  ";
            } else {
              btn.className = "toggle-btn off";
              btn.textContent = " OFF ";
            }
          }
        }
      } catch (e) {
        console.error("Section toggle error:", e);
      }
    }
  }

  const sec = SECTIONS.find(s => s.key === sectionKey);
  flash(`${sec.label}: ${count} node(s) ${newState ? "ON" : "OFF"}`);
  updateSectionToggleBtn(sectionKey);
}

// ---------------------------------------------------------------------------
// Master ALL OFF
// ---------------------------------------------------------------------------
async function masterAllOff() {
  let total = 0;
  for (const sec of SECTIONS) {
    const graphInfo = graphsCache[sec.key];
    if (!graphInfo) continue;
    const context = graphInfo.context || "";
    const sectionSlots = config.slots[sec.key] || {};

    for (const [numStr, slotCfg] of Object.entries(sectionSlots)) {
      if (!slotCfg.tool && !slotCfg.label) continue;
      const sk = stateKey(sec.key, slotCfg.tool, slotCfg.label, context);
      if (stateData[sk] === true) {
        try {
          const result = await invoke("bridge_set_node_enabled", {
            section: sec.key,
            tool: slotCfg.tool,
            label: slotCfg.label,
            enabled: false,
          });
          if (result.success) {
            stateData[sk] = false;
            total++;
            const row = getSectionEl(sec.key)?.querySelector(`.slot-row[data-slot="${numStr}"]`);
            const btn = row?.querySelector(".toggle-btn");
            if (btn) {
              btn.className = "toggle-btn off";
              btn.textContent = " OFF ";
            }
          }
        } catch (e) {
          console.error("Master off error:", e);
        }
      }
    }
    updateSectionToggleBtn(sec.key);
  }
  flash(`⚡ Master OFF — ${total} node(s) disabled`);
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------
async function refresh() {
  let connected = false;

  // Connect if needed
  try {
    await invoke("bridge_connect");
    connected = true;
  } catch (e) {
    $statusDot.className = "dot disconnected";
    if (String(e).includes("not running") || String(e).includes("not enabled")) {
      $statusText.textContent = "Scripting not enabled in Resolve";
      flash("Enable 'External scripting using: Local' in Resolve → Preferences → System → General", 10000);
    } else if (String(e).includes("not found") || String(e).includes("module")) {
      $statusText.textContent = "Scripting module not found";
      flash("Check Resolve installation or set RESOLVE_SCRIPT_LIB env var", 8000);
    } else if (String(e).includes("Python not found")) {
      $statusText.textContent = "Python not found";
      flash("Install Python 3 and ensure it's on PATH", 10000);
    } else {
      $statusText.textContent = "Cannot connect";
      flash(String(e), 8000);
    }
    $clipName.textContent = "";
  }

  // Get graphs (only if connected)
  if (connected) {
    let graphResult;
    try {
      graphResult = await invoke("bridge_get_graphs");
    } catch (e) {
      $statusDot.className = "dot disconnected";
      $statusText.textContent = "Connection lost";
      flash(String(e), 5000);
      connected = false;
    }

    if (graphResult) {
      graphsCache = graphResult.graphs || {};
      const clipName = graphResult.clip_name || "";

      // Fetch nodes for each available section
      nodesCache = {};
      for (const sec of SECTIONS) {
        if (graphsCache[sec.key]) {
          try {
            const nodeResult = await invoke("bridge_get_nodes", { section: sec.key });
            nodesCache[sec.key] = nodeResult.nodes || [];
          } catch (e) {
            nodesCache[sec.key] = [];
          }
        }
      }

      // Update status
      if (graphsCache.clip) {
        $statusDot.className = "dot connected";
        $statusText.textContent = "Connected";
        $clipName.textContent = clipName;
      } else {
        $statusDot.className = "dot partial";
        $statusText.textContent = graphResult.error || "Partial";
        $clipName.textContent = "";
      }
    }
  }

  // Rebuild slot rows (always — shows saved config even when disconnected)
  for (const sec of SECTIONS) {
    const secEl = getSectionEl(sec.key);
    if (!secEl) continue;
    const slotsContainer = secEl.querySelector(".section-slots");
    const infoEl = secEl.querySelector(".section-info");

    // Clear existing rows
    slotsContainer.querySelectorAll(".slot-row").forEach(r => r.remove());

    const graphInfo = graphsCache[sec.key];
    if (graphInfo) {
      infoEl.textContent = `(${graphInfo.num_nodes} nodes)`;
    } else {
      infoEl.textContent = "(not available)";
    }

    const sectionSlots = config.slots[sec.key] || {};
    const sortedNums = Object.keys(sectionSlots).sort((a, b) => parseInt(a) - parseInt(b));
    const emptyEl = slotsContainer.querySelector(".section-empty");

    if (sortedNums.length > 0) {
      if (emptyEl) emptyEl.style.display = "none";
      for (const numStr of sortedNums) {
        const slotCfg = sectionSlots[numStr];
        const row = buildSlotRow(sec.key, parseInt(numStr), slotCfg.tool || "", slotCfg.label || "");
        slotsContainer.appendChild(row);
      }
    } else {
      if (emptyEl) emptyEl.style.display = "";
    }

    updateSectionToggleBtn(sec.key);
  }

  const totalNodes = Object.values(nodesCache).reduce((s, n) => s + n.length, 0);
  const totalSlots = Object.values(config.slots).reduce((s, sec) => s + Object.keys(sec).length, 0);
  flash(`Refreshed — ${totalNodes} nodes, ${totalSlots} slot(s)`);
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
async function doScan() {
  const modal = document.getElementById("scan-modal");
  const output = document.getElementById("scan-output");

  try {
    const result = await invoke("bridge_scan");
    let text = "";
    for (const sec of SECTIONS) {
      const data = result[sec.key];
      if (data && data.nodes && data.nodes.length > 0) {
        text += `  ${sec.label} (${data.context || "?"}) — ${data.nodes.length} nodes\n`;
        text += `  ${"#".padEnd(4)} ${"Label".padEnd(20)} ${"Cache".padEnd(6)} ${"Tools".padEnd(30)} LUT\n`;
        text += `  ${"─".repeat(4)} ${"─".repeat(20)} ${"─".repeat(6)} ${"─".repeat(30)} ${"─".repeat(20)}\n`;
        for (const n of data.nodes) {
          const toolDisplay = n.tool_str + (n.is_ofx ? "  ◆" : "");
          text += `  ${String(n.index).padEnd(4)} ${(n.label || "—").padEnd(20)} ${(n.cache || "?").padEnd(6)} ${toolDisplay.padEnd(30)} ${n.lut || ""}\n`;
        }
      } else {
        text += `  ${sec.label} — (not available)\n`;
      }
      text += "\n";
    }
    text += "  Legend: ◆ = OFX plugin or DCTL\n";
    output.textContent = text;
  } catch (e) {
    output.textContent = `Error: ${e}`;
  }

  modal.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------
async function doSaveProfile() {
  const modal = document.getElementById("profile-save-modal");
  const input = document.getElementById("profile-name-input");
  const existingDiv = document.getElementById("existing-profiles-save");

  input.value = "";
  existingDiv.innerHTML = "";

  try {
    const profiles = await invoke("list_profiles");
    if (profiles.length > 0) {
      const hint = document.createElement("div");
      hint.className = "existing-profiles-hint";
      hint.textContent = "Existing:";
      existingDiv.appendChild(hint);
      for (const name of profiles) {
        const tag = document.createElement("span");
        tag.className = "existing-profile-tag";
        tag.textContent = name;
        tag.addEventListener("click", () => { input.value = name; });
        existingDiv.appendChild(tag);
      }
    }
  } catch (e) {
    console.error("list profiles:", e);
  }

  modal.classList.remove("hidden");
  input.focus();
}

async function confirmSaveProfile() {
  const input = document.getElementById("profile-name-input");
  const name = input.value.trim().replace(/[/\\\.]/g, "_");
  if (!name) { flash("Enter a profile name"); return; }

  try {
    await invoke("save_profile", { name });
    $activeProf.textContent = `⬤ ${name}`;
    flash(`Profile "${name}" saved`);
  } catch (e) {
    flash(`Save failed: ${e}`);
  }
  document.getElementById("profile-save-modal").classList.add("hidden");
}

async function doLoadProfile() {
  const modal = document.getElementById("profile-load-modal");
  const listDiv = document.getElementById("profile-list-load");
  listDiv.innerHTML = "";

  try {
    const profiles = await invoke("list_profiles");
    if (!profiles.length) {
      flash("No saved profiles");
      return;
    }

    for (const name of profiles) {
      const row = document.createElement("div");
      row.className = "profile-row";

      const nameEl = document.createElement("span");
      nameEl.className = "profile-name";
      nameEl.textContent = name;
      nameEl.addEventListener("click", async () => {
        try {
          const newConfig = await invoke("load_profile", { name });
          config = newConfig;
          $activeProf.textContent = `⬤ ${name}`;
          modal.classList.add("hidden");
          flash(`Profile "${name}" loaded — refreshing...`);
          setTimeout(refresh, 100);
        } catch (e) {
          flash(`Load failed: ${e}`);
        }
      });
      row.appendChild(nameEl);

      const delBtn = document.createElement("span");
      delBtn.className = "profile-delete";
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", async () => {
        try {
          await invoke("delete_profile", { name });
          row.remove();
          flash(`Profile "${name}" deleted`);
          if (!listDiv.querySelector(".profile-row")) modal.classList.add("hidden");
        } catch (e) {
          flash(`Delete failed: ${e}`);
        }
      });
      row.appendChild(delBtn);

      listDiv.appendChild(row);
    }
  } catch (e) {
    flash(`Error: ${e}`);
    return;
  }

  modal.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------
async function saveConfig() {
  try {
    await invoke("save_config", { config });
  } catch (e) {
    console.error("Save config error:", e);
  }
}

async function loadConfig() {
  try {
    config = await invoke("get_config");
    if (!config.slots) config.slots = {};
  } catch (e) {
    config = { slots: {} };
  }
}

async function loadState() {
  try {
    stateData = await invoke("get_state_data");
  } catch (e) {
    stateData = {};
  }
}

// ---------------------------------------------------------------------------
// Hotkey utilities
// ---------------------------------------------------------------------------

// Default hotkey mappings (fallback when no custom binding is set)
function getDefaultMapping() {
  const isMac = navigator.platform.includes("Mac");
  return isMac ? {
    clip: "Option+CommandOrControl",
    timeline: "Option+Control",
    pre_group: "Option+Shift",
    post_group: "Option+Control+Shift",
  } : {
    clip: "Control+Shift",
    timeline: "Control+Alt",
    pre_group: "Alt+Shift",
    post_group: "Control+Alt+Shift",
  };
}

function getDefaultMasterKey() {
  const isMac = navigator.platform.includes("Mac");
  return isMac ? "Option+CommandOrControl+0" : "Control+Shift+0";
}

// Convert a Tauri shortcut string to a nice display label
function formatShortcutDisplay(shortcut) {
  if (!shortcut) return "⌨";
  const isMac = navigator.platform.includes("Mac");
  if (isMac) {
    return shortcut
      .replace(/CommandOrControl/g, "⌘")
      .replace(/Option/g, "⌥")
      .replace(/Control/g, "⌃")
      .replace(/Shift/g, "⇧")
      .replace(/\+/g, "");
  }
  return shortcut;
}

// Convert a browser KeyboardEvent to a Tauri accelerator string
function keyEventToAccelerator(e) {
  const parts = [];
  const isMac = navigator.platform.includes("Mac");

  if (isMac) {
    if (e.altKey) parts.push("Option");
    if (e.metaKey) parts.push("CommandOrControl");
    if (e.ctrlKey && !e.metaKey) parts.push("Control");
    if (e.shiftKey) parts.push("Shift");
  } else {
    if (e.ctrlKey) parts.push("Control");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
  }

  // Ignore pure modifier keypresses
  const key = e.key;
  if (["Meta", "Control", "Alt", "Shift", "CapsLock", "Tab"].includes(key)) {
    return { partial: parts.join("+"), full: null };
  }

  // Map common keys to Tauri accelerator names
  let keyName;
  if (key >= "0" && key <= "9") keyName = key;
  else if (key >= "a" && key <= "z") keyName = key.toUpperCase();
  else if (key >= "A" && key <= "Z") keyName = key;
  else if (key >= "F1" && key <= "F24") keyName = key;
  else if (key === " ") keyName = "Space";
  else if (key === "Escape") keyName = "Escape";
  else if (key === "Enter") keyName = "Enter";
  else if (key === "Backspace") keyName = "Backspace";
  else if (key === "Delete") keyName = "Delete";
  else if (key === "ArrowUp") keyName = "Up";
  else if (key === "ArrowDown") keyName = "Down";
  else if (key === "ArrowLeft") keyName = "Left";
  else if (key === "ArrowRight") keyName = "Right";
  else keyName = key.toUpperCase();

  if (parts.length === 0) {
    // Require at least one modifier
    return { partial: keyName, full: null };
  }

  parts.push(keyName);
  return { partial: null, full: parts.join("+") };
}

// ---------------------------------------------------------------------------
// Hotkey recording modal
// ---------------------------------------------------------------------------

function openHotkeyModal(sectionKey, slotNum, hotkeyBtn) {
  const modal = document.getElementById("hotkey-modal");
  const display = document.getElementById("hotkey-display");
  const slotLabel = document.getElementById("hotkey-modal-slot");
  const sec = SECTIONS.find(s => s.key === sectionKey);
  const slotCfg = config.slots[sectionKey]?.[String(slotNum)];
  const toolName = slotCfg?.tool || "(empty)";

  slotLabel.textContent = `${sec.label} · Slot ${slotNum} · ${toolName}`;

  const current = slotCfg?.hotkey || "";
  display.textContent = current ? formatShortcutDisplay(current) : "Press a key combo…";
  display.classList.remove("recording");

  hotkeyModalState = { section: sectionKey, slot: slotNum, hotkeyBtn, captured: current };
  modal.classList.remove("hidden");

  // Start listening for keys
  display.classList.add("recording");
}

function closeHotkeyModal() {
  document.getElementById("hotkey-modal").classList.add("hidden");
  hotkeyModalState = null;
}

function onHotkeyKeyDown(e) {
  if (!hotkeyModalState) return;
  const modal = document.getElementById("hotkey-modal");
  if (modal.classList.contains("hidden")) return;

  e.preventDefault();
  e.stopPropagation();

  const display = document.getElementById("hotkey-display");
  const result = keyEventToAccelerator(e);

  if (result.full) {
    hotkeyModalState.captured = result.full;
    display.textContent = formatShortcutDisplay(result.full);
    display.classList.remove("recording");
  } else if (result.partial) {
    display.textContent = formatShortcutDisplay(result.partial) + "…";
    display.classList.add("recording");
  }
}

async function saveHotkeyFromModal() {
  if (!hotkeyModalState) return;
  const { section, slot, hotkeyBtn, captured } = hotkeyModalState;

  if (!config.slots[section]) config.slots[section] = {};
  if (!config.slots[section][String(slot)]) {
    config.slots[section][String(slot)] = { tool: "", label: "" };
  }
  config.slots[section][String(slot)].hotkey = captured || undefined;
  await saveConfig();

  // Update the button display
  if (captured) {
    hotkeyBtn.textContent = formatShortcutDisplay(captured);
    hotkeyBtn.className = "hotkey-btn has-hotkey";
    hotkeyBtn.title = `Hotkey: ${captured}`;
  } else {
    hotkeyBtn.textContent = "⌨";
    hotkeyBtn.className = "hotkey-btn";
    hotkeyBtn.title = "Click to set hotkey";
  }

  closeHotkeyModal();

  // Re-register all hotkeys to pick up the change
  await setupHotkeys();
  flash(captured ? `Hotkey set: ${formatShortcutDisplay(captured)}` : "Hotkey cleared");
}

function clearHotkeyFromModal() {
  if (!hotkeyModalState) return;
  hotkeyModalState.captured = "";
  const display = document.getElementById("hotkey-display");
  display.textContent = "Cleared — click Save to confirm";
  display.classList.remove("recording");
}

// ---------------------------------------------------------------------------
// Global hotkeys
// ---------------------------------------------------------------------------
async function setupHotkeys() {
  try {
    const { register, unregisterAll } = await import("@tauri-apps/plugin-global-shortcut");

    // Unregister everything first to avoid conflicts
    try { await unregisterAll(); } catch (_) { /* ignore */ }
    registeredShortcuts.clear();

    const isMac = navigator.platform.includes("Mac");
    const defaults = getDefaultMapping();
    let registeredCount = 0;

    for (const sec of SECTIONS) {
      const sectionSlots = config.slots[sec.key] || {};
      for (let i = 1; i <= 9; i++) {
        const slotCfg = sectionSlots[String(i)];
        // Use custom hotkey if set, otherwise use default pattern
        const shortcut = slotCfg?.hotkey || `${defaults[sec.key]}+${i}`;

        // Skip if already registered (user assigned same key to two slots)
        if (registeredShortcuts.has(shortcut)) continue;

        try {
          const secKey = sec.key;
          const slotNum = i;
          await register(shortcut, async () => {
            const row = getSectionEl(secKey)?.querySelector(`.slot-row[data-slot="${slotNum}"]`);
            const btn = row?.querySelector(".toggle-btn");
            if (btn) {
              await doToggle(secKey, slotNum, btn);
            } else {
              flash(`Hotkey: no slot ${sec.short}:${slotNum} configured`);
            }
          });
          registeredShortcuts.set(shortcut, { section: sec.key, slot: i });
          registeredCount++;
        } catch (e) {
          console.warn(`Failed to register ${shortcut}:`, e);
        }
      }
    }

    // Master OFF
    const masterKey = getDefaultMasterKey();
    if (!registeredShortcuts.has(masterKey)) {
      try {
        await register(masterKey, masterAllOff);
        registeredShortcuts.set(masterKey, { section: "_master", slot: 0 });
      } catch (e) {
        console.warn("Failed to register master off shortcut:", e);
      }
    }

    // Update legend with custom info if any custom hotkeys exist
    const hasCustom = Object.values(config.slots).some(sec =>
      Object.values(sec).some(s => s.hotkey)
    );
    if (hasCustom) {
      $hotkeyLeg.textContent = `✓ ${registeredCount} hotkeys (custom bindings active)`;
    } else if (isMac) {
      $hotkeyLeg.textContent = "✓ ⌥⌘1-9 clip · ⌥⌃ tl · ⌥⇧ pre · ⌥⌃⇧ post · ⌥⌘0 OFF";
    } else {
      $hotkeyLeg.textContent = "✓ Ctrl⇧1-9 clip · Ctrl+Alt tl · Alt⇧ pre · Ctrl+Alt⇧ post · Ctrl⇧0 OFF";
    }
    $hotkeyLeg.style.color = "#88cc88";
  } catch (e) {
    console.error("Hotkey setup failed:", e);
    $hotkeyLeg.textContent = "⚠ Hotkeys unavailable";
    $hotkeyLeg.style.color = "var(--yellow)";
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  buildSections();

  // Wire up buttons
  document.getElementById("btn-refresh").addEventListener("click", refresh);
  document.getElementById("btn-scan").addEventListener("click", doScan);
  document.getElementById("btn-master-off").addEventListener("click", masterAllOff);
  document.getElementById("btn-save-profile").addEventListener("click", doSaveProfile);
  document.getElementById("btn-load-profile").addEventListener("click", doLoadProfile);
  document.getElementById("btn-scan-close").addEventListener("click", () => {
    document.getElementById("scan-modal").classList.add("hidden");
  });
  document.getElementById("btn-profile-save-confirm").addEventListener("click", confirmSaveProfile);
  document.getElementById("btn-profile-save-cancel").addEventListener("click", () => {
    document.getElementById("profile-save-modal").classList.add("hidden");
  });
  document.getElementById("btn-profile-load-cancel").addEventListener("click", () => {
    document.getElementById("profile-load-modal").classList.add("hidden");
  });

  // Enter key in profile name input
  document.getElementById("profile-name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmSaveProfile();
  });

  // Hotkey modal buttons
  document.getElementById("btn-hotkey-save").addEventListener("click", saveHotkeyFromModal);
  document.getElementById("btn-hotkey-cancel").addEventListener("click", closeHotkeyModal);
  document.getElementById("btn-hotkey-clear").addEventListener("click", clearHotkeyFromModal);

  // Global keydown listener for hotkey recording
  document.addEventListener("keydown", (e) => {
    // If hotkey modal is open, route there first
    if (hotkeyModalState && !document.getElementById("hotkey-modal").classList.contains("hidden")) {
      onHotkeyKeyDown(e);
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === "r") {
      e.preventDefault();
      refresh();
    }
    if (e.key === "Escape") {
      // Close hotkey modal first if open
      if (hotkeyModalState && !document.getElementById("hotkey-modal").classList.contains("hidden")) {
        closeHotkeyModal();
        return;
      }
      // Close any open modal first
      const modals = document.querySelectorAll(".modal:not(.hidden)");
      if (modals.length > 0) {
        modals.forEach(m => m.classList.add("hidden"));
      } else {
        masterAllOff();
      }
    }
  });

  // Load persisted data
  await loadConfig();
  await loadState();

  // Load last profile
  try {
    const lastName = await invoke("get_last_profile_name");
    if (lastName) {
      const profiles = await invoke("list_profiles");
      if (profiles.includes(lastName)) {
        $activeProf.textContent = `⬤ ${lastName}`;
      }
    }
  } catch (e) {
    // ignore
  }

  // Setup hotkeys
  setupHotkeys();

  // Initial refresh
  setTimeout(refresh, 200);
}

init();
