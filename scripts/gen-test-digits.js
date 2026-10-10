"use strict";

/*
    Computes real digits of pi locally (Rabinowitz-Wagon spigot
    algorithm, pure BigInt — no external dependency) so the app can
    be tested end-to-end without waiting on a ~1GB download, and runs
    them through the SAME build-index.js pipeline the real data uses
    — so this exercises the actual production code path, not a
    separate one. Not meant to replace the real file: the spigot
    algorithm is slow per-digit, so this is only practical for a few
    tens of thousands of digits, not a billion.

    Usage: node scripts/gen-test-digits.js [digitCount] [--text]
    Default: 5000 digits, packed9 format.
*/

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DATA_DIR = path.join(__dirname, "..", "data");
const RAW_PATH = path.join(DATA_DIR, "pi-raw.txt");

function* piDigits() {
    let q = 1n, r = 0n, t = 1n, k = 1n, n = 3n, l = 3n;

    while (true) {
        if (4n * q + r - t < n * t) {
            yield n;
            const nq = 10n * q;
            const nr = 10n * (r - n * t);
            const nn = (10n * (3n * q + r)) / t - 10n * n;
            q = nq; r = nr; n = nn;
        } else {
            const nq = q * k;
            const nr = (2n * q + r) * l;
            const nt = t * l;
            const nn = (q * (7n * k + 2n) + r * l) / (t * l);
            q = nq; r = nr; t = nt; n = nn; k += 1n; l += 2n;
        }
    }
}

function main() {
    const args = process.argv.slice(2);
    const useText = args.includes("--text");
    const count = Number(args.find(a => /^\d+$/.test(a))) || 5000;

    fs.mkdirSync(DATA_DIR, { recursive: true });

    console.log(`Computing ${count.toLocaleString()} digits of pi locally...`);

    const out = fs.createWriteStream(RAW_PATH);
    const gen = piDigits();
    let produced = 0;
    let lastPrint = Date.now();

    while (produced < count) {
        const { value } = gen.next();
        out.write(String(value));
        produced++;

        if (Date.now() - lastPrint > 1000) {
            lastPrint = Date.now();
            process.stdout.write(`\r${produced.toLocaleString()} / ${count.toLocaleString()}`);
        }
    }

    out.end(() => {
        console.log(`\n\nWrote raw digits to ${RAW_PATH}. Building index...\n`);

        const buildArgs = [path.join(__dirname, "build-index.js"), RAW_PATH];
        if (useText) buildArgs.push("--text");

        execFileSync(process.execPath, buildArgs, { stdio: "inherit" });
    });
}

main();
