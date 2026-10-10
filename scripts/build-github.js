"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIGIT_COUNT = 1_000_000;
const BLOCK_DIGITS = 9;
const BLOCK_BYTES = 4;
const outputDir = path.join(ROOT, "docs");
const outputDataDir = path.join(outputDir, "data");
const outputDigits = path.join(outputDataDir, "pi-digits.txt");
const rootDataDir = path.join(ROOT, "data");

function writeFromPackedFile(filePath) {
    const fd = fs.openSync(filePath, "r");
    const digits = Buffer.alloc(DIGIT_COUNT);
    let written = 0;

    try {
        const blocks = Math.ceil(DIGIT_COUNT / BLOCK_DIGITS);
        const packed = Buffer.alloc(blocks * BLOCK_BYTES);
        const bytesRead = fs.readSync(fd, packed, 0, packed.length, 0);
        if (bytesRead !== packed.length) {
            throw new Error(`Packed digit file is too short: ${filePath}`);
        }

        for (let block = 0; block < blocks; block++) {
            const value = packed.readUInt32LE(block * BLOCK_BYTES);
            const chunk = String(value).padStart(BLOCK_DIGITS, "0");
            const count = Math.min(BLOCK_DIGITS, DIGIT_COUNT - written);
            digits.write(chunk.slice(0, count), written, count, "ascii");
            written += count;
        }
    } finally {
        fs.closeSync(fd);
    }

    fs.writeFileSync(outputDigits, digits);
}

function writeFromTextFile(filePath) {
    const input = fs.readFileSync(filePath, "utf8");
    const digits = input.replace(/[^0-9]/g, "").slice(0, DIGIT_COUNT);
    if (digits.length !== DIGIT_COUNT) {
        throw new Error(`Expected at least ${DIGIT_COUNT} digits in ${filePath}; found ${digits.length}.`);
    }
    fs.writeFileSync(outputDigits, digits);
}

function main() {
    const packedPath = path.join(ROOT, "data", "pi-digits.bin");
    const textSources = [
        path.join(ROOT, "data", "pi-raw.txt"),
        path.join(ROOT, "data", "pi-digits.txt"),
        outputDigits
    ];

    fs.mkdirSync(outputDataDir, { recursive: true });

    if (fs.existsSync(packedPath)) {
        writeFromPackedFile(packedPath);
    } else {
        const textSource = textSources.find(fs.existsSync);
        if (!textSource) {
            throw new Error(
                "No pi digit source found. Add data/pi-digits.bin or data/pi-raw.txt, " +
                "or run this build from a clone that already contains docs/data/pi-digits.txt."
            );
        }
        writeFromTextFile(textSource);
    }

    fs.copyFileSync(path.join(ROOT, "github", "index.html"), path.join(outputDir, "index.html"));
    fs.mkdirSync(rootDataDir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, "github", "index.html"), path.join(ROOT, "index.html"));
    fs.copyFileSync(outputDigits, path.join(rootDataDir, "pi-digits.txt"));
    console.log(`GitHub Pages site built in ${path.relative(ROOT, outputDir)}.`);
    console.log(`Included exactly ${DIGIT_COUNT.toLocaleString()} digits in ${path.relative(ROOT, outputDigits)}.`);
    console.log(`Root GitHub site built in ${path.relative(ROOT, "index.html")}.`);
}

try {
    main();
} catch (error) {
    console.error(`GitHub build failed: ${error.message}`);
    process.exitCode = 1;
}
