// serve/web/app.js - the Strata web app: Chat, Monitor, About. No framework, no network beyond this server.
// The Monitor tab rebuilds PR #22's dashboard idea (code-martin) on the server's own /metrics.
"use strict";

const $ = (id) => document.getElementById(id);
const SPRITE = "web/sprite.svg";
const icon = (name, cls = "st-icon") => `<svg class="${cls}" aria-hidden="true"><use href="${SPRITE}#i-${name}"/></svg>`;
// an icon-only button, built the same way every one of them is in this page
const iconBtn = (cls, name, aria, title) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.setAttribute("aria-label", aria);
  b.title = title;
  b.innerHTML = icon(name);
  return b;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString(undefined, {maximumFractionDigits: d, minimumFractionDigits: d}));
const kfmt = (n) => (n == null ? "–" : n >= 1000 ? `${fmt(n / 1000, n >= 10000 ? 0 : 1)}k` : fmt(n));
// a context size: 32768 -> "32K" (powers of two), else like kfmt
const ctxfmt = (n) => (n && n % 1024 === 0 ? `${fmt(n / 1024)}K` : kfmt(n));
const gb = (b, d = 1) => (b == null ? "–" : fmt(b / 1073741824, d));   // memory: binary GB, as Windows shows it
// I18N.t for a UI string; TK for a string the server may answer with a word this page has no translation for
const T = (k, p) => I18N.t(k, p);
const TK = (k, fallback, p) => (I18N.STRINGS[k] ? I18N.t(k, p) : fallback);

const store = {
  get(k, d) { try { const v = localStorage.getItem("strata." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("strata." + k, JSON.stringify(v)); } catch (e) { /* private mode: in memory only */ } },
};

// ------------------------------------------------------------------ toasts
function toast(kind, title, text = "", ms = 3500, action = null) {
  const names = {info: "info", success: "check", warn: "warning", error: "error"};
  const el = document.createElement("div");
  el.className = `st-toast st-toast--${kind}`;
  el.innerHTML = `${icon(names[kind] || "info")}<div><div class="st-toast__title"></div><div class="t-text"></div></div>`;
  el.querySelector(".st-toast__title").textContent = title;
  el.querySelector(".t-text").textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.className = "st-btn st-btn--secondary";
    b.style.height = "32px";
    b.style.marginLeft = "auto";
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
  }
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {                                   // http on another host: no async clipboard
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  if (btn) {
    const use = btn.querySelector("use");
    use.setAttribute("href", `${SPRITE}#i-check`);
    setTimeout(() => use.setAttribute("href", `${SPRITE}#i-copy`), 1500);
  }
  toast("success", T("toast.copied"), "", 1800);
}

// ------------------------------------------------------------------ theme and tabs
// the system's theme until the user picks one (only a click is saved)
function setTheme(t, save) {
  document.documentElement.dataset.theme = t;
  if (save) try { localStorage.setItem("strata.theme", t); } catch (e) { /* ignore */ }
  $("theme-icon").setAttribute("href", `${SPRITE}#i-${t === "dark" ? "sun" : "moon"}`);
  $("dark-toggle").setAttribute("aria-checked", String(t === "dark"));
}
const flipTheme = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
$("theme-btn").onclick = flipTheme;
$("dark-toggle").onclick = flipTheme;
setTheme(document.documentElement.dataset.theme || "light", false);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  let saved = null;
  try { saved = localStorage.getItem("strata.theme"); } catch (err) { /* ignore */ }
  if (!saved) setTheme(e.matches ? "dark" : "light", false);
});

let tab = "chat";
function showTab(name) {
  tab = ["chat", "monitor", "about"].includes(name) ? name : "chat";
  for (const b of document.querySelectorAll(".st-tab")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of ["chat", "monitor", "about"]) $(`view-${v}`).hidden = v !== tab;
  if (location.hash.slice(1) !== tab) history.replaceState(null, "", tab === "chat" ? location.pathname : `#${tab}`);
  if (tab === "chat") $("input").focus();
  if (tab === "monitor") loadMcp();
  if (tab === "about") loadConfig();
  if (lastMetrics) render(lastMetrics);
}
for (const b of document.querySelectorAll(".st-tab")) b.onclick = () => showTab(b.dataset.tab);
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ------------------------------------------------------------------ server access
function headers(json = false) {
  const h = {};
  const key = store.get("apikey", "");
  if (key) h.Authorization = "Bearer " + key;
  if (json) h["Content-Type"] = "application/json";
  return h;
}
$("api-key").value = store.get("apikey", "");
$("api-key").onchange = () => { store.set("apikey", $("api-key").value.trim()); toast("success", T("toast.keySaved"), T("toast.keySavedNote")); };

let health = {model: "strata", images: false, max_context: 0};
async function loadHealth() {
  try {
    health = await (await fetch("health")).json();
    $("attach-btn").title = health.images ? T("chat.attachTitleImages") : T("chat.attachTitle");
    $("chat-empty-sub").textContent = T("chat.emptySubModel", {model: health.model});
  } catch (e) {
    setTimeout(loadHealth, 2000);
  }
}

// ------------------------------------------------------------------ Monitor
const METRICS = [
  // the label comes from the dictionary: T("metric." + key)
  {key: "speed", icon: "gauge", unit: "t/s", series: "tok_s"},
  {key: "gpu", icon: "gpu", unit: "%", series: "gpu_util", max: 100},
  {key: "vram", icon: "layers", unit: "GB", series: "gpu_mem_used"},
  {key: "temp", icon: "thermometer", unit: "°C", series: "gpu_temp", tone: "warn"},
  {key: "power", icon: "bolt", unit: "W", series: "gpu_power"},
  {key: "pcie", icon: "link", unit: "", series: "gpu_pcie_rx_mb", tone: "info"},
  {key: "cpu", icon: "cpu", unit: "%", series: "cpu", max: 100},
  {key: "disk", icon: "disk", unit: "MB/s", series: "disk_read_mb", tone: "info"},
];
$("metrics").innerHTML = METRICS.map((m) => `
  <div class="st-card metric-card"><div class="st-metric">
    <span class="st-metric__label">${icon(m.icon, "st-icon st-icon--sm")}${esc(T("metric." + m.key))}</span>
    ${m.key === "speed" ? `<div class="speed-values">
      <div><span class="st-metric__value" id="mv-speed">-</span><span class="st-metric__sub" id="ms-speed" data-i18n="sub.decode">Decode</span></div>
      <div class="speed-prefill"><span class="st-metric__value" id="mv-prefill">-</span><span class="st-metric__sub" id="ms-prefill" data-i18n="sub.prefill">Prefill</span></div>
    </div>` : `<span class="st-metric__value" id="mv-${m.key}">–</span>
    <span class="st-metric__sub" id="ms-${m.key}"></span>`}
    <svg class="st-metric__spark" id="sp-${m.key}" viewBox="0 0 100 32" preserveAspectRatio="none"${m.tone ? ` data-tone="${m.tone}"` : ""}>
      <path class="area" fill="currentColor" opacity=".12"/><path class="line" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      ${m.key === "speed" ? `<g id="sp-prefill" class="speed-prefill"><path class="area" fill="currentColor" opacity=".12"/>
        <path class="line" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"
        stroke-linecap="round" vector-effect="non-scaling-stroke"/></g>` : ""}</svg>
  </div></div>`).join("");

function spark(id, values, max) {
  const svg = $(id);
  const v = (values || []).map((x) => (x == null ? 0 : x));
  if (v.length < 2) { svg.querySelector(".line").setAttribute("d", ""); svg.querySelector(".area").setAttribute("d", ""); return; }
  const top = Math.max(max || 0, ...v, 1);
  const pts = v.map((x, i) => [(i / (v.length - 1)) * 100, 30 - (x / top) * 26]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("");
  svg.querySelector(".line").setAttribute("d", line);
  svg.querySelector(".area").setAttribute("d", `${line}L100,32L0,32Z`);
}
function setMetric(key, value, unit, sub) {
  $(`mv-${key}`).innerHTML = value == null ? "–" : `${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}`;
  $(`ms-${key}`).textContent = sub || "";
}

let lastMetrics = null, metricsFailures = 0, keyWarned = false, mcpTick = 0;
let reqShowAll = false;   // the Monitor's request table: the last 12, or every one the server keeps (issue #35)
async function poll() {
  try {
    const r = await fetch(reqShowAll ? "metrics?requests=all" : "metrics", {headers: headers()});
    if (r.status === 401) {
      setPill("error", T("pill.keyNeeded"));
      if (!keyWarned) { keyWarned = true; toast("warn", T("pill.keyNeeded"), T("toast.keyNeededNote"), 6000); }
    } else if (r.ok) {
      lastMetrics = await r.json();
      metricsFailures = 0;
      render(lastMetrics);
    } else {
      throw new Error(`HTTP ${r.status}`);
    }
  } catch (e) {
    if (++metricsFailures === 3) setPill("error", T("pill.notReachable"));
  }
  if (tab === "monitor" && ++mcpTick % 10 === 0) loadMcp();       // server states change rarely: every 10 s
  setTimeout(poll, 1000);
}

function setPill(state, text) {
  $("pill").dataset.state = state === "error" ? "queued" : state;
  $("pill-text").textContent = text;
}

function render(m) {
  const live = m.live || {}, hw = m.hardware || {}, st = m.hardware_static || {}, eng = m.engine || {}, h = m.history || {};
  const last = (m.requests || [])[0];
  // the header pill
  if (live.state === "reading") {
    const pct = live.prompt_total ? Math.round((100 * live.prompt_read) / live.prompt_total) : null;
    setPill("reading", pct != null ? T("pill.reading", {pct}) : T("pill.readingPlain"));
  } else if (live.state === "generating") {
    setPill("generating", T("pill.generating", {n: fmt(live.tok_s, 1)}));
  } else {
    setPill("idle", T("pill.idle"));
  }
  if (live.queued > 0) setPill("queued", T("pill.queued", {n: live.queued}));
  if (tab === "monitor") renderMonitor(live, hw, st, eng, h, last, m.requests || [], m.totals, m.requests_kept);
  if (tab === "monitor") renderConvCache(m.conversation_cache);
  if (tab === "about") renderAbout(eng, hw, st);
}

// #596: the conversation cache - the prompt's state the engine keeps between requests (always), and the whole
// conversations it parks in RAM when "--conversation-cache-mib N" is in the run config's args (opt-in)
function since(t) {
  if (!t) return "";
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? T("cc.justNow") : s < 3600 ? T("cc.minAgo", {n: fmt(s / 60)}) : T("cc.hourAgo", {n: fmt(s / 3600, 1)});
}
function renderConvCache(c) {
  $("cc-card").hidden = !c;
  if (!c) return;                                  // an older server
  const pct = (a, b) => (b ? `${Math.min(100, (100 * a) / b)}%` : "0%");
  $("cc-bars").hidden = !c.enabled;
  if (c.enabled) {
    $("cc-slots-text").textContent = `${fmt(c.parked)} / ${fmt(c.slots)}`;
    $("cc-slots-bar").style.width = pct(c.parked, c.slots);
    const budget = c.budget_mib * 1048576;
    $("cc-mem-text").textContent = `${gb(c.bytes)} / ${gb(budget)} GB`;
    $("cc-mem-bar").style.width = pct(c.bytes, budget);
  }
  $("cc-sum").textContent = c.requests ? T("cc.sum", {a: fmt(c.requests_reused), b: fmt(c.requests)}) : "";
  const share = c.prompt_tokens ? T("cc.share", {n: fmt((100 * c.reused_tokens) / c.prompt_tokens)}) : "";
  const event = c.last_event ? T("cc.event", {what: T(c.last_event === "parked" ? "cc.parkedWord" : "cc.restoredWord"),
                                           n: fmt(c.last_tokens), when: since(c.last_at)}) : null;
  facts($("cc-facts"), [
    [T("cc.factLastRequest"), c.last_prompt != null ? T("cc.factLastValue", {a: fmt(c.last_reused || 0), b: fmt(c.last_prompt)}) : null],
    [T("cc.factReused"), c.requests ? `${fmt(c.reused_tokens)} tokens${share}` : null],
    [T("cc.factParked"), c.enabled ? `${fmt(c.parks)} / ${fmt(c.restores)}${c.evictions ? T("cc.evicted", {n: fmt(c.evictions)}) : ""}` : null],
    [T("cc.factLastSwitch"), c.enabled ? event : null],
  ]);
  $("cc-note").textContent = c.enabled ? T("cc.noteOn") : T("cc.noteOff");
}

function renderTotals(t) {
  if (!t || !t.requests) return "";
  const since = new Date(t.since * 1000).toLocaleString([], {weekday: "short", hour: "2-digit", minute: "2-digit"});
  const read = t.prompt_tokens - t.reused;
  const pSpeed = t.prompt_ms > 0 && read > 0 ? T("state.atSpeed", {s: fmt(read / (t.prompt_ms / 1000))}) : "";
  const oSpeed = t.decode_ms > 0 && t.output_tokens > 0 ? T("state.atSpeed", {s: fmt(t.output_tokens / (t.decode_ms / 1000), 1)}) : "";
  return T("totals.line", {since, n: fmt(t.requests), read, ps: pSpeed, reused: fmt(t.reused),
                           out: fmt(t.output_tokens), os: oSpeed});
}
function renderMonitor(live, hw, st, eng, h, last, requests, totals, kept) {
  // model state
  const on = live.queued > 0 ? "queued" : live.state;
  for (const b of document.querySelectorAll("#state-badges .st-badge")) b.classList.toggle("on", b.dataset.s === on || b.dataset.s === live.state);
  const prog = $("state-progress");
  let label = T("monitor.waiting"), detail = "", pct = 0;
  if (live.state === "reading") {
    label = T("state.readingPrompt");
    prog.dataset.tone = "info";
    if (live.prompt_total) {
      pct = (100 * live.prompt_read) / live.prompt_total;
      detail = T("state.readDetail", {a: fmt(live.prompt_read), b: fmt(live.prompt_total), pct: fmt(pct)});
    } else {
      detail = T("state.tokens", {n: fmt(live.prompt_tokens)});
    }
  } else if (live.state === "generating") {
    label = TK("phase." + live.phase, T("state.generating"));
    delete prog.dataset.tone;
    pct = live.max_tokens ? Math.min(100, (100 * live.generated) / live.max_tokens) : 0;
    detail = T("state.genDetail", {n: fmt(live.generated), s: fmt(live.tok_s, 1)});
  } else if (last) {
    delete prog.dataset.tone;
    detail = T("state.lastDetail", {n: fmt(last.output_tokens),
                                    s: last.decode_tok_s ? T("state.atSpeed", {s: fmt(last.decode_tok_s, 1)}) : ""});
  }
  $("state-label").textContent = label;
  $("state-detail").textContent = detail;
  $("state-bar").style.width = `${pct}%`;

  // the eight cards
  const speed = live.state === "generating" ? live.tok_s : last ? last.decode_tok_s : null;
  setMetric("speed", speed == null ? null : fmt(speed, 1), "t/s",
            live.state === "generating" ? T("sub.decodeNow") : last ? T("sub.decodeLast") : T("sub.decode"));
  const prefill = live.state !== "idle" ? live.prefill_tok_s_mean
                : last && last.prompt_ms > 0 ? Math.max(0, last.prompt_tokens - (last.reused || 0)) / (last.prompt_ms / 1000) : null;
  setMetric("prefill", prefill == null ? null : fmt(prefill), "t/s",
            live.state === "reading" ? T("sub.prefillNow") : live.state === "generating" ? T("sub.prefillThis") : last ? T("sub.prefillLast") : T("sub.prefill"));
  spark("sp-speed", h.tok_s);
  spark("sp-prefill", h.prefill_tok_s_mean);
  // a model split across several cards (issue #112): the cards show their total / mean / hottest, and each card's own
  const per = (f) => (hw.gpus || []).map((g) => `GPU ${g.index} ${f(g)}`).join(" · ");
  const multi = (hw.gpus || []).length > 1;
  setMetric("gpu", hw.gpu_util == null ? null : fmt(hw.gpu_util), "%",
            multi ? per((g) => (g.util == null ? "–" : `${fmt(g.util)}%`)) : st.gpu_name || (st.gpu_note ? T("sub.notAvailable") : ""));
  spark("sp-gpu", h.gpu_util, 100);
  setMetric("vram", hw.gpu_mem_used == null ? null : gb(hw.gpu_mem_used), hw.gpu_mem_total ? `/ ${gb(hw.gpu_mem_total, 0)} GB` : "GB",
            multi ? per((g) => (g.mem_used == null ? "–" : `${gb(g.mem_used)} GB`))
                  : eng.expert_slots ? T("sub.expertsCached", {n: fmt(eng.expert_slots)}) : (st.gpu_note ? T("sub.notAvailableAmd") : ""));
  spark("sp-vram", h.gpu_mem_used, hw.gpu_mem_total);
  setMetric("temp", hw.gpu_temp == null ? null : fmt(hw.gpu_temp), "°C",
            multi ? per((g) => (g.temp == null ? "–" : `${fmt(g.temp)}°`)) : "");
  spark("sp-temp", h.gpu_temp, 90);
  setMetric("power", hw.gpu_power == null ? null : fmt(hw.gpu_power), "W", hw.gpu_power_limit ? T("sub.ofLimit", {n: fmt(hw.gpu_power_limit)}) : "");
  spark("sp-power", h.gpu_power, hw.gpu_power_limit);
  const gen = hw.gpu_pcie_gen_max || hw.gpu_pcie_gen;
  setMetric("pcie", gen ? `Gen${gen}` : null, hw.gpu_pcie_width ? `x${hw.gpu_pcie_width}` : "",
            hw.gpu_pcie_rx_mb == null ? "" : T("sub.toGpu", {n: fmt(hw.gpu_pcie_rx_mb, hw.gpu_pcie_rx_mb < 10 ? 1 : 0)}) +
            (hw.gpu_pcie_gen && gen && hw.gpu_pcie_gen < gen ? T("sub.idleGen", {gen: hw.gpu_pcie_gen}) : ""));
  spark("sp-pcie", h.gpu_pcie_rx_mb);
  setMetric("cpu", hw.cpu == null ? null : fmt(hw.cpu), "%", st.threads ? (st.cores ? T("sub.coresThreads", {cores: st.cores, threads: st.threads}) : T("sub.threads", {threads: st.threads})) : "");
  spark("sp-cpu", h.cpu, 100);
  if (hw.disk_read_mb == null) {
    setMetric("disk", null, "", st.psutil ? "" : T("sub.needsPsutil"));
  } else {
    const big = hw.disk_read_mb >= 1000;
    setMetric("disk", big ? fmt(hw.disk_read_mb / 1024, 2) : fmt(hw.disk_read_mb, hw.disk_read_mb < 10 ? 1 : 0), big ? "GB/s" : "MB/s",
              hw.disk_write_mb == null ? "" : T("sub.write", {n: fmt(hw.disk_write_mb, 1)}));
  }
  spark("sp-disk", h.disk_read_mb);

  // context fill: the running request, else the last one
  const ctx = eng.max_context || 0;
  let used = 0;
  if (live.state !== "idle") used = (live.prompt_tokens || 0) + (live.generated || 0);
  else if (last) used = (last.prompt_tokens || 0) + (last.output_tokens || 0);
  const frac = ctx ? Math.min(1, used / ctx) : 0;
  $("ctx-fill").setAttribute("stroke-dasharray", `${(235.6 * frac).toFixed(1)} 314.2`);
  $("ctx-fill").style.opacity = 235.6 * frac >= 3 ? "1" : "0";         // a near-zero arc would draw just its round cap
  $("ctx-pct").textContent = `${Math.round(frac * 100)}%`;
  $("ctx-sub").textContent = ctx ? `${kfmt(used)} / ${ctxfmt(ctx)}` : "–";
  const cacheBytes = (eng.expert_cache_mib || 0) * 1048576;
  $("slots-text").textContent = eng.expert_slots ? `${fmt(eng.expert_slots)} · ${gb(cacheBytes)} GB` : "–";
  $("slots-bar").style.width = hw.gpu_mem_total ? `${Math.min(100, (100 * cacheBytes) / hw.gpu_mem_total)}%` : "0%";
  $("ram-text").textContent = hw.ram_total ? `${gb(hw.ram_used)} / ${gb(hw.ram_total, 0)} GB` : "–";
  const ramPct = hw.ram_total ? (100 * hw.ram_used) / hw.ram_total : 0;
  $("ram-bar").style.width = `${ramPct}%`;
  if (ramPct > 92) $("ram-progress").dataset.tone = "danger"; else delete $("ram-progress").dataset.tone;
  $("temp-text").textContent = hw.gpu_temp == null ? "–" : `${fmt(hw.gpu_temp)} °C`;
  $("temp-bar").style.width = hw.gpu_temp == null ? "0%" : `${Math.min(100, hw.gpu_temp)}%`;

  // recent requests
  const body = $("req-body");
  if (!requests.length) {
    body.innerHTML = `<tr><td colspan="9" class="muted">${T("req.none")}</td></tr>`;
  } else {
    const badge = {stop: ["", T("badge.done")], length: ["", T("badge.maxTokens")], cancel: ["st-badge--queued", T("badge.stopped")],
                   disconnect: ["st-badge--queued", T("badge.closed")], error: ["st-badge--error", T("badge.error")]};
    body.innerHTML = requests.slice(0, reqShowAll ? requests.length : 12).map((r) => {
      const [cls, text] = badge[r.finish] || ["", r.finish || "–"];
      const t = new Date(r.time * 1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
      const proj = r.projection == null ? "" : ` <span class="st-badge${r.projection ? " st-badge--reading" : ""}" title="${esc(T("badge.espTitle", {v: r.projection ? T("badge.on") : T("badge.off")}))}">${r.projection ? "ESP" : esc(T("badge.stock"))}</span>`;
      // #588: the VRAM share; the PCIe share (--pcie-frac) beside it when there is one
      const hit = r.hit_rate == null ? "–" : `${(r.hit_rate * 100).toFixed(1)}%` +
        (r.pcie_share ? ` <span class="muted" title="${esc(T("badge.pcieTitle"))}">+${(r.pcie_share * 100).toFixed(1)}% PCIe</span>` : "");
      // Reused tokens are not prefetched again. Match the Monitor's existing Prefill metric.
      const fresh = r.prompt_tokens == null ? null : Math.max(0, r.prompt_tokens - (r.reused || 0));
      const prefillRate = fresh > 0 && r.prompt_ms > 0 ? fresh / (r.prompt_ms / 1000) : null;
        (r.pcie_share ? ` <span class="muted" title="${esc(T("badge.pcieTitle"))}">+${(r.pcie_share * 100).toFixed(1)}% PCIe</span>` : "");
      return `<tr><td>${esc(t)}</td><td><span class="st-badge ${cls}">${esc(text)}</span>${proj}</td><td class="num">${fmt(r.prompt_tokens)}</td>
        <td class="num">${fmt(r.reused)}</td><td class="num">${fmt(r.output_tokens)}</td><td class="num">${fmt(prefillRate)}</td><td class="num">${fmt(r.decode_tok_s, 1)}</td>
        <td class="num">${hit}</td><td class="num">${fmt(r.duration_s, 1)} s</td></tr>`;
    }).join("");
  }
  const all = $("req-all");
  kept = kept == null ? requests.length : kept;
  all.hidden = kept <= 12;
  all.textContent = reqShowAll ? T("req.showFewer") : T("req.showAll", {n: kept});
  $("req-wrap").classList.toggle("all", reqShowAll);
  $("req-totals").textContent = renderTotals(totals);
}

function facts(el, rows) {
  el.innerHTML = rows.filter((r) => r[1] != null && r[1] !== "").map(([k, v, copy]) =>
    `<dt>${esc(k)}</dt><dd>${copy ? `<code>${esc(v)}</code><button class="st-btn st-btn--icon" data-copy="${esc(v)}" aria-label="${esc(T("fact.copy"))}">${icon("copy")}</button>` : esc(v)}</dd>`).join("");
}
// INFO cvec=project:4-44[:singleL] | add:A-B | 0
function projectionText(c) {
  if (!c || c === "0" || c === 0) return null;
  const [mode, range, single] = String(c).split(":");
  const [a, b] = (range || "").split("-");
  return T("esp.text", {mode: T(mode === "project" ? "esp.modeProject" : "esp.modeAdditive"), a, b,
                         single: single ? T("esp.single", {n: single.replace("single", "")}) : ""});
}
function renderAbout(eng, hw, st) {
  const kv = {int8: "8-bit", q4_0: "4-bit (Hadamard-rotated)", fp16: "16-bit"}[eng.kv] || eng.kv;
  facts($("facts-engine"), [
    [T("fact.model"), eng.model],
    [T("fact.engine"), eng.version ? `v${eng.version}` : T("fact.builtFromSource")],
    [T("fact.context"), eng.max_context ? T("fact.tokens", {n: fmt(eng.max_context)}) : null],
    [T("fact.kvCache"), kv ? `${kv}${eng.kv_resident ? T("fact.kvStreamed", {n: fmt(eng.kv_resident)}) : T("fact.kvAllVram")}` : null],
    [T("fact.expertsVram"), eng.expert_slots ? `${fmt(eng.expert_slots)} (${gb((eng.expert_cache_mib || 0) * 1048576)} GB)` : null],
    [T("fact.speculation"), eng.spec ? T("fact.specValue", {n: Math.max(0, (eng.mtp_max || eng.spec) - 1),
                                          lookup: eng.lookup ? T("fact.promptLookup") : ""}) : null],
    [T("fact.images"), eng.images ? T("badge.on") : T("badge.off")],
    [T("fact.esp"), projectionText(eng.cvec)],
  ]);
  facts($("facts-hw"), [
    [T("fact.gpu"), st.gpu_name ? `${st.gpu_name}${hw.gpu_mem_total ? `, ${gb(hw.gpu_mem_total, 0)} GB` : ""}` : (st.gpu_note || T("fact.gpuNotReadable"))],
    [T("fact.cpu"), st.cpu_name ? `${st.cpu_name}${st.threads ? T("fact.cpuThreads", {n: st.threads}) : ""}` : null],
    [T("fact.ram"), hw.ram_total ? `${gb(hw.ram_total, 0)} GB` : null],
  ]);
  const base = location.origin;
  facts($("facts-api"), [
    [T("fact.openaiUrl"), `${base}/v1`, true],
    [T("fact.anthropicUrl"), base, true],
    [T("fact.modelName"), eng.model, true],
  ]);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (b) copyText(b.dataset.copy, b);
});
$("req-all").addEventListener("click", () => { reqShowAll = !reqShowAll; if (lastMetrics) render(lastMetrics); });

// ------------------------------------------------------------------ MCP servers (GET /mcp)
// Tools from the MCP servers in the run config: the chat offers them to the model (opt-in per request,
// "strata_mcp": true, which only this page sends); the Monitor lists the servers and what they offer.
let mcpInfo = {servers: [], tools: 0}, mcpRetry = null;
async function loadMcp() {
  try {
    const r = await fetch("mcp", {headers: headers()});
    if (!r.ok) return;
    mcpInfo = await r.json();
  } catch (e) { return; /* an older server: no MCP */ }
  renderMcp();
  clearTimeout(mcpRetry);                          // right after the start, servers may still be starting (npx downloads)
  if ((mcpInfo.servers || []).some((s) => s.status === "starting")) mcpRetry = setTimeout(loadMcp, 3000);
}
// a badge label is a dictionary key, not a finished word, so a language switch reaches badges already on screen
const MCP_STATE = {ready: ["st-badge--generating", "mcp.connected"], starting: ["st-badge--reading", "mcp.starting"],
                   failed: ["st-badge--error", "mcp.failed"], stopped: ["st-badge--queued", "mcp.stopped"], idle: ["", "mcp.waiting"]};
function renderMcp() {
  const servers = mcpInfo.servers || [];
  $("mcp-card").hidden = !servers.length;
  $("mcp-row").hidden = !servers.length;
  const ready = servers.filter((s) => s.status === "ready" || s.status === "stopped");
  $("mcp-sum").textContent = servers.length ? T("mcp.sum", {n: fmt(mcpInfo.tools), ready: ready.length, total: servers.length}) : "";
  $("mcp-row-sub").textContent = mcpInfo.tools ? T("mcp.rowSub", {n: fmt(mcpInfo.tools), names: ready.map((s) => s.name).join(", ")})
                                               : T("mcp.rowSubNone");
  $("mcp-list").innerHTML = servers.map((s) => {
    const [cls, key] = MCP_STATE[s.status] || ["", null];
    const text = key ? T(key) : s.status;
    const info = s.info && s.info.name ? ` · ${s.info.name}${s.info.version ? ` ${s.info.version}` : ""}` : "";
    return `<div class="mcp-server"><div class="mcp-server__head"><span class="st-badge ${cls}">${esc(text)}</span>` +
      `<strong>${esc(s.name)}</strong><span class="muted small">${esc(s.transport)} · ${esc(T("mcp.tools", {n: fmt(s.tools.length)}))}${esc(info)}</span></div>` +
      (s.error ? `<div class="msg-error">${esc(s.error)}</div>` : "") +
      (s.tools.length ? `<div class="mcp-server__tools">${s.tools.map((t) => `<span class="chip" title="${esc(t.description || "")}">${esc(t.tool)}</span>`).join("")}</div>` : "") +
      `</div>`;
  }).join("");
}

// ------------------------------------------------------------------ Model settings (GET / POST /config, #564)
// A few documented keys of the run config (strata-<model>.json), for every client, from the next start on.  The
// server lists them, checks every value and keeps every other key of the file as it is.
let cfgKeys = [];
async function loadConfig() {
  let r;
  try { r = await fetch("config", {headers: headers()}); } catch (e) { return; }
  if (!r.ok) { $("cfg-card").hidden = true; return; }       // no run config, an older server, or no key yet
  const c = await r.json();
  cfgKeys = c.keys || [];
  $("cfg-file").textContent = c.file || "";
  $("cfg-form").innerHTML = cfgKeys.map((k, i) => {
    const id = `cfg-${i}`, v = k.value;
    let input;
    const help = TK(`cfg.field.${k.key}`, k.help);      // a key a newer server adds keeps the server's own words
    if (k.kind === "bool" || k.kind === "enum") {
      const opts = k.kind === "bool" ? [["true", T("cfg.on")], ["false", T("cfg.off")]]
                                          : k.choices.map((x) => [x, TK(`cfg.enum.${x}`, x)]);
      const cur = v == null ? "" : String(v);
      input = `<select class="st-input" id="${id}"><option value=""${cur === "" ? " selected" : ""}>${esc(T("cfg.default"))}</option>` +
        opts.map(([val, text]) => `<option value="${esc(val)}"${cur === val ? " selected" : ""}>${esc(text)}</option>`).join("") + `</select>`;
    } else {
      const text = v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
      input = `<input class="st-input" id="${id}" ${k.kind === "number" ? 'type="number" step="any" min="0"' : 'type="text"'} ` +
        `value="${esc(text)}" placeholder="${esc(T("cfg.default"))}" autocomplete="off">`;
    }
    return `<label for="${id}" title="${esc(help)}">${esc(help)}<code>${esc(k.key)}</code></label>${input}`;
  }).join("");
  $("cfg-card").hidden = false;
}
function configValue(k, el) {
  const s = el.value.trim();
  if (s === "") return null;
  if (k.kind === "bool") return s === "true";
  if (k.kind === "number") return Number(s);
  return s;                                         // enum, or names (the server splits them at commas)
}
$("cfg-save").addEventListener("click", async () => {
  const set = {};
  cfgKeys.forEach((k, i) => {
    const v = configValue(k, $(`cfg-${i}`));
    const old = Array.isArray(k.value) ? k.value.join(", ") : k.value;
    if (JSON.stringify(v) !== JSON.stringify(old ?? null)) set[k.key] = v;
  });
  if (!Object.keys(set).length) { $("cfg-msg").textContent = T("cfg.nothingChanged"); return; }
  try {
    const r = await fetch("config", {method: "POST", headers: headers(true), body: JSON.stringify({set})});
    const b = await r.json();
    if (!r.ok) throw new Error((b.error || {}).message || `HTTP ${r.status}`);
    $("cfg-msg").textContent = b.changed.length
      ? T("cfg.saved", {keys: b.changed.join(", "), file: b.file}) : T("cfg.nothingChanged");
    loadConfig();
  } catch (e) {
    $("cfg-msg").textContent = "";
    toast("error", T("toast.notSaved"), String(e.message || e), 6000);
  }
});

// ------------------------------------------------------------------ Markdown (escaped first, then formatted)
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code class="inline">${esc(codes[+i])}</code>`);
}
function codeBlock(lang, code) {
  return `<div class="st-code"><div class="st-code__head"><span>${esc(lang || T("chat.codeLabel"))}</span>` +
    `<button class="st-btn st-btn--icon" data-code-copy aria-label="${esc(T("chat.copyCode"))}">${icon("copy")}</button></div>` +
    `<pre><code>${esc(code)}</code></pre></div>`;
}
function blocks(text) {
  const out = [], lines = text.split("\n");
  let para = [], list = null;
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (!l.trim()) { flushPara(); flushList(); continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<${m[1].length <= 2 ? "h3" : "h4"}>${inline(m[2])}</${m[1].length <= 2 ? "h3" : "h4"}>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { flushPara(); flushList(); out.push("<hr>"); continue; }
    if ((m = l.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      flushPara(); flushList();
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      let html = `<table><thead><tr>${cells(l).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) html += `<tr>${cells(lines[i++]).map((c) => `<td>${c}</td>`).join("")}</tr>`;
      i--;
      out.push(html + "</tbody></table>");
      continue;
    }
    if ((m = l.match(/^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/))) {
      flushPara();
      const tag = m[1] ? "ol" : "ul";
      if (!list || list.tag !== tag) { flushList(); list = {tag, items: []}; }
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(l)) { list.items[list.items.length - 1] += " " + l.trim(); continue; }
    flushList();
    para.push(l);
  }
  flushPara(); flushList();
  return out.join("");
}
function markdown(text) {
  let html = "", rest = text;
  for (;;) {
    const m = rest.match(/(^|\n)```([^\n`]*)\n/);
    if (!m) { html += blocks(rest); break; }
    html += blocks(rest.slice(0, m.index));
    rest = rest.slice(m.index + m[0].length);
    const end = rest.match(/(^|\n)```[ \t]*(\n|$)/);
    if (!end) { html += codeBlock(m[2].trim(), rest); break; }         // still streaming
    html += codeBlock(m[2].trim(), rest.slice(0, end.index));
    rest = rest.slice(end.index + end[0].length);
  }
  return html;
}

// ------------------------------------------------------------------ Chat
const DEFAULTS = {thinking: "high", temperature: 0.6, top_p: 0.95, top_k: 20, max: "", seed: "", show: true, esp: true, mcp: true};
let settings = {...DEFAULTS, ...store.get("sampling", {})};
let messages = store.get("chat", []);
let attachments = [];                 // {name, url}
let busy = null;                      // {controller, msg}

// the chat without the pictures' data URLs, which are too big to store (issue #30)
function slim(msgs) {
  return (msgs || []).map((m) => ({...m, images: (m.images || []).map((i) => ({name: i.name})),
                                   files: (m.files || []).map((f) => ({name: f.name}))}));
}
function saveChat() {
  store.set("chat", slim(messages));
  saveSessions();
}
function timeStr(t) { return new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}); }

function msgEl(m, i) {
  const el = document.createElement("div");
  el.className = `st-msg st-msg--${m.role}`;
  el.dataset.i = i;
  if (m.role === "user") {
    if (m.files && m.files.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-images";
      for (const f of m.files) {
        const c = document.createElement("span");
        c.className = "chip";
        c.innerHTML = icon("attach", "st-icon st-icon--sm");
        c.append(f.name);
        wrap.appendChild(c);
      }
      el.appendChild(wrap);
    }
    if (m.images && m.images.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-images";
      for (const im of m.images) {
        if (im.url) { const img = document.createElement("img"); img.src = im.url; img.alt = im.name || "image"; wrap.appendChild(img); }
        else { const c = document.createElement("span"); c.className = "chip"; c.innerHTML = icon("image", "st-icon st-icon--sm"); c.append(im.name || "image"); wrap.appendChild(c); }
      }
      el.appendChild(wrap);
    }
    const b = document.createElement("div");
    b.className = "st-bubble";
    b.textContent = m.text;
    el.appendChild(b);
    const meta = document.createElement("div");
    meta.className = "st-msg__meta";
    meta.textContent = `${T("chat.you")} · ${timeStr(m.time)}`;
    if (labs.msgTools) {
      meta.textContent = "";
      const label = document.createElement("span");
      label.className = "meta-text";
      label.textContent = `${T("chat.you")} · ${timeStr(m.time)}`;
      const edit = iconBtn("st-btn st-btn--icon", "pen", T("msg.editAria"), T("msg.edit"));
      edit.dataset.msgEdit = "";
      edit.hidden = !!busy;
      meta.append(label, edit);
    }
    el.appendChild(meta);
  } else {
    el.innerHTML = `<details class="st-collapse think" hidden><summary>${icon("thinking", "st-icon st-icon--sm")}<span class="think-title"></span>` +
      `${icon("chevron", "st-icon st-icon--sm st-chev")}</summary><div class="st-collapse__body thinking"></div></details>` +
      `<div class="st-bubble"></div><div class="st-msg__meta"><span class="meta-text"></span>` +
      `<button class="st-btn st-btn--icon" data-msg-copy aria-label="${esc(T("chat.copyAnswer"))}" title="${esc(T("fact.copy"))}">${icon("copy")}</button>` +
      (labs.msgTools ? `<button class="st-btn st-btn--icon" data-msg-regen hidden aria-label="${esc(T("msg.regenerateAria"))}"` +
                      `title="${esc(T("msg.regenerate"))}">${icon("regenerate")}</button>` : "") +
      `</div>`;
    updateAssistant(el, m, false);
  }
  return el;
}
// One MCP tool call in the answer: a compact block (name, state, a one-line preview) that opens to the arguments and
// the result as the model read it.  Its body is built only while open: a result can be 20,000 characters.
// the label is a dictionary key, so a language switch reaches tool calls already rendered in the answer
const TOOL_STATE = {writing: ["st-badge--reading", "tool.writing"], running: ["st-badge--generating", "tool.running"], done: ["", "tool.done"],
                    error: ["st-badge--error", "tool.error"], skipped: ["st-badge--queued", "tool.skipped"]};
function toolHtml(t, k) {
  const [cls, key] = TOOL_STATE[t.state] || ["", null];
  const label = key ? T(key) : t.state;
  const args = t.arguments == null ? "" : JSON.stringify(t.arguments, null, 2);
  const preview = t.result != null ? t.result : args.replace(/\s+/g, " ");
  let body = "";
  if (t.open) {
    body = `<div class="tool-call__label">${T("tool.arguments")}</div><pre class="tool-call__pre">${esc(args || T("tool.beingWritten"))}</pre>`;
    if (t.result != null) {
      body += `<div class="tool-call__label">${t.ok ? T("tool.result") : T("tool.error")}${t.chars ? T("tool.chars", {n: fmt(t.chars)}) : ""}` +
              `${t.truncated ? T("tool.truncated") : ""}</div><pre class="tool-call__pre">${esc(t.result)}</pre>`;
    }
  }
  return `<details class="st-collapse tool-call" data-tool="${k}" data-state="${esc(t.state)}"${t.open ? " open" : ""}>` +
    `<summary>${icon("tool", "st-icon st-icon--sm")}<span class="tool-call__name" title="${esc(t.name || "")}">${esc(t.tool || t.name || "tool")}</span>` +
    (t.server ? `<span class="muted small">${esc(t.server)}</span>` : "") +
    `<span class="tool-call__preview muted">${esc(preview.slice(0, 200))}</span>` +
    `<span class="st-badge ${cls}">${esc(label)}</span>${t.ms != null && t.state !== "skipped" ? `<span class="muted small">${fmt(t.ms / 1000, 1)} s</span>` : ""}` +
    `${icon("chevron", "st-icon st-icon--sm st-chev")}</summary><div class="st-collapse__body">${body}</div></details>`;
}
// the answer's text with the tool blocks where the model called them
function answerHtml(m) {
  if (!m.tools || !m.tools.length) return markdown(m.text || "");
  let html = "", pos = 0;
  m.tools.forEach((t, k) => {
    const at = Math.min(Math.max(t.at || 0, pos), m.text.length);
    if (at > pos) html += markdown(m.text.slice(pos, at));
    pos = at;
    html += toolHtml(t, k);
  });
  return html + markdown(m.text.slice(pos));
}
// a tool event from the stream (the `strata_mcp` field of a chunk)
function onTool(m, x) {
  if (x.event === "limit") { m.limit = x.max_rounds; return; }
  m.tools = m.tools || [];
  let t = m.tools.find((y) => y.id === x.id);
  if (!t) { t = {id: x.id, name: x.name, at: m.text.length, rat: m.reasoning.length, state: "writing"}; m.tools.push(t); }
  if (x.event === "call") {
    Object.assign(t, {name: x.name, server: x.server, tool: x.tool, arguments: x.arguments, round: x.round, state: "running"});
  } else if (x.event === "result") {
    Object.assign(t, {result: x.text, ok: x.ok, chars: x.chars, truncated: x.truncated, ms: x.ms,
                      state: x.skipped ? "skipped" : x.ok ? "done" : "error"});
  }
}
function updateAssistant(el, m, streaming) {
  const det = el.querySelector("details.think");
  if (m.reasoning) {
    det.hidden = false;
    const thinkingNow = streaming && !m.text;
    el.querySelector(".think-title").textContent = thinkingNow ? T("chat.thinkingNow") :
      m.thinkSecs != null ? T("chat.thoughtFor", {n: fmt(m.thinkSecs, 1)}) : T("chat.thoughts");
    const body = el.querySelector(".thinking");
    if (det.open || thinkingNow) body.textContent = m.reasoning;
    else body.dataset.pending = "1";
    // open while it streams (if wanted), closed once the answer starts - unless the user toggled it themselves
    if (thinkingNow && settings.show && !det.dataset.touched && !det.open) { det._auto = true; det.open = true; }
    if (!thinkingNow && det.open && !det.dataset.touched) { det._auto = true; det.open = false; }
  }
  const bubble = el.querySelector(".st-bubble");
  if (m.error) {
    bubble.innerHTML = `<div class="msg-error"></div>`;
    bubble.firstChild.textContent = m.error;
  } else if (!m.text && streaming && !(m.tools && m.tools.length)) {
    bubble.innerHTML = m.reasoning ? `<span class="muted cursor">${T("chat.writing")}</span>` : `<span class="cursor"></span>`;
  } else {
    bubble.innerHTML = answerHtml(m);
    if (streaming) bubble.classList.add("cursor"); else bubble.classList.remove("cursor");
  }
  el.querySelector(".meta-text").textContent = m.meta || (streaming ? "" : m.stopped ? T("chat.stopped") : "");
  el.querySelector("[data-msg-copy]").hidden = streaming || !m.text;
  const regen = el.querySelector("[data-msg-regen]");
  if (regen) regen.hidden = streaming || !m.text;
}
function renderChat() {
  const chat = $("chat");
  chat.querySelectorAll(".st-msg").forEach((e) => e.remove());
  $("chat-empty").hidden = messages.length > 0;
  messages.forEach((m, i) => chat.appendChild(msgEl(m, i)));
  scrollDown(true);
}
function nearBottom() { const s = $("chat-scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 120; }
function scrollDown(force) { const s = $("chat-scroll"); if (force || nearBottom()) s.scrollTop = s.scrollHeight; }

$("chat").addEventListener("click", (e) => {
  const cc = e.target.closest("[data-code-copy]");
  if (cc) { copyText(cc.closest(".st-code").querySelector("pre").textContent, cc); return; }
  const mc = e.target.closest("[data-msg-copy]");
  if (mc) { const i = +mc.closest(".st-msg").dataset.i; copyText(messages[i].text, mc); return; }
  // the Chat add-on's per-message buttons (About > Chat extras)
  const me = e.target.closest("[data-msg-edit]");
  if (me) { startEdit(+me.closest(".st-msg").dataset.i, me.closest(".st-msg")); return; }
  const mr = e.target.closest("[data-msg-regen]");
  if (mr) { regenerate(+mr.closest(".st-msg").dataset.i); return; }
  // a tool block: its open state lives in the message (the answer is rebuilt while it streams), so the click sets it
  const sum = e.target.closest(".tool-call > summary");
  if (sum) {
    e.preventDefault();
    const el = sum.closest(".st-msg"), m = messages[+el.dataset.i], t = m && m.tools && m.tools[+sum.parentElement.dataset.tool];
    if (!t) return;
    t.open = !t.open;
    updateAssistant(el, m, !!busy && busy.msg === m);
  }
});
$("chat").addEventListener("toggle", (e) => {
  const d = e.target;
  if (d.tagName !== "DETAILS" || !d.classList.contains("think")) return;
  if (d._auto) { d._auto = false; return; }          // our own open/close, not the user's
  d.dataset.touched = "1";
  const body = d.querySelector(".thinking");
  if (d.open && body.dataset.pending) { body.textContent = messages[+d.closest(".st-msg").dataset.i].reasoning; delete body.dataset.pending; }
}, true);

function apiMessages() {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      const imgs = (m.images || []).filter((i) => i.url);
      const text = userText(m);
      out.push({role: "user", content: imgs.length ? [{type: "text", text},
        ...imgs.map((i) => ({type: "image_url", image_url: {url: i.url}}))] : text});
    } else if (!(busy && busy.msg === m)) {            // the answer being asked for now is not history yet
      out.push(...assistantMessages(m));
    }
  }
  return out;
}
// An answer that used MCP tools goes back as the model wrote it: per round the text before the calls, the calls and
// their results (as the model read them), then the rest - so the next question can build on what the tools found.
function assistantMessages(m) {
  const ran = (m.tools || []).filter((t) => t.round != null && t.result != null && t.state !== "skipped");
  // #1392: a turn with no answer text (only reasoning, a stop before the first content token, or an error) still goes
  // back as an assistant turn, so the history keeps alternating and a reasoning model sees that it already answered.
  // The server leaves such a turn out of the prompt itself (serve/frontend.py, #843); reasoning_content rides along.
  if (!ran.length) {
    const msg = {role: "assistant", content: m.text || ""};
    if (!m.text && m.reasoning) msg.reasoning_content = m.reasoning;
    return [msg];
  }
  const out = [];
  let pos = 0;
  for (const r of [...new Set(ran.map((t) => t.round))]) {
    const calls = ran.filter((t) => t.round === r);
    const at = Math.min(Math.max(pos, calls[0].at || 0), m.text.length);
    out.push({role: "assistant", content: m.text.slice(pos, at).trim(),
              tool_calls: calls.map((t) => ({id: t.id, type: "function", function: {name: t.name, arguments: JSON.stringify(t.arguments || {})}}))});
    for (const t of calls) out.push({role: "tool", tool_call_id: t.id, content: t.result});
    pos = at;
  }
  const rest = m.text.slice(pos).trim();
  if (rest) out.push({role: "assistant", content: rest});
  return out;
}

function setBusy(on) {
  $("stop-btn").hidden = !on;
  $("send-btn").disabled = on;
  $("composer-hint").textContent = on ? "" : T("composer.hint");
  for (const b of document.querySelectorAll("[data-msg-edit], [data-msg-regen]")) b.hidden = on;
}

async function send() {
  const text = $("input").value.trim();
  if ((!text && !attachments.length) || busy) return;
  messages.push({role: "user", text, images: attachments.filter((a) => a.kind !== "file"),
                 files: attachments.filter((a) => a.kind === "file"), time: Date.now()});
  attachments = [];
  renderAttachments();
  $("input").value = "";
  autosize();
  await runAssistant();
}

// The stream itself, for when the last message in `messages` is the question.  A re-sent question (the edit) and a
// regenerated answer both come through here, so they build on the same history a new question builds on.
async function runAssistant() {
  const m = {role: "assistant", text: "", reasoning: "", time: Date.now()};
  messages.push(m);
  renderChat();
  const el = $("chat").lastElementChild;
  el.classList.add("msg-in");            // the new answer cross-fades in over the answer a regenerate dropped
  const controller = new AbortController();
  busy = {controller, msg: m};
  setBusy(true);

  const body = {model: health.model, messages: apiMessages(), stream: true,
                reasoning_effort: settings.thinking};
  if (settings.temperature > 0) {
    Object.assign(body, {temperature: +settings.temperature, top_p: +settings.top_p, top_k: +settings.top_k});
  } else {
    body.temperature = 0;
  }
  if (settings.seed) body.seed = +settings.seed;
  if (settings.max) body.max_tokens = +settings.max;
  if (projectionLoaded()) body.experimental_speed_projection = !!settings.esp;
  if (settings.mcp !== false && mcpInfo.tools > 0) body.strata_mcp = true;   // this server may run MCP tools for it

  let firstAt = null, thinkStart = null, usage = null, frame = 0;
  const paint = () => { frame = 0; updateAssistant(el, m, true); scrollDown(); };
  try {
    const r = await fetch("v1/chat/completions", {method: "POST", headers: headers(true), body: JSON.stringify(body),
                                                   signal: controller.signal});
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).error.message || msg; } catch (e) { /* not json */ }
      if (r.status === 401) msg = T("toast.keyNeededBody");
      throw new Error(msg);
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;              // ": keep-alive" comments while a long prompt is read
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.error) throw new Error(j.error.message || T("toast.engineError"));
        if (j.usage) usage = j.usage;
        if (j.strata_mcp) onTool(m, j.strata_mcp);
        const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
        const lastTool = m.tools && m.tools.length ? m.tools[m.tools.length - 1] : null;   // a new round after a tool
        if (d.reasoning_content) {
          if (!firstAt) firstAt = performance.now();
          if (!thinkStart) thinkStart = performance.now();
          if (lastTool && m.reasoning && lastTool.rat === m.reasoning.length) m.reasoning += "\n\n";
          m.reasoning += d.reasoning_content;
        }
        if (d.content) {
          if (!firstAt) firstAt = performance.now();
          if (thinkStart && m.thinkSecs == null) m.thinkSecs = (performance.now() - thinkStart) / 1000;
          if (lastTool && m.text && lastTool.at === m.text.length) m.text += "\n\n";
          m.text += d.content;
        }
        if (!frame) frame = requestAnimationFrame(paint);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") m.stopped = true;
    else { m.error = e.message || String(e); toast("error", T("toast.requestFailed"), m.error, 6000); }
  }
  if (thinkStart && m.thinkSecs == null) m.thinkSecs = (performance.now() - thinkStart) / 1000;
  const n = usage ? usage.completion_tokens : null;
  if (n && firstAt) {
    const secs = (performance.now() - firstAt) / 1000;
    m.meta = T("chat.metaTokens", {n: fmt(n),
                                   speed: secs > 0.25 ? T("state.atSpeed", {s: fmt(n / secs, 1)}) : "",
                                   stopped: m.stopped ? T("chat.stoppedMeta") : "",
                                   proj: projectionLoaded() ? (settings.esp ? T("chat.projOn") : T("chat.projOff")) : ""});
  } else if (m.stopped) {
    m.meta = T("chat.stopped");
  }
  for (const t of m.tools || []) if (t.state === "writing" || t.state === "running") { t.state = "skipped"; t.ms = null; }
  const ran = (m.tools || []).filter((t) => t.state === "done" || t.state === "error").length;
  if (ran) m.meta = `${m.meta ? `${m.meta} · ` : ""}${T("chat.metaToolCalls", {n: ran, s: T("chat.pluralS")})}`;
  if (m.limit) m.meta = `${m.meta || ""}${T("chat.metaLimit", {n: m.limit})}`;
  busy = null;
  setBusy(false);
  if (frame) cancelAnimationFrame(frame);
  updateAssistant(el, m, false);
  saveChat();
  scrollDown();
}

$("composer").onsubmit = (e) => { e.preventDefault(); send(); };
$("stop-btn").onclick = () => { if (busy) busy.controller.abort(); };
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
function autosize() { const t = $("input"); t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, innerHeight * 0.4)}px`; }
$("input").addEventListener("input", autosize);

$("new-btn").onclick = () => newChat();      // newChat() is in the Chat add-ons below; with them off it is the old path
// the chat as one Markdown file: the same text for the composer's button and for a row in the sidebar
function chatMarkdown(messages) {
  const tools = (m) => (m.tools || []).filter((t) => t.result != null).map((t) =>
    `<details><summary>${T("chat.exportTool")} ${t.server ? `${t.server} / ` : ""}${t.tool || t.name}${t.ok ? "" : T("chat.exportError")}</summary>\n\n` +
    `\`\`\`json\n${JSON.stringify(t.arguments || {}, null, 2)}\n\`\`\`\n\n\`\`\`\n${t.result}\n\`\`\`\n\n</details>\n\n`).join("");
  return messages.map((m) => m.role === "user" ? `## ${T("chat.exportYou")}\n\n${m.text}\n` :
    `## ${health.model}\n\n${m.reasoning ? `<details><summary>${T("chat.exportThinking")}</summary>\n\n${m.reasoning}\n\n</details>\n\n` : ""}${tools(m)}${m.text || m.error || ""}\n`).join("\n");
}
function downloadMarkdown(md) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md], {type: "text/markdown"}));
  a.download = `strata-chat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$("export-btn").onclick = () => exportChat();   // exportChat() is in the Chat add-ons below

// pictures and text files: the attach button, dropping them on the chat, or pasting a picture (issue #30)
const TEXT_EXT = /\.(txt|md|markdown|rst|tex|py|pyi|ipynb|js|mjs|cjs|ts|tsx|jsx|vue|svelte|json|jsonl|csv|tsv|log|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|c|cc|cpp|cxx|h|hh|hpp|cu|cuh|rs|go|java|kt|kts|swift|rb|php|pl|lua|r|jl|scala|sql|sh|bash|zsh|fish|ps1|psm1|bat|cmd|diff|patch|gradle|cmake|mk|dockerfile|gitignore|proto|graphql)$/i;
const MAX_TEXT_FILE = 512 * 1024;
function isTextFile(f) {
  return f.type.startsWith("text/") || /json|xml|javascript|yaml|toml|x-sh|x-python/.test(f.type) ||
         TEXT_EXT.test(f.name) || /(^|[\\/])(makefile|dockerfile|readme|license)$/i.test(f.name);
}
function addFiles(files) {
  for (const f of files) {
    if (f.type.startsWith("image/")) {
      if (!health.images) { toast("warn", T("toast.picturesOff"), T("toast.picturesOffNote")); continue; }
      if (f.size > 20e6) { toast("warn", T("toast.pictureTooLarge"), T("toast.pictureTooLargeNote", {name: f.name})); continue; }
      const r = new FileReader();
      r.onload = () => { attachments.push({kind: "image", name: f.name || T("toast.pastedImage"), url: r.result}); renderAttachments(); };
      r.readAsDataURL(f);
      continue;
    }
    if (!isTextFile(f)) { toast("warn", T("toast.notText"), T("toast.notTextNote", {name: f.name, extra: health.images ? T("toast.notTextExtra") : ""})); continue; }
    if (f.size > MAX_TEXT_FILE) { toast("warn", T("toast.fileTooLarge"), T("toast.fileTooLargeNote", {name: f.name})); continue; }
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result);
      if (text.includes("\u0000")) { toast("warn", T("toast.notText"), T("toast.binaryFile", {name: f.name})); return; }
      attachments.push({kind: "file", name: f.name, text});
      renderAttachments();
    };
    r.readAsText(f);
  }
}
// a file's text in the message, fenced with more backticks than it contains itself
function fileBlock(f) {
  const longest = Math.max(2, ...(f.text.match(/`+/g) || []).map((s) => s.length));
  const fence = "`".repeat(longest + 1);
  return `File: ${f.name}\n${fence}\n${f.text}\n${fence}`;
}
function userText(m) {
  const files = (m.files || []).filter((f) => f.text != null);
  return [m.text, ...files.map(fileBlock)].filter((s) => s).join("\n\n");
}
function renderAttachments() {
  const box = $("attachments");
  box.hidden = !attachments.length;
  box.innerHTML = "";
  attachments.forEach((a, i) => {
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = icon(a.kind === "file" ? "attach" : "image", "st-icon st-icon--sm");
    c.append(a.name);
    const x = document.createElement("button");
    x.type = "button"; x.className = "st-btn st-btn--icon"; x.setAttribute("aria-label", T("chat.remove"));
    x.innerHTML = icon("trash");
    x.onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    c.appendChild(x);
    box.appendChild(c);
  });
}
$("attach-btn").onclick = () => $("file").click();
// drop files on the chat or the message box
for (const id of ["chat", "composer"]) {
  const el = $(id);
  el.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer || {}).types || []].includes("Files")) return;
    e.preventDefault();
    $("composer").classList.add("dragging");
  });
  el.addEventListener("dragleave", () => $("composer").classList.remove("dragging"));
  el.addEventListener("drop", (e) => {
    $("composer").classList.remove("dragging");
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
    $("input").focus();
  });
}
$("file").onchange = () => { addFiles($("file").files); $("file").value = ""; };
$("input").addEventListener("paste", (e) => {
  if (!health.images) return;
  const files = [...(e.clipboardData || {}).files || []].filter((f) => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); addFiles(files); }
});

// ------------------------------------------------------------------ the sampling drawer
function openDrawer(open) {
  $("drawer").dataset.open = String(open);
  $("drawer").setAttribute("aria-hidden", String(!open));
  $("scrim").hidden = !open;
  if (open) { loadDrawer(); loadShared(); loadMcp(); }
}
function loadDrawer(s = settings) {
  for (const b of $("s-thinking").children) b.setAttribute("aria-checked", String(b.dataset.v === s.thinking));
  $("s-temp").value = s.temperature; $("s-topp").value = s.top_p; $("s-topk").value = s.top_k;
  $("s-max").value = s.max; $("s-seed").value = s.seed;
  $("s-show").setAttribute("aria-checked", String(!!s.show));
  $("s-esp").setAttribute("aria-checked", String(s.esp !== false));
  $("esp-row").hidden = !projectionLoaded();
  $("s-mcp").setAttribute("aria-checked", String(s.mcp !== false));
  $("s-share").setAttribute("aria-checked", String(sharedOn));
  outputs();
}
// "Use for other apps too": the server keeps these settings as every client's defaults (GET/POST /settings)
let sharedOn = false;
async function loadShared() {
  try {
    const r = await fetch("settings", {headers: headers()});
    if (r.ok) sharedOn = !!(await r.json()).shared;
  } catch (e) { /* an older server: the switch just stays off */ }
  $("s-share").setAttribute("aria-checked", String(sharedOn));
}
function sharedDefaults(s) {
  const d = {reasoning_effort: s.thinking, temperature: +s.temperature};
  if (+s.temperature > 0) Object.assign(d, {top_p: +s.top_p, top_k: +s.top_k});
  if (s.seed) d.seed = +s.seed;
  if (s.max) d.max_tokens = +s.max;
  if (projectionLoaded()) d.experimental_speed_projection = s.esp !== false;
  return d;
}
async function saveShared(on, s) {
  const r = await fetch("settings", {method: "POST", headers: headers(true),
                                      body: JSON.stringify({defaults: on ? sharedDefaults(s) : null})});
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error.message || msg; } catch (e) { /* not json */ }
    throw new Error(msg);
  }
  sharedOn = !!(await r.json()).shared;
}
// the engine was started with the experimental-speed-projection control vector (INFO cvec=...)
function projectionLoaded() {
  const c = lastMetrics && lastMetrics.engine ? lastMetrics.engine.cvec : 0;
  return !!c && c !== "0";
}
function outputs() {
  const t = +$("s-temp").value;
  $("o-temp").textContent = t === 0 ? `0 · ${T("s.greedy")}` : t.toFixed(2);
  $("o-topp").textContent = (+$("s-topp").value).toFixed(2);
  $("o-topk").textContent = $("s-topk").value;
  const sel = [...$("s-thinking").children].find((b) => b.getAttribute("aria-checked") === "true");
  $("o-thinking").textContent = sel ? {none: T("s.outNone"), low: T("s.outLow"), medium: T("s.outMedium"), high: T("s.outHigh")}[sel.dataset.v] : "";
  for (const id of ["s-topp", "s-topk"]) $(id).disabled = t === 0;
}
for (const b of $("s-thinking").children) b.onclick = () => { for (const x of $("s-thinking").children) x.setAttribute("aria-checked", String(x === b)); outputs(); };
for (const id of ["s-temp", "s-topp", "s-topk"]) $(id).oninput = outputs;
$("s-show").onclick = () => $("s-show").setAttribute("aria-checked", String($("s-show").getAttribute("aria-checked") !== "true"));
$("s-esp").onclick = () => $("s-esp").setAttribute("aria-checked", String($("s-esp").getAttribute("aria-checked") !== "true"));
$("s-mcp").onclick = () => $("s-mcp").setAttribute("aria-checked", String($("s-mcp").getAttribute("aria-checked") !== "true"));
$("s-share").onclick = () => $("s-share").setAttribute("aria-checked", String($("s-share").getAttribute("aria-checked") !== "true"));
$("s-reset").onclick = () => loadDrawer(DEFAULTS);
$("s-apply").onclick = async () => {
  const sel = [...$("s-thinking").children].find((b) => b.getAttribute("aria-checked") === "true");
  settings = {thinking: sel ? sel.dataset.v : "high", temperature: +$("s-temp").value, top_p: +$("s-topp").value,
              top_k: +$("s-topk").value, max: $("s-max").value.trim(), seed: $("s-seed").value.trim(),
              show: $("s-show").getAttribute("aria-checked") === "true",
              esp: $("s-esp").getAttribute("aria-checked") === "true",
              mcp: $("s-mcp").getAttribute("aria-checked") === "true"};
  store.set("sampling", settings);
  const share = $("s-share").getAttribute("aria-checked") === "true";
  openDrawer(false);
  if (share || sharedOn) {
    try {
      await saveShared(share, settings);
      toast("success", T("toast.samplingSaved"), share ? T("toast.samplingShared") : T("toast.samplingOwn"));
    } catch (e) {
      toast("error", T("toast.samplingPartial"), e.message, 6000);
    }
    return;
  }
  toast("success", T("toast.samplingSaved"), settings.temperature === 0 ? T("toast.samplingGreedy") : "");
};
$("sampling-btn").onclick = () => openDrawer(true);
$("drawer-close").onclick = () => openDrawer(false);
$("scrim").onclick = () => openDrawer(false);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("drawer").dataset.open === "true") openDrawer(false); });
// ------------------------------------------------------------------ Chat add-ons (About > Chat extras)
// Three opt-in add-ons, all off by default: a sidebar of saved conversations, the edit / regenerate buttons on each
// message, and the Ctrl+K command list with saved prompts.  Every node here is built at run time, so with the three
// switches off this page creates nothing new and sends the same requests it always did.  Conversations and prompts
// are localStorage only - none of it goes to the server.
const LABS_OFF = {sessions: false, msgTools: false, palette: false};
let labs = {...LABS_OFF, ...store.get("labs", {})};
const SESSION_LIMIT = 60, SNIPPET_LIMIT = 100;
let sessions = store.get("sessions", []);
let sessionId = store.get("sessionId", "");
let snippets = store.get("snippets", []);
let storageWarned = false;
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const epoch = () => Math.floor(Date.now() / 1000);
const currentSession = () => sessions.find((s) => s.id === sessionId) || null;
const saveLabs = () => store.set("labs", {sessions: labs.sessions, msgTools: labs.msgTools, palette: labs.palette});

// localStorage fills up - a long chat with pictures is the usual cause.  The data stays in this window.
function persist(key, value) {
  try { localStorage.setItem("strata." + key, JSON.stringify(value)); return true; }
  catch (e) {
    if (!storageWarned) { storageWarned = true; toast("warn", T("sessions.quota"), T("sessions.quotaNote"), 6000); }
    return false;
  }
}
function autoTitle(msgs) {
  const first = (msgs || []).find((m) => m.role === "user");
  const t = String((first && first.text) || "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 48) : T("session.untitled");
}
function saveSessions() {
  if (!labs.sessions) return;
  const s = currentSession();
  if (!s) return;
  s.messages = slim(messages);
  s.updated = epoch();
  if (!s.titleLocked) s.title = autoTitle(s.messages);
  sessions.sort((a, b) => (b.updated - a.updated) || (b.created - a.created));
  if (sessions.length > SESSION_LIMIT) sessions = sessions.slice(0, SESSION_LIMIT);
  persist("sessions", sessions);
  persist("sessionId", sessionId);
}
// The one migration, and only with the switch on: the chat already in this browser becomes the first conversation.
// strata.chat is left where it is, so switching the add-on back off returns to the single chat this page had.
function migrateSessions() {
  if (!sessions.length) {
    if (!messages.length) return;
    sessions = [{id: uid(), title: autoTitle(messages), created: epoch(), updated: epoch(), titleLocked: false,
                 messages: slim(messages)}];
    sessionId = sessions[0].id;
    persist("sessions", sessions);
    persist("sessionId", sessionId);
    return;
  }
  if (!sessions.some((s) => s.id === sessionId)) sessionId = sessions[0].id;
}
function newChat() {
  if (busy) { toast("warn", T("toast.stillWriting"), T("toast.stillWritingNote")); return; }
  if (!labs.sessions) {
    if (!messages.length) return;
    const backup = messages;
    messages = [];
    saveChat();
    renderChat();
    toast("info", T("toast.newChat"), T("toast.newChatNote"), 6000,
          {label: T("toast.undo"), run: () => { messages = backup; saveChat(); renderChat(); }});
    return;
  }
  const cur = currentSession();
  if (cur && !cur.messages.length) { $("input").focus(); return; }
  const back = {msgs: messages, id: sessionId};
  const s = {id: uid(), title: T("session.untitled"), created: epoch(), updated: epoch(), titleLocked: false, messages: []};
  sessions.unshift(s);
  sessionId = s.id;
  messages = [];
  saveChat();
  renderChat();
  renderSessions();
  toast("info", T("toast.newChat"), T("sessions.newNote"), 6000, {label: T("toast.undo"),
        run: () => { sessions = sessions.filter((x) => x.id !== s.id); sessionId = back.id; messages = back.msgs;
                     saveChat(); renderChat(); renderSessions(); }});
}
function openSession(id) {
  if (busy) { toast("warn", T("msg.busy"), T("msg.busyNote")); return; }
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  setSidebar(false);
  if (id === sessionId) return;
  const chat = $("chat");
  chat.classList.add("swap-out");
  setTimeout(() => {
    sessionId = id;
    messages = (s.messages || []).map((m) => ({...m}));
    persist("sessionId", sessionId);
    store.set("chat", slim(messages));
    renderChat();
    renderSessions();
    chat.classList.remove("swap-out");
    chat.classList.add("swap-in");
    setTimeout(() => chat.classList.remove("swap-in"), 200);
  }, 120);
}
function deleteSession(s, row) {
  const at = sessions.indexOf(s);
  const back = {s, at, id: sessionId, msgs: messages};
  row.style.height = `${row.offsetHeight}px`;
  row.classList.add("session-row--gone");
  setTimeout(() => {
    sessions.splice(at, 1);
    if (sessionId === s.id) {
      sessionId = sessions.length ? sessions[0].id : "";
      messages = sessionId ? (currentSession().messages || []).map((m) => ({...m})) : [];
      renderChat();
    }
    persist("sessions", sessions);
    persist("sessionId", sessionId);
    renderSessions();
  }, 200);
  toast("info", T("sessions.deleted"), T("sessions.deletedNote"), 6000, {label: T("toast.undo"),
        run: () => { sessions.splice(Math.min(at, sessions.length), 0, back.s); sessionId = back.id;
                     messages = back.msgs; saveChat(); renderChat(); renderSessions(); }});
}
function renameSession(s, row) {
  const open = row.querySelector(".session-row__open");
  if (open.dataset.editing) return;
  open.dataset.editing = "1";
  const label = open.querySelector(".session-row__title");
  const ta = document.createElement("textarea");
  ta.className = "session-row__input";
  ta.rows = 2;
  ta.value = s.title || "";
  ta.setAttribute("aria-label", T("sessions.renameAria", {title: s.title || T("session.untitled")}));
  label.hidden = true;
  open.insertBefore(ta, open.querySelector(".session-row__meta"));
  ta.focus();
  ta.select();
  const done = (keep) => {
    if (keep) {
      s.title = ta.value.trim() || T("session.untitled");
      s.titleLocked = true;
      persist("sessions", sessions);
    }
    delete open.dataset.editing;
    renderSessions();
  };
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); done(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
  };
  ta.onblur = () => { if (open.dataset.editing) done(true); };
}

// the sidebar: 260px beside the chat, and an off-canvas panel over the kit's scrim under 1000px
let sidebar = null, sidebarBtn = null, sidebarScrim = null, sidebarQuery = "";
function mountSidebar() {
  if (sidebar) return;
  const view = $("view-chat");
  view.classList.add("chat-split");          // a grid seats the sidebar beside the chat: no chat node is moved
  sidebar = document.createElement("aside");
  sidebar.className = "sessions";
  sidebar.id = "sessions";
  sidebar.dataset.open = "false";
  sidebar.setAttribute("aria-label", T("sessions.title"));
  const head = document.createElement("div");
  head.className = "sessions__head";
  const title = document.createElement("span");
  title.className = "card-title";
  title.id = "sessions-title";
  title.textContent = T("sessions.title");
  const nb = iconBtn("st-btn st-btn--icon", "new-chat", T("sessions.newAria"), T("sessions.new"));
  nb.id = "sessions-new";
  nb.onclick = () => newChat();
  head.append(title, nb);
  const box = document.createElement("div");
  box.className = "sessions__search";
  box.innerHTML = icon("search", "st-icon st-icon--sm");
  const q = document.createElement("input");
  q.className = "st-input";
  q.type = "search";
  q.spellcheck = false;
  q.id = "sessions-q";
  q.placeholder = T("sessions.search");
  q.setAttribute("aria-label", T("sessions.searchAria"));
  q.oninput = () => { sidebarQuery = q.value; renderSessions(); };
  box.appendChild(q);
  const list = document.createElement("div");
  list.className = "sessions__list";
  list.dataset.sList = "";
  sidebar.append(head, box, list);
  view.insertBefore(sidebar, $("chat-scroll"));   // first column, so the chat keeps its own width
  sidebarScrim = document.createElement("div");
  sidebarScrim.className = "scrim sessions-scrim";
  sidebarScrim.hidden = true;
  sidebarScrim.onclick = () => setSidebar(false);
  document.body.appendChild(sidebarScrim);
  sidebarBtn = iconBtn("st-btn st-btn--icon", "sessions", T("sessions.title"), T("sessions.title"));
  sidebarBtn.id = "sessions-btn";
  sidebarBtn.onclick = () => setSidebar(sidebar.dataset.open !== "true");
  document.querySelector(".st-header").insertBefore(sidebarBtn, $("pill"));
  renderSessions();
}
function paintSidebar() {
  if (!sidebar) return;
  sidebar.setAttribute("aria-label", T("sessions.title"));
  $("sessions-title").textContent = T("sessions.title");
  $("sessions-new").setAttribute("aria-label", T("sessions.newAria"));
  $("sessions-new").title = T("sessions.new");
  $("sessions-q").placeholder = T("sessions.search");
  $("sessions-q").setAttribute("aria-label", T("sessions.searchAria"));
  if (sidebarBtn) { sidebarBtn.setAttribute("aria-label", T("sessions.title")); sidebarBtn.title = T("sessions.title"); }
  renderSessions();
}
function setSidebar(open) {
  if (!sidebar) return;
  sidebar.dataset.open = String(open);
  sidebarScrim.hidden = !open;
}
function unmountSidebar() {
  if (!sidebar) return;
  const view = $("view-chat");
  view.classList.remove("chat-split");
  sidebar.remove();
  sidebarScrim.remove();
  sidebarBtn.remove();
  sidebar = sidebarScrim = sidebarBtn = null;
  sidebarQuery = "";
}
function visibleSessions() {
  const q = sidebarQuery.trim().toLowerCase();
  return sessions.filter((s) => !q || (s.title || "").toLowerCase().includes(q) ||
    (s.messages || []).some((m) => String(m.text || "").toLowerCase().includes(q)));
}
function renderSessions() {
  if (!sidebar) return;
  const list = sidebar.querySelector("[data-s-list]");
  list.innerHTML = "";
  const rows = visibleSessions();
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "sessions__empty muted small";
    p.textContent = sessions.length ? T("sessions.none") : T("sessions.empty");
    list.appendChild(p);
    return;
  }
  rows.forEach((s, i) => {
    const t = s.title || T("session.untitled");
    const row = document.createElement("div");
    row.className = "session-row";
    row.dataset.id = s.id;
    if (i < 8) row.style.animationDelay = `${i * 20}ms`;      // the first rows arrive in a short cascade
    const open = document.createElement("button");
    open.type = "button";
    open.className = "session-row__open";
    open.innerHTML = `<span class="session-row__title"></span><span class="session-row__meta muted small"></span>`;
    open.querySelector(".session-row__title").textContent = t;
    open.querySelector(".session-row__meta").textContent =
      `${since(s.updated)} \u00b7 ${T("sessions.count", {n: fmt((s.messages || []).length)})}`;
    if (s.id === sessionId) open.setAttribute("aria-current", "true");
    open.onclick = () => openSession(s.id);
    const tools = document.createElement("span");
    tools.className = "session-row__tools";
    const rn = iconBtn("st-btn st-btn--icon", "pen", T("sessions.renameAria", {title: t}), T("sessions.rename"));
    rn.onclick = () => renameSession(s, row);
    const ex = iconBtn("st-btn st-btn--icon", "download", T("sessions.exportAria", {title: t}), T("sessions.export"));
    ex.onclick = () => downloadMarkdown(chatMarkdown(s.messages));
    const del = iconBtn("st-btn st-btn--icon", "trash", T("sessions.deleteAria", {title: t}), T("sessions.delete"));
    del.onclick = () => deleteSession(s, row);
    tools.append(rn, ex, del);
    row.append(open, tools);
    list.appendChild(row);
  });
}

// ------------------------------------------------------------------ edit a question, regenerate an answer
function startEdit(i, el) {
  if (busy) { toast("warn", T("msg.busy"), T("msg.busyNote")); return; }
  const m = messages[i];
  if (!m || m.role !== "user" || el.querySelector(".msg-edit")) return;
  const box = document.createElement("div");
  box.className = "msg-edit";
  const ta = document.createElement("textarea");
  ta.className = "st-input msg-edit__input";
  ta.rows = 2;
  ta.value = m.text || "";
  ta.setAttribute("aria-label", T("msg.editAria"));
  const bar = document.createElement("div");
  bar.className = "msg-edit__bar";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "st-btn st-btn--secondary";
  cancel.textContent = T("msg.cancel");
  const save = document.createElement("button");
  save.type = "button";
  save.className = "st-btn st-btn--primary";
  save.textContent = T("msg.save");
  bar.append(cancel, save);
  box.append(ta, bar);
  el.querySelector(".st-bubble").hidden = true;
  el.insertBefore(box, el.querySelector(".st-msg__meta"));
  const fit = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, innerHeight * 0.4)}px`; };
  ta.addEventListener("input", fit);
  fit();
  box.style.height = "0px";
  box.style.opacity = "0";
  requestAnimationFrame(() => { box.style.height = `${box.scrollHeight}px`; box.style.opacity = "1"; });
  ta.focus();
  const close = () => {
    box.style.height = "0px";
    box.style.opacity = "0";
    setTimeout(() => { box.remove(); el.querySelector(".st-bubble").hidden = false; }, 180);
  };
  cancel.onclick = close;
  ta.onkeydown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); save.click(); }
  };
  save.onclick = () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    const snapshot = messages.map((x) => ({...x}));
    const lostPicture = (m.images || []).some((im) => !im.url);   // pictures live in memory only (issue #30)
    messages[i].text = text;
    messages.length = i + 1;                                       // the answers after it are dropped
    saveChat();
    renderChat();
    if (lostPicture) toast("warn", T("msg.imageLost"), T("msg.imageLostNote"), 6000);
    toast("info", T("msg.edited"), T("msg.editedNote"), 6000,
          {label: T("toast.undo"), run: () => { messages = snapshot; saveChat(); renderChat(); }});
    runAssistant();
  };
}
function regenerate(i) {
  if (busy) { toast("warn", T("msg.busy"), T("msg.busyNote")); return; }
  const snapshot = messages.map((x) => ({...x}));
  messages.length = i;
  saveChat();
  toast("info", T("msg.regenerated"), "", 6000,
        {label: T("toast.undo"), run: () => { messages = snapshot; saveChat(); renderChat(); }});
  runAssistant();
}

// ------------------------------------------------------------------ the Ctrl+K command list
// One box for the commands, the last conversations and the saved prompts.  It is built at run time, and only while
// the add-on is on, so a first visit to this page shows nothing of it.
let palette = null, paletteScrim = null, paletteInput = null, paletteList = null, paletteHint = null;
let paletteRows = [], paletteSel = 0, paletteTimer = null, paletteReturn = null;

// a subsequence match: "nc" finds "New conversation", "zq" finds nothing
function fuzzy(q, text) {
  const t = String(text).toLowerCase();
  const needle = String(q).toLowerCase().replace(/\s+/g, "");
  if (!needle) return 0;
  let at = -1, run = 0, score = 0;
  for (const ch of needle) {
    const next = t.indexOf(ch, at + 1);
    if (next < 0) return -1;
    if (at === -1 && next === 0) score += 6;
    if (next === at + 1) { run += 1; score += 3 + run; } else { score -= next - at - 1; run = 0; }
    at = next;
  }
  return score;
}
function lastAnswer() {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return {i, m: messages[i]};
  return null;
}
// one sampling switch flipped from the command list, saved the way the Sampling drawer saves it
function setSampling(patch, title) {
  settings = {...settings, ...patch};
  store.set("sampling", settings);
  if ($("drawer").dataset.open === "true") loadDrawer();
  toast("success", title, "", 2200);
}
function paletteItems() {
  const out = [];
  const add = (group, key, run, note) => out.push({group, label: T(key), note: note || "", run});
  add("actions", "palette.cmd.newChat", () => newChat());
  if (labs.sessions) add("actions", "cmd.openChat",
                   () => { setSidebar(true); $("sessions-q").focus(); $("sessions-q").select(); });
  add("actions", "cmd.export", () => exportChat());
  const last = lastAnswer();
  if (last && !busy) add("actions", "cmd.regen", () => regenerate(last.i));
  if (last && last.m.text) add("actions", "cmd.copy", () => copyText(last.m.text, null));
  if (labs.sessions) {
    for (const s of sessions.slice(0, 8)) {
      out.push({group: "chats", label: s.title || T("session.untitled"), note: since(s.updated), run: () => openSession(s.id)});
    }
  }
  for (const s of snippets) out.push({group: "prompts", label: s.title, note: "", run: () => insertSnippet(s.text)});
  add("prompts", "cmd.snippets", () => openSnippets(false));
  add("prompts", "cmd.newSnippet", () => openSnippets(true));
  add("settings", "cmd.goChat", () => showTab("chat"));
  add("settings", "cmd.goMonitor", () => showTab("monitor"));
  add("settings", "cmd.goAbout", () => showTab("about"));
  add("settings", "cmd.theme", () => flipTheme());
  add("settings", "cmd.lang", () => I18N.toggle());
  add("settings", "cmd.sampling", () => { showTab("chat"); openDrawer(true); });
  add("settings", "cmd.mcp", () => setSampling({mcp: settings.mcp === false},
                                             settings.mcp === false ? T("toast.mcpOn") : T("toast.mcpOff")));
  add("settings", "cmd.show", () => setSampling({show: !settings.show},
                                             settings.show ? T("toast.showOff") : T("toast.showOn")));
  add("settings", "cmd.labs", () => { showTab("about"); $("labs-card").scrollIntoView({block: "center"}); });
  return out;
}
// Actions, then the last conversations, then the prompts, then the settings; a typed query ranks inside each group.
const PALETTE_GROUPS = [["actions", "palette.groupActions"], ["chats", "palette.groupChats"],
                       ["prompts", "palette.groupPrompts"], ["settings", "palette.groupSettings"]];
function filteredPalette(q) {
  const query = q.trim();
  const kept = [];
  for (const it of paletteItems()) {
    if (!query) { kept.push({it, s: 0}); continue; }
    const s = Math.max(fuzzy(query, it.label), fuzzy(query, it.note) - 4);
    if (s >= 0) kept.push({it, s});
  }
  const out = [];
  for (const [key] of PALETTE_GROUPS) {
    const inGroup = kept.filter((x) => x.it.group === key);
    if (query) inGroup.sort((a, b) => b.s - a.s);
    out.push(...inGroup.map((x) => x.it));
  }
  return out.slice(0, 40);
}
function renderPalette(q) {
  paletteList.innerHTML = "";
  paletteRows = [];
  const items = filteredPalette(q);
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "palette__empty muted small";
    p.textContent = T("palette.empty");
    paletteList.appendChild(p);
    paletteInput.removeAttribute("aria-activedescendant");
    return;
  }
  for (const [key, labelKey] of PALETTE_GROUPS) {
    const inGroup = items.filter((x) => x.group === key);
    if (!inGroup.length) continue;
    const head = document.createElement("div");
    head.className = "palette-group muted small";
    head.textContent = T(labelKey);
    paletteList.appendChild(head);
    for (const it of inGroup) {
      const k = paletteRows.length;
      const row = document.createElement("div");
      row.className = "palette-row";
      row.id = `palette-row-${k}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      if (k < 10) row.style.animationDelay = `${k * 14}ms`;      // the first rows arrive in a short cascade
      row.innerHTML = `<span class="palette-row__label"></span><span class="palette-row__note muted small"></span>`;
      row.querySelector(".palette-row__label").textContent = it.label;
      row.querySelector(".palette-row__note").textContent = it.note;
      row.onmousemove = () => { if (k !== paletteSel) selectPalette(k); };
      row.onclick = () => runPalette(k);
      it.el = row;
      paletteRows.push(it);
      paletteList.appendChild(row);
    }
  }
  selectPalette(0);
}
function selectPalette(i) {
  if (!paletteRows.length) return;
  paletteSel = Math.max(0, Math.min(paletteRows.length - 1, i));
  paletteRows.forEach((x, k) => {
    const on = k === paletteSel;
    x.el.classList.toggle("is-sel", on);
    x.el.setAttribute("aria-selected", String(on));
  });
  const sel = paletteRows[paletteSel].el;
  paletteInput.setAttribute("aria-activedescendant", sel.id);
  sel.scrollIntoView({block: "nearest"});
}
// the box closes first: a command that opens a drawer must not land behind its scrim
function runPalette(i) {
  const x = paletteRows[i];
  closePalette();
  if (x) x.run();
}
function paintPalette() {
  if (!palette) return;
  palette.setAttribute("aria-label", T("palette.aria"));
  paletteInput.placeholder = T("palette.search");
  paletteInput.setAttribute("aria-label", T("palette.search"));
  paletteHint.textContent = T("palette.hint");
}
function openPalette() {
  if (palette) return;
  paletteReturn = document.activeElement;
  paletteScrim = document.createElement("div");
  paletteScrim.className = "palette-scrim";
  paletteScrim.onclick = () => closePalette();
  palette = document.createElement("div");
  palette.className = "palette";
  palette.id = "palette";
  palette.setAttribute("role", "dialog");
  palette.setAttribute("aria-modal", "true");
  palette.setAttribute("aria-describedby", "palette-hint");
  const box = document.createElement("div");
  box.className = "palette__search";
  box.innerHTML = icon("search", "st-icon st-icon--sm");
  paletteInput = document.createElement("input");
  paletteInput.type = "search";
  paletteInput.id = "palette-q";
  paletteInput.spellcheck = false;
  paletteInput.setAttribute("role", "combobox");
  paletteInput.setAttribute("aria-controls", "palette-list");
  paletteInput.setAttribute("aria-expanded", "true");
  paletteInput.setAttribute("aria-autocomplete", "list");
  paletteInput.oninput = () => {
    clearTimeout(paletteTimer);
    paletteTimer = setTimeout(() => renderPalette(paletteInput.value), 60);
  };
  box.appendChild(paletteInput);
  paletteList = document.createElement("div");
  paletteList.className = "palette__list";
  paletteList.id = "palette-list";
  paletteList.setAttribute("role", "listbox");
  paletteHint = document.createElement("div");
  paletteHint.className = "palette__hint muted small";
  paletteHint.id = "palette-hint";
  palette.append(box, paletteList, paletteHint);
  palette.onkeydown = (e) => {
    if (e.key === "Tab") { e.preventDefault(); paletteInput.focus(); return; }      // the box keeps its focus
    if (e.key === "ArrowDown") { e.preventDefault(); selectPalette(paletteSel + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); selectPalette(paletteSel - 1); }
    else if (e.key === "Enter") { e.preventDefault(); runPalette(paletteSel); }
    else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  };
  document.body.appendChild(paletteScrim);
  document.body.appendChild(palette);
  paintPalette();
  renderPalette("");
  paletteInput.focus();
}
function closePalette() {
  if (!palette) return;
  clearTimeout(paletteTimer);
  palette.remove();
  paletteScrim.remove();
  palette = paletteScrim = paletteInput = paletteList = paletteHint = null;
  paletteRows = [];
  paletteSel = 0;
  if (paletteReturn && paletteReturn.isConnected) paletteReturn.focus();
  paletteReturn = null;
}
// Ctrl+K (Cmd+K on a Mac), taken over from the browser the way i18n.js took Ctrl+L
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || (e.key !== "k" && e.key !== "K")) return;
  if (!labs.palette) return;
  e.preventDefault();
  if (palette) closePalette(); else openPalette();
});

// ------------------------------------------------------------------ saved prompts
// The text a user keeps retyping: a name, the text, and an Insert button that puts it where the cursor is and sends
// nothing.  They stay in this browser, like the conversations.
let snipDrawer = null, snipScrim = null, snipName = null, snipText = null, snipList = null, snipEditing = null;
let snipTitleEl = null, snipNameLabel = null, snipTextLabel = null, snipNoteEl = null, snipSaveBtn = null, snipDelBtn = null;
function mountSnippets() {
  if (snipDrawer) return;
  snipDrawer = document.createElement("aside");
  snipDrawer.className = "st-drawer snip-drawer";
  snipDrawer.id = "snip-drawer";
  snipDrawer.dataset.open = "false";
  snipDrawer.setAttribute("aria-hidden", "true");
  const head = document.createElement("div");
  head.className = "st-drawer__head";
  snipTitleEl = document.createElement("span");
  snipTitleEl.className = "card-title";
  const close = iconBtn("st-btn st-btn--icon", "chevron", T("snip.close"), T("snip.close"));
  close.id = "snip-close";
  close.onclick = () => closeSnippets();
  head.append(snipTitleEl, close);
  const body = document.createElement("div");
  body.className = "st-drawer__body";
  const nameWrap = document.createElement("div");
  nameWrap.className = "st-field";
  snipNameLabel = document.createElement("label");
  snipNameLabel.className = "st-label";
  snipNameLabel.htmlFor = "snip-name";
  snipName = document.createElement("input");
  snipName.className = "st-input";
  snipName.id = "snip-name";
  snipName.maxLength = 80;
  snipName.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); saveSnippet(); } };
  nameWrap.append(snipNameLabel, snipName);
  const textWrap = document.createElement("div");
  textWrap.className = "st-field";
  snipTextLabel = document.createElement("label");
  snipTextLabel.className = "st-label";
  snipTextLabel.htmlFor = "snip-text";
  snipText = document.createElement("textarea");
  snipText.className = "st-input";
  snipText.id = "snip-text";
  snipText.rows = 6;
  textWrap.append(snipTextLabel, snipText);
  const actions = document.createElement("div");
  actions.className = "drawer-actions";
  snipDelBtn = document.createElement("button");
  snipDelBtn.type = "button";
  snipDelBtn.className = "st-btn st-btn--secondary";
  snipDelBtn.id = "snip-delete";
  snipDelBtn.onclick = () => {
    if (snipEditing) { deleteSnippet(snipEditing); return; }
    snipName.value = ""; snipText.value = ""; snipName.focus();      // nothing open: the box just clears
  };
  snipSaveBtn = document.createElement("button");
  snipSaveBtn.type = "button";
  snipSaveBtn.className = "st-btn st-btn--primary";
  snipSaveBtn.id = "snip-save";
  snipSaveBtn.onclick = () => saveSnippet();
  actions.append(snipDelBtn, snipSaveBtn);
  snipNoteEl = document.createElement("p");
  snipNoteEl.className = "snip-note muted small";
  snipList = document.createElement("div");
  snipList.className = "snip-list";
  body.append(nameWrap, textWrap, actions, snipNoteEl, snipList);
  snipDrawer.append(head, body);
  document.body.appendChild(snipDrawer);
  snipScrim = document.createElement("div");
  snipScrim.className = "scrim snip-scrim";
  snipScrim.hidden = true;
  snipScrim.onclick = () => closeSnippets();
  document.body.appendChild(snipScrim);
  paintSnippets();
}
function paintSnippets() {
  if (!snipDrawer) return;
  snipDrawer.setAttribute("aria-label", T("snip.aria"));
  snipTitleEl.textContent = T("snip.title");
  snipNameLabel.textContent = T("snip.name");
  snipTextLabel.textContent = T("snip.text");
  snipName.setAttribute("aria-label", T("snip.name"));
  snipText.setAttribute("aria-label", T("snip.text"));
  snipDelBtn.textContent = T("snip.delete");
  snipSaveBtn.textContent = T("snip.save");
  snipNoteEl.textContent = T("snip.note");
  renderSnippets();
}
function renderSnippets() {
  if (!snipList) return;
  snipList.innerHTML = "";
  if (!snippets.length) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = T("snip.empty");
    snipList.appendChild(p);
    return;
  }
  snippets.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "snip-item";
    if (i < 10) row.style.animationDelay = `${i * 14}ms`;
    const label = document.createElement("span");
    label.className = "snip-item__label";
    label.textContent = s.title;
    const ins = iconBtn("st-btn st-btn--icon", "send", T("snip.insertAria", {title: s.title}), T("snip.insert"));
    ins.onclick = () => { insertSnippet(s.text); closeSnippets(); };
    const ed = iconBtn("st-btn st-btn--icon", "pen", T("snip.editAria", {title: s.title}), T("snip.edit"));
    ed.onclick = () => editSnippet(s);
    const del = iconBtn("st-btn st-btn--icon", "trash", T("snip.deleteAria", {title: s.title}), T("snip.delete"));
    del.onclick = () => deleteSnippet(s);
    row.append(label, ins, ed, del);
    snipList.appendChild(row);
  });
}
function openSnippets(newOne) {
  mountSnippets();
  if (newOne) { snipEditing = null; snipName.value = ""; snipText.value = ""; }
  snipDrawer.dataset.open = "true";
  snipDrawer.setAttribute("aria-hidden", "false");
  snipScrim.hidden = false;
  renderSnippets();
  snipName.focus();
  snipName.select();
}
function closeSnippets() {
  if (!snipDrawer) return;
  snipDrawer.dataset.open = "false";
  snipDrawer.setAttribute("aria-hidden", "true");
  snipScrim.hidden = true;
  snipEditing = null;
}
function editSnippet(s) {
  snipEditing = s;
  snipName.value = s.title;
  snipText.value = s.text;
  snipName.focus();
  snipName.select();
}
function saveSnippet() {
  const title = snipName.value.trim(), text = snipText.value.trim();
  if (!title || !text) { toast("warn", T("snip.needTitle"), "", 3000); snipName.focus(); return; }
  if (!snipEditing && snippets.length >= SNIPPET_LIMIT) { toast("warn", T("snip.limit"), T("snip.limitNote"), 5000); return; }
  if (snipEditing) Object.assign(snipEditing, {title, text, updated: epoch()});
  else { snipEditing = {id: uid(), title, text, updated: epoch()}; snippets.unshift(snipEditing); }
  snippets.sort((a, b) => b.updated - a.updated);
  if (snippets.length > SNIPPET_LIMIT) snippets = snippets.slice(0, SNIPPET_LIMIT);
  persist("snippets", snippets);
  renderSnippets();
  toast("success", T("snip.saved"), "", 2200);
}
function deleteSnippet(s) {
  const at = snippets.indexOf(s);
  if (at < 0) return;
  snippets.splice(at, 1);
  if (snipEditing === s) { snipEditing = null; snipName.value = ""; snipText.value = ""; }
  persist("snippets", snippets);
  renderSnippets();
  toast("info", T("snip.deleted"), "", 6000, {label: T("toast.undo"),
        run: () => { snippets.splice(Math.min(at, snippets.length), 0, s); persist("snippets", snippets); renderSnippets(); }});
}
// insert at the caret, and stop there: a prompt is something the user reads before sending it
function insertSnippet(text) {
  const el = $("input");
  const at = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
  const before = el.value.slice(0, at);
  const gap = before && !/\s$/.test(before) ? " " : "";
  el.value = before + gap + text + el.value.slice(at);
  const end = at + gap.length + text.length;
  el.focus();
  el.setSelectionRange(end, end);
  autosize();
  toast("success", T("snip.inserted"), T("snip.insertedNote"), 2200);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && snipDrawer && snipDrawer.dataset.open === "true") closeSnippets();
});

// ------------------------------------------------------------------ the three switches (About > Chat extras)
let snipBtn = null, paletteBtn = null;
function mountComposerBtns() {
  if (paletteBtn) return;
  const bar = document.querySelector(".st-composer__bar");
  const gap = bar.querySelector(".spacer");
  snipBtn = iconBtn("st-btn st-btn--icon", "pen", T("snip.aria"), T("snip.title"));
  snipBtn.id = "snip-btn";
  snipBtn.onclick = () => openSnippets(false);
  paletteBtn = iconBtn("st-btn st-btn--icon", "command", T("palette.openTitle"), T("palette.openTitle"));
  paletteBtn.id = "palette-btn";
  paletteBtn.onclick = () => openPalette();
  bar.insertBefore(snipBtn, gap);
  bar.insertBefore(paletteBtn, gap);
}
function unmountComposerBtns() {
  if (snipBtn) snipBtn.remove();
  if (paletteBtn) paletteBtn.remove();
  snipBtn = paletteBtn = null;
}
function paintComposerBtns() {
  if (snipBtn) { snipBtn.setAttribute("aria-label", T("snip.aria")); snipBtn.title = T("snip.title"); }
  if (paletteBtn) { paletteBtn.setAttribute("aria-label", T("palette.openTitle")); paletteBtn.title = T("palette.openTitle"); }
}
// the composer's Export button and the command list both save the same file
function exportChat() {
  if (!messages.length) { toast("info", T("toast.nothingToSave")); return; }
  downloadMarkdown(chatMarkdown(messages));
}
const LABS_SWITCHES = [["sessions", "labs-sessions"], ["msgTools", "labs-edit"], ["palette", "labs-palette"]];
const LABS_LABEL = {sessions: "labs.sessions", msgTools: "labs.edit", palette: "labs.palette"};
function paintLabsSwitches() {
  for (const [k, id] of LABS_SWITCHES) $(id).setAttribute("aria-checked", String(!!labs[k]));
}
// every node an add-on owns is built, or removed, here: the one place the switches touch the page
function applyLabs() {
  if (labs.sessions) { migrateSessions(); mountSidebar(); } else unmountSidebar();
  if (labs.palette) mountComposerBtns(); else unmountComposerBtns();
  if (!labs.palette) closePalette();
  closeSnippets();
  renderChat();          // the per-message buttons come and go with the switch
  renderSessions();
}
for (const [k, id] of LABS_SWITCHES) {
  $(id).onclick = () => {
    labs[k] = !labs[k];
    saveLabs();
    paintLabsSwitches();
    applyLabs();
    toast("success", T(labs[k] ? "toast.labsOn" : "toast.labsOff", {name: T(LABS_LABEL[k])}));
  };
}

// ------------------------------------------------------------------ start
setBusy(false);
paintLabsSwitches();
applyLabs();
renderChat();
const startQuestion = new URLSearchParams(location.search).get("q");   // /?q=... starts a chat (a shortcut)
if (startQuestion) history.replaceState(null, "", location.pathname + location.hash);
loadHealth().then(loadMcp).then(() => { if (startQuestion) { $("input").value = startQuestion; send(); } });
showTab(location.hash.slice(1) || "chat");
// a language switch repaints what is already on screen: the pill and cards, the chat, the settings form
document.addEventListener("strata:lang", () => {
  renderChat();
  if (lastMetrics) render(lastMetrics);
  if (tab === "about") loadConfig();
  setBusy(!!busy);
  outputs();
  paintLabsSwitches();
  paintSidebar();
  paintSnippets();
  paintComposerBtns();
  if (palette) { paintPalette(); renderPalette(paletteInput.value); }
});
poll();
