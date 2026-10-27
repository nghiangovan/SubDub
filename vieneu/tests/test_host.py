"""Tests for vieneu/host.py.

Run (needs numpy, onnxruntime, sea-g2p; the model files must be present):
    python vieneu/tests/test_host.py            # or: python -m unittest vieneu/tests/test_host.py

Environment:
  SUBDUB_VIENEU_MODEL_DIR / SUBDUB_VIENEU_VOICES   point at already-downloaded files (else <host dir>/models)
  SUBDUB_TEST_HOST_CMD     run the protocol tests against an installed launcher (run-host.sh / run-host.bat)
                           instead of `python host.py`
Parity tests need the original `vieneu` package importable and are skipped otherwise.
"""
import base64
import http.server
import io
import json
import os
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
HOST_DIR = os.path.dirname(HERE)
sys.path.insert(0, HOST_DIR)
import host  # noqa: E402

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

HAVE_MODEL = host.files_present()
try:
    from vieneu.v3nano import OnnxV3NanoEngine
    from vieneu_utils.core_utils import gaps_to_silence, join_audio_chunks as orig_join
    from vieneu_utils.phonemize_text import normalize_to_chunks_v3_with_gaps, phonemize_text_with_emotions
    HAVE_ORIG = True
except Exception:
    HAVE_ORIG = False

SENTENCES = [
    "Xin chào các bạn.",
    "Hôm nay là ngày 27/10/2026, nhiệt độ ngoài trời là 32°C.",
    "Giá vàng tăng lên 85.000.000 đồng, tương đương khoảng 3,5 triệu đô la hay $3500.",
    "Tôi dùng iPhone, Google Chrome và YouTube để học tiếng Anh mỗi ngày với giáo viên người Mỹ.",
    "Thế à? Không thể tin được! Anh nói \"Rồi sao nữa? Mình phải làm đến bao giờ?\", đúng không anh?",
    "Dòng một của đoạn văn.\nDòng hai là một câu dài hơn một chút để không bị gộp.\n\nĐoạn mới bắt đầu ở đây nhé các bạn.",
    # >140 chars, several sentences
    "Mùa xuân đã về trên khắp các nẻo đường đất nước. Những cánh đồng lúa xanh mướt trải dài đến tận chân trời, "
    "còn những ngọn đồi phủ đầy hoa mận trắng muốt. Người dân rộn ràng chuẩn bị đón Tết cổ truyền với bao niềm vui.",
    # one very long sentence without a stop (forces the word-level splitter)
    "Sau khi hoàn thành xong tất cả các công việc quan trọng trong ngày hôm nay chúng tôi quyết định cùng nhau đi "
    "dạo quanh hồ để hít thở không khí trong lành và nói chuyện về những kế hoạch lớn cho năm tới của cả nhóm "
    "vì chúng tôi tin rằng nếu cố gắng hết mình thì mọi điều tốt đẹp nhất sẽ đến với tất cả mọi người",
]


class Client:
    """Speaks Chrome's native-messaging framing with a host.py subprocess."""

    def __init__(self, env_extra=None, home=None):
        self.home = home or tempfile.mkdtemp(prefix="vieneu-home-")
        cmd = os.environ.get("SUBDUB_TEST_HOST_CMD")
        env = dict(os.environ)
        if not cmd:  # an installed launcher keeps its own data dir
            env["SUBDUB_VIENEU_HOME"] = self.home
        env.update(env_extra or {})
        argv = [cmd] if cmd else [sys.executable, "-I", os.path.join(HOST_DIR, "host.py")]
        self.p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env=env)
        self.q = queue.Queue()
        self.frame_sizes = []
        self.stray = b""
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        out = self.p.stdout
        while True:
            head = out.read(4)
            if len(head) < 4:
                self.stray = head
                self.q.put(None)
                return
            (n,) = struct.unpack("<I", head)
            body = out.read(n)
            self.frame_sizes.append(n)
            self.q.put((time.monotonic(), json.loads(body.decode("utf-8"))))

    def send(self, obj):
        data = json.dumps(obj).encode("utf-8")
        self.p.stdin.write(struct.pack("<I", len(data)) + data)
        self.p.stdin.flush()

    def recv(self, timeout=60):
        item = self.q.get(timeout=timeout)
        if item is None:
            raise EOFError("host closed stdout")
        return item

    def wait_for(self, pred, timeout=60):
        end = time.monotonic() + timeout
        while True:
            t, m = self.recv(max(0.1, end - time.monotonic()))
            if pred(m):
                return t, m

    def rss_mb(self):
        with open("/proc/%d/status" % self.p.pid) as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) // 1024

    def wait_ready(self, timeout=180):
        self.send({"type": "warm"})
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.send({"type": "hello"})
            _, m = self.wait_for(lambda m: m["type"] == "hello")
            if m["state"] == "ready":
                return m
            if m["state"] in ("error", "missing", "low-memory", "too-slow"):
                raise AssertionError("host state %s: %s" % (m["state"], m.get("error")))
            time.sleep(0.5)
        raise AssertionError("host never became ready")

    def collect_audio(self, ids, timeout=120):
        """Wait for complete audio (or error) for every id. Returns {id: ('audio', wavbytes, t, dur, parts) | ('error', msg, t)}."""
        parts, res = {}, {}
        end = time.monotonic() + timeout
        while len(res) < len(ids):
            t, m = self.recv(max(0.1, end - time.monotonic()))
            if m["type"] == "audio" and m["id"] in ids:
                d = parts.setdefault(m["id"], {})
                d[m["part"]] = m["b64"]
                assert len(m["b64"]) <= 600000
                if len(d) == m["parts"]:
                    data = base64.b64decode("".join(d[i] for i in range(m["parts"])))
                    res[m["id"]] = ("audio", data, t, m["dur"], m["parts"])
            elif m["type"] == "error" and m.get("id") in ids:
                res[m["id"]] = ("error", m["error"], t)
        return res

    def close(self):
        try:
            self.p.stdin.close()
        except OSError:
            pass
        try:
            self.p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.p.kill()


def read_wav(data):
    w = wave.open(io.BytesIO(data))
    return w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()


# ───────────────────────────── pure text / parity ─────────────────────────────

@unittest.skipUnless(HAVE_ORIG, "original vieneu package not importable")
class ParityText(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.front = host.TextFront()

    def test_chunks_and_gaps_match_original(self):
        for text in SENTENCES:
            with self.subTest(text=text[:40]):
                mine = self.front.chunks(text, max_chars=140)
                ref = normalize_to_chunks_v3_with_gaps(text, max_chars=140)
                self.assertEqual(mine[0], ref[0])
                self.assertEqual(mine[1], ref[1])
                for ch in mine[0]:
                    self.assertLessEqual(len(ch), 140 + 15 + 21)

    def test_phonemes_match_original(self):
        n = 0
        for text in SENTENCES:
            for ch in self.front.chunks(text)[0]:
                self.assertEqual(self.front.phonemes(ch), phonemize_text_with_emotions(ch), ch)
                n += 1
        self.assertGreaterEqual(n, 10)


@unittest.skipUnless(HAVE_ORIG and HAVE_MODEL, "needs original vieneu package and model files")
class ParityWave(unittest.TestCase):
    def test_waveform_matches_original(self):
        eng = host.Engine(host.MODEL_DIR, host.VOICES_PATH, threads=4)
        ref = OnnxV3NanoEngine(local_dir=host.MODEL_DIR, threads=4)
        for text, voice in ((SENTENCES[1], "Trúc Ly"), (SENTENCES[6], "Minh Quân")):
            with self.subTest(text=text[:30]):
                v = eng.voices[voice]
                chunks, gaps = normalize_to_chunks_v3_with_gaps(text, max_chars=140)
                wavs = [ref.infer(phonemize_text_with_emotions(c), v["speaker_emb"], v["style"],
                                  steps=16, cfg=3.0, seed=7 + i) for i, c in enumerate(chunks)]
                expect = orig_join(wavs, 24000, silence_ps=gaps_to_silence(gaps))
                got = eng.synthesize(text, voice, steps=16, cfg=3.0, seed=7)
                self.assertEqual(got.shape, expect.shape)
                diff = float(np.max(np.abs(got - expect)))
                print("\n  parity %-30r chunks=%d samples=%d max|diff|=%.2e" % (text[:30], len(chunks), got.size, diff))
                self.assertLess(diff, 1e-4)


class TextBasics(unittest.TestCase):
    def test_wav_bytes_header(self):
        if np is None:
            self.skipTest("numpy missing")
        d = host.wav_bytes(np.zeros(100, dtype=np.float32))
        self.assertEqual(read_wav(d), (1, 2, 24000, 100))
        self.assertEqual(read_wav(host.wav_bytes(np.zeros(0, dtype=np.float32))), (1, 2, 24000, 0))

    def test_sentence_split_keeps_decimals_and_quotes(self):
        self.assertEqual(host.split_into_sentences("Giá 3.5 triệu. Hết!"), ["Giá 3.5 triệu.", "Hết!"])
        self.assertEqual(len(host.split_into_sentences('Anh nói "đi đâu? về đâu?" rồi đi.')), 1)


# ───────────────────────────── downloads ─────────────────────────────

class _Handler(http.server.BaseHTTPRequestHandler):
    data = b""

    def log_message(self, *a):
        pass

    def do_GET(self):
        rng = self.headers.get("Range")
        start = int(rng.split("=")[1].split("-")[0]) if rng else 0
        body = self.data[start:]
        self.send_response(206 if rng else 200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Downloads(unittest.TestCase):
    def setUp(self):
        _Handler.data = os.urandom(300_000)
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/f" % self.srv.server_address[1]
        self.dir = tempfile.mkdtemp(prefix="vieneu-dl-")

    def tearDown(self):
        self.srv.shutdown()

    def test_ok_and_resume(self):
        import hashlib
        dest = os.path.join(self.dir, "a.bin")
        sha = hashlib.sha256(_Handler.data).hexdigest()
        with open(dest + ".part", "wb") as f:  # simulate an interrupted earlier run
            f.write(_Handler.data[:100_000])
        seen = []
        host._download_one(self.url, dest, len(_Handler.data), sha, None, seen.append)
        self.assertEqual(open(dest, "rb").read(), _Handler.data)
        self.assertFalse(os.path.exists(dest + ".part"))
        self.assertEqual(seen[0] > 100_000, True)

    def test_bad_sha_rejected(self):
        dest = os.path.join(self.dir, "b.bin")
        with self.assertRaises(host.FetchError):
            host._download_one(self.url, dest, len(_Handler.data), "0" * 64, None, lambda n: None)
        self.assertFalse(os.path.exists(dest))
        self.assertFalse(os.path.exists(dest + ".part"))

    def test_git_blob_sha1(self):
        import hashlib
        dest = os.path.join(self.dir, "c.bin")
        d = _Handler.data
        sha1 = hashlib.sha1(b"blob %d\0" % len(d) + d).hexdigest()
        host._download_one(self.url, dest, len(d), None, sha1, lambda n: None)
        self.assertTrue(os.path.exists(dest))

    def test_unreachable(self):
        dest = os.path.join(self.dir, "d.bin")
        self.srv.shutdown()
        self.srv.server_close()
        orig_sleep, host.time.sleep = host.time.sleep, lambda s: None
        try:
            with self.assertRaises(host.FetchError):
                host._download_one(self.url, dest, 10, None, None, lambda n: None)
        finally:
            host.time.sleep = orig_sleep

    def test_pinned_table_sane(self):
        for name, url, size, s256, s1 in host.MODEL_FILES + [host.VOICES_FILE]:
            self.assertTrue(url.startswith("https://"))
            self.assertGreater(size, 1000)
            self.assertTrue((s256 and len(s256) == 64) or (s1 and len(s1) == 40), name)
        self.assertIn(host.HF_REV, host.MODEL_FILES[0][1])


# ───────────────────────────── protocol ─────────────────────────────

class ProtocolMissing(unittest.TestCase):
    def test_missing_model_state(self):
        empty = tempfile.mkdtemp(prefix="vieneu-empty-")
        c = Client({"SUBDUB_VIENEU_MODEL_DIR": os.path.join(empty, "m"),
                    "SUBDUB_VIENEU_VOICES": os.path.join(empty, "v.json")})
        try:
            c.send({"type": "hello"})
            _, m = c.wait_for(lambda m: m["type"] == "hello")
            self.assertEqual((m["proto"], m["state"]), (1, "missing"))
            self.assertEqual(m["progress"], 0)
            c.send({"type": "speak", "id": "x", "text": "Xin chào", "voice": "Trúc Ly", "prio": 0})
            r = c.collect_audio({"x"}, 10)
            self.assertEqual(r["x"][:2], ("error", "model-missing"))
        finally:
            c.close()
        self.assertEqual(c.p.returncode, 0)


@unittest.skipUnless(HAVE_MODEL or os.environ.get("SUBDUB_TEST_HOST_CMD"), "model files not present")
class Lazy(unittest.TestCase):
    def hello(self, c):
        c.send({"type": "hello"})
        return c.wait_for(lambda m: m["type"] == "hello")[1]

    def test_hello_does_not_load_then_warm_loads(self):
        c = Client()
        try:
            h = self.hello(c)
            self.assertEqual((h["state"], h["progress"]), ("idle", 1))
            self.assertEqual(len(h["voices"]), 11)
            time.sleep(1.5)
            self.assertEqual(self.hello(c)["state"], "idle")
            before = c.rss_mb() if sys.platform.startswith("linux") else 0
            c.send({"type": "warm"})
            _, m = c.wait_for(lambda m: m["type"] == "status" and m["state"] == "loading")
            _, m = c.wait_for(lambda m: m["type"] == "status" and m["state"] == "ready", 120)
            self.assertIn(m["steps"], (8, 16))
            after = c.rss_mb() if sys.platform.startswith("linux") else 0
            print("\n  lazy: idle RSS %d MB -> ready RSS %d MB, steps %d" % (before, after, m["steps"]))
            if before:
                self.assertLess(before, 120)
                self.assertGreater(after, before + 200)
            self.assertEqual(self.hello(c)["state"], "ready")
        finally:
            c.close()

    def test_speak_triggers_load(self):
        c = Client()
        try:
            self.assertEqual(self.hello(c)["state"], "idle")
            c.send({"type": "speak", "id": "a", "text": "Xin chào các bạn.", "voice": "Trúc Ly", "prio": 0})
            r = c.collect_audio({"a"}, 150)["a"]
            self.assertEqual(r[0], "audio")
            self.assertEqual(self.hello(c)["state"], "ready")
        finally:
            c.close()

    def test_idle_exit_without_speak(self):
        c = Client({"SUBDUB_VIENEU_IDLE_SECONDS": "2"})
        try:
            self.assertEqual(self.hello(c)["state"], "idle")
            t0 = time.monotonic()
            c.p.wait(timeout=10)  # stdin stays open: the host leaves on its own
            self.assertEqual(c.p.returncode, 0)
            self.assertLess(time.monotonic() - t0, 6)
        finally:
            c.close()

    def test_idle_exit_after_load(self):
        c = Client({"SUBDUB_VIENEU_IDLE_SECONDS": "4"})
        try:
            c.wait_ready()
            t0 = time.monotonic()
            c.p.wait(timeout=15)
            self.assertEqual(c.p.returncode, 0)
            self.assertGreater(time.monotonic() - t0, 2)
        finally:
            c.close()

    def test_hello_does_not_extend_life(self):
        c = Client({"SUBDUB_VIENEU_IDLE_SECONDS": "3"})
        try:
            end = time.monotonic() + 8
            while c.p.poll() is None and time.monotonic() < end:
                try:
                    self.hello(c)
                except (EOFError, OSError, queue.Empty):
                    break
                time.sleep(0.5)
            self.assertEqual(c.p.wait(timeout=5), 0)
        finally:
            c.close()

    def test_low_memory_guard(self):
        c = Client({"SUBDUB_VIENEU_FAKE_AVAIL_MB": "500"})
        try:
            c.send({"type": "speak", "id": "m", "text": "Xin chào các bạn.", "voice": "Trúc Ly", "prio": 0})
            r = c.collect_audio({"m"}, 20)["m"]
            self.assertEqual(r[:2], ("error", "low-memory"))
            self.assertEqual(self.hello(c)["state"], "low-memory")
            if sys.platform.startswith("linux"):
                self.assertLess(c.rss_mb(), 120)  # the model was not loaded
        finally:
            c.close()

    def test_too_slow_state(self):
        c = Client({"SUBDUB_VIENEU_FAKE_RTF": "1.5"})
        try:
            c.send({"type": "warm"})
            c.wait_for(lambda m: m["type"] == "status" and m["state"] == "too-slow", 120)
            c.send({"type": "speak", "id": "t", "text": "Xin chào các bạn.", "voice": "Trúc Ly", "prio": 0})
            self.assertEqual(c.collect_audio({"t"}, 10)["t"][:2], ("error", "too-slow"))
        finally:
            c.close()


@unittest.skipUnless(HAVE_MODEL or os.environ.get("SUBDUB_TEST_HOST_CMD"), "model files not present")
class Protocol(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = Client()
        cls.hello = cls.c.wait_ready()

    @classmethod
    def tearDownClass(cls):
        cls.c.close()
        cls.exit_code = cls.c.p.returncode

    def speak(self, id_, text, prio=0, voice="Trúc Ly"):
        self.c.send({"type": "speak", "id": id_, "text": text, "voice": voice, "prio": prio})

    def test_a_hello(self):
        h = self.hello
        self.assertEqual(h["proto"], 1)
        self.assertEqual(h["state"], "ready")
        self.assertEqual(h["progress"], 1)
        self.assertIn(h["steps"], (8, 16))
        names = [v["name"] for v in h["voices"]]
        self.assertEqual(len(names), 11)
        self.assertIn("Trúc Ly", names)
        self.assertIn(h["defaultVoice"], names)
        self.assertEqual(set(h["voices"][0]), {"name", "gender", "description"})
        print("\n  hello: steps=%d defaultVoice=%s voices=%d" % (h["steps"], h["defaultVoice"], len(names)))

    def test_b_speak_valid_wav_and_lru(self):
        text = "Xin chào các bạn. Hôm nay chúng ta học về trí tuệ nhân tạo."
        t0 = time.monotonic()
        self.speak("s1", text)
        r = self.c.collect_audio({"s1"})["s1"]
        t_first = r[2] - t0
        ch, sw, sr, n = read_wav(r[1])
        self.assertEqual((ch, sw, sr), (1, 2, 24000))
        self.assertAlmostEqual(n / sr, r[3], delta=0.01)
        self.assertGreater(r[3], 2.0)
        self.assertEqual(r[4], 1)
        # repeat: LRU hit, instant and byte-identical
        t1 = time.monotonic()
        self.speak("s2", text)
        r2 = self.c.collect_audio({"s2"})["s2"]
        self.assertLess(r2[2] - t1, 0.5)
        self.assertEqual(r2[1], r[1])
        print("\n  speak: %.2fs audio in %.2fs (RTF %.2f, steps %d); LRU repeat %.3fs" % (
            r[3], t_first, t_first / r[3], self.hello["steps"], r2[2] - t1))

    def test_c_unknown_voice_and_empty(self):
        self.speak("u1", "Chào bạn nhé.", voice="Không có giọng này")
        self.speak("e1", "   ")
        r = self.c.collect_audio({"u1", "e1"})
        self.assertEqual(read_wav(r["u1"][1])[2], 24000)
        self.assertGreater(read_wav(r["u1"][1])[3], 1000)
        self.assertEqual(read_wav(r["e1"][1]), (1, 2, 24000, 0))

    def test_d_dedupe_attaches_and_upgrades(self):
        busy = "Đây là một câu khá dài để máy bận trong một lúc, " * 3
        self.speak("busy", busy, prio=0)
        time.sleep(0.3)
        same = "Câu giống hệt nhau được gửi hai lần."
        self.speak("d1", same, prio=1)
        self.speak("d2", same, prio=0)  # same (voice,text): attach to d1's job and upgrade its priority
        r = self.c.collect_audio({"busy", "d1", "d2"})
        self.assertEqual(r["d1"][0], "audio")
        self.assertEqual(r["d1"][1], r["d2"][1])  # one synthesis (random noise would differ otherwise)

    def test_e_priority_and_cancel(self):
        busy = "Câu dài đang chạy để chặn hàng đợi trong chốc lát nhé các bạn, " * 3
        self.speak("run", busy, prio=0)
        time.sleep(0.3)
        for i in range(3):
            self.speak("pf%d" % i, "Câu dự phòng số %d của hàng đợi." % i, prio=1)
        self.speak("now", "Câu cần đọc ngay lập tức.", prio=0)
        self.c.send({"type": "cancel"})
        r = self.c.collect_audio({"run", "now", "pf0", "pf1", "pf2"})
        for i in range(3):
            self.assertEqual(r["pf%d" % i][:2], ("error", "cancelled"))
        self.assertEqual(r["run"][0], "audio")
        self.assertEqual(r["now"][0], "audio")
        self.assertLess(r["run"][2], r["now"][2])  # running job finished first, then the prio-0 one

        # cancel by ids, and prio ordering without cancel
        self.speak("run2", busy + " ", prio=0)
        time.sleep(0.3)
        self.speak("lo", "Câu ưu tiên thấp trước.", prio=1)
        self.speak("hi", "Câu ưu tiên cao sau.", prio=0)
        self.speak("kill", "Câu sẽ bị huỷ theo id.", prio=1)
        self.c.send({"type": "cancel", "ids": ["kill"]})
        r = self.c.collect_audio({"run2", "lo", "hi", "kill"})
        self.assertEqual(r["kill"][:2], ("error", "cancelled"))
        self.assertLess(r["hi"][2], r["lo"][2])

    def test_f_large_wav_is_sliced(self):
        sentence = "Hôm nay chúng ta cùng nhau tìm hiểu về lịch sử của một thành phố rất cổ kính và đẹp đẽ. "
        self.speak("big", sentence * 6)
        r = self.c.collect_audio({"big"}, 240)["big"]
        self.assertEqual(r[0], "audio")
        self.assertGreater(len(r[1]), 1_000_000)
        self.assertGreaterEqual(r[4], 2)
        ch, sw, sr, n = read_wav(r[1])
        self.assertEqual((ch, sw, sr), (1, 2, 24000))
        self.assertLess(max(self.c.frame_sizes), 1_000_000)
        print("\n  big wav: %d bytes, %d parts, largest frame %d bytes, %.1fs audio" % (
            len(r[1]), r[4], max(self.c.frame_sizes), r[3]))

    def test_z_exit_on_stdin_close_and_clean_stdout(self):
        c = Client()
        c.wait_ready()
        t0 = time.monotonic()
        c.p.stdin.close()
        c.p.wait(timeout=10)
        self.assertEqual(c.p.returncode, 0)
        self.assertLess(time.monotonic() - t0, 5)
        time.sleep(0.2)
        self.assertEqual(c.stray, b"")  # nothing but whole frames came out of stdout


if __name__ == "__main__":
    unittest.main(verbosity=2)
