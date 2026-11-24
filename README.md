# Termux Studio

A lightweight, mobile-first web IDE, interactive PTY terminal, inline media player, and local workspace built specifically for **Android Termux**—powered by Python (`Bottle`) and vanilla HTML/CSS/JavaScript.

---

## Overview & Tabs

Termux Studio turns a mobile browser into a touch-friendly development environment running locally on `http://127.0.0.1:8888`. The top bar provides a live connection status indicator, a collapsible **Sessions Sidebar** for organizing multiple workspaces, a real-time **Storage Pill**, and a one-tap **Hard Reload (`↻`)** button to clear cached assets on mobile browsers.

### 1. Chat (Browser PTY Terminal)
- **Persistent Shell Sessions:** Run interactive `bash` commands directly in your browser backed by a real pseudo-terminal (`PTY`).
- **Multi-Session & Multi-Chat Organization:** Create separate project sessions and terminal threads with saved command histories, exit codes, and execution timers.
- **Live Directory Sync:** Displays your active working directory (`cwd`) in the bottom dock—tap it anytime to jump straight to that folder in the **Files** tab.

### 2. Files (Touch-Friendly File Manager & Inline Media Player)
- **Full Mobile File Operations:** Browse directories, upload/download files, create new files or folders, rename, and safely move items to trash.
- **Touch & Gesture Controls:** Tap to open files or folders; long-press (`460ms` with haptic feedback) or tap `⋮` to open a mobile bottom sheet with quick actions (`Open`, `Play / View`, `Rename`, `Delete`).
- **Inline Media & Document Streaming:** Plays and previews files directly inside a dark-mode overlay player using HTTP byte-range streaming (`/api/file/media`) without leaving the app:
  - **Audio:** `.wav`, `.mp3`, `.ogg`, `.m4a`, `.flac`, `.aac`, `.opus`, `.weba`
  - **Video:** `.mp4`, `.webm`, `.mkv`, `.mov`, `.m4v`, `.avi`
  - **Images & Docs:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`, and `.pdf`

### 3. Editor (Mobile Code Editor)
- **Syntax Highlighting:** Powered by CodeMirror (`material-darker` theme) with support for Python, JavaScript, JSON, HTML, CSS, XML/SVG, Shell/Bash, and Markdown.
- **One-Tap Run & Lint:** Execute the open script directly from the toolbar (`Run`) or run syntax checks (`Check`) with inline error line highlighting.
- **Touchscreen Helpers:** Quick-access toolbar buttons for **All**, **Copy**, **Paste**, and **+Tab**, plus automatic local draft recovery.

### 4. Tools (Local LLM, Web Search & Service Monitor)
- **Local LLM Chat (`:8090`):** Direct prompt interface with a live stopwatch timer connected to a local `llama-server` (`llama.cpp`) instance for running offline `.gguf` models on-device.
- **Web Search:** Integrated web search card with clickable links, text snippets, and one-tap copy buttons.
- **Local Services Monitor:** Automatic parallel localhost port scanner (`1024–10000`) and process detector (`ps -A`) showing `ONLINE` / `OFFLINE` badges, `AUTO` tags, and one-tap **Start**, **Stop**, and **Open** buttons.
- **Saved Routes & Quick Utilities:** Integrates with `~/.routes/routes.db` for instant directory jumps alongside offline Base64 encode/decode, JSON formatter, and SHA-256 hash tools.

---

## Quick Start (Termux)

1. **Clone the repository and install dependencies:**
```bash
git clone https://github.com/Resteus/termux-studio.git
cd termux-studio
pip install -r requirements.txt
```

2. **Start the server:**
```bash
python server.py
```

3. **Open in your mobile browser:**
   Navigate to `http://127.0.0.1:8888`.

### Optional: Local GGUF Model Chat (`:8090`)
1. Install `llama.cpp` (`llama-server`) in Termux.
2. Place a `.gguf` model inside `~/models/` (or export `LLM_MODEL=/path/to/your-model.gguf`).
3. Start or stop the inference server via CLI or the **Local Services** card:
```bash
./llm.sh start
./llm.sh stop
```

---

## Built 100% on Mobile — Author, Device & AI Collaborator

### Creator & Target Hardware
Termux Studio was conceived, built, debugged, and published by **Resteus** (`https://github.com/Resteus`) entirely on a smartphone—with zero laptop or desktop PC involved:
- **Device:** realme RMX5020
- **Operating System:** Android 16 (realme UI 7.0, `aarch64` / ARM64 architecture)
- **Processor (SoC):** MediaTek MT6769 (Octa-core @ 2.0 GHz)
- **Memory & GPU:** 8 GB RAM · Mali-G52 MC2 GPU
- **Runtime Environment:** Termux (`bash` shell, Python virtual environment, mobile browser UI)

### About Gemini (AI Co-Architect)
This project was co-developed in pair-programming sessions with **Gemini** (Google's AI collaborator). Working iteratively from a mobile touchscreen terminal, Gemini assisted with system architecture, Bottle backend endpoints, HTTP byte-range media streaming, Android 16 SELinux-compatible port scanning, mobile UI layout, and repository privacy auditing.

---

## Disclaimer

- **Localhost Use & Security:** Termux Studio binds to `127.0.0.1:8888` and protects API routes with a per-session random token, but its PTY terminal executes commands with your full Termux user permissions. **Do not** expose port `8888` to public networks or untrusted Wi-Fi without placing it behind an authenticated reverse proxy or encrypted tunnel.
- **No Warranty:** This software is provided *"as is"* under the [MIT License](LICENSE), without warranty of any kind. Always review shell commands, scripts, and file operations before running them.
- **Third-Party Tools & Trademarks:** Optional local AI inference relies on user-supplied GGUF models and `llama.cpp`. Termux, Android, realme, and Gemini are trademarks of their respective owners.
