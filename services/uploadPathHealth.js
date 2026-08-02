'use strict';

// Proves at boot that a realistic recording chunk can actually reach this app.
//
// Written after an nginx installation left at its default client_max_body_size of
// 1m silently rejected every camera-only recording chunk with a 413. Because the
// refusal happened in the proxy, nothing was ever logged server-side, and the
// failure was only discovered when a student's attempt produced no video at all —
// after it had presumably been happening to every tablet and phone since launch.
//
// The check exists so that class of misconfiguration announces itself on startup
// instead of waiting to be noticed in a report weeks later.

const crypto = require('crypto');

// Comfortably above nginx's 1m default and above any chunk the recorders now
// produce, but far below the app's own 50mb body limit. If this gets through, a
// real chunk will.
const PROBE_PAYLOAD_BYTES = 2 * 1024 * 1024;

// Regenerated every boot and never persisted, so only this process can drive the
// probe endpoint. Without it the endpoint would be an open multi-megabyte sink.
const PROBE_NONCE = crypto.randomBytes(24).toString('hex');

let health = {
    ok: null, // true = verified working, false = verified broken, null = undetermined
    checked: false,
    reason: 'The upload path has not been checked yet.',
    payloadBytes: PROBE_PAYLOAD_BYTES,
    checkedAt: null
};

function getProbeNonce() {
    return PROBE_NONCE;
}

function getHealth() {
    return Object.assign({}, health);
}

function isProbeNonce(candidate) {
    if (typeof candidate !== 'string' || candidate.length !== PROBE_NONCE.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(PROBE_NONCE));
    } catch (e) {
        return false;
    }
}

function setHealth(ok, reason) {
    health = {
        ok,
        checked: true,
        reason,
        payloadBytes: PROBE_PAYLOAD_BYTES,
        checkedAt: new Date().toISOString()
    };
    return getHealth();
}

// Resolves to the health object. Never throws — a failure to run the check must
// not stop the server from starting.
async function probeUploadPath(baseUrl) {
    const mb = (PROBE_PAYLOAD_BYTES / (1024 * 1024)).toFixed(0);

    if (!baseUrl) {
        return setHealth(null,
            'BASE_URL is not set, so the upload path could not be tested through the reverse proxy. ' +
            'Set BASE_URL to the public https:// origin to enable this check.');
    }

    let origin;
    try {
        origin = new URL(baseUrl);
    } catch (e) {
        return setHealth(null, `BASE_URL is not a valid URL (${baseUrl}), so the upload path could not be tested.`);
    }

    // A probe aimed at the Node port proves nothing: the entire point is to make the
    // request traverse whatever sits in front of it. Refuse rather than report a pass
    // that would be actively misleading.
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'];
    if (local.indexOf(origin.hostname) !== -1) {
        return setHealth(null,
            `BASE_URL points at ${origin.hostname}, which bypasses the reverse proxy — a pass here would not ` +
            'mean student uploads work. Set BASE_URL to the public origin to enable this check.');
    }

    const url = `${origin.origin}/api/health/upload-probe`;
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nonce: PROBE_NONCE, filler: 'a'.repeat(PROBE_PAYLOAD_BYTES) }),
            signal: AbortSignal.timeout(20000)
        });
    } catch (err) {
        return setHealth(null,
            `Could not reach ${url} to test the upload path (${err && err.message}). ` +
            'This is inconclusive, not a failure — check DNS, TLS and firewall if it persists.');
    }

    if (res.status === 413) {
        return setHealth(false,
            `A ${mb}MB upload was rejected with HTTP 413 by something in front of this app — almost always the ` +
            "reverse proxy's client_max_body_size. Student recordings WILL be lost. Fix: " +
            "`echo 'client_max_body_size 64M;' | sudo tee /etc/nginx/conf.d/upload-size.conf` " +
            'then `sudo nginx -t && sudo systemctl reload nginx`.');
    }

    if (res.ok) {
        return setHealth(true, `Verified: a ${mb}MB upload reaches the app through the proxy.`);
    }

    return setHealth(false,
        `The ${mb}MB upload probe returned HTTP ${res.status} instead of 200. Recording uploads may be affected; ` +
        'check the reverse proxy and any WAF or CDN in front of this app.');
}

module.exports = {
    PROBE_PAYLOAD_BYTES,
    getProbeNonce,
    isProbeNonce,
    getHealth,
    probeUploadPath
};
