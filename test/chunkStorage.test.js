'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    buildChunkReceipt,
    ensureSessionChunkDir,
    getSessionChunkDir,
    purgeExpiredChunkDirectories
} = require('../services/chunkStorage');

test('reports every missing chunk before finalization', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-receipt-'));
    const env = { CHUNK_STORAGE_DIR: root };
    const directory = ensureSessionChunkDir(118, 'primary', env);
    fs.writeFileSync(path.join(directory, 'chunk-00001.dat'), 'a');
    fs.writeFileSync(path.join(directory, 'chunk-00003.dat'), 'c');

    assert.deepEqual(buildChunkReceipt(directory, 4), {
        expected_highest: 4,
        highest_received: 3,
        received_count: 2,
        missing_indexes: [2, 4],
        complete: false
    });
    fs.rmSync(root, { recursive: true, force: true });
});

test('persistent chunk paths survive process temp cleanup and expire by policy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-retention-'));
    const env = { CHUNK_STORAGE_DIR: root };
    const directory = ensureSessionChunkDir(7, 'mobile', env);
    assert.equal(directory, getSessionChunkDir(7, 'mobile', env));
    fs.utimesSync(directory, new Date(0), new Date(0));

    const removed = purgeExpiredChunkDirectories({ env, now: 48 * 60 * 60 * 1000, retentionMs: 24 * 60 * 60 * 1000 });
    assert.deepEqual(removed, [directory]);
    assert.equal(fs.existsSync(directory), false);
    fs.rmSync(root, { recursive: true, force: true });
});

test('camera recordings use an isolated persistent chunk directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-camera-chunks-'));
    const env = { CHUNK_STORAGE_DIR: root };
    const primary = ensureSessionChunkDir(21, 'primary', env);
    const camera = ensureSessionChunkDir(21, 'camera', env);
    assert.notEqual(camera, primary);
    assert.equal(camera, path.join(root, 'chunks-camera-21'));
    assert.throws(() => getSessionChunkDir(21, 'unknown', env), /Invalid recording kind/);
    fs.rmSync(root, { recursive: true, force: true });
});
