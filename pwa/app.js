"use strict";

const APP_VERSION = "1.1.0"; // single source of truth — service worker derives its cache from this
const CFG = window.SITESCOUT_CONFIG || {};

const MAX_PHOTOS = 6;      // per scan — keeps latency and token cost sane
const API_EDGE = 1280;     // px, longest edge of the image sent for analysis
const STORE_EDGE = 800;    // px, longest edge of the copy kept in history
const HISTORY_LIMIT = 50;  // records kept (photos make these much heavier than before)

const LS = { access: "sitescout.access" }; // only small values stay in localStorage
const OLD_LS = { history: "sitescout.history", queue: "sitescout.queue" };

// ---- State ----------------------------------------------------------------
let currentScanPhotos = []; // [{ data, media_type, disp }]
let preMode = "jsea";

// ---- Helpers --------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const getAccess = () => localStorage.getItem(LS.access) || "";

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 2600);
}

// ---- IndexedDB ------------------------------------------------------------
// Photos are far too large for localStorage's ~5MB cap, so history and the
// offline queue live in IndexedDB.
const DB_NAME = "sitescout";
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("history")) d.createObjectStore("history", { keyPath: "id" });
        if (!d.objectStoreNames.contains("queue")) d.createObjectStore("queue", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function idbPut(store, value) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbAll(store) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, "readonly");
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}
async function idbDelete(store, id) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// One-time lift of any pre-v1.1 records out of localStorage.
async function migrateFromLocalStorage() {
  for (const [store, key] of [["history", OLD_LS.history], ["queue", OLD_LS.queue]]) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      for (const rec of JSON.parse(raw) || []) await idbPut(store, rec);
    } catch { /* ignore malformed legacy data */ }
    localStorage.removeItem(key);
  }
}

// ---- Tabs -----------------------------------------------------------------
document.querySelectorAll(".tabbtn").forEach((btn) => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
});
function showTab(name) {
  document.querySelectorAll(".tab").forEach((s) => s.classList.remove("active"));
  document.querySelectorAll(".tabbtn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $(`#tab-${name}`).classList.add("active");
  $("#results").hidden = true;
  if (name === "history") renderHistory();
}

// ---- Settings / access code ----------------------------------------------
$("#settingsBtn").addEventListener("click", () => {
  $("#accessInput").value = getAccess();
  $("#settingsDlg").showModal();
});
$("#saveAccess").addEventListener("click", () => {
  localStorage.setItem(LS.access, $("#accessInput").value.trim());
  toast("Access code saved");
});

// ---- Photo capture (multiple) ---------------------------------------------
$("#scanInput").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;

  const room = MAX_PHOTOS - currentScanPhotos.length;
  if (room <= 0) { toast(`Maximum ${MAX_PHOTOS} photos`); return; }
  const take = files.slice(0, room);
  if (files.length > room) toast(`Added ${room} — maximum ${MAX_PHOTOS} photos`);

  for (const file of take) {
    const api = await downscale(file, API_EDGE, 0.82);   // sent for analysis
    const disp = await downscale(file, STORE_EDGE, 0.72); // kept in history
    currentScanPhotos.push({ data: api.base64, media_type: "image/jpeg", disp: disp.dataUrl });
  }
  e.target.value = ""; // let the same file be re-picked later
  renderThumbs();
});

function renderThumbs() {
  const wrap = $("#scanThumbs");
  wrap.innerHTML = currentScanPhotos.map((p, i) => `
    <div class="thumb">
      <img src="${p.disp}" alt="Site photo ${i + 1}" />
      <span class="thumb-num">${i + 1}</span>
      <button class="thumb-x" data-i="${i}" aria-label="Remove photo ${i + 1}">✕</button>
    </div>`).join("");
  wrap.querySelectorAll(".thumb-x").forEach((b) => {
    b.addEventListener("click", () => {
      currentScanPhotos.splice(Number(b.dataset.i), 1);
      renderThumbs();
    });
  });
  wrap.querySelectorAll(".thumb img").forEach((img) => {
    img.addEventListener("click", () => openLightbox(img.src));
  });
  $("#scanRun").disabled = currentScanPhotos.length === 0;
  $("#scanRun").textContent = currentScanPhotos.length > 1
    ? `Analyse site (${currentScanPhotos.length} photos)`
    : "Analyse site";
}

function downscale(file, maxEdge, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      URL.revokeObjectURL(url);
      resolve({ dataUrl, base64: dataUrl.split(",")[1] });
    };
    img.src = url;
  });
}

// ---- Lightbox -------------------------------------------------------------
function openLightbox(src) {
  $("#lightboxImg").src = src;
  $("#lightbox").showModal();
}
$("#lightbox").addEventListener("click", () => $("#lightbox").close());

// ---- Pre-start segmented control ------------------------------------------
document.querySelectorAll(".seg").forEach((seg) => {
  seg.addEventListener("click", () => {
    document.querySelectorAll(".seg").forEach((s) => s.classList.remove("active"));
    seg.classList.add("active");
    preMode = seg.dataset.pre;
    $("#preText").placeholder = preMode === "jsea"
      ? "Paste your JSEA text to review…"
      : "Describe the planned work (e.g. 'excavator test pits, roadside, semi-rural, summer, one worker').";
  });
});
$("#preText").addEventListener("input", (e) => {
  $("#preRun").disabled = e.target.value.trim().length < 8;
});

// ---- Run buttons ----------------------------------------------------------
$("#scanRun").addEventListener("click", () => {
  if (!currentScanPhotos.length) return;
  const n = currentScanPhotos.length;
  const photos = currentScanPhotos.map((p) => p.disp); // display copies for history
  run({
    mode: "scan",
    images: currentScanPhotos.map((p) => ({ data: p.data, media_type: p.media_type })),
    note: $("#scanNote").value.trim(),
  }, n > 1 ? `Site scan (${n} photos)` : "Site scan", photos);
});

$("#preRun").addEventListener("click", () => {
  const text = $("#preText").value.trim();
  run({ mode: preMode, text }, preMode === "jsea" ? "JSEA review" : "Pre-start prompts");
});

// ---- Journey --------------------------------------------------------------
$("#jHours").addEventListener("input", renderBreakPlan);
function renderBreakPlan() {
  const hours = parseFloat($("#jHours").value);
  const box = $("#breakPlan");
  if (!hours || hours <= 0) { box.hidden = true; return; }
  const breaks = Math.max(0, Math.ceil(hours / 2) - 1);
  const stops = [];
  for (let i = 1; i <= breaks; i++) stops.push(`Break ${i}: after ${i * 2} h driving`);
  const total = (hours + breaks * 0.25).toFixed(2).replace(/\.00$/, "");
  box.hidden = false;
  box.innerHTML =
    `<strong>Rest breaks (2-hour rule):</strong> ${breaks || "none needed"}` +
    (stops.length ? `<ul>${stops.map((s) => `<li>${s}</li>`).join("")}</ul>` : "") +
    `<div style="margin-top:8px;color:var(--muted)">Approx. total incl. 15-min breaks: ${total} h</div>`;
}
$("#jRun").addEventListener("click", () => {
  const from = $("#jFrom").value.trim();
  const to = $("#jTo").value.trim();
  const hours = parseFloat($("#jHours").value) || null;
  if (!from && !to && !hours) { toast("Add at least a destination or drive time"); return; }
  run({
    mode: "journey", from, to, hours,
    notes: [$("#jNotes").value.trim(), $("#jContact").value.trim() && `Check-in contact: ${$("#jContact").value.trim()}`]
      .filter(Boolean).join(". "),
  }, `Journey: ${to || from || "trip"}`);
});

// ---- Core run + offline queue ---------------------------------------------
async function run(body, label, photos = []) {
  if (!getAccess()) {
    toast("Enter your team access code in ⚙ first");
    $("#settingsDlg").showModal();
    return;
  }
  showSpinner();
  if (!navigator.onLine) return queueCapture(body, label, photos);

  try {
    const result = await callWorker(body);
    const record = await saveToHistory(label, result, photos);
    renderResult(record);
    if (body.mode === "scan") clearScan();
  } catch (err) {
    // Network hiccup mid-request — queue it rather than lose the capture.
    if (err.name === "TypeError") {
      queueCapture(body, label, photos);
    } else {
      $("#results").hidden = false;
      $("#results").innerHTML = `<div class="result-card"><p>Couldn't analyse: ${escapeHtml(err.message)}</p></div>`;
    }
  }
}

function clearScan() {
  currentScanPhotos = [];
  $("#scanNote").value = "";
  renderThumbs();
}

async function callWorker(body) {
  const res = await fetch(CFG.WORKER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sitescout-access": getAccess() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

async function queueCapture(body, label, photos = []) {
  await idbPut("queue", { id: Date.now(), body, label, photos });
  $("#results").hidden = false;
  $("#results").innerHTML =
    `<div class="result-card"><p><strong>Saved offline.</strong> "${escapeHtml(label)}" will be analysed automatically when you're back in coverage.</p></div>`;
  if (body.mode === "scan") clearScan();
  updateOffline();
}

async function processQueue() {
  if (!navigator.onLine || !getAccess()) return;
  const q = await idbAll("queue");
  if (!q.length) return;
  let done = 0;
  for (const item of q) {
    try {
      const result = await callWorker(item.body);
      await saveToHistory(item.label, result, item.photos || []);
      await idbDelete("queue", item.id);
      done++;
    } catch { /* leave it queued for the next attempt */ }
  }
  if (done) toast(`${done} queued scan(s) analysed`);
  updateOffline();
}

// ---- History --------------------------------------------------------------
async function saveToHistory(label, result, photos = []) {
  const record = { id: Date.now(), label, at: new Date().toISOString(), result, photos };
  await idbPut("history", record);
  await pruneHistory();
  return record;
}

async function pruneHistory() {
  const all = await idbAll("history");
  if (all.length <= HISTORY_LIMIT) return;
  const oldest = all.sort((a, b) => a.id - b.id).slice(0, all.length - HISTORY_LIMIT);
  for (const r of oldest) await idbDelete("history", r.id);
}

async function renderHistory() {
  const list = $("#historyList");
  const hist = (await idbAll("history")).sort((a, b) => b.id - a.id);
  const qCount = (await idbAll("queue")).length;

  if (!hist.length && !qCount) { list.innerHTML = `<p class="empty">No scans yet.</p>`; return; }

  list.innerHTML =
    (qCount ? `<div class="history-item"><div class="hi-main"><div class="hi-title">${qCount} scan(s) waiting for coverage</div><div class="hi-sub">Queued offline</div></div><span class="hi-badge">queued</span></div>` : "") +
    hist.map((r) => {
      const n = (r.result.hazards || []).length;
      const photos = r.photos || [];
      const thumb = photos.length ? `<img class="hi-thumb" src="${photos[0]}" alt="" />` : "";
      const pCount = photos.length > 1 ? ` · ${photos.length} photos` : photos.length === 1 ? " · 1 photo" : "";
      return `<div class="history-item" data-id="${r.id}">
          ${thumb}
          <div class="hi-main">
            <div class="hi-title">${escapeHtml(r.label)}</div>
            <div class="hi-sub">${fmtDate(r.at)}${pCount}</div>
          </div>
          <span class="hi-badge">${n} item${n === 1 ? "" : "s"}</span>
        </div>`;
    }).join("");

  list.querySelectorAll(".history-item[data-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const rec = hist.find((r) => String(r.id) === el.dataset.id);
      if (rec) renderResult(rec);
    });
  });
}

// ---- Result rendering -----------------------------------------------------
function showSpinner() {
  const r = $("#results");
  r.hidden = false;
  r.innerHTML = `<div class="spinner">Analysing<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></div>`;
  r.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderResult(record) {
  const res = record.result;
  const hazards = res.hazards || [];
  const photos = record.photos || [];
  const r = $("#results");

  const photosHtml = photos.length
    ? `<div class="result-photos">${photos.map((p, i) => `<img src="${p}" alt="Site photo ${i + 1}" />`).join("")}</div>`
    : "";

  // Tally by risk and by category so the crew sees the shape of the findings at a glance.
  const RISKS = ["high", "medium", "low"];
  const byRisk = {};
  const byCat = {};
  hazards.forEach((h) => {
    byRisk[h.risk] = (byRisk[h.risk] || 0) + 1;
    byCat[h.category] = (byCat[h.category] || 0) + 1;
  });

  const statsHtml = hazards.length ? `
    <div class="stats">
      <div class="stats-row">
        ${RISKS.filter((r) => byRisk[r]).map((r) =>
          `<span class="stat risk-${r}"><b>${byRisk[r]}</b> ${r}</span>`).join("")}
      </div>
      <div class="stats-row">
        ${Object.keys(byCat).sort().map((c) =>
          `<span class="stat cat ${c}"><b>${byCat[c]}</b> ${catLabel(c)}</span>`).join("")}
      </div>
    </div>` : "";

  const hazardCard = (h) => `
    <div class="hazard ${h.risk}">
      <div class="hazard-head">
        <span class="hazard-title">${escapeHtml(h.title)}</span>
        <span class="chip ${h.category}">${h.category}</span>
        <span class="chip risk-${h.risk}">${h.risk}</span>
      </div>
      <div class="hazard-body">
        <div><span class="lbl">Watch for</span> ${escapeHtml(h.watch_for)}</div>
        <div style="margin-top:4px"><span class="lbl">Suggested</span> ${escapeHtml(h.suggested_control)}</div>
      </div>
    </div>`;

  // Group by risk. High opens by default; medium/low start collapsed so the
  // serious items aren't buried in a long list.
  const hazardHtml = RISKS.filter((r) => byRisk[r]).map((r) => `
    <details class="risk-group" ${r === "high" ? "open" : ""}>
      <summary>
        <span class="grp-dot ${r}"></span>
        <span class="grp-label">${cap(r)} risk</span>
        <span class="grp-count">${byRisk[r]}</span>
      </summary>
      <div class="grp-body">${hazards.filter((h) => h.risk === r).map(hazardCard).join("")}</div>
    </details>`).join("");

  const listBlock = (title, items) =>
    items && items.length
      ? `<div class="list-block"><h4>${title}</h4><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>`
      : "";

  r.hidden = false;
  r.innerHTML = `
    ${photosHtml}
    <div class="result-card">
      <div class="result-summary">${escapeHtml(res.summary || "")}</div>
      ${res.site_type ? `<div style="color:var(--muted);font-size:13px;margin-top:6px">Site read as: ${escapeHtml(res.site_type)}</div>` : ""}
      ${statsHtml}
    </div>
    ${hazardHtml || ""}
    ${listBlock("Questions to answer", res.questions)}
    ${listBlock("Pre-drive checklist", res.checklist)}
    ${listBlock("Good practices", res.good_practices)}
    <div class="result-card">
      <div class="result-actions">
        <button class="primary" id="shareBtn">Share</button>
        <button class="ghost" id="copyBtn">Copy</button>
      </div>
      <p class="disclaimer">${escapeHtml(res.disclaimer || "")}</p>
    </div>`;
  r.scrollIntoView({ behavior: "smooth", block: "start" });

  r.querySelectorAll(".result-photos img").forEach((img) => {
    img.addEventListener("click", () => openLightbox(img.src));
  });

  const text = resultToText(record);
  $("#shareBtn").addEventListener("click", () => shareRecord(record, text));
  $("#copyBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard"));
  });
}

function resultToText(record) {
  const res = record.result;
  const lines = [`SiteScout — ${record.label}`, fmtDate(record.at), "", res.summary || ""];

  const hz = res.hazards || [];
  if (hz.length) {
    const tally = (key) => {
      const c = {};
      hz.forEach((h) => { c[h[key]] = (c[h[key]] || 0) + 1; });
      return c;
    };
    const risk = tally("risk");
    const cat = tally("category");
    const fmtTally = (c, order) =>
      (order || Object.keys(c).sort()).filter((k) => c[k]).map((k) => `${c[k]} ${k}`).join(" · ");
    lines.push("", `Findings: ${fmtTally(risk, ["high", "medium", "low"])}  |  ${fmtTally(cat)}`);
  }

  hz.forEach((h) => {
    lines.push("", `• [${h.risk.toUpperCase()} · ${h.category}] ${h.title}`,
      `  Watch for: ${h.watch_for}`, `  Suggested: ${h.suggested_control}`);
  });
  const sec = (t, items) => { if (items && items.length) { lines.push("", `${t}:`); items.forEach((i) => lines.push(`  - ${i}`)); } };
  sec("Questions to answer", res.questions);
  sec("Pre-drive checklist", res.checklist);
  sec("Good practices", res.good_practices);
  lines.push("", res.disclaimer || "");
  return lines.join("\n");
}

// Share the findings, and the photos too where the platform supports it.
async function shareRecord(record, text) {
  const title = `SiteScout — ${record.label}`;
  const photos = record.photos || [];
  if (navigator.share) {
    try {
      const files = await photosToFiles(photos);
      if (files.length && navigator.canShare && navigator.canShare({ files })) {
        await navigator.share({ title, text, files });
      } else {
        await navigator.share({ title, text });
      }
      return;
    } catch { /* cancelled or unsupported — fall through */ }
  }
  navigator.clipboard.writeText(text).then(() => toast("Copied (sharing not supported here)"));
}

async function photosToFiles(photos) {
  const files = [];
  for (let i = 0; i < photos.length; i++) {
    try {
      const blob = await (await fetch(photos[i])).blob();
      files.push(new File([blob], `sitescout-${i + 1}.jpg`, { type: "image/jpeg" }));
    } catch { /* skip a photo that won't convert */ }
  }
  return files;
}

// ---- Utilities ------------------------------------------------------------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
// Journey mode uses its own categories (fatigue, road, …), so fall back to Capitalised.
const CAT_LABELS = { safety: "Safety", environment: "Environment", health: "Health" };
const catLabel = (c) => CAT_LABELS[c] || cap(c);

// ---- Offline handling -----------------------------------------------------
function updateOffline() {
  $("#offlineBanner").hidden = navigator.onLine;
}
window.addEventListener("online", () => { updateOffline(); processQueue(); });
window.addEventListener("offline", updateOffline);
updateOffline();

// ---- Init -----------------------------------------------------------------
(async () => {
  try { await migrateFromLocalStorage(); } catch { /* non-fatal */ }
  processQueue();
})();

// ---- Version tag ----------------------------------------------------------
const versionTag = $("#versionTag");
if (versionTag) versionTag.textContent = "SiteScout v" + APP_VERSION;

// ---- Service worker -------------------------------------------------------
// Pass the version in the query so a bump forces the browser to reinstall the SW.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("service-worker.js?v=" + APP_VERSION).catch(() => {}));
}
