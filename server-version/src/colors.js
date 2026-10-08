"use strict";

/*
============================================================
COLOR PALETTE

The digit -> color mapping you specified. Every digit 0-9 maps
to exactly one color, and the mapping is a bijection, which
matters: it means "search for a color sequence" is exactly the
same operation as "search for a digit sequence" once you swap
colors back to their digits — no separate index needed.
============================================================
*/

const PALETTE = [
    { digit: 0, name: "black",       hex: "#000000", rgb: [0, 0, 0] },
    { digit: 1, name: "orange",      hex: "#ff8c00", rgb: [255, 140, 0] },
    { digit: 2, name: "green",       hex: "#1fa64a", rgb: [31, 166, 74] },
    { digit: 3, name: "red",         hex: "#e8112d", rgb: [232, 17, 45] },
    { digit: 4, name: "purple",      hex: "#8a2be2", rgb: [138, 43, 226] },
    { digit: 5, name: "brown",       hex: "#8b5a2b", rgb: [139, 90, 43] },
    { digit: 6, name: "pink",        hex: "#ff69b4", rgb: [255, 105, 180] },
    { digit: 7, name: "gray",        hex: "#808080", rgb: [128, 128, 128] },
    { digit: 8, name: "light green", hex: "#90ee90", rgb: [144, 238, 144] },
    { digit: 9, name: "blue",        hex: "#1f75fe", rgb: [31, 117, 254] }
];

const DIGIT_TO_HEX = PALETTE.map(p => p.hex);
const DIGIT_TO_NAME = PALETTE.map(p => p.name);

/*
    "Pi as black and white": a separate, purely numeric grayscale
    reading (not the named palette above) — digit value scaled
    straight to a gray intensity, 0 (black) through 9 (near-white).
*/
function digitToGray(digit) {
    const v = Math.round((digit / 9) * 255);
    return `rgb(${v},${v},${v})`;
}

function nearestDigitForRgb(r, g, b) {
    let best = 0;
    let bestDist = Infinity;

    for (const p of PALETTE) {
        const [pr, pg, pb] = p.rgb;
        const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;

        if (dist < bestDist) {
            bestDist = dist;
            best = p.digit;
        }
    }

    return best;
}

module.exports = {
    PALETTE,
    DIGIT_TO_HEX,
    DIGIT_TO_NAME,
    digitToGray,
    nearestDigitForRgb
};
