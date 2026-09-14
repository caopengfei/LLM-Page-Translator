// CRC-32 (IEEE 802.3) — the checksum PNG chunks and ZIP entries both carry.
//
// Hand-rolled rather than `zlib.crc32`, which only exists from Node 22.2 on, so the
// tooling stays runnable on every Node version vitest supports. Both the icon
// generator and the packager import this, so the two binary writers cannot drift.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
