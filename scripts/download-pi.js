"use strict";

/*
    Downloads the 1-billion-digit pi file. This has to be run on
    YOUR machine, not built into the app — it's ~1GB and the
    sandbox this project was built in only has network access to a
    small allowlist of package registries, not arbitrary websites.
*/

const fs = require("fs");
const https = require("https");
const path = require("path");

const URL = "https://stuff.mit.edu/afs/sipb/contrib/pi/pi-billion.txt";
const OUT_PATH = path.join(__dirname, "..", "data", "pi-raw.txt");

function download(url, outPath, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (redirectsLeft <= 0) {
                    reject(new Error("Too many redirects."));
                    return;
                }
                res.resume();
                resolve(download(res.headers.location, outPath, redirectsLeft - 1));
                return;
            }

            if (res.statusCode !== 200) {
                reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                return;
            }

            const total = Number(res.headers["content-length"]) || null;
            let downloaded = 0;
            let lastPrint = 0;

            const file = fs.createWriteStream(outPath);
            res.pipe(file);

            res.on("data", (chunk) => {
                downloaded += chunk.length;
                const now = Date.now();
                if (now - lastPrint > 1000) {
                    lastPrint = now;
                    const mb = (downloaded / 1e6).toFixed(1);
                    if (total) {
                        const pct = ((downloaded / total) * 100).toFixed(1);
                        process.stdout.write(`\rDownloading... ${mb}MB (${pct}%)`);
                    } else {
                        process.stdout.write(`\rDownloading... ${mb}MB`);
                    }
                }
            });

            file.on("finish", () => {
                process.stdout.write("\n");
                file.close(resolve);
            });

            file.on("error", reject);
        });

        req.on("error", reject);
    });
}

async function main() {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

    console.log(`Downloading pi digits from:\n  ${URL}\n`);
    console.log("This is about 1GB — it'll take a while depending on your connection.\n");

    await download(URL, OUT_PATH);

    console.log(`\nSaved to ${OUT_PATH}`);
    console.log("Next: run `npm run build-index`");
}

main().catch((err) => {
    console.error("Download failed:", err.message);
    process.exit(1);
});
