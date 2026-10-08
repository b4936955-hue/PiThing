"use strict";

const express = require("express");
const path = require("path");
const multer = require("multer");
const sharp = require("sharp");

const pi = require("./src/piIndex");
const remoteAdapter = require("./src/remoteAdapter");
const colors = require("./src/colors");

const PORT = process.env.PORT || 3001;
const MAX_IMAGE_GRID = 40;
const CONTEXT_RADIUS = 40;
const REMOTE_URL = process.env.PI_REMOTE_URL || null;

pi.init();

// `source` is whichever backend is actually active — local indexed
// file by default, or the remote (zero-local-storage) adapter if
// PI_REMOTE_URL is set and the remote responds sanely. Every route
// below talks to `source`, not `pi` directly, so this is the only
// place that needs to know which mode is running.
let source = pi;
let remoteInitPromise = Promise.resolve();

if (REMOTE_URL) {
    remoteInitPromise = remoteAdapter.init(REMOTE_URL).then((ok) => {
        if (ok) {
            source = remoteAdapter;
            console.log(`Remote mode active: ${REMOTE_URL}`);
            console.log(`(${remoteAdapter.getDigitCount().toLocaleString()} digits detected, nothing saved locally)`);
        } else {
            console.log(`Remote mode requested but failed: ${remoteAdapter.getInitError()}`);
            console.log("Falling back to local mode.");
        }
    });
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// If express.json() fails to parse the request body (malformed/empty
// JSON), it calls next(err) and — without this handler — Express's
// default error page (an HTML doctype) gets sent back. Any client
// code doing res.json() on that response then fails with something
// like `"<!DOCTYPE ... is not valid JSON"`. Catch it here and always
// respond with JSON instead.
app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
        return res.status(400).json({ success: false, error: "Invalid JSON in request body." });
    }
    next(err);
});

const upload = multer({
    limits: { fileSize: 15 * 1024 * 1024 },
    storage: multer.memoryStorage()
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "main.html"));
});

/*
============================================================
STATUS
============================================================
*/

app.get("/api/status", async (req, res) => {
    await remoteInitPromise;

    res.json({
        ready: source.isReady(),
        digitCount: source.isReady() ? source.getDigitCount() : 0,
        letterCount: source.isReady() ? Math.floor(source.getDigitCount() / 2) : 0,
        format: source.getFormat(),
        tier: source.getTier(),
        ramBudgetMB: Math.round((source.RAM_BUDGET_BYTES || 0) / 1024 / 1024),
        remote: Boolean(REMOTE_URL),
        remoteUrl: REMOTE_URL,
        remoteError: source === pi && REMOTE_URL ? remoteAdapter.getInitError() : null,
        palette: colors.PALETTE.map(p => ({ digit: p.digit, name: p.name, hex: p.hex }))
    });
});

/*
============================================================
BROWSE (random access — instant locally; a small network round
trip in remote mode, but still nothing saved to disk there)
============================================================
*/

app.get("/api/digits", async (req, res) => {
    try {
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const length = Math.min(2000, Math.max(1, Number(req.query.length) || 100));
        const digits = await source.getDigits(offset, length);
        res.json({ success: true, offset, digits });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.get("/api/letters", async (req, res) => {
    try {
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const length = Math.min(2000, Math.max(1, Number(req.query.length) || 100));
        const letters = await source.getLettersAt(offset, length);
        res.json({ success: true, offset, letters });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/*
============================================================
SEARCH (NDJSON: zero or more progress lines, then one result line)

In local RAM tiers this still "streams" — it just happens that the
first (and only) line written is the final result, since those
searches finish before there's anything to report progress on. In
remote mode, progress reflects real download bytes. Same client
code handles every case uniformly.
============================================================
*/

function ndjsonSearch(kind) {
    return async (req, res) => {
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Cache-Control", "no-cache");

        const write = (obj) => res.write(JSON.stringify(obj) + "\n");

        const controller = new AbortController();
        res.on("close", () => {
            if (!res.writableEnded) controller.abort();
        });

        const query = String(req.body.query || "").trim();
        const started = Date.now();

        try {
            if (kind === "digits") source.validateDigitQuery(query);

            let lastSent = 0;
            const onProgress = (fraction) => {
                const now = Date.now();
                if (now - lastSent > 150) { // throttle so we're not flooding the connection
                    lastSent = now;
                    write({ type: "progress", fraction });
                }
            };

            const searchFn = kind === "digits" ? source.searchDigits : source.searchLetters;
            const { offset, tier, cancelled } = await searchFn(query, { signal: controller.signal, onProgress });

            if (cancelled) {
                write({ type: "cancelled" });
                return res.end();
            }

            const elapsedMs = Date.now() - started;
            const total = kind === "digits" ? source.getDigitCount() : Math.floor(source.getDigitCount() / 2);

            if (offset === null) {
                write({ type: "result", found: false, tier, elapsedMs, total });
                return res.end();
            }

            const context = kind === "digits"
                ? await source.getDigitContext(offset, query.length, CONTEXT_RADIUS)
                : await source.getLetterContext(offset, query.toUpperCase().replace(/[^A-Z]/g, "").length, CONTEXT_RADIUS);

            write({ type: "result", found: true, offset, tier, elapsedMs, total, context });
            res.end();
        } catch (error) {
            write({ type: "error", error: error.message });
            res.end();
        }
    };
}

app.post("/api/search/digits", ndjsonSearch("digits"));
app.post("/api/search/letters", ndjsonSearch("letters"));

/*
============================================================
IMAGES
============================================================
*/

function renderSvg(digitsOrColors, width, height, mode, highlight) {
    const cell = 12;
    const rects = [];

    for (let i = 0; i < digitsOrColors.length; i++) {
        const digit = digitsOrColors[i];
        const x = (i % width) * cell;
        const y = Math.floor(i / width) * cell;
        const fill = mode === "grayscale" ? colors.digitToGray(digit) : colors.DIGIT_TO_HEX[digit];
        rects.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${fill}"/>`);
    }

    let border = "";
    if (highlight) {
        const hx = highlight.x * cell;
        const hy = highlight.y * cell;
        border = `<rect x="${hx}" y="${hy}" width="${highlight.w * cell}" height="${highlight.h * cell}" ` +
            `fill="none" stroke="#ffffff" stroke-width="2"/>`;
    }

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width * cell} ${height * cell}" ` +
        `width="${width * cell}" height="${height * cell}">${rects.join("")}${border}</svg>`
    );
}

app.get("/api/image", async (req, res) => {
    try {
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const width = Math.min(MAX_IMAGE_GRID, Math.max(1, Number(req.query.width) || 20));
        const height = Math.min(MAX_IMAGE_GRID, Math.max(1, Number(req.query.height) || 20));
        const mode = req.query.mode === "grayscale" ? "grayscale" : "color";

        const digits = await source.getColorsAt(offset, width * height);
        const svg = renderSvg(digits, width, height, mode);

        res.type("image/svg+xml").send(svg);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Same idea as /api/image, but renders a wider surrounding view with
// the actual matched sub-grid outlined — the "highlight what you
// searched" view for images.
app.get("/api/image/context", async (req, res) => {
    try {
        const matchOffset = Math.max(0, Number(req.query.offset) || 0);
        const width = Math.min(20, Math.max(1, Number(req.query.width) || 6));
        const height = Math.min(20, Math.max(1, Number(req.query.height) || 6));
        const mode = req.query.mode === "grayscale" ? "grayscale" : "color";

        const pad = 2; // extra cells of surrounding context on each side
        const totalWidth = width + pad * 2;
        const totalHeight = height + pad * 2;
        const contextOffset = Math.max(0, matchOffset - pad * totalWidth);

        const digits = await source.getColorsAt(contextOffset, totalWidth * totalHeight);
        const svg = renderSvg(digits, totalWidth, totalHeight, mode, {
            x: pad, y: pad, w: width, h: height
        });

        res.type("image/svg+xml").send(svg);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post("/api/search/image", upload.single("image"), async (req, res) => {
    try {
        if (!req.file) throw new Error("No image uploaded.");

        const width = Math.min(12, Math.max(2, Number(req.body.width) || 6));
        const height = Math.min(12, Math.max(2, Number(req.body.height) || 6));

        const { data, info } = await sharp(req.file.buffer)
            .resize(width, height, { fit: "fill" })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const digitPattern = [];
        for (let i = 0; i < info.width * info.height; i++) {
            const r = data[i * 3];
            const g = data[i * 3 + 1];
            const b = data[i * 3 + 2];
            digitPattern.push(colors.nearestDigitForRgb(r, g, b));
        }

        const query = digitPattern.join("");
        const started = Date.now();
        const { offset, tier } = await source.searchDigits(query);
        const elapsedMs = Date.now() - started;

        res.json({
            success: true,
            found: offset !== null,
            offset,
            tier,
            elapsedMs,
            width: info.width,
            height: info.height,
            pattern: digitPattern,
            digitCount: source.getDigitCount()
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Final safety net: catch anything that throws/next(err)'s past every
// route above and still return JSON, never Express's default HTML
// error page (which is what was breaking client-side res.json() calls).
app.use((err, req, res, next) => {
    console.error("Unhandled route error:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ success: false, error: err.message || "Internal server error." });
});

/*
============================================================
START
============================================================
*/

app.listen(PORT, async () => {
    await remoteInitPromise;

    console.log("");
    console.log("======================================");
    console.log("       THE LIBRARY OF PI");
    console.log("======================================");
    console.log(`http://localhost:${PORT}`);

    if (!source.isReady()) {
        console.log("");
        console.log("NOTE: no pi digit source is ready.");
        if (REMOTE_URL) {
            console.log(`Remote mode was requested (${REMOTE_URL}) but isn't working — see above.`);
        }
        console.log("Run `npm run download-pi` then `npm run build-index`,");
        console.log("or `npm run gen-test-digits` for a small local test set,");
        console.log("or set PI_REMOTE_URL to browse/search a remote source with nothing saved locally.");
    } else {
        console.log(`Loaded: ${source.getDigitCount().toLocaleString()} digits`);
        console.log(`Mode: ${source.getTier()}` +
            (source === pi ? ` (RAM budget: ${Math.round(pi.RAM_BUDGET_BYTES / 1024 / 1024)}MB — set PI_MAX_RAM_MB to change)` : ""));
    }

    console.log("");
});

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});
