"use strict";

/*
============================================================
PI INDEX v2

Two storage formats, chosen by build-index.js and recorded in
meta.json:

  - "text"    one ASCII digit per byte (simple, what v1 used)
  - "packed9" nine decimal digits packed into one 4-byte
              unsigned int (base 10^9 per block) — ~0.44
              bytes/digit instead of 1, so the same disk budget
              holds ~2.25x as many digits, and more importantly
              the same RAM budget holds far more too.

Three speed tiers, chosen automatically at startup based on
file size vs. a RAM budget (PI_MAX_RAM_MB, default 2048):

  - "ram-ascii"   the whole file fits comfortably as decoded
                  ASCII within budget -> decode it ALL once at
                  startup, search is a single native Buffer
                  #indexOf call. This is the "already loaded,
                  shouldn't take a minute" case — sub-millisecond
                  to low-millisecond searches.
  - "ram-packed"  decoded ASCII wouldn't fit, but the packed
                  bytes do -> keep the packed buffer resident and
                  decode on the fly per search. No disk I/O, so
                  still fast (CPU/memory-bound, not I/O-bound) —
                  this is what makes ~10x more digits usable at
                  "fast" speed within the same RAM than the old
                  text-format approach could manage.
  - "disk"        too big for either -> stream from disk in
                  chunks, same overlap-safe scanning as before,
                  now with progress reporting and cancellation.
============================================================
*/

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const META_FILE = path.join(DATA_DIR, "meta.json");

const RAM_BUDGET_BYTES = Number(process.env.PI_MAX_RAM_BYTES) || (Number(process.env.PI_MAX_RAM_MB) || 2048) * 1024 * 1024;
const CHUNK_SIZE = Number(process.env.PI_TEST_CHUNK_SIZE) || 32 * 1024 * 1024;
const DIGITS_PER_BLOCK = 9;
const BLOCK_BYTES = 4;

let meta = null;
let digitsFilePath = null;
let fd = null;
let ready = false;

let tier = null;          // "ram-ascii" | "ram-packed" | "disk"
let ramAscii = null;      // Buffer of ASCII digit bytes, tier === "ram-ascii"
let ramPacked = null;     // Buffer of packed uint32 blocks, tier === "ram-packed"

// Small LRU-ish cache of recent exact-query results, so repeating
// (or re-rendering) the same search is instant regardless of tier.
const SEARCH_CACHE_LIMIT = 200;
const searchCache = new Map();

function cacheGet(key) {
    if (!searchCache.has(key)) return undefined;
    const val = searchCache.get(key);
    searchCache.delete(key);
    searchCache.set(key, val); // bump to most-recently-used
    return val;
}

function cacheSet(key, val) {
    if (searchCache.has(key)) searchCache.delete(key);
    searchCache.set(key, val);
    if (searchCache.size > SEARCH_CACHE_LIMIT) {
        searchCache.delete(searchCache.keys().next().value);
    }
}

function isReady() {
    return ready;
}

function getTier() {
    return tier;
}

function getDigitCount() {
    return meta ? meta.digitCount : 0;
}

function getFormat() {
    return meta ? meta.format : null;
}

/*
============================================================
INIT
============================================================
*/

function init() {
    if (!fs.existsSync(META_FILE)) {
        ready = false;
        return false;
    }

    meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    digitsFilePath = path.join(DATA_DIR, meta.file);

    if (!fs.existsSync(digitsFilePath)) {
        ready = false;
        return false;
    }

    const fileSize = fs.statSync(digitsFilePath).size;
    fd = fs.openSync(digitsFilePath, "r");

    if (meta.format === "text") {
        if (fileSize <= RAM_BUDGET_BYTES) {
            ramAscii = Buffer.alloc(fileSize);
            fs.readSync(fd, ramAscii, 0, fileSize, 0);
            tier = "ram-ascii";
        } else {
            tier = "disk";
        }
    } else if (meta.format === "packed9") {
        const decodedSize = meta.digitCount; // 1 byte per digit if fully decoded
        if (decodedSize <= RAM_BUDGET_BYTES) {
            const packedBuf = Buffer.alloc(fileSize);
            fs.readSync(fd, packedBuf, 0, fileSize, 0);
            ramAscii = decodeBlocksToAscii(packedBuf, 0, meta.digitCount);
            tier = "ram-ascii";
        } else if (fileSize <= RAM_BUDGET_BYTES) {
            ramPacked = Buffer.alloc(fileSize);
            fs.readSync(fd, ramPacked, 0, fileSize, 0);
            tier = "ram-packed";
        } else {
            tier = "disk";
        }
    } else {
        throw new Error(`Unknown pi data format "${meta.format}" in meta.json.`);
    }

    searchCache.clear();
    ready = true;
    return true;
}

function requireReady() {
    if (!ready) {
        throw new Error(
            "The pi digit file isn't set up yet. Run `npm run download-pi` " +
            "then `npm run build-index` (or `npm run gen-test-digits` for a " +
            "small local test set) and restart the server."
        );
    }
}

/*
============================================================
PACKED9 DECODE HELPERS
============================================================
*/

// Decodes a range of BLOCKS (not digits) from a packed buffer into an
// ASCII digit buffer, then trims to the exact requested digit range.
// `blockBase` is which block index byte 0 of packedBuf corresponds
// to — 0 when packedBuf is the whole file (ram tiers), or the slice's
// own start block when packedBuf is only a partial read from disk.
function decodeBlocksToAscii(packedBuf, digitOffset, digitLength, blockBase = 0) {
    const startBlock = Math.floor(digitOffset / DIGITS_PER_BLOCK);
    const endBlock = Math.floor((digitOffset + digitLength - 1) / DIGITS_PER_BLOCK);
    const blockCount = endBlock - startBlock + 1;

    const out = Buffer.alloc(blockCount * DIGITS_PER_BLOCK);

    for (let b = 0; b < blockCount; b++) {
        const byteOffset = (startBlock + b - blockBase) * BLOCK_BYTES;
        let value = packedBuf.readUInt32LE(byteOffset);

        // Write 9 digits, least-significant first, then we've built
        // them back-to-front — fill from the end of this block's slot.
        const base = b * DIGITS_PER_BLOCK;
        for (let i = DIGITS_PER_BLOCK - 1; i >= 0; i--) {
            out[base + i] = 48 + (value % 10); // ASCII '0' + digit
            value = (value / 10) | 0;
        }
    }

    const sliceStart = digitOffset - startBlock * DIGITS_PER_BLOCK;
    return out.subarray(sliceStart, sliceStart + digitLength);
}

// Same, but reads directly from disk (used only in "disk" tier).
function readPackedRangeFromDisk(digitOffset, digitLength) {
    const startBlock = Math.floor(digitOffset / DIGITS_PER_BLOCK);
    const endBlock = Math.floor((digitOffset + digitLength - 1) / DIGITS_PER_BLOCK);
    const blockCount = endBlock - startBlock + 1;
    const byteStart = startBlock * BLOCK_BYTES;
    const byteLength = blockCount * BLOCK_BYTES;

    const packedBuf = Buffer.alloc(byteLength);
    fs.readSync(fd, packedBuf, 0, byteLength, byteStart);

    // packedBuf holds ONLY blocks [startBlock..endBlock], so tell the
    // decoder that byte 0 of this buffer corresponds to block startBlock,
    // not block 0 of the whole file.
    return decodeBlocksToAscii(packedBuf, digitOffset, digitLength, startBlock);
}

/*
============================================================
RANDOM ACCESS
============================================================
*/

function getDigits(offset, length) {
    requireReady();

    if (offset < 0 || length < 1) {
        throw new Error("Invalid offset or length.");
    }

    const clampedLength = Math.min(length, meta.digitCount - offset);
    if (clampedLength <= 0) return "";

    if (tier === "ram-ascii") {
        return ramAscii.toString("ascii", offset, offset + clampedLength);
    }

    if (tier === "ram-packed") {
        return decodeBlocksToAscii(ramPacked, offset, clampedLength).toString("ascii");
    }

    // disk tier
    if (meta.format === "text") {
        const buf = Buffer.alloc(clampedLength);
        fs.readSync(fd, buf, 0, clampedLength, offset);
        return buf.toString("ascii");
    }
    return readPackedRangeFromDisk(offset, clampedLength).toString("ascii");
}

function pairToLetter(pairStr) {
    const value = parseInt(pairStr, 10) % 26;
    return String.fromCharCode(65 + value);
}

function getLettersAt(letterOffset, length) {
    const digitOffset = letterOffset * 2;
    const digits = getDigits(digitOffset, length * 2);

    let letters = "";
    for (let i = 0; i + 1 < digits.length; i += 2) {
        letters += pairToLetter(digits.slice(i, i + 2));
    }
    return letters;
}

function getColorsAt(offset, length) {
    const digits = getDigits(offset, length);
    return digits.split("").map(d => Number(d));
}

/*
============================================================
CONTEXT (for highlighting matches in the UI)
============================================================
*/

function getDigitContext(matchOffset, matchLength, radius = 40) {
    const start = Math.max(0, matchOffset - radius);
    const before = getDigits(start, matchOffset - start);
    const match = getDigits(matchOffset, matchLength);
    const after = getDigits(matchOffset + matchLength, radius);
    return { before, match, after, contextStart: start };
}

function getLetterContext(matchOffset, matchLength, radius = 40) {
    const start = Math.max(0, matchOffset - radius);
    const before = getLettersAt(start, matchOffset - start);
    const match = getLettersAt(matchOffset, matchLength);
    const after = getLettersAt(matchOffset + matchLength, radius);
    return { before, match, after, contextStart: start };
}

/*
============================================================
SEARCH
============================================================
*/

function validateDigitQuery(query) {
    if (!/^[0-9]+$/.test(query)) {
        throw new Error("That query isn't made only of digits 0-9.");
    }
    if (query.length > 200) {
        throw new Error("Search text is too long (200 digits max).");
    }
}

// options: { signal: AbortSignal, onProgress: (fraction) => void }
async function searchDigits(query, options = {}) {
    requireReady();
    validateDigitQuery(query);

    const cacheKey = "d:" + query;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
        return { offset: cached, tier: "cache" };
    }

    if (tier === "ram-ascii") {
        const offset = ramAscii.indexOf(query, 0, "ascii");
        const result = offset === -1 ? null : offset;
        cacheSet(cacheKey, result);
        return { offset: result, tier };
    }

    if (tier === "ram-packed") {
        const offset = searchWithinPackedBuffer(ramPacked, query);
        cacheSet(cacheKey, offset);
        return { offset, tier };
    }

    // disk tier — stream, with progress + cancellation
    const { offset, cancelled } = await streamSearchDigitsFromDisk(query, options);
    if (!cancelled) cacheSet(cacheKey, offset);
    return { offset, tier, cancelled };
}

// Scans an in-RAM packed buffer by decoding it in large sub-chunks
// (so we're not materializing hundreds of millions of ASCII bytes at
// once) with the same overlap-safe technique used for disk streaming.
function searchWithinPackedBuffer(packedBuf, query) {
    const needle = Buffer.from(query, "ascii");
    const overlapSize = needle.length - 1;

    const blocksPerSubchunk = 4_000_000; // 16MB packed -> 36M digits per pass
    const totalBlocks = Math.ceil(meta.digitCount / DIGITS_PER_BLOCK);

    let carry = Buffer.alloc(0);
    let digitBase = 0;

    for (let blockStart = 0; blockStart < totalBlocks; blockStart += blocksPerSubchunk) {
        const blockCount = Math.min(blocksPerSubchunk, totalBlocks - blockStart);
        const digitOffset = blockStart * DIGITS_PER_BLOCK;
        const digitLength = Math.min(blockCount * DIGITS_PER_BLOCK, meta.digitCount - digitOffset);

        const ascii = decodeBlocksToAscii(packedBuf, digitOffset, digitLength);
        const buf = carry.length ? Buffer.concat([carry, ascii]) : ascii;
        const idx = buf.indexOf(needle);

        if (idx !== -1) {
            return digitBase - carry.length + idx;
        }

        digitBase += ascii.length;
        carry = overlapSize > 0 ? buf.subarray(Math.max(0, buf.length - overlapSize)) : Buffer.alloc(0);
    }

    return null;
}

function streamSearchDigitsFromDisk(query, { signal, onProgress } = {}) {
    return new Promise((resolve, reject) => {
        const needle = Buffer.from(query, "ascii");
        const overlapSize = needle.length - 1;
        const totalBytes = fs.statSync(digitsFilePath).size;

        let carry = Buffer.alloc(0);       // ASCII-space overlap carry
        let byteCarry = Buffer.alloc(0);   // packed9 only: 0-3 leftover raw bytes to keep block-aligned
        let baseOffset = 0; // in digits
        let bytesRead = 0;
        let found = null;

        const stream = fs.createReadStream(digitsFilePath, { highWaterMark: CHUNK_SIZE });

        const onAbort = () => stream.destroy(new Error("cancelled"));
        if (signal) signal.addEventListener("abort", onAbort, { once: true });

        stream.on("data", (rawChunk) => {
            bytesRead += rawChunk.length;

            let asciiChunk;

            if (meta.format === "text") {
                asciiChunk = rawChunk;
            } else {
                // packed9: keep block alignment across chunk boundaries
                // by carrying over any leftover partial-block bytes.
                const combined = byteCarry.length ? Buffer.concat([byteCarry, rawChunk]) : rawChunk;
                const usableBytes = combined.length - (combined.length % BLOCK_BYTES);
                byteCarry = combined.subarray(usableBytes);

                if (usableBytes === 0) {
                    return; // not even one full block yet — wait for more data
                }

                const packedSlice = combined.subarray(0, usableBytes);
                const blockCount = usableBytes / BLOCK_BYTES;
                const digitsInSlice = Math.min(blockCount * DIGITS_PER_BLOCK, meta.digitCount - baseOffset);

                asciiChunk = decodeBlocksToAscii(packedSlice, 0, digitsInSlice);
            }

            const buf = carry.length ? Buffer.concat([carry, asciiChunk]) : asciiChunk;
            const idx = buf.indexOf(needle);

            if (idx !== -1) {
                found = baseOffset - carry.length + idx;
                stream.destroy();
                return;
            }

            baseOffset += asciiChunk.length;
            carry = overlapSize > 0
                ? buf.subarray(Math.max(0, buf.length - overlapSize))
                : Buffer.alloc(0);

            if (onProgress) onProgress(bytesRead / totalBytes);
        });

        stream.on("close", () => {
            if (signal) signal.removeEventListener("abort", onAbort);
            resolve({ offset: found, cancelled: false });
        });
        stream.on("end", () => resolve({ offset: found, cancelled: false }));
        stream.on("error", (err) => {
            if (err.message === "cancelled") resolve({ offset: found, cancelled: true });
            else reject(err);
        });
    });
}

async function searchLetters(query, options = {}) {
    requireReady();

    const clean = query.toUpperCase().replace(/[^A-Z]/g, "");
    if (!clean.length) throw new Error("Enter some letters to search for.");
    if (clean.length > 100) throw new Error("Search text is too long (100 letters max).");

    const cacheKey = "l:" + clean;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
        return { offset: cached, tier: "cache" };
    }

    // Build the full letter stream lazily, chunk by chunk, from
    // whichever tier we're in — getDigits already abstracts over
    // ram-ascii / ram-packed / disk, so this one implementation
    // covers all three (disk tier is naturally slower, same as
    // before, but correctness and cancellation work identically).
    const needle = Buffer.from(clean, "ascii");
    const overlapSize = needle.length - 1;
    const stepDigits = 8_000_000; // digits per pass, i.e. 4M letters

    let carry = Buffer.alloc(0);
    let letterBase = 0;
    let found = null;

    for (let offset = 0; offset < meta.digitCount; offset += stepDigits) {
        if (options.signal && options.signal.aborted) break;

        const length = Math.min(stepDigits, meta.digitCount - offset);
        const evenLength = length - (length % 2);
        if (evenLength <= 0) break;

        const digits = getDigits(offset, evenLength);
        let letters = "";
        for (let i = 0; i < digits.length; i += 2) {
            letters += pairToLetter(digits.slice(i, i + 2));
        }

        const letterBuf = Buffer.from(letters, "ascii");
        const buf = carry.length ? Buffer.concat([carry, letterBuf]) : letterBuf;
        const idx = buf.indexOf(needle);

        if (idx !== -1) {
            found = letterBase - carry.length + idx;
            break;
        }

        letterBase += letterBuf.length;
        carry = overlapSize > 0 ? buf.subarray(Math.max(0, buf.length - overlapSize)) : Buffer.alloc(0);

        if (options.onProgress) options.onProgress((offset + evenLength) / meta.digitCount);
    }

    cacheSet(cacheKey, found);
    return { offset: found, tier };
}

module.exports = {
    init,
    isReady,
    getTier,
    getFormat,
    getDigitCount,
    getDigits,
    getLettersAt,
    getColorsAt,
    getDigitContext,
    getLetterContext,
    pairToLetter,
    searchDigits,
    searchLetters,
    validateDigitQuery,
    RAM_BUDGET_BYTES
};
