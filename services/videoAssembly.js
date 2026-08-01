// ================================================================
// Reassembling a MediaRecorder recording
//
// The browser records with `mediaRecorder.start(5000)`, so what lands on disk is
// a sequence of 5-second timeslice blobs. Those blobs are NOT independent files:
// only the first blob of a recorder run carries the WebM/EBML header, and cluster
// boundaries do not line up with blob boundaries. A run is playable only when
// every blob of that run is present, in order, with nothing missing.
//
// That invariant gets broken two ways in the field, and both used to fail
// silently — which is why an attempt of twelve minutes could produce a
// thirty-five second video and nothing anywhere said so:
//
//   1. A gap. One chunk lost (a permanently failed upload, a chunk still queued
//      when the session ended) corrupts the byte stream from that point on. The
//      remaining minutes are sitting on disk, but nothing can decode them.
//
//   2. A restart. If the student reloads and resumes, a second MediaRecorder
//      starts and emits a *fresh* EBML header mid-file. A player — and ffmpeg —
//      reads the first segment, reaches the second header, and stops. The video
//      is then exactly as long as the recording was before the reload.
//
// In both cases ffmpeg exits 0. It decodes up to the bad byte, writes a short
// file, and reports success, so the old code logged "Successfully transcoded"
// over a video missing most of the attempt.
//
// The fix is to stop treating the chunks as one stream. Split them into runs at
// gaps and at embedded headers, decode each run on its own, then join the results
// with the concat demuxer. A gap now costs the seconds around it instead of every
// minute after it.
// ================================================================

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

function parseChunkIndex(filename) {
    const match = filename.match(/^chunk-(\d+)\.dat$/);
    return match ? parseInt(match[1], 10) : null;
}

// Detect a container header at the head of a chunk. A chunk that begins one is
// the first chunk of a new recorder run, no matter what index it carries. This is
// read from the bytes rather than announced by the client on purpose: it works
// for recordings already sitting on disk and for students running a cached copy
// of student.js.
function startsNewMediaSegment(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const head = Buffer.alloc(12);
        const bytesRead = fs.readSync(fd, head, 0, 12, 0);
        if (bytesRead < 8) return false;
        if (head.slice(0, 4).equals(EBML_MAGIC)) return true;
        // ISO-BMFF (MP4): 4-byte box size followed by 'ftyp'.
        if (head.slice(4, 8).toString('latin1') === 'ftyp') return true;
        return false;
    } catch (err) {
        return false;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (e) {}
        }
    }
}

// Matroska Cluster element ID. Everything before the first Cluster in a WebM
// stream is initialisation data (EBML header, Segment, Info, Tracks).
const CLUSTER_ID = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

// Pull the initialisation bytes out of the chunk that started a recorder run.
//
// A run that begins after a gap has no header of its own, so on its own it is
// undecodable — but it is not lost. Prefixing it with the original run's
// initialisation segment gives the decoder the track layout it needs, and the
// clusters that follow then decode normally. This is what keeps a single missing
// chunk from costing every minute after it.
function extractInitSegment(headerChunkPath) {
    const data = fs.readFileSync(headerChunkPath);
    if (data.length < 4 || !data.slice(0, 4).equals(EBML_MAGIC)) return null;
    const clusterOffset = data.indexOf(CLUSTER_ID);
    // No Cluster in this chunk means it is all initialisation data.
    return clusterOffset > 0 ? data.slice(0, clusterOffset) : data;
}

// Group ordered chunk files into runs that can each be decoded on their own.
function groupChunksIntoSegments(chunkDir, orderedFiles) {
    const segments = [];
    let previousIndex = null;

    for (const entry of orderedFiles) {
        const filePath = path.join(chunkDir, entry.file);
        const isGap = previousIndex !== null && entry.index !== previousIndex + 1;
        const hasOwnHeader = startsNewMediaSegment(filePath);

        if (segments.length === 0 || isGap || hasOwnHeader) {
            segments.push({
                files: [],
                startIndex: entry.index,
                endIndex: entry.index,
                hasOwnHeader,
                // A run that starts mid-stream needs initialisation bytes prefixed
                // before ffmpeg can read it. This includes the very first run when the
                // recording's opening chunk is the one that went missing.
                needsInit: !hasOwnHeader,
                precededByGap: isGap,
                missingBefore: isGap ? entry.index - previousIndex - 1 : 0
            });
        }

        const current = segments[segments.length - 1];
        current.files.push(entry.file);
        current.endIndex = entry.index;
        previousIndex = entry.index;
    }

    return segments;
}

// Write one run out as a standalone container, prefixing initialisation bytes when
// the run does not carry its own header.
function writeSegmentFile(chunkDir, segment, outPath, initSegment) {
    const parts = [];
    if (segment.needsInit) {
        if (!initSegment) return false;
        parts.push(initSegment);
    }
    for (const file of segment.files) {
        parts.push(fs.readFileSync(path.join(chunkDir, file)));
    }
    fs.writeFileSync(outPath, Buffer.concat(parts));
    return true;
}

// List a chunk directory in true numeric order. The names are zero-padded so a
// lexicographic sort happens to work today, but ordering the recording correctly
// is too important to leave resting on the padding width.
function readOrderedChunks(chunkDir) {
    return fs.readdirSync(chunkDir)
        .map(file => ({ file, index: parseChunkIndex(file) }))
        .filter(entry => entry.index !== null)
        .sort((a, b) => a.index - b.index);
}

function timemarkToSeconds(timemark) {
    if (!timemark || typeof timemark !== 'string') return 0;
    const parts = timemark.split(':');
    if (parts.length !== 3) return 0;
    const hours = parseInt(parts[0], 10) || 0;
    const minutes = parseInt(parts[1], 10) || 0;
    const seconds = parseFloat(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
}

// Normalise one recorder run to MP4. Resolves with the output duration in seconds
// so the caller can tell how much of the run actually decoded — ffmpeg-static
// ships no ffprobe, so the last progress timemark is our measurement.
function transcodeSegmentToMp4(inputPath, outputPath, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
        let lastTimemark = 0;
        const command = ffmpeg(inputPath)
            // Chunked MediaRecorder WebM has no reliable duration/timestamps in
            // its header. Regenerating presentation timestamps on the INPUT is the
            // single most important fix for the "chipmunk/fast audio" symptom —
            // without it ffmpeg guesses the timebase wrong and the whole recording
            // (audio + video) plays sped up, which raises the perceived pitch.
            .inputOptions('-fflags +genpts+discardcorrupt')
            // Push through damaged packets instead of treating the first one as
            // end-of-file. Combined with the segmenting above, this is what keeps a
            // single bad chunk from ending the video.
            .inputOptions('-err_detect ignore_err')
            .outputOptions('-c:v libx264')
            .outputOptions('-pix_fmt yuv420p')
            .outputOptions('-preset ultrafast') // Use ultrafast preset to minimize CPU/RAM usage
            .outputOptions('-crf 30')          // Lower quality/high compression to speed up transcoding
            .outputOptions('-threads 2')        // Limit CPU threads to protect Canvas LMS resources
            .outputOptions('-vsync vfr')
            // Resync audio to the (now-correct) timestamps and anchor it to t=0 so
            // it can't drift ahead of the video. aac at the source rate — no forced
            // resample, since forcing a rate is itself a common pitch-shift cause.
            .outputOptions('-af aresample=async=1:first_pts=0')
            .outputOptions('-c:a aac')
            // Uniform output parameters matter: the concat demuxer stream-copies,
            // so every segment has to share a timebase.
            .outputOptions('-video_track_timescale 90000')
            .on('start', (commandLine) => {
                console.log(`Spawned FFmpeg with command: ${commandLine}`);
            })
            .on('progress', (progress) => {
                const seconds = timemarkToSeconds(progress.timemark);
                if (seconds > lastTimemark) lastTimemark = seconds;
            })
            .on('end', () => {
                clearTimeout(timeoutId);
                resolve(lastTimemark);
            })
            .on('error', (err) => {
                clearTimeout(timeoutId);
                reject(err);
            });

        const timeoutId = setTimeout(() => {
            console.error(`Transcoding ${inputPath} timed out. Killing FFmpeg process.`);
            command.kill('SIGKILL');
        }, timeoutMs);

        command.save(outputPath);
    });
}

// Join already-normalised MP4 segments without re-encoding.
function concatMp4Segments(segmentPaths, outputPath, workDir, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
        const listPath = path.join(workDir, `concat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
        const listBody = segmentPaths
            .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
            .join('\n');
        fs.writeFileSync(listPath, listBody, 'utf8');

        let lastTimemark = 0;
        const command = ffmpeg()
            .input(listPath)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions('-c copy')
            .outputOptions('-movflags +faststart')
            .on('start', (commandLine) => {
                console.log(`Spawned FFmpeg concat with command: ${commandLine}`);
            })
            .on('progress', (progress) => {
                const seconds = timemarkToSeconds(progress.timemark);
                if (seconds > lastTimemark) lastTimemark = seconds;
            })
            .on('end', () => {
                clearTimeout(timeoutId);
                try { fs.unlinkSync(listPath); } catch (e) {}
                resolve(lastTimemark);
            })
            .on('error', (err) => {
                clearTimeout(timeoutId);
                try { fs.unlinkSync(listPath); } catch (e) {}
                reject(err);
            });

        const timeoutId = setTimeout(() => {
            console.error(`Concat for ${outputPath} timed out. Killing FFmpeg process.`);
            command.kill('SIGKILL');
        }, timeoutMs);

        command.save(outputPath);
    });
}

module.exports = {
    parseChunkIndex,
    startsNewMediaSegment,
    extractInitSegment,
    groupChunksIntoSegments,
    writeSegmentFile,
    readOrderedChunks,
    timemarkToSeconds,
    transcodeSegmentToMp4,
    concatMp4Segments
};
