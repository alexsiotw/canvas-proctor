'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

function normalizeSessionId(sessionId) {
    const value = Number.parseInt(sessionId, 10);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid exam session id: ${sessionId}`);
    }
    return value;
}

function getChunkStorageRoot(env = process.env) {
    const configured = String(env.CHUNK_STORAGE_DIR || '').trim();
    return path.resolve(configured || path.join(__dirname, '..', 'data', 'recording-chunks'));
}

function getSessionChunkDir(sessionId, kind = 'primary', env = process.env) {
    const id = normalizeSessionId(sessionId);
    const normalizedKind = String(kind || 'primary').toLowerCase();
    if (!['primary', 'camera', 'mobile'].includes(normalizedKind)) {
        throw new Error(`Invalid recording kind: ${kind}`);
    }
    const prefix = normalizedKind === 'primary' ? 'chunks-' : `chunks-${normalizedKind}-`;
    return path.join(getChunkStorageRoot(env), `${prefix}${id}`);
}

function ensureSessionChunkDir(sessionId, kind = 'primary', env = process.env) {
    const directory = getSessionChunkDir(sessionId, kind, env);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function parseStoredChunkIndex(fileName) {
    const match = String(fileName || '').match(/^chunk-(\d+)\.dat$/);
    if (!match) return null;
    const index = Number.parseInt(match[1], 10);
    return Number.isInteger(index) && index >= 0 ? index : null;
}

function listStoredChunkIndices(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
        .map(parseStoredChunkIndex)
        .filter(index => index !== null)
        .sort((a, b) => a - b);
}

function buildChunkReceipt(directory, totalChunks) {
    const expectedHighest = Math.max(0, Number.parseInt(totalChunks, 10) || 0);
    const indices = listStoredChunkIndices(directory);
    const received = new Set(indices);
    const missing = [];
    for (let index = 1; index <= expectedHighest; index++) {
        if (!received.has(index)) missing.push(index);
    }
    return {
        expected_highest: expectedHighest,
        highest_received: indices.length ? indices[indices.length - 1] : 0,
        received_count: indices.length,
        missing_indexes: missing,
        complete: expectedHighest === 0 || missing.length === 0
    };
}

function purgeExpiredChunkDirectories({
    env = process.env,
    now = Date.now(),
    retentionMs = Number.parseInt(env.CHUNK_RETENTION_MS, 10) || DEFAULT_RETENTION_MS
} = {}) {
    const root = getChunkStorageRoot(env);
    if (!fs.existsSync(root)) return [];
    const removed = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^chunks-(?:(?:camera|mobile)-)?\d+$/.test(entry.name)) continue;
        const target = path.resolve(root, entry.name);
        if (path.dirname(target) !== root) continue;
        const ageMs = now - fs.statSync(target).mtimeMs;
        if (ageMs < retentionMs) continue;
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(target);
    }
    return removed;
}

module.exports = {
    DEFAULT_RETENTION_MS,
    buildChunkReceipt,
    ensureSessionChunkDir,
    getChunkStorageRoot,
    getSessionChunkDir,
    listStoredChunkIndices,
    normalizeSessionId,
    parseStoredChunkIndex,
    purgeExpiredChunkDirectories
};
