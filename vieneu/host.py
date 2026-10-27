#!/usr/bin/env python3
"""SubDub native-messaging host for the optional local Vietnamese voice (VieNeu-TTS v3 Nano).

Chrome starts this program itself (via run-host.bat / run-host.sh) and talks to it with
Chrome's native-messaging framing: 4-byte little-endian length + UTF-8 JSON, on stdin/stdout.

Modes
  host.py               native-messaging mode (default; never prints anything but frames)
  host.py --download    console mode used by the installer: download + load + warm-up, Vietnamese output
  host.py --say "text" [--voice NAME] [--out FILE.wav] [--steps N]   one-off synthesis (dev/test)

Dependencies: Python 3.10+, numpy, onnxruntime, sea-g2p (versions pinned in requirements.txt).
The `vieneu` pip package is NOT needed: its text chunking and the Nano sampling loop are
ported here (see the credit below).

Data directory: env SUBDUB_VIENEU_HOME, else the directory that contains this file.
  <home>/host.log                       size-limited log (all diagnostics go here, never to stdout)
  <home>/models/VieNeu-TTS-v3-Nano/     the six model files
  <home>/models/voices_v3_nano.json     the preset voices
Dev overrides (optional): SUBDUB_VIENEU_MODEL_DIR, SUBDUB_VIENEU_VOICES, SUBDUB_VIENEU_STEPS (8|16),
SUBDUB_VIENEU_IDLE_SECONDS, SUBDUB_VIENEU_FAKE_AVAIL_MB / SUBDUB_VIENEU_FAKE_RTF (test hooks for the low-memory and too-slow paths).

Resource policy (the host must never make the PC feel slow): below-normal process priority,
cpu_count//4 ORT threads (max 4), the model is loaded lazily on the first `speak` or `warm`
message (hello alone never loads it), no loading when < 1 GB RAM is available, and the process
exits by itself after 3 minutes (SUBDUB_VIENEU_IDLE_SECONDS) without speak/warm.
States: missing | downloading | idle (files present, model not loaded) | loading | ready |
low-memory | too-slow (RTF still > 0.9 at 8 steps) | error.

Protocol: see the extension docs. Messages Chrome -> host: hello, download, warm, speak, cancel.
Host -> Chrome: hello, status, audio (WAV split in base64 slices <= 600000 chars), error.
`status` also carries an additive `steps` field once the model is loaded.

User-facing strings (the `error` field of hello/status; the extension may show them verbatim)
are short Vietnamese sentences. Per-request errors `{type:"error", id, error}` use ASCII codes:
  cancelled      the job was dropped by a cancel message
  model-missing  speak before the model was downloaded
  not-ready      speak while the host is in the error state
  low-memory     speak while less than 1 GB of RAM is available (model not loaded)
  too-slow       speak on a machine that is too slow even at 8 steps
  synth-failed   unexpected failure while synthesizing (details are in host.log)

Credit: the Nano sampling loop, text chunking and audio joining are ported from VieNeu-TTS
(Apache-2.0, https://github.com/pnnbao97/VieNeu-TTS); phonemes come from sea-g2p (Apache-2.0).
"""
from __future__ import annotations

import base64
import collections
import errno
import hashlib
import json
import logging
import logging.handlers
import math
import os
import re
import struct
import sys
import threading
import time
import urllib.error
import urllib.request

try:  # heavy deps are imported defensively so hello() can still report a friendly error
    import numpy as np
    IMPORT_ERROR = None
except Exception as _e:  # pragma: no cover - only on broken installs
    np = None
    IMPORT_ERROR = "numpy: %s" % _e

PROTO = 1
SAMPLE_RATE = 24000
MAX_SLICE = 600000          # base64 characters per audio message
MAX_FRAME = 1000000         # Chrome rejects host messages >= 1 MiB
LRU_SIZE = 64
DEFAULT_STEPS = 16
FAST_STEPS = 8
CFG = 3.0
RTF_LIMIT = 0.45
RTF_TOO_SLOW = 0.9
MIN_FREE_RAM = 1_000_000_000
IDLE_SECONDS = float(os.environ.get("SUBDUB_VIENEU_IDLE_SECONDS") or 180)
CHUNK_CHARS = 140

HOME = os.path.abspath(os.environ.get("SUBDUB_VIENEU_HOME") or os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.abspath(os.environ.get("SUBDUB_VIENEU_MODEL_DIR") or os.path.join(HOME, "models", "VieNeu-TTS-v3-Nano"))
VOICES_PATH = os.path.abspath(os.environ.get("SUBDUB_VIENEU_VOICES") or os.path.join(HOME, "models", "voices_v3_nano.json"))
LOG_PATH = os.path.join(HOME, "host.log")

HF_REV = "aba295eb96a6fa6003ebe417cc1f2802a7adc1dc"
HF_BASE = "https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Nano/resolve/%s/" % HF_REV
VOICES_URL = ("https://raw.githubusercontent.com/pnnbao97/VieNeu-TTS/"
              "04044e1b8f822f946bafb2c88b716459f4164152/src/vieneu/assets/voices_v3_nano.json")
# (name, url, size, sha256 of the content or None, git blob sha1 or None). For the HF LFS files the
# sha256 is the file's ETag (x-linked-etag); config.json is a plain git blob (sha1).
MODEL_FILES = [
    ("text_encoder.onnx", HF_BASE + "text_encoder.onnx", 26519943,
     "204f02cccae1f16ccb2d3840f05721a37fe250b82cbd456337a0ccb49615e4bf", None),
    ("duration_predictor.onnx", HF_BASE + "duration_predictor.onnx", 727809,
     "20fd7fa60006d0a48ee82e0451b3f920d2052588c083c756cce669f3947c0a68", None),
    ("vector_estimator.onnx", HF_BASE + "vector_estimator.onnx", 155132418,
     "c6c1d4398ca35d3ad1bd3f0459413d1b975d09e7f2f3a2b4493a7b92bbf6ce93", None),
    ("codec_decoder.onnx", HF_BASE + "codec_decoder.onnx", 99319941,
     "b0ab15e7828a39d53679e25b1ba4ba415a61311307202a6323130b9e1cc3029d", None),
    ("constants.npz", HF_BASE + "constants.npz", 53448,
     "7c011938effe41687a9af85107a31a040dfcf0fb3d0f048ec10f4fb65c1a8829", None),
    ("config.json", HF_BASE + "config.json", 2927, None,
     "28775f73b90821ca586215eedc7c20be83d02ee3"),
]
VOICES_FILE = ("voices_v3_nano.json", VOICES_URL, 2316799,
               "2ca4cbf475409e61fda662fbd3fb3a3ac3e980bbc3925fedb4d1199c4ccac3e7", None)

MSG_NO_NET = "Không kết nối được mạng. Hãy kiểm tra Internet rồi thử lại."
MSG_DISK = "Ổ đĩa đầy. Hãy giải phóng khoảng 400 MB rồi thử lại."
MSG_BAD_FILE = "Tệp mô hình tải về bị lỗi. Hãy thử lại."
MSG_LOAD = "Không nạp được mô hình: %s"
MSG_DEPS = "Thiếu thư viện cần thiết (%s). Hãy chạy lại Cai-giong-VieNeu.bat."

FLUSH_CODE = {"missing": "model-missing", "low-memory": "low-memory", "too-slow": "too-slow"}

log = logging.getLogger("subdub.vieneu")


# ───────────────────────────── logging ─────────────────────────────

def setup_logging(console: bool = False) -> None:
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s [%(threadName)s] %(message)s")
    try:
        os.makedirs(HOME, exist_ok=True)
        h = logging.handlers.RotatingFileHandler(LOG_PATH, maxBytes=500_000, backupCount=1, encoding="utf-8")
        h.setFormatter(fmt)
        log.addHandler(h)
    except OSError:
        log.addHandler(logging.NullHandler())
    if console:
        sh = logging.StreamHandler(sys.stderr)
        sh.setFormatter(logging.Formatter("%(message)s"))
        sh.setLevel(logging.WARNING)
        log.addHandler(sh)

    def _hook(exc_type, exc, tb):
        log.error("uncaught exception", exc_info=(exc_type, exc, tb))
    sys.excepthook = _hook
    threading.excepthook = lambda a: log.error("thread %s crashed", a.thread and a.thread.name,
                                               exc_info=(a.exc_type, a.exc_value, a.exc_traceback))


# ───────────────────────── system helpers ─────────────────────────

def available_ram():
    """Available physical RAM in bytes, or None if unknown."""
    fake = os.environ.get("SUBDUB_VIENEU_FAKE_AVAIL_MB")
    if fake:
        return int(float(fake) * 1_000_000)
    try:
        if os.name == "nt":
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]
            ms = MS()
            ms.dwLength = ctypes.sizeof(MS)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms)):
                return int(ms.ullAvailPhys)
            return None
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
    except Exception:
        pass
    return None


def _kernel32():
    # HANDLE is pointer-sized: without explicit types ctypes passes the pseudo-handle (-1) as a 32-bit int and the
    # call fails silently on 64-bit Windows
    import ctypes
    from ctypes import wintypes
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.GetCurrentProcess.restype = wintypes.HANDLE
    k.GetCurrentProcess.argtypes = []
    return k, ctypes, wintypes


def rss_mb():
    try:
        if os.name == "nt":
            k, ctypes, wintypes = _kernel32()

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                    (n, ctypes.c_size_t) for n in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                                                   "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                                                   "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
            k.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
            k.K32GetProcessMemoryInfo.restype = wintypes.BOOL
            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            if k.K32GetProcessMemoryInfo(k.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
                return pmc.WorkingSetSize // (1024 * 1024)
            return "?"
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return "?"


def lower_priority():
    try:
        if os.name == "nt":
            k, ctypes, wintypes = _kernel32()
            k.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            k.SetPriorityClass.restype = wintypes.BOOL
            if not k.SetPriorityClass(k.GetCurrentProcess(), 0x00004000):  # BELOW_NORMAL_PRIORITY_CLASS
                log.warning("could not lower process priority (error %s)", ctypes.get_last_error())
        else:
            os.nice(10)
    except Exception:
        log.warning("could not lower process priority")


# ──────────────────────────── downloads ────────────────────────────

class FetchError(Exception):
    """Download failure carrying a ready-to-show Vietnamese message."""


def _file_ok(path: str, size: int) -> bool:
    try:
        return os.path.getsize(path) == size
    except OSError:
        return False


def _digest_ok(path: str, sha256: str | None, git_sha1: str | None) -> bool:
    if sha256:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for blk in iter(lambda: f.read(1 << 20), b""):
                h.update(blk)
        return h.hexdigest() == sha256
    if git_sha1:
        data = open(path, "rb").read()
        return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest() == git_sha1
    return True


def _download_one(url: str, dest: str, size: int, sha256, git_sha1, on_bytes) -> None:
    """Download to dest.part (resuming if possible), verify, then rename. on_bytes(total_so_far)."""
    tmp = dest + ".part"
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    last_err = None
    for attempt in range(1, 5):
        try:
            have = os.path.getsize(tmp) if os.path.exists(tmp) else 0
            if have > size:
                os.remove(tmp)
                have = 0
            if have < size:
                headers = {"User-Agent": "SubDub-VieNeu/1"}
                if have:
                    headers["Range"] = "bytes=%d-" % have
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
                    if have and getattr(r, "status", 200) != 206:
                        have = 0  # server ignored Range: start over
                    with open(tmp, "ab" if have else "wb") as f:
                        while True:
                            blk = r.read(1 << 20)
                            if not blk:
                                break
                            f.write(blk)
                            have += len(blk)
                            on_bytes(have)
                            if have > size:
                                raise OSError("file larger than expected")
                if have != size:
                    raise OSError("truncated download (%d/%d)" % (have, size))
            break
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code == 416 and os.path.exists(tmp):
                os.remove(tmp)
            elif e.code in (401, 403, 404, 410):
                break
        except OSError as e:
            if e.errno == errno.ENOSPC:
                raise FetchError(MSG_DISK)
            last_err = e
        log.warning("download %s attempt %d failed: %s", os.path.basename(dest), attempt, last_err)
        time.sleep(1.5 * attempt)
    else:
        raise FetchError(MSG_NO_NET)
    if not _file_ok(tmp, size):
        raise FetchError(MSG_NO_NET)
    if not _digest_ok(tmp, sha256, git_sha1):
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise FetchError(MSG_BAD_FILE)
    for i in range(5):  # antivirus may briefly lock a fresh file on Windows
        try:
            os.replace(tmp, dest)
            return
        except PermissionError:
            time.sleep(0.5)
    os.replace(tmp, dest)


def _plan():
    plan = [(name, os.path.join(MODEL_DIR, name), url, size, s256, s1) for name, url, size, s256, s1 in MODEL_FILES]
    n, url, size, s256, s1 = VOICES_FILE
    plan.append((n, VOICES_PATH, url, size, s256, s1))
    return plan


def files_present() -> bool:
    return all(_file_ok(p, size) for _, p, _, size, _, _ in _plan())


def ensure_files(progress=None, verify: bool = False) -> None:
    """Download whatever is missing (or fails verification when verify=True). progress(fraction)."""
    plan = _plan()
    total = sum(p[3] for p in plan)
    todo = []
    for item in plan:
        name, path, url, size, s256, s1 = item
        if _file_ok(path, size) and (not verify or _digest_ok(path, s256, s1)):
            continue
        if os.path.exists(path):
            os.remove(path)
        todo.append(item)
    if not todo:
        if progress:
            progress(1.0)
        return
    need = sum(p[3] for p in todo)
    try:
        import shutil
        os.makedirs(HOME, exist_ok=True)
        if shutil.disk_usage(HOME).free < need + 50_000_000:
            raise FetchError(MSG_DISK)
    except OSError:
        pass
    done_before = total - need
    for name, path, url, size, s256, s1 in todo:
        log.info("downloading %s (%d bytes)", name, size)
        _download_one(url, path, size, s256, s1,
                      lambda n: progress and progress(min(1.0, (done_before + n) / total)))
        done_before += size
    if progress:
        progress(1.0)


# ─────────────────────── text → chunks (port) ───────────────────────
# Ported from VieNeu-TTS vieneu_utils (Apache-2.0) so that chunking and phonemes are identical.

RE_NEWLINE_SPLIT = re.compile(r"[\r\n]+")
RE_MINOR_PUNCT = re.compile(r"(?<=[\,\;\:\-\–\—])\s+")
RE_TOKEN_KEEP_EN = re.compile(r"<en>.*?</en>|\S+", re.IGNORECASE | re.DOTALL)
_OPEN_TO_CLOSE = {"(": ")", "[": "]", "{": "}", "“": "”", "‘": "’", "«": "»", "‹": "›", "「": "」", "『": "』"}
_OPENERS = frozenset(_OPEN_TO_CLOSE)
_CLOSERS = frozenset(_OPEN_TO_CLOSE.values())
_SENT_END_CHARS = frozenset(".!?…")
_TRAILING_CLOSE = _CLOSERS | frozenset("\"'’”")
_CONN_WORDS = frozenset("và nhưng hoặc song rồi nên vì nếu khi để do bởi".split())
_CONN_PAIRS = frozenset([
    ("sau", "khi"), ("trước", "khi"), ("trong", "khi"), ("mỗi", "khi"), ("đến", "khi"), ("tới", "khi"),
    ("cho", "nên"), ("cho", "đến"), ("bởi", "vì"), ("nếu", "như"), ("tuy", "nhiên"), ("thế", "nhưng"),
    ("vì", "vậy"), ("vì", "thế"), ("do", "đó"), ("sau", "đó"),
])
_CONN_STRIP = "\"'“”‘’()[]«»…"
_NUMBER_WORDS = frozenset(
    "không một mốt hai ba bốn tư năm lăm sáu bảy tám chín mười mươi trăm nghìn ngàn "
    "triệu tỷ tỉ linh lẻ phẩy chấm".split())
CHUNK_TAIL_SLACK = 15
GAP_SILENCE = {"para": 0.70, "sentence": 0.50, "minor": 0.30}
EDGE_THRESH_DB, EDGE_KEEP_S, EDGE_FADE_S = -45.0, 0.04, 0.015


def _scan_sentences(text, quote_aware=True):
    sentences, n, start, i, depth, in_quote = [], len(text), 0, 0, 0, False
    while i < n:
        ch = text[i]
        if quote_aware and ch == '"':
            in_quote = not in_quote
        elif quote_aware and ch in _OPENERS:
            depth += 1
        elif quote_aware and ch in _CLOSERS:
            if depth:
                depth -= 1
        elif ch in _SENT_END_CHARS and depth == 0 and not in_quote:
            j = i + 1
            while j < n and text[j] in _SENT_END_CHARS:
                j += 1
            while j < n and text[j] in _TRAILING_CLOSE:
                j += 1
            if j >= n or text[j].isspace():
                sentences.append(text[start:j])
                start = i = j
                continue
            i = j
            continue
        i += 1
    if start < n:
        sentences.append(text[start:])
    return [s.strip() for s in sentences if s.strip()], (depth == 0 and not in_quote)


def split_into_sentences(text):
    if not text:
        return []
    sentences, balanced = _scan_sentences(text, True)
    if not balanced:
        sentences, _ = _scan_sentences(text, False)
    return sentences


def _conn_key(t):
    return t.strip(_CONN_STRIP).lower()


def _is_number_word(t):
    k = _conn_key(t)
    return k in _NUMBER_WORDS or k.isdigit()


def _span_len(words, start, end):
    return 0 if end <= start else sum(len(w) for w in words[start:end]) + (end - start - 1)


def _tail_slack(max_chars):
    return min(CHUNK_TAIL_SLACK, max_chars // 8)


def _fits(cur_len, add_len, max_chars):
    total = cur_len + 1 + add_len if cur_len else add_len
    slack = _tail_slack(max_chars)
    return total <= max_chars or (add_len <= slack and total <= max_chars + slack)


def _balanced_cut(words, start, target, max_chars, min_left):
    best_nat = best_plain = None
    end_cap = start + 1
    for j in range(start + 1, len(words)):
        left = _span_len(words, start, j)
        if left > max_chars:
            break
        end_cap = j
        key, prev = _conn_key(words[j]), _conn_key(words[j - 1])
        nxt = _conn_key(words[j + 1]) if j + 1 < len(words) else ""
        d = abs(left - target)
        inside_pair = (prev, key) in _CONN_PAIRS
        natural = (key in _CONN_WORDS or (key, nxt) in _CONN_PAIRS) and prev not in _CONN_WORDS
        if natural and not inside_pair and left >= min_left and (best_nat is None or d < best_nat[0]):
            best_nat = (d, j)
        plain_ok = not inside_pair and not (_is_number_word(words[j - 1]) and _is_number_word(words[j]))
        if plain_ok and (best_plain is None or d < best_plain[0]):
            best_plain = (d, j)
    if best_nat is not None:
        return best_nat[1]
    if best_plain is not None:
        return best_plain[1]
    end = end_cap
    while end > start + 1 and (_conn_key(words[end - 1]), _conn_key(words[end])) in _CONN_PAIRS:
        end -= 1
    return end


def _split_long_part(part, max_chars):
    words = RE_TOKEN_KEEP_EN.findall(part)
    min_left = max_chars // 3
    pieces, start = [], 0
    while start < len(words):
        rest = _span_len(words, start, len(words))
        if rest <= max_chars:
            pieces.append(" ".join(words[start:]))
            break
        full = start + 1
        while full < len(words) and _span_len(words, start, full + 1) <= max_chars:
            full += 1
        if _fits(_span_len(words, start, full), _span_len(words, full, len(words)), max_chars):
            pieces.append(" ".join(words[start:]))
            break
        n_pieces = -(-rest // max_chars)
        end = _balanced_cut(words, start, rest / n_pieces, max_chars, min_left)
        pieces.append(" ".join(words[start:end]))
        start = end
    return pieces


def pack_sentences_into_chunks(sentences, max_chars):
    final, buffer = [], ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > max_chars:
            if buffer:
                final.append(buffer)
                buffer = ""
            for part in RE_MINOR_PUNCT.split(sentence):
                part = part.strip()
                if not part:
                    continue
                if _fits(len(buffer), len(part), max_chars):
                    buffer = (buffer + " " + part) if buffer else part
                else:
                    if buffer:
                        final.append(buffer)
                    buffer = part
                    if len(buffer) > max_chars:
                        pieces = _split_long_part(buffer, max_chars)
                        final.extend(pieces[:-1])
                        buffer = pieces[-1] if pieces else ""
        elif buffer and not _fits(len(buffer), len(sentence), max_chars):
            final.append(buffer)
            buffer = sentence
        else:
            buffer = (buffer + " " + sentence) if buffer else sentence
    if buffer:
        final.append(buffer)
    return [c.strip() for c in final if c.strip()]


def _classify_gap(chunk):
    c = chunk.rstrip()
    return "sentence" if c and c[-1] in ".!?" else "minor"


def _merge_short_chunks(chunks, gaps, min_chars):
    while len(chunks) > 1:
        short = [i for i, c in enumerate(chunks) if len(c.strip()) < min_chars]
        if not short:
            break
        i = min(short, key=lambda k: len(chunks[k].strip()))
        sides = []
        if i < len(chunks) - 1:
            sides.append(((gaps[i] != "para", -len(chunks[i + 1])), "R"))
        if i > 0:
            sides.append(((gaps[i - 1] != "para", -len(chunks[i - 1])), "L"))
        side = max(sides, key=lambda t: t[0])[1]
        if side == "R":
            chunks[i] = chunks[i] + " " + chunks.pop(i + 1)
            gaps.pop(i)
        else:
            chunks[i - 1] = chunks[i - 1] + " " + chunks.pop(i)
            gaps.pop(i - 1)
    return chunks, gaps


class TextFront:
    """sea-g2p normalizer + G2P with the same behaviour as VieNeu's phonemize_text module."""

    def __init__(self):
        from sea_g2p import SEAPipeline, Normalizer, punc_norm
        self._pipeline = SEAPipeline(lang="vi")
        self._normalizer = Normalizer(lang="vi")
        self._punc_norm = punc_norm

    def chunks(self, text: str, max_chars: int = CHUNK_CHARS, min_chunk_chars: int = 20):
        """text -> (chunks, gaps) exactly like normalize_to_chunks_v3_with_gaps (emotion cues are ignored)."""
        paragraphs = [p for p in RE_NEWLINE_SPLIT.split(text or "") if p.strip()]
        chunks, gaps = [], []
        for para in paragraphs:
            sentences = split_into_sentences(para)
            if not sentences:
                continue
            normed = self._normalizer.normalize_batch(sentences, punc_norm=False)
            para_chunks = pack_sentences_into_chunks(normed, max_chars)
            if not para_chunks:
                continue
            if chunks:
                gaps.append("para")
            for j, ch in enumerate(para_chunks):
                if j > 0:
                    gaps.append("sentence")
                chunks.append(ch)
        chunks = [self._punc_norm(c) for c in chunks]
        gaps = [g if g == "para" else _classify_gap(chunks[i]) for i, g in enumerate(gaps)]
        return _merge_short_chunks(chunks, gaps, min_chunk_chars)

    def phonemes(self, chunk: str) -> str:
        return self._pipeline.run(chunk, punc_norm=True)


# ─────────────────────── audio helpers (port) ───────────────────────

def edge_silence(wav, sr, thresh_db=EDGE_THRESH_DB, win_s=0.01):
    n_samp = int(wav.size)
    win = max(1, int(win_s * sr))
    n_win = n_samp // win
    if n_win == 0:
        return n_samp, 0
    env = np.abs(wav[: n_win * win]).reshape(n_win, win).mean(1)
    above = np.flatnonzero(env > 10 ** (thresh_db / 20))
    if not above.size:
        return n_samp, 0
    return int(above[0]) * win, n_samp - (int(above[-1]) + 1) * win


def trim_and_fade(wav, sr, thresh_db=EDGE_THRESH_DB, keep_s=EDGE_KEEP_S, fade_s=EDGE_FADE_S):
    if wav.size == 0:
        return wav
    lead, tail = edge_silence(wav, sr, thresh_db)
    keep = int(keep_s * sr)
    a = max(0, lead - keep)
    b = wav.size - max(0, tail - keep)
    out = np.array(wav[a:b], dtype=np.float32, copy=True)
    n = min(int(fade_s * sr), out.size // 2)
    if n > 0:
        ramp = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, n))).astype(np.float32)
        out[:n] *= ramp
        out[-n:] *= ramp[::-1]
    return out


def pause_pad_samples(prev_wav, next_wav, sr, pause_s):
    lead_prev, tail = edge_silence(prev_wav, sr)
    if lead_prev == prev_wav.size:
        tail = prev_wav.size
    lead, _ = edge_silence(next_wav, sr)
    return max(0, int(pause_s * sr) - tail - lead)


def join_audio_chunks(chunks, sr, silence_ps):
    if not chunks:
        return np.array([], dtype=np.float32)
    parts = [chunks[0]]
    for i in range(1, len(chunks)):
        pause_s = silence_ps[i - 1] if i - 1 < len(silence_ps) else 0.0
        pad = pause_pad_samples(chunks[i - 1], chunks[i], sr, pause_s)
        if pad > 0:
            parts.append(np.zeros(pad, dtype=np.float32))
        parts.append(chunks[i])
    return np.concatenate(parts) if len(parts) > 1 else parts[0]


def wav_bytes(samples) -> bytes:
    """float32 [-1,1] mono @24 kHz -> 16-bit PCM WAV bytes (header only for empty input)."""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes() if len(samples) else b""
    hdr = (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " +
           struct.pack("<IHHIIHH", 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16) +
           b"data" + struct.pack("<I", len(pcm)))
    return hdr + pcm


# ───────────────────────────── engine ─────────────────────────────

class Engine:
    """The four ONNX graphs + the flow-matching sampling loop (port of OnnxV3NanoEngine.infer)."""
    MAX_CHUNK_SECONDS = 15.0
    MIN_FRAMES = 2

    def __init__(self, model_dir: str, voices_path: str, threads: int | None = None):
        import onnxruntime as ort
        self.text = TextFront()
        d = model_dir
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            self.cfg = json.load(f)
        c = np.load(os.path.join(d, "constants.npz"))
        self.null_spk = c["null_spk"].astype(np.float32)[None]
        self.null_style = c["null_style"].astype(np.float32)[None]
        self.vocab = self.cfg["vocab"]
        self.bos, self.eos, self.pad = int(self.cfg["bos_id"]), int(self.cfg["eos_id"]), int(self.cfg["pad_id"])
        self.fps = float(self.cfg.get("flow_fps", 24000 / 256 / 6))
        self.voices, self.default_voice = load_voices(voices_path)

        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = threads or min(4, max(1, (os.cpu_count() or 4) // 4))
        so.add_session_config_entry("session.intra_op.allow_spinning", "0")
        so.log_severity_level = 3
        prov = ["CPUExecutionProvider"]

        def sess(n):
            return ort.InferenceSession(os.path.join(d, n + ".onnx"), so, providers=prov)
        self.s_text, self.s_dur = sess("text_encoder"), sess("duration_predictor")
        self.s_ve, self.s_dec = sess("vector_estimator"), sess("codec_decoder")
        null_ids = np.array([[self.bos, self.eos]], dtype=np.int64)
        self.null_ctx = self.s_text.run(None, {"ids": null_ids, "style": self.null_style})[0]
        self.null_mask = null_ids != self.pad
        self._oov = set()

    def encode_phones(self, phones: str):
        ids = [self.bos]
        for ch in phones:
            i = self.vocab.get(ch)
            if i is None:
                if ch not in self._oov:
                    self._oov.add(ch)
                    log.warning("ignoring character outside vocab: %r", ch)
                continue
            ids.append(i)
        ids.append(self.eos)
        return np.array([ids], dtype=np.int64)

    def infer(self, phonemes, spk, style, steps=DEFAULT_STEPS, cfg=CFG, seed=None, speed=1.0, sway=0.0):
        spk = np.asarray(spk, dtype=np.float32).reshape(1, -1)
        style = np.asarray(style, dtype=np.float32)
        style = style.reshape(1, *style.shape[-2:])
        ids = self.encode_phones(phonemes)
        mask = ids != self.pad
        ctx = self.s_text.run(None, {"ids": ids, "style": style})[0]
        log_s = float(self.s_dur.run(None, {"ctx": ctx, "ctx_mask": mask, "spk": spk})[0][0])
        secs = min(math.exp(log_s) / max(float(speed), 1e-3), self.MAX_CHUNK_SECONDS)
        T = max(self.MIN_FRAMES, int(round(secs * self.fps)))
        x = np.random.default_rng(seed).standard_normal((1, 144, T)).astype(np.float32)
        n = max(1, int(steps))
        u = np.linspace(0.0, 1.0, n + 1, dtype=np.float64)
        tg = u + float(sway) * (np.cos(np.pi / 2 * u) - 1 + u)
        for i in range(n):
            t = np.array([tg[i]], dtype=np.float32)
            v = self.s_ve.run(None, {"x": x, "t": t, "ctx": ctx, "ctx_mask": mask, "spk": spk, "style": style})[0]
            if cfg > 0:
                vu = self.s_ve.run(None, {"x": x, "t": t, "ctx": self.null_ctx, "ctx_mask": self.null_mask,
                                          "spk": self.null_spk, "style": self.null_style})[0]
                v = vu + float(cfg) * (v - vu)
            x = x + np.float32(tg[i + 1] - tg[i]) * v
        wav = self.s_dec.run(None, {"x": x})[0][0, 0]
        return trim_and_fade(np.clip(wav, -1.0, 1.0).astype(np.float32), SAMPLE_RATE)

    def synthesize(self, text: str, voice: str | None, steps=DEFAULT_STEPS, cfg=CFG, seed=None):
        """Whole line -> float32 waveform. Splits to <=140-char chunks and joins with short pauses."""
        v = self.voices.get(voice or "") or self.voices[self.default_voice]
        chunks, gaps = self.text.chunks(text)
        if not chunks:
            return np.array([], dtype=np.float32)
        wavs = [self.infer(self.text.phonemes(ch), v["speaker_emb"], v["style"], steps=steps, cfg=cfg,
                           seed=None if seed is None else int(seed) + i) for i, ch in enumerate(chunks)]
        return join_audio_chunks(wavs, SAMPLE_RATE, [GAP_SILENCE.get(g, GAP_SILENCE["sentence"]) for g in gaps])

    def warm_up(self):
        """Initialise ORT, then time one sentence. Returns (rtf, steps_to_use, rtf_at_8_steps_or_None)."""
        forced = os.environ.get("SUBDUB_VIENEU_STEPS")
        text = "Xin chào các bạn, hôm nay chúng ta sẽ cùng tìm hiểu một chủ đề rất thú vị."
        self.synthesize("Xin chào.", self.default_voice, steps=FAST_STEPS, seed=1)

        def timed(steps):
            t0 = time.perf_counter()
            wav = self.synthesize(text, self.default_voice, steps=steps, seed=1)
            dt = time.perf_counter() - t0
            return dt / max(len(wav) / SAMPLE_RATE, 1e-3)
        rtf = timed(DEFAULT_STEPS)
        rtf8 = None
        steps = DEFAULT_STEPS
        if rtf > RTF_LIMIT:
            steps = FAST_STEPS
            rtf8 = timed(FAST_STEPS)
        fake = os.environ.get("SUBDUB_VIENEU_FAKE_RTF")  # test hook
        if fake:
            rtf = rtf8 = float(fake)
            steps = FAST_STEPS
        if forced in ("8", "16"):
            steps = int(forced)
        log.info("warm-up: RTF %.2f at 16 steps%s -> steps %d", rtf,
                 "" if rtf8 is None else ", %.2f at 8 steps" % rtf8, steps)
        return rtf, steps, rtf8


def load_voices(path: str):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    voices = {}
    for name, v in data.get("presets", {}).items():
        voices[name] = {
            "description": v.get("description", ""), "gender": v.get("gender", ""),
            "speaker_emb": np.asarray(v["speaker_emb"], dtype=np.float32),
            "style": np.asarray(v["style"], dtype=np.float32),
        }
    default = data.get("default_voice") or next(iter(voices))
    return voices, default


def voices_meta(path: str):
    """(voices list for hello, default voice) without needing numpy arrays or the model."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        lst = [{"name": n, "gender": v.get("gender", ""), "description": v.get("description", "")}
               for n, v in data.get("presets", {}).items()]
        return lst, data.get("default_voice") or (lst[0]["name"] if lst else "")
    except (OSError, ValueError):
        return [], ""


# ─────────────────────────── host (native mode) ───────────────────────────

class Job:
    __slots__ = ("key", "prio", "seq", "ids")

    def __init__(self, key, prio, seq, id_):
        self.key, self.prio, self.seq, self.ids = key, prio, seq, [id_]


class Host:
    def __init__(self, write):
        self._write = write              # callable(dict), thread-safe
        self.cond = threading.Condition()
        self.state = "missing"
        self.progress = 0.0
        self.error = None
        self.steps = DEFAULT_STEPS
        self.engine = None
        self.voices_list, self.default_voice = voices_meta(VOICES_PATH)
        self.queue: list[Job] = []
        self.pending: dict = {}          # key -> Job (queued or running)
        self.running: Job | None = None
        self.lru: "collections.OrderedDict" = collections.OrderedDict()
        self.seq = 0
        self.stop = False
        self._last_status = 0.0
        self.last_activity = time.monotonic()
        threading.Thread(target=self._worker, name="worker", daemon=True).start()
        threading.Thread(target=self._watchdog, name="watchdog", daemon=True).start()

    # ---- state / messages ----
    def _status_msg(self):
        m = {"type": "status", "state": self.state, "progress": round(self.progress, 4), "steps": self.steps}
        if self.error:
            m["error"] = self.error
        return m

    def set_state(self, state, progress=None, error=None):
        flush = []
        with self.cond:
            self.state = state
            if progress is not None:
                self.progress = progress
            self.error = error
            self._last_status = time.monotonic()
            msg = self._status_msg()
            if state in ("error", "missing", "low-memory", "too-slow"):
                flush = list(self.queue)
                self.queue.clear()
                for j in flush:
                    self.pending.pop(j.key, None)
            self.cond.notify_all()
        self._write(msg)
        for j in flush:
            for id_ in j.ids:
                self._write({"type": "error", "id": id_, "error": FLUSH_CODE.get(state, "not-ready")})

    def _progress(self, frac):
        now = time.monotonic()
        with self.cond:
            self.progress = frac
            if now - self._last_status < 0.5:
                return
            self._last_status = now
            msg = self._status_msg()
        self._write(msg)

    def start(self):
        if IMPORT_ERROR:
            self.state, self.error = "error", MSG_DEPS % IMPORT_ERROR
        elif files_present():
            self.state, self.progress = "idle", 1.0

    def _wake(self):
        """speak/warm: make sure the model gets loaded (once), unless RAM is short."""
        with self.cond:
            self.last_activity = time.monotonic()
            if self.state not in ("idle", "low-memory"):
                return
            avail = available_ram()
            if avail is not None and avail < MIN_FREE_RAM:
                log.warning("only %d MB RAM available, not loading the model", avail // 1_000_000)
                go = False
            else:
                self.state, go = "loading", True
        if go:
            self.set_state("loading", 1.0)
            threading.Thread(target=self._load, name="loader", daemon=True).start()
        else:
            self.set_state("low-memory", 1.0)

    # ---- download / load ----
    def _download(self):
        try:
            ensure_files(self._progress, verify=True)
        except FetchError as e:
            self.set_state("error", error=str(e))
            return
        except Exception as e:
            log.exception("download failed")
            self.set_state("error", error=MSG_NO_NET if isinstance(e, OSError) else MSG_BAD_FILE)
            return
        self.voices_list, self.default_voice = voices_meta(VOICES_PATH)
        self.set_state("idle", 1.0)

    def _load(self):
        try:
            log.info("loading model, RSS %s MB", rss_mb())
            eng = Engine(MODEL_DIR, VOICES_PATH)
            _, steps, rtf8 = eng.warm_up()
            log.info("model ready, RSS %s MB", rss_mb())
        except ImportError as e:
            log.exception("import failed")
            self.set_state("error", error=MSG_DEPS % e)
            return
        except Exception as e:
            log.exception("model load failed")
            self.set_state("error", error=MSG_LOAD % e)
            return
        self.voices_list = [{"name": n, "gender": v["gender"], "description": v["description"]}
                            for n, v in eng.voices.items()]
        self.default_voice = eng.default_voice
        self.steps = steps
        self.last_activity = time.monotonic()
        if rtf8 is not None and rtf8 > RTF_TOO_SLOW:
            del eng  # free the memory; the extension falls back to another voice
            self.set_state("too-slow", 1.0)
            return
        self.engine = eng
        self.set_state("ready", 1.0)

    def _watchdog(self):
        while True:
            time.sleep(min(1.0, IDLE_SECONDS / 4))
            with self.cond:
                busy = self.queue or self.running or self.state in ("downloading", "loading")
                idle_for = time.monotonic() - self.last_activity
            if not busy and idle_for > IDLE_SECONDS:
                log.info("no speak/warm for %.0fs, exiting", idle_for)
                os._exit(0)

    # ---- incoming messages ----
    def handle(self, msg):
        t = msg.get("type") if isinstance(msg, dict) else None
        if t == "hello":
            with self.cond:
                m = {"type": "hello", "proto": PROTO, "state": self.state,
                     "progress": 0 if self.state == "missing" else (round(self.progress, 4) if self.state == "downloading" else 1.0),
                     "voices": self.voices_list, "defaultVoice": self.default_voice, "steps": self.steps}
                if self.error:
                    m["error"] = self.error
            self._write(m)
        elif t == "download":
            with self.cond:
                if self.state not in ("missing", "error") or IMPORT_ERROR:
                    return
                self.state, self.progress, self.error = "downloading", 0.0, None
            self.set_state("downloading", 0.0)
            threading.Thread(target=self._download, name="download", daemon=True).start()
        elif t == "warm":
            self._wake()
        elif t == "speak":
            self._speak(msg)
        elif t == "cancel":
            self._cancel(msg.get("ids"))

    def _norm_voice(self, voice):
        names = {v["name"] for v in self.voices_list}
        return voice if voice in names else self.default_voice

    def _speak(self, msg):
        id_ = str(msg.get("id", ""))
        text = msg.get("text")
        text = text if isinstance(text, str) else ""
        prio = 0 if msg.get("prio", 0) == 0 else 1
        voice = self._norm_voice(msg.get("voice"))
        key = (voice, text)
        if not text.strip():
            return self._reply_audio([id_], wav_bytes([]), 0.0)
        with self.cond:
            hit = self.lru.get(key)
            err = None
            if hit is not None:
                self.lru.move_to_end(key)
            else:
                err = {"missing": "model-missing", "error": "not-ready", "too-slow": "too-slow",
                       "downloading": "model-missing"}.get(self.state)
                self.last_activity = time.monotonic()
                if err is None:
                    job = self.pending.get(key)
                    if job:
                        job.ids.append(id_)
                        job.prio = min(job.prio, prio)
                    else:
                        self.seq += 1
                        job = Job(key, prio, self.seq, id_)
                        self.pending[key] = job
                        self.queue.append(job)
                    self.cond.notify_all()
        if hit is not None:
            self.last_activity = time.monotonic()
            self._reply_audio([id_], hit[0], hit[1])
        elif err is not None:
            self._write({"type": "error", "id": id_, "error": err})
        else:
            self._wake()  # loads the model if needed; a tripped RAM guard flushes the queue with "low-memory"

    def _cancel(self, ids):
        dropped = []
        with self.cond:
            if isinstance(ids, list):
                want = {str(i) for i in ids}
                for j in list(self.queue):
                    gone = [i for i in j.ids if i in want]
                    if gone:
                        j.ids = [i for i in j.ids if i not in want]
                        dropped += gone
                        if not j.ids:
                            self.queue.remove(j)
                            self.pending.pop(j.key, None)
            else:
                for j in list(self.queue):
                    if j.prio == 1:
                        self.queue.remove(j)
                        self.pending.pop(j.key, None)
                        dropped += j.ids
        for i in dropped:
            self._write({"type": "error", "id": i, "error": "cancelled"})

    # ---- worker ----
    def _worker(self):
        while True:
            with self.cond:
                while not self.stop and not (self.queue and self.state == "ready"):
                    self.cond.wait()
                if self.stop:
                    return
                job = min(self.queue, key=lambda j: (j.prio, j.seq))
                self.queue.remove(job)
                self.running = job
                steps = self.steps
            voice, text = job.key
            try:
                t0 = time.perf_counter()
                wav = self.engine.synthesize(text, voice, steps=steps)
                data, dur = wav_bytes(wav), len(wav) / SAMPLE_RATE
                log.info("synth %d chars -> %.2fs audio in %.2fs (steps %d)", len(text), dur,
                         time.perf_counter() - t0, steps)
                result = (data, dur)
            except Exception:
                log.exception("synthesis failed")
                result = None
            with self.cond:
                self.running = None
                self.last_activity = time.monotonic()
                self.pending.pop(job.key, None)
                ids = list(job.ids)
                if result:
                    self.lru[job.key] = result
                    while len(self.lru) > LRU_SIZE:
                        self.lru.popitem(last=False)
            if result:
                self._reply_audio(ids, *result)
            else:
                for i in ids:
                    self._write({"type": "error", "id": i, "error": "synth-failed"})

    def _reply_audio(self, ids, data, dur):
        b64 = base64.b64encode(data).decode("ascii")
        n = max(1, -(-len(b64) // MAX_SLICE))
        for id_ in ids:
            for p in range(n):
                self._write({"type": "audio", "id": id_, "part": p, "parts": n, "sr": SAMPLE_RATE,
                             "dur": round(dur, 3), "b64": b64[p * MAX_SLICE:(p + 1) * MAX_SLICE]})

    def shutdown(self):
        with self.cond:
            self.stop = True
            self.cond.notify_all()


# ───────────────────────────── native loop ─────────────────────────────

def native_main() -> int:
    setup_logging()
    log.info("host start, home=%s, pid=%d", HOME, os.getpid())
    lower_priority()
    # keep the real stdout for framing only; anything else that writes to fd 1/2 goes to the bin
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(0, os.O_BINARY)
        msvcrt.setmode(1, os.O_BINARY)
    out_fd = os.dup(1)
    if os.name == "nt":
        msvcrt.setmode(out_fd, os.O_BINARY)
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    os.close(devnull)
    sys.stdout = open(os.devnull, "w")
    sys.stderr = sys.stdout
    stdout = os.fdopen(out_fd, "wb")
    stdin = sys.stdin.buffer
    wlock = threading.Lock()

    def write(obj):
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(data) >= MAX_FRAME:
            log.error("dropping oversize message (%d bytes)", len(data))
            return
        try:
            with wlock:
                stdout.write(struct.pack("<I", len(data)) + data)
                stdout.flush()
        except (OSError, ValueError):
            log.info("stdout closed, exiting")
            os._exit(0)

    host = Host(write)
    host.start()
    while True:
        head = stdin.read(4)
        if len(head) < 4:
            break
        (n,) = struct.unpack("<I", head)
        if n > 256 * 1024 * 1024:
            log.error("absurd frame length %d, exiting", n)
            break
        body = stdin.read(n)
        if len(body) < n:
            break
        try:
            host.handle(json.loads(body.decode("utf-8")))
        except Exception:
            log.exception("bad message")
    log.info("stdin closed, exiting")
    host.shutdown()
    os._exit(0)


# ───────────────────────────── console modes ─────────────────────────────

def _console_utf8():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def download_main() -> int:
    """Installer step: fetch the model, load it, warm it up. Vietnamese console output."""
    _console_utf8()
    setup_logging(console=False)
    if IMPORT_ERROR:
        print("Lỗi: " + (MSG_DEPS % IMPORT_ERROR))
        return 1
    last = [0.0, -1]

    def prog(frac):
        now = time.monotonic()
        if now - last[0] > 0.25 or frac >= 1.0:
            last[0] = now
            total = sum(p[3] for p in _plan()) / 1e6
            bar = "#" * int(frac * 30)
            line = "   [%-30s] %3d%%  (%d/%d MB)" % (bar, int(frac * 100), int(frac * total), int(total))
            if sys.stdout.isatty():
                print("\r" + line, end="", flush=True)
            elif frac >= 1.0 or int(frac * 10) != last[1]:
                last[1] = int(frac * 10)
                print(line, flush=True)

    print("   Đang kiểm tra / tải mô hình giọng (khoảng 280 MB, chỉ tải một lần)...")
    try:
        ensure_files(prog, verify=True)
    except FetchError as e:
        print("\n   LỖI: %s" % e)
        return 1
    except Exception as e:
        log.exception("download failed")
        print("\n   LỖI: %s (%s)" % (MSG_NO_NET, e))
        return 1
    print("\n   Đã tải xong và kiểm tra tệp: đạt.")
    print("   Đang nạp mô hình và chạy thử (vài giây)...")
    try:
        eng = Engine(MODEL_DIR, VOICES_PATH)
        rtf, steps, rtf8 = eng.warm_up()
    except ImportError as e:
        log.exception("import failed")
        msg = MSG_DEPS % e
        if "DLL" in str(e):
            msg += " Có thể máy thiếu 'Microsoft Visual C++ Redistributable' (tải tại https://aka.ms/vs/17/release/vc_redist.x64.exe)."
        print("   LỖI: " + msg)
        return 1
    except Exception as e:
        log.exception("load failed")
        print("   LỖI: " + (MSG_LOAD % e))
        return 1
    print("   Chạy thử xong: tốc độ %.2f lần thời gian thực -> chất lượng %s." %
          (rtf, "tiêu chuẩn" if steps == DEFAULT_STEPS else "nhanh (máy hơi chậm)"))
    if rtf8 is not None and rtf8 > RTF_TOO_SLOW:
        print("   Lưu ý: máy hơi yếu cho giọng này, SubDub sẽ tạm dùng giọng Google khi cần.")
    return 0


def say_main(argv) -> int:
    _console_utf8()
    setup_logging(console=True)
    args = {"--say": None, "--voice": None, "--out": "out.wav", "--steps": str(DEFAULT_STEPS)}
    for k in args:
        if k in argv:
            args[k] = argv[argv.index(k) + 1]
    eng = Engine(MODEL_DIR, VOICES_PATH)
    t0 = time.perf_counter()
    wav = eng.synthesize(args["--say"], args["--voice"], steps=int(args["--steps"]))
    dt = time.perf_counter() - t0
    with open(args["--out"], "wb") as f:
        f.write(wav_bytes(wav))
    print("%.2fs audio in %.2fs (RTF %.2f) -> %s" % (len(wav) / SAMPLE_RATE, dt, dt / max(len(wav) / SAMPLE_RATE, 1e-3), args["--out"]))
    return 0


if __name__ == "__main__":
    if "--download" in sys.argv:
        sys.exit(download_main())
    if "--say" in sys.argv:
        sys.exit(say_main(sys.argv))
    sys.exit(native_main())
