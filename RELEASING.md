# Izdajanje novih različic (samostojno gostovane posodobitve)

Razširitev je podpisana na AMO kot **unlisted** (ni javno na addons.mozilla.org) in se posodablja sama prek GitHuba.

## Kako deluje samodejna posodobitev
- `src/manifest.json` → `browser_specific_settings.gecko.id = stream-saver@kajzer.personal` (**nikoli ne spreminjaj** – nastavitve in posodobitve so vezane nanj).
- `gecko.update_url` = `https://raw.githubusercontent.com/JoshuaJackK/stream-saver/main/updates.json`
- Firefox ta JSON občasno (privzeto ~na 24 h) prebere; če najde višjo `version`, prenese `.xpi` iz `update_link` (GitHub Release) in preveri `update_hash` (sha256).
- Repozitorij mora ostati **javen**, sicer Firefox posodobitve ne more prebrati.
- Če se dovoljenja (`permissions`) med različicami ne spremenijo, Firefox pri posodobitvi ne vpraša za potrditev.

## Prva ročna namestitev (enkrat)
Firefox se samodejno posodablja samo pri razširitvah, ki že vsebujejo `update_url`. Različice **1.0.x in 1.1.0 ga nimajo**,
zato se ne posodobijo same. **Različica 1.1.1 je prva s samodejnim posodabljanjem** – namesti jo ročno, enkrat:

1. Prenesi `stream-saver-1.1.1.xpi` iz [Releases](https://github.com/JoshuaJackK/stream-saver/releases/latest).
2. Odpri jo v Firefoxu (povleci v okno ali `about:addons` → ⚙ → **Namesti dodatek iz datoteke …**) in potrdi **Dodaj**.
   Isti id pomeni, da se prejšnja različica prepiše in nastavitve ostanejo.

Od takrat naprej vse nadaljnje različice pridejo same.

## Nova verzija
Predpogoji: `gh` prijavljen, `npm i -g web-ext`, `npm install` (za teste), `ffmpeg` (nekateri testi), `python3` in okoljski spremenljivki
**`STREAMSAVER_AMO_JWT_ISSUER`** in **`STREAMSAVER_AMO_JWT_SECRET`** (AMO API ključa računa, pod katerim je dodatek registriran – nikoli ju ne
commitaj in ne izpisuj).

```bash
# vse spremembe commitane in pushane, nato:
./release.sh 1.1.2
```
Skripta: dvigne verzijo v `src/manifest.json`, `package.json` in `package-lock.json` → zažene `npm test` in `npm run lint` (`web-ext lint --self-hosted`)
→ podpiše (`web-ext sign -s src --channel=unlisted`, počaka na odobritev) → commit + tag `v1.1.2` + push → GitHub Release s `stream-saver-1.1.2.xpi`
→ doda vnos (verzija, povezava, sha256) v `updates.json` in ga pushne → preveri obe URL‑ja s curl (pričakovano `200`).

Pravila: verzija mora biti vedno višja od prejšnje; ista verzija se na AMO ne more podpisati dvakrat.

## Ročno preverjanje posodobitve
`about:addons` → zobnik ⚙ → **Preveri posodobitve** (*Check for Updates*). Za hiter test v `about:config` lahko znižaš `extensions.update.interval`.

## Varnost
V repozitoriju ni ključev, posnetkov ali zasebnih podatkov; testi uporabljajo izmišljene podatke. `dist/`, `web-ext-artifacts/` in `*.xpi` so v `.gitignore`
(podpisane datoteke so samo kot priponke izdaj na GitHubu).
