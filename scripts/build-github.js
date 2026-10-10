"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIGIT_COUNT = 1_000_000_000;
const CHUNK_DIGIT_COUNT = 9_000_000;
const DIGITS_PER_BLOCK = 9;
const BYTES_PER_BLOCK = 4;
const SOURCE_PATH = path.join(ROOT, "data", "pi-digits.bin");
const ROOT_DATA_DIR = path.join(ROOT, "data");
const DOCS_DIR = path.join(ROOT, "docs");
const ROOT_META_PATH = path.join(ROOT_DATA_DIR, "pi-billion-meta.json");
const DOCS_DATA_DIR = path.join(DOCS_DIR, "data");

function writeIfChanged(filePath, contents) {
    const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    if (fs.existsSync(filePath) && fs.statSync(filePath).size === buffer.length) {
        const current = fs.readFileSync(filePath);
        if (current.equals(buffer)) return;
    }
    fs.writeFileSync(filePath, buffer);
}

function writePackedChunks() {
    const requiredBytes = Math.ceil(DIGIT_COUNT / DIGITS_PER_BLOCK) * BYTES_PER_BLOCK;
    const sourceSize = fs.statSync(SOURCE_PATH).size;
    if (sourceSize < requiredBytes) {
        throw new Error(
            `Packed pi source is too short: expected at least ${requiredBytes} bytes, found ${sourceSize}.`
        );
    }

    const chunkCount = Math.ceil(DIGIT_COUNT / CHUNK_DIGIT_COUNT);
    const sourceFd = fs.openSync(SOURCE_PATH, "r");
    try {
        for (let index = 0; index < chunkCount; index++) {
            const firstDigit = index * CHUNK_DIGIT_COUNT;
            const digitCount = Math.min(CHUNK_DIGIT_COUNT, DIGIT_COUNT - firstDigit);
            const byteCount = Math.ceil(digitCount / DIGITS_PER_BLOCK) * BYTES_PER_BLOCK;
            const packed = Buffer.alloc(byteCount);
            let bytesRead = 0;

            while (bytesRead < byteCount) {
                const count = fs.readSync(
                    sourceFd,
                    packed,
                    bytesRead,
                    byteCount - bytesRead,
                    firstDigit / DIGITS_PER_BLOCK * BYTES_PER_BLOCK + bytesRead
                );
                if (count === 0) throw new Error(`Unexpected end of packed pi data at chunk ${index}.`);
                bytesRead += count;
            }

            const name = `pi-billion-${String(index).padStart(3, "0")}.bin`;
            writeIfChanged(path.join(ROOT_DATA_DIR, name), packed);
            writeIfChanged(path.join(DOCS_DATA_DIR, name), packed);
            console.log(`Wrote ${name} (${digitCount.toLocaleString()} digits).`);
        }
    } finally {
        fs.closeSync(sourceFd);
    }

    return {
        digitCount: DIGIT_COUNT,
        chunkDigitCount: CHUNK_DIGIT_COUNT,
        chunkCount,
        format: "packed9-le",
        pattern: "pi-billion-{index}.bin"
    };
}

function copyExistingChunks() {
    const chunkCount = Math.ceil(DIGIT_COUNT / CHUNK_DIGIT_COUNT);
    for (let index = 0; index < chunkCount; index++) {
        const digitCount = Math.min(CHUNK_DIGIT_COUNT, DIGIT_COUNT - index * CHUNK_DIGIT_COUNT);
        const expectedBytes = Math.ceil(digitCount / DIGITS_PER_BLOCK) * BYTES_PER_BLOCK;
        const name = `pi-billion-${String(index).padStart(3, "0")}.bin`;
        const sourcePath = path.join(ROOT_DATA_DIR, name);
        if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size !== expectedBytes) {
            throw new Error(
                `Missing packed source ${sourcePath}. Restore data/pi-digits.bin or all checked-in pi-billion chunks.`
            );
        }
        fs.copyFileSync(sourcePath, path.join(DOCS_DATA_DIR, name));
    }

    return {
        digitCount: DIGIT_COUNT,
        chunkDigitCount: CHUNK_DIGIT_COUNT,
        chunkCount,
        format: "packed9-le",
        pattern: "pi-billion-{index}.bin"
    };
}

function main() {
    fs.mkdirSync(ROOT_DATA_DIR, { recursive: true });
    fs.mkdirSync(DOCS_DATA_DIR, { recursive: true });
    const metadata = fs.existsSync(SOURCE_PATH) ? writePackedChunks() : copyExistingChunks();
    const serializedMetadata = JSON.stringify(metadata, null, 2);
    writeIfChanged(ROOT_META_PATH, serializedMetadata);
    writeIfChanged(path.join(DOCS_DATA_DIR, "pi-billion-meta.json"), serializedMetadata);

    const page = fs.readFileSync(path.join(ROOT, "github", "index.html"));
    writeIfChanged(path.join(DOCS_DIR, "index.html"), page);
    writeIfChanged(path.join(ROOT, "index.html"), page);

    for (const oldDigitsPath of [
        path.join(ROOT_DATA_DIR, "pi-digits.txt"),
        path.join(DOCS_DATA_DIR, "pi-digits.txt")
    ]) {
        if (fs.existsSync(oldDigitsPath)) fs.unlinkSync(oldDigitsPath);
    }

    console.log(`GitHub site built with ${DIGIT_COUNT.toLocaleString()} digits in ${metadata.chunkCount} packed chunks.`);
}

try {
    main();
} catch (error) {
    console.error(`GitHub build failed: ${error.message}`);
    process.exitCode = 1;
}
