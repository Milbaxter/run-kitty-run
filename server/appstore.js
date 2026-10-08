// Apple App Store data for the iOS app's in-app purchases (accounts.js credits them). No SDK: everything StoreKit 2
// signs (a transaction, the app transaction, an App Store Server Notification V2) is a JWS whose x5c chain must lead
// to Apple Root CA - G3, pinned below. Checked with node:crypto the way Apple's app-store-server-library does it
// offline: each certificate signed by the next, Apple's marker OIDs on the intermediate and the leaf, all valid at the
// signing date, then the ES256 signature. Then this app's own checks: bundle id, App Store app id, environment.
//
// Environments: Production always; Sandbox (TestFlight, sandbox testers and App Review, who buy against the
// production server) unless turned off; Xcode (StoreKit Testing in Xcode: signed by Xcode itself, NOT by Apple) and
// extra test roots only outside production, for local and CI tests.
import crypto from 'node:crypto';

const BUNDLE_ID = 'io.runkittyrun.app';
const APP_APPLE_ID = 6820576828;

// https://www.apple.com/certificateauthority/AppleRootCA-G3.cer (checked against its published SHA-256 at load)
const APPLE_ROOT_G3 = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;
const APPLE_ROOT_G3_SHA256 = '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';
// Apple's marker extensions (DER-encoded OIDs): 1.2.840.113635.100.6.11.1 on the leaf (signs App Store data),
// 1.2.840.113635.100.6.2.1 on the intermediate (Apple Worldwide Developer Relations)
const OID_LEAF = Buffer.from('060a2a864886f76364060b01', 'hex');
const OID_INTERMEDIATE = Buffer.from('060a2a864886f76364060201', 'hex');
const MAX_JWS = 64 << 10;

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

class AppStoreError extends Error {}
const fail = (msg) => { throw new AppStoreError(msg); };

// roots: extra trusted roots (PEM strings) for tests; env: { sandbox, xcode } switches
function createAppStore({ testRoots = [], sandbox = true, xcode = false } = {}) {
  const g3 = new crypto.X509Certificate(APPLE_ROOT_G3);
  if (g3.fingerprint256 !== APPLE_ROOT_G3_SHA256) throw new Error('Apple Root CA - G3 does not match its fingerprint');
  const roots = [g3, ...testRoots.map((p) => new crypto.X509Certificate(p))];
  const envs = new Set(['Production', ...(sandbox ? ['Sandbox'] : []), ...(xcode ? ['Xcode', 'LocalTesting'] : [])]);

  // a JWS -> { header, payload }, its signature checked (by the chain to a trusted root, or for Xcode only by the
  // certificate it carries); `envOf(payload)` says which environment the data claims to come from
  function verify(jws, envOf) {
    if (typeof jws !== 'string' || jws.length > MAX_JWS) fail('bad jws');
    const parts = jws.split('.');
    if (parts.length !== 3) fail('bad jws');
    let header, payload;
    try { header = b64json(parts[0]); payload = b64json(parts[1]); } catch { fail('bad jws'); }
    if (!header || !payload || typeof payload !== 'object' || header.alg !== 'ES256') fail('bad jws');
    const env = envOf(payload);
    if (!envs.has(env)) fail('environment not accepted: ' + env);
    const x5c = Array.isArray(header.x5c) ? header.x5c : [];
    let certs;
    try { certs = x5c.map((c) => new crypto.X509Certificate(Buffer.from(String(c), 'base64'))); } catch { fail('bad certificate'); }
    let leaf;
    if (env === 'Xcode' || env === 'LocalTesting') {
      // StoreKit Testing in Xcode signs with a local certificate: check the signature only (test setups only)
      if (!certs.length) fail('no certificate');
      leaf = certs[0];
    } else {
      if (certs.length !== 3) fail('bad chain');
      const [l, mid] = certs;
      const anchor = roots.find((r) => mid.checkIssued(r) && mid.verify(r.publicKey));
      if (!anchor) fail('untrusted chain');
      if (!mid.ca || !l.checkIssued(mid) || !l.verify(mid.publicKey)) fail('bad chain');
      if (!l.raw.includes(OID_LEAF) || !mid.raw.includes(OID_INTERMEDIATE)) fail('not an App Store certificate');
      // valid when it was signed (what Apple's library checks without online checks)
      const at = Number(payload.signedDate || payload.receiptCreationDate) || Date.now();
      for (const c of [l, mid, anchor]) if (!(Date.parse(c.validFrom) <= at && at <= Date.parse(c.validTo))) fail('certificate not valid');
      leaf = l;
    }
    const ok = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]),
      { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'));
    if (!ok) fail('bad signature');
    return payload;
  }

  // a signed transaction (Transaction.jwsRepresentation, or a notification's signedTransactionInfo)
  function transaction(jws) {
    const t = verify(jws, (p) => p.environment);
    if (t.bundleId !== BUNDLE_ID) fail('other app');
    if (typeof t.transactionId !== 'string' || !/^\d{1,30}$/.test(t.transactionId)) fail('no transaction id');
    return t;
  }
  // the app transaction (AppTransaction.shared): proves which App Store account installed the app
  function appTransaction(jws) {
    const a = verify(jws, (p) => p.receiptType);
    if (a.bundleId !== BUNDLE_ID) fail('other app');
    if (a.receiptType === 'Production' && Number(a.appAppleId) !== APP_APPLE_ID) fail('other app');
    return a;
  }
  // App Store Server Notifications V2: the POSTed { signedPayload } -> { type, subtype, uuid, env, transaction }
  function notification(signedPayload) {
    const n = verify(signedPayload, (p) => (p.data && p.data.environment) || (p.summary && p.summary.environment));
    const d = n.data || n.summary || {};
    if (d.bundleId !== BUNDLE_ID) fail('other app');
    if (d.environment === 'Production' && Number(d.appAppleId) !== APP_APPLE_ID) fail('other app');
    if (typeof n.notificationUUID !== 'string' || !n.notificationUUID) fail('no notification id');
    const t = d.signedTransactionInfo ? transaction(d.signedTransactionInfo) : null;
    if (t && t.environment !== d.environment) fail('environment mismatch');
    return { type: n.notificationType, subtype: n.subtype || '', uuid: n.notificationUUID, env: d.environment, transaction: t };
  }

  return { transaction, appTransaction, notification, environments: [...envs] };
}

export { createAppStore, AppStoreError, BUNDLE_ID, APP_APPLE_ID };
