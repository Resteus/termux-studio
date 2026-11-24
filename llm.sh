#!/data/data/com.termux/files/usr/bin/bash
DIR="$HOME/termux-studio"
MODEL="/storage/EFFE-E067/Local Ai/Qwen2.5-Coder-3B-Instruct-abliterated-Q4_K_M.gguf"
[ -f "$HOME/models/Qwen2.5-Coder-3B-Instruct-abliterated-Q4_K_M.gguf" ] && MODEL="$HOME/models/Qwen2.5-Coder-3B-Instruct-abliterated-Q4_K_M.gguf"
PID_FILE="$DIR/llm.pid"
LOG_FILE="$DIR/llm.log"

case "${1:-start}" in
  start)
    if [ ! -f "$MODEL" ]; then
      echo "Model not found: $MODEL"
      exit 1
    fi
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "LLM already running (PID $(cat "$PID_FILE"))"
      exit 0
    fi
    nohup llama-server \
      -m "$MODEL" \
      --host 127.0.0.1 \
      --port 8090 \
      -t 2 \
      -tb 2 \
      -c 1024 \
      -np 1 \
      --no-warmup > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "Started Qwen2.5-Coder-3B (PID $!)..."
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null
      rm -f "$PID_FILE"
    fi
    pkill -f "llama-server.*8090" 2>/dev/null
    echo "Stopped llama-server."
    ;;
  *)
    echo "Usage: ~/termux-studio/llm.sh {start|stop}"
    ;;
esac
