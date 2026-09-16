#!/usr/bin/env python3
"""Render a Claude Code session transcript (JSONL) as Markdown.

Runs as a Stop hook: reads the hook payload on stdin, finds the session's
transcript file, and rewrites .claude/transcript-code.md from scratch.

Usage:
  echo '{"transcript_path": "...jsonl"}' | sync-transcript.py
  sync-transcript.py path/to/session.jsonl [output.md]

Rendering rules (verbatim content, only the framing is ours):
  * every message on the conversation's final path, in order: user turns,
    Claude's text, tool calls (input as JSON), tool results (as Claude saw
    them), mid-turn user messages, and the context Claude Code injects
    (CLAUDE.md, skills, reminders), the last three collapsed in <details>;
  * messages that were rewound or abandoned (not on the final path) go in
    an appendix so nothing is lost;
  * thinking is included where the session file kept its text (some blocks
    are stored empty); per-request token counters and hook-summary rows are
    skipped because they carry no conversation content.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

SKIP_ATTACHMENTS = {"total_tokens_reminder"}  # mechanical, one per request


def read_rows(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def ts(row):
    t = row.get("timestamp")
    if not t:
        return ""
    try:
        d = datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone()
        return d.strftime("%Y-%m-%d %H:%M:%S %Z")
    except ValueError:
        return t


def fence(text, lang=""):
    """Fenced block whose fence is longer than any backtick run inside."""
    text = text if text.endswith("\n") else text + "\n"
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    f = "`" * max(3, longest + 1)
    return f"{f}{lang}\n{text}{f}\n"


def details(summary, body):
    return f"<details>\n<summary>{summary}</summary>\n\n{body}\n</details>\n"


def block_text(content):
    """Flatten a tool_result / text content value to a string."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    for b in content:
        if not isinstance(b, dict):
            parts.append(str(b))
        elif b.get("type") == "text":
            parts.append(b.get("text", ""))
        elif b.get("type") == "image":
            parts.append("[image]")
        else:
            parts.append(json.dumps(b, indent=2, ensure_ascii=False))
    return "\n".join(parts)


def user_label(row, text):
    if text.startswith("[Request interrupted by user]"):
        return "User (interrupt)"
    if "<task-notification>" in text:
        return "Claude Code: background task notification"
    if row.get("origin") or row.get("promptSource") or row.get("permissionMode"):
        return "User"
    return "Claude Code: injected message"


def render_user(row, out, tool_names):
    msg = row.get("message", {})
    content = msg.get("content")
    if isinstance(content, list) and content and content[0].get("type") == "tool_result":
        for b in content:
            if b.get("type") != "tool_result":
                continue
            name = tool_names.get(b.get("tool_use_id"), "tool")
            status = "error" if b.get("is_error") else "ok"
            body = block_text(b.get("content"))
            out.append(details(f"Result: {name} ({status}, {ts(row)})", fence(body)))
        return
    text = content if isinstance(content, str) else block_text(content)
    label = user_label(row, text)
    if label.startswith("Claude Code:"):
        out.append(details(f"{label} ({ts(row)})", fence(text)))
        return
    out.append(f"## {label} · {ts(row)}\n\n{text.rstrip()}\n\n")


def render_assistant_group(rows, out, tool_names):
    first = rows[0]
    out.append(f"## Claude · {ts(first)}\n\n")
    for row in rows:
        for b in row.get("message", {}).get("content", []):
            kind = b.get("type")
            if kind == "text":
                out.append(b.get("text", "").rstrip() + "\n\n")
            elif kind == "tool_use":
                tool_names[b.get("id")] = b.get("name", "tool")
                desc = ""
                inp = b.get("input", {})
                if isinstance(inp, dict) and isinstance(inp.get("description"), str):
                    desc = " — " + inp["description"]
                body = fence(json.dumps(inp, indent=2, ensure_ascii=False), "json")
                out.append(details(f"Tool call: {b.get('name')}{desc}", body))
            elif kind == "thinking":
                t = b.get("thinking", "")
                if t:
                    out.append(details("Thinking", t.rstrip() + "\n"))
            else:
                out.append(details(f"{kind} block", fence(json.dumps(b, indent=2, ensure_ascii=False), "json")))


def render_attachment(row, out):
    att = row.get("attachment", {})
    kind = att.get("type", "attachment")
    if kind in SKIP_ATTACHMENTS:
        return
    if kind == "queued_command":
        prompt = att.get("prompt", "")
        out.append(f"## User (sent mid-turn) · {ts(row)}\n\n{prompt.rstrip()}\n\n")
        return
    rendered = row.get("rendered")
    if not rendered:
        return
    body = "\n".join(
        (r.get("content", "") if isinstance(r, dict) else str(r)) for r in rendered
    )
    if not body.strip():
        return
    out.append(details(f"Context injected by Claude Code: {kind} ({ts(row)})", fence(body)))


def select_rows(rows):
    """Split rows into (kept, abandoned), both in file order.

    Kept = the chain of ancestors of the newest message (the conversation's
    final path), plus tool results answering calls on that path (parallel
    calls leave every result but the last off the ancestor chain), plus
    attachments hanging off kept rows. Everything else is a rewound or
    abandoned branch.
    """
    by_uuid = {r["uuid"]: r for r in rows if r.get("uuid")}
    convo = [r for r in rows if r.get("type") in ("user", "assistant", "system") and r.get("uuid")]
    if not convo:
        return [], []
    children = set(r.get("parentUuid") for r in convo)
    leaves = [r for r in convo if r["uuid"] not in children]
    leaf = max(leaves, key=lambda r: r.get("timestamp") or "") if leaves else convo[-1]
    kept = set()
    cur = leaf
    while cur is not None and cur["uuid"] not in kept:
        kept.add(cur["uuid"])
        cur = by_uuid.get(cur.get("parentUuid"))
    # parallel tool calls: sibling assistant rows of one API response share a
    # message id but fan out from the same parent, so only one is an ancestor
    kept_msg_ids = {
        r.get("message", {}).get("id") or r.get("requestId")
        for r in rows if r.get("uuid") in kept and r.get("type") == "assistant"
    }
    for r in rows:
        if r.get("type") == "assistant" and r.get("uuid") and (
            r.get("message", {}).get("id") or r.get("requestId")
        ) in kept_msg_ids:
            kept.add(r["uuid"])
    on_path_calls = set()
    for r in rows:
        if r.get("uuid") in kept and r.get("type") == "assistant":
            for b in r.get("message", {}).get("content", []):
                if b.get("type") == "tool_use":
                    on_path_calls.add(b.get("id"))
    for r in convo:
        if r["uuid"] in kept or r.get("type") != "user":
            continue
        content = r.get("message", {}).get("content")
        if isinstance(content, list) and any(
            b.get("type") == "tool_result" and b.get("tool_use_id") in on_path_calls for b in content
        ):
            kept.add(r["uuid"])
    for r in rows:
        if r.get("type") == "attachment" and r.get("uuid") and r.get("parentUuid") in kept:
            kept.add(r["uuid"])
    keep, drop = [], []
    for r in rows:
        if r.get("type") not in ("user", "assistant", "system", "attachment") or not r.get("uuid"):
            continue
        (keep if r["uuid"] in kept else drop).append(r)
    return keep, drop


def render(rows, out, tool_names):
    group = []
    group_id = None

    def flush():
        nonlocal group, group_id
        if group:
            render_assistant_group(group, out, tool_names)
        group, group_id = [], None

    for row in rows:
        kind = row.get("type")
        if kind == "assistant":
            mid = row.get("message", {}).get("id") or row.get("requestId")
            if group and mid != group_id:
                flush()
            group.append(row)
            group_id = mid
            continue
        flush()
        if kind == "user":
            render_user(row, out, tool_names)
        elif kind == "attachment":
            render_attachment(row, out)
        # 'system' rows (hook summaries) carry no conversation content
    flush()


def main():
    payload = {}
    if not sys.stdin.isatty():
        raw = sys.stdin.read()
        if raw.strip():
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {}
    transcript = sys.argv[1] if len(sys.argv) > 1 else payload.get("transcript_path")
    project = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()
    if not transcript:
        pdir = os.path.expanduser("~/.claude/projects/" + re.sub(r"[^A-Za-z0-9]", "-", os.path.abspath(project)))
        cands = [os.path.join(pdir, f) for f in os.listdir(pdir)] if os.path.isdir(pdir) else []
        cands = [c for c in cands if c.endswith(".jsonl")]
        if not cands:
            sys.exit(0)
        transcript = max(cands, key=os.path.getmtime)
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(project, ".claude", "transcript-code.md")
    if not os.path.isfile(transcript):
        sys.exit(0)

    rows = read_rows(transcript)
    ordered, abandoned = select_rows(rows)
    path = [r for r in ordered if r.get("type") in ("user", "assistant")]

    session_ids = sorted({r.get("sessionId") for r in rows if r.get("sessionId")})
    titles = [r.get("customTitle") for r in rows if r.get("type") == "custom-title"]
    title = titles[-1] if titles else "Claude Code session"
    first = next((r for r in path if r.get("timestamp")), None)
    last = next((r for r in reversed(path) if r.get("timestamp")), None)

    out = []
    out.append(f"# Transcript: {title}\n\n")
    out.append(
        "Verbatim record of the Claude Code conversation for this project, regenerated by "
        "`.claude/hooks/sync-transcript.py` (a Stop hook in `.claude/settings.json`) every time "
        "Claude finishes a turn.\n\n"
    )
    out.append(f"- Session file: `{transcript}`\n")
    out.append(f"- Session ids: {', '.join(session_ids)}\n")
    if first and last:
        out.append(f"- Span: {ts(first)} to {ts(last)}\n")
    out.append(f"- Generated: {datetime.now(timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}\n")
    out.append(
        "- Collapsed: thinking, tool calls, tool results, and everything Claude Code injects "
        "(CLAUDE.md, skill bodies, reminders, background-task notifications). Thinking appears only where "
        "the session file kept its text; some blocks are stored empty. Skipped as content-free: "
        "per-request token counters and hook-summary rows.\n\n---\n\n"
    )
    tool_names = {}
    render(ordered, out, tool_names)
    if abandoned:
        out.append("\n---\n\n# Appendix: messages not on the final conversation path\n\n")
        out.append("Rewound or abandoned messages, in file order.\n\n")
        render(abandoned, out, tool_names)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("".join(out))
    os.replace(tmp, out_path)


if __name__ == "__main__":
    main()
