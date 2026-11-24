let fileClipboard = null;
let crudTargetItem = null;

function updateClipBar() {
  const bar = document.getElementById("fileClipBar");
  const txt = document.getElementById("fileClipText");
  if (!bar || !txt) return;
  if (!fileClipboard) {
    bar.classList.remove("visible");
    return;
  }
  const verb = fileClipboard.mode === "move" ? "Cut (Move): " : "Copied: ";
  txt.textContent = verb + fileClipboard.name;
  bar.classList.add("visible");
}

function clearFileClipboard() {
  fileClipboard = null;
  updateClipBar();
  showToast("Clipboard cleared");
}

async function pasteClipboardHere() {
  if (!fileClipboard || !browseDir) return;
  const endpoint = fileClipboard.mode === "move" ? "/api/file/move" : "/api/file/copy";
  try {
    const res = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ src: fileClipboard.path, dest_dir: browseDir })
    });
    showToast((fileClipboard.mode === "move" ? "Moved: " : "Pasted: ") + (res.name || fileClipboard.name));
    if (fileClipboard.mode === "move") {
      fileClipboard = null;
      updateClipBar();
    }
    loadFiles(browseDir);
  } catch (e) {
    showToast("Paste failed: " + e.message);
  }
}

function openCrudSheet(item) {
  crudTargetItem = item;
  const icon = document.getElementById("crudSheetIcon");
  const title = document.getElementById("crudSheetTitle");
  if (icon) icon.className = item.is_dir ? "ri-folder-3-fill" : "ri-file-code-line";
  if (title) title.textContent = item.name;
  document.getElementById("crudBackdrop").classList.add("visible");
  document.getElementById("crudSheet").classList.add("visible");
}

function closeCrudSheet() {
  document.getElementById("crudBackdrop").classList.remove("visible");
  document.getElementById("crudSheet").classList.remove("visible");
}

function crudActionOpen() {
  const item = crudTargetItem;
  closeCrudSheet();
  if (!item) return;
  if (item.is_dir) loadFiles(item.path);
  else if (getMediaKind(item.name)) openMediaPreview(item);
  else if (typeof openInEditor === "function") openInEditor(item.path);
}

function crudActionCopy() {
  const item = crudTargetItem;
  closeCrudSheet();
  if (!item) return;
  fileClipboard = { mode: "copy", path: item.path, name: item.name, is_dir: item.is_dir };
  updateClipBar();
  showToast("Copied '" + item.name + "' — open target folder & tap Paste Here");
}

function crudActionMove() {
  const item = crudTargetItem;
  closeCrudSheet();
  if (!item) return;
  fileClipboard = { mode: "move", path: item.path, name: item.name, is_dir: item.is_dir };
  updateClipBar();
  showToast("Cut '" + item.name + "' — open target folder & tap Paste Here");
}

async function crudActionDuplicate() {
  const item = crudTargetItem;
  closeCrudSheet();
  if (!item) return;
  try {
    const res = await api("/api/file/copy", {
      method: "POST",
      body: JSON.stringify({ src: item.path, dest_dir: browseDir })
    });
    showToast("Duplicated as " + (res.name || item.name));
    loadFiles(browseDir);
  } catch (e) {
    showToast("Duplicate failed: " + e.message);
  }
}

async function crudActionRename() {
  const item = crudTargetItem;
  closeCrudSheet();
  if (!item) return;
  const nextName = prompt("Rename '" + item.name + "' to:", item.name);
  if (!nextName || !nextName.trim() || nextName.trim() === item.name) return;
  try {
    await api("/api/file/rename", {
      method: "POST",
      body: JSON.stringify({ path: item.path, new_name: nextName.trim() })
    });
    showToast("Renamed to " + nextName.trim());
    loadFiles(browseDir);
  } catch (e) {
    showToast("Rename failed: " + e.message);
  }
}

async function crudActionDelete() {
  const item = crudTargetItem;
  closeCrudSheet();
  if (!item) return;
  if (!confirm("Move '" + item.name + "' to trash?")) return;
  try {
    const res = await api("/api/file/delete", {
      method: "POST",
      body: JSON.stringify({ path: item.path })
    });
    showToast(res.message || "Moved to trash");
    loadFiles(browseDir);
  } catch (e) {
    showToast("Trash failed: " + e.message);
  }
}

function attachLongPress(rowEl, item) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;

  rowEl.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    fired = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    rowEl.classList.add("pressing");
    timer = setTimeout(() => {
      fired = true;
      rowEl.classList.remove("pressing");
      if (navigator.vibrate) navigator.vibrate(25);
      openCrudSheet(item);
    }, 460);
  }, { passive: true });

  rowEl.addEventListener("touchmove", (e) => {
    if (!timer || e.touches.length !== 1) return;
    const dx = Math.abs(e.touches[0].clientX - startX);
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dx > 10 || dy > 10) {
      clearTimeout(timer);
      timer = null;
      rowEl.classList.remove("pressing");
    }
  }, { passive: true });

  const cancelPress = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    rowEl.classList.remove("pressing");
  };

  rowEl.addEventListener("touchend", cancelPress);
  rowEl.addEventListener("touchcancel", cancelPress);

  rowEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openCrudSheet(item);
  });

  return () => fired;
}

async function loadFiles(targetPath) {
  try {
    const data = await api("/api/files?path=" + encodeURIComponent(targetPath || browseDir || currentCwd));
    browseDir = data.path;
    window._parentDir = data.parent;
    const filesEl = document.getElementById("filesPathText");
    if (filesEl) filesEl.textContent = data.path;

    const list = document.getElementById("filesList");
    list.innerHTML = "";

    if (!data.entries.length) {
      list.innerHTML = '<div style="color:var(--muted);padding:24px;text-align:center;">Empty directory</div>';
      return;
    }

    data.entries.forEach(item => {
      const row = document.createElement("div");
      row.className = "file-row";
      const didLongPress = attachLongPress(row, item);

      const main = document.createElement("div");
      main.className = "file-main";

      const mKind = item.is_dir ? null : getMediaKind(item.name);
      const iconCls = item.is_dir
        ? "ri-folder-3-fill"
        : mKind === "audio"
          ? "ri-music-2-line"
          : mKind === "video"
            ? "ri-film-line"
            : mKind === "image"
              ? "ri-image-line"
              : mKind === "pdf"
                ? "ri-file-pdf-line"
                : "ri-file-text-line";

      const name = document.createElement("div");
      name.className = "file-name" + (item.is_dir ? " dir" : "");
      name.innerHTML = '<i class="' + iconCls + '"></i><span></span>';
      name.querySelector("span").textContent = item.name;

      const sub = document.createElement("div");
      sub.className = "file-sub";
      sub.textContent = item.is_dir
        ? "Folder · Hold for options"
        : (item.size + (mKind ? " · Tap to play/view" : " · Hold for options"));

      main.appendChild(name);
      main.appendChild(sub);

      main.onclick = (e) => {
        if (didLongPress()) {
          e.preventDefault();
          return;
        }
        if (item.is_dir) loadFiles(item.path);
        else if (mKind) openMediaPreview(item);
        else if (typeof openInEditor === "function") openInEditor(item.path);
      };

      const moreBtn = document.createElement("button");
      moreBtn.className = "row-more-btn";
      moreBtn.innerHTML = '<i class="ri-more-2-fill"></i>';
      moreBtn.title = "Actions";
      moreBtn.onclick = (e) => {
        e.stopPropagation();
        openCrudSheet(item);
      };

      row.appendChild(main);
      row.appendChild(moreBtn);
      list.appendChild(row);
    });
  } catch (e) {
    showToast("Failed to load files: " + e.message);
  }
}

function goParentDir() {
  if (window._parentDir) loadFiles(window._parentDir);
}

async function syncChatToFolder() {
  switchTab("chat");
  await sendCommand('cd "' + browseDir.replace(/"/g, '\\"') + '"');
  showToast("Chat synced to folder");
}

async function createNewItem(kind) {
  const label = kind === "folder" ? "New folder name:" : "New file name:";
  const name = prompt(label);
  if (!name || !name.trim()) return;
  try {
    const res = await api("/api/file/create", {
      method: "POST",
      body: JSON.stringify({ dir: browseDir, name: name.trim(), kind })
    });
    showToast("Created " + name.trim());
    if (kind === "file" && typeof openInEditor === "function") openInEditor(res.path);
    else loadFiles(browseDir);
  } catch (e) {
    showToast("Error: " + e.message);
  }
}

function triggerFileUpload() {
  const inp = document.getElementById("fileUploadInput");
  if (inp) {
    inp.value = "";
    inp.click();
  }
}

async function handleFileUploadInput(inputEl) {
  if (!inputEl || !inputEl.files || !inputEl.files.length) return;
  const fd = new FormData();
  fd.append("dir", browseDir || currentCwd);
  for (let i = 0; i < inputEl.files.length; i++) {
    fd.append("files", inputEl.files[i]);
  }
  try {
    showToast("Uploading " + inputEl.files.length + " file(s)...");
    const res = await fetch("/api/file/upload", {
      method: "POST",
      headers: { "X-Studio-Token": STUDIO_TOKEN },
      body: fd
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    showToast("Uploaded " + (data.count || 0) + " file(s)");
    loadFiles(browseDir);
  } catch (e) {
    showToast("Upload failed: " + e.message);
  }
}

function crudActionDownload() {
  const item = crudTargetItem;
  closeCrudSheet();
  if (!item) return;
  if (item.is_dir) return showToast("Download works on files (zip folders first)");
  const url = "/api/file/download?path=" + encodeURIComponent(item.path) + "&token=" + encodeURIComponent(STUDIO_TOKEN);
  const a = document.createElement("a");
  a.href = url;
  a.download = item.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast("Downloading " + item.name);
}


function getMediaKind(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (["wav", "mp3", "ogg", "m4a", "flac", "aac", "opus", "weba"].includes(ext)) return "audio";
  if (["mp4", "webm", "mkv", "mov", "m4v", "avi"].includes(ext)) return "video";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  return null;
}

function closeMediaPreview() {
  const modal = document.getElementById("mediaPreviewModal");
  const body = document.getElementById("mediaModalBody");
  if (body) {
    body.querySelectorAll("audio,video").forEach(el => {
      try { el.pause(); el.removeAttribute("src"); el.load(); } catch (_) {}
    });
    body.innerHTML = "";
  }
  if (modal) modal.style.display = "none";
}

function openMediaPreview(item) {
  if (!item || item.is_dir) return;
  const modal = document.getElementById("mediaPreviewModal");
  const body = document.getElementById("mediaModalBody");
  const title = document.getElementById("mediaModalTitle");
  const icon = document.getElementById("mediaModalIcon");
  const dlBtn = document.getElementById("mediaModalDlBtn");
  if (!modal || !body) return;

  closeMediaPreview();
  const kind = getMediaKind(item.name) || "other";
  const streamUrl = "/api/file/media?path=" + encodeURIComponent(item.path) + "&token=" + encodeURIComponent(STUDIO_TOKEN);

  if (title) title.textContent = item.name;
  if (icon) {
    icon.className = kind === "audio" ? "ri-music-2-line"
      : kind === "video" ? "ri-film-line"
      : kind === "image" ? "ri-image-line"
      : kind === "pdf" ? "ri-file-pdf-line"
      : "ri-file-line";
  }
  if (dlBtn) {
    dlBtn.onclick = () => {
      const a = document.createElement("a");
      a.href = "/api/file/download?path=" + encodeURIComponent(item.path) + "&token=" + encodeURIComponent(STUDIO_TOKEN);
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };
  }

  if (kind === "audio") {
    const wrap = document.createElement("div");
    wrap.style.cssText = "width:100%;display:flex;flex-direction:column;align-items:center;gap:14px;padding:12px 4px;";
    wrap.innerHTML = '<div style="width:64px;height:64px;border-radius:50%;background:rgba(138,180,248,0.14);display:flex;align-items:center;justify-content:center;font-size:28px;color:var(--accent);"><i class="ri-volume-up-line"></i></div>';
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.autoplay = true;
    audio.preload = "metadata";
    audio.style.width = "100%";
    audio.src = streamUrl;
    wrap.appendChild(audio);
    body.appendChild(wrap);
  } else if (kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.style.cssText = "width:100%;max-height:66vh;border-radius:10px;background:#000;";
    video.src = streamUrl;
    body.appendChild(video);
  } else if (kind === "image") {
    const img = document.createElement("img");
    img.src = streamUrl;
    img.alt = item.name;
    img.style.cssText = "max-width:100%;max-height:68vh;object-fit:contain;border-radius:10px;";
    body.appendChild(img);
  } else if (kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.src = streamUrl;
    frame.style.cssText = "width:100%;height:68vh;border:none;border-radius:10px;background:#fff;";
    body.appendChild(frame);
  } else {
    const frame = document.createElement("iframe");
    frame.src = streamUrl;
    frame.style.cssText = "width:100%;height:60vh;border:1px solid var(--border,#2d333b);border-radius:10px;background:#0d1117;";
    body.appendChild(frame);
  }

  modal.style.display = "flex";
}

function crudActionPreview() {
  const item = crudTargetItem;
  closeCrudSheet();
  if (!item) return;
  if (item.is_dir) return showToast("Preview works on files");
  openMediaPreview(item);
}
