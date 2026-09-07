/**
 * Minimal ZIP writer — "store" mode (no compression). PNGs are already
 * compressed, so storing them costs nothing and saves pulling in a zip library
 * for what a header format and a CRC32 need. Produces a standard .zip any OS
 * unzips.
 */

// Standard CRC32 (polynomial 0xEDB88320), table built once.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function zipBlobs(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);   // local file header signature
    lh.setUint16(4, 20, true);           // version needed
    lh.setUint16(8, 0, true);            // method 0 = store
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); // compressed size
    lh.setUint32(22, data.length, true); // uncompressed size
    lh.setUint16(26, name.length, true);
    const lhArr = new Uint8Array(lh.buffer);
    parts.push(lhArr, name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);   // central dir header signature
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(10, 0, true);           // method
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);      // offset of local header
    central.push(new Uint8Array(ch.buffer), name);

    offset += lhArr.length + name.length + data.length;
  }

  const centralSize = central.reduce((n, a) => n + a.length, 0);
  for (const a of central) parts.push(a);

  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true);     // end of central directory signature
  eo.setUint16(8, files.length, true);
  eo.setUint16(10, files.length, true);
  eo.setUint32(12, centralSize, true);
  eo.setUint32(16, offset, true);        // central dir offset
  parts.push(new Uint8Array(eo.buffer));

  return new Blob(parts as BlobPart[], { type: "application/zip" });
}
