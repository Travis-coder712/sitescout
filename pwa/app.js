"use strict";

const APP_VERSION = "1.0.0"; // single source of truth — service worker derives its cache from this
const CFG = window.SITESCOUT_CONFIG || {};
const LS = {
  access: "sitescout.access",
  history: "sitescout.history",
  queue: "sitescout.queue",
};

// ---- State ----------------------------------------------------------------
let currentScanImage = null; // { data, media_type }
let preMode = "jsea";

// ---- Helpers --------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const getAccess = () => localStorage.getItem(LS.access) || "";
const load = (k) => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 2600);
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

// ---- Image capture --------------------------------------------------------
$("#scanInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const { dataUrl, base64 } = await downscale(file, 1280);
  currentScanImage = { data: base64, media_type: "image/jpeg" };
  const img = $("#scanPreview");
  img.src = dataUrl;
  img.hidden = false;
  $("#scanRun").disabled = false;
});

function downscale(file, maxEdge) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      resolve({ dataUrl, base64: dataUrl.split(",")[1] });
    };
    img.src = URL.createObjectURL(file);
  });
}

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
  if (!currentScanImage) return;
  run("scan", {
    mode: "scan",
    image: currentScanImage.data,
    media_type: currentScanImage.media_type,
    note: $("#scanNote").value.trim(),
  }, "Site scan");
});

$("#preRun").addEventListener("click", () => {
  const text = $("#preText").value.trim();
  run(preMode, { mode: preMode, text }, preMode === "jsea" ? "JSEA review" : "Pre-start prompts");
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
  run("journey", {
    mode: "journey", from, to, hours,
    notes: [$("#jNotes").value.trim(), $("#jContact").value.trim() && `Check-in contact: ${$("#jContact").value.trim()}`]
      .filter(Boolean).join(". "),
  }, `Journey: ${to || from || "trip"}`);
});

// ---- Core run + offline queue ---------------------------------------------
async function run(mode, body, label) {
  if (!getAccess()) {
    toast("Enter your team access code in ⚙ first");
    $("#settingsDlg").showModal();
    return;
  }
  showSpinner();
  if (!navigator.onLine) {
    queueCapture(body, label);
    return;
  }
  try {
    const result = await callWorker(body);
    const record = saveToHistory(label, result);
    renderResult(record);
  } catch (err) {
    // Network hiccup mid-request — queue it rather than lose the capture.
    if (err.name === "TypeError") {
      queueCapture(body, label);
    } else {
      $("#results").hidden = false;
      $("#results").innerHTML = `<div class="result-card"><p>Couldn't analyse: ${escapeHtml(err.message)}</p></div>`;
    }
  }
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

function queueCapture(body, label) {
  const q = load(LS.queue);
  q.push({ id: Date.now(), body, label });
  save(LS.queue, q);
  $("#results").hidden = false;
  $("#results").innerHTML =
    `<div class="result-card"><p><strong>Saved offline.</strong> "${escapeHtml(label)}" will be analysed automatically when you're back in coverage.</p></div>`;
  updateOffline();
}

async function processQueue() {
  if (!navigator.onLine || !getAccess()) return;
  const q = load(LS.queue);
  if (!q.length) return;
  const remaining = [];
  for (const item of q) {
    try {
      const result = await callWorker(item.body);
      saveToHistory(item.label, result);
    } catch {
      remaining.push(item);
    }
  }
  save(LS.queue, remaining);
  if (q.length !== remaining.length) toast(`${q.length - remaining.length} queued scan(s) analysed`);
  updateOffline();
}

// ---- History --------------------------------------------------------------
function saveToHistory(label, result) {
  const hist = load(LS.history);
  const record = { id: Date.now(), label, at: new Date().toISOString(), result };
  hist.unshift(record);
  save(LS.history, hist.slice(0, 100));
  return record;
}
function renderHistory() {
  const hist = load(LS.history);
  const list = $("#historyList");
  const qCount = load(LS.queue).length;
  if (!hist.length && !qCount) { list.innerHTML = `<p class="empty">No scans yet.</p>`; return; }
  list.innerHTML =
    (qCount ? `<div class="history-item"><div class="hi-main"><div class="hi-title">${qCount} scan(s) waiting for coverage</div><div class="hi-sub">Queued offline</div></div><span class="hi-badge">queued</span></div>` : "") +
    hist.map((r) => {
      const n = (r.result.hazards || []).length;
      return `<div class="history-item" data-id="${r.id}"><div class="hi-main"><div class="hi-title">${escapeHtml(r.label)}</div><div class="hi-sub">${fmtDate(r.at)}</div></div><span class="hi-badge">${n} item${n === 1 ? "" : "s"}</span></div>`;
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
  const r = $("#results");

  const hazardHtml = hazards.map((h) => `
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
    </div>`).join("");

  const listBlock = (title, items) =>
    items && items.length
      ? `<div class="list-block"><h4>${title}</h4><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>`
      : "";

  r.hidden = false;
  r.innerHTML = `
    <div class="result-card">
      <div class="result-summary">${escapeHtml(res.summary || "")}</div>
      ${res.site_type ? `<div style="color:var(--muted);font-size:13px;margin-top:6px">Site read as: ${escapeHtml(res.site_type)}</div>` : ""}
    </div>
    ${hazardHtml ? `<div>${hazardHtml}</div>` : ""}
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

  const text = resultToText(record);
  $("#shareBtn").addEventListener("click", () => shareText(record.label, text));
  $("#copyBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard"));
  });
}

function resultToText(record) {
  const res = record.result;
  const lines = [`SiteScout — ${record.label}`, fmtDate(record.at), "", res.summary || ""];
  (res.hazards || []).forEach((h) => {
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

async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title: `SiteScout — ${title}`, text }); return; } catch { /* cancelled */ }
  }
  navigator.clipboard.writeText(text).then(() => toast("Copied (sharing not supported here)"));
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

// ---- Offline handling -----------------------------------------------------
function updateOffline() {
  $("#offlineBanner").hidden = navigator.onLine;
}
window.addEventListener("online", () => { updateOffline(); processQueue(); });
window.addEventListener("offline", updateOffline);
updateOffline();
processQueue();

// ---- Version tag ----------------------------------------------------------
const versionTag = $("#versionTag");
if (versionTag) versionTag.textContent = "SiteScout v" + APP_VERSION;

// ---- Service worker -------------------------------------------------------
// Pass the version in the query so a bump forces the browser to reinstall the SW.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("service-worker.js?v=" + APP_VERSION).catch(() => {}));
}
