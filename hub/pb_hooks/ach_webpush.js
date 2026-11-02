/// <reference path="../pb_data/types.d.ts" />
// Web Push without payload (no message encryption needed): the hub signs a
// VAPID JWT (ES256 over P-256) and POSTs an empty push to the subscription's
// endpoint; the panel's service worker then reads the newest item with its own
// read key (GET /api/ach/push/latest). VAPID keys are generated on first use
// and stored server-side (hub_settings "ach_vapid"). Pure JS (BigInt) because
// the hub's JS runtime has no EC primitives. Keep the code small and standard:
// affine P-256 arithmetic, random k from the hub's CSPRNG, SHA-256 from $security.

var P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff")
var A = P - BigInt(3)
var N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")
var G = { x: BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"), y: BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5") }
var ZERO = BigInt(0)
var ONE = BigInt(1)
var TWO = BigInt(2)
var THREE = BigInt(3)
var KEY = "ach_vapid"

function mod(a, m) { var r = a % m; return r < ZERO ? r + m : r }
function inv(a, m) {
  var t = ZERO, nt = ONE, r = m, nr = mod(a, m)
  while (nr !== ZERO) {
    var q = r / nr
    var x = t - q * nt; t = nt; nt = x
    var y = r - q * nr; r = nr; nr = y
  }
  return mod(t, m)
}
function add(p1, p2) {
  if (!p1) return p2
  if (!p2) return p1
  var l
  if (p1.x === p2.x) {
    if (mod(p1.y + p2.y, P) === ZERO) return null
    l = mod((THREE * p1.x * p1.x + A) * inv(TWO * p1.y, P), P)
  } else {
    l = mod((p2.y - p1.y) * inv(p2.x - p1.x, P), P)
  }
  var x = mod(l * l - p1.x - p2.x, P)
  return { x: x, y: mod(l * (p1.x - x) - p1.y, P) }
}
function mul(k, pt) {
  var r = null
  var bits = k.toString(2)
  for (var i = 0; i < bits.length; i++) {
    r = add(r, r)
    if (bits[i] === "1") r = add(r, pt)
  }
  return r
}
function hex64(b) { var h = b.toString(16); while (h.length < 64) h = "0" + h; return h }
function randScalar() {
  for (;;) {
    var k = BigInt("0x" + $security.randomStringWithAlphabet(64, "0123456789abcdef"))
    if (k > ZERO && k < N) return k
  }
}

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
function bytesB64url(bytes) {
  var out = ""
  for (var i = 0; i < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]
    if (i + 2 < bytes.length) out += B64[n & 63]
  }
  return out
}
function hexBytes(h) { var o = []; for (var i = 0; i < h.length; i += 2) o.push(parseInt(h.substr(i, 2), 16)); return o }
function strB64url(s) {
  // ASCII/UTF-8 text
  var bytes = []
  var e = encodeURIComponent(s)
  for (var i = 0; i < e.length; i++) {
    if (e[i] === "%") { bytes.push(parseInt(e.substr(i + 1, 2), 16)); i += 2 } else bytes.push(e.charCodeAt(i))
  }
  return bytesB64url(bytes)
}

/** The hub's VAPID key pair (created on first use). */
function keys(app) {
  var D = require(__hooks + "/ach_lib.js").wikiDeps()
  var k = D.readSetting(app, KEY)
  if (k && k.d && k.x && k.y) return k
  var d = randScalar()
  var q = mul(d, G)
  k = { d: hex64(d), x: hex64(q.x), y: hex64(q.y) }
  D.writeSetting(app, KEY, k)
  return k
}
function publicKey(app) { var k = keys(app); return bytesB64url(hexBytes("04" + k.x + k.y)) }

/** ES256 signature (r||s, base64url) of an ASCII signing input. */
function sign(dHex, input) {
  var z = BigInt("0x" + $security.sha256(input))
  var d = BigInt("0x" + dHex)
  for (;;) {
    var k = randScalar()
    var r = mod(mul(k, G).x, N)
    if (r === ZERO) continue
    var s = mod(inv(k, N) * (z + r * d), N)
    if (s === ZERO) continue
    return bytesB64url(hexBytes(hex64(r) + hex64(s)))
  }
}

/** The Authorization header for a push to `endpoint`. */
function vapidAuth(app, endpoint, nowS) {
  var k = keys(app)
  var m = /^(https?:\/\/[^\/]+)/.exec(endpoint)
  var sub = str($os.getenv("ACH_VAPID_SUBJECT")) || str($os.getenv("ACH_PUBLIC_URL")).replace(/\/+$/, "") || "mailto:admin@localhost"
  var input = strB64url(JSON.stringify({ typ: "JWT", alg: "ES256" })) + "." + strB64url(JSON.stringify({ aud: m ? m[1] : endpoint, exp: nowS + 12 * 3600, sub: sub }))
  return "vapid t=" + input + "." + sign(k.d, input) + ", k=" + bytesB64url(hexBytes("04" + k.x + k.y))
}
function str(v) { return v === undefined || v === null ? "" : String(v) }

module.exports = { keys: keys, publicKey: publicKey, vapidAuth: vapidAuth, sign: sign, bytesB64url: bytesB64url, hexBytes: hexBytes }
