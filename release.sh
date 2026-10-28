#!/usr/bin/env bash
# Uporaba: ./release.sh <nova-verzija>     npr. ./release.sh 1.1.2
# Potrebuje: gh (prijavljen), web-ext (npm i -g web-ext), node/npm, python3,
#            okoljski spremenljivki STREAMSAVER_AMO_JWT_ISSUER / STREAMSAVER_AMO_JWT_SECRET (AMO API kljuca racuna JoshuaTree).
# Kljucev nikoli ne izpisuj in ne commitaj.
set -euo pipefail
VERSION="${1:?usage: ./release.sh <version>}"
REPO="JoshuaJackK/stream-saver"
ID="stream-saver@kajzer.personal"
cd "$(dirname "$0")"

: "${STREAMSAVER_AMO_JWT_ISSUER:?set STREAMSAVER_AMO_JWT_ISSUER}"; : "${STREAMSAVER_AMO_JWT_SECRET:?set STREAMSAVER_AMO_JWT_SECRET}"
[[ -z "$(git status --porcelain)" ]] || { echo "Working tree not clean"; exit 1; }
git pull --ff-only

# 1) bump version (manifest + package.json + package-lock.json)
python3 - "$VERSION" <<'PY'
import json, sys, re
v = sys.argv[1]
if not re.fullmatch(r"\d+\.\d+\.\d+", v): sys.exit("bad version: " + v)
def bump(path, fn):
    s = open(path, encoding="utf-8").read()
    s = fn(s); open(path, "w", encoding="utf-8").write(s)
# manifest: besedilna zamenjava, da ostane oblika datoteke
bump("src/manifest.json", lambda s: re.sub(r'("version"\s*:\s*")[^"]+(")', r'\g<1>' + v + r'\g<2>', s, count=1))
for p in ("package.json", "package-lock.json"):
    d = json.load(open(p, encoding="utf-8")); d["version"] = v
    if p == "package-lock.json" and "" in d.get("packages", {}): d["packages"][""]["version"] = v
    open(p, "w", encoding="utf-8").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY

# 2) testi + lint (lint z --self-hosted zaradi update_url)
npm test
npm run lint

# 3) podpis (unlisted, samostojno gostovano)
rm -rf web-ext-artifacts
web-ext sign -s src --channel=unlisted --api-key="$STREAMSAVER_AMO_JWT_ISSUER" --api-secret="$STREAMSAVER_AMO_JWT_SECRET" \
  --approval-timeout 900000
XPI=$(ls web-ext-artifacts/*.xpi | head -1)
ASSET="stream-saver-$VERSION.xpi"
cp "$XPI" "web-ext-artifacts/$ASSET"

# 4) commit verzije, tag, GitHub Release
git add src/manifest.json package.json package-lock.json
git commit -m "Release $VERSION"
git tag "v$VERSION"
git push origin main "v$VERSION"
gh release create "v$VERSION" "web-ext-artifacts/$ASSET" -R "$REPO" -t "v$VERSION" -n "Stream Saver $VERSION (podpisano, unlisted)"
URL="https://github.com/$REPO/releases/download/v$VERSION/$ASSET"

# 5) updates.json za samodejno posodabljanje Firefoxa
python3 - "$ID" "$VERSION" "$URL" "web-ext-artifacts/$ASSET" <<'PY'
import json, sys, hashlib
aid, ver, url, xpi = sys.argv[1:]
d = json.load(open("updates.json"))
ups = d.setdefault("addons", {}).setdefault(aid, {}).setdefault("updates", [])
ups[:] = [u for u in ups if u.get("version") != ver]
ups.append({"version": ver, "update_link": url,
            "update_hash": "sha256:" + hashlib.sha256(open(xpi, "rb").read()).hexdigest()})
open("updates.json", "w").write(json.dumps(d, indent=2) + "\n")
PY
git add updates.json
git commit -m "updates.json: $VERSION"
git push origin main

# 6) preverjanje
sleep 5
for u in "$URL" "https://raw.githubusercontent.com/$REPO/main/updates.json"; do
  echo "$(curl -sL -o /dev/null -w '%{http_code}' "$u")  $u"
done
