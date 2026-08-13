"""Sentence segmentation that terminates on the Devanagari danda (Issue 41).

WHY THIS EXISTS
---------------
`livekit-plugins-sarvam` hardcodes `tokenize.basic.SentenceTokenizer()` inside
`TTS.__init__` (sarvam/tts.py:549), and that tokenizer's end-of-sentence class is
`([.!?。！？])` (livekit/agents/tokenize/_basic_sent.py:44-45) — ASCII plus the
CJK forms. The Devanagari danda `।` U+0964 is absent, and so is `॥` U+0965.

Hindi is not punctuated with ASCII periods. Measured against the installed
library at 51195c1, streaming a reply in one character at a time:

    Telugu reply, 3 sentences, ASCII '.'   first segment released at char 34/104
    English reply, 3 sentences             first segment released at char 34/109
    Hindi reply, pure danda, 5 sentences   NEVER — all 150 chars held to flush
    the SAME Hindi text with ASCII '.'     first segment released at char 31/150

So for a Hindi reply punctuated the way Hindi is normally punctuated, nothing is
synthesized until generation finishes. It is not only generated replies: the
shipped `APOLOGIES["hi-IN"]` (76 chars, two dandas) is held in full as well.

`blingfire` does not solve it either — measured at HEAD, it also returns one
sentence for the same pure-danda input.

HOW IT WORKS, AND WHY IT IS A SUBSTITUTION RATHER THAN A COPY
-------------------------------------------------------------
The library's sentence logic (abbreviations `Mr.`/`Dr.`, decimals `1500.50`,
acronyms, websites, the `min_sentence_len` merge) is REUSED, never copied. Were
`split_sentences` vendored into this repo it would silently fork on the next
`livekit-agents` bump, and "Telugu and English are byte-unchanged" would be true
only by inspection.

Instead the danda is mapped onto a character the library ALREADY terminates on,
the library does the splitting, and the map is inverted on each returned token:

    ।  U+0964  ->  。 U+3002  (IDEOGRAPHIC FULL STOP)
    ॥  U+0965  ->  ！ U+FF01  (FULLWIDTH EXCLAMATION MARK)

Both substitutes are single characters, so `str.translate` is position- and
length-preserving; both are already in the class at `_basic_sent.py:44-45`, so
the library needs no modification; and they are distinct from each other, so the
inversion is unambiguous.

The inversion is exact because the library never invents non-space characters:
every text-producing step is `strip()`, `split()`, a join with a single space
(`:69`), or a `<prd>`/`<stop>` marker substitution that is undone before output.
So a token's characters are always input characters plus inserted spaces.

WHY NOT SLICE THE ORIGINAL AT THE RETURNED OFFSETS
---------------------------------------------------
That was tried first and REJECTED ON MEASUREMENT — it is the natural instinct and
it is wrong. `split_sentences` returns `(token, start, end)`, but the token is not
`text[start:end]`; the offsets are span markers, and the library itself only ever
uses `end` to advance its buffer (token_stream.py:62). Two mechanisms break the
slice, both present at HEAD on UNMODIFIED text — 131 of 344 tokens violate
`tok == text[start:end].strip()` with no substitution anywhere:

  * `_basic_sent.py:77` — the TAIL token is appended with `len(text) - 1`, one
    short, so slicing drops the last character. `split_sentences("Yes. No. Ok.")`
    returns `end=11` for a 12-character string.
  * `_basic_sent.py:69` — `buff += pre_pad + sentence` re-joins merged sentences
    with exactly ONE space, so the token is whitespace-normalised and no slice of
    the original can reproduce it when the separator was '', '  ', '\n' or '\t'.

Scored over the same 234-input corpus this module's tests use, offset-slicing was
lossless on 141/234 and identical to the library on 60/139 danda-free inputs;
this substitution is 234/234 and 139/139. Offset-slicing corrupts Telugu and
English — an English reply closing "Thank you." loses its period, and so does a
Telugu one closing "ధన్యవాదాలు." — which is the opposite of the requirement.

THE COLLISION BRANCH IS A REAL PATH, NOT A COMMENT
---------------------------------------------------
If the input already contains `。` or `！`, inverting would rewrite a character
the caller's clinic actually typed. That input takes `split_sentences` unmodified
— exactly HEAD behaviour: correct text, no danda splitting. The failure direction
is deliberate and is the whole reason this mechanism was chosen over slicing: a
collision costs one reply its incremental segmentation, where a bad slice would
put corrupted text on the wire in the two languages that work today.

Because the stream tokenizes a growing buffer, a `。` arriving mid-reply moves
only the REMAINING text onto the unmodified path; segments already emitted stand.
Text is correct on both sides of that boundary.
"""

from __future__ import annotations

import functools

from livekit.agents.tokenize import _basic_sent, basic, token_stream

# The two Devanagari sentence terminators.
DANDA = "।"          # ।  purna viram — the ordinary Hindi full stop
DOUBLE_DANDA = "॥"   # ॥  deergh viram — verse terminator

# Substitutes, chosen because they are ALREADY in the library's terminator class.
DANDA_SUBSTITUTE = "。"         # 。
DOUBLE_DANDA_SUBSTITUTE = "！"  # ！

# The effective terminator set this module gives the library: [.!?。！？।॥]
_TO_SUBSTITUTE = str.maketrans({
    DANDA: DANDA_SUBSTITUTE,
    DOUBLE_DANDA: DOUBLE_DANDA_SUBSTITUTE,
})
_FROM_SUBSTITUTE = str.maketrans({
    DANDA_SUBSTITUTE: DANDA,
    DOUBLE_DANDA_SUBSTITUTE: DOUBLE_DANDA,
})


def has_substitute_collision(text: str) -> bool:
    """True when `text` already contains a substitute, so inversion is unsafe."""
    return DANDA_SUBSTITUTE in text or DOUBLE_DANDA_SUBSTITUTE in text


def split_sentences(
    text: str, min_sentence_len: int = 20, retain_format: bool = False
) -> list[tuple[str, int, int]]:
    """`_basic_sent.split_sentences` with the danda in the terminator class.

    Same signature, same return shape. Danda-free input is passed through the
    library untouched and returns the library's own tuples, offsets included.
    """
    if has_substitute_collision(text):
        return _basic_sent.split_sentences(text, min_sentence_len, retain_format)

    substituted = text.translate(_TO_SUBSTITUTE)
    return [
        (token.translate(_FROM_SUBSTITUTE), start, end)
        for token, start, end in _basic_sent.split_sentences(
            substituted, min_sentence_len, retain_format
        )
    ]


class DandaSentenceTokenizer(basic.SentenceTokenizer):
    """`basic.SentenceTokenizer` whose terminator set includes the danda.

    Subclasses rather than reimplements: `_config` and its defaults
    (`min_sentence_len=20`, `stream_context_len=10`) come from the library, so
    the three release gates in `token_stream.BufferedTokenStream` are the ones
    that govern Telugu and English today. Only the split function differs, and
    only for text containing a danda.
    """

    def tokenize(self, text: str, *, language: str | None = None) -> list[str]:
        return [
            token[0]
            for token in split_sentences(
                text,
                min_sentence_len=self._config.min_sentence_len,
                retain_format=self._config.retain_format,
            )
        ]

    def stream(self, *, language: str | None = None):
        return token_stream.BufferedSentenceStream(
            tokenizer=functools.partial(
                split_sentences,
                min_sentence_len=self._config.min_sentence_len,
                retain_format=self._config.retain_format,
            ),
            min_token_len=self._config.min_sentence_len,
            min_ctx_len=self._config.stream_context_len,
        )
