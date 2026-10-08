"use strict";

/*
============================================================
REMOTE SOURCE

An alternative to the local indexed file — talks directly to a
remote URL, keeping NOTHING on disk. Two very different
operations, same as the local index, but with a real tradeoff
this file can't hide:

  - browse (getDigitsRemote) is fast and cheap: one HTTP Range
    request for exactly the bytes you asked for. MIT's file (and
    most static file servers) support this.

  - search (searchDigitsRemote) has no way around re-downloading
    and re-scanning the ENTIRE remote file, every single time you
    search, because there's no index — nothing is cached between
    searches. For a ~1GB file that's a real wait (network-bound,
    not CPU-bound); for anything approaching 100GB it would be
    impractical. This is the direct cost of not keeping a local
    copy — there's no clever way to make both "instant" and
    "nothing stored locally" true for arbitrary substring search.

IMPORTANT ASSUMPTION: this only works correctly if the remote
file is a "3." followed by one uninterrupted run of digits, with
no other formatting (newlines, spaces) mixed into the digit
stream. That's true of many pi-digit dumps but not guaranteed —
if a source has periodic line breaks, byte offset stops lining
up with digit offset, and results here would be wrong. The local
build-index.js pipeline handles that correctly by construction
(it strips non-digit characters as it goes); this module cannot,
because it doesn't read the whole file up front. If you're not
sure, use local mode.
============================================================
*/

const https = require("https");
const http = require("http");

function clientFor(url) {
    return url.startsWith("https:") ? https : http;
}

function request(url, headers, signal) {
    return new Promise((resolve, reject) => {
        const client = clientFor(url);
        const req = client.get(url, { headers }, resolve);
        req.on("error", reject);
        if (signal) {
            const onAbort = () => req.destroy(new Error("cancelled"));
            signal.addEventListener("abort", onAbort, { once: true });
            req.on("close", () => signal.removeEventListener("abort", onAbort));
        }
    });
}

/*
    Fetches a small initial sample and works out exactly how many
    non-digit bytes (header text, and critically the "." in "3.")
    sit before the digit stream truly becomes contiguous — so byte
    offset N+skipCount reliably corresponds to digit offset N for
    any offset beyond the sample. This is what makes the extremely
    common "3.14159..." format work correctly: the "." between
    digit 0 and digit 1 is exactly one such skip byte, and a naive
    "skip a fixed header length" approach (as an earlier version of
    this file did) gets every subsequent digit off by one.

    Also confirms the server honors Range requests at all — if it
    doesn't (returns 200 instead of 206), browsing would silently
    read the wrong bytes, so we detect and report that clearly
    instead.
*/
async function detectSource(url) {
    const sampleSize = 4096;
    const res = await request(url, { Range: `bytes=0-${sampleSize - 1}` });

    const rangeSupported = res.statusCode === 206;

    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    const sample = Buffer.concat(chunks);

    const skipPositions = [];
    for (let i = 0; i < sample.length; i++) {
        const byte = sample[i];
        if (byte < 48 || byte > 57) skipPositions.push(i);
    }

    if (skipPositions.length === sample.length) {
        throw new Error("Couldn't find any digits near the start of that URL.");
    }

    let totalBytes = null;
    const contentRange = res.headers["content-range"];
    if (contentRange) {
        const m = contentRange.match(/\/(\d+)$/);
        if (m) totalBytes = Number(m[1]);
    } else if (res.headers["content-length"] && res.statusCode === 200) {
        totalBytes = Number(res.headers["content-length"]);
    }

    return {
        rangeSupported,
        skipPositions,          // exact non-digit byte positions within the sample
        sampleSize: sample.length,
        totalBytes,
        approxDigitCount: totalBytes ? totalBytes - skipPositions.length : null
    };
}

// Converts a digit offset to the exact byte offset in the remote
// file, using the sample's skip-position map for anything within
// the sample, and a constant shift (total skip bytes found) for
// anything beyond it — correct as long as no further non-digit
// bytes occur later in the file, which is the documented assumption
// this whole module rests on.
function digitOffsetToByteOffset(offset, detected) {
    let digitsSeenBeforeSample = 0;
    let byteInSample = 0;

    for (byteInSample = 0; byteInSample < detected.sampleSize; byteInSample++) {
        if (!detected.skipPositions.includes(byteInSample)) {
            if (digitsSeenBeforeSample === offset) return byteInSample;
            digitsSeenBeforeSample++;
        }
    }

    // Offset falls beyond the sampled window: shift by the total
    // number of non-digit bytes we found (assumed to be all of them).
    return offset + detected.skipPositions.length;
}

async function getDigitsRemote(url, detected, offset, length) {
    // Clamp defensively, same as the local index does — asking for
    // more digits than the file actually has causes the server's
    // Content-Length to not match what it can actually send, which
    // otherwise surfaces as a confusing "aborted" error far from here.
    const clampedLength = detected.approxDigitCount != null
        ? Math.max(0, Math.min(length, detected.approxDigitCount - offset))
        : length;

    if (clampedLength <= 0) return "";

    const start = digitOffsetToByteOffset(offset, detected);
    const end = digitOffsetToByteOffset(offset + clampedLength - 1, detected);

    const res = await request(url, { Range: `bytes=${start}-${end}` });

    if (res.statusCode !== 206 && res.statusCode !== 200) {
        throw new Error(`Remote source returned HTTP ${res.statusCode}.`);
    }

    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("ascii");

    // Defensive: strip anything that isn't a digit, in case a stray
    // non-digit character landed inside this window despite the "no
    // further interior formatting" assumption.
    return raw.replace(/[^0-9]/g, "");
}

/*
    Streams the WHOLE remote file once (no local write at any point —
    each chunk is scanned then discarded) using the same overlap-safe
    technique as the local disk scanner. This is the honestly-slow
    path: expect it to take roughly as long as downloading the file
    would, because that's exactly what it's doing.
*/
/*
    Streams the WHOLE remote file once (no local write at any point —
    each chunk is scanned then discarded) using the same overlap-safe
    technique as the local disk scanner. Unlike getDigitsRemote, this
    doesn't need to know where the header/skip bytes are: every chunk
    has non-digit characters filtered out as it arrives, so the
    resulting stream is correct regardless of where a "3." or any
    other formatting shows up.

    This is the honestly-slow path: expect it to take roughly as long
    as downloading the file would, because that's exactly what it's
    doing.
*/
/*
    Low-level building block: yields the remote file's content as a
    stream of DIGIT-ONLY buffers (non-digit bytes already stripped),
    plus a running byte-progress fraction. Both searchDigitsRemote and
    the letters equivalent are built on this, so there's one streaming
    implementation instead of two near-identical ones.
*/
async function* streamCleanDigits(url, { signal, onProgress } = {}) {
    const res = await request(url, {}, signal);

    if (res.statusCode !== 200 && res.statusCode !== 206) {
        throw new Error(`Remote source returned HTTP ${res.statusCode}.`);
    }

    const totalBytes = Number(res.headers["content-length"]) || null;
    let bytesRead = 0;

    for await (const chunk of res) {
        bytesRead += chunk.length;
        if (onProgress && totalBytes) onProgress(bytesRead / totalBytes);

        const clean = chunk.toString("ascii").replace(/[^0-9]/g, "");
        if (clean.length) yield Buffer.from(clean, "ascii");
    }
}

/*
    Streams the WHOLE remote file once (no local write at any point —
    each chunk is scanned then discarded) using the same overlap-safe
    technique as the local disk scanner. This is the honestly-slow
    path: expect it to take roughly as long as downloading the file
    would, because that's exactly what it's doing.
*/
async function searchDigitsRemote(url, query, { signal, onProgress } = {}) {
    const needle = Buffer.from(query, "ascii");
    const overlapSize = needle.length - 1;

    let carry = Buffer.alloc(0);
    let baseOffset = 0;

    try {
        for await (const chunk of streamCleanDigits(url, { signal, onProgress })) {
            const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
            const idx = buf.indexOf(needle);

            if (idx !== -1) {
                return { offset: baseOffset - carry.length + idx, cancelled: false };
            }

            baseOffset += chunk.length;
            carry = overlapSize > 0 ? buf.subarray(Math.max(0, buf.length - overlapSize)) : Buffer.alloc(0);
        }

        return { offset: null, cancelled: false };
    } catch (err) {
        if (err.message === "cancelled" || (signal && signal.aborted)) {
            return { offset: null, cancelled: true };
        }
        throw err;
    }
}

// Same idea, but the haystack is the decoded LETTER stream (pairs of
// digits mod 26 -> A-Z), built on the fly from the same digit stream.
async function searchLettersRemote(url, cleanQuery, { signal, onProgress } = {}) {
    const needle = Buffer.from(cleanQuery, "ascii");
    const overlapSize = needle.length - 1;

    let digitCarry = "";
    let letterCarry = Buffer.alloc(0);
    let letterBase = 0;

    try {
        for await (const chunk of streamCleanDigits(url, { signal, onProgress })) {
            const digits = digitCarry + chunk.toString("ascii");
            const usable = digits.length - (digits.length % 2);
            digitCarry = digits.slice(usable);

            let letters = "";
            for (let i = 0; i < usable; i += 2) {
                letters += pairToLetter(digits.slice(i, i + 2));
            }

            const letterBuf = Buffer.from(letters, "ascii");
            const buf = letterCarry.length ? Buffer.concat([letterCarry, letterBuf]) : letterBuf;
            const idx = buf.indexOf(needle);

            if (idx !== -1) {
                return { offset: letterBase - letterCarry.length + idx, cancelled: false };
            }

            letterBase += letterBuf.length;
            letterCarry = overlapSize > 0
                ? buf.subarray(Math.max(0, buf.length - overlapSize))
                : Buffer.alloc(0);
        }

        return { offset: null, cancelled: false };
    } catch (err) {
        if (err.message === "cancelled" || (signal && signal.aborted)) {
            return { offset: null, cancelled: true };
        }
        throw err;
    }
}

function pairToLetter(pairStr) {
    const value = parseInt(pairStr, 10) % 26;
    return String.fromCharCode(65 + value);
}

module.exports = { detectSource, getDigitsRemote, searchDigitsRemote, searchLettersRemote };
