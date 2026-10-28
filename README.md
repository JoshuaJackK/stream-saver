# Stream Saver

Firefox razširitev za shranjevanje posnetkov predavanj iz Microsoft Stream (SharePoint/OneDrive, tudi Teams) in ločeno samo prepisa (.txt/.vtt) – **samo za osebno uporabo**.

**Spoštovanje zaščite dostopa:** razširitev ne zaobide nobene zaščite. Shrani le tisto, kar tvoj brskalnik med predvajanjem že sam prejema, z isto prijavo, in samo za posnetke, ki jih lahko sam gledaš. Posnetkov in prepisov ne deli naprej. Ne uporabljaj je za posnetke, ki ti jih lastnik ni namenil.

## Namestitev
1. Prenesi zadnjo podpisano datoteko `stream-saver-<različica>.xpi` iz [Releases](https://github.com/JoshuaJackK/stream-saver/releases/latest).
2. Odpri jo v Firefoxu (povleci v okno ali `about:addons` → ⚙ → **Namesti dodatek iz datoteke …**) in potrdi **Dodaj**.

Od različice **1.1.2** se razširitev posodablja sama (prek `updates.json` v tem repozitoriju). Starejših različic (1.0.x, 1.1.0) Firefox sam ne posodobi – 1.1.2 namesti ročno, enkrat.

## Navodila
Podrobna navodila v slovenščini (uporaba, shranjevanje po predmetih, samo prepis, omejitve): **[README_SL.md](README_SL.md)**.
Izdajanje novih različic: [RELEASING.md](RELEASING.md).

Razvoj: `npm install`, `npm test`, `npm run lint`, `npm run build`.
