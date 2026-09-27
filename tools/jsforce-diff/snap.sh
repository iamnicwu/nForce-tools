#!/bin/bash
# 用无头 Chrome 打开差分页面，等它把断言写进 DOM 后抓出来。
#
# 用法: ./snap.sh [输出文件] [最多等几秒]
#
# 注意两点：
#   · 必须 --no-sandbox：沙箱里 Chrome 自身的沙箱初始化会失败。
#   · 必须用 grep -E：macOS 自带的是 BSD grep，不支持 BRE 的 "\|" 交替，
#     `grep -q 'a\|b'` 会**静默零匹配**，于是这个循环永远不提前退出、每次空等满超时。
set -u

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT="${PORT:-8788}"
OUT="${1:-/tmp/jsforce-diff-dump.html}"
WAIT="${2:-40}"

if [ ! -x "$CHROME" ]; then echo "找不到 Chrome: $CHROME" >&2; exit 1; fi

PROFILE="$(mktemp -d /tmp/sfjd-profile.XXXXXX)"
rm -f "$OUT"

"$CHROME" --headless=new --no-sandbox --disable-gpu \
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  --virtual-time-budget=15000 --dump-dom "http://127.0.0.1:${PORT}/" > "$OUT" 2>/dev/null &
PID=$!

for _ in $(seq 1 "$WAIT"); do
  sleep 1
  if [ -s "$OUT" ] && grep -qE 'data-status="(ok|diff)"' "$OUT" 2>/dev/null; then break; fi
done

sleep 1
kill -TERM "$PID" 2>/dev/null
wait "$PID" 2>/dev/null
rm -rf "$PROFILE"

echo "dump: $(wc -c < "$OUT" | tr -d ' ') bytes → $OUT"
