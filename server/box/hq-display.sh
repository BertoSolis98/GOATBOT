#!/usr/bin/env bash
# hq-display: start or stop one X display with its window manager and VNC server, for running
# GoatBot on your own machine (COMPUTER=local). On Orgo, Orgo provides these instead.
#
#   hq-display.sh start N    display :N, VNC on 127.0.0.1:$((5900 + N - 99))
#   hq-display.sh stop N
#   hq-display.sh list       numbers of the displays that are up
#
# Size: HQ_SCREEN_SIZE (default 1280x800). VNC password: /root/goatbot/vnc/passwd (made on first use).
set -euo pipefail

ROOT=/root/goatbot
RUN=$ROOT/displays
SIZE="${HQ_SCREEN_SIZE:-1280x800}"
mkdir -p "$RUN" "$ROOT/vnc"

up() { [ -S "/tmp/.X11-unix/X$1" ] && xdpyinfo -display ":$1" >/dev/null 2>&1; }
port() { echo $((5900 + $1 - 99)); }

vnc_password() {
  if [ ! -s "$ROOT/vnc/passwd.txt" ]; then
    umask 077
    head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 8 > "$ROOT/vnc/passwd.txt"
    x11vnc -storepasswd "$(cat "$ROOT/vnc/passwd.txt")" "$ROOT/vnc/passwd" >/dev/null 2>&1
  fi
}

start() {
  n=$1
  [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 99 ] || { echo "bad display: $n" >&2; exit 2; }
  vnc_password
  if ! up "$n"; then
    rm -f "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"
    setsid nohup Xvfb ":$n" -screen 0 "${SIZE}x24" -nolisten tcp -dpi 96 >"$RUN/xvfb-$n.log" 2>&1 &
    echo $! > "$RUN/xvfb-$n.pid"
    for _ in $(seq 1 50); do up "$n" && break; sleep 0.1; done
    up "$n" || { echo "display :$n did not start" >&2; exit 1; }
  fi
  if ! pgrep -f "xfwm4 --display :$n( |$)" >/dev/null; then
    DISPLAY=":$n" setsid nohup xfwm4 --display ":$n" --compositor=off >"$RUN/wm-$n.log" 2>&1 &
    echo $! > "$RUN/wm-$n.pid"
  fi
  if ! pgrep -f "x11vnc .*-display :$n " >/dev/null; then
    setsid nohup x11vnc -display ":$n" -rfbport "$(port "$n")" -localhost -rfbauth "$ROOT/vnc/passwd" \
      -forever -shared -noxdamage -quiet >"$RUN/vnc-$n.log" 2>&1 &
    echo $! > "$RUN/vnc-$n.pid"
  fi
  echo "up :$n vnc $(port "$n") ${SIZE}"
}

stop() {
  n=$1
  for what in vnc wm xvfb; do
    if [ -f "$RUN/$what-$n.pid" ]; then kill "$(cat "$RUN/$what-$n.pid")" 2>/dev/null || true; rm -f "$RUN/$what-$n.pid"; fi
  done
  rm -f "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"
  echo "down :$n"
}

case "${1:-}" in
  start) start "$2" ;;
  stop) stop "$2" ;;
  list) for s in /tmp/.X11-unix/X*; do n=${s##*X}; [ "$n" -ge 99 ] 2>/dev/null && up "$n" && echo "$n"; done; true ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
