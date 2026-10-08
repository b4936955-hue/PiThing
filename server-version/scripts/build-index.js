"use strict";

/*
    Turns raw pi-digit source file(s) into an indexed file this app
    can search/browse quickly.

    Usage:
      node scripts/build-index.js [file1 file2 ...] [--text]

    With no files given, defaults to data/pi-raw.txt (what
    download-pi.js produces). Multiple files are concatenated IN THE
    ORDER GIVEN — this matters if you're assembling something like
    100 billion digits from several chunked downloads (e.g. the
    pi2e.ch "chunks of one hundred billion digits" releases, or
    JA0HXV's page) rather than one single file.

    By default this produces the "packed9" format: 9 decimal digits
    packed into each 4-byte block (~0.44 bytes/digit, vs 1 byte/digit
    for plain text) — for 100 billion digits that's roughly 44GB
    instead of 100GB. Pass --text to keep the old one-byte-per-digit
    format instead (simpler, but ~2.25x the disk space).

    Streams through the input in chunks — never loads a whole
    (potentially many-GB) file into memory at once.
*/

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const META_PATH = path.join(DATA_DIR, "meta.json");
const DEFAULT_RAW = path.join(DATA_DIR, "pi-raw.txt");

const DIGITS_PER_BLOCK = 9;

function parseArgs(argv) {
    const files = [];
    let useText = false;

    for (const arg of argv) {
        if (arg === "--text") useText = true;
        else files.push(arg);
    }

    if (!files.length) files.push(DEFAULT_RAW);

    return { files, format: useText ? "text" : "packed9" };
}

async function* streamDigitsFromFiles(files) {
    for (const file of files) {
        if (!fs.existsSync(file)) {
            throw new Error(`Input file not found: ${file}`);
        }

        const input = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 16 * 1024 * 1024 });

        for await (const chunk of input) {
            const digitsOnly = chunk.replace(/[^0-9]/g, "");
            if (digitsOnly) yield digitsOnly;
        }
    }
}

async function buildText(files, outPath) {
    const output = fs.createWriteStream(outPath);
    let digitCount = 0;
    let lastPrint = Date.now();

    for await (const digitsOnly of streamDigitsFromFiles(files)) {
        digitCount += digitsOnly.length;
        output.write(digitsOnly);

        if (Date.now() - lastPrint > 1000) {
            lastPrint = Date.now();
            process.stdout.write(`\r${digitCount.toLocaleString()} digits so far...`);
        }
    }

    await new Promise((resolve, reject) => output.end(err => (err ? reject(err) : resolve())));
    return digitCount;
}

async function buildPacked(files, outPath) {
    const output = fs.createWriteStream(outPath);
    let digitCount = 0;
    let leftover = ""; // <9 leftover digits carried between chunks
    let lastPrint = Date.now();

    for await (const digitsOnly of streamDigitsFromFiles(files)) {
        const pool = leftover + digitsOnly;
        const usableLen = pool.length - (pool.length % DIGITS_PER_BLOCK);
        leftover = pool.slice(usableLen);

        if (usableLen > 0) {
            const blockCount = usableLen / DIGITS_PER_BLOCK;
            const buf = Buffer.alloc(blockCount * 4);

            for (let b = 0; b < blockCount; b++) {
                const nineDigits = pool.slice(b * DIGITS_PER_BLOCK, (b + 1) * DIGITS_PER_BLOCK);
                buf.writeUInt32LE(parseInt(nineDigits, 10), b * 4);
            }

            output.write(buf);
            digitCount += usableLen;
        }

        if (Date.now() - lastPrint > 1000) {
            lastPrint = Date.now();
            process.stdout.write(`\r${digitCount.toLocaleString()} digits so far...`);
        }
    }

    // Final partial block, right-padded with zero digits (meta.json's
    // digitCount is the source of truth for where real data ends, so
    // the padding is never read back out).
    if (leftover.length > 0) {
        const padded = leftover.padEnd(DIGITS_PER_BLOCK, "0");
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(parseInt(padded, 10), 0);
        output.write(buf);
        digitCount += leftover.length;
    }

    await new Promise((resolve, reject) => output.end(err => (err ? reject(err) : resolve())));
    return digitCount;
}

async function main() {
    const { files, format } = parseArgs(process.argv.slice(2));

    fs.mkdirSync(DATA_DIR, { recursive: true });

    const outFile = format === "packed9" ? "pi-digits.bin" : "pi-digits.txt";
    const outPath = path.join(DATA_DIR, outFile);

    console.log(`Building ${format} index from:\n  ${files.join("\n  ")}\n`);

    const digitCount = format === "packed9"
        ? await buildPacked(files, outPath)
        : await buildText(files, outPath);

    const sizeBytes = fs.statSync(outPath).size;

    fs.writeFileSync(META_PATH, JSON.stringify({
        digitCount,
        letterCount: Math.floor(digitCount / 2),
        format,
        file: outFile,
        sizeBytes,
        builtAt: new Date().toISOString(),
        sources: files
    }, null, 2));

    console.log(`\n\nDone: ${digitCount.toLocaleString()} digits indexed.`);
    console.log(`Written to ${outPath} (${(sizeBytes / 1e9).toFixed(2)} GB)`);
    if (format === "packed9") {
        const textEquivalent = digitCount / 1e9;
        console.log(`(the old one-byte-per-digit format would have needed ~${textEquivalent.toFixed(2)} GB)`);
    }
    console.log("Next: `npm start`");
}

main().catch((err) => {
    console.error("\nIndexing failed:", err.message);
    process.exit(1);
});
