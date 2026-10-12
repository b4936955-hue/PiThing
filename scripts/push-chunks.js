"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const META_PATH = path.join(ROOT, "data", "pi-index-meta.json");
const CHUNKS_PER_PUSH = 50;

function runGit(args, options = {}) {
    const result = spawnSync("git", args, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: options.quiet ? "ignore" : "inherit"
    });
    if (result.error) throw result.error;
    return result.status;
}

function assertNoStagedChanges() {
    const status = runGit(["diff", "--cached", "--quiet"], { quiet: true });
    if (status === 1) {
        throw new Error(
            "There are already staged changes. Commit or unstage them before publishing the large pi chunks."
        );
    }
    if (status !== 0) throw new Error("Could not inspect the Git staging area.");
}

function main() {
    if (!fs.existsSync(META_PATH)) return;
    const metadata = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
    if (metadata.format !== "packed9-le" ||
        !Number.isSafeInteger(metadata.chunkCount) ||
        metadata.pattern !== "pi-chunk-{index}.bin") {
        throw new Error("The packed pi chunk metadata is invalid; run build.bat before pushing.");
    }

    assertNoStagedChanges();
    const branchResult = spawnSync("git", ["branch", "--show-current"], {
        cwd: ROOT,
        encoding: "utf8"
    });
    if (branchResult.error) throw branchResult.error;
    if (branchResult.status !== 0 || !branchResult.stdout.trim()) {
        throw new Error("Could not determine the current Git branch.");
    }
    const branch = branchResult.stdout.trim();
    console.log(`Checking GitHub branch ${branch} before uploading pi chunks...`);
    if (runGit(["push", "-u", "origin", branch]) !== 0) {
        throw new Error("Could not push the current branch before uploading packed pi chunks.");
    }

    let committedBatches = 0;
    for (let start = 0; start < metadata.chunkCount; start += CHUNKS_PER_PUSH) {
        const end = Math.min(metadata.chunkCount, start + CHUNKS_PER_PUSH);
        console.log(`Checking packed chunks ${start.toLocaleString()}-${(end - 1).toLocaleString()}...`);
        const paths = [];
        for (let index = start; index < end; index++) {
            const name = `pi-chunk-${String(index).padStart(4, "0")}.bin`;
            for (const relativePath of [`data/${name}`, `docs/data/${name}`]) {
                const absolutePath = path.join(ROOT, relativePath);
                if (!fs.existsSync(absolutePath)) {
                    throw new Error(`Missing generated pi chunk: ${relativePath}. Run build.bat again.`);
                }
                paths.push(relativePath);
            }
        }

        if (runGit(["add", "--", ...paths]) !== 0) {
            throw new Error(`Could not stage packed pi chunks ${start}-${end - 1}.`);
        }

        const stagedStatus = runGit(["diff", "--cached", "--quiet"], { quiet: true });
        if (stagedStatus === 1) {
            const message = `Add packed pi chunks ${start}-${end - 1}`;
            const trailer = "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>";
            if (runGit(["commit", "-m", message, "-m", trailer]) !== 0) {
                throw new Error(`Could not commit packed pi chunks ${start}-${end - 1}.`);
            }
            if (runGit(["push", "-u", "origin", branch]) !== 0) {
                throw new Error(
                    `Push failed after chunks ${start}-${end - 1}. This batch remains committed locally; ` +
                    "resolve the Git error and run push.bat again."
                );
            }
            committedBatches++;
        } else if (stagedStatus !== 0) {
            throw new Error("Could not inspect staged pi chunk changes.");
        }
    }

    if (committedBatches === 0) {
        console.log("All packed pi chunks are already on GitHub; no chunk upload was needed.");
    } else {
        console.log(`Uploaded ${committedBatches} packed chunk batch(es) to GitHub.`);
    }
}

try {
    main();
} catch (error) {
    console.error(`Chunk push failed: ${error.message}`);
    process.exitCode = 1;
}
