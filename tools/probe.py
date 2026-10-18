#!/usr/bin/env python3
"""真实模式充分测试探针：驱动多场景并记录结果。

只用标准库。用法：
  python3 tools/probe.py --base http://127.0.0.1:4320 --scenario all
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:4320"


def req(method, path, body=None, timeout=30):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    request = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            payload = json.loads(raw) if raw else None
        except Exception:
            payload = raw.decode(errors="replace")[:300]
        return err.code, payload
    except Exception as err:  # noqa: BLE001
        return 0, {"error": str(err)}


def state():
    return req("GET", "/api/state")[1]


def wait_until(predicate, timeout=120, interval=2, label=""):
    started = time.time()
    last = None
    while time.time() - started < timeout:
        s = state()
        if s:
            last = s
            if predicate(s):
                return True, s, time.time() - started
        time.sleep(interval)
    return False, last, time.time() - started


def names(s):
    return {c["id"]: c["name"] for c in s.get("cats", [])}


def text_of(m):
    return (m.get("text") or "").replace("\n", " ")


def approve_all(label=""):
    """批准所有 pending 审批，返回批准数量。"""
    _, payload = req("GET", "/api/approvals")
    pending = (payload or {}).get("pending", [])
    count = 0
    for item in pending:
        code, _ = req("POST", f"/api/tool-calls/{item['callId']}/approve")
        if code == 200:
            count += 1
    return count


def reject_all():
    _, payload = req("GET", "/api/approvals")
    pending = (payload or {}).get("pending", [])
    count = 0
    for item in pending:
        code, _ = req("POST", f"/api/tool-calls/{item['callId']}/reject")
        if code == 200:
            count += 1
    return count


def run_task(brief, room="room_cafe", scenario=None, timeout=180, auto_approve=True,
             auto_nudge=True, auto_reject=False):
    body = {"roomId": room, "brief": brief}
    if scenario:
        body["scenarioId"] = scenario
    code, task = req("POST", "/api/tasks", body)
    assert code == 201, f"create task failed: {code} {task}"
    task_id = task["id"]
    started = time.time()
    approved = rejected = nudges = 0
    while time.time() - started < timeout:
        s = state()
        t = next((x for x in s.get("tasks", []) if x["id"] == task_id), None)
        if t is None:
            return {"id": task_id, "error": "task disappeared"}
        if auto_approve:
            approved += approve_all()
        if auto_reject:
            rejected += reject_all()
        if auto_nudge and t["status"] == "stalled":
            req("POST", f"/api/tasks/{task_id}/nudge")
            nudges += 1
        if t["status"] == "done":
            return {"id": task_id, "status": "done", "stage": t["stage"],
                    "elapsed": round(time.time() - started, 1), "approved": approved,
                    "rejected": rejected, "nudges": nudges, "state": s}
        time.sleep(2)
    s = state()
    t = next((x for x in s.get("tasks", []) if x["id"] == task_id), None)
    return {"id": task_id, "status": "timeout", "stage": t["stage"] if t else None,
            "elapsed": round(time.time() - started, 1), "approved": approved,
            "rejected": rejected, "nudges": nudges, "state": s}


def summarize(s, task_id):
    out = {"toolCalls": [], "messages": 0, "artifacts": 0, "handoffs": 0, "memory": 0}
    calls = [c for c in s.get("toolCalls", []) if c.get("taskId") == task_id]
    out["toolCalls"] = [f"{c['tool']}:{c['status']}" for c in calls]
    out["messages"] = len([m for m in s.get("messages", []) if m.get("taskId") == task_id])
    out["artifacts"] = len([a for a in s.get("artifacts", []) if a.get("taskId") == task_id])
    out["handoffs"] = len([h for h in s.get("handoffs", []) if h.get("taskId") == task_id])
    out["memory"] = len(s.get("memory", []))
    return out
