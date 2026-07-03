"""Unit tests for latest_user_text (pure; fake ChatContext, no LiveKit)."""

from turn_context import latest_user_text


class _Msg:
    def __init__(self, role, content=None, text_content=None):
        self.role = role
        if content is not None:
            self.content = content
        if text_content is not None:
            self.text_content = text_content


class _Ctx:
    def __init__(self, items):
        self.items = items


def test_prefers_last_user_message():
    ctx = _Ctx([_Msg("user", "first"), _Msg("assistant", "reply"), _Msg("user", "second")])
    assert latest_user_text(ctx) == "second"


def test_text_content_property():
    ctx = _Ctx([_Msg("user", text_content="hi there")])
    assert latest_user_text(ctx) == "hi there"


def test_text_content_callable():
    class CallableMsg:
        role = "user"

        def text_content(self):
            return "called out"

    assert latest_user_text(_Ctx([CallableMsg()])) == "called out"


def test_list_content_joined():
    ctx = _Ctx([_Msg("user", content=["part one", "part two"])])
    assert latest_user_text(ctx) == "part one part two"


def test_empty_when_no_user_turn():
    assert latest_user_text(_Ctx([_Msg("assistant", "only assistant")])) == ""


def test_messages_fallback_attribute():
    class MsgsCtx:
        def __init__(self, messages):
            self.messages = messages

    assert latest_user_text(MsgsCtx([_Msg("user", "via messages")])) == "via messages"
