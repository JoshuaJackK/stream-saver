#!/usr/bin/env python3
"""Zgradi Chrome MV3 paket (dist/chrome/ za Load unpacked in dist/stream-saver-chrome-<ver>.zip)."""

import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
OUT_DIR = DIST / "chrome"


def main():
    manifest_src = SRC / "manifest.chrome.json"
    manifest = json.loads(manifest_src.read_text(encoding="utf-8"))
    version = manifest["version"]

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for item in SRC.rglob("*"):
        rel = item.relative_to(SRC)
        if rel.name in ("manifest.json", "manifest.chrome.json"):
            continue
        dst = OUT_DIR / rel
        if item.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, dst)

    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    # Preveri, da vse poti v manifestu obstajajo
    refs = []
    sw = manifest.get("background", {}).get("service_worker")
    if sw:
        refs.append(sw)
    for icon in manifest.get("icons", {}).values():
        refs.append(icon)
    for icon in manifest.get("action", {}).get("default_icon", {}).values():
        refs.append(icon)
    popup = manifest.get("action", {}).get("default_popup")
    if popup:
        refs.append(popup)
    for cs in manifest.get("content_scripts", []):
        refs.extend(cs.get("js", []))
        refs.extend(cs.get("css", []))

    missing = [r for r in refs if not (OUT_DIR / r).is_file()]
    if missing:
        raise SystemExit(f"Manjkajoče datoteke v dist/chrome: {missing}")

    zip_path = DIST / f"stream-saver-chrome-{version}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(OUT_DIR.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(OUT_DIR).as_posix())

    file_count = sum(1 for f in OUT_DIR.rglob("*") if f.is_file())
    print(f"OK: {OUT_DIR} ({file_count} datotek)")
    print(f"OK: {zip_path} ({zip_path.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
