// pi-worker-version: parallel-v4
"use strict";

const digitTriplets = new Uint8Array(3000);
for (let value = 0; value < 1000; value++) {
  const offset = value * 3;
  digitTriplets[offset] = 48 + Math.floor(value / 100);
  digitTriplets[offset + 1] = 48 + Math.floor(value / 10) % 10;
  digitTriplets[offset + 2] = 48 + value % 10;
}

const decoder = new TextDecoder("latin1"); // all our bytes are ASCII, so this is exact and very fast
function toText(bytes) { return decoder.decode(bytes); }
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function decodePacked(buffer, digitCount) {
  const words = LITTLE_ENDIAN ? new Uint32Array(buffer) : null;
  const view = words ? null : new DataView(buffer);
  const T = digitTriplets;
  const digits = new Uint8Array(digitCount);
  const full = Math.floor(digitCount / 9);
  let o = 0;
  for (let block = 0; block < full; block++, o += 9) {
    const value = words ? words[block] : view.getUint32(block * 4, true);
    const a = ((value / 1000000) | 0) * 3;
    const b = (((value / 1000) | 0) % 1000) * 3;
    const c = (value % 1000) * 3;
    digits[o] = T[a]; digits[o + 1] = T[a + 1]; digits[o + 2] = T[a + 2];
    digits[o + 3] = T[b]; digits[o + 4] = T[b + 1]; digits[o + 5] = T[b + 2];
    digits[o + 6] = T[c]; digits[o + 7] = T[c + 1]; digits[o + 8] = T[c + 2];
  }
  const rest = digitCount - o;
  if (rest > 0) {
    const value = words ? words[full] : view.getUint32(full * 4, true);
    const g = [((value / 1000000) | 0) * 3, (((value / 1000) | 0) % 1000) * 3, (value % 1000) * 3];
    for (let d = 0; d < rest; d++) digits[o + d] = T[g[(d / 3) | 0] + d % 3];
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

function mapBytes(bytes, table) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = table[bytes[i]];
  return out;
}

self.onmessage = async event => {
  const { kind, query, baseUrl, digitCount, chunkDigitCount, startChunk, endChunk, minOffset, maxOffset, bw, bwThreshold, bwInvert, prefetch } = event.data;
  try {
    // Offsets are always DIGIT offsets (for letters, the digit where the match's first letter starts).
    const qlen = query.length;
    const wildcard = kind === "pattern" && query.includes(".");
    const lp = [], lb = [];                       // wildcard patterns: positions and bytes that must match
    if (wildcard) for (let i = 0; i < qlen; i++) if (query[i] !== ".") { lp.push(i); lb.push(query.charCodeAt(i)); }
    const n = lp.length, p0 = lp[0], b0 = lb[0];
    const table = new Uint8Array(256);            // black & white: digit -> "b" (98) or "w" (119)
    if (bw) for (let d = 0; d < 10; d++) table[48 + d] = ((d > bwThreshold) !== bwInvert) ? 98 : 119;
    const find = (text, from) => text.indexOf(query, from);

    // Download the next few chunks while the current one is being scanned.
    const ahead = Math.max(1, (prefetch | 0) || 1);
    const pending = new Map();
    const request = index => {
      if (index >= endChunk || pending.has(index)) return;
      const promise = (async () => {
        const response = await fetch(new URL(`data/${chunkName(index)}`, baseUrl));
        if (!response.ok) throw new Error(`Could not load packed digit chunk ${index + 1} (HTTP ${response.status}).`);
        return response.arrayBuffer();
      })();
      promise.catch(() => {});
      pending.set(index, promise);
    };

    let carry = "";                      // last qlen-1 symbols of the previous chunk (text paths)
    let carryStarts = [];                // letters only: digit offset of each carried letter
    let carryBytes = new Uint8Array(0);  // wildcard path: same idea, as bytes
    let leftover = new Uint8Array(0);    // letters only: digits not yet tokenized (needs next digit)
    for (let index = startChunk; index < endChunk; index++) {
      for (let k = 0; k <= ahead; k++) request(index + k);
      const buffer = await pending.get(index);
      pending.delete(index);
      const chunkStart = index * chunkDigitCount;
      const count = Math.min(chunkDigitCount, digitCount - chunkStart);
      const expectedBytes = Math.ceil(count / 9) * 4;
      if (buffer.byteLength !== expectedBytes) {
        throw new Error(`Packed digit chunk ${index + 1} has ${buffer.byteLength} bytes; expected ${expectedBytes}.`);
      }
      const decoded = decodePacked(buffer, count);
      const atEnd = chunkStart + count >= digitCount;

      if (wildcard) {
        // Tight loop over bytes: cheaper than calling indexOf for every candidate when literals are short.
        const symbols = bw ? mapBytes(decoded, table) : decoded;
        const text = carryBytes.length ? joinBytes(carryBytes, symbols) : symbols;
        const last = text.length - qlen;
        for (let i = 0; i <= last; i++) {
          if (text[i + p0] !== b0) continue;
          let k = 1;
          while (k < n && text[i + lp[k]] === lb[k]) k++;
          if (k === n) {
            const offset = chunkStart - carryBytes.length + i;
            if (offset >= minOffset && offset < maxOffset) { self.postMessage({ type: "done", offset }); return; }
          }
        }
        carryBytes = text.slice(Math.max(0, text.length - (qlen - 1)));
        self.postMessage({ type: "progress", chunkIndex: index });
        continue;
      }

      let segment, segmentStarts = null, base = 0;
      if (kind !== "letter") {
        segment = kind === "pattern" && bw ? toText(mapBytes(decoded, table)) : toText(decoded);
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

      const keep = Math.min(combined.length, Math.max(0, qlen - 1));
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