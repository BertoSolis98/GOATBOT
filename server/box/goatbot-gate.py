#!/usr/bin/env python3
"""GoatBot's approval gate: a Hermes `pre_tool_call` shell hook.

Hermes runs this before the tools listed in the hook's matcher (shell, code, browser, desktop
control). It forwards the call to the GoatBot server, which decides from the user's permissions
or puts an approval card in the chat and waits for the answer.

Reads the Hermes hook payload (JSON) on stdin and prints the decision on stdout:
  {}                                    go ahead
  {"action": "block", "message": "..."} do not run the tool; the message goes back to the agent

Where to ask comes from goatbot-gate.json next to this script: {"url": ..., "token": ...}.
The hook is registered with fail_closed, so if this script cannot reach the server or crashes,
Hermes blocks the tool call instead of running it.
"""
import json
import os
import sys
import urllib.error
import urllib.request

# Hermes caps a shell hook at 300 s; answer a little before that so the reason reaches the agent.
WAIT_S = 290


def block(message: str) -> None:
    print(json.dumps({"action": "block", "message": message}))
    sys.exit(0)


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        with open(os.path.join(here, "goatbot-gate.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        url, token = cfg["url"], cfg["token"]
    except Exception as e:  # no config means no way to ask: refuse rather than run unchecked
        block(f"GoatBot's approval gate is not set up ({e}). The tool was not run.")

    try:
        payload = json.load(sys.stdin)
    except Exception:
        block("GoatBot's approval gate got an unreadable request. The tool was not run.")

    body = json.dumps({
        "tool_name": payload.get("tool_name"),
        "tool_input": payload.get("tool_input") or {},
        "tool_call_id": (payload.get("extra") or {}).get("tool_call_id") or "",
        "session_id": payload.get("session_id") or "",
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    })
    try:
        with urllib.request.urlopen(req, timeout=WAIT_S) as res:
            answer = json.loads(res.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        block(f"GoatBot's approval gate refused the request (HTTP {e.code}). The tool was not run.")
    except Exception as e:
        block(f"GoatBot's approval gate could not be reached ({e}). The tool was not run.")

    if answer.get("decision") == "allow":
        print("{}")
    else:
        block(str(answer.get("message") or "Not allowed by the user."))


if __name__ == "__main__":
    main()
