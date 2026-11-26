#!/usr/bin/env python3
"""Zgradi Chrome MV3 paket (dist/chrome/ za Load unpacked in dist/stream-saver-chrome-<ver>.zip)."""

import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
CHROME_SRC = ROOT / "chrome"
DIST = ROOT / "dist"
OUT_DIR = DIST / "chrome"


def copy_tree(src_dir: Path, dst_dir: Path, skip_names=()):
    for item in src_dir.rglob("*"):
        rel = item.relative_to(src_dir)
        if rel.name in skip_names:
            continue
        dst = dst_dir / rel
        if item.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, dst)


def validate_cws(manifest: dict):
    name = manifest.get("name", "")
    short_name = manifest.get("short_name", "")
    desc = manifest.get("description", "")
    if len(name) > 75:
        raise SystemExit(f"Ime v manifestu presega 75 znakov ({len(name)}).")
    if len(short_name) > 12:
        raise SystemExit(f"short_name v manifestu presega 12 znakov ({len(short_name)}).")
    if len(desc) > 132:
        raise SystemExit(f"Opis (description) presega 132 znakov za Chrome Web Store ({len(desc)}).")


def main():
    manifest_src = CHROME_SRC / "manifest.json"
    manifest = json.loads(manifest_src.read_text(encoding="utf-8"))
    validate_cws(manifest)
    version = manifest["version"]

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 1) Skupna koda iz src/ (brez Firefoxovega MV2 manifest.json)
    copy_tree(SRC, OUT_DIR, skip_names=("manifest.json",))

    # 2) Chrome-specifične datoteke iz chrome/ -> dist/chrome/chrome/ (brez manifest.json)
    copy_tree(CHROME_SRC, OUT_DIR / "chrome", skip_names=("manifest.json",))

    # 3) Chrome MV3 manifest v korenu paketa
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    # 4) Preveri, da vse poti v manifestu obstajajo
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
