"""Environment isolation for the worker suite.

`agent.py:40` calls `load_dotenv()` at import. A developer's `voice-agent/.env`
is gitignored, so without this file the suite's verdict depends on a file that is
not in the repository: `.env:17` setting `VOICE_STREAM_TURNS=true` sent four
JSON-path tests in `test_agent_shim.py` down the SSE path, and they failed with
`stream_turn failed: SSE stream ended without a done event` on that machine only.

The fix works because of one property of the installed python-dotenv (1.2.2):

    .venv/Lib/site-packages/dotenv/main.py:387   load_dotenv(..., override=False)
    .venv/Lib/site-packages/dotenv/main.py:105   if k in os.environ and not self.override: continue

`load_dotenv()` does NOT overwrite a key that is already in `os.environ`. So a key
SET here, before `agent` is first imported, survives. Note the direction:
`os.environ.pop(...)` would do the exact opposite of what it looks like — a key
absent from `os.environ` is precisely the one `load_dotenv()` fills in from the
file. Set, never unset.

The values below are `agent.py`'s own fallbacks — what the code uses when the
variable is absent — so the suite runs as if no `.env` existed on any machine.
A test that needs another value sets it explicitly with `monkeypatch.setenv`,
which the per-test fixture below leaves alone (see `test_agent_stream.py`,
which opts the whole file in to SSE).
"""

import os

import pytest

# Every variable `agent.py` reads, mapped to the default in its own
# `os.environ.get(...)` call. Keep in step with agent.py:51-75.
SHIPPED_ENV = {
    # agent.py:51-53 — brain delegation, read at import
    "NODE_BRAIN_URL": "http://localhost:3000",
    "VOICE_INTERNAL_SECRET": "",
    "VOICE_TURN_TIMEOUT_S": "10",
    # agent.py:56-57 — dev call context, read at import
    "VOICE_DEV_CALLER_NUMBER": "",
    "VOICE_TENANT_ID": "",
    # agent.py:62,67 — read per call, so a test can flip them
    "VOICE_STREAM_TURNS": "false",
    "VOICE_TURN_MAX_S": "60",
    # agent.py:72-75 — Sarvam models and the apology fallback language
    "SARVAM_STT_MODEL": "saaras:v3",
    "SARVAM_TTS_MODEL": "bulbul:v3",
    "SARVAM_TTS_SPEAKER": "shubh",
    "VOICE_DEFAULT_LANGUAGE": "te-IN",
}

# At conftest import — before pytest imports the test modules, and therefore
# before any of them imports `agent` and runs its `load_dotenv()`. The
# import-time constants at agent.py:51-57 and :72-75 are frozen at that moment;
# for those, this assignment is the only chance to get it right.
for _key, _value in SHIPPED_ENV.items():
    os.environ[_key] = _value


@pytest.fixture(autouse=True)
def shipped_env(monkeypatch):
    """Re-assert the shipped values before every test.

    The loop above runs once per session. This restores the same values per test,
    so a test that writes `os.environ` directly cannot leak into the next one.
    It cannot defeat an opt-in: this fixture lives in a conftest, so it is set up
    before a test module's own autouse fixture, and the module's `setenv` wins.
    Only the call-time reads (`VOICE_STREAM_TURNS`, `VOICE_TURN_MAX_S`) can be
    changed this late — the rest are already frozen into module constants.
    """
    for key, value in SHIPPED_ENV.items():
        monkeypatch.setenv(key, value)
