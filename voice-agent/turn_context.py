"""Pure turn-context extraction (no LiveKit import) — unit-testable in isolation.

The worker forwards ONLY the latest user-turn text to the brain; conversation
history/context is owned by Node (the single context-assembly path) and never
re-derived here. This lives in its own livekit-free module so the extraction is
testable with a fake ChatContext without importing livekit-agents.
"""

from __future__ import annotations


def latest_user_text(chat_ctx) -> str:
    """Return the most recent user-turn text from a LiveKit ChatContext.

    Defensive across SDK minor versions (items vs messages; text_content property
    or method vs a str/list `content`).
    """
    items = getattr(chat_ctx, "items", None)
    if items is None:
        items = getattr(chat_ctx, "messages", []) or []
    for item in reversed(list(items)):
        if getattr(item, "role", None) != "user":
            continue
        txt = getattr(item, "text_content", None)
        if callable(txt):
            txt = txt()
        if txt:
            return str(txt).strip()
        content = getattr(item, "content", None)
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, (list, tuple)):
            parts = [c for c in content if isinstance(c, str)]
            if parts:
                return " ".join(parts).strip()
    return ""
