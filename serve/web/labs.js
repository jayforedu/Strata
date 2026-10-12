// ------------------------------------------------------------------ Chat add-ons (About > Chat extras)
// Three opt-in add-ons, all off by default: a sidebar of saved conversations, the edit / regenerate buttons on each
// message, and the Ctrl+K command list with saved prompts.  Every node here is built at run time, so with the three
// switches off this page creates nothing new and sends the same requests it always did.  Conversations and prompts
// are localStorage only - none of it goes to the server.
// Loaded by web/app.js with import(), and only when a switch is on.  Its stylesheet comes with it here, so the page
// asks for web/labs.css in the same step it asks for this file, and never before.
const labsCss = document.createElement("link");
labsCss.rel = "stylesheet";
labsCss.href = "web/labs.css";
document.head.appendChild(labsCss);

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
  let s = currentSession();
  if (!s) {
    // the switch went on over an empty chat: the first saved message opens the conversation
    if (!messages.length) return;
    s = {id: uid(), title: autoTitle(messages), created: epoch(), updated: epoch(), titleLocked: false, messages: []};
    sessions.unshift(s);
    sessionId = s.id;
    renderSessions();
  }
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
// exported: the composer's New chat button reaches this through Labs.newChat in web/app.js
export function newChat() {
  if (!labs.sessions) { newChatDefault(); return; }   // the sidebar is off, so the composer's button is the plain path
  if (busy) { toast("warn", T("toast.stillWriting"), T("toast.stillWritingNote")); return; }
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
const LABS_SWITCHES = [["sessions", "labs-sessions"], ["msgTools", "labs-edit"], ["palette", "labs-palette"]];
function paintLabsSwitches() {
  for (const [k, id] of LABS_SWITCHES) { const el = $(id); if (el) el.setAttribute("aria-checked", String(!!labs[k])); }
}
// The switches live in web/app.js: this file is only asked for once one of them is on, so it cannot be the place
// that first answers a click.  sync() reads the three states back out of storage, which is where core wrote them.
export function sync() { labs = {...LABS_OFF, ...store.get("labs", {})}; }
// every node an add-on owns is built, or removed, here: the one place the switches touch the page
export function apply() {
  paintLabsSwitches();
  if (labs.sessions) { migrateSessions(); mountSidebar(); } else unmountSidebar();
  if (labs.palette) mountComposerBtns(); else unmountComposerBtns();
  if (!labs.palette) closePalette();
  closeSnippets();
  renderChat();          // the per-message buttons come and go with the switch
  renderSessions();
}
// ------------------------------------------------------------------ the four hooks web/app.js uses
// saveChat() in core calls chatSaved on every save; the per-message buttons report their clicks through msgClick;
// a language switch repaints what this file owns through lang.  Nothing else in core reaches in here.
export const chatSaved = () => saveSessions();
export function msgClick(t) {
  const me = t.closest("[data-msg-edit]");
  if (me) { startEdit(+me.closest(".st-msg").dataset.i, me.closest(".st-msg")); return true; }
  const mr = t.closest("[data-msg-regen]");
  if (mr) { regenerate(+mr.closest(".st-msg").dataset.i); return true; }
  return false;
}
export function lang() {
  paintLabsSwitches();
  paintSidebar();
  paintSnippets();
  paintComposerBtns();
  if (palette) { paintPalette(); renderPalette(paletteInput.value); }
}

