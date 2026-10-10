// Packs a plain-text pi file into data/pi-N.bin (9 digits per 4 bytes) + data/meta.json.
//   node tools/pack.js pi.txt
// pi.txt = the archive.org file ("3.14159..."), any dots/newlines/spaces are ignored.
// Output is ~0.444 bytes per digit: 100 million digits -> ~44 MB (under jsDelivr's 50 MB/file limit).
const fs = require("fs");
const path = require("path");
const input = process.argv[2];
if (!input) { console.error("usage: node tools/pack.js pi.txt"); process.exit(1); }

const CHUNK_DIGITS = 9_000_000;           // 1,000,000 blocks = 4,000,000 bytes per file
const outDir = path.join(__dirname, "..", "data");
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (/^pi-\d+\.(bin|txt)$/.test(f)) fs.unlinkSync(path.join(outDir, f));

const fd = fs.openSync(input, "r");
const buf = Buffer.alloc(CHUNK_DIGITS);
let filled = 0, total = 0, chunkIndex = 0;

function flush(n) {
  const blocks = Math.ceil(n / 9), out = Buffer.alloc(blocks * 4);
  for (let b = 0; b < blocks; b++) {
    let v = 0;
    for (let k = 0; k < 9; k++) { const i = b * 9 + k; v = v * 10 + (i < n ? buf[i] - 48 : 0); }
    out.writeUInt32BE(v, b * 4);
  }
  fs.writeFileSync(path.join(outDir, `pi-${chunkIndex++}.bin`), out);
  total += n; filled = 0;
  process.stdout.write(`\rpacked ${total.toLocaleString()} digits`);
}

const read = Buffer.alloc(1 << 22);
let pos = 0, n;
while ((n = fs.readSync(fd, read, 0, read.length, pos)) > 0) {
  pos += n;
  for (let i = 0; i < n; i++) {
    const c = read[i];
    if (c < 48 || c > 57) continue;     // skip "." newlines spaces
    buf[filled++] = c;
    if (filled === CHUNK_DIGITS) flush(filled);
  }
}
if (filled) flush(filled);
fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({
  digitCount: total, chunkSize: CHUNK_DIGITS, chunkCount: chunkIndex, format: "packed9",
  note: "pi digits: '3' then the decimals, no dot. 9 digits per big-endian uint32."
}));
console.log(`\ndone: ${total.toLocaleString()} digits in ${chunkIndex} files`);
