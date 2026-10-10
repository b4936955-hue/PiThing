# The Library of Pi

Search, browse, and view pi as digits, letters, colors, and grayscale —
same idea as the Library of Babel, but instead of generating random
noise, it uses pi's digits as the (conjectured normal, so effectively
infinite-ish) source of "everything."

## Quick start (local test data, no download)

```
npm install
npm run gen-test-digits 5000
npm start
```

## GitHub Pages

The Express app above needs Node.js and cannot run directly on GitHub Pages.
For a static GitHub site, build the browser version from
`data/first_10_billion_digits_of_pi.txt` (10 billion decimal digits, plus the
leading `3` of pi):

```
npm run build:github
```

On Windows, `build.bat` runs the same build. The builder streams the digits
from the text file, prepends pi's leading `3` (10,000,000,001 indexed digits),
and writes the index as
nine-million-digit packed chunks (about 4 MB each, below GitHub's 100 MB
per-file limit). It writes the site to the repository root and `docs/`.
Browsing downloads only the chunks it needs; full searches scan chunks on
demand in the browser. The root `index.html` is the default entry point for
GitHub and jsDelivr. The browser version supports digit and letter
search/browsing, date patterns, and digit-color images without an API server.
Full searches use four parallel browser workers to fetch and scan separate
chunk ranges without blocking the page. Searches that find no match still
need to download and scan the complete packed index, so their speed depends
on the browser's network connection and available CPU cores.

`push.bat` builds the site, merges the latest `master` branch without replacing
remote files, and pushes the repository configured in that file.
The loader is `loader.html` and is configured for `b4936955-hue/PiThing`.
After the push, the loader reads the updated root `index.html` from the
repository. If GitHub Pages is used, select the `master` branch and `/docs`
folder. If the repository has a different name or owner, update `REMOTE_URL`
in `push.bat` and `USER`/`REPO` in `loader.html`.

The large source text and original monolithic `data/pi-digits.bin` are excluded
from Git by `.gitignore`. The build commits the split packed chunks and can
recreate the `docs/` copy from those chunks after cloning. Metadata records the
actual indexed digit count, so the client can use larger indexes without a
hard-coded one-billion-digit limit.

## Real data — local mode (fast, uses disk)

```
npm install
npm run download-pi     # fetches ~1GB from stuff.mit.edu
npm run build-index     # strips it to a packed digit file for fast lookups
npm start
```

For much larger digit counts (tens of billions+), `build-index.js`
accepts multiple chunked input files, concatenated in order:

```
node scripts/build-index.js chunk1.txt chunk2.txt chunk3.txt
```

## Real data — remote mode (nothing saved to disk)

```
npm install
```

macOS/Linux:
```
PI_REMOTE_URL=https://stuff.mit.edu/afs/sipb/contrib/pi/pi-billion.txt npm start
```

Windows PowerShell:
```
$env:PI_REMOTE_URL="https://stuff.mit.edu/afs/sipb/contrib/pi/pi-billion.txt"; npm start
```

Windows cmd:
```
set PI_REMOTE_URL=https://stuff.mit.edu/afs/sipb/contrib/pi/pi-billion.txt && npm start
```

**Read this before relying on remote mode.** Browsing (jumping to a
specific digit offset) uses HTTP Range requests — one small network
call per view, genuinely nothing written to disk, fast. Searching is a
different story: there's no way to know where an arbitrary string
occurs without looking, so a search re-downloads and re-scans the
*entire* remote file, every single time, entirely in memory. For a
~1GB file that's a real wait; it isn't a good fit for a much larger
source. This is a hard tradeoff, not a bug — nothing can make
"instant" and "nothing stored locally" both true for arbitrary
substring search. If a remote URL doesn't respond to Range requests
correctly, or isn't reachable, the server automatically falls back to
local mode and tells you why (check the terminal output, and
`/api/status`'s `remoteError` field).

Remote mode also assumes the source file is a "3." followed by one
uninterrupted run of digits with no other formatting mixed in later.
That's true of the MIT file. If you point this at something with
periodic line breaks throughout, results could be wrong — local mode
(`build-index.js`) handles that correctly by construction, since it
reads and cleans the whole file up front.

## Speed tiers (local mode)

The server automatically picks one, based on the digit file's size
against a RAM budget (`PI_MAX_RAM_MB`, default 2048):

- **ram-ascii** — small enough to decode fully into memory at startup.
  Searches are a single native buffer scan: sub-millisecond to a few
  milliseconds, even for a fairly large file.
- **ram-packed** — too big to decode fully, but the packed bytes fit
  in RAM. Still no disk I/O per search, just some CPU to decode on
  the fly — noticeably slower than ram-ascii but still fast.
- **disk** — too big for either. Streams from disk in chunks, same as
  before, now with live progress and a cancel button.

Check which tier is active via the About page or `/api/status`.

## Storage format

Digits are packed 9-per-4-bytes (base 10^9 per block) by default —
about 0.44 bytes/digit instead of 1, so a digit count that would need
~100GB as plain text needs roughly ~44GB packed. This also means the
same RAM budget holds several times more digits at full search speed
than a plain-text approach would. Pass `--text` to `build-index.js`
if you want the old one-byte-per-digit format instead (simpler, but
~2.25x the disk space).

## How search actually works

Every search — digits, letters, or an uploaded image — comes back
with the exact position AND the surrounding digits/letters, with the
match highlighted, so you can see it in context, not just get a bare
number back.

- **Digits**: a direct substring search, streamed in chunks (never
  loaded fully into memory unless the RAM tier is active) so it works
  the same whether the file is 5,000 digits or 100 billion.
- **Letters**: pi decoded as letters (see below), searched the same way.
- **Images**: your uploaded image is shrunk to a small grid, each pixel
  matched to the nearest palette color, converted back to the
  equivalent digit string, and searched exactly like a digit search —
  colors and digits are a straight 1-to-1 mapping. The result is shown
  with the matched region outlined in its surrounding context.

Long disk-tier or remote searches report live progress and can be
cancelled mid-scan.

## The letter mapping (a judgment call)

There's no single obvious way to turn 10 digits into 26 letters. This
app uses: **non-overlapping pairs of digits (00-99), mod 26, → one
letter A-Z.** It's a genuine continuous decode of the whole digit
stream (letter #500,000 is a fixed, specific letter), not something
computed only at search time. If you had a different scheme in mind,
it's isolated to `pairToLetter()` in `src/piIndex.js` (and mirrored in
`src/remoteAdapter.js`/`src/remoteSource.js` for remote mode) and easy
to swap.

## Quality-of-life extras

- Match highlighting with surrounding context, for digits, letters,
  and images.
- Live progress bar + cancel button for long (disk-tier or remote)
  searches.
- A small in-memory result cache — repeating (or re-rendering) a
  search is instant.
- "Try these" quick searches (the Feynman Point, an ascending run,
  e's digits) and a date/birthday finder (a few common digit orders).
- Search history (per-device, via localStorage), click to re-run.
- Copy buttons on the browse views.
- Elapsed time + which tier served each search, shown right in the
  result.

## Data source

https://stuff.mit.edu/afs/sipb/contrib/pi/pi-billion.txt — 1 billion
digits. For substantially more, see the JA0HXV 100-billion-digit page
or pi2e.ch's chunked releases; feed the resulting file(s) into
`build-index.js`.
