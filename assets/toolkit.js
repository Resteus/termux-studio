async function loadWorkspaceTools() {
  try {
    const data = await api("/api/workspace");
    renderServerCards(data.servers || []);
    renderRouteChips(data.routes || []);
  } catch (e) {
    showToast("Workspace load error: " + e.message);
  }
}

function renderServerCards(servers) {
  const box = document.getElementById("serversList");
  if (!box) return;
  box.innerHTML = "";

  servers.forEach(srv => {
    const row = document.createElement("div");
    row.className = "tool-row";

    const left = document.createElement("div");
    left.className = "tool-row-info";
    const statusCls = srv.running ? "ok" : "err";
    const statusTxt = srv.running ? "ONLINE" : "OFFLINE";
    const autoTag = srv.auto ? '<span class="badge run" style="font-size:10px;">AUTO</span>' : "";
    left.innerHTML = `
      <div class="tool-row-title">
        <span class="badge ${statusCls}">${statusTxt}</span>
        ${autoTag}
        <span>${srv.name}</span>
        <span style="color:var(--muted);font-family:var(--mono);font-size:11px;">:${srv.port}</span>
      </div>
    `;

    const acts = document.createElement("div");
    acts.className = "bot-actions";

    if (srv.running && srv.port !== 8888) {
      const openA = document.createElement("a");
      openA.className = "mini-btn";
      openA.href = srv.url;
      openA.target = "_blank";
      openA.style.textDecoration = "none";
      openA.innerHTML = '<i class="ri-external-link-line"></i> Open';
      acts.appendChild(openA);
    }

    if (!srv.running && srv.start_cmd) {
      const startBtn = document.createElement("button");
      startBtn.className = "mini-btn";
      startBtn.innerHTML = '<i class="ri-play-fill"></i> Start';
      startBtn.onclick = async () => {
        switchTab("chat");
        await sendCommand(srv.start_cmd);
        setTimeout(loadWorkspaceTools, 2500);
      };
      acts.appendChild(startBtn);
    } else if (srv.running && srv.stop_cmd) {
      const stopBtn = document.createElement("button");
      stopBtn.className = "mini-btn";
      stopBtn.innerHTML = '<i class="ri-stop-fill"></i> Stop';
      stopBtn.onclick = async () => {
        switchTab("chat");
        await sendCommand(srv.stop_cmd);
        setTimeout(loadWorkspaceTools, 1500);
      };
      acts.appendChild(stopBtn);
    }

    row.appendChild(left);
    row.appendChild(acts);
    box.appendChild(row);
  });
}

function renderRouteChips(routes) {
  const box = document.getElementById("routesList");
  if (!box) return;
  box.innerHTML = "";

  if (!routes.length) {
    box.innerHTML = '<div style="color:var(--muted);font-size:12px;">No saved routes found in ~/.routes/routes.db</div>';
    return;
  }

  routes.forEach(rt => {
    const row = document.createElement("div");
    row.className = "tool-row";

    const info = document.createElement("div");
    info.className = "tool-row-info";
    info.innerHTML = `
      <div class="tool-row-title"><i class="ri-map-pin-line" style="color:var(--accent);"></i> <span></span></div>
      <div class="chat-item-sub"></div>
    `;
    info.querySelector("span").textContent = rt.name;
    info.querySelector(".chat-item-sub").textContent = rt.path;

    const acts = document.createElement("div");
    acts.className = "bot-actions";

    const cdBtn = document.createElement("button");
    cdBtn.className = "mini-btn";
    cdBtn.innerHTML = '<i class="ri-terminal-line"></i> cd';
    cdBtn.onclick = async () => {
      switchTab("chat");
      await sendCommand('cd "' + rt.path.replace(/"/g, '\\"') + '"');
    };

    const filesBtn = document.createElement("button");
    filesBtn.className = "mini-btn";
    filesBtn.innerHTML = '<i class="ri-folder-open-line"></i> Files';
    filesBtn.onclick = () => {
      browseDir = rt.path;
      switchTab("files");
      loadFiles(rt.path);
    };

    acts.appendChild(cdBtn);
    acts.appendChild(filesBtn);
    row.appendChild(info);
    row.appendChild(acts);
    box.appendChild(row);
  });
}

async function runWebSearch() {
  const inp = document.getElementById("webSearchInput");
  const out = document.getElementById("webSearchResults");
  const q = (inp ? inp.value : "").trim();
  if (!q) return showToast("Enter a search query");

  out.innerHTML = '<div style="color:var(--muted);font-size:12.5px;padding:8px 0;">Searching web...</div>';
  try {
    const data = await api("/api/tools/search?q=" + encodeURIComponent(q));
    if (!data.ok) {
      out.innerHTML = '<div style="color:var(--red);font-size:12.5px;">' + (data.error || "Search failed") + "</div>";
      return;
    }
    if (!data.results || !data.results.length) {
      out.innerHTML = '<div style="color:var(--muted);font-size:12.5px;">No results found.</div>';
      return;
    }

    out.innerHTML = "";
    data.results.forEach(item => {
      const card = document.createElement("div");
      card.className = "search-card";

      const top = document.createElement("div");
      top.className = "search-card-head";

      const link = document.createElement("a");
      link.href = item.url;
      link.target = "_blank";
      link.className = "search-title";
      link.textContent = item.title || item.url;

      const copyBtn = document.createElement("button");
      copyBtn.className = "mini-btn";
      copyBtn.innerHTML = '<i class="ri-file-copy-line"></i> Copy';
      copyBtn.onclick = () => copyText(item.title + "\n" + item.url + (item.snippet ? "\n" + item.snippet : ""), copyBtn);

      top.appendChild(link);
      top.appendChild(copyBtn);

      const urlDiv = document.createElement("div");
      urlDiv.className = "search-url";
      urlDiv.textContent = item.url;

      const snipDiv = document.createElement("div");
      snipDiv.className = "search-snip";
      snipDiv.textContent = item.snippet || "";

      card.appendChild(top);
      card.appendChild(urlDiv);
      if (item.snippet) card.appendChild(snipDiv);
      out.appendChild(card);
    });
  } catch (e) {
    out.innerHTML = '<div style="color:var(--red);font-size:12.5px;">Error: ' + e.message + "</div>";
  }
}

async function runMiniTransform(mode) {
  const srcEl = document.getElementById("miniToolInput");
  const outEl = document.getElementById("miniToolOutput");
  const val = srcEl ? srcEl.value : "";
  if (!val) return showToast("Enter text first");

  try {
    if (mode === "b64enc") {
      outEl.value = btoa(unescape(encodeURIComponent(val)));
    } else if (mode === "b64dec") {
      outEl.value = decodeURIComponent(escape(atob(val.trim())));
    } else if (mode === "json") {
      outEl.value = JSON.stringify(JSON.parse(val), null, 2);
    } else if (mode === "sha256") {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(val));
      outEl.value = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }
  } catch (e) {
    outEl.value = "Error: " + e.message;
  }
}

window.addEventListener("load", () => {
  const toolsTab = document.querySelector('.tab-btn[data-tab="tools"]');
  if (toolsTab) {
    toolsTab.addEventListener("click", loadWorkspaceTools);
  }
  const searchInp = document.getElementById("webSearchInput");
  if (searchInp) {
    searchInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runWebSearch();
      }
    });
  }
});

async function runLocalAgent(presetPrompt) {
  const inp = document.getElementById("agentPromptInput");
  const out = document.getElementById("agentOutputBox");
  const btn = document.getElementById("agentRunBtn");
  const promptText = (presetPrompt !== undefined ? presetPrompt : (inp ? inp.value : "")).trim();
  if (!promptText) return showToast("Enter a message for the local LLM");
  if (inp && presetPrompt !== undefined) inp.value = presetPrompt;

  const tStart = performance.now();
  const fmtSec = () => ((performance.now() - tStart) / 1000).toFixed(1) + "s";

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="ri-loader-4-line"></i> 0.0s';
  }
  out.innerHTML = '<div id="agentLiveTimer" style="color:var(--amber);font-family:var(--mono);font-size:12px;">Running local model on :8090... 0.0s</div>';

  const timerId = setInterval(() => {
    const el = document.getElementById("agentLiveTimer");
    if (el) el.textContent = "Running local model on :8090... " + fmtSec();
    if (btn) btn.innerHTML = '<i class="ri-loader-4-line"></i> ' + fmtSec();
  }, 100);

  try {
    const data = await api("/api/agent", {
      method: "POST",
      body: JSON.stringify({ prompt: promptText })
    });
    clearInterval(timerId);
    const totalSec = (data.elapsed !== undefined ? data.elapsed + "s" : fmtSec());
    out.innerHTML = "";

    if (Array.isArray(data.steps) && data.steps.length) {
      data.steps.forEach((st, idx) => {
        const stepCard = document.createElement("div");
        stepCard.className = "search-card";
        const head = document.createElement("div");
        head.className = "tool-row-title";
        head.innerHTML = '<span class="badge run">STEP ' + (idx + 1) + '</span> <span style="font-family:var(--mono);font-size:11.5px;color:var(--accent);"></span>';
        head.querySelector("span:last-child").textContent = st.tool + (st.input ? " -> " + st.input : "");
        const pre = document.createElement("pre");
        pre.className = "bot-body";
        pre.style.padding = "6px 0 0";
        pre.style.fontSize = "11.5px";
        pre.textContent = st.output || "";
        stepCard.appendChild(head);
        stepCard.appendChild(pre);
        out.appendChild(stepCard);
      });
    }

    if (!data.ok) {
      const errDiv = document.createElement("div");
      errDiv.style.color = "var(--red)";
      errDiv.style.fontFamily = "var(--mono)";
      errDiv.style.fontSize = "12px";
      errDiv.textContent = "Failed after " + totalSec + ": " + (data.error || "Agent error");
      out.appendChild(errDiv);
      return;
    }

    const ansCard = document.createElement("div");
    ansCard.className = "search-card";
    ansCard.style.borderColor = "rgba(129, 201, 149, 0.4)";
    const top = document.createElement("div");
    top.className = "search-card-head";
    top.innerHTML = '<span class="badge ok">ANSWER · ' + totalSec + '</span>';
    const copyBtn = document.createElement("button");
    copyBtn.className = "mini-btn";
    copyBtn.innerHTML = '<i class="ri-file-copy-line"></i> Copy';
    copyBtn.onclick = () => copyText(data.reply || "", copyBtn);
    top.appendChild(copyBtn);

    const body = document.createElement("pre");
    body.className = "bot-body";
    body.style.padding = "6px 0 0";
    body.textContent = data.reply || "(no reply)";
    ansCard.appendChild(top);
    ansCard.appendChild(body);
    out.appendChild(ansCard);
  } catch (e) {
    clearInterval(timerId);
    out.innerHTML = "";
    const errDiv = document.createElement("div");
    errDiv.style.color = "var(--red)";
    errDiv.style.fontFamily = "var(--mono)";
    errDiv.style.fontSize = "12px";
    errDiv.textContent = "Stopped at " + fmtSec() + ": " + e.message;
    out.appendChild(errDiv);
  } finally {
    clearInterval(timerId);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="ri-send-plane-fill"></i> Send';
    }
  }
}


async function hardReloadStudio() {
  showToast("Hard reloading UI...");
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (_) {}
  window.location.replace(window.location.pathname + "?v=" + Date.now());
}
