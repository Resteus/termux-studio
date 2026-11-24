const EDITOR_STATE_KEY = "termux_studio_editor_v1";
let cmEditor = null;
let errorLineHandle = null;
let editorDraftTimer = null;
let isRestoringEditor = false;

function getSavedEditorState() {
  try {
    const raw = localStorage.getItem(EDITOR_STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function saveEditorState(patch) {
  try {
    const next = Object.assign(getSavedEditorState(), patch);
    localStorage.setItem(EDITOR_STATE_KEY, JSON.stringify(next));
  } catch (_) {}
}

function detectEditorMode(filePath) {
  const lower = (filePath || "").toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".json")) return { name: "javascript", json: true };
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "javascript";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "htmlmixed";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".xml") || lower.endsWith(".svg")) return "xml";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "shell";
  if (lower.endsWith(".md")) return "markdown";
  return "text/plain";
}

function initCodeEditor() {
  if (cmEditor) return cmEditor;
  const ta = document.getElementById("editorArea");
  if (!ta || typeof CodeMirror === "undefined") return null;

  cmEditor = CodeMirror.fromTextArea(ta, {
    theme: "material-darker",
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    autoCloseBrackets: true,
    mode: "text/plain"
  });

  cmEditor.on("change", () => {
    clearErrorHighlight();
    if (isRestoringEditor || !activeFilePath) return;
    document.getElementById("editorPath").textContent = activeFilePath + " *";
    clearTimeout(editorDraftTimer);
    editorDraftTimer = setTimeout(() => {
      saveEditorState({
        path: activeFilePath,
        draft: cmEditor.getValue(),
        dirty: true
      });
    }, 350);
  });

  return cmEditor;
}

function refreshEditorLayout() {
  const ed = initCodeEditor();
  if (ed) setTimeout(() => ed.refresh(), 30);
}

function clearErrorHighlight() {
  if (cmEditor && errorLineHandle !== null) {
    cmEditor.removeLineClass(errorLineHandle, "background", "cm-error-line");
    errorLineHandle = null;
  }
  const banner = document.getElementById("lintBanner");
  if (banner) {
    banner.className = "lint-banner";
    banner.textContent = "";
  }
}

function applyLintResult(lint) {
  const banner = document.getElementById("lintBanner");
  if (!banner || !lint) return;

  clearErrorHighlight();
  if (lint.ok) {
    banner.className = "lint-banner ok visible";
    banner.innerHTML = '<i class="ri-checkbox-circle-line"></i> <span></span>';
    banner.querySelector("span").textContent = lint.message || "No syntax errors.";
  } else {
    banner.className = "lint-banner err visible";
    banner.innerHTML = '<i class="ri-error-warning-line"></i> <span></span>';
    banner.querySelector("span").textContent = lint.message || "Syntax error detected.";

    const lineIdx = Math.max(0, (lint.line || 1) - 1);
    if (cmEditor && lineIdx < cmEditor.lineCount()) {
      errorLineHandle = cmEditor.addLineClass(lineIdx, "background", "cm-error-line");
      cmEditor.setCursor({ line: lineIdx, ch: Math.max(0, (lint.col || 1) - 1) });
      cmEditor.scrollIntoView({ line: lineIdx, ch: 0 }, 80);
    }
  }
}

async function openInEditor(fullPath, opts = {}) {
  const _mName = (fullPath || "").split("/").pop() || "";
  if (typeof getMediaKind === "function" && getMediaKind(_mName) && typeof openMediaPreview === "function") {
    openMediaPreview({ name: _mName, path: fullPath, is_dir: false });
    return;
  }
  try {
    const data = await api("/api/file/read?path=" + encodeURIComponent(fullPath));
    activeFilePath = data.path;
    const useDraft = Boolean(opts.dirty && typeof opts.draft === "string");
    const textToLoad = useDraft ? opts.draft : (data.content || "");

    document.getElementById("editorPath").textContent =
      data.path + (useDraft ? " * (unsaved)" : (data.is_new ? " (new)" : ""));

    const ed = initCodeEditor();
    clearErrorHighlight();
    isRestoringEditor = true;
    try {
      if (ed) {
        ed.setOption("mode", detectEditorMode(data.path));
        ed.setValue(textToLoad);
        ed.clearHistory();
      } else {
        document.getElementById("editorArea").value = textToLoad;
      }
    } finally {
      isRestoringEditor = false;
    }

    saveEditorState({
      path: data.path,
      draft: textToLoad,
      dirty: useDraft
    });

    if (!opts.silentTab) {
      saveEditorState({ lastTab: "editor" });
      switchTab("editor");
    }
    refreshEditorLayout();
  } catch (e) {
    if (!opts.silentTab) showToast("Cannot open: " + e.message);
  }
}

async function saveCurrentFile() {
  if (!activeFilePath) return showToast("No file open");
  try {
    const content = cmEditor ? cmEditor.getValue() : document.getElementById("editorArea").value;
    const res = await api("/api/file/write", {
      method: "POST",
      body: JSON.stringify({ path: activeFilePath, content })
    });
    document.getElementById("editorPath").textContent = activeFilePath;
    saveEditorState({ path: activeFilePath, draft: content, dirty: false });
    if (res.lint) applyLintResult(res.lint);
    showToast(res.lint && !res.lint.ok ? "Saved (with syntax error)" : "Saved (" + res.size + ")");
  } catch (e) {
    showToast("Save failed: " + e.message);
  }
}

async function checkEditorErrors() {
  if (!activeFilePath) return showToast("Open a file first");
  try {
    const content = cmEditor ? cmEditor.getValue() : document.getElementById("editorArea").value;
    const lint = await api("/api/file/lint", {
      method: "POST",
      body: JSON.stringify({ path: activeFilePath, content })
    });
    applyLintResult(lint);
    showToast(lint.ok ? "No errors found" : "Syntax error found!");
  } catch (e) {
    showToast("Check failed: " + e.message);
  }
}

function editorSelectAll() {
  if (cmEditor) {
    cmEditor.focus();
    cmEditor.execCommand("selectAll");
  } else {
    const ta = document.getElementById("editorArea");
    ta.focus();
    ta.select();
  }
}

function editorCopyAll(btn) {
  const val = cmEditor ? cmEditor.getValue() : document.getElementById("editorArea").value;
  copyText(val, btn);
}

async function editorPaste() {
  try {
    const txt = await navigator.clipboard.readText();
    if (cmEditor) {
      cmEditor.replaceSelection(txt);
      cmEditor.focus();
    } else {
      const ta = document.getElementById("editorArea");
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + txt + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + txt.length;
    }
    showToast("Pasted");
  } catch (_) {
    showToast("Tap inside editor and use Android Paste");
  }
}

function insertTab() {
  if (cmEditor) {
    cmEditor.replaceSelection("    ");
    cmEditor.focus();
  } else {
    const ta = document.getElementById("editorArea");
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + "    " + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + 4;
    ta.focus();
  }
}

window.addEventListener("load", () => {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      saveEditorState({ lastTab: btn.dataset.tab });
    });
  });

  const saved = getSavedEditorState();
  if (saved.path) {
    const stayInEditor = saved.lastTab === "editor";
    openInEditor(saved.path, {
      silentTab: !stayInEditor,
      dirty: saved.dirty,
      draft: saved.draft
    });
  } else if (saved.lastTab === "files" || saved.lastTab === "editor") {
    switchTab(saved.lastTab);
  }
});

async function runCurrentFile() {
  if (!activeFilePath) return showToast("Open a file first");
  await saveCurrentFile();
  const ext = activeFilePath.split(".").pop().toLowerCase();
  const slashIdx = activeFilePath.lastIndexOf("/");
  const dir = slashIdx > 0 ? activeFilePath.substring(0, slashIdx) : ".";
  const name = slashIdx >= 0 ? activeFilePath.substring(slashIdx + 1) : activeFilePath;
  const qDir = '"' + dir.replace(/"/g, '\\"') + '"';
  const qName = '"' + name.replace(/"/g, '\\"') + '"';

  let cmd = "";
  if (ext === "py") cmd = "cd " + qDir + " && python " + qName;
  else if (ext === "sh" || ext === "bash") cmd = "cd " + qDir + " && bash " + qName;
  else if (ext === "js" || ext === "mjs") cmd = "cd " + qDir + " && node " + qName;
  else cmd = "cd " + qDir + " && chmod +x " + qName + " && ./" + qName;

  saveEditorState({ lastTab: "chat" });
  switchTab("chat");
  await sendCommand(cmd);
}
