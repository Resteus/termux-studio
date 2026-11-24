import os
import re
import ast
import pty
import html as html_lib
import json
import time
import fcntl
import errno
import shlex
import shutil
import signal
import socket
import struct
import select
import secrets
import termios
import tempfile
import subprocess
import threading
import urllib.parse
import urllib.request
from pathlib import Path
from bottle import Bottle, request, response, abort, static_file

app = Bottle()

HOST = "127.0.0.1"
PORT = 8888
STUDIO_DIR = Path(__file__).resolve().parent
SESSIONS_FILE = STUDIO_DIR / "sessions.json"
ROUTES_DB = Path(os.path.expanduser("~/.routes/routes.db"))
SESSION_TOKEN = secrets.token_hex(24)

STATE_LOCK = threading.Lock()
FILE_LOCK = threading.Lock()
CURRENT_DIR = os.path.expanduser("~")
PREV_DIR = CURRENT_DIR

JOB = {
    "id": None,
    "command": "",
    "running": False,
    "output": "",
    "exit_code": None,
    "cwd": CURRENT_DIR,
    "ls_meta": None,
    "started_at": 0.0,
    "elapsed": 0.0,
    "master_fd": None,
    "proc": None,
    "marker": "",
}

ANSI_RE = re.compile(
    r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))"
)


def apply_terminal_text(existing: str, chunk: str) -> str:
    chunk = ANSI_RE.sub("", chunk)
    chunk = chunk.replace("\r\n", "\n")
    if "\r" not in chunk and "\b" not in chunk:
        return existing + chunk

    buf = existing
    for ch in chunk:
        if ch == "\r":
            nl = buf.rfind("\n")
            buf = buf[: nl + 1] if nl != -1 else ""
        elif ch == "\b":
            if buf and not buf.endswith("\n"):
                buf = buf[:-1]
        else:
            buf += ch
    return buf


def require_token():
    token = request.headers.get("X-Studio-Token", "")
    if not secrets.compare_digest(token, SESSION_TOKEN):
        abort(403, "Invalid or missing session token.")


def resolve_path(raw_path: str, base_dir: str = None) -> str:
    base = base_dir or CURRENT_DIR
    if not raw_path:
        return base
    expanded = os.path.expanduser(raw_path.strip())
    if os.path.isabs(expanded):
        return os.path.normpath(expanded)
    return os.path.normpath(os.path.join(base, expanded))


def format_size(num_bytes: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if num_bytes < 1024.0:
            return f"{num_bytes:.0f} {unit}" if unit == "B" else f"{num_bytes:.1f} {unit}"
        num_bytes /= 1024.0
    return f"{num_bytes:.1f} TB"


def is_port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def set_pty_winsize(fd: int, rows: int = 32, cols: int = 68):
    try:
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except Exception:
        pass


def _strip_marker_preview(text: str, marker: str) -> str:
    idx = text.find(marker)
    if idx != -1:
        return text[:idx].rstrip("\r\n")
    return text


def _extract_final_pwd(text: str, marker: str, fallback_dir: str):
    new_cwd = fallback_dir
    marker_tag = f"\n{marker}:"
    idx = text.rfind(marker_tag)
    if idx != -1:
        pwd_line = text[idx + len(marker_tag) :].splitlines()[0].strip()
        if pwd_line and os.path.isdir(pwd_line):
            new_cwd = pwd_line
        return text[:idx], new_cwd
    if text.startswith(f"{marker}:"):
        pwd_line = text[len(marker) + 1 :].splitlines()[0].strip()
        if pwd_line and os.path.isdir(pwd_line):
            new_cwd = pwd_line
        return "", new_cwd
    return text, new_cwd


def _format_cd_output(cmd: str, clean_out: str, work_dir: str, new_cwd: str, exit_code: int) -> str:
    body = clean_out.strip("\r\n")
    if new_cwd != work_dir:
        header = f"📂 {new_cwd}"
        return f"{header}\n{body}" if body else header
    if exit_code == 0 and not body and (cmd == "cd" or cmd.startswith("cd ")):
        return f"📂 {new_cwd}"
    return body


def _detect_ls_meta(cmd: str, active_cwd: str, exit_code: int):
    if exit_code != 0:
        return None
    tail = re.split(r"&&|;", cmd)[-1].strip()
    if not tail or "|" in tail or ">" in tail:
        return None
    try:
        tokens = shlex.split(tail)
    except ValueError:
        tokens = tail.split()
    if not tokens or tokens[0] != "ls":
        return None

    non_flags = [t for t in tokens[1:] if not t.startswith("-")]
    target_dir = active_cwd
    if len(non_flags) == 1:
        cand = resolve_path(non_flags[0], active_cwd)
        if os.path.isdir(cand):
            target_dir = cand
        elif os.path.exists(cand):
            target_dir = os.path.dirname(cand)
        else:
            return None
    elif len(non_flags) > 1:
        return None

    try:
        items = []
        for name in os.listdir(target_dir):
            full = os.path.join(target_dir, name)
            items.append({
                "name": name,
                "path": full,
                "is_dir": os.path.isdir(full),
            })
        items.sort(key=lambda x: len(x["name"]), reverse=True)
        return {"dir": target_dir, "items": items}
    except OSError:
        return None


def check_syntax(file_path: str, content: str):
    ext = Path(file_path).suffix.lower()
    first_line = content.splitlines()[0].strip() if content.strip() else ""

    if ext == ".py":
        try:
            ast.parse(content, filename=file_path)
            return {"ok": True, "lang": "Python", "message": "No Python syntax errors."}
        except SyntaxError as e:
            return {
                "ok": False,
                "lang": "Python",
                "line": e.lineno or 1,
                "col": e.offset or 1,
                "message": f"Line {e.lineno or 1}: {e.msg}",
            }

    if ext == ".json":
        try:
            json.loads(content)
            return {"ok": True, "lang": "JSON", "message": "Valid JSON."}
        except json.JSONDecodeError as e:
            return {
                "ok": False,
                "lang": "JSON",
                "line": e.lineno,
                "col": e.colno,
                "message": f"Line {e.lineno}, Col {e.colno}: {e.msg}",
            }

    if ext in (".sh", ".bash") or (first_line.startswith("#!/") and "sh" in first_line):
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False, encoding="utf-8") as tf:
                tf.write(content)
                tmp_path = tf.name
            res = subprocess.run(["bash", "-n", tmp_path], capture_output=True, text=True, timeout=5)
            if res.returncode == 0:
                return {"ok": True, "lang": "Shell", "message": "No Bash syntax errors."}
            err = (res.stderr or "Shell syntax error").replace(tmp_path, os.path.basename(file_path)).strip()
            m = re.search(r"line\s+(\d+)", err)
            line_no = int(m.group(1)) if m else 1
            return {"ok": False, "lang": "Shell", "line": line_no, "message": err}
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)

    return {"ok": True, "lang": ext.lstrip(".").upper() or "Text", "message": "Saved cleanly."}


def _pty_reader_worker(job_id: str, master_fd: int, proc: subprocess.Popen, marker: str, work_dir: str, cmd: str):
    global CURRENT_DIR, PREV_DIR
    raw_accum = ""
    try:
        while True:
            rlist, _, _ = select.select([master_fd], [], [], 0.15)
            if master_fd in rlist:
                try:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    text = data.decode("utf-8", errors="replace")
                    raw_accum = apply_terminal_text(raw_accum, text)
                    display_text = _strip_marker_preview(raw_accum, marker)
                    with STATE_LOCK:
                        if JOB["id"] == job_id:
                            JOB["output"] = display_text
                            JOB["elapsed"] = round(time.time() - JOB["started_at"], 2)
                except OSError as e:
                    if e.errno in (errno.EIO, errno.EBADF):
                        break
                    raise

            if proc.poll() is not None:
                while True:
                    try:
                        r2, _, _ = select.select([master_fd], [], [], 0.05)
                        if master_fd not in r2:
                            break
                        data = os.read(master_fd, 4096)
                        if not data:
                            break
                        raw_accum = apply_terminal_text(
                            raw_accum, data.decode("utf-8", errors="replace")
                        )
                    except OSError:
                        break
                break
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

        exit_code = proc.poll()
        if exit_code is None:
            try:
                exit_code = proc.wait(timeout=1)
            except Exception:
                exit_code = 1

        clean_out, new_cwd = _extract_final_pwd(raw_accum, marker, work_dir)
        final_out = _format_cd_output(cmd, clean_out, work_dir, new_cwd, exit_code)
        ls_meta = _detect_ls_meta(cmd, new_cwd, exit_code)

        with STATE_LOCK:
            if new_cwd != CURRENT_DIR and os.path.isdir(new_cwd):
                PREV_DIR = CURRENT_DIR
                CURRENT_DIR = new_cwd
            if JOB["id"] == job_id:
                JOB["output"] = final_out
                JOB["exit_code"] = exit_code
                JOB["cwd"] = CURRENT_DIR
                JOB["ls_meta"] = ls_meta
                JOB["elapsed"] = round(time.time() - JOB["started_at"], 2)
                JOB["running"] = False
                JOB["master_fd"] = None
                JOB["proc"] = None


@app.get("/assets/<filepath:path>")
def serve_assets(filepath):
    return static_file(filepath, root=str(STUDIO_DIR / "assets"))


@app.get("/")
def index():
    html_file = STUDIO_DIR / "index.html"
    if not html_file.exists():
        return "<h3>index.html missing</h3>"
    html = html_file.read_text(encoding="utf-8")
    html = html.replace("__STUDIO_TOKEN__", SESSION_TOKEN)
    response.content_type = "text/html; charset=utf-8"
    return html


@app.get("/api/status")
def api_status():
    require_token()
    with STATE_LOCK:
        cwd = CURRENT_DIR
        running = JOB["running"]
        job_id = JOB["id"]
    _, _, free = shutil.disk_usage(os.path.expanduser("~"))
    return {
        "cwd": cwd,
        "running": running,
        "job_id": job_id,
        "disk_free": format_size(free),
        "port": PORT,
    }


def _scan_active_ports(pinned_ports: set) -> list:
    import concurrent.futures

    proc_by_port = {}
    generic_procs = []
    try:
        out = subprocess.check_output(["ps", "-A", "-o", "pid,args"], text=True, stderr=subprocess.DEVNULL)
        for line in out.splitlines()[1:]:
            parts = line.split(None, 1)
            if len(parts) < 2 or not parts[0].isdigit():
                continue
            pid, cmd = int(parts[0]), parts[1].strip()
            if pid == os.getpid() or "ps -A" in cmd:
                continue

            ports = [int(x) for x in re.findall(r"(?::|--port[=\s]+|-p[=\s]+)(\d{4,5})\b", cmd)]
            matched_port = next((p for p in ports if 1024 <= p <= 65535 and p not in pinned_ports), None)

            lower = cmd.lower()
            if "postgres" in lower and ("-d " in lower or "postgresql" in lower):
                proc_by_port[5432] = {"pid": pid, "name": "PostgreSQL"}
                continue

            if "http.server" in lower:
                label = "Python HTTP Server"
            elif "uvicorn" in lower:
                label = "Uvicorn Server"
            elif "vite" in lower or "next" in lower or "node" in lower:
                label = "Node Web Server"
            elif "python" in lower:
                py_files = [t for t in cmd.split() if t.endswith(".py")]
                if py_files:
                    sp = Path(py_files[0])
                    stem = sp.parent.name if sp.name in ("server.py", "app.py", "main.py", "manage.py") else sp.stem
                    label = stem.replace("-", " ").replace("_", " ").title()
                else:
                    label = "Python Service"
            else:
                toks = [os.path.basename(t) for t in cmd.split() if not t.startswith("-")]
                label = " ".join(toks[:2]) if toks else "Local Service"

            if matched_port:
                proc_by_port[matched_port] = {"pid": pid, "name": label}
            elif any(k in lower for k in ("python", "node", "php", "ruby", "uvicorn", "gunicorn")):
                generic_procs.append({"pid": pid, "name": label})
    except Exception:
        pass

    def _probe(port: int) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.05):
                return True
        except OSError:
            return False

    candidates = [p for p in range(1024, 10001) if p not in pinned_ports]
    with concurrent.futures.ThreadPoolExecutor(max_workers=128) as pool:
        open_ports = [p for p, ok in zip(candidates, pool.map(_probe, candidates)) if ok]

    discovered = []
    for p in open_ports:
        info = proc_by_port.get(p) or (generic_procs[0] if len(open_ports) == 1 and len(generic_procs) == 1 else {})
        entry = {"name": info.get("name") or f"Local Service (:{p})", "port": p, "url": f"http://127.0.0.1:{p}", "running": True, "auto": True}
        if info.get("pid"):
            entry["stop_cmd"] = f"kill {info['pid']}"
        discovered.append(entry)
    return discovered


@app.get("/api/workspace")
def api_workspace():
    require_token()
    routes = []
    if ROUTES_DB.exists():
        try:
            for line in ROUTES_DB.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = re.split(r"[=|\t:]", line, maxsplit=1)
                if len(parts) == 2:
                    name, path = parts[0].strip(), os.path.expanduser(parts[1].strip())
                    if name and path:
                        routes.append({"name": name, "path": path, "exists": os.path.isdir(path)})
        except Exception:
            pass

    llm_script = shlex.quote(str(STUDIO_DIR / "llm.sh"))
    servers = [
        {"name": "Termux Studio", "port": 8888, "url": "http://127.0.0.1:8888", "running": True},
        {"name": "Local LLM (llama-server)", "port": 8090, "url": "http://127.0.0.1:8090", "running": is_port_open(8090), "start_cmd": f"{llm_script} start", "stop_cmd": f"{llm_script} stop"},
    ]
    servers.extend(_scan_active_ports({s["port"] for s in servers}))
    return {"routes": routes, "servers": servers}


@app.get("/api/tools/search")
def api_tools_search():
    require_token()
    query = (request.query.get("q") or "").strip()
    if not query:
        return {"ok": False, "results": [], "error": "Empty query."}

    results = []
    ua = "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"

    try:
        body = urllib.parse.urlencode({"q": query}).encode("utf-8")
        req = urllib.request.Request(
            "https://lite.duckduckgo.com/lite/",
            data=body,
            headers={"User-Agent": ua, "Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw_html = resp.read().decode("utf-8", errors="replace")

        anchors = re.findall(r"<a\b([^>]*)>(.*?)</a>", raw_html, re.S | re.I)
        links = []
        for attrs, raw_title in anchors:
            if "result-link" not in attrs:
                continue
            hm = re.search(r"href=([\x22\x27])([^\x22\x27]+)\1", attrs, re.I)
            if hm:
                links.append((hm.group(2), raw_title))

        snippets = re.findall(
            r"<td[^>]*class=[\x22\x27]result-snippet[\x22\x27][^>]*>(.*?)</td>",
            raw_html,
            re.S | re.I,
        )
        for idx, (href, raw_title) in enumerate(links[:8]):
            title = html_lib.unescape(re.sub(r"<[^>]+>", "", raw_title)).strip()
            snip = html_lib.unescape(re.sub(r"<[^>]+>", "", snippets[idx])).strip() if idx < len(snippets) else ""
            if "uddg=" in href:
                parsed = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
                href = parsed.get("uddg", [href])[0]
            if title and href.startswith("http"):
                results.append({"title": title, "url": href, "snippet": snip})
    except Exception:
        pass

    if not results:
        try:
            wiki_url = (
                "https://en.wikipedia.org/w/api.php?action=opensearch&limit=6&namespace=0&format=json&search="
                + urllib.parse.quote(query)
            )
            wreq = urllib.request.Request(wiki_url, headers={"User-Agent": "TermuxStudio/1.0"})
            with urllib.request.urlopen(wreq, timeout=8) as wresp:
                wdata = json.loads(wresp.read().decode("utf-8", errors="replace"))
            titles = wdata[1] if len(wdata) > 1 else []
            descs = wdata[2] if len(wdata) > 2 else []
            urls = wdata[3] if len(wdata) > 3 else []
            for i in range(min(len(titles), len(urls))):
                results.append({
                    "title": titles[i],
                    "url": urls[i],
                    "snippet": descs[i] if i < len(descs) else "",
                })
        except Exception as exc:
            return {"ok": False, "results": [], "error": f"Search failed: {exc}"}

    return {"ok": True, "query": query, "results": results}


def _agent_exec_tool(tool_name: str, payload: dict) -> str:
    if tool_name == "run_shell":
        cmd = str(payload.get("arg") or payload.get("command") or "").strip()
        if not cmd:
            return "Error: empty shell command."
        try:
            res = subprocess.run(
                ["bash", "-c", cmd],
                cwd=CURRENT_DIR,
                capture_output=True,
                text=True,
                timeout=15,
            )
            out = ((res.stdout or "") + (res.stderr or "")).strip()
            return (out[:1600] + "\n...(truncated)") if len(out) > 1600 else (out or f"(exit {res.returncode}, no output)")
        except Exception as exc:
            return f"Shell error: {exc}"

    if tool_name == "read_file":
        raw_p = str(payload.get("arg") or payload.get("path") or "").strip()
        fp = resolve_path(raw_p)
        if not os.path.isfile(fp):
            return f"File not found: {fp}"
        try:
            txt = Path(fp).read_text(encoding="utf-8", errors="replace")
            return txt[:2200] + ("\n...(truncated)" if len(txt) > 2200 else "")
        except Exception as exc:
            return f"Read error: {exc}"

    if tool_name == "write_file":
        raw_p = str(payload.get("path") or payload.get("arg") or "").strip()
        content = str(payload.get("content") or "")
        if not raw_p:
            return "Error: missing file path."
        fp = resolve_path(raw_p)
        try:
            os.makedirs(os.path.dirname(fp), exist_ok=True)
            Path(fp).write_text(content, encoding="utf-8")
            return f"Saved {fp} ({len(content)} chars)."
        except Exception as exc:
            return f"Write error: {exc}"

    if tool_name == "web_search":
        q = str(payload.get("arg") or payload.get("query") or "").strip()
        if not q:
            return "Error: empty search query."
        try:
            wiki_url = (
                "https://en.wikipedia.org/w/api.php?action=opensearch&limit=4&namespace=0&format=json&search="
                + urllib.parse.quote(q)
            )
            wreq = urllib.request.Request(wiki_url, headers={"User-Agent": "TermuxStudio/1.0"})
            with urllib.request.urlopen(wreq, timeout=8) as wresp:
                wdata = json.loads(wresp.read().decode("utf-8", errors="replace"))
            titles = wdata[1] if len(wdata) > 1 else []
            descs = wdata[2] if len(wdata) > 2 else []
            urls = wdata[3] if len(wdata) > 3 else []
            lines = [f"- {titles[i]}: {descs[i]} ({urls[i]})" for i in range(min(len(titles), len(urls)))]
            return "\n".join(lines) if lines else "No search results found."
        except Exception as exc:
            return f"Search error: {exc}"

    return f"Unknown tool: {tool_name}"


def _extract_tool_calls(text: str) -> list:
    cleaned = re.sub(r"```(?:json)?|```", "", text).strip()
    decoder = json.JSONDecoder()
    calls = []
    idx = 0
    n = len(cleaned)
    while idx < n:
        brace = cleaned.find("{", idx)
        if brace == -1:
            break
        try:
            obj, end_idx = decoder.raw_decode(cleaned, brace)
            if isinstance(obj, dict) and obj.get("tool"):
                calls.append(obj)
            idx = end_idx
        except Exception:
            idx = brace + 1
    return calls


def _call_local_llm(messages: list) -> str:
    body = json.dumps({
        "messages": messages,
        "temperature": 0.4,
        "max_tokens": 256,
        "cache_prompt": True,
    }).encode("utf-8")
    req = urllib.request.Request(
        "http://127.0.0.1:8090/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read().decode("utf-8", errors="replace"))
    return data["choices"][0]["message"]["content"].strip()


@app.post("/api/agent")
def api_agent():
    require_token()
    t0 = time.time()
    data = request.json or {}
    goal = (data.get("prompt") or "").strip()
    if not goal:
        return {"ok": False, "error": "Empty prompt.", "elapsed": 0.0}

    messages = [
        {"role": "system", "content": "You are a helpful, concise local assistant running on Android Termux. Answer clearly and directly."},
        {"role": "user", "content": goal},
    ]
    try:
        reply = _call_local_llm(messages)
        return {"ok": True, "reply": reply, "steps": [], "elapsed": round(time.time() - t0, 2)}
    except Exception as exc:
        return {
            "ok": False,
            "error": f"LLM offline or busy on :8090 ({exc})",
            "steps": [],
            "elapsed": round(time.time() - t0, 2),
        }


@app.post("/api/cd")
def api_cd():
    global CURRENT_DIR, PREV_DIR
    require_token()
    data = request.json or {}
    target = resolve_path(data.get("cwd", ""))
    if os.path.isdir(target):
        with STATE_LOCK:
            if target != CURRENT_DIR:
                PREV_DIR = CURRENT_DIR
                CURRENT_DIR = target
            cwd = CURRENT_DIR
        return {"ok": True, "cwd": cwd}
    return {"ok": False, "cwd": CURRENT_DIR}


@app.get("/api/sessions")
def api_get_sessions():
    require_token()
    with FILE_LOCK:
        if not SESSIONS_FILE.exists():
            return {"sessions": [], "activeSessionId": None, "activeChatId": None}
        try:
            data = json.loads(SESSIONS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("sessions"), list):
                return data
        except Exception:
            pass
    return {"sessions": [], "activeSessionId": None, "activeChatId": None}


@app.post("/api/sessions")
def api_save_sessions():
    require_token()
    data = request.json or {}
    if not isinstance(data.get("sessions"), list):
        abort(400, "Invalid sessions payload.")
    with FILE_LOCK:
        tmp_file = STUDIO_DIR / "sessions.json.tmp"
        tmp_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp_file, SESSIONS_FILE)
    return {"ok": True}


@app.post("/api/exec")
def api_exec():
    global CURRENT_DIR, PREV_DIR
    require_token()

    data = request.json or {}
    cmd = (data.get("command") or "").strip()
    cols = int(data.get("cols") or 68)
    if not cmd:
        return {"ok": False, "output": "Empty command.", "exit_code": 1, "cwd": CURRENT_DIR}

    edit_match = re.match(r"^(?:edit|nano|vi|vim)\s+(.+)$", cmd)
    if edit_match:
        target = edit_match.group(1).strip().strip("'\"")
        full_path = resolve_path(target)
        return {
            "ok": True,
            "running": False,
            "action": "open_editor",
            "path": full_path,
            "output": f"Opening {full_path} in Web Editor...",
            "exit_code": 0,
            "cwd": CURRENT_DIR,
            "elapsed": 0.0,
        }

    if cmd == "cd -":
        with STATE_LOCK:
            CURRENT_DIR, PREV_DIR = PREV_DIR, CURRENT_DIR
            cwd = CURRENT_DIR
        return {
            "ok": True,
            "running": False,
            "output": f"📂 {cwd}",
            "exit_code": 0,
            "cwd": cwd,
            "elapsed": 0.0,
        }

    with STATE_LOCK:
        if JOB["running"]:
            return {
                "ok": False,
                "running": True,
                "job_id": JOB["id"],
                "output": "A command is still running. Send input to it or tap Ctrl+C.",
                "exit_code": 1,
                "cwd": CURRENT_DIR,
            }
        work_dir = CURRENT_DIR

    marker = f"__STUDIO_PWD_{secrets.token_hex(6)}__"
    wrapped_cmd = (
        f"{cmd}\n"
        f"__EC=$?\n"
        f'printf "\\n{marker}:%s\\n" "$(pwd)"\n'
        f"exit $__EC\n"
    )

    env = os.environ.copy()
    venv_bin = os.path.expanduser("~/centralized-venv/bin")
    if os.path.isdir(venv_bin) and venv_bin not in env.get("PATH", ""):
        env["PATH"] = f"{venv_bin}:{env.get('PATH', '')}"
    env["TERM"] = "xterm"
    env["COLUMNS"] = str(max(40, min(cols, 140)))

    master_fd, slave_fd = pty.openpty()
    set_pty_winsize(master_fd, rows=32, cols=max(40, min(cols, 140)))

    def _setup_slave():
        os.setsid()
        try:
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        except Exception:
            pass

    try:
        proc = subprocess.Popen(
            ["bash", "-c", wrapped_cmd],
            cwd=work_dir,
            env=env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
            preexec_fn=_setup_slave,
        )
    except Exception as exc:
        os.close(master_fd)
        os.close(slave_fd)
        return {
            "ok": False,
            "running": False,
            "output": f"Failed to start command: {exc}",
            "exit_code": 1,
            "cwd": work_dir,
        }

    os.close(slave_fd)

    job_id = secrets.token_hex(8)
    with STATE_LOCK:
        JOB.update(
            {
                "id": job_id,
                "command": cmd,
                "running": True,
                "output": "",
                "exit_code": None,
                "cwd": work_dir,
                "ls_meta": None,
                "started_at": time.time(),
                "elapsed": 0.0,
                "master_fd": master_fd,
                "proc": proc,
                "marker": marker,
            }
        )

    t = threading.Thread(
        target=_pty_reader_worker,
        args=(job_id, master_fd, proc, marker, work_dir, cmd),
        daemon=True,
    )
    t.start()

    deadline = time.time() + 0.25
    while time.time() < deadline:
        with STATE_LOCK:
            if not JOB["running"]:
                break
        time.sleep(0.03)

    with STATE_LOCK:
        return {
            "ok": (JOB["exit_code"] == 0) if not JOB["running"] else True,
            "running": JOB["running"],
            "job_id": job_id,
            "output": JOB["output"],
            "exit_code": JOB["exit_code"],
            "cwd": JOB["cwd"],
            "ls_meta": JOB["ls_meta"],
            "elapsed": JOB["elapsed"],
        }


@app.get("/api/poll")
def api_poll():
    require_token()
    job_id = request.query.get("id", "")
    with STATE_LOCK:
        if JOB["id"] != job_id:
            return {"found": False, "running": False}
        return {
            "found": True,
            "running": JOB["running"],
            "ok": (JOB["exit_code"] == 0) if not JOB["running"] else True,
            "output": JOB["output"],
            "exit_code": JOB["exit_code"],
            "cwd": JOB["cwd"],
            "ls_meta": JOB["ls_meta"],
            "elapsed": JOB["elapsed"],
        }


@app.post("/api/stdin")
def api_stdin():
    require_token()
    data = request.json or {}
    text = data.get("input", "")
    append_newline = bool(data.get("newline", True))

    with STATE_LOCK:
        if not JOB["running"] or JOB["master_fd"] is None:
            return {"ok": False, "message": "No interactive command is currently running."}
        fd = JOB["master_fd"]

    payload = (text + ("\n" if append_newline else "")).encode("utf-8")
    try:
        os.write(fd, payload)
        return {"ok": True}
    except OSError as exc:
        return {"ok": False, "message": f"Failed to send input: {exc}"}


@app.post("/api/kill")
def api_kill():
    require_token()
    with STATE_LOCK:
        proc = JOB["proc"]
        running = JOB["running"]
    if not running or proc is None or proc.poll() is not None:
        return {"ok": True, "message": "No active command running."}
    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGINT)
        time.sleep(0.25)
        if proc.poll() is None:
            os.killpg(pgid, signal.SIGTERM)
            time.sleep(0.2)
        if proc.poll() is None:
            os.killpg(pgid, signal.SIGKILL)
        return {"ok": True, "message": "Sent Ctrl+C (SIGINT) to process."}
    except Exception as exc:
        return {"ok": False, "message": f"Failed to stop process: {exc}"}


@app.get("/api/files")
def api_files():
    require_token()
    raw_path = request.query.get("path", "")
    target_dir = resolve_path(raw_path)

    if not os.path.exists(target_dir):
        abort(404, "Directory not found.")
    if not os.path.isdir(target_dir):
        target_dir = os.path.dirname(target_dir)

    entries = []
    try:
        for name in os.listdir(target_dir):
            full = os.path.join(target_dir, name)
            try:
                st = os.lstat(full)
                is_dir = os.path.isdir(full)
                entries.append(
                    {
                        "name": name,
                        "path": full,
                        "is_dir": is_dir,
                        "size": "-" if is_dir else format_size(st.st_size),
                        "mtime": int(st.st_mtime),
                    }
                )
            except OSError:
                continue
    except PermissionError:
        abort(403, "Permission denied.")

    entries.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
    parent = os.path.dirname(target_dir) if target_dir != "/" else "/"
    return {"path": target_dir, "parent": parent, "entries": entries}


@app.post("/api/file/upload")
def api_file_upload():
    require_token()
    dest_dir = resolve_path(request.forms.get("dir", CURRENT_DIR))
    if not os.path.isdir(dest_dir):
        abort(400, "Target directory not found.")
    uploads = request.files.getall("files")
    if not uploads:
        abort(400, "No files selected.")
    saved = []
    for item in uploads:
        safe_name = os.path.basename(item.filename or "").strip()
        if not safe_name:
            continue
        dest_path = os.path.join(dest_dir, safe_name)
        item.save(dest_path, overwrite=True)
        saved.append(safe_name)
    return {"ok": True, "saved": saved, "count": len(saved)}


@app.get("/api/file/download")
def api_file_download():
    token = request.query.get("token", "")
    if not secrets.compare_digest(token, SESSION_TOKEN):
        abort(403, "Invalid token.")
    full_path = resolve_path(request.query.get("path", ""))
    if not os.path.isfile(full_path):
        abort(404, "File not found.")
    return static_file(
        os.path.basename(full_path),
        root=os.path.dirname(full_path),
        download=os.path.basename(full_path),
    )


@app.get("/api/file/media")
def api_file_media():
    token = request.query.get("token", "")
    if not secrets.compare_digest(token, SESSION_TOKEN):
        abort(403, "Invalid token.")
    full_path = resolve_path(request.query.get("path", ""))
    if not os.path.isfile(full_path):
        abort(404, "File not found.")
    return static_file(
        os.path.basename(full_path),
        root=os.path.dirname(full_path),
    )


@app.get("/api/file/read")
def api_file_read():
    require_token()
    full_path = resolve_path(request.query.get("path", ""))
    if not os.path.exists(full_path):
        return {"path": full_path, "content": "", "is_new": True}
    if os.path.isdir(full_path):
        abort(400, "Cannot edit a directory.")
    if os.path.getsize(full_path) > 2 * 1024 * 1024:
        abort(400, "File larger than 2 MB; edit via shell tools instead.")

    try:
        with open(full_path, "r", encoding="utf-8") as f:
            content = f.read()
        return {"path": full_path, "content": content, "is_new": False}
    except UnicodeDecodeError:
        abort(400, "Binary file cannot be opened in text editor.")


@app.post("/api/file/write")
def api_file_write():
    require_token()
    data = request.json or {}
    full_path = resolve_path(data.get("path", ""))
    content = data.get("content", "")

    parent = os.path.dirname(full_path)
    if parent and not os.path.exists(parent):
        os.makedirs(parent, exist_ok=True)

    with open(full_path, "w", encoding="utf-8") as f:
        f.write(content)
    lint = check_syntax(full_path, content)
    return {
        "ok": True,
        "path": full_path,
        "size": format_size(os.path.getsize(full_path)),
        "lint": lint,
    }


@app.post("/api/file/lint")
def api_file_lint():
    require_token()
    data = request.json or {}
    full_path = resolve_path(data.get("path", "untitled.txt"))
    content = data.get("content", "")
    return check_syntax(full_path, content)


@app.post("/api/file/create")
def api_file_create():
    require_token()
    data = request.json or {}
    base_dir = resolve_path(data.get("dir", CURRENT_DIR))
    name = (data.get("name") or "").strip()
    kind = data.get("kind", "file")
    if not name or "/" in name:
        abort(400, "Invalid name.")

    target = os.path.join(base_dir, name)
    if os.path.exists(target):
        abort(400, "Item already exists.")

    if kind == "folder":
        os.makedirs(target, exist_ok=True)
    else:
        with open(target, "w", encoding="utf-8") as f:
            f.write("")
    return {"ok": True, "path": target}


@app.post("/api/file/rename")
def api_file_rename():
    require_token()
    data = request.json or {}
    src = resolve_path(data.get("path", ""))
    new_name = (data.get("new_name") or "").strip()
    if not os.path.exists(src):
        abort(404, "Item not found.")
    if not new_name or "/" in new_name:
        abort(400, "Invalid new name.")

    dst = os.path.join(os.path.dirname(src), new_name)
    if os.path.exists(dst):
        abort(400, "Target name already exists.")
    os.rename(src, dst)
    return {"ok": True, "path": dst}


def _unique_dest(dest_dir: str, base_name: str) -> str:
    candidate = os.path.join(dest_dir, base_name)
    if not os.path.exists(candidate):
        return candidate
    p = Path(base_name)
    stem = p.stem if p.suffix else base_name
    suffix = p.suffix if p.suffix else ""
    idx = 1
    while True:
        cand = os.path.join(dest_dir, f"{stem}_copy{idx}{suffix}")
        if not os.path.exists(cand):
            return cand
        idx += 1


@app.post("/api/file/copy")
def api_file_copy():
    require_token()
    data = request.json or {}
    src = resolve_path(data.get("src", ""))
    dest_dir = resolve_path(data.get("dest_dir", ""))
    if not os.path.exists(src):
        abort(404, "Source not found.")
    if not os.path.isdir(dest_dir):
        abort(400, "Destination folder not found.")

    dst = _unique_dest(dest_dir, os.path.basename(src))
    if os.path.isdir(src):
        if os.path.commonpath([src, dst]) == src:
            abort(400, "Cannot copy a folder inside itself.")
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)
    return {"ok": True, "path": dst, "name": os.path.basename(dst)}


@app.post("/api/file/move")
def api_file_move():
    require_token()
    data = request.json or {}
    src = resolve_path(data.get("src", ""))
    dest_dir = resolve_path(data.get("dest_dir", ""))
    if not os.path.exists(src):
        abort(404, "Source not found.")
    if not os.path.isdir(dest_dir):
        abort(400, "Destination folder not found.")

    dst = os.path.join(dest_dir, os.path.basename(src))
    if src == dst:
        return {"ok": True, "path": dst}
    if os.path.exists(dst):
        abort(400, "Item with same name already exists in destination.")
    if os.path.isdir(src) and os.path.commonpath([src, dst]) == src:
        abort(400, "Cannot move a folder inside itself.")
    shutil.move(src, dst)
    return {"ok": True, "path": dst, "name": os.path.basename(dst)}


@app.post("/api/file/delete")
def api_file_delete():
    require_token()
    data = request.json or {}
    full_path = resolve_path(data.get("path", ""))
    if not os.path.exists(full_path):
        abort(404, "Item not found.")

    trash_bin = shutil.which("trash") or os.path.expanduser("~/.trash/trash.sh")
    if os.path.exists(trash_bin):
        subprocess.run(["bash", trash_bin, full_path], check=False)
        return {"ok": True, "message": f"Moved to trash: {os.path.basename(full_path)}"}

    fallback_trash = os.path.expanduser("~/.trash")
    os.makedirs(fallback_trash, exist_ok=True)
    shutil.move(full_path, os.path.join(fallback_trash, os.path.basename(full_path)))
    return {"ok": True, "message": f"Moved to ~/.trash: {os.path.basename(full_path)}"}


if __name__ == "__main__":
    from waitress import serve
    print(f"Termux Studio V6 PTY Server running on http://{HOST}:{PORT}")
    serve(app, host=HOST, port=PORT, threads=8)
