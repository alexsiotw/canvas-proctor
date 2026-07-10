const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

// Output goes to the repo-root extension/ folder (NOT public/) — this bundle contains
// review-center.js, which holds the ProctorGuard shared secret. It must never be placed
// anywhere express.static() serves, or it becomes fetchable by anyone with the URL,
// extension or no extension. Use this zip only for manual Chrome Web Store uploads.
const output = fs.createWriteStream(path.join(__dirname, 'extension', 'canvas-proctor-extension.zip'));
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
    console.log(`Extension zipped successfully. Size: ${archive.pointer()} total bytes`);
});

archive.on('error', (err) => {
    throw err;
});

archive.pipe(output);

// Append files from the extension/ directory (outside the public webroot)
const extDir = path.join(__dirname, 'extension');
archive.file(path.join(extDir, 'background.js'), { name: 'background.js' });
archive.file(path.join(extDir, 'content.js'), { name: 'content.js' });
archive.file(path.join(extDir, 'review-center.js'), { name: 'review-center.js' });
archive.file(path.join(extDir, 'icon.png'), { name: 'icon.png' });
archive.file(path.join(extDir, 'icon16.png'), { name: 'icon16.png' });
archive.file(path.join(extDir, 'icon48.png'), { name: 'icon48.png' });
archive.file(path.join(extDir, 'icon128.png'), { name: 'icon128.png' });
archive.file(path.join(extDir, 'manifest.json'), { name: 'manifest.json' });

archive.finalize();
