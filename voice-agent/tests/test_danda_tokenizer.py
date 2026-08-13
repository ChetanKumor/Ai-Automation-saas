"""The sentence tokenizer that terminates on the Devanagari danda (Issue 41).

Three things are pinned here, and the first two ARE the byte-unchanged claim for
Telugu and English — nothing weaker substitutes for them:

  * LOSSLESS  — over a 234-input corpus, every non-whitespace character of the
                input survives into the tokens, in order, and none is invented.
  * IDENTICAL — over the 139 danda-free inputs of that corpus, output is `==` to
                `_basic_sent.split_sentences`, tuples and offsets included.
  * BOUNDARY  — a pure-danda Hindi reply releases its first segment AT the first
                danda, not at flush, and the segment text is asserted, not just
                its existence.

The corpus is the one the mechanism was chosen on. Offset-slicing — recovering
each token by slicing the original at the returned offsets — scored 141/234
lossless and 60/139 identical against this same corpus, because the library's
tail token carries `len(text) - 1` (`_basic_sent.py:77`) and merged sentences are
re-joined with one space (`:69`). See danda_tokenizer.py's module docstring.
"""

import pytest
from livekit.agents.tokenize import _basic_sent, basic

from danda_tokenizer import (
    DANDA,
    DANDA_SUBSTITUTE,
    DOUBLE_DANDA,
    DOUBLE_DANDA_SUBSTITUTE,
    DandaSentenceTokenizer,
    has_substitute_collision,
    split_sentences,
)

# ── The corpus ────────────────────────────────────────────────────────────────
# 9 separators x 5 bodies x 5 terminators, plus 9 named shapes. Deliberately
# includes separators the fixtures of the Phase 0 pass did not: '', '  ', '\n',
# '\t' — the ones that break offset recovery.
SEPARATORS = ["", " ", "  ", "   ", "\n", "\r\n", "\t", " \n ", "\n\n"]
BODIES = [
    ["हाँ", "नहीं", "ठीक"],                                    # short enough to MERGE
    ["जी हाँ हम करते हैं", "कीमत पांच हज़ार है"],                # around min_sentence_len
    ["जी हाँ, हम रूट कैनल करते हैं", "इसकी कीमत पांच हज़ार रुपये है",
     "डॉक्टर राव सोमवार को उपलब्ध हैं"],                         # comfortably over
    ["Yes we do root canals", "The fee is five thousand"],
    ["అవును మేము చేస్తాము", "ఖర్చు అయ్దు వేలు"],
]
TERMINATORS = [DANDA, DOUBLE_DANDA, ".", "?", "!"]

NAMED = [
    ("", False),
    (DANDA, True),
    (DOUBLE_DANDA, True),
    (".", False),
    ("कीमत 1500।2000 रुपये अलग हैं। डॉक्टर राव कल उपलब्ध रहेंगे।", True),
    ("Dr. Rao is here। The fee is Rs. 5000। Call at 9 a.m. tomorrow।", True),
    ('उन्होंने कहा "ठीक है।" फिर वे चले गए। डॉक्टर राव कल उपलब्ध रहेंगे।', True),
    ("The cost is 1500.50 rupees. That includes the X-ray.", False),
    ("Dr. Rao is here. The fee is Rs. 5000. Call us at 9 a.m. tomorrow.", False),
]


def build_corpus():
    corpus = [
        (sep.join(part + term for part in body), term in (DANDA, DOUBLE_DANDA))
        for sep in SEPARATORS
        for body in BODIES
        for term in TERMINATORS
    ]
    return corpus + NAMED


CORPUS = build_corpus()
DANDA_FREE = [text for text, has_danda in CORPUS if not has_danda]


def nonspace(text):
    return "".join(ch for ch in text if not ch.isspace())


def test_the_corpus_is_the_one_the_mechanism_was_measured_on():
    # The two headline numbers below mean nothing if the corpus quietly shrinks,
    # so its shape is asserted before anything is measured against it.
    assert len(CORPUS) == 234
    assert sum(1 for _, has_danda in CORPUS if has_danda) == 95
    assert len(DANDA_FREE) == 139


def test_every_input_survives_losslessly():
    """234/234 — no character lost, none invented. Offset-slicing scored 141."""
    lost = []
    for text, _ in CORPUS:
        produced = nonspace(" ".join(tok for tok, _, _ in split_sentences(text)))
        if produced != nonspace(text):
            lost.append((text, produced))
    assert lost == [], f"{len(lost)} of {len(CORPUS)} inputs lost or gained characters"


def test_danda_free_input_is_byte_identical_to_the_library():
    """139/139 — Telugu and English are unchanged BY CONSTRUCTION, not by luck.

    `==` on the returned list compares token text, start and end offsets, so a
    change in buffer advancement would fail here too. Offset-slicing scored 60.
    """
    drifted = []
    for text in DANDA_FREE:
        ours = split_sentences(text)
        theirs = _basic_sent.split_sentences(text)
        if ours != theirs:
            drifted.append((text, theirs, ours))
    assert drifted == [], f"{len(drifted)} of {len(DANDA_FREE)} danda-free inputs drifted"


def test_a_danda_input_actually_splits_somewhere():
    # Anti-vacuity for the two tests above: if the danda were being ignored, both
    # would still pass — losslessly and identically — while buying nothing.
    text = "जी हाँ, हम रूट कैनल करते हैं। इसकी कीमत पांच हज़ार रुपये है।"
    assert len(_basic_sent.split_sentences(text)) == 1
    assert len(split_sentences(text)) == 2


# ── The collision branch ─────────────────────────────────────────────────────
# A first-class path, not a comment. If the input already carries a substitute,
# inverting would rewrite a character the clinic typed, so that input takes the
# library unmodified: correct text, no danda splitting — exactly HEAD.


def test_a_literal_substitute_is_detected():
    assert has_substitute_collision(f"पहला{DANDA_SUBSTITUTE} दूसरा")
    assert has_substitute_collision(f"पहला{DOUBLE_DANDA_SUBSTITUTE} दूसरा")
    assert not has_substitute_collision(f"पहला{DANDA} दूसरा{DOUBLE_DANDA}")


def test_a_literal_substitute_is_never_rewritten_into_a_danda():
    """THE guard assertion. Without the collision check the inversion turns the
    clinic's own 。 into a danda — a character it never typed, on the wire."""
    text = f"पहला वाक्य यहाँ है{DANDA_SUBSTITUTE} दूसरा वाक्य यहाँ है{DANDA_SUBSTITUTE}"
    assert DANDA not in text, "the fixture must not already contain a danda"

    produced = " ".join(tok for tok, _, _ in split_sentences(text))

    assert DANDA not in produced, "the collision branch was bypassed — a 。 became a ।"
    assert produced.count(DANDA_SUBSTITUTE) == text.count(DANDA_SUBSTITUTE)


def test_the_fullwidth_substitute_is_never_rewritten_into_a_double_danda():
    text = f"पहला वाक्य यहाँ है{DOUBLE_DANDA_SUBSTITUTE} दूसरा वाक्य यहाँ है{DOUBLE_DANDA_SUBSTITUTE}"
    assert DOUBLE_DANDA not in text

    produced = " ".join(tok for tok, _, _ in split_sentences(text))

    assert DOUBLE_DANDA not in produced, "the collision branch was bypassed"


def test_a_collision_returns_the_library_unmodified():
    # Including when the same text also carries a danda: the danda is NOT split,
    # which is the deliberate cost. Degrading to HEAD is the failure direction
    # this mechanism was chosen for.
    text = f"पहला वाक्य{DANDA} दूसरा वाक्य{DANDA_SUBSTITUTE} तीसरा वाक्य{DANDA}"
    assert split_sentences(text) == _basic_sent.split_sentences(text)


# ── Streaming: where the first segment is released ───────────────────────────


def drain(stream):
    out = []
    while True:
        try:
            out.append(stream._event_ch.recv_nowait().token)
        except Exception:
            return out


def emissions(text, tokenizer):
    """Push `text` one character at a time.

    Returns (incremental, at_flush): incremental is [(chars_pushed, token)], the
    finest-grained answer to "when was this released" — pushing in larger deltas
    can only round an emission point up to a chunk boundary, never earlier.
    """
    stream = tokenizer.stream()
    incremental = []
    for pushed, ch in enumerate(text, start=1):
        stream.push_text(ch)
        incremental.extend((pushed, tok) for tok in drain(stream))
    stream.end_input()
    return incremental, drain(stream)


HI_PURE_DANDA = (
    "जी हाँ, हम रूट कैनल करते हैं। इसकी कीमत पांच हज़ार रुपये है। "
    "डॉक्टर राव सोमवार को उपलब्ध हैं। समय सुबह दस बजे है। "
    "मैं आपका अपॉयंटमेंट बुक कर देती हूँ।"
)


async def test_head_holds_the_whole_pure_danda_reply_to_flush():
    """The defect, pinned. Anti-vacuity for the test below: without this, a
    tokenizer that changed nothing would still look like it fixed something."""
    incremental, at_flush = emissions(HI_PURE_DANDA, basic.SentenceTokenizer())

    assert incremental == [], "the library released a segment early — the defect is gone?"
    assert at_flush == [HI_PURE_DANDA]
    assert len(HI_PURE_DANDA) == 150


async def test_a_pure_danda_hindi_reply_releases_its_first_segment_at_the_first_danda():
    incremental, _ = emissions(HI_PURE_DANDA, DandaSentenceTokenizer())

    assert incremental, "nothing was released incrementally — still held to flush"
    pushed, segment = incremental[0]

    # THE BOUNDARY, not merely 'some segments exist'. The first danda sits at
    # index 28, so it is character 29; release follows two characters later, at
    # 31, the point at which the library's lookahead gate (`token_stream.py:42-45`
    # — a lone sentence is never emitted) can see a second sentence beginning.
    assert segment == "जी हाँ, हम रूट कैनल करते हैं।"
    assert segment.endswith(DANDA)
    assert HI_PURE_DANDA.index(DANDA) == 28
    assert pushed == 31
    assert pushed < len(HI_PURE_DANDA), "released before the reply finished"


async def test_the_pure_danda_reply_segments_exactly_as_the_same_text_with_ascii_periods():
    """The sharpest statement of the fix: punctuation stops mattering."""
    ascii_text = HI_PURE_DANDA.replace(DANDA, ".")

    ours, _ = emissions(HI_PURE_DANDA, DandaSentenceTokenizer())
    control, _ = emissions(ascii_text, basic.SentenceTokenizer())

    assert [pushed for pushed, _ in ours] == [pushed for pushed, _ in control]
    assert [tok.replace(DANDA, ".") for _, tok in ours] == [tok for _, tok in control]


# ── Regression: Telugu and English, against behaviour captured BEFORE the change
# Literals captured at 51195c1 with the stock tokenizer
# (scratchpad/issue41/logs/01-reproduce.log). Asserted twice: against the capture,
# which is the "unchanged" claim, and against the live library, so the capture
# itself cannot silently rot.

TE_APOLOGY = "క్షమించండి, ప్రస్తుతం సాంకేతిక సమస్య వచ్చింది. దయచేసి కాసేపటి తర్వాత మళ్లీ కాల్ చేయండి."
EN_APOLOGY = "Sorry, we are having technical trouble right now. Please call again in a little while."
TE_REPLY = (
    "అవును, మేము రూట్ కానల్ చేస్తాము. దీని ఖర్చు అయ్దు వేలు రూపాయలు. "
    "డాక్టర్ రావు సోమవారం అందుబాటులో ఉన్నారు."
)
EN_REPLY = (
    "Yes, we do root canal treatment. The cost is five thousand rupees. "
    "Doctor Rao is available on Monday morning."
)

CAPTURED_AT_HEAD = [
    (TE_APOLOGY,
     [(48, "క్షమించండి, ప్రస్తుతం సాంకేతిక సమస్య వచ్చింది.")],
     ["దయచేసి కాసేపటి తర్వాత మళ్లీ కాల్ చేయండి."]),
    (EN_APOLOGY,
     [(51, "Sorry, we are having technical trouble right now.")],
     ["Please call again in a little while."]),
    (TE_REPLY,
     [(34, "అవును, మేము రూట్ కానల్ చేస్తాము."),
      (65, "దీని ఖర్చు అయ్దు వేలు రూపాయలు.")],
     ["డాక్టర్ రావు సోమవారం అందుబాటులో ఉన్నారు."]),
    (EN_REPLY,
     [(34, "Yes, we do root canal treatment."),
      (68, "The cost is five thousand rupees.")],
     ["Doctor Rao is available on Monday morning."]),
]


@pytest.mark.parametrize("text,captured_incremental,captured_flush", CAPTURED_AT_HEAD)
async def test_telugu_and_english_segment_exactly_as_they_did_before_the_change(
    text, captured_incremental, captured_flush
):
    incremental, at_flush = emissions(text, DandaSentenceTokenizer())

    assert incremental == captured_incremental
    assert at_flush == captured_flush
    # and the capture still describes the stock tokenizer at this commit
    assert (incremental, at_flush) == emissions(text, basic.SentenceTokenizer())
