# Stream Saver – shranjevanje posnetkov predavanj iz Microsoft Stream (Firefox)

Razširitev za Firefox, s katero si posnetek predavanja, ki ga lahko gledaš v Microsoft Stream
(SharePoint/OneDrive, tudi kadar ga odpreš v Microsoft Teams), shraniš za osebno uporabo brez povezave,
tudi kadar je gumb **Prenesi** onemogočen (dostop »samo za ogled«).

Od različice **1.2.0** zna (po ročnem vklopu neobveznega dovoljenja) zaznati in shraniti tudi videe na **drugih straneh**
(HLS, DASH, navadne datoteke MP4/WebM) – glej razdelek 6.

Razširitev ne zaobide nobene zaščite dostopa: prenese le tisto, kar tvoj brskalnik med predvajanjem
že prejema, in to z istimi piškotki, s katerimi si prijavljen. Uporabljaj jo samo za posnetke, do katerih
imaš dostop, in jih ne deli naprej. **Samo za osebno uporabo; za spoštovanje pogojev spletnega mesta in
avtorskih pravic si odgovoren sam.**

---

## 1. Kaj razširitev počne

- Ko v Firefoxu predvajaš posnetek (`…sharepoint.com/…/_layouts/15/stream.aspx?id=…` ali posnetek v
  Teams na `teams.microsoft.com` / `teams.cloud.microsoft`), zazna DASH manifest (`videomanifest`)
  oz. zahteve `oneDrive.transcode`. Na strani se prikaže plavajoči gumb **Prenesi posnetek**, na ikoni v orodni vrstici (če je vidna) pa zelena značka **▼**.
- Klik na plavajoči gumb ali na ikono odpre ploščo/okno, kjer s klikom na **Prenesi**:
  - prenese video in zvok (najvišjo kakovost), ju sproti združi v **eno datoteko MP4** in jo shrani
    z imenom posnetka (npr. `3. predavanje.mp4`);
  - med prenosom kaže napredek (odstotek, število segmentov, velikost, ocena preostalega časa),
    na znački pa odstotek;
  - ob preobremenitvi strežnika (HTTP 429) samodejno počaka in poskusi znova ter zmanjša število
    hkratnih prenosov;
  - če Microsoft segmente šifrira z AES-128 (to ni DRM), ključ prebere iz predvajalnika in segmente dešifrira.
- Rezervna možnost: kopiraš pripravljen ukaz za **yt-dlp** ali **ffmpeg**.
- Od različice 1.1.0 lahko **ločeno** shraniš tudi samo **prepis** (besedilo govora) posnetka, glej razdelek 5.

## 2. Namestitev v Firefox

Razširitev je javno na GitHubu: <https://github.com/JoshuaJackK/stream-saver>. Podpisane datoteke `.xpi` so v razdelku
[Releases](https://github.com/JoshuaJackK/stream-saver/releases) (`stream-saver-<različica>.xpi`). Za osebno rabo je to najlažja pot.

### Priporočeno: podpisana različica z GitHuba (samodejne posodobitve)

1. Odpri <https://github.com/JoshuaJackK/stream-saver/releases/latest> in prenesi `stream-saver-1.1.2.xpi`
   (ali novejšo različico).
2. Odpri datoteko v Firefoxu (povleci jo v okno Firefoxa ali: `about:addons` → zobnik ⚙ →
   **Namesti dodatek iz datoteke …**) in potrdi z **Dodaj**. Podpisana razširitev ostane nameščena tudi po
   ponovnem zagonu.
3. Če imaš nameščeno **starejšo** različico (1.0.x ali 1.1.0), jo namesti kar čez: id razširitve
   (`stream-saver@kajzer.personal`) je isti, zato se nastavitve ohranijo.

**Pomembno – prva ročna namestitev:** Firefox se samodejno posodablja samo pri razširitvah, ki že vsebujejo
naslov za posodobitve (`update_url`). Različici 1.0.x in 1.1.0 ga **nimata**, zato se ne moreta posodobiti
sami. **Različica 1.1.2 je prva, ki se posodablja sama**, vendar jo moraš namestiti **ročno, enkrat**
(koraki zgoraj). Od takrat naprej Firefox sam prebere
`https://raw.githubusercontent.com/JoshuaJackK/stream-saver/main/updates.json` (običajno na ~24 ur) in
prenese novo različico. Ročno preverjanje: `about:addons` → zobnik ⚙ → **Preveri posodobitve**
(*Check for Updates*). Posodobitev na 1.2.0 **ne zahteva potrditve dovoljenj** (novo dovoljenje za vse strani je
neobvezno in ga vklopiš sam, glej razdelek 6), zato se namesti sama.

Če je isti Firefox profil opremljen z začasnim dodatkom (možnost A spodaj), ga pred namestitvijo odstrani
oziroma ga ne uporabljaj hkrati.

Spodaj so še druge možnosti (za razvijalce in za preizkus).

> Navadni Firefox (Release) trajno namesti samo razširitve, ki jih je podpisal Mozilla.

### Možnost A: začasna namestitev (za preizkus)

Razširitev ostane nameščena le do zaprtja Firefoxa.

1. V naslovno vrstico vpiši `about:debugging#/runtime/this-firefox` in pritisni Enter.
2. Klikni **Naloži začasni dodatek …** (*Load Temporary Add-on…*).
3. Izberi datoteko `stream-saver-1.1.2.xpi` (ali `manifest.json` v mapi `src`).
4. Ikona Stream Saver se prikaže v orodni vrstici. Če je ne vidiš, klikni ikono sestavljanke
   (Razširitve) in jo pripni.


### Kje je ikona? (začasni dodatek in orodna vrstica)

Začasno naložen dodatek (`about:debugging`) **pogosto ni viden** v `about:addons` in včasih tudi ne
v meniju sestavljanke (puzzle). To je omejitev Firefoxa, ne napaka razširitve.

- Na strani s posnetkom se po nekaj sekundah predvajanja prikaže plavajoči gumb
  **»Prenesi posnetek«** (spodaj desno). To je glavni način prenosa pri začasni namestitvi.
- Če se ikona Stream Saver vseeno pojavi v orodni vrstici ali meniju razširitev: desni klik na
  orodno vrstico → **Prilagodi orodno vrstico …** → povleci Stream Saver v vrstico.
- Trajna namestitev (podpisan XPI ali Developer Edition, glej možnosti B/C) ikono prikaže
  zanesljiveje in dodatek listira v `about:addons`.

### Možnost B: ročno podpisovanje na AMO (navaden Firefox)

Za to potrebuješ brezplačen račun Mozilla. Razširitev bo »nenavedena« (*unlisted*): ne bo javno
objavljena, Mozilla jo samo samodejno pregleda in podpiše.

1. Odpri <https://addons.mozilla.org/developers/> in se prijavi oz. ustvari račun Mozilla.
2. Klikni **Submit a New Add-on** (Oddaj nov dodatek).
3. Pri vprašanju, kje bo dodatek objavljen, izberi **On your own** (sam ga bom distribuiral – *unlisted*).
4. Naloži datoteko `stream-saver-1.1.2.xpi` in počakaj na samodejno preverjanje.
5. Ko je dodatek podpisan (običajno v nekaj minutah, včasih dlje), na strani dodatka prenesi
   **podpisano** datoteko `.xpi`.
6. V Firefoxu odpri `about:addons`, klikni zobnik ⚙ → **Namesti dodatek iz datoteke …** in izberi
   podpisano datoteko. Potrdi z **Dodaj**.

Namesto spletnega obrazca lahko podpišeš tudi v ukazni vrstici: na
<https://addons.mozilla.org/developers/addon/api/key/> ustvari ključa API in zaženi

```
web-ext sign -s src --channel=unlisted --api-key=TVOJ_JWT_ISSUER --api-secret=TVOJA_JWT_SKRIVNOST
```

Podpisani `.xpi` se shrani v mapo `web-ext-artifacts`.

Pri vsaki novi različici je treba v `src/manifest.json` povečati številko `version` in ponovno podpisati.

### Možnost C: Firefox Developer Edition, Nightly ali ESR brez podpisa

1. Namesti Firefox Developer Edition (<https://www.mozilla.org/firefox/developer/>) ali Firefox ESR.
2. Odpri `about:config`, sprejmi opozorilo, poišči `xpinstall.signatures.required` in ga z dvoklikom
   nastavi na `false`.
3. Odpri `about:addons` → ⚙ → **Namesti dodatek iz datoteke …** → izberi `stream-saver-1.1.2.xpi`.

(V navadnem Firefoxu ta nastavitev nima učinka.)

### Dovoljenja

Od 1.2.0 obstaja **neobvezno** dovoljenje »Dostop do podatkov na vseh straneh« (`<all_urls>`), ki se vklopi
šele s klikom v razširitvi (razdelek 6). Brez njega razširitev deluje kot prej (samo Microsoft Stream/SharePoint/Teams).

Ob namestitvi Firefox vpraša za dovoljenja: dostop do strani `sharepoint.com`, `svc.ms`,
`teams.microsoft.com` in `cloud.microsoft` (zaznavanje in prenos posnetka), prenosi (shranjevanje
datoteke), shramba (nastavitve in začasna datoteka med prenosom). Razširitev ne pošilja nobenih
podatkov nikamor drugam.

## 3. Uporaba

1. V Firefoxu se prijavi v Microsoft 365 in odpri posnetek (v Streamu, OneDrivu, SharePointu ali Teams).
2. Zaženi predvajanje in ga pusti teči **vsaj 5–10 sekund** (takrat predvajalnik naloži manifest
   in, če obstaja, ključ za dešifriranje). Predvajanje lahko nato ustaviš.
3. Na strani (spodaj desno) se prikaže plavajoči gumb **Prenesi posnetek**. Klikni ga – odpre se
   majhna plošča z imenom datoteke in gumbom **Prenesi**. (Enako lahko storiš prek ikone v orodni
   vrstici Firefoxa, če jo vidiš – zelena značka **▼**.)
4. Preveri **Ime datoteke** (predlaga se ime posnetka) in po želji vpiši **Podmapo (predmet)** – glej
   razdelek 4.
5. Izberi **Vsebina**: *Video + zvok* (privzeto), *Samo zvok* ali *Samo video*.
6. Klikni **Prenesi**. Ploščo lahko zapreš – prenos teče naprej, napredek je na gumbu (odstotek).
   Zavihka s posnetkom med prenosom **ne zapri** in se ne odjavi.
7. Ko je prenos končan, se datoteka pojavi med prenosi Firefoxa (Ctrl+Shift+Y).

Samo prepis (brez videa) shraniš v istem oknu z razdelkom **Prepis** → **Shrani prepis** (glej razdelek 5).

**Vzporedni prenosi:** privzeto 4. Če se pogosto pojavlja »Strežnik omejuje hitrost (HTTP 429)«,
izberi 2; pri hitri povezavi lahko poskusiš 6–8.

Tri ure dolg posnetek (~1,5 GB) se pri hitri povezavi prenese v nekaj minutah do pol ure.

**Prostor na disku:** med prenosom razširitev datoteko sproti zapisuje v začasno shrambo Firefoxa
(v profilu, običajno na disku C:). Tam potrebuješ vsaj toliko prostora, kot je velik posnetek
(~1,5 GB). Po shranjevanju se začasna datoteka izbriše.

### Rezervna možnost: yt-dlp ali ffmpeg

Če prenos v brskalniku ne uspe, v oknu razširitve odpri **Rezervna možnost**:

- **Kopiraj ukaz yt-dlp** – npr.
  `yt-dlp --cookies-from-browser firefox -o "3. predavanje.%(ext)s" "https://example-my.sharepoint.com/…/stream.aspx?id=…"`
  Zaženi v PowerShellu ali ukaznem pozivu (potrebuješ nameščena `yt-dlp` in `ffmpeg`). Če Firefox
  med izvajanjem teče, ga po potrebi zapri, da lahko yt-dlp prebere piškotke.
- **Kopiraj ukaz ffmpeg** – `ffmpeg -i "<URL manifesta>" -map 0:v:0 -map 0:a:0? -c copy "ime.mp4"`.
  Deluje le kratek čas po predvajanju (URL vsebuje začasne žetone).
- **Kopiraj URL manifesta** – za lastno uporabo z drugimi orodji.

Ukazi vsebujejo začasne žetone za dostop – ne objavljaj jih in jih ne pošiljaj drugim.
Opozorilo: če Microsoft segmente šifrira (AES-128), yt-dlp in ffmpeg takega posnetka običajno ne
moreta prenesti; takrat deluje samo prenos v brskalniku.

## 4. Shranjevanje v mapo C:\Študij\Primer predmeta\<predmet>

Razširitev shranjuje prek Firefoxovih prenosov, zato najprej nastavi mapo za prenose v Firefoxu,
v razširitvi pa vpiši ime predmeta kot podmapo.

### Korak 1: privzeta mapa za prenose v Firefoxu

1. Odpri meni ☰ → **Nastavitve** (ali vpiši `about:preferences`).
2. Na zavihku **Splošno** se pomakni do razdelka **Datoteke in programi** → **Prenosi**.
3. Pri **Shrani datoteke v** klikni **Prebrskaj …**.
4. Izberi mapo `C:\Študij\Primer predmeta`
   (če je še ni, jo ustvari v oknu za izbiro mape) in klikni **Izberi mapo**.

### Korak 2: predmet kot podmapa v razširitvi

V oknu Stream Saver v polje **Podmapa (predmet)** vpiši ime predmeta, npr. `Razvojna psihologija`.
Posnetek se bo shranil v

```
C:\Študij\Primer predmeta\Razvojna psihologija\3. predavanje.mp4
```

Podmapo Firefox ustvari sam, če še ne obstaja. Vpisano podmapo si razširitev zapomni; ko preklopiš
na drug predmet, jo samo spremeniš. Lahko vpišeš tudi več ravni, npr. `Razvojna psihologija/Vaje`.
Šumniki (č, š, ž) v imenih map in datotek so v redu.

### Druga možnost: vsakič izberi mapo sam

V oknu razširitve obkljukaj **Vprašaj, kam naj shranim (»Shrani kot«)** – ob koncu prenosa se odpre
okno za izbiro mape in imena. (Enako velja, če imaš v Firefoxu vklopljeno *Vedno vprašaj, kam
shraniti datoteke*.)

Opomba: Firefox razširitvam ne dovoli shranjevanja z absolutno potjo (npr. neposredno na `C:\…`),
zato je pot vedno sestavljena iz Firefoxove mape za prenose in podmape iz razširitve.

## 5. Samo prepis (Prepis)

Od različice 1.1.0 lahko posnetku **ločeno od videa** shraniš samo prepis govora (zavihek **Prepis** v predvajalniku Stream). To je ločena možnost: deluje tudi, če video še ni zaznan (npr. predvajanje še ni steklo) – dovolj je, da predvajalnik prepis prikazuje oz. ga je naložil.

### Kaj razširitev naredi in česa ne

- Razširitev shrani **samo tisto, kar predvajalnik že sam prejme** za prikaz prepisa: ob nalaganju strani predvajalnik s tvojo prijavo prebere prepis (zahteva `…/media/transcripts/<id>/streamContent?format=json…`). Razširitev to zahtevo zazna in **isti naslov** z istimi parametri in tvojimi piškotki prebere še enkrat. Drugih naslovov ne kliče.
- **Ne** uporablja nobene povezave za prenos (npr. `format=vtt`, `docx`, gumb **Prenesi** v zavihku Prepis) in **ne zaobide** onemogočenega gumba **Prenesi**. Če predvajalnik prepisa ne prikaže, ga razširitev ne more shraniti.
- Deluje samo za posnetke, ki jih lahko sam gledaš, in samo za tvojo osebno uporabo. Ne deli prepisov naprej.
- Prepis, ki mu lastnik posnetka onemogoči prenos (gumb **Prenesi** je siv), se v predvajalniku vseeno prikaže; razširitev ga shrani samo toliko, kolikor ga predvajalnik prejme za prikaz. Če meniš, da lastnik tega ne želi, prepisa ne shranjuj.

### Kako ga shraniš

1. Odpri posnetek v Streamu (ali v Teams) in **počakaj, da se stran naloži**. Prepis predvajalnik naloži sam ob nalaganju strani – zavihka Prepis ni treba odpreti.
2. Odpri okno razširitve (ikona v orodni vrstici) ali plavajoči gumb na strani (**Prenesi posnetek** oz. **Shrani prepis**, če video še ni zaznan). V razdelku **Prepis** mora pisati npr. *»Prepis zaznan: 1214 vrstic, 12 govorcev, jezik sl-si«* (številke so izračunane iz prejetih podatkov).
3. Preveri **Ime datoteke** in **Podmapo (predmet)**. Uporabljata se enako kot pri videu (isto ime, ista podmapa v mapi za prenose, enaka možnost *Vprašaj, kam naj shranim*); razlikuje se samo končnica.
4. Izberi **Obliko prepisa** in klikni **Shrani prepis**. Izbrana oblika se zapomni.

### Obliki

| Oblika | Datoteka | Vsebina |
| --- | --- | --- |
| **Besedilo (.txt)** – *privzeto* | `ime posnetka.txt` | Berljivo besedilo, ena vrstica na vrstico prepisa: `[H:MM:SS] Ime Priimek: besedilo`. Brez govorca: `[H:MM:SS] besedilo`. UTF-8 z BOM, vrstice se končajo z CRLF, zato Beležnica v Windows pravilno prikaže šumnike. |
| **Podnapisi (.vtt)** | `ime posnetka.vtt` | WebVTT: ena replika na vrstico prepisa, čas `HH:MM:SS.mmm --> HH:MM:SS.mmm` (zaokroženo na milisekunde), govorec kot `<v Ime Priimek>besedilo</v>` (če ime govorca manjka, brez oznake). Znaki `<`, `>`, `&` so pretvorjeni v `&lt;`, `&gt;`, `&amp;`. UTF-8 brez BOM. Primerno za VLC/mpv ob videu z istim imenom. |

**Popravek kodiranja (vedno vklopljen):** Microsoft v prepisu besede *če/Če/četudi* zapiše kot *èe/Èe/èetudi*, besedo *že* pa (vsaj ponekod) kot *ëe*. Razširitev jih ob shranjevanju popravi: `è→č`, `È→Č`, `ë→ž`, `Ë→Ž` (v besedilu in v imenih govorcev, v .txt in .vtt). Teh znakov v slovenščini ni, zato popravek ne spremeni pravilnih besed. Popravek ni izklopljiv; originalni podatki iz Streama se ne spreminjajo, popravi se samo shranjena datoteka.

V obeh oblikah: vrstice z praznim besedilom se izpustijo, nič se ne združuje (ena vrstica prepisa = ena vrstica v datoteki), vrstice so razvrščene po času.

### Če prepis ni zaznan

| Sporočilo | Pomen / kaj narediti |
| --- | --- |
| *»Prepis še ni naložen – osveži stran (F5), da ga predvajalnik znova naloži.«* | Prepis predvajalnik naloži ob nalaganju strani. Če si stran odprl, preden je razširitev tekla (ali si razširitev šele namestil/osvežil), je razširitev zahteve ni videla. Pritisni **F5**; v Teams osveži posnetek/zavihek. Če se po osvežitvi še vedno ne pojavi, posnetek verjetno nima prepisa. |
| *»Ta posnetek nima prepisa (prepis je prazen).«* | Predvajalnik je prejel prepis brez vrstic. |
| *»Prepisa ni bilo mogoče prebrati (HTTP …) …«* | Prijava je potekla ali strežnik odgovarja z napako: osveži stran (F5) in poskusi znova. |

### Omejitve prepisa

- **Ni preizkušeno na živem Streamu** (različica 1.1.0 je bila preverjena le s samodejnimi testi na izmišljenih podatkih). Če kaj ne deluje, napiši, kaj piše v oknu razširitve.
- Deluje samo z zahtevo `format=json`, ki jo predvajalnik naredi sam; če Microsoft naslov ali obliko spremeni, razširitev prepisa ne zazna.
- Shrani se prepis, ki ga je predvajalnik naložil (privzeti jezik prepisa); drugih jezikov ni mogoče izbrati.
- Če se po osvežitvi (F5) prepis ne pojavi, prepisa ne poskušaj dobiti z drugimi povezavami – razširitev tega namenoma ne podpira.
- Hitro preklapljanje med posnetki brez nalaganja strani (v Streamu): razširitev ob spremembi naslova (po nekaj sekundah) ali novem prepisu prepis prejšnjega posnetka zavrže; preden shraniš, preveri v oknu, da se število vrstic ujema s pričakovanim, po potrebi pritisni F5.
- Posnetek v Teams (okvir): prepis je vezan na zavihek; če zavihek vsebuje več posnetkov, velja zadnji, ki ga je predvajalnik naložil.
- Prepis je besedilo, ki ga je ustvaril Microsoft, in je lahko napačen (imena, strokovni izrazi). Popravek kodiranja zajema samo znake è, È, ë, Ë; morebitne druge napake v izvornem besedilu ostanejo.

## 6. Splošni video tokovi na drugih straneh (od 1.2.0)

**Samo za osebno uporabo.** Uporabljaj to za posnetke, ki jih smeš gledati in si jih shraniti za ogled brez povezave
(npr. predavanja, ki si jih lahko ogledaš sam). **Za spoštovanje pogojev uporabe spletnega mesta in avtorskih pravic si
odgovoren sam.** Posnetkov ne deli naprej in ne objavljaj.

### Trdne omejitve (v kodi, ne samo v navodilih)

- **DRM se nikoli ne prenaša.** Če je tok zaščiten (HLS `SAMPLE-AES`/`KEYFORMAT` Apple FairPlay, Microsoft PlayReady, Widevine;
  DASH `ContentProtection` Widevine/PlayReady/FairPlay; šifrirani CENC segmenti), razširitev prenos **zavrne** (»Posnetek je
  zaščiten z DRM«) še preden prenese kakšen segment. Takih posnetkov ni mogoče shraniti in tega ne poskuša obiti.
- **Prijave in plačljivih vsebin ne obide.** Prenese samo tisto, kar zahteva predvajalnik strani sam, z **istimi piškotki** (tvoja seja).
  Ne ugiba naslovov, ne ponareja prijave, ne spreminja dostopa.
- **Prenosi v živo** (seznam brez `#EXT-X-ENDLIST`, DASH `type="dynamic"`) so zavrnjeni z jasnim sporočilom.
- Naslovi **YouTube** (`googlevideo.com`) se ne obravnavajo: zahteve so razdrobljeni kosi, ne en posnetek.
- Oglaševalska omrežja se ne ponujajo.

### Kaj podpira

| Vrsta | Kaj se zgodi |
| --- | --- |
| **HLS** (`.m3u8`) | Glavni seznam: izbereš kakovost (privzeto najvišja pasovna širina) in zvočno sled; podpora za `EXT-X-MAP`, `BYTERANGE`, fMP4 in MPEG-TS segmente ter **AES-128** (ključ z naslova v seznamu, IV iz seznama ali zaporedne številke). Rezultat je običajna **MP4**. |
| **DASH** (`.mpd`) | Kot pri Streamu: **najvišja kakovost** videa + zvok v eno MP4 (izbire kakovosti ni). |
| **Navadna datoteka** (`video/*`, `.mp4`, `.webm`) | Prenese se po delih (Range) in shrani **brez spreminjanja** (isto kot na strežniku). |

MPEG-TS (H.264 + AAC/MP3) se **pretvori v MP4 brez ponovnega kodiranja** (lastna majhna pretvorba, pri kateri se ohrani zamik med
sliko in zvokom). Če TS vsebuje kodek, ki ga pretvorba ne zna (npr. **HEVC/H.265**), se shrani surov **.ts**; v tem primeru
popup pokaže ukaz: `ffmpeg -i vhod.ts -c copy izhod.mp4` (ffmpeg ga zna pretvoriti).

### Vklop (enkrat)

Dovoljenje je **neobvezno** in se **ne zahteva ob posodobitvi**, zato se 1.2.0 namesti brez vprašanja. Zaznavanje na drugih straneh vklopiš sam:

1. Klikni ikono Stream Saver v orodni vrstici (na strani, ki ni Stream).
2. Klikni **Vklopi zaznavanje na vseh straneh** in v Firefoxovem oknu potrdi (»Dostop do podatkov na vseh straneh«). Dovoljenje lahko kadarkoli
   umakneš z gumbom **Izklopi zaznavanje na vseh straneh** v istem oknu ali v `about:addons` → Stream Saver → **Dovoljenja**.
3. **Osveži stran z videom (F5)** in predvajaj nekaj sekund. (Skripta s plavajočim gumbom se v že odprte strani ne vstavi sama.)

Zakaj tako: razširitev mora za zaznavo videa brati **glave** omrežnih zahtev (ne pa vsebine strani). Razširitev ne pošilja nič nikamor
drugam, vse ostane v brskalniku.

### Uporaba

- Ko je tok zaznan, se pojavi majhen gumb **▼ Stream Saver** (privzeto spodaj levo; **povleci** ga na drugo mesto). Pojavi se šele po zaznavi,
  na vsaki strani posebej ga lahko **skriješ** (**Skrij na tej strani**; skritje razveljaviš v oknu razširitve).
- Klik odpre ploščo: seznam zaznanih tokov (vrsta HLS/DASH/MP4, ločljivost, trajanje, velikost – če so znani), izbereš tok (privzeto glavni),
  kakovost (HLS), **ime datoteke** (privzeto naslov strani), podmapa in **Vprašaj, kam naj shranim** (iz nastavitev razširitve, razdelek 4).
- Zelo kratki tokovi (< 8 s), samo zvok in verjetni predogledi/oglasi so v seznamu, vendar označeni; drobne datoteke (< 0,5 MB) se ne prikažejo.
- Isto je na voljo v oknu razširitve (ikona v orodni vrstici). Stanje se ob prehodu na drugo stran ponastavi.
- Na straneh Microsoft Stream/SharePoint/Teams ostane obstoječe vedenje (gumb **Prenesi posnetek**); splošno zaznavanje tam ne podvaja.

### Omejitve in poštena opozorila

- **Referer/Origin:** prenos najprej poskusi razširitev sama (s piškotki, brez glave Referer); če strežnik zavrne (401/403) ali ne odgovori, poskusi
  še prek okvirja strani (z izvorom, piškotki in Referer strani, vendar velja enaka omejitev CORS kot za stran). Nekatera spletna mesta
  prenos kljub temu zavrnejo (npr. kratkotrajni žetoni, podpisani naslovi, ki so že potekli) – takrat osveži stran, predvajaj nekaj sekund in poskusi znova.
- Videov, ki se nalagajo iz **Web Workerjev**, **blob:** naslovov ali prek MSE brez omrežne zahteve za datoteko, razširitev ne vidi.
- Prenos je **v pomnilniku, kjer ni drugače mogoče**: HLS/DASH se sproti zapiše na disk (začasna shramba), vendar se pri pretvorbi v klasičen MP4 in
  pri navadnih datotekah brez podpore za Range celotna datoteka naloži v pomnilnik. Zelo velikih posnetkov (več GB) v takem primeru ne prenašaj.
- DASH: samo najvišja kakovost, ena zvočna sled. HLS: ena zvočna sled (izbrana/privzeta); podnapisi se ne shranijo.
- Prenosa ni mogoče nadaljevati; med prenosom zavihka ne zapiraj.
- **Nič od tega ni bilo preizkušeno na živih spletnih mestih** s pravim Firefoxom: testi uporabljajo sintetične HLS/DASH/MP4 datoteke (ffmpeg),
  preverjene z ffprobe/ffmpeg. Če kakšno mesto ne deluje, je to pričakovano za nekatera; sporoči, kaj se je zgodilo.

## 7. Težave in omejitve

| Težava | Kaj narediti |
| --- | --- |
| Značka se ne prikaže | Osveži stran (F5), znova zaženi predvajanje in počakaj nekaj sekund. Preveri, da je razširitev omogočena. |
| »Segmenti so šifrirani … ključa ni bilo mogoče zajeti« | Pusti posnetek predvajati 10–20 s, nato znova klikni Prenesi. Če ne pomaga, osveži stran. |
| »HTTP 401/403« | Prijava ali žetoni so potekli: osveži stran, predvajaj nekaj sekund in poskusi znova. |
| »Posnetek je zaščiten z DRM« | Pravega DRM (PlayReady/Widevine) ni mogoče prenesti z nobenim orodjem. |
| Pogosti 429 | Zmanjšaj vzporedne prenose na 1–2. |
| Datoteka je samo video (brez zvoka) | Predvajaj posnetek 10–20 s, da se naloži tudi zvočna sled, nato znova Prenesi. V 1.0.3 razširitev bolje zazna zvok tudi, kadar Stream označi zvočni AdaptationSet kot `video/mp4`. |
| VLC predvaja samo video, WMP pa tudi zvok | Starejši prenosi (1.0.1/1.0.2) so fragmentiran MP4; VLC pri njih pogosto ne predvaja zvoka. **Takoj** (PowerShell): `ffmpeg -i ".\vhod.mp4" -c copy -movflags +faststart ".\izhod.mp4"`. Od 1.0.3 razširitev shrani klasičen MP4. |
| Prepis ni zaznan | Osveži stran (F5); glej razdelek 5. |
| Gumba za splošne tokove ni | Preveri, da je dovoljenje vklopljeno (okno razširitve → **Vklopi zaznavanje na vseh straneh**), nato **osveži stran (F5)** in predvajaj video. Gumb je lahko tudi skrit (»Skrij na tej strani«). |
| Tok ni na seznamu | Predvajaj nekaj sekund po osvežitvi; video iz Web Workerja/`blob:` ali YouTube razširitev ne zazna (razdelek 6). |
| »Posnetek je zaščiten z DRM« (splošni tokovi) | Zaščiteni posnetki se **ne prenašajo** in tega ne bo mogoče obiti. |
| »To je živi prenos …« | Počakaj, da se oddaja konča in posnetek postane običajen, nato poskusi znova. |
| Splošni tok: HTTP 401/403 | Osveži stran, predvajaj nekaj sekund (žetoni potečejo) in poskusi znova; nekatera mesta zavrnejo prenos zunaj predvajalnika. |
| Dobim datoteko .ts namesto .mp4 | Kodek (npr. HEVC) ni podprt za pretvorbo: `ffmpeg -i vhod.ts -c copy izhod.mp4`. |
| Posnetek v Teams | Najbolj zanesljivo je odpreti posnetek neposredno v Streamu (v Teams: ⋯ → *Odpri v brskalniku* / *Open in Stream*). |

Znane omejitve:

- Prenosa ni mogoče nadaljevati po prekinitvi (zaprt Firefox, izguba povezave za več minut) –
  začne se znova. Kratke prekinitve in 429 se samodejno ponovijo.
- Shrani se najvišja kakovost videa in prvi zvočni posnetek; podnapisi in prepis se ne shranijo skupaj z videom – prepis se shrani ločeno (razdelek 5, od različice 1.1.0).
- Od različice 1.0.3 je shranjena datoteka **klasičen MP4** (moov na začetku), ki ga VLC, mpv in
  brskalniki predvajajo z zvokom. Starejši prenosi (1.0.1/1.0.2) so bili fragmentirani – VLC pri njih
  včasih ni predvajal zvoka; pretvori jih z: `ffmpeg -i vhod.mp4 -c copy -movflags +faststart izhod.mp4`.
- Microsoft svoj predvajalnik pogosto spreminja; če preneha delovati, je verjetno treba posodobiti razširitev.

## 8. Za razvijalce

```
npm install          # namesti @xmldom/xmldom za teste
npm test             # testi (razčlenjevanje manifesta, združevanje MP4 z ffmpeg, AES, 429, ozadje, prepis JSON → VTT/TXT, HLS/DASH/MP4 end-to-end s sintetičnimi ffmpeg datotekami)
npm run lint         # web-ext lint --self-hosted
npm run build        # dist/stream-saver-<različica>.xpi (nepodpisana)
```

Izdajanje nove različice (podpis, GitHub Release, `updates.json`): glej `RELEASING.md`.

Zgradba: `src/background.js` (zaznavanje, prenosi, značka), `src/content.js` (ključ in ime iz
predvajalnika, prenos prek okvirja), `src/lib/mpd.js` (DASH), `src/lib/mp4.js` (združevanje MP4),
`src/lib/engine.js` (prenos, ponovni poskusi, dešifriranje), `src/lib/sink.js` (zapis na disk), `src/lib/hls.js`, `src/lib/hlsdl.js`, `src/lib/ts.js` (HLS in MPEG-TS → MP4), `src/lib/detect.js` + `src/background-generic.js` + `src/content-generic.js` + `src/popup/popup-generic.js` (splošno zaznavanje), `src/lib/transcript.js` (zaznava zahteve za prepis, pretvorba JSON → VTT/TXT), `src/popup/`.
Prepis: `src/background.js` zazna zahtevo `format=json` (webRequest), isti naslov prebere z `fetch` (po potrebi prek okvirja predvajalnika) in ga shrani prek `downloads`; `filterResponseData` se ne uporablja (dovoljenja so ostala enaka).
