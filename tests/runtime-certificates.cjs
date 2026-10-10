'use strict';
const { X509Certificate } = require('node:crypto');
// Test-only certificate pinning. PEM line endings differ between OpenSSL builds;
// compare the exact DER certificate rather than its textual representation.
function sameCertificate(received, expected) {
  try { return new X509Certificate(received).raw.equals(new X509Certificate(expected).raw); }
  catch { return false; }
}
module.exports = { sameCertificate };
