#!/usr/bin/env bash
# Linux installer for the optional SubDub VieNeu voice (used for development / end-to-end tests).
# Layout mirrors the Windows install: <install dir>/{venv,host.py,run-host.sh,com.subdub.vieneu.json,models/}
#
#   bash install.sh [--profile-dir DIR]... [--manifest-dir DIR]... [--no-download]
#
#   --profile-dir DIR   also register the host for a Chrome user-data dir (writes DIR/NativeMessagingHosts/)
#   --manifest-dir DIR  register into DIR instead of ~/.config/google-chrome/NativeMessagingHosts (repeatable)
#   --no-download       skip pre-downloading the model
# Env: SUBDUB_VIENEU_INSTALL_DIR overrides ~/.local/share/subdub/vieneu
set -euo pipefail

HOST_NAME="com.subdub.vieneu"
EXT_ORIGIN="chrome-extension://cbbadcdbccjlgmmnihmnlpbehdcidoeh/"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${SUBDUB_VIENEU_INSTALL_DIR:-$HOME/.local/share/subdub/vieneu}"
MANIFEST_DIRS=()
EXTRA_DIRS=()
DOWNLOAD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --profile-dir) EXTRA_DIRS+=("$2/NativeMessagingHosts"); shift 2;;
    --manifest-dir) MANIFEST_DIRS+=("$2"); shift 2;;
    --no-download) DOWNLOAD=0; shift;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
done
[ ${#MANIFEST_DIRS[@]} -eq 0 ] && MANIFEST_DIRS=("$HOME/.config/google-chrome/NativeMessagingHosts")
MANIFEST_DIRS+=("${EXTRA_DIRS[@]}")

echo "[1/5] Installing into $DEST"
mkdir -p "$DEST"

echo "[2/5] Creating the Python environment"
if [ ! -x "$DEST/venv/bin/python" ]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 "$DEST/venv"
  else
    python3 -m venv "$DEST/venv"
  fi
fi
if command -v uv >/dev/null 2>&1; then
  uv pip install --python "$DEST/venv/bin/python" -r "$SRC/requirements.txt"
else
  "$DEST/venv/bin/python" -m pip install --quiet -r "$SRC/requirements.txt"
fi

echo "[3/5] Copying the host"
cp "$SRC/host.py" "$DEST/host.py"
cp "$SRC/requirements.txt" "$DEST/requirements.txt"
cat > "$DEST/run-host.sh" <<'RUN'
#!/bin/sh
D="$(cd "$(dirname "$0")" && pwd)"
exec "$D/venv/bin/python" -u -I "$D/host.py" "$@"
RUN
chmod +x "$DEST/run-host.sh"

echo "[4/5] Registering the native messaging host"
"$DEST/venv/bin/python" -I - "$DEST" "$HOST_NAME" "$EXT_ORIGIN" "${MANIFEST_DIRS[@]}" <<'PY'
import json, os, sys
dest, name, origin, *dirs = sys.argv[1:]
manifest = {"name": name, "description": "SubDub - giọng VieNeu chạy trên máy",
            "path": os.path.join(dest, "run-host.sh"), "type": "stdio", "allowed_origins": [origin]}
with open(os.path.join(dest, name + ".json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
for d in dirs:
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, name + ".json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print("  manifest ->", os.path.join(d, name + ".json"))
PY

if [ "$DOWNLOAD" = 1 ]; then
  echo "[5/5] Downloading and checking the model"
  "$DEST/venv/bin/python" -I "$DEST/host.py" --download
else
  echo "[5/5] Skipped model download"
fi
echo "Done. Host: $DEST/run-host.sh"
