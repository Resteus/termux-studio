const STUDIO_TOKEN = window.STUDIO_TOKEN || "";
const STORAGE_KEY = "termux_studio_sessions_v5";

let currentCwd = "~";
let browseDir = "~";
let activeFilePath = "";
let cmdHistory = [];
let histIndex = -1;

let activeJobId = null;
let activeCard = null;
let activeBotRecord = null;
let pollTimer = null;
let diskSaveTimer = null;

let store = {
  updatedAt: 0,
  activeSessionId: null,
  activeChatId: null,
  sessions: []
};

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function syncViewport() {
  const app = document.getElementById("appRoot");
  if (!app) return;
  if (window.visualViewport) {
    app.style.height = window.visualViewport.height + "px";
    app.style.top = window.visualViewport.offsetTop + "px";
  } else {
    app.style.height = window.innerHeight + "px";
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    syncViewport();
    scrollToBottom(false);
  });
  window.visualViewport.addEventListener("scroll", syncViewport);
}
window.addEventListener("resize", syncViewport);
syncViewport();

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.remove("show"), 2000);
}

function updateCwdDisplays(pathStr) {
  if (!pathStr) return;
  currentCwd = pathStr;
  const dockEl = document.getElementById("dockCwdText");
  if (dockEl) dockEl.textContent = pathStr;
  const filesEl = document.getElementById("filesPathText");
  if (filesEl) filesEl.textContent = browseDir || pathStr;
}

async function api(url, options = {}) {
  const headers = Object.assign({
    "X-Studio-Token": STUDIO_TOKEN,
    "Content-Type": "application/json"
  }, options.headers || {});
  const res = await fetch(url, Object.assign({}, options, { headers }));
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || ("HTTP " + res.status));
  }
  return res.json();
}

/* SIDEBAR TOGGLE */
function isMobileView() {
  return window.innerWidth <= 768;
}

function toggleSidebar() {
  const sb = document.getElementById("sidebar");
  const bd = document.getElementById("sidebarBackdrop");
  if (isMobileView()) {
    const open = sb.classList.toggle("mobile-open");
    bd.classList.toggle("mobile-open", open);
  } else {
    sb.classList.toggle("desktop-collapsed");
  }
}

function closeMobileSidebar() {
  document.getElementById("sidebar").classList.remove("mobile-open");
  document.getElementById("sidebarBackdrop").classList.remove("mobile-open");
}

/* PERSISTENCE */
function persistStore() {
  store.updatedAt = Date.now();
  try {
    const trimmed = JSON.parse(JSON.stringify(store));
    trimmed.sessions.forEach(s => {
      s.chats.forEach(c => {
        if (c.messages.length > 80) c.messages = c.messages.slice(-80);
        c.messages.forEach(m => {
          if (m.output && m.output.length > 60000) m.output = m.output.slice(-60000);
        });
      });
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("localStorage save warning:", e);
  }

  clearTimeout(diskSaveTimer);
  diskSaveTimer = setTimeout(() => {
    api("/api/sessions", {
      method: "POST",
      body: JSON.stringify(store)
    }).catch(() => {});
  }, 300);
}

function getActiveSession() {
  return store.sessions.find(s => s.id === store.activeSessionId) || store.sessions[0] || null;
}

function getActiveChat() {
  const sess = getActiveSession();
  if (!sess) return null;
  return sess.chats.find(c => c.id === store.activeChatId) || sess.chats[0] || null;
}

function ensureDefaultStore(defaultCwd) {
  if (!store.sessions || !store.sessions.length) {
    const chatId = uid("chat");
    const sessId = uid("sess");
    store = {
      updatedAt: Date.now(),
      activeSessionId: sessId,
      activeChatId: chatId,
      sessions: [{
        id: sessId,
        name: "Main Workspace",
        chats: [{
          id: chatId,
          title: "Main Shell",
          customTitle: false,
          cwd: defaultCwd || "~",
          messages: []
        }]
      }]
    };
    persistStore();
    return;
  }

  let sess = getActiveSession();
  if (!sess) {
    sess = store.sessions[0];
    store.activeSessionId = sess.id;
  }
  if (!sess.chats || !sess.chats.length) {
    const cid = uid("chat");
    sess.chats = [{ id: cid, title: "New Chat", customTitle: false, cwd: defaultCwd || "~", messages: [] }];
    store.activeChatId = cid;
  } else if (!sess.chats.some(c => c.id === store.activeChatId)) {
    store.activeChatId = sess.chats[0].id;
  }
}

async function initSessions() {
  let localData = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) localData = JSON.parse(raw);
  } catch (_) {}

  if (localData && Array.isArray(localData.sessions) && localData.sessions.length) {
    store = localData;
    ensureDefaultStore(currentCwd);
    renderSidebar();
    await activateCurrentChat(false);
  }

  try {
    const remoteData = await api("/api/sessions");
    if (remoteData && Array.isArray(remoteData.sessions) && remoteData.sessions.length) {
      const localTs = (localData && localData.updatedAt) || 0;
      const remoteTs = remoteData.updatedAt || 0;
      if (remoteTs > localTs) {
        store = remoteData;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
        ensureDefaultStore(currentCwd);
        renderSidebar();
        await activateCurrentChat(false);
        return;
      }
    }
  } catch (_) {}

  if (!store.sessions.length) {
    ensureDefaultStore(currentCwd);
    renderSidebar();
    await activateCurrentChat(false);
  } else {
    persistStore();
  }
}

function renderSidebar() {
  const list = document.getElementById("sessionsList");
  list.innerHTML = "";

  store.sessions.forEach(sess => {
    const isSessActive = sess.id === store.activeSessionId;
    const card = document.createElement("div");
    card.className = "session-card" + (isSessActive ? " active-session" : "");

    const head = document.createElement("div");
    head.className = "session-head";

    const titleBtn = document.createElement("button");
    titleBtn.className = "session-title-btn";
    titleBtn.innerHTML = '<i class="ri-folder-3-line"></i><span></span>';
    titleBtn.querySelector("span").textContent = sess.name;
    titleBtn.onclick = () => {
      if (sess.chats.length) selectChat(sess.id, sess.chats[0].id);
    };

    const actions = document.createElement("div");
    actions.className = "session-actions";

    const renBtn = document.createElement("button");
    renBtn.className = "icon-btn";
    renBtn.innerHTML = '<i class="ri-edit-line"></i>';
    renBtn.title = "Rename Session";
    renBtn.onclick = (e) => { e.stopPropagation(); renameSession(sess.id); };

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn danger";
    delBtn.innerHTML = '<i class="ri-delete-bin-line"></i>';
    delBtn.title = "Delete Session";
    delBtn.onclick = (e) => { e.stopPropagation(); deleteSession(sess.id); };

    actions.appendChild(renBtn);
    actions.appendChild(delBtn);
    head.appendChild(titleBtn);
    head.appendChild(actions);

    const newChatBtn = document.createElement("button");
    newChatBtn.className = "new-chat-btn";
    newChatBtn.innerHTML = '<i class="ri-chat-new-line"></i> New Chat';
    newChatBtn.onclick = () => createChatInSession(sess.id);

    const chatList = document.createElement("div");
    chatList.className = "chat-list";

    sess.chats.forEach(chat => {
      const isChatActive = isSessActive && chat.id === store.activeChatId;
      const row = document.createElement("div");
      row.className = "chat-item" + (isChatActive ? " active" : "");
      row.onclick = () => selectChat(sess.id, chat.id);

      const info = document.createElement("div");
      info.className = "chat-item-info";

      const cTitle = document.createElement("div");
      cTitle.className = "chat-item-title";
      cTitle.innerHTML = '<i class="ri-terminal-line"></i><span></span>';
      cTitle.querySelector("span").textContent = chat.title;

      const cSub = document.createElement("div");
      cSub.className = "chat-item-sub";
      cSub.textContent = chat.cwd || "~";

      info.appendChild(cTitle);
      info.appendChild(cSub);

      const cActs = document.createElement("div");
      cActs.className = "session-actions";

      const cRen = document.createElement("button");
      cRen.className = "icon-btn";
      cRen.innerHTML = '<i class="ri-pencil-line"></i>';
      cRen.title = "Rename Chat";
      cRen.onclick = (e) => { e.stopPropagation(); renameChat(sess.id, chat.id); };

      const cDel = document.createElement("button");
      cDel.className = "icon-btn danger";
      cDel.innerHTML = '<i class="ri-close-line"></i>';
      cDel.title = "Delete Chat";
      cDel.onclick = (e) => { e.stopPropagation(); deleteChat(sess.id, chat.id); };

      cActs.appendChild(cRen);
      cActs.appendChild(cDel);

      row.appendChild(info);
      row.appendChild(cActs);
      chatList.appendChild(row);
    });

    card.appendChild(head);
    card.appendChild(newChatBtn);
    card.appendChild(chatList);
    list.appendChild(card);
  });

  const activeSess = getActiveSession();
  const activeChat = getActiveChat();
  const ctxLabel = document.getElementById("activeContextLabel");
  if (activeSess && activeChat) {
    ctxLabel.textContent = "· " + activeSess.name + " / " + activeChat.title;
  }
}

function createSession() {
  if (activeJobId) return showToast("Stop running process first");
  const name = prompt("New Session Name:", "Project " + (store.sessions.length + 1));
  if (!name || !name.trim()) return;

  const sessId = uid("sess");
  const chatId = uid("chat");
  store.sessions.unshift({
    id: sessId,
    name: name.trim(),
    chats: [{ id: chatId, title: "New Chat", customTitle: false, cwd: currentCwd || "~", messages: [] }]
  });
  store.activeSessionId = sessId;
  store.activeChatId = chatId;
  persistStore();
  renderSidebar();
  activateCurrentChat(true);
}

function renameSession(sessId) {
  const sess = store.sessions.find(s => s.id === sessId);
  if (!sess) return;
  const next = prompt("Edit Session Name:", sess.name);
  if (!next || !next.trim()) return;
  sess.name = next.trim();
  persistStore();
  renderSidebar();
  showToast("Session renamed");
}

function deleteSession(sessId) {
  if (activeJobId) return showToast("Stop running process first");
  if (store.sessions.length <= 1) return showToast("Keep at least one session");
  const sess = store.sessions.find(s => s.id === sessId);
  if (!sess || !confirm("Delete session '" + sess.name + "' and all its chats?")) return;

  store.sessions = store.sessions.filter(s => s.id !== sessId);
  if (store.activeSessionId === sessId) {
    store.activeSessionId = store.sessions[0].id;
    store.activeChatId = store.sessions[0].chats[0].id;
  }
  persistStore();
  renderSidebar();
  activateCurrentChat(false);
  showToast("Session deleted");
}

function createChatInSession(sessId) {
  if (activeJobId) return showToast("Stop running process first");
  const sess = store.sessions.find(s => s.id === sessId);
  if (!sess) return;
  const chatId = uid("chat");
  sess.chats.unshift({ id: chatId, title: "New Chat", customTitle: false, cwd: currentCwd || "~", messages: [] });
  store.activeSessionId = sess.id;
  store.activeChatId = chatId;
  persistStore();
  renderSidebar();
  activateCurrentChat(true);
}

function renameChat(sessId, chatId) {
  const sess = store.sessions.find(s => s.id === sessId);
  if (!sess) return;
  const chat = sess.chats.find(c => c.id === chatId);
  if (!chat) return;
  const next = prompt("Edit Chat Name:", chat.title);
  if (!next || !next.trim()) return;
  chat.title = next.trim();
  chat.customTitle = true;
  persistStore();
  renderSidebar();
  showToast("Chat renamed");
}

function deleteChat(sessId, chatId) {
  if (activeJobId) return showToast("Stop running process first");
  const sess = store.sessions.find(s => s.id === sessId);
  if (!sess) return;
  if (sess.chats.length <= 1) return showToast("Each session needs at least 1 chat");
  const chat = sess.chats.find(c => c.id === chatId);
  if (!chat || !confirm("Delete chat '" + chat.title + "'?")) return;

  sess.chats = sess.chats.filter(c => c.id !== chatId);
  if (store.activeChatId === chatId) store.activeChatId = sess.chats[0].id;
  persistStore();
  renderSidebar();
  activateCurrentChat(false);
  showToast("Chat deleted");
}

async function selectChat(sessId, chatId) {
  if (activeJobId) return showToast("Stop running process first");
  store.activeSessionId = sessId;
  store.activeChatId = chatId;
  persistStore();
  renderSidebar();
  await activateCurrentChat(true);
}

async function activateCurrentChat(closeDrawer) {
  if (closeDrawer) closeMobileSidebar();
  const chat = getActiveChat();
  const feed = document.getElementById("chatFeed");
  feed.innerHTML = "";
  cmdHistory = [];
  if (!chat) return;

  if (!chat.messages.length) {
    renderWelcomeCard();
  } else {
    chat.messages.forEach(m => {
      if (m.type === "user") {
        if (!m.isStdin) cmdHistory.push(m.text);
        renderUserBubbleDOM(m.text, m.isStdin);
      } else if (m.type === "bot") {
        renderBotCardDOM(m.cmd, {
          ok: m.ok,
          running: false,
          output: m.output,
          exit_code: m.exit_code,
          elapsed: m.elapsed,
          ls_meta: m.ls_meta || null
        });
      }
    });
    histIndex = cmdHistory.length;
  }

  if (chat.cwd && chat.cwd !== "~") {
    try {
      const res = await api("/api/cd", {
        method: "POST",
        body: JSON.stringify({ cwd: chat.cwd })
      });
      if (res.ok && res.cwd) {
        browseDir = res.cwd;
        updateCwdDisplays(res.cwd);
      }
    } catch (_) {}
  }
  scrollToBottom(true);
}

function renderWelcomeCard() {
  const feed = document.getElementById("chatFeed");
  const card = document.createElement("div");
  card.className = "msg-bot";
  card.innerHTML = `
    <div class="bot-head">
      <div class="bot-meta"><span class="badge ok">IDE READY</span> <span>Clickable ls · Full CRUD · CodeMirror</span></div>
      <div class="bot-actions">
        <button class="mini-btn" onclick="copyText('ls -la', this)"><i class="ri-file-copy-line"></i> Copy</button>
      </div>
    </div>
    <pre class="bot-body">Termux Studio V5 is live:
• Run ls or ls -la — tap any folder to cd into it, or tap any file to edit it.
• Long-press any item in Files for Copy, Move, Duplicate, Rename & Trash.
• CodeMirror syntax highlighting + Check button catches syntax errors with line numbers.</pre>
  `;
  feed.appendChild(card);
}

/* CLIPBOARD */
async function copyText(text, btnEl) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (_) {}

  if (!ok) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { ok = document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
  }

  if (ok) {
    showToast("Copied to clipboard");
    if (btnEl) {
      const origHTML = btnEl.innerHTML;
      btnEl.innerHTML = '<i class="ri-check-line"></i> Copied';
      btnEl.classList.add("copied");
      setTimeout(() => {
        btnEl.innerHTML = origHTML;
        btnEl.classList.remove("copied");
      }, 1400);
    }
  } else {
    showToast("Copy blocked by browser");
  }
}

/* CHIPS & COMPOSER */
function renderChips() {
  const bar = document.getElementById("chipsBar");
  bar.innerHTML = "";
  if (activeJobId) {
    const keys = [
      { label: "1", val: "1" },
      { label: "2", val: "2" },
      { label: "3", val: "3" },
      { label: "y", val: "y" },
      { label: "n", val: "n" },
      { label: "q", val: "q" },
      { label: "Enter ↵", val: "" }
    ];
    keys.forEach(k => {
      const b = document.createElement("button");
      b.className = "chip stdin-chip";
      b.textContent = k.label;
      b.onclick = () => sendStdin(k.val);
      bar.appendChild(b);
    });
  } else {
    const cmds = [
      { label: "ls -la", fn: () => sendCommand("ls -la") },
      { label: "cd ..", fn: () => sendCommand("cd ..") },
      { label: "pwd", fn: () => sendCommand("pwd") },
      { label: "↑ Prev", fn: () => recallPrev() },
      { label: "archive", fn: () => sendCommand("archive") },
      { label: "Clear", fn: () => clearChat() }
    ];
    cmds.forEach(c => {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = c.label;
      b.onclick = c.fn;
      bar.appendChild(b);
    });
  }
}

function setInteractiveMode(isRunning) {
  const dot = document.getElementById("statusDot");
  const banner = document.getElementById("interactiveBanner");
  const input = document.getElementById("cmdInput");
  const sendBtn = document.getElementById("sendBtn");
  const stopBtn = document.getElementById("stopBtn");

  if (isRunning) {
    dot.classList.add("busy");
    banner.classList.add("visible");
    input.classList.add("stdin-mode");
    input.placeholder = "Type reply (1, 2, y, q)...";
    sendBtn.classList.add("stdin-mode");
    sendBtn.innerHTML = '<i class="ri-reply-line"></i> Send';
    stopBtn.classList.add("visible");
  } else {
    dot.classList.remove("busy");
    banner.classList.remove("visible");
    input.classList.remove("stdin-mode");
    input.placeholder = "Tap here to run command...";
    sendBtn.classList.remove("stdin-mode");
    sendBtn.innerHTML = '<i class="ri-play-fill"></i> Run';
    stopBtn.classList.remove("visible");
  }
  renderChips();
}

function isNearBottom() {
  const feed = document.getElementById("chatFeed");
  return (feed.scrollTop + feed.clientHeight) >= (feed.scrollHeight - 140);
}

function scrollToBottom(force = false) {
  const feed = document.getElementById("chatFeed");
  if (!feed) return;
  if (force || isNearBottom()) feed.scrollTop = feed.scrollHeight;
}

function switchTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });
  document.querySelectorAll(".view").forEach(v => {
    v.classList.toggle("active", v.id === "view-" + tabName);
  });
  if (tabName === "files" && typeof loadFiles === "function") loadFiles(currentCwd);
  if (tabName === "editor" && typeof refreshEditorLayout === "function") refreshEditorLayout();
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

async function refreshStatus() {
  try {
    const st = await api("/api/status");
    browseDir = st.cwd;
    updateCwdDisplays(st.cwd);
    document.getElementById("diskPillText").textContent = st.disk_free;
  } catch (e) {
    console.error(e);
  }
}

function renderUserBubbleDOM(text, isStdin = false) {
  const feed = document.getElementById("chatFeed");
  const div = document.createElement("div");
  div.className = "msg-user";
  div.textContent = (isStdin ? "↳ " : "$ ") + text;
  feed.appendChild(div);
}

function appendUserBubble(text, isStdin = false) {
  const chat = getActiveChat();
  if (chat && chat.messages.length === 0) {
    document.getElementById("chatFeed").innerHTML = "";
  }
  renderUserBubbleDOM(text, isStdin);
  scrollToBottom(true);

  if (chat) {
    chat.messages.push({ type: "user", text, isStdin });
    if (!isStdin && !chat.customTitle && (chat.title === "New Chat" || chat.title === "Main Shell")) {
      chat.title = text.length > 26 ? text.slice(0, 26) + "…" : text;
      renderSidebar();
    }
    persistStore();
  }
}

function renderClickableLsOutput(preEl, text, lsMeta) {
  preEl.innerHTML = "";
  const itemMap = new Map();
  lsMeta.items.forEach(it => {
    itemMap.set(it.name, it);
    if (it.is_dir) itemMap.set(it.name + "/", it);
  });

  const parts = text.split(/(\s+)/);
  parts.forEach(part => {
    if (!part) return;
    const hit = itemMap.get(part);
    if (hit) {
      const span = document.createElement("span");
      span.className = "ls-link " + (hit.is_dir ? "dir" : "file");
      span.textContent = part;
      span.title = hit.is_dir ? ("cd " + hit.path) : ("Edit " + hit.path);
      span.onclick = () => {
        if (hit.is_dir) {
          sendCommand('cd "' + hit.path.replace(/"/g, '\\"') + '"');
        } else if (typeof openInEditor === "function") {
          openInEditor(hit.path);
        }
      };
      preEl.appendChild(span);
    } else {
      preEl.appendChild(document.createTextNode(part));
    }
  });
}

function renderBotCardDOM(cmd, res) {
  const feed = document.getElementById("chatFeed");
  const card = document.createElement("div");
  card.className = "msg-bot" + (res.running ? " live" : "");

  const head = document.createElement("div");
  head.className = "bot-head";

  const meta = document.createElement("div");
  meta.className = "bot-meta";
  const badge = document.createElement("span");
  const timeSpan = document.createElement("span");
  meta.appendChild(badge);
  meta.appendChild(timeSpan);

  const actions = document.createElement("div");
  actions.className = "bot-actions";

  const wrapBtn = document.createElement("button");
  wrapBtn.className = "mini-btn";
  wrapBtn.innerHTML = '<i class="ri-text-wrap"></i> Wrap';

  const rerunBtn = document.createElement("button");
  rerunBtn.className = "mini-btn";
  rerunBtn.innerHTML = '<i class="ri-refresh-line"></i>';
  rerunBtn.title = "Re-run command";
  rerunBtn.onclick = () => sendCommand(cmd);

  const copyBtn = document.createElement("button");
  copyBtn.className = "mini-btn";
  copyBtn.innerHTML = '<i class="ri-file-copy-line"></i> Copy';

  actions.appendChild(wrapBtn);
  actions.appendChild(rerunBtn);
  actions.appendChild(copyBtn);

  head.appendChild(meta);
  head.appendChild(actions);

  const body = document.createElement("pre");
  body.className = "bot-body";

  wrapBtn.onclick = () => {
    const nowNoWrap = body.classList.toggle("nowrap");
    wrapBtn.innerHTML = nowNoWrap
      ? '<i class="ri-text-wrap"></i> NoWrap'
      : '<i class="ri-text-wrap"></i> Wrap';
  };

  const cardState = { card, badge, timeSpan, body, latestOutput: "" };
  copyBtn.onclick = () => copyText(cardState.latestOutput, copyBtn);

  card.appendChild(head);
  card.appendChild(body);
  feed.appendChild(card);

  updateBotCardDOM(cardState, res);
  return cardState;
}

function updateBotCardDOM(cardState, res) {
  const out = res.output || "";
  cardState.latestOutput = out;

  if (res.running) {
    cardState.card.classList.add("live");
    cardState.badge.className = "badge run";
    cardState.badge.textContent = "RUNNING";
  } else {
    cardState.card.classList.remove("live");
    cardState.badge.className = "badge " + (res.ok ? "ok" : "err");
    cardState.badge.textContent = res.ok ? "OK" : ("EXIT " + res.exit_code);
  }

  cardState.timeSpan.textContent = (res.elapsed !== undefined ? res.elapsed + "s" : "");

  if (out) {
    cardState.body.classList.remove("empty");
    if (!res.running && res.ls_meta && Array.isArray(res.ls_meta.items) && res.ls_meta.items.length) {
      renderClickableLsOutput(cardState.body, out, res.ls_meta);
    } else {
      cardState.body.textContent = out;
    }
  } else if (res.running) {
    cardState.body.classList.add("empty");
    cardState.body.textContent = "Running...";
  } else {
    cardState.body.classList.add("empty");
    cardState.body.textContent = "(no output)";
  }
}

function createBotCard(cmd, res) {
  const cardState = renderBotCardDOM(cmd, res);
  scrollToBottom(true);

  const chat = getActiveChat();
  if (chat) {
    const botRecord = {
      type: "bot",
      cmd,
      output: res.output || "",
      ok: !!res.ok,
      exit_code: res.exit_code ?? 0,
      elapsed: res.elapsed ?? 0,
      ls_meta: res.ls_meta || null
    };
    chat.messages.push(botRecord);
    activeBotRecord = botRecord;
    if (res.cwd) {
      chat.cwd = res.cwd;
      renderSidebar();
    }
    persistStore();
  }
  return cardState;
}

function handleComposerSubmit() {
  if (activeJobId) {
    const input = document.getElementById("cmdInput");
    const val = input.value;
    input.value = "";
    input.style.height = "44px";
    sendStdin(val);
  } else {
    sendCommand();
  }
}

async function sendCommand(overrideCmd) {
  if (activeJobId) return showToast("Wait for running process or tap Ctrl+C");
  const input = document.getElementById("cmdInput");
  const cmd = (overrideCmd !== undefined ? overrideCmd : input.value).trim();
  if (!cmd) return;

  if (overrideCmd === undefined) {
    input.value = "";
    input.style.height = "44px";
  }
  cmdHistory.push(cmd);
  histIndex = cmdHistory.length;

  appendUserBubble(cmd, false);

  const cols = Math.max(44, Math.min(120, Math.floor((window.innerWidth - 48) / 7.8)));

  try {
    const res = await api("/api/exec", {
      method: "POST",
      body: JSON.stringify({ command: cmd, cols })
    });

    if (res.cwd) updateCwdDisplays(res.cwd);

    const cardState = createBotCard(cmd, res);

    if (res.action === "open_editor" && res.path && typeof openInEditor === "function") {
      openInEditor(res.path);
      return;
    }

    if (res.running && res.job_id) {
      activeJobId = res.job_id;
      activeCard = cardState;
      setInteractiveMode(true);
      startPolling(res.job_id);
    } else {
      activeBotRecord = null;
    }
  } catch (err) {
    createBotCard(cmd, { ok: false, running: false, exit_code: 1, output: err.message });
  }
}

function startPolling(jobId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!activeJobId || activeJobId !== jobId) {
      clearInterval(pollTimer);
      return;
    }
    try {
      const res = await api("/api/poll?id=" + encodeURIComponent(jobId));
      if (!res.found) {
        finishActiveJob();
        return;
      }
      if (res.cwd) {
        updateCwdDisplays(res.cwd);
        const chat = getActiveChat();
        if (chat && chat.cwd !== res.cwd) {
          chat.cwd = res.cwd;
          renderSidebar();
        }
      }
      if (activeCard) {
        updateBotCardDOM(activeCard, res);
        scrollToBottom(false);
      }
      if (activeBotRecord) {
        activeBotRecord.output = res.output || "";
        activeBotRecord.ok = !!res.ok;
        activeBotRecord.exit_code = res.exit_code ?? 0;
        activeBotRecord.elapsed = res.elapsed ?? 0;
        activeBotRecord.ls_meta = res.ls_meta || null;
      }
      if (!res.running) {
        persistStore();
        finishActiveJob();
      }
    } catch (_) {}
  }, 250);
}

function finishActiveJob() {
  clearInterval(pollTimer);
  pollTimer = null;
  activeJobId = null;
  activeCard = null;
  activeBotRecord = null;
  setInteractiveMode(false);
  scrollToBottom(false);
}

async function sendStdin(text) {
  if (!activeJobId) return;
  try {
    const res = await api("/api/stdin", {
      method: "POST",
      body: JSON.stringify({ input: text, newline: true })
    });
    if (!res.ok) showToast(res.message || "Could not send input");
  } catch (e) {
    showToast("Input error: " + e.message);
  }
}

async function killRunning() {
  try {
    const res = await api("/api/kill", { method: "POST" });
    showToast(res.message || "Sent Ctrl+C");
  } catch (e) {
    showToast("Error stopping process");
  }
}

function recallPrev() {
  if (!cmdHistory.length) return;
  histIndex = Math.max(0, histIndex - 1);
  const input = document.getElementById("cmdInput");
  input.value = cmdHistory[histIndex];
  input.focus();
}

function clearChat() {
  const chat = getActiveChat();
  if (chat) {
    chat.messages = [];
    persistStore();
  }
  document.getElementById("chatFeed").innerHTML = "";
  renderWelcomeCard();
  showToast("Chat cleared");
}

const cmdInput = document.getElementById("cmdInput");
cmdInput.addEventListener("focus", () => {
  setTimeout(() => {
    syncViewport();
    scrollToBottom(true);
  }, 120);
});
cmdInput.addEventListener("input", () => {
  cmdInput.style.height = "44px";
  cmdInput.style.height = Math.min(cmdInput.scrollHeight, 110) + "px";
});
cmdInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleComposerSubmit();
  }
});

renderChips();
(async () => {
  await refreshStatus();
  await initSessions();
})();
