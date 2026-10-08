# PiThing (static)

Open `index.html` — nothing to install or run.

- `index.html` — the whole Library of Pi app. It does the searching in your browser.
- `data/` — 100,000,001 digits of pi ("3" + 100 million decimals), packed 9 digits per 4 bytes (about 44 MB total) in 12 files of ~4 MB, plus `meta.json`.
- `tools/pack.js` — rebuilds `data/` from a plain-text pi file: `node tools/pack.js pi.txt`
- `server-version/` — the original Node/Express version.

Live URL once pushed:
https://quantil.jsdelivr.net/gh/b4936955-hue/PiThing@latest/index.html
