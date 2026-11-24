# Termux Studio

A lightweight, mobile-first web IDE and workspace for **Android Termux**, built with Python (`Bottle`) and vanilla HTML/CSS/JavaScript.

## Features
- **Browser PTY Terminal:** Interactive shell sessions with persistent tabs and directory tracking.
- **File Manager & Inline Media Player:** Browse, upload, download, and stream audio (`.wav`, `.mp3`, `.ogg`), video (`.mp4`, `.webm`), images, and `.pdf` files directly in the browser.
- **Mobile Code Editor:** Syntax-highlighted editing with one-tap script execution and syntax checks.
- **Workspace Tools:** Automatic localhost port scanner, saved `route` bookmarks, web search, offline JSON/Base64/SHA-256 tools, and optional local `llama-server` (`:8090`) chat.

## Quick Start (Termux)
```bash
pip install -r requirements.txt
python server.py
```

Open `http://127.0.0.1:8888` in your mobile browser.

## Optional Local GGUF Chat (`:8090`)
Place a `.gguf` model in `~/models/` (or set `LLM_MODEL=/path/to/model.gguf`) and run:
```bash
./llm.sh start
```
