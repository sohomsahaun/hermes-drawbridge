"""Drive the real plugin through its tool handler and a separately loaded API module."""

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import sys
from threading import Lock

source, fixture = map(Path, sys.argv[1:])
sys.path.insert(0, str(source))
from hermes_constants import set_hermes_home_override

package = Path(__file__).resolve().parents[1]


def load(name, path, **kwargs):
    spec = importlib.util.spec_from_file_location(name, path, **kwargs)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


plugin = load("drawbridge_fixture", package / "__init__.py",
              submodule_search_locations=[str(package)])
api = load("dashboard_drawbridge_fixture", package / "dashboard/plugin_api.py")


class Context:
    hooks = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def register_tool(self, **spec):
        self.handler = spec["handler"]
        assert spec["name"] == "drawbridge_folder"


ctx = Context()
plugin.register(ctx)
output_lock = Lock()


def dispatch(frame):
    assert frame["profile"] in ("primary", "other")
    set_hermes_home_override(fixture / frame["profile"])
    if frame["kind"] == "tool":
        op = frame["body"].get("op") if isinstance(frame["body"], dict) else None
        if isinstance(op, str) and op in api.PROPOSAL_PERMISSIONS:
            return api.run_tool(frame["body"], session_id=frame.get("sessionId"))
        return json.loads(ctx.handler(frame["body"], task_id="test", session_id=frame.get("sessionId")))
    if frame["kind"] == "approvalHook":
        body = frame["body"]
        return ctx.hooks[body["hook"]](**body["params"], session_id=frame.get("sessionId"))
    if frame["kind"] == "nativeTool":
        return json.loads(ctx.handler(frame["body"], session_id=frame.get("sessionId")))
    if frame["kind"] == "heartbeatMs":
        return api.HEARTBEAT_SECONDS * 1000
    if frame["kind"] == "expire":
        with api.transaction() as (db, now):
            db.execute("UPDATE share SET grant_expires = ? WHERE session_id = ?", (now - 1, frame["sessionId"]))
        return {"ok": True}
    if frame["kind"] == "expireApply":
        with api.transaction() as (db, now):
            db.execute("UPDATE proposal SET apply_deadline = ? WHERE id = ?", (now - 1, frame["body"]["proposalId"]))
        return {"ok": True}
    return api.desktop_request(frame["body"])


def reply(frame):
    try:
        result = {"result": dispatch(frame)}
    except Exception as exc:
        result = {"exception": repr(exc)}
    with output_lock:
        print(json.dumps({"id": frame["id"], **result}), flush=True)


with ThreadPoolExecutor(max_workers=4) as pool:
    for line in sys.stdin:
        pool.submit(reply, json.loads(line))
