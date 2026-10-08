"use strict";

/*
    Wraps src/remoteSource.js so it looks like src/piIndex.js from
    server.js's point of view — same method names/shapes — so the
    routes don't need to know or care which mode they're in.
*/

const remote = require("./remoteSource");

let url = null;
let detected = null;
let ready = false;
let initError = null;

async function init(remoteUrl) {
    url = remoteUrl;

    try {
        detected = await remote.detectSource(url);

        if (!detected.rangeSupported) {
            throw new Error(
                "That server didn't respond to a Range request the way a static " +
                "file host normally does, so remote browsing can't be trusted to " +
                "read the right bytes. Local mode (download + build-index) is the " +
                "reliable option for this source."
            );
        }

        ready = true;
        initError = null;
    } catch (err) {
        initError = err.message;
        ready = false;
    }

    return ready;
}

function isReady() { return ready; }
function getInitError() { return initError; }
function getSourceUrl() { return url; }
function getDigitCount() { return detected ? (detected.approxDigitCount || 0) : 0; }
function getTier() { return "remote"; }
function getFormat() { return "remote"; }

async function getDigits(offset, length) {
    return remote.getDigitsRemote(url, detected, offset, length);
}

function pairToLetter(pairStr) {
    const value = parseInt(pairStr, 10) % 26;
    return String.fromCharCode(65 + value);
}

async function getLettersAt(letterOffset, length) {
    const digits = await getDigits(letterOffset * 2, length * 2);
    let letters = "";
    for (let i = 0; i + 1 < digits.length; i += 2) {
        letters += pairToLetter(digits.slice(i, i + 2));
    }
    return letters;
}

async function getColorsAt(offset, length) {
    const digits = await getDigits(offset, length);
    return digits.split("").map(Number);
}

async function getDigitContext(matchOffset, matchLength, radius = 40) {
    const start = Math.max(0, matchOffset - radius);
    const [before, match, after] = await Promise.all([
        getDigits(start, matchOffset - start),
        getDigits(matchOffset, matchLength),
        getDigits(matchOffset + matchLength, radius)
    ]);
    return { before, match, after, contextStart: start };
}

async function getLetterContext(matchOffset, matchLength, radius = 40) {
    const start = Math.max(0, matchOffset - radius);
    const [before, match, after] = await Promise.all([
        getLettersAt(start, matchOffset - start),
        getLettersAt(matchOffset, matchLength),
        getLettersAt(matchOffset + matchLength, radius)
    ]);
    return { before, match, after, contextStart: start };
}

function validateDigitQuery(query) {
    if (!/^[0-9]+$/.test(query)) throw new Error("That query isn't made only of digits 0-9.");
    if (query.length > 200) throw new Error("Search text is too long (200 digits max).");
}

async function searchDigits(query, options = {}) {
    validateDigitQuery(query);
    const { offset, cancelled } = await remote.searchDigitsRemote(url, query, options);
    return { offset, tier: "remote", cancelled };
}

async function searchLetters(query, options = {}) {
    const clean = query.toUpperCase().replace(/[^A-Z]/g, "");
    if (!clean.length) throw new Error("Enter some letters to search for.");
    if (clean.length > 100) throw new Error("Search text is too long (100 letters max).");

    const { offset, cancelled } = await remote.searchLettersRemote(url, clean, options);
    return { offset, tier: "remote", cancelled };
}

module.exports = {
    init,
    isReady,
    getInitError,
    getSourceUrl,
    getDigitCount,
    getTier,
    getFormat,
    getDigits,
    getLettersAt,
    getColorsAt,
    getDigitContext,
    getLetterContext,
    validateDigitQuery,
    searchDigits,
    searchLetters,
    RAM_BUDGET_BYTES: 0
};
