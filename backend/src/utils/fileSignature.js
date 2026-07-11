'use strict';

// Real, content-based file-type detection via magic bytes. multer's
// fileFilter only ever sees the client-declared Content-Type header —
// trivially spoofable, and proven live in the access-security audit (a
// plain-text file declared as image/png was accepted and stored). This
// checks the actual leading bytes of the uploaded buffer instead.
// fileFilter itself cannot do this: multer calls it before the file body
// is read, so file.buffer doesn't exist yet — this must run after upload
// completes (buffer fully populated), before the file is forwarded anywhere.
const SIGNATURES = [
  { mimetype: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mimetype: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mimetype: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

function detectRealMimeType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  for (const { mimetype, bytes } of SIGNATURES) {
    if (bytes.every((b, i) => buffer[i] === b)) return mimetype;
  }
  return null;
}

module.exports = { detectRealMimeType };
