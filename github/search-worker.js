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

function makeLetters(digits) {
  const letters = new Uint8Array(Math.floor(digits.length / 2));
  for (let digit = 0, letter = 0; digit + 1 < digits.length; digit += 2, letter++) {
    const pair = (digits[digit] - 48) * 10 + digits[digit + 1] - 48;
    letters[letter] = 65 + pair % 26;
  }
  return toText(letters);
}

function chunkName(index) {
  return `pi-chunk-${String(index).padStart(4, "0")}.bin`;
}

self.onmessage = async event => {
  const { kind, query, baseUrl, digitCount, chunkDigitCount, startChunk, endChunk, minOffset, maxOffset } = event.data;
  try {
    let carry = "";
    const unitsPerChunk = kind === "digit" ? chunkDigitCount : chunkDigitCount / 2;
    for (let index = startChunk; index < endChunk; index++) {
      const count = Math.min(chunkDigitCount, digitCount - index * chunkDigitCount);
      const url = new URL(`data/${chunkName(index)}`, baseUrl);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load packed digit chunk ${index + 1} (HTTP ${response.status}).`);
      const buffer = await response.arrayBuffer();
      const expectedBytes = Math.ceil(count / 9) * 4;
      if (buffer.byteLength !== expectedBytes) {
        throw new Error(`Packed digit chunk ${index + 1} has ${buffer.byteLength} bytes; expected ${expectedBytes}.`);
      }

      const digits = decodePacked(buffer, count);
      const segment = kind === "digit" ? toText(digits) : makeLetters(digits);
      const combined = carry + segment;
      let matchIndex = combined.indexOf(query);
      while (matchIndex >= 0) {
        const offset = index * unitsPerChunk - carry.length + matchIndex;
        if (offset >= minOffset && offset < maxOffset) {
          self.postMessage({ type: "done", offset });
          return;
        }
        matchIndex = combined.indexOf(query, matchIndex + 1);
      }
      carry = combined.slice(Math.max(0, combined.length - query.length + 1));
      self.postMessage({ type: "progress", chunkIndex: index });
    }
    self.postMessage({ type: "done", offset: -1 });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
