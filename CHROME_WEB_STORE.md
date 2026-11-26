# Objava v Chrome Web Store (*Unlisted*)

Ta vodič vsebuje vse pripravljene podatke in utemeljitve dovoljenj za hitro objavo paketa `dist/stream-saver-chrome-<verzija>.zip` v **Chrome Web Store** z vidnostjo **Unlisted** (dostopno samo prek neposredne povezave, ne pojavlja se v iskanju).

## 1. Priprava paketa
```bash
python build_chrome.py
```
Preveri izpis: ustvariti mora `dist/stream-saver-chrome-1.2.9.zip` brez napak. Skripta samodejno preveri omejitve Chrome Web Store (`name ≤ 75`, `short_name ≤ 12`, `description ≤ 132` znakov in obstoj vseh datotek iz manifesta).

## 2. Nalaganje v Chrome Web Store Developer Dashboard
1. Odpri [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) in se prijavi z Google računom.
   - Če še nimaš razvijalskega računa, Google zahteva enkratno registracijo (**5 USD**).
2. Klikni **Add new item** in naloži datoteko `dist/stream-saver-chrome-1.2.9.zip`.
3. V zavihku **Distribution** nastavi **Visibility → Unlisted** (tako razširitev vidijo samo tisti, ki jim pošlješ povezavo).

## 3. Zavihek *Store listing*
- **Title:** `Stream Saver (posnetki predavanj)`
- **Summary (≤ 132 znakov):** `Shrani posnetke in prepise predavanj iz Microsoft Stream (SharePoint, OneDrive, Teams) za osebno uporabo brez povezave. Brez DRM.`
- **Description:**
  ```text
  Stream Saver omogoča shranjevanje posnetkov predavanj (video MP4 ali samo zvok M4A) ter prepisov (.txt ali .vtt) iz Microsoft Stream (SharePoint, OneDrive, Microsoft Teams) za osebno uporabo brez povezave.

  Lastnosti:
  - Shranjevanje videa (MP4), samo zvoka (M4A) ali samo videa.
  - Samodejno združevanje v standardni MP4/M4A (primeren za VLC, mpv in druge predvajalnike).
  - Izvoz prepisa predavanj v obliki .txt ali .vtt (vključno z branjem vidnega zavihka Prepis).
  - Neobvezen splošni način (vklopi se ročno) za zaznavanje nezaščitenih tokov HLS/DASH/MP4 na drugih spletnih mestih.
  - Popolnoma lokalno delovanje v brskalniku: nobeni podatki se ne pošiljajo na zunanje strežnike.
  - Posnetkov z zaščito DRM (Widevine, PlayReady, FairPlay, CENC) ne prenaša in ne zaobide nobene prijave.
  ```
- **Category:** `Productivity` (ali `Tools` / `Education`)
- **Language:** `Slovenian`
- **Store icon (128×128):** `src/icons/icon-128.png`
- **Screenshot (vsaj 1, 1280×800 ali 640×400):** naredi posnetek zaslona odprtega pojavnega okna razširitve na strani s predavanjem (brez osebnih podatkov).

## 4. Zavihek *Privacy practices* (pripravljeno v angleščini za pregledovalce Google)

### Single purpose description
```text
Downloads non-DRM lecture recordings (video MP4 or audio-only M4A) and lecture transcripts (.txt/.vtt) that the user already has authorized access to view in Microsoft Stream (SharePoint/OneDrive/Teams), plus optional user-enabled detection of non-DRM media streams on other sites for personal offline study.
```

### Permission justifications
- **`webRequest`:**
  ```text
  Read-only observation of outgoing request URLs/headers (and response headers only when the user explicitly grants optional <all_urls> access) to detect DASH/HLS manifest URLs, media segment templates, and transcript JSON endpoints requested by the video player. No requests are blocked or modified.
  ```
- **`downloads`:**
  ```text
  Saves the assembled local MP4/M4A recording or .txt/.vtt transcript file to the user's Downloads folder (with optional subject subfolder and Save As dialog).
  ```
- **`storage`:**
  ```text
  Stores user preferences locally (default subfolder, download mode, concurrency, transcript format) in storage.local and transient per-tab detected stream metadata in storage.session so detection survives Manifest V3 service worker restarts.
  ```
- **`unlimitedStorage`:**
  ```text
  Lecture recordings can be 1–4 GB; temporary assembly uses Origin Private File System (OPFS) / IndexedDB before handing the completed file to chrome.downloads.download, then deletes the temporary storage immediately after download finishes.
  ```
- **`clipboardWrite`:**
  ```text
  Allows the user to click buttons in the popup to copy fallback yt-dlp/ffmpeg commands or the detected manifest URL to the clipboard.
  ```
- **`offscreen`:**
  ```text
  Creates an offscreen document (reason: BLOBS) to generate blob: URLs from large locally assembled OPFS/IndexedDB media files for chrome.downloads.download (since MV3 service workers lack URL.createObjectURL) and to hold a keep-alive port during long lecture downloads.
  ```
- **`scripting`:**
  ```text
  Dynamically registers the generic stream-helper content script only if the user explicitly opts in and grants optional <all_urls> host permission, and unregisters it immediately when disabled.
  ```
- **`host_permissions` (`sharepoint.com`, `svc.ms`, `teams.microsoft.com`, `cloud.microsoft`):**
  ```text
  Required to observe Microsoft Stream/SharePoint/Teams player manifest, media segment, and transcript requests, read the player's file title and AES-128 transport key when applicable, and fetch media segments with the user's existing authenticated session.
  ```
- **`optional_host_permissions` (`<all_urls>`):**
  ```text
  Strictly optional and off by default. Requested only when the user clicks "Vklopi zaznavanje na vseh straneh" in the popup to detect non-DRM HLS/DASH/MP4 streams on other websites.
  ```
- **Remote code:** `No, I am not using remote code` (vsa koda je vključena v paketu, ni zunanjih skriptov, ni `eval`).

### Data usage & certification
- **Does this extension collect or transmit user data?** **Ne** (pusti vsa polja za zbiranje podatkov neoznačena).
- Obkljukaj vse tri potrditve certifikata zasebnosti (podatkov ne prodajaš, ne uporabljaš za druge namene in ne uporabljaš za kreditno ocenjevanje).
- **Privacy policy URL:** pri *Unlisted* brez zbiranja podatkov običajno ni obvezna; če jo obrazec vseeno zahteva, lahko navedeš povezavo na `https://github.com/JoshuaJackK/stream-saver#readme`.

## 5. Oddaja v pregled
Klikni **Submit for review**. Pri prvem pregledu (zaradi `webRequest` in opcijskega `<all_urls>`) pregled običajno traja 1–5 delovnih dni. Po odobritvi dobiš stalno povezavo za namestitev v Chrome brez opozoril za razvijalski način in s samodejnimi posodobitvami.
