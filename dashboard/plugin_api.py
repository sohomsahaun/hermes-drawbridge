"""Private broker shared by the Hermes tool and the authenticated Desktop routes."""

from contextlib import contextmanager
import hashlib
import json
import logging
import re
import secrets
import sqlite3
import time

from fastapi import APIRouter
from hermes_cli.config import load_config_readonly
from plugins.plugin_storage import plugin_data_dir

router = APIRouter()
logger = logging.getLogger(__name__)
PLUGIN_ID = "hermes-drawbridge"
RESULT_LIMIT = 384 * 1024
REVIEW_DISPLAY_LIMIT = 144 * 1024
HEARTBEAT_SECONDS = 8
MAX_DURATION_SECONDS = 86400
REQUEST_SECONDS = 20
MAX_GRANTS = 16
# Negotiate KiB limits at share start. Older grants without stored limits use the previous fixed caps.
LIMIT_SETTINGS = {
    "readLimitKiB": ("max_read_kib", 96),
    "reviewedWriteLimitKiB": ("max_reviewed_write_kib", 64),
    "sessionWriteLimitKiB": ("max_session_write_kib", 128),
}
LEGACY_LIMITS = {"readLimitKiB": 96, "reviewedWriteLimitKiB": 64, "sessionWriteLimitKiB": 64}
MAX_PROPOSALS = 128
MAX_PROPOSALS_PER_CHAT = 16
MAX_ACCESS_REQUESTS = 32
ACCESS_SECONDS = 120
APPLY_SECONDS = 30
RECEIPT_SECONDS = 300
TOKEN = re.compile(r"[0-9a-f]{64}")
REQUEST_ID = re.compile(r"[0-9a-f]{32}")
SESSION_ID = re.compile(r"[!-~]{1,128}")
INVALID_PATH_CHARS = re.compile(r'[\\:<>"|?*\x00-\x1f\x7f]')
WINDOWS_DEVICE = re.compile(r"(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])", re.IGNORECASE)
ACTION_FIELDS = {
    "start": {"action", "token", "sessionId", "durationSeconds"},
    "stop": {"action", "token"},
    "poll": {"action", "token"},
    "finish": {"action", "token", "id", "result"},
    "begin_apply": {"action", "token", "id"},
    "settle": {"action", "token", "id", "status"},
}
TOOL_FIELDS = {
    "list_folders": {"op"},
    "list": {"op", "path"},
    "read": {"op", "path"},
    "propose_update": {"op", "path", "baseVersion", "text"},
    "propose_create": {"op", "path", "text"},
    "status": {"op", "proposalId"},
    "request_access": {"op", "permissions", "durationSeconds"},
}
PROPOSAL_PERMISSIONS = {"propose_update": "update", "propose_create": "create"}
FOLDER_OPERATIONS = {"list", "read", *PROPOSAL_PERMISSIONS}
OUTCOMES = ("applied", "conflict", "failed", "uncertain", "rejected")


def failure(error):
    return {"ok": False, "error": error}


def grant_limits(requested):
    settings = load_config_readonly().get("plugins", {}).get("entries", {}).get(PLUGIN_ID, {}).get("settings", {})
    if not isinstance(settings, dict):
        return None
    limits = {}
    for key, (setting, ceiling) in LIMIT_SETTINGS.items():
        configured = settings.get(setting, ceiling)
        if type(configured) is not int or configured < 1:
            return None
        limits[key] = min(requested[key], configured, ceiling)
    return limits


def share_limits(share):
    return json.loads(share["limits"]) if share["limits"] else LEGACY_LIMITS


def session_approved(db, owner):
    return db.execute("SELECT 1 FROM session_approval WHERE owner = ?", (owner,)).fetchone() is not None


def valid_session(session_id):
    return isinstance(session_id, str) and SESSION_ID.fullmatch(session_id) is not None


def valid_folder(value):
    return valid_utf8(value, 256) and bool(value) and value.strip() == value and value.isprintable()


def valid_folder_hint(value):
    return (valid_utf8(value, 4096) and value.isprintable()
            and bool(re.match(r"^(?:[A-Za-z]:[\\/]|[\\/]{2}|/)", value)))


def valid_id(value):
    return isinstance(value, str) and REQUEST_ID.fullmatch(value) is not None


def valid_duration(value):
    return type(value) is int and 0 <= value <= MAX_DURATION_SECONDS


def valid_permissions(value):
    return (isinstance(value, list) and 1 <= len(value) <= 3
            and all(item in ("read", "create", "update") for item in value)
            and "read" in value and len(set(value)) == len(value))


def valid_utf8(value, limit):
    if not isinstance(value, str) or len(value) > limit or "\x00" in value:
        return False
    try:
        return len(value.encode("utf-8")) <= limit
    except UnicodeEncodeError:
        return False


def valid_path(path, op):
    if not isinstance(path, str) or not 1 <= len(path) <= 512 or not valid_utf8(path, 2048):
        return False
    if path == ".":
        return op == "list"
    if INVALID_PATH_CHARS.search(path):
        return False
    return all(
        part and len(part) <= 255 and part == part.strip() and not part.endswith(".")
        and not WINDOWS_DEVICE.fullmatch(part.split(".", 1)[0].rstrip())
        for part in path.split("/")
    )


def create_share_table(db):
    db.execute("""CREATE TABLE IF NOT EXISTS share (
        owner TEXT NOT NULL PRIMARY KEY, session_id TEXT NOT NULL, folder TEXT NOT NULL,
        expires REAL NOT NULL, grant_expires REAL NOT NULL,
        permissions TEXT NOT NULL DEFAULT '["read"]', heartbeat INTEGER NOT NULL DEFAULT 8,
        limits TEXT,
        UNIQUE(session_id, folder)
    )""")


def migrate_share_table(db):
    columns = {column["name"] for column in db.execute("PRAGMA table_info(share)")}
    if not columns or "folder" in columns:
        return
    db.execute("PRAGMA foreign_keys = OFF")
    db.execute("PRAGMA legacy_alter_table = ON")
    db.execute("BEGIN IMMEDIATE")
    columns = {column["name"] for column in db.execute("PRAGMA table_info(share)")}
    if "folder" not in columns:
        db.execute("ALTER TABLE share RENAME TO legacy_share")
        create_share_table(db)
        permissions = "permissions" if "permissions" in columns else """'["read"]'"""
        heartbeat = "heartbeat" if "heartbeat" in columns else "8"
        db.execute(f"""INSERT INTO share (owner, session_id, folder, expires, grant_expires, permissions, heartbeat)
            SELECT owner, session_id, 'Shared folder', expires, grant_expires, {permissions}, {heartbeat}
            FROM legacy_share""")
        db.execute("DROP TABLE legacy_share")
        if db.execute("PRAGMA foreign_key_check").fetchone():
            raise sqlite3.IntegrityError("Drawbridge share migration would break an existing grant")
    db.commit()
    db.execute("PRAGMA legacy_alter_table = OFF")


@contextmanager
def transaction():
    # Use the chat-scoped grant store. The older profile-wide database cannot authorize a chat.
    path = plugin_data_dir(PLUGIN_ID) / "chat-bridge.sqlite3"
    db = sqlite3.connect(path, timeout=1, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA secure_delete = ON")
        migrate_share_table(db)
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("BEGIN IMMEDIATE")
        create_share_table(db)
        if not any(column["name"] == "limits" for column in db.execute("PRAGMA table_info(share)")):
            db.execute("ALTER TABLE share ADD COLUMN limits TEXT")
        db.execute("""CREATE TABLE IF NOT EXISTS work (
            owner TEXT NOT NULL PRIMARY KEY REFERENCES share(owner) ON DELETE CASCADE,
            id TEXT NOT NULL UNIQUE,
            op TEXT NOT NULL, payload TEXT, expires REAL NOT NULL,
            claimed INTEGER NOT NULL DEFAULT 0, result TEXT
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS proposal (
            id TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL,
            status TEXT NOT NULL, expires REAL NOT NULL, apply_deadline REAL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS access_request (
            session_id TEXT NOT NULL PRIMARY KEY, id TEXT NOT NULL UNIQUE,
            permissions TEXT NOT NULL, duration INTEGER NOT NULL, expires REAL NOT NULL
        )""")
        if not any(column["name"] == "folder_hint" for column in db.execute("PRAGMA table_info(access_request)")):
            db.execute("ALTER TABLE access_request ADD COLUMN folder_hint TEXT")
        db.execute("""CREATE TABLE IF NOT EXISTS native_review (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
            call_id TEXT NOT NULL, args_hash TEXT NOT NULL, display_hash TEXT,
            decision TEXT, dispatched INTEGER NOT NULL DEFAULT 0, expires REAL NOT NULL,
            UNIQUE(session_id, turn_id, call_id)
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS session_approval (
            owner TEXT PRIMARY KEY REFERENCES share(owner) ON DELETE CASCADE
        )""")
        now = time.time()
        db.execute("""UPDATE proposal SET status = 'expired', expires = (
                SELECT MIN(expires, grant_expires) + ? FROM share WHERE owner = proposal.owner
            ) WHERE status = 'pending' AND owner IN (
                SELECT owner FROM share WHERE expires <= ? OR grant_expires <= ?
            )""", (RECEIPT_SECONDS, now, now))
        db.execute("""UPDATE proposal SET status = 'uncertain', expires = apply_deadline + ?
            WHERE status = 'applying' AND apply_deadline <= ?""", (RECEIPT_SECONDS, now))
        db.execute("DELETE FROM share WHERE expires <= ? OR grant_expires <= ?", (now, now))
        db.execute("DELETE FROM work WHERE expires < ?", (now - 5,))
        db.execute("DELETE FROM proposal WHERE expires <= ?", (now,))
        db.execute("DELETE FROM access_request WHERE expires <= ?", (now,))
        db.execute("DELETE FROM native_review WHERE expires <= ?", (now,))
        db.execute("""DELETE FROM native_review WHERE NOT EXISTS (SELECT 1 FROM work WHERE work.id = native_review.id)
            AND NOT EXISTS (SELECT 1 FROM proposal WHERE proposal.id = native_review.id)""")
        yield db, now
        db.commit()
    finally:
        db.close()


def run_tool(args, *, session_id, review_context=None):
    if not isinstance(args, dict):
        return failure("invalid-request")
    op = args.get("op")
    if not isinstance(op, str) or op not in TOOL_FIELDS:
        return failure("invalid-request")
    optional_fields = {"folder"} if op in FOLDER_OPERATIONS else {"folderHint"} if op == "request_access" else set()
    fields = set(args) - optional_fields
    if fields != TOOL_FIELDS[op] or ("folder" in args and not valid_folder(args["folder"])):
        return failure("invalid-request")
    if "path" in args and not valid_path(args["path"], op):
        return failure("invalid-request")
    if op in PROPOSAL_PERMISSIONS and not valid_utf8(args["text"], LIMIT_SETTINGS["sessionWriteLimitKiB"][1] * 1024):
        return failure("invalid-request")
    if op == "propose_update" and (not isinstance(args["baseVersion"], str)
                                   or not TOKEN.fullmatch(args["baseVersion"])):
        return failure("invalid-request")
    if op == "status" and not valid_id(args["proposalId"]):
        return failure("invalid-request")
    if op == "request_access" and (not valid_permissions(args["permissions"])
                                   or not valid_duration(args["durationSeconds"])
                                   or ("folderHint" in args and not valid_folder_hint(args["folderHint"]))):
        return failure("invalid-request")
    if not valid_session(session_id):
        logger.warning("Drawbridge tool call has no valid Hermes session ID")
        return failure("offline")

    request_id = secrets.token_hex(16)
    with transaction() as (db, now):
        if op == "status":
            proposal = db.execute("SELECT status FROM proposal WHERE id = ? AND session_id = ?",
                                  (args["proposalId"], session_id)).fetchone()
            if not proposal:
                return failure("proposal-ended")
            return {"ok": True, "proposalId": args["proposalId"], "status": proposal["status"]}
        if op == "request_access":
            return queue_access_request(db, now, session_id, request_id, args)
        shares = db.execute("""SELECT owner, folder, permissions, grant_expires, limits FROM share
            WHERE session_id = ? ORDER BY folder""", (session_id,)).fetchall()
        folders = [{"folder": row["folder"], "permissions": json.loads(row["permissions"])} for row in shares]
        if op == "list_folders":
            return {"ok": True, "folders": folders}
        if not shares:
            logger.warning(
                "Drawbridge found no grant for session fingerprint %s in %s",
                hashlib.sha256(session_id.encode()).hexdigest()[:12],
                plugin_data_dir(PLUGIN_ID).parent.parent.name,
            )
            return failure("offline")
        if "folder" in args:
            share = next((row for row in shares if row["folder"].casefold() == args["folder"].casefold()), None)
            if not share:
                return {**failure("unknown-folder"), "folders": folders}
        elif len(shares) == 1:
            share = shares[0]
        else:
            return {**failure("folder-required"), "folders": folders}
        owner = share["owner"]
        if op in PROPOSAL_PERMISSIONS and PROPOSAL_PERMISSIONS[op] not in json.loads(share["permissions"]):
            return failure("permission-denied")
        if op in PROPOSAL_PERMISSIONS:
            limit_key = "sessionWriteLimitKiB" if review_context and session_approved(db, owner) else "reviewedWriteLimitKiB"
            if not valid_utf8(args["text"], share_limits(share)[limit_key] * 1024):
                return failure("too-large")
        if db.execute("SELECT 1 FROM work WHERE owner = ?", (owner,)).fetchone():
            return failure("busy")
        if review_context:
            turn_id, call_id = review_context
            if db.execute("""SELECT 1 FROM native_review WHERE session_id = ? AND
                ((turn_id = ? AND call_id = ?) OR (args_hash = ? AND
                  (decision IS NULL OR decision IN ('authorized', 'authorize_session'))))""",
                (session_id, turn_id, call_id, review_hash(args))).fetchone():
                return failure("busy")
            db.execute("""INSERT INTO native_review (id, session_id, turn_id, call_id, args_hash, expires)
                VALUES (?, ?, ?, ?, ?, ?)""",
                (request_id, session_id, turn_id, call_id, review_hash(args), share["grant_expires"] + RECEIPT_SECONDS))
        payload = {key: value for key, value in args.items() if key != "folder"}
        db.execute("""INSERT INTO work (id, owner, op, payload, expires)
            VALUES (?, ?, ?, ?, ?)""", (request_id, owner, op, json.dumps(payload), now + REQUEST_SECONDS))

    deadline = time.monotonic() + REQUEST_SECONDS
    while True:
        with transaction() as (db, now):
            work = db.execute("SELECT * FROM work WHERE id = ?", (request_id,)).fetchone()
            if not work:
                logger.warning("Drawbridge grant or queued work ended before the tool received a result")
                return failure("offline")
            if work["result"] is not None:
                db.execute("DELETE FROM work WHERE id = ?", (request_id,))
                return json.loads(work["result"])
            if now >= work["expires"] or time.monotonic() >= deadline:
                db.execute("DELETE FROM work WHERE id = ?", (request_id,))
                return failure("timeout")
        time.sleep(0.2)


def review_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def register_review_display(proposal_id, display):
    with transaction() as (db, _now):
        approved_share = db.execute("""SELECT 1 FROM proposal p
            JOIN session_approval a ON a.owner = p.owner JOIN share s ON s.owner = p.owner
            WHERE p.id = ? AND p.status = 'pending'""", (proposal_id,)).fetchone()
        if approved_share:
            db.execute("UPDATE native_review SET decision = 'authorized' WHERE id = ? AND decision IS NULL",
                       (proposal_id,))
            return True
        if display is not None:
            db.execute("UPDATE native_review SET display_hash = ? WHERE id = ?", (review_hash(display), proposal_id))
        return False


def record_review(pattern_key, session_id, turn_id, call_id, description, choice):
    prefix = "plugin_rule:drawbridge:"
    if not isinstance(pattern_key, str) or not pattern_key.startswith(prefix):
        return
    proposal_id = pattern_key[len(prefix):]
    if not valid_id(proposal_id):
        return
    with transaction() as (db, now):
        record = db.execute("""SELECT n.display_hash FROM native_review n
            JOIN proposal p ON p.id = n.id JOIN share s ON s.owner = p.owner
            WHERE n.id = ? AND n.session_id = ? AND n.turn_id = ? AND n.call_id = ?
              AND n.decision IS NULL AND p.status = 'pending' AND s.grant_expires > ?""",
            (proposal_id, session_id, turn_id, call_id, now)).fetchone()
        if record and record["display_hash"]:
            decision = "rejected"
            # Hermes reports the gateway's redacted description. Only approve an exact display match.
            if record["display_hash"] == review_hash(description):
                if choice == "once":
                    decision = "authorized"
                elif choice == "session":
                    decision = "authorize_session"
            db.execute("UPDATE native_review SET decision = ? WHERE id = ?", (decision, proposal_id))


def wait_for_review(args, session_id):
    deadline = time.monotonic() + REQUEST_SECONDS
    while True:
        with transaction() as (db, _now):
            row = db.execute("""SELECT p.id, p.owner, p.status, n.decision FROM native_review n
                JOIN proposal p ON p.id = n.id WHERE n.session_id = ? AND n.args_hash = ?
                ORDER BY n.rowid DESC LIMIT 1""", (session_id, review_hash(args))).fetchone()
            if not row or row["decision"] not in ("once", "authorized", "authorize_session"):
                return failure("approval-required")
            if row["status"] not in ("pending", "applying") or time.monotonic() >= deadline:
                return {"ok": row["status"] == "applied", "proposalId": row["id"], "status": row["status"]}
            if row["decision"] in ("authorized", "authorize_session"):
                if row["decision"] == "authorize_session":
                    db.execute("INSERT OR IGNORE INTO session_approval VALUES (?)", (row["owner"],))
                db.execute("UPDATE native_review SET decision = 'once' WHERE id = ?", (row["id"],))
        time.sleep(0.2)


def queue_access_request(db, now, session_id, request_id, args):
    hint = args.get("folderHint")
    existing = db.execute("SELECT * FROM access_request WHERE session_id = ?", (session_id,)).fetchone()
    if existing:
        if (set(json.loads(existing["permissions"])) == set(args["permissions"])
                and existing["duration"] == args["durationSeconds"] and existing["folder_hint"] == hint):
            return {"ok": True, "requestId": existing["id"]}
        return failure("busy")
    if db.execute("SELECT COUNT(*) FROM access_request").fetchone()[0] >= MAX_ACCESS_REQUESTS:
        return failure("busy")
    db.execute("""INSERT INTO access_request (session_id, id, permissions, duration, expires, folder_hint)
        VALUES (?, ?, ?, ?, ?, ?)""",
               (session_id, request_id, json.dumps(args["permissions"]),
                args["durationSeconds"], now + ACCESS_SECONDS, hint))
    return {"ok": True, "requestId": request_id}


def start_share(db, now, owner, body):
    session_id = body["sessionId"]
    duration = body["durationSeconds"]
    permissions = body.get("permissions", ["read"])
    request_id = body.get("requestId")
    heartbeat = body.get("heartbeatSeconds", HEARTBEAT_SECONDS)
    folder = body.get("folder", "Shared folder")
    requested_limits = body.get("limits", LEGACY_LIMITS)
    if (not valid_session(session_id) or not valid_duration(duration)
            or not valid_folder(folder)
            or type(heartbeat) is not int or not 5 <= heartbeat <= 120
            or not valid_permissions(permissions) or ("requestId" in body and not valid_id(request_id))):
        return failure("invalid-request")
    if (not isinstance(requested_limits, dict) or requested_limits.keys() != LIMIT_SETTINGS.keys()
            or any(type(value) is not int or value < 1 for value in requested_limits.values())):
        return failure("invalid-request")
    limits = grant_limits(requested_limits)
    if limits is None:
        return failure("invalid-size-settings")
    if db.execute("SELECT 1 FROM share WHERE owner = ?", (owner,)).fetchone() or db.execute(
            "SELECT 1 FROM proposal WHERE owner = ?", (owner,)).fetchone():
        return failure("already-sharing")
    pending = db.execute("SELECT * FROM access_request WHERE session_id = ? AND id = ?",
                         (session_id, request_id)).fetchone() if request_id else None
    if request_id and not pending:
        return failure("request-ended")
    existing = db.execute("SELECT * FROM share WHERE session_id = ?", (session_id,)).fetchone()
    if "replaceToken" in body:
        previous_token = body["replaceToken"]
        if (not isinstance(previous_token, str) or not TOKEN.fullmatch(previous_token)
                or not pending or not pending["folder_hint"] or pending["duration"] != duration
                or set(json.loads(pending["permissions"])) != set(permissions) or len(permissions) <= 1):
            return failure("invalid-request")
        previous_owner = hashlib.sha256(previous_token.encode("ascii")).hexdigest()
        if (not existing or existing["owner"] != previous_owner or existing["folder"] != folder
                or json.loads(existing["permissions"]) != ["read"]):
            return failure("share-ended")
        # Replace the read-only grant and consume the request in the same transaction.
        db.execute("DELETE FROM share WHERE owner = ?", (previous_owner,))
    elif existing:
        return failure("already-sharing")
    elif db.execute("SELECT COUNT(*) FROM share").fetchone()[0] >= MAX_GRANTS:
        return failure("busy")
    db.execute("""INSERT INTO share (owner, session_id, folder, expires, grant_expires, permissions, heartbeat, limits)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (owner, session_id, folder, now + heartbeat, now + duration if duration else float("inf"),
         json.dumps(permissions), heartbeat, json.dumps(limits)))
    if request_id:
        db.execute("DELETE FROM access_request WHERE session_id = ?", (session_id,))
    return {"ok": True, "limits": limits}


def change_proposal(db, now, action, owner, proposal_id, status, share):
    proposal = db.execute("SELECT * FROM proposal WHERE id = ? AND owner = ?",
                          (proposal_id, owner)).fetchone()
    if not proposal:
        return failure("proposal-ended")
    previous = proposal["status"]
    if action == "begin_apply":
        if previous != "pending" or not share:
            return failure("invalid-transition")
        native = db.execute("SELECT decision FROM native_review WHERE id = ?", (proposal_id,)).fetchone()
        if native and native["decision"] != "once":
            return failure("approval-required")
        db.execute("""UPDATE proposal SET status = 'applying', apply_deadline = ?, expires = ?
            WHERE id = ?""", (now + APPLY_SECONDS, now + APPLY_SECONDS + RECEIPT_SECONDS, proposal_id))
        return {"ok": True}
    if previous == status:
        return {"ok": True}
    may_settle_write = previous == "applying" or (
        previous == "uncertain" and proposal["apply_deadline"] is not None
    )
    if status == "rejected":
        allowed = previous == "pending"
    else:
        allowed = may_settle_write or (status == "failed" and previous == "pending")
    if not allowed:
        return failure("invalid-transition")
    db.execute("UPDATE proposal SET status = ?, expires = ?, apply_deadline = NULL WHERE id = ?",
               (status, now + RECEIPT_SECONDS, proposal_id))
    return {"ok": True}


def finish_work(db, now, owner, share, request_id, result):
    if not isinstance(result, dict):
        return failure("invalid-request")
    encoded = json.dumps(result)
    work = db.execute("""SELECT op FROM work WHERE id = ? AND owner = ?
        AND claimed = 1 AND result IS NULL AND expires > ?""", (request_id, owner, now)).fetchone()
    if not work:
        return failure("request-ended")
    op = work["op"]
    too_large = len(encoded) > RESULT_LIMIT
    if op in PROPOSAL_PERMISSIONS:
        if PROPOSAL_PERMISSIONS[op] not in json.loads(share["permissions"]):
            return failure("permission-denied")
        pending = {"ok": True, "proposalId": request_id, "status": "pending"}
        native = db.execute("SELECT 1 FROM native_review WHERE id = ?", (request_id,)).fetchone()
        display = result.get("display")
        needs_display = native and ("display" in result or not session_approved(db, owner))
        if needs_display and result.get("ok") is True:
            if not isinstance(display, str):
                return failure("invalid-request")
            too_large = too_large or not valid_utf8(display, REVIEW_DISPLAY_LIMIT)
        expected = {**pending, "display": display} if needs_display else pending
        if result.get("ok") is True and result == expected:
            if too_large:
                db.execute("UPDATE work SET result = ? WHERE id = ?",
                           (json.dumps(failure("result-too-large")), request_id))
                return {"ok": True, "resultError": "result-too-large"}
            if (db.execute("SELECT COUNT(*) FROM proposal").fetchone()[0] >= MAX_PROPOSALS
                    or db.execute("SELECT COUNT(*) FROM proposal WHERE session_id = ?",
                                  (share["session_id"],)).fetchone()[0] >= MAX_PROPOSALS_PER_CHAT):
                db.execute("UPDATE work SET result = ? WHERE id = ?", (json.dumps(failure("busy")), request_id))
                return failure("busy")
            db.execute("""INSERT INTO proposal (id, owner, session_id, status, expires)
                VALUES (?, ?, ?, 'pending', ?)""", (request_id, owner, share["session_id"], share["grant_expires"]))
        elif (result.get("ok") is not False or set(result) != {"ok", "error"}
                or not valid_utf8(result["error"], 128)):
            return failure("request-ended")
    elif op not in ("list", "read"):
        return failure("request-ended")
    elif op == "read" and result.get("ok") is True:
        too_large = too_large or not valid_utf8(result.get("text"), share_limits(share)["readLimitKiB"] * 1024)
    if too_large:
        db.execute("UPDATE work SET result = ? WHERE id = ?", (json.dumps(failure("result-too-large")), request_id))
        return {"ok": True, "resultError": "result-too-large"}
    db.execute("UPDATE work SET result = ? WHERE id = ?", (encoded, request_id))
    return {"ok": True}


@router.post("/chat-bridge")
def desktop_request(body: dict):
    """Hermes authenticates this REST route. The Desktop key owns one chat grant."""
    if not isinstance(body, dict):
        return failure("invalid-request")
    token = body.get("token")
    action = body.get("action")
    if action in ("access_request", "reject_access"):
        fields = {"action", "sessionId"} if action == "access_request" else {"action", "sessionId", "id"}
        if set(body) != fields or not valid_session(body["sessionId"]) or ("id" in body and not valid_id(body["id"])):
            return failure("invalid-request")
        with transaction() as (db, now):
            if action == "reject_access":
                deleted = db.execute("DELETE FROM access_request WHERE session_id = ? AND id = ?",
                                     (body["sessionId"], body["id"])).rowcount
                return {"ok": True} if deleted else failure("request-ended")
            request = db.execute("SELECT * FROM access_request WHERE session_id = ?", (body["sessionId"],)).fetchone()
            return {"ok": True, "request": None if not request else {
                "id": request["id"], "permissions": json.loads(request["permissions"]),
                "durationSeconds": request["duration"],
                "folderHint": request["folder_hint"],
            }}
    fields = set(body) - {"permissions", "requestId", "heartbeatSeconds", "folder", "limits", "replaceToken"} if action == "start" else set(body)
    if (not isinstance(action, str) or fields != ACTION_FIELDS.get(action)
            or not isinstance(token, str) or not TOKEN.fullmatch(token)):
        return failure("invalid-request")
    if ("id" in body and not valid_id(body["id"])) or (action == "settle" and body["status"] not in OUTCOMES):
        return failure("invalid-request")
    owner = hashlib.sha256(token.encode("ascii")).hexdigest()

    with transaction() as (db, now):
        if action == "start":
            return start_share(db, now, owner, body)

        share = db.execute("SELECT * FROM share WHERE owner = ?", (owner,)).fetchone()
        if action in ("begin_apply", "settle"):
            return change_proposal(db, now, action, owner, body["id"], body.get("status"), share)
        if not share:
            return failure("share-ended")
        if action == "stop":
            # Cascading deletion also discards claimed work and unreturned results.
            db.execute("""UPDATE proposal SET status = 'revoked', expires = ?
                WHERE owner = ? AND status = 'pending'""", (now + RECEIPT_SECONDS, owner))
            db.execute("DELETE FROM share WHERE owner = ?", (owner,))
            return {"ok": True}
        if action == "poll":
            db.execute("UPDATE share SET expires = ? WHERE owner = ?",
                       (now + share["heartbeat"], owner))
            review = db.execute("""SELECT n.id, n.decision FROM native_review n
                JOIN proposal p ON p.id = n.id WHERE p.owner = ? AND p.status = 'pending'
                AND n.dispatched = 0 AND n.decision IN ('once', 'rejected') ORDER BY n.rowid LIMIT 1""", (owner,)).fetchone()
            if review:
                db.execute("UPDATE native_review SET dispatched = 1 WHERE id = ?", (review["id"],))
                return {"ok": True, "approval": dict(review)}
            work = db.execute("""SELECT * FROM work WHERE owner = ? AND claimed = 0
                AND op IN ('list', 'read', 'propose_create', 'propose_update')
                AND result IS NULL AND expires > ?""",
                (owner, now + 1)).fetchone()
            if not work:
                return {"ok": True, "job": None}
            db.execute("UPDATE work SET claimed = 1, payload = NULL WHERE id = ?", (work["id"],))
            native_review = db.execute("SELECT 1 FROM native_review WHERE id = ?", (work["id"],)).fetchone() is not None
            return {"ok": True, "job": {
                "id": work["id"],
                "sessionId": share["session_id"],
                "ttlMs": int((min(work["expires"], share["grant_expires"]) - now) * 1000),
                "args": json.loads(work["payload"]),
                "nativeReview": native_review,
                "sessionApproved": native_review and session_approved(db, owner),
            }}
        return finish_work(db, now, owner, share, body["id"], body["result"])
