/**
 * appleAuthService.js
 * Verifies Apple Sign In identity tokens using Apple's JWKS endpoint.
 * No paid subscription needed. Apple's public keys are freely accessible.
 */
const https  = require("https");
const crypto = require("crypto");

let _cachedKeys = null;
let _cacheExp   = 0;

function fetchAppleJWKS() {
  return new Promise((resolve, reject) => {
    const req = https.get("https://appleid.apple.com/auth/keys", (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Failed to parse Apple JWKS")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Apple JWKS timeout")); });
  });
}

async function getAppleKeys() {
  if (_cachedKeys && Date.now() < _cacheExp) return _cachedKeys;
  const data  = await fetchAppleJWKS();
  _cachedKeys = data.keys;
  _cacheExp   = Date.now() + 3600_000;
  return _cachedKeys;
}

function b64url(str) {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function jwkToPem(jwk) {
  const n = b64url(jwk.n), e = b64url(jwk.e);
  const encLen = (l) => l < 128 ? Buffer.from([l]) : l < 256 ? Buffer.from([0x81, l]) : Buffer.from([0x82, l >> 8, l & 0xff]);
  const encInt = (buf) => { const p = (buf[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), buf]) : buf; return Buffer.concat([Buffer.from([0x02]), encLen(p.length), p]); };
  const seq = Buffer.concat([Buffer.from([0x30]), (() => { const c = Buffer.concat([encInt(n), encInt(e)]); return Buffer.concat([encLen(c.length), c]); })()]);
  const oid = Buffer.from([0x30,0x0d,0x06,0x09,0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x01,0x01,0x05,0x00]);
  const bit = Buffer.concat([Buffer.from([0x03]), encLen(seq.length + 1), Buffer.from([0x00]), seq]);
  const spki = Buffer.concat([Buffer.from([0x30]), encLen(oid.length + bit.length), oid, bit]);
  return ["-----BEGIN PUBLIC KEY-----", spki.toString("base64").match(/.{1,64}/g).join("\n"), "-----END PUBLIC KEY-----"].join("\n");
}

function verifyJwt(token, pem) {
  const [hb64, pb64, sb64] = token.split(".");
  const sig    = b64url(sb64);
  const verify = crypto.createVerify("RSA-SHA256");
  verify.update(`${hb64}.${pb64}`);
  if (!verify.verify(pem, sig)) throw new Error("Apple token signature invalid");
  return JSON.parse(b64url(pb64).toString("utf8"));
}

async function verifyAppleToken(identityToken, clientId) {
  if (!identityToken) throw new Error("Apple identity token required");
  const parts = identityToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid Apple token format");

  let header;
  try { header = JSON.parse(b64url(parts[0]).toString("utf8")); }
  catch (_) { throw new Error("Failed to decode Apple token header"); }

  let keys = await getAppleKeys();
  let key  = keys.find((k) => k.kid === header.kid);
  if (!key) {
    _cachedKeys = null;
    keys = await getAppleKeys();
    key  = keys.find((k) => k.kid === header.kid);
  }
  if (!key) throw new Error("Apple public key not found");

  const payload = verifyJwt(identityToken, jwkToPem(key));

  if (payload.iss !== "https://appleid.apple.com") throw new Error("Apple token issuer mismatch");

  // Only the caller's own clientId (plus the shared web Services ID, used
  // for browser-based Sign in with Apple flows common to both apps) is
  // accepted here - the driver app's client ID must NOT be unconditionally
  // trusted on every call, or a token minted for one app is accepted by
  // the other app's sign-in endpoint regardless of which one is calling.
  const accepted = [clientId, process.env.APPLE_SERVICE_ID].filter(Boolean);
  if (!accepted.includes(payload.aud)) throw new Error(`Apple token audience mismatch: ${payload.aud}`);
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Apple token expired");

  return {
    sub:           payload.sub,
    email:         payload.email || null,
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    realUserStatus: payload.real_user_status,
  };
}

module.exports = { verifyAppleToken };
