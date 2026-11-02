// RS256 JWT verification for Cloudflare Access, in plain JS.
//
// Why this file exists: PocketBase v0.40.6's JSVM only offers HS256 JWTs
// ($security.parseJWT takes a shared secret) and no RSA primitive. Cloudflare
// Access signs with RS256, so the signature is checked here with BigInt
// (supported by goja): RSASSA-PKCS1-v1_5 verification per RFC 8017 §8.2.2.
// The decoded signature is compared against the complete expected encoding
// EM = 00 01 FF..FF 00 || DigestInfo(SHA-256) || H, never parsed, so there is
// no ASN.1 parsing to get wrong (Bleichenbacher-style forgeries need a lenient
// parser). Keys under 2048 bits are rejected. Pure functions only; sha256Hex is
// injected ($security.sha256 in the hub, node:crypto in tests).
// Keep ES5-compatible (goja), except BigInt.

var B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
var B64URL_RE = /^[A-Za-z0-9_-]*$/
// DER prefix of DigestInfo for SHA-256 (RFC 8017 §9.2 note 1).
var SHA256_DIGESTINFO = "3031300d060960864801650304020105000420"

function b64urlDecode(s) {
  s = String(s).replace(/=+$/, "")
  if (!B64URL_RE.test(s) || s.length % 4 === 1) throw new Error("bad base64url")
  var out = []
  var buf = 0
  var bits = 0
  for (var i = 0; i < s.length; i++) {
    buf = ((buf << 6) | B64URL.indexOf(s.charAt(i))) & 0xffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buf >> bits) & 0xff)
    }
  }
  return out
}

function b64urlEncode(bytes) {
  var out = ""
  for (var i = 0; i < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0)
    out += B64URL.charAt((n >> 18) & 63) + B64URL.charAt((n >> 12) & 63)
    if (i + 1 < bytes.length) out += B64URL.charAt((n >> 6) & 63)
    if (i + 2 < bytes.length) out += B64URL.charAt(n & 63)
  }
  return out
}

function utf8Encode(s) {
  var out = []
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

function utf8Decode(bytes) {
  var s = ""
  for (var i = 0; i < bytes.length;) {
    var c = bytes[i++]
    var cp
    if (c < 0x80) cp = c
    else if (c >= 0xc0 && c < 0xe0) cp = ((c & 31) << 6) | (bytes[i++] & 63)
    else if (c >= 0xe0 && c < 0xf0) cp = ((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63)
    else if (c >= 0xf0) cp = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63)
    else throw new Error("bad utf8")
    if (cp >= 0x10000) {
      cp -= 0x10000
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023))
    } else s += String.fromCharCode(cp)
  }
  return s
}

function bytesToHex(bytes) {
  var h = ""
  for (var i = 0; i < bytes.length; i++) h += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16)
  return h
}

function hexToBig(hex) {
  return BigInt("0x" + (hex || "0"))
}

function modPow(base, exp, mod) {
  var r = BigInt(1)
  var b = base % mod
  var zero = BigInt(0)
  var one = BigInt(1)
  while (exp > zero) {
    if ((exp & one) === one) r = (r * b) % mod
    b = (b * b) % mod
    exp = exp >> one
  }
  return r
}

// True when sigBytes is a valid RS256 signature of signingInput (an ASCII
// string) under the RSA public key {n, e} (base64url, as in a JWK).
function verifyRS256(signingInput, sigBytes, jwk, sha256Hex) {
  var nBytes = b64urlDecode(jwk.n)
  while (nBytes.length && nBytes[0] === 0) nBytes.shift()
  var k = nBytes.length
  if (k < 256) return false // < 2048-bit keys are not accepted
  if (sigBytes.length !== k) return false
  var n = hexToBig(bytesToHex(nBytes))
  var e = hexToBig(bytesToHex(b64urlDecode(jwk.e)))
  if (e < BigInt(3)) return false
  var s = hexToBig(bytesToHex(sigBytes))
  if (s >= n) return false
  var m = modPow(s, e, n).toString(16)
  while (m.length < k * 2) m = "0" + m
  var h = String(sha256Hex(signingInput)).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(h)) return false
  var t = SHA256_DIGESTINFO + h
  var psLen = k - 3 - t.length / 2
  if (psLen < 8) return false
  var em = "0001"
  for (var i = 0; i < psLen; i++) em += "ff"
  em += "00" + t
  // constant-time-ish compare (the inputs are public anyway)
  var diff = m.length ^ em.length
  for (var j = 0; j < em.length; j++) diff |= m.charCodeAt(j) ^ em.charCodeAt(j)
  return diff === 0
}

// Verify a JWT: RS256 signature against a key from keys (JWKS "keys" array,
// matched by kid), then iss, aud, exp, nbf/iat. Returns the claims or throws
// Error with a short reason. nowMs is the current time.
function verifyJWT(token, opts, sha256Hex) {
  var parts = String(token || "").split(".")
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("malformed token")
  for (var i = 0; i < 3; i++) if (!B64URL_RE.test(parts[i])) throw new Error("malformed token")
  var header, claims
  try {
    header = JSON.parse(utf8Decode(b64urlDecode(parts[0])))
    claims = JSON.parse(utf8Decode(b64urlDecode(parts[1])))
  } catch (err) {
    throw new Error("malformed token")
  }
  if (!header || header.alg !== "RS256") throw new Error("unsupported alg")
  if (!claims || typeof claims !== "object") throw new Error("malformed token")
  var keys = opts.keys || []
  var key = null
  for (var j = 0; j < keys.length; j++) {
    var kj = keys[j]
    if (kj && kj.kty === "RSA" && kj.n && kj.e && (!header.kid || kj.kid === header.kid) && (!kj.alg || kj.alg === "RS256") && (!kj.use || kj.use === "sig")) {
      key = kj
      break
    }
  }
  if (!key) throw new Error("unknown key")
  if (!verifyRS256(parts[0] + "." + parts[1], b64urlDecode(parts[2]), key, sha256Hex)) throw new Error("bad signature")
  var now = Math.floor(opts.nowMs / 1000)
  var skew = opts.skewSec === undefined ? 60 : opts.skewSec
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("expired")
  if (typeof claims.nbf === "number" && claims.nbf > now + skew) throw new Error("not yet valid")
  if (typeof claims.iat === "number" && claims.iat > now + skew) throw new Error("issued in the future")
  if (opts.iss && claims.iss !== opts.iss) throw new Error("wrong issuer")
  var aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!opts.aud || aud.indexOf(opts.aud) < 0) throw new Error("wrong audience")
  return claims
}

module.exports = {
  b64urlDecode: b64urlDecode,
  b64urlEncode: b64urlEncode,
  utf8Encode: utf8Encode,
  utf8Decode: utf8Decode,
  verifyRS256: verifyRS256,
  verifyJWT: verifyJWT,
}
