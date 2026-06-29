'use strict';

const crypto = require('crypto');

/**
 * HMAC-SHA256 body signing — the scheme used by the WhatsApp webhook
 * (`sha256=<hexdigest>` over the raw request body), reused for the internal
 * voice endpoint. The Python voice-agent worker signs the same way.
 */

/**
 * @param {Buffer|string} body  Raw request body bytes.
 * @param {string} secret       Shared secret.
 * @returns {string}            `sha256=<hex>`
 */
function sign(body, secret) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return 'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');
}

/**
 * Constant-time verification (length-checked first to avoid timingSafeEqual throwing).
 * @param {Buffer|string} rawBody  Raw request body bytes.
 * @param {string} header          Signature header value (`sha256=<hex>`).
 * @param {string} secret          Shared secret.
 * @returns {boolean}
 */
function verify(rawBody, header, secret) {
  if (!header || !secret) return false;
  const expected = sign(rawBody, secret);
  const headerBuf = Buffer.from(header);
  const expectedBuf = Buffer.from(expected);
  return headerBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(headerBuf, expectedBuf);
}

module.exports = { sign, verify };
