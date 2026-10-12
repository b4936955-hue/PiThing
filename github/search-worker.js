"use strict";

const digitTriplets = new Uint8Array(3000);
for (let value = 0; value < 1000; value++) {
  const offset = value * 3;
  digitTriplets[offset] = 48 + Math.floor(value / 100);
  digitTriplets[offset + 1] = 48 + Math.floor(value / 10) % 10;
  digitTriplets[offset + 2] = 48 + value % 10;
}

function toText(bytes) {
  const pieces = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return pieces.join("");
}

function decodePacked(buffer, digitCount) {
  const packed = new DataView(buffer);
  const digits = new Uint8Array(digitCount);
  for (let block = 0, digitOffset = 0; digitOffset < digitCount; block++, digitOffset += 9) {
    const value = packed.getUint32(block * 4, true);
    const first = Math.floor(value / 1_000_000) * 3;
    const second = Math.floor(value / 1_000) % 1_000 * 3;
    const third = value % 1_000 * 3;
    const take = Math.min(9, digitCount - digitOffset);
    for (let digit = 0; digit < take; digit++) {
      const group = digit < 3 ? first : digit < 6 ? second : third;
      digits[digitOffset + digit] = digitTriplets[group + digit % 3];
    }
  }
  return digits;
}

// Letter rule: read digits as numbers 1-26 (A=1 ... Z=26). Take two digits together
// when they make 10-26, otherwise one digit alone. A lone 0 has no letter.
// Returns the token width (1 or 2), or 0 if the next digit is needed but not loaded yet.
// The numeric value of the token is left in tokenValue (0 means "no letter").
let tokenValue = 0;
function tokenAt(digits, i, atEnd) {
  const d = digits[i] - 48;
  if (d === 0 || d >= 3) { tokenValue = d; return 1; }
  if (i + 1 >= digits.length) {
    if (!atEnd) return 0;
    tokenValue = d;
    return 1;
  }
  const pair = d * 10 + digits[i + 1] - 48;
  if (pair <= 26) { tokenValue = pair; return 2; }
  tokenValue = d;
  return 1;
}

// Returns the letters, the digit index (within `digits`) where each letter starts,
// and how many digits were consumed (the rest must be carried into the next chunk).
function makeLetters(digits, atEnd) {
  const letters = new Uint8Array(digits.length);
  const starts = new Uint32Array(digits.length);
  let count = 0;
  let i = 0;
  while (i < digits.length) {
    const width = tokenAt(digits, i, atEnd);
    if (width === 0) break;
    if (tokenValue > 0) {
      letters[count] = 64 + tokenValue;
      starts[count] = i;
      count++;
    }
    i += width;
  }
  return { text: toText(letters.subarray(0, count)), starts, used: i };
}

function joinBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function chunkName(index) {
  return `pi-chunk-${String(index).padStart(4, "0")}.bin`;
}

function binarize(digits, threshold, invert) {
  const out = new Uint8Array(digits.length);
  for (let i = 0; i < digits.length; i++) out[i] = ((digits[i] - 48 > threshold) !== invert) ? 98 : 119; // b / w
  return toText(out);
}

// Pattern search: "." matches anything. Find the longest literal run, indexOf it natively, verify the rest.
function makeMatcher(query, wildcard) {
  if (!wildcard) return (text, from) => text.indexOf(query, from);
  let best = 0, bestLen = 0;
  for (let i = 0; i < query.length;) {
    if (query[i] === ".") { i++; continue; }
    let j = i;
    while (j < query.length && query[j] !== ".") j++;
    if (j - i > bestLen) { bestLen = j - i; best = i; }
    i = j;
  }
  const anchor = query.slice(best, best + bestLen);
  return (text, from) => {
    let at = text.indexOf(anchor, from + best);
    while (at >= 0) {
      const start = at - best;
      if (start >= from && start + query.length <= text.length) {
        let ok = true;
        for (let k = 0; k < query.length; k++) {
          const q = query.charCodeAt(k);
          if (q !== 46 && text.charCodeAt(start + k) !== q) { ok = false; break; }
        }
        if (ok) return start;
      }
      at = text.indexOf(anchor, at + 1);
    }
    return -1;
  };
}

self.onmessage = async event => {
  const { kind, query, baseUrl, digitCount, chunkDigitCount, startChunk, endChunk, minOffset, maxOffset, bw, bwThreshold, bwInvert } = event.data;
  try {
    // Offsets are always DIGIT offsets (for letters, the digit where the match's first letter starts).
    const find = makeMatcher(query, kind === "pattern");
    let carry = "";          // last query.length-1 symbols of the previous chunk
    let carryStarts = [];    // letters only: digit offset of each carried letter
    let leftover = new Uint8Array(0); // letters only: digits not yet tokenized (needs next digit)
    for (let index = startChunk; index < endChunk; index++) {
      const chunkStart = index * chunkDigitCount;
      const count = Math.min(chunkDigitCount, digitCount - chunkStart);
      const url = new URL(`data/${chunkName(index)}`, baseUrl);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load packed digit chunk ${index + 1} (HTTP ${response.status}).`);
      const buffer = await response.arrayBuffer();
      const expectedBytes = Math.ceil(count / 9) * 4;
      if (buffer.byteLength !== expectedBytes) {
        throw new Error(`Packed digit chunk ${index + 1} has ${buffer.byteLength} bytes; expected ${expectedBytes}.`);
      }

      const decoded = decodePacked(buffer, count);
      const atEnd = chunkStart + count >= digitCount;
      let segment, segmentStarts = null, base = 0;
      if (kind !== "letter") {
        segment = kind === "pattern" && bw ? binarize(decoded, bwThreshold, bwInvert) : toText(decoded);
      } else {
        // The first chunk a worker sees may start mid-token. That is harmless: any 0 or 3-9
        // always ends a token, so the parse is back in sync long before minOffset.
        const digits = leftover.length ? joinBytes(leftover, decoded) : decoded;
        base = chunkStart - leftover.length;
        const made = makeLetters(digits, atEnd);
        segment = made.text;
        segmentStarts = made.starts;
        leftover = digits.slice(made.used);
      }

      const combined = carry + segment;
      const carryLength = carry.length;
      const previousStarts = carryStarts;
      const startOf = position => position < carryLength
        ? previousStarts[position]
        : base + segmentStarts[position - carryLength];

      let matchIndex = find(combined, 0);
      while (matchIndex >= 0) {
        const offset = kind !== "letter" ? chunkStart - carryLength + matchIndex : startOf(matchIndex);
        if (offset >= minOffset && offset < maxOffset) {
          self.postMessage({ type: "done", offset });
          return;
        }
        matchIndex = find(combined, matchIndex + 1);
      }

      const keep = Math.min(combined.length, Math.max(0, query.length - 1));
      const from = combined.length - keep;
      if (kind === "letter") {
        carryStarts = [];
        for (let position = from; position < combined.length; position++) carryStarts.push(startOf(position));
      }
      carry = combined.slice(from);
      self.postMessage({ type: "progress", chunkIndex: index });
    }
    self.postMessage({ type: "done", offset: -1 });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};