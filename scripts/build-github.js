"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CHUNK_DIGIT_COUNT = 9_000_000;
const DIGITS_PER_BLOCK = 9;
const BYTES_PER_BLOCK = 4;
const PREFIX_DIGIT_COUNT = 1;
const TEXT_SOURCE_PATH = path.join(ROOT, "data", "first_10_billion_digits_of_pi.txt");
const PACKED_SOURCE_PATH = path.join(ROOT, "data", "pi-digits.bin");
const ROOT_DATA_DIR = path.join(ROOT, "data");
const DOCS_DIR = path.join(ROOT, "docs");
const ROOT_META_PATH = path.join(ROOT_DATA_DIR, "pi-index-meta.json");
const DOCS_DATA_DIR = path.join(DOCS_DIR, "data");

function chunkFileName(index) {
    return `pi-chunk-${String(index).padStart(4, "0")}.bin`;
}

function writeIfChanged(filePath, contents) {
    const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    if (fs.existsSync(filePath) && fs.statSync(filePath).size === buffer.length) {
        const current = fs.readFileSync(filePath);
        if (current.equals(buffer)) return;
    }
    fs.writeFileSync(filePath, buffer);
}

function isValidMetadata(metadata) {
    return metadata !== null &&
        typeof metadata === "object" &&
        metadata.format === "packed9-le" &&
        Number.isSafeInteger(metadata.digitCount) &&
        metadata.digitCount > 0 &&
        Number.isSafeInteger(metadata.chunkDigitCount) &&
        metadata.chunkDigitCount > 0 &&
        Number.isSafeInteger(metadata.chunkCount) &&
        metadata.chunkCount === Math.ceil(metadata.digitCount / metadata.chunkDigitCount) &&
        metadata.pattern === "pi-chunk-{index}.bin";
}

function expectedChunkBytes(metadata, index) {
    const digitsInChunk = Math.min(
        metadata.chunkDigitCount,
        metadata.digitCount - index * metadata.chunkDigitCount
    );
    return Math.ceil(digitsInChunk / DIGITS_PER_BLOCK) * BYTES_PER_BLOCK;
}

function hasCompleteChunks(directory, metadata) {
    for (let index = 0; index < metadata.chunkCount; index++) {
        const filePath = path.join(directory, chunkFileName(index));
        if (!fs.existsSync(filePath) || fs.statSync(filePath).size !== expectedChunkBytes(metadata, index)) {
            return false;
        }
    }
    return true;
}

function publishChunk(index, packed, digitCount) {
    const fileName = chunkFileName(index);
    writeIfChanged(path.join(ROOT_DATA_DIR, fileName), packed);
    writeIfChanged(path.join(DOCS_DATA_DIR, fileName), packed);
    return digitCount;
}

function packTextSource() {
    const sourceSize = fs.statSync(TEXT_SOURCE_PATH).size;
    if (!Number.isSafeInteger(sourceSize) || sourceSize < 1) {
        throw new Error(`Invalid pi text source size: ${sourceSize} bytes.`);
    }

    // This source is the digits after the decimal point; prepend pi's leading 3.
    const digitCount = sourceSize + PREFIX_DIGIT_COUNT;
    const chunkCount = Math.ceil(digitCount / CHUNK_DIGIT_COUNT);
    const sourceFd = fs.openSync(TEXT_SOURCE_PATH, "r");
    const readBuffer = Buffer.alloc(16 * 1024 * 1024);
    let sourceOffset = 0;
    let outputDigitCount = 0;
    let chunkIndex = 0;
    let chunkDigits = 0;
    let chunkBytes = 0;
    let packedValue = 0;
    let packedDigits = 0;
    let lastProgress = 0;

    const packed = Buffer.alloc(Math.ceil(CHUNK_DIGIT_COUNT / DIGITS_PER_BLOCK) * BYTES_PER_BLOCK);

    function appendDigit(digit) {
        packedValue = packedValue * 10 + digit;
        packedDigits++;
        chunkDigits++;
        outputDigitCount++;

        if (packedDigits === DIGITS_PER_BLOCK) {
            packed.writeUInt32LE(packedValue, chunkBytes);
            chunkBytes += BYTES_PER_BLOCK;
            packedValue = 0;
            packedDigits = 0;
        }

        if (chunkDigits === CHUNK_DIGIT_COUNT) {
            publishChunk(chunkIndex++, packed.subarray(0, chunkBytes), chunkDigits);
            chunkDigits = 0;
            chunkBytes = 0;
        }
    }

    try {
        appendDigit(3);

        while (sourceOffset < sourceSize) {
            const bytesRead = fs.readSync(
                sourceFd,
                readBuffer,
                0,
                Math.min(readBuffer.length, sourceSize - sourceOffset),
                sourceOffset
            );
            if (bytesRead === 0) throw new Error(`Unexpected end of pi text source at byte ${sourceOffset}.`);

            for (let i = 0; i < bytesRead; i++) {
                const digit = readBuffer[i] - 48;
                if (digit < 0 || digit > 9) {
                    throw new Error(`Expected a digits-only source; invalid byte at offset ${sourceOffset + i}.`);
                }
                appendDigit(digit);
            }

            sourceOffset += bytesRead;
            const completedHundredMillions = Math.floor(outputDigitCount / 100_000_000);
            if (completedHundredMillions > lastProgress) {
                lastProgress = completedHundredMillions;
                console.log(`${Math.min(outputDigitCount, digitCount).toLocaleString()} / ${digitCount.toLocaleString()} digits packed.`);
            }
        }

        if (packedDigits > 0) {
            packedValue *= 10 ** (DIGITS_PER_BLOCK - packedDigits);
            packed.writeUInt32LE(packedValue, chunkBytes);
            chunkBytes += BYTES_PER_BLOCK;
        }
        if (chunkDigits > 0) {
            publishChunk(chunkIndex++, packed.subarray(0, chunkBytes), chunkDigits);
        }
    } finally {
        fs.closeSync(sourceFd);
    }

    if (outputDigitCount !== digitCount || chunkIndex !== chunkCount) {
        throw new Error(
            `Packed ${outputDigitCount} digits into ${chunkIndex} chunks; expected ${digitCount} digits and ${chunkCount} chunks.`
        );
    }

    return { digitCount, chunkDigitCount: CHUNK_DIGIT_COUNT, chunkCount, format: "packed9-le", pattern: "pi-chunk-{index}.bin" };
}

function copyPackedSource() {
    const digitCount = 1_000_000_000;
    const requiredBytes = Math.ceil(digitCount / DIGITS_PER_BLOCK) * BYTES_PER_BLOCK;
    const sourceSize = fs.statSync(PACKED_SOURCE_PATH).size;
    if (sourceSize < requiredBytes) {
        throw new Error(`Packed pi source is too short: expected ${requiredBytes} bytes, found ${sourceSize}.`);
    }

    const chunkCount = Math.ceil(digitCount / CHUNK_DIGIT_COUNT);
    const sourceFd = fs.openSync(PACKED_SOURCE_PATH, "r");
    try {
        for (let index = 0; index < chunkCount; index++) {
            const firstDigit = index * CHUNK_DIGIT_COUNT;
            const count = Math.min(CHUNK_DIGIT_COUNT, digitCount - firstDigit);
            const byteCount = Math.ceil(count / DIGITS_PER_BLOCK) * BYTES_PER_BLOCK;
            const packed = Buffer.alloc(byteCount);
            let bytesRead = 0;
            while (bytesRead < byteCount) {
                const read = fs.readSync(sourceFd, packed, bytesRead, byteCount - bytesRead, firstDigit / DIGITS_PER_BLOCK * BYTES_PER_BLOCK + bytesRead);
                if (read === 0) throw new Error(`Unexpected end of packed pi source at chunk ${index}.`);
                bytesRead += read;
            }
            publishChunk(index, packed, count);
        }
    } finally {
        fs.closeSync(sourceFd);
    }

    return { digitCount, chunkDigitCount: CHUNK_DIGIT_COUNT, chunkCount, format: "packed9-le", pattern: "pi-chunk-{index}.bin" };
}

function copyExistingChunks() {
    const previousMeta = JSON.parse(fs.readFileSync(ROOT_META_PATH, "utf8"));
    if (!isValidMetadata(previousMeta)) {
        throw new Error("Cannot rebuild: the packed source and valid previous chunk metadata are both missing.");
    }

    for (let index = 0; index < previousMeta.chunkCount; index++) {
        const sourcePath = path.join(ROOT_DATA_DIR, chunkFileName(index));
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Cannot rebuild: missing packed chunk ${sourcePath}.`);
        }
        if (fs.statSync(sourcePath).size !== expectedChunkBytes(previousMeta, index)) {
            throw new Error(`Cannot rebuild: packed chunk ${sourcePath} has an unexpected size.`);
        }

        const docsPath = path.join(DOCS_DATA_DIR, chunkFileName(index));
        if (!fs.existsSync(docsPath) ||
            fs.statSync(docsPath).size !== expectedChunkBytes(previousMeta, index)) {
            fs.copyFileSync(sourcePath, docsPath);
        }
    }
    return previousMeta;
}

function removeStaleGeneratedChunks(chunkCount) {
    const chunkPattern = /^pi-chunk-(\d+)\.bin$/;
    for (const directory of [ROOT_DATA_DIR, DOCS_DATA_DIR]) {
        for (const entry of fs.readdirSync(directory)) {
            const match = chunkPattern.exec(entry);
            if (match && Number(match[1]) >= chunkCount) {
                fs.unlinkSync(path.join(directory, entry));
            }
            if (/^pi-billion-\d+\.bin$/.test(entry)) {
                fs.unlinkSync(path.join(directory, entry));
            }
        }
    }
}

function main() {
    const args = process.argv.slice(2);
    if (args.some(argument => argument !== "--repack")) {
        throw new Error("Unknown argument. Use --repack to rebuild all chunks from the text source.");
    }
    const forceRepack = args.includes("--repack");

    fs.mkdirSync(ROOT_DATA_DIR, { recursive: true });
    fs.mkdirSync(DOCS_DATA_DIR, { recursive: true });

    let metadata;
    if (!forceRepack && fs.existsSync(ROOT_META_PATH)) {
        const previousMeta = JSON.parse(fs.readFileSync(ROOT_META_PATH, "utf8"));
        if (isValidMetadata(previousMeta)) {
            const sourceSizeMatches = !fs.existsSync(TEXT_SOURCE_PATH) ||
                fs.statSync(TEXT_SOURCE_PATH).size + PREFIX_DIGIT_COUNT === previousMeta.digitCount;
            if (sourceSizeMatches && hasCompleteChunks(ROOT_DATA_DIR, previousMeta)) {
                console.log(
                    `Reusing ${previousMeta.chunkCount.toLocaleString()} existing packed chunks; ` +
                    "skipping the full digit repack."
                );
                metadata = copyExistingChunks();
            }
        }
    }

    if (!metadata && fs.existsSync(TEXT_SOURCE_PATH)) {
        console.log("Packing the pi text source. This can take a while for 10 billion digits...");
        metadata = packTextSource();
    } else if (!metadata && fs.existsSync(ROOT_META_PATH)) {
        metadata = copyExistingChunks();
    } else if (!metadata && fs.existsSync(PACKED_SOURCE_PATH)) {
        metadata = copyPackedSource();
    } else if (!metadata) {
        throw new Error(
            "No pi source found. Add data/first_10_billion_digits_of_pi.txt, " +
            "data/pi-digits.bin, or all packed pi chunks."
        );
    }

    const serializedMetadata = JSON.stringify(metadata, null, 2);
    writeIfChanged(ROOT_META_PATH, serializedMetadata);
    writeIfChanged(path.join(DOCS_DATA_DIR, "pi-index-meta.json"), serializedMetadata);

    const page = fs.readFileSync(path.join(ROOT, "github", "index.html"));
    writeIfChanged(path.join(DOCS_DIR, "index.html"), page);
    writeIfChanged(path.join(ROOT, "index.html"), page);
    const searchWorker = fs.readFileSync(path.join(ROOT, "github", "search-worker.js"));
    writeIfChanged(path.join(DOCS_DIR, "search-worker.js"), searchWorker);
    writeIfChanged(path.join(ROOT, "search-worker.js"), searchWorker);

    removeStaleGeneratedChunks(metadata.chunkCount);
    for (const oldMetaPath of [
        path.join(ROOT_DATA_DIR, "pi-billion-meta.json"),
        path.join(DOCS_DATA_DIR, "pi-billion-meta.json"),
        path.join(ROOT_DATA_DIR, "pi-digits.txt"),
        path.join(DOCS_DATA_DIR, "pi-digits.txt")
    ]) {
        if (fs.existsSync(oldMetaPath)) fs.unlinkSync(oldMetaPath);
    }

    console.log(`GitHub site built with ${metadata.digitCount.toLocaleString()} digits in ${metadata.chunkCount} packed chunks.`);
}

try {
    main();
} catch (error) {
    console.error(`GitHub build failed: ${error.message}`);
    process.exitCode = 1;
}
