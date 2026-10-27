# Vendored third-party runtime

All files below are copied unmodified from the npm registry tarballs (fetched with `npm pack`, 2026-10-27).
They contain no remote code loading: the only URL string in them is a documentation link. Everything is loaded
through `lib/piper-worker.js` from this folder (`script-src 'self' 'wasm-unsafe-eval'`). The voice model itself
is data and is NOT stored here (downloaded once from Hugging Face, see `lib/piper-text.js`).

| Path | Package | Version | Size | License |
| --- | --- | --- | --- | --- |
| `onnxruntime-web/ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` | `onnxruntime-web` (CPU/WASM build; Microsoft) | 1.30.0 | 49 KB + 24 KB + 13.6 MB | MIT (`onnxruntime-web/LICENSE`, copied from github.com/microsoft/onnxruntime) |
| `piper-wasm/piper_phonemize.js`, `.wasm`, `.data` | `@diffusionstudio/piper-wasm` (WASM build of rhasspy `piper-phonemize` + `espeak-ng`, emscripten 3.1.47) | 1.0.0 | 121 KB + 635 KB + 18.1 MB | package metadata: MIT; `piper-phonemize` is MIT (`LICENSE-piper-phonemize-MIT`); the bundled **espeak-ng** (phoneme rules in `.wasm`, voices/dictionaries in `.data`) is **GPL-3.0-or-later** (`LICENSE-espeak-ng-GPL-3.0`) |

Notes
- The inference code in `lib/piper-worker.js` follows the flow of `@mintplex-labs/piper-tts-web` 1.0.5 (MIT, a fork of
  `@diffusionstudio/vits-web`) but is written for this extension: single-threaded ORT session, model read from Cache
  Storage, no OPFS, no remote voice list, no CDN URLs.
- Distributing this extension (e.g. publishing it) means distributing espeak-ng under GPL-3.0; keep the license file
  and offer the corresponding source (https://github.com/espeak-ng/espeak-ng, rhasspy fork https://github.com/rhasspy/espeak-ng).
- Voice `vi_VN-vais1000-medium` (rhasspy/piper-voices): dataset VAIS-1000, license CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/); attribution: "VAIS-1000 Vietnamese speech synthesis corpus".
