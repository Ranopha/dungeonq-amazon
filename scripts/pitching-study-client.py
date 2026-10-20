"""固定預算的 workspace client；憑證與原始記錄只留私人目錄。"""
import fcntl
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid
from urllib.parse import urlsplit


def endpoint(config, family):
    transport = config.get("transport", "https")
    if transport == "https":
        assert config["origin"] == "https://dungeonq.talkidino.com"
        return config["origin"], []
    assert transport == "loopback"
    origin = config["origin"] if family == "http" else config["mcpOrigin"]
    parsed = urlsplit(origin)
    assert (parsed.scheme == "http" and parsed.hostname == "127.0.0.1"
            and parsed.port is not None and 0 < parsed.port <= 65535
            and origin == "http://127.0.0.1:" + str(parsed.port))
    # Explicit loopback has no DNS, redirects, proxy or external inference endpoint.
    return origin, ["--noproxy", "*"]


def main():
    # argv: participant-directory http|mcp operation JSON-args
    directory = pathlib.Path(sys.argv[1]).resolve()
    family, operation = sys.argv[2:4]
    args = json.loads(sys.argv[4]) if len(sys.argv) == 5 else {}
    assert family in ("http", "mcp")
    assert operation in ("snapshot", "read", "write", "issue-ticket", "use-ticket")
    assert isinstance(args, dict)
    os.umask(0o077)
    with (directory / "client.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        config = json.loads((directory / "participant.json").read_text())
        origin, transport_args = endpoint(config, family)
        state_path = directory / "budget.json"
        state = json.loads(state_path.read_text()) if state_path.exists() else {"startedAt": time.time(), "requests": 0}
        if state["requests"] >= 40 or time.time() - state["startedAt"] >= 300:
            print(json.dumps({"error": "STUDY_BUDGET_ENDED", "requests": state["requests"]}))
            return
        request_id = str(uuid.uuid4())
        body = {"requestId": request_id, "operation": operation, "args": args}
        path = "/api/operate"
        if family == "mcp":
            path = "/mcp"
            body = {"jsonrpc": "2.0", "id": request_id, "method": "tools/call", "params": {
                "name": "dungeonq_" + operation.replace("-", "_"),
                "arguments": {"requestId": request_id, "args": args}}}
        state["requests"] += 1
        state_path.write_text(json.dumps(state))
        # Default curl client. Never put the bearer in argv, URL, logs or stdout.
        token = config["token"]
        assert isinstance(token, str) and all(c.isalnum() or c in "_-" for c in token)
        curl_config = 'header = "Authorization: Bearer ' + token + '"\n'
        start = time.time()
        timeout = max(0.1, min(12, 300 - (start - state["startedAt"])))
        response = subprocess.run(["curl", "-sS", *transport_args, "--max-time", str(timeout), "-K", "-", "-X", "POST",
            origin + path, "-H", "Content-Type: application/json",
            "-H", "Accept: application/json, text/event-stream", "--data-binary", json.dumps(body),
            "-w", "\n%{http_code}"], input=curl_config, capture_output=True, text=True)
        payload, _, status = response.stdout.rpartition("\n")
        try:
            result = json.loads(payload)
        except ValueError:
            result = {"error": "NON_JSON_RESPONSE", "text": payload[:500]}
        record = {"sequence": state["requests"], "at": start, "family": family,
            "request": body, "status": status, "response": result,
            "elapsedSeconds": round(time.time() - start, 3), "clientExit": response.returncode}
        with (directory / "trajectory.jsonl").open("a") as out:
            out.write(json.dumps(record) + "\n")
        print(json.dumps({"sequence": record["sequence"], "status": status, "response": result}))


if __name__ == "__main__":
    main()
