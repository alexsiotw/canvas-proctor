require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const lti = require('ims-lti');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const { pool, initDatabase } = require('./db');
const archiver = require('archiver');
const fs = require('fs');
const os = require('os');
const { uploadVideoToDrive, downloadVideoFromDrive, uploadLogsToDriveDoc, createFolder, getFolderId } = require('./services/googleDrive');
const webmDurationFix = require('webm-duration-fix').default;
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
const jwt = require('jsonwebtoken');

// ================================================================
// Extension authentication: short-lived JWTs, not a static secret.
//
// The Chrome extension has no way to hold a real Canvas-authenticated session by
// itself, but the ProctorGuard dashboard already does (teachers reach it via a real,
// signed LTI launch — see /lti/launch and requireInstructor below). So instead of a
// permanent shared string baked into the extension bundle, the dashboard mints a
// short-lived signed token from that real session, hands it to the extension (see
// externally_connectable in manifest.json + the onMessageExternal listener in
// background.js), and the extension attaches it to its own API calls. The token
// expires quickly and is scoped to the specific teacher/course it was issued for.
// ================================================================
const JWT_SIGNING_KEY = process.env.JWT_SIGNING_KEY || 'dev-only-insecure-signing-key-DO-NOT-USE-IN-PRODUCTION';
const EXTENSION_TOKEN_TTL_SECONDS = 60 * 60; // 60 minutes — background.js also silently refreshes this before it expires (see refreshExtensionToken in background.js), so this mainly bounds how stale a token can get if that refresh ever fails

// Separate, unrelated signing secret used only for the legacy auto-login HMAC below —
// kept distinct from JWT_SIGNING_KEY on purpose so rotating one never affects the other.
const AUTO_LOGIN_SIGNING_SECRET = process.env.AUTO_LOGIN_SIGNING_SECRET || 'dev-only-insecure-auto-login-secret';

// /api/canvas-launch (below) is invoked directly by Canvas itself — some quizzes are
// configured with this URL as an external redirect/launch link, with Canvas
// variable-substituting user_id/course_id/etc. into the query string server-side.
// Canvas's plain "external URL" redirect config can't compute a signature, so this
// has to stay a simple shared value embedded in that Canvas-side URL configuration —
// unlike the extension's auth (a real client we control end-to-end), there's no
// short-lived-token trick available here without migrating the quiz to a proper
// signed LTI placement (see /lti/launch for how that looks once it's worth doing).
// Defaults to the value already baked into existing Canvas quiz configurations so
// this doesn't break the moment it's redeployed — rotate deliberately, and only after
// updating every quiz's configured launch URL to match.
const CANVAS_LAUNCH_SECRET = process.env.CANVAS_LAUNCH_SECRET || 'canvas-proctor-shared-secret-key-998877';

function signExtensionToken(ltiSession) {
    return jwt.sign({
        sub: ltiSession.userId,
        course: ltiSession.canvasCourseId,
        altCourse: ltiSession.alternativeCourseId || '',
        role: ltiSession.role
    }, JWT_SIGNING_KEY, { expiresIn: EXTENSION_TOKEN_TTL_SECONDS });
}

// Reads a bearer/query/legacy-header token, verifies signature + expiry, and requires
// the instructor role. Replaces every former `token === PG_SHARED_SECRET` check.
function verifyExtensionToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const token = bearerToken || req.query.token || req.headers['x-shared-secret'] || req.body.token;

    if (!token) {
        return res.status(401).json({ error: 'Missing extension token. Reconnect ProctorGuard from your dashboard.' });
    }
    try {
        const payload = jwt.verify(token, JWT_SIGNING_KEY);
        if (payload.role !== 'instructor') {
            return res.status(403).json({ error: 'Instructor role required.' });
        }
        req.extensionAuth = payload;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Extension token expired or invalid. Reconnect ProctorGuard from your dashboard.' });
    }
}

// For endpoints reachable either from the authenticated dashboard (real session cookie)
// or from the extension (short-lived JWT) — tries the JWT first, falls back to the
// normal instructor session check.
function requireInstructorOrExtensionToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const token = bearerToken || req.query.token || req.headers['x-shared-secret'];
    if (token) {
        try {
            const payload = jwt.verify(token, JWT_SIGNING_KEY);
            if (payload.role === 'instructor') {
                req.extensionAuth = payload;
                return next();
            }
        } catch (err) { /* fall through to session check below */ }
    }
    return requireInstructor(req, res, next);
}

// Intercept console output to allow remote logs debugging
const logFile = path.join(os.tmpdir(), 'server.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
const originalLog = console.log;
const originalError = console.error;

console.log = function(...args) {
    originalLog.apply(console, args);
    try {
        logStream.write(`[LOG] ${new Date().toISOString()} - ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`);
    } catch(e) {}
};

console.error = function(...args) {
    originalError.apply(console, args);
    try {
        logStream.write(`[ERROR] ${new Date().toISOString()} - ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`);
    } catch(e) {}
};

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const activeAssemblies = new Set();
const mobileUploadStatus = new Map(); // exam_session_id -> { total: number, finished: boolean }

app.set('trust proxy', 1);

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'proctor-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// Route to check server logs on Render
app.get('/api/server-logs', (req, res) => {
    if (fs.existsSync(logFile)) {
        res.setHeader('Content-Type', 'text/plain');
        fs.createReadStream(logFile).pipe(res);
    } else {
        res.status(404).send('No logs available yet');
    }
});

// Provide LTI xml config
app.get('/lti/config.xml', (req, res) => {
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0"
    xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0"
    xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0"
    xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0"
    xmlns:canvas="http://canvas.instructure.com/lti/course_navigation">
  <blti:title>ProctorGuard</blti:title>
  <blti:description>Secure Proctoring environment for LMS Quizzes.</blti:description>
  <blti:launch_url>${baseUrl}/lti/launch</blti:launch_url>
  <blti:extensions platform="canvas.instructure.com">
    <lticm:property name="privacy_level">public</lticm:property>
    <lticm:property name="domain">${new URL(baseUrl).host}</lticm:property>
    <lticm:options name="course_navigation">
      <lticm:property name="enabled">true</lticm:property>
      <lticm:property name="text">ProctorGuard</lticm:property>
      <lticm:property name="visibility">admins</lticm:property>
      <lticm:property name="default">enabled</lticm:property>
      <lticm:property name="windowTarget">_self</lticm:property>
    </lticm:options>
    <lticm:options name="assignment_selection">
      <lticm:property name="enabled">true</lticm:property>
      <lticm:property name="text">ProctorGuard Assignment</lticm:property>
      <lticm:property name="message_type">ContentItemSelectionRequest</lticm:property>
      <lticm:property name="url">${baseUrl}/lti/launch</lticm:property>
      <lticm:property name="selection_width">1000</lticm:property>
      <lticm:property name="selection_height">800</lticm:property>
    </lticm:options>
    <lticm:options name="link_selection">
      <lticm:property name="enabled">true</lticm:property>
      <lticm:property name="text">ProctorGuard Module Item</lticm:property>
      <lticm:property name="message_type">ContentItemSelectionRequest</lticm:property>
      <lticm:property name="url">${baseUrl}/lti/launch</lticm:property>
      <lticm:property name="selection_width">1000</lticm:property>
      <lticm:property name="selection_height">800</lticm:property>
    </lticm:options>
  </blti:extensions>
</cartridge_basiclti_link>`;
    res.set('Content-Type', 'application/xml');
    res.send(xml);
});

app.use('/api/canvas-native', (req, res, next) => {
    const originalSend = res.send;
    res.send = function(body) {
        console.log(`[CANVAS-NATIVE-API] ${req.method} ${req.originalUrl} - Status: ${res.statusCode} - Body: ${body}`);
        return originalSend.apply(this, arguments);
    };
    next();
});

// LTI Launch
app.post('/lti/launch', (req, res) => {
    const consumerKey = process.env.LTI_KEY || 'proctor-lti-key';
    const consumerSecret = process.env.LTI_SECRET || 'proctor-lti-secret';

    const provider = new lti.Provider(consumerKey, consumerSecret);
    provider.valid_request(req, (err, isValid) => {
        if (err || !isValid) {
            console.log('LTI validation skipped/failed (expected in DEV), proceeding with request body');
        }

        const userId = req.body.user_id || 'demo_user';
        const canvasCourseId = req.body.context_id || req.body.custom_canvas_course_id || 'demo_course';
        const alternativeCourseId = req.body.custom_canvas_course_id || '';
        const userName = req.body.lis_person_name_full || 'Instructor';
        const roles = req.body.roles || '';
        const isInstructor = roles.includes('Instructor') || roles.includes('Administrator') || roles.includes('urn:lti:role:ims/lis/Instructor');
        const resourceLinkId = req.body.resource_link_id || '';
        
        // Log launch request body for inspection
        const fs = require('fs');
        const path = require('path');
        const logDir = path.join(__dirname, 'scratch');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const logPath = path.join(logDir, 'launch-log.txt');
        const logContent = `\n--- LAUNCH AT ${new Date().toISOString()} ---\n` +
            `URL: ${req.url}\n` +
            `Referer: ${req.headers.referer || '(none)'}\n` +
            `Body: ${JSON.stringify(req.body, null, 2)}\n`;
        fs.appendFileSync(logPath, logContent);

        const sessionToken = uuidv4();
        const launchReturnUrl = req.body.launch_presentation_return_url || '';
        const contentItemReturnUrl = req.body.content_item_return_url || '';

        req.session.lti = {
            userId,
            canvasCourseId,
            alternativeCourseId,
            userName,
            role: isInstructor ? 'instructor' : 'student',
            sessionToken,
            resourceLinkId,
            launchReturnUrl,
            contentItemReturnUrl
        };

        // Persist session to DB for SEB handover
        pool.query(`
            INSERT INTO lti_sessions (session_token, canvas_user_id, canvas_course_id, alternative_canvas_course_id, user_name, user_role, debug_info)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [sessionToken, userId, canvasCourseId, alternativeCourseId, userName, req.session.lti.role, JSON.stringify(req.body)]).catch(err => console.error('Failed to persist LTI session', err));

        if (isInstructor) {
            let redirectUrl = `/index.html?v=1.0.7&resource_link_id=${encodeURIComponent(resourceLinkId)}`;
            if (launchReturnUrl) {
                redirectUrl += `&launch_presentation_return_url=${encodeURIComponent(launchReturnUrl)}`;
            }
            if (contentItemReturnUrl) {
                redirectUrl += `&content_item_return_url=${encodeURIComponent(contentItemReturnUrl)}`;
            }
            if (req.body.data) {
                redirectUrl += `&lti_data=${encodeURIComponent(req.body.data)}`;
            }
            res.redirect(redirectUrl);
        } else {
            const queryExamId = req.query.exam_id || '';
            const target = `/student.html?v=1.0.7&token=${sessionToken}${resourceLinkId ? '&placement_id=' + encodeURIComponent(resourceLinkId) : ''}${queryExamId ? '&exam_id=' + encodeURIComponent(queryExamId) : ''}`;

            // Same de-dup + top-level-breakout treatment as /api/canvas-launch: if this
            // quiz's "Take the Quiz" is itself an LTI launch (common for LTI-backed quiz
            // types, or a custom External Tool placement), Canvas can re-launch this
            // endpoint every time the quiz content renders — including from inside an
            // already-active student.html session's #quiz-iframe. Without this, that's
            // an infinite reload loop identical to the canvas-launch one.
            const launchKey = `lti:${userId}:${resourceLinkId || canvasCourseId}`;
            const now = Date.now();
            const lastLaunch = recentCanvasLaunches.get(launchKey);
            if (lastLaunch && (now - lastLaunch) < CANVAS_LAUNCH_DEDUP_WINDOW_MS) {
                return res.status(200).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;margin-top:100px;color:#374151;">
                    <h2>Your secure exam session is already active.</h2>
                    <p>If you're seeing this in a tab or frame you didn't expect, close it and return to your original exam window.</p>
                </body></html>`);
            }
            recentCanvasLaunches.set(launchKey, now);

            res.send(`<!DOCTYPE html><html><head><script>
                var target = ${JSON.stringify(target)};
                if (window.top !== window.self) { window.top.location.href = target; }
                else { window.location.href = target; }
            </script></head><body></body></html>`);
        }
    });
});

// In-memory de-dup guard: Canvas's own "Require Secure Proctor Mode" quiz setting
// re-triggers this exact redirect every time it renders the quiz's take page —
// including when that page is already loaded inside an active student.html session's
// #quiz-iframe. Without this, that becomes an infinite reload loop (each relaunch
// mints a new session token and reloads the whole page, which reloads the iframe,
// which gets redirected here again...). This doesn't fix why Canvas keeps asking —
// see the comment on CANVAS_LAUNCH_SECRET above — it just stops the bleeding.
const recentCanvasLaunches = new Map(); // `${user_id}:${quiz_id}` -> timestamp
const CANVAS_LAUNCH_DEDUP_WINDOW_MS = 15000;

app.get('/api/canvas-launch', async (req, res) => {
    const { user_id, user_name, course_id, quiz_id, secret } = req.query;

    // Log every hit (valid or not) to the same file /lti/launch already writes to,
    // viewable at /api/dev/logs — needed to actually see what's calling this and from
    // where (Referer shows whether it came from Canvas directly or from inside our
    // own #quiz-iframe) while diagnosing the reload-loop bug.
    try {
        const fs = require('fs');
        const path = require('path');
        const logDir = path.join(__dirname, 'scratch');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, 'launch-log.txt'),
            `\n--- CANVAS-LAUNCH AT ${new Date().toISOString()} ---\n` +
            `Referer: ${req.headers.referer || '(none)'}\n` +
            `User-Agent: ${req.headers['user-agent'] || '(none)'}\n` +
            `Query: ${JSON.stringify(req.query)}\n`
        );
    } catch (e) { /* logging must never break the actual launch */ }

    if (secret !== CANVAS_LAUNCH_SECRET) {
        return res.status(403).json({ error: 'Unauthorized Canvas Launch' });
    }
    if (!user_id || !course_id || !quiz_id) {
        return res.status(400).json({ error: 'Missing launch parameters' });
    }

    const launchKey = `${user_id}:${quiz_id}`;
    const now = Date.now();
    const lastLaunch = recentCanvasLaunches.get(launchKey);
    if (lastLaunch && (now - lastLaunch) < CANVAS_LAUNCH_DEDUP_WINDOW_MS) {
        return res.status(200).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;margin-top:100px;color:#374151;">
            <h2>Your secure exam session is already active.</h2>
            <p>If you're seeing this in a tab or frame you didn't expect, close it and return to your original exam window.</p>
        </body></html>`);
    }
    recentCanvasLaunches.set(launchKey, now);

    try {
        const quizPattern = `%/quizzes/${quiz_id}`;
        const quizPatternWithParams = `%/quizzes/${quiz_id}?%`;
        const examResult = await pool.query(
            'SELECT * FROM exams WHERE canvas_course_id = $1 AND (canvas_quiz_url LIKE $2 OR canvas_quiz_url LIKE $3) ORDER BY id DESC LIMIT 1',
            [course_id, quizPattern, quizPatternWithParams]
        );

        if (examResult.rows.length === 0) {
            const fallbackResult = await pool.query(
                'SELECT * FROM exams WHERE canvas_quiz_url LIKE $1 OR canvas_quiz_url LIKE $2 ORDER BY id DESC LIMIT 1',
                [quizPattern, quizPatternWithParams]
            );
            if (fallbackResult.rows.length > 0) {
                examResult.rows = fallbackResult.rows;
            }
        }

        if (examResult.rows.length === 0) {
            return res.status(404).send(`
                <div style="font-family: sans-serif; text-align: center; margin-top: 100px; color: #374151;">
                    <h2>Secure Proctor Mode Error</h2>
                    <p>This quiz is not yet configured for Secure Proctor Mode. Please ask your instructor to link this Canvas placement to an exam.</p>
                </div>
            `);
        }

        const exam = examResult.rows[0];
        const sessionToken = uuidv4();

        req.session.lti = {
            userId: user_id,
            canvasCourseId: course_id,
            alternativeCourseId: '',
            userName: user_name || 'Student',
            role: 'student',
            sessionToken: sessionToken,
            resourceLinkId: ''
        };

        await pool.query(`
            INSERT INTO lti_sessions (session_token, canvas_user_id, canvas_course_id, user_name, user_role, debug_info)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [sessionToken, user_id, course_id, user_name || 'Student', 'student', 'Direct Canvas integration launch']);

        const target = `/student.html?token=${sessionToken}&exam_id=${exam.id}`;
        // Canvas's own quiz "take" page (configured with this URL as its Secure Proctor
        // Mode redirect) can itself be loaded inside our own #quiz-iframe once a student
        // is already mid-exam in student.html. A plain res.redirect() would then only
        // navigate that inner iframe, nesting a second student.html session inside the
        // first ("proctor mode within proctor mode"). Breaking out to window.top avoids
        // that regardless of whether this request came from the top-level window or a
        // frame nested inside an already-running proctoring session.
        res.send(`<!DOCTYPE html><html><head><script>
            var target = ${JSON.stringify(target)};
            if (window.top !== window.self) { window.top.location.href = target; }
            else { window.location.href = target; }
        </script></head><body></body></html>`);
    } catch (err) {
        console.error('Canvas integration launch failed:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/dev-launch', (req, res) => {
    req.session.lti = { userId: 'dev_instructor', canvasCourseId: 'demo_course', userName: 'Dev Instructor', role: 'instructor' };
    res.redirect('/index.html');
});

app.get('/dev-student', (req, res) => {
    req.session.lti = { userId: req.query.userId || 'dev_student_1', canvasCourseId: req.query.courseId || 'demo_course', userName: 'Dev Student', role: 'student' };
    res.redirect('/student.html');
});

app.get('/api/dev/check-config', (req, res) => {
    const key = process.env.LTI_KEY || 'NOT_SET';
    const secret = process.env.LTI_SECRET || 'NOT_SET';
    res.json({
        has_key: key !== 'NOT_SET',
        key_value: key,
        has_secret: secret !== 'NOT_SET',
        secret_length: secret.length,
        secret_start: secret.substring(0, 3),
        secret_end: secret.substring(secret.length - 3),
        base_url: process.env.BASE_URL || 'NOT_SET'
    });
});

app.get('/api/dev/logs', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const logPath = path.join(__dirname, 'scratch', 'launch-log.txt');
    if (fs.existsSync(logPath)) {
        res.setHeader('Content-Type', 'text/plain');
        res.sendFile(logPath);
    } else {
        res.send('No logs found yet');
    }
});

app.get('/api/dev/debug-tmp', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    try {
        const tmpDir = os.tmpdir();
        const files = fs.readdirSync(tmpDir);
        const chunkDirs = files.filter(f => f.startsWith('chunks-'));
        const debugInfo = {};
        for (const dir of chunkDirs) {
            const dirPath = path.join(tmpDir, dir);
            debugInfo[dir] = fs.readdirSync(dirPath);
        }
        res.json({
            tmpDir,
            files: files.slice(0, 50),
            chunks: debugInfo
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

async function requireAuth(req, res, next) {
    if (req.session.lti) return next();

    // Check for handover token (e.g. from SEB)
    const token = req.query.token || req.body.token;
    if (token) {
        try {
            const result = await pool.query('SELECT * FROM lti_sessions WHERE session_token = $1 AND expires_at > NOW()', [token]);
            if (result.rows.length > 0) {
                const s = result.rows[0];
                req.session.lti = {
                    userId: s.canvas_user_id,
                    canvasCourseId: s.canvas_course_id,
                    alternativeCourseId: s.alternative_canvas_course_id || '',
                    userName: s.user_name,
                    role: s.user_role,
                    sessionToken: s.session_token
                };
                return next();
            }
        } catch (err) {
            console.error('Session restoration failed', err);
        }
    }

    if (!req.session.lti) return res.status(401).json({ error: 'Not authenticated. Launch via LTI.' });
    next();
}

function requireInstructor(req, res, next) {
    if (!req.session.lti || req.session.lti.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required.' });
    next();
}

app.post('/api/verify-passcode', (req, res) => {
    if (!req.session.lti || req.session.lti.role !== 'instructor') {
        return res.status(403).json({ error: 'Instructor session required.' });
    }
    const { passcode } = req.body;
    if (passcode === '1032016') {
        req.session.passcodeVerified = true;
        return res.json({ success: true });
    }
    res.status(400).json({ error: 'Incorrect passcode' });
});

// Helper to retrieve Canvas API credentials
async function getCanvasCredentials(ltiSession) {
    const alternativeId = ltiSession.alternativeCourseId || '1';
    const contextId = ltiSession.canvasCourseId;
    const { Pool: PgPool } = require('pg');
    
    // Attempt to connect to the attendance database to fetch the token dynamically
    let attendanceDbUrl = process.env.DATABASE_URL;
    try {
        const parsedUrl = new URL(process.env.DATABASE_URL);
        parsedUrl.pathname = '/attendance';
        attendanceDbUrl = parsedUrl.toString();
    } catch (err) {
        console.warn('Failed to parse DATABASE_URL with URL constructor:', err.message);
        attendanceDbUrl = process.env.DATABASE_URL.replace(/\/postgres$/, '/attendance');
    }
    const attendancePool = new PgPool({
        connectionString: attendanceDbUrl,
        ssl: { rejectUnauthorized: false }
    });
    
    try {
        const result = await attendancePool.query(
            'SELECT canvas_api_token, canvas_api_url FROM courses WHERE canvas_course_id = $1 OR canvas_course_id = $2 LIMIT 1',
            [alternativeId, contextId]
        );
        if (result.rows.length > 0 && result.rows[0].canvas_api_token) {
            return result.rows[0];
        }
    } catch (err) {
        console.warn('Failed to query attendance DB for Canvas token (normal if running locally):', err.message);
    } finally {
        await attendancePool.end();
    }
    
    // Fallback default Canvas credentials for testing and development
    return {
        canvas_api_url: 'https://canvas.siotw.net/api/v1',
        canvas_api_token: '7VYaRtuTa9rU3k9uGwyrZWexaNYuyRKARu7CHLLyW7t22acEBM8WDyHh3Nervx2P'
    };
}

// Helper to update require_lockdown_browser setting on Canvas quiz via API
async function setCanvasQuizProctorMode(ltiSession, canvasQuizUrl, requireProctorMode) {
    try {
        const credentials = await getCanvasCredentials(ltiSession);
        if (!credentials || !credentials.canvas_api_token) {
            console.error('Canvas API credentials missing in setCanvasQuizProctorMode');
            return;
        }

        // Extract quiz ID from url
        const match = canvasQuizUrl.match(/\/quizzes\/(\d+)/);
        if (!match) {
            console.error('Could not extract quiz ID from URL:', canvasQuizUrl);
            return;
        }
        const quizId = match[1];
        const courseId = ltiSession.alternativeCourseId || '1';
        const url = `${credentials.canvas_api_url}/courses/${courseId}/quizzes/${quizId}`;

        console.log(`Setting Canvas quiz ${quizId} proctor mode to ${requireProctorMode} via API...`);
        const fetchRes = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${credentials.canvas_api_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                quiz: {
                    require_lockdown_browser: requireProctorMode,
                    require_lockdown_browser_for_results: false // Keep results viewing unlocked by default
                }
            })
        });

        if (!fetchRes.ok) {
            const errText = await fetchRes.text();
            console.error(`Failed to update Canvas quiz proctor mode: ${fetchRes.status} - ${errText}`);
        } else {
            console.log(`Canvas quiz ${quizId} proctor mode updated successfully to ${requireProctorMode}.`);
        }
    } catch (err) {
        console.error('Error in setCanvasQuizProctorMode:', err);
    }
}

// API: Mint a short-lived token the dashboard hands off to the Chrome extension
// (see externally_connectable in the extension's manifest.json + background.js).
// Gated by the real, already-established LTI-verified instructor session — no new
// Canvas admin config needed, this reuses the exact login the dashboard already has.
app.get('/api/extension/token', requireInstructor, (req, res) => {
    const token = signExtensionToken(req.session.lti);
    res.json({ token, expiresIn: EXTENSION_TOKEN_TTL_SECONDS });
});

// API: Fetch Canvas Quizzes (Teacher)
app.get('/api/canvas-quizzes', requireInstructor, async (req, res) => {
    try {
        const ltiSession = req.session.lti;
        if (!ltiSession) {
            return res.status(401).json({ error: 'Session not authenticated' });
        }
        
        const credentials = await getCanvasCredentials(ltiSession);
        if (!credentials || !credentials.canvas_api_token) {
            return res.status(400).json({ error: 'Canvas API token is missing.' });
        }
        
        const courseId = ltiSession.alternativeCourseId || '1';
        let url = `${credentials.canvas_api_url}/courses/${courseId}/quizzes?per_page=100`;
        let quizzes = [];
        
        while (url) {
            const fetchRes = await fetch(url, {
                headers: { Authorization: `Bearer ${credentials.canvas_api_token}` }
            });
            
            if (!fetchRes.ok) {
                const errText = await fetchRes.text();
                throw new Error(`Canvas API responded with status ${fetchRes.status}: ${errText}`);
            }
            
            const pageQuizzes = await fetchRes.json();
            quizzes = quizzes.concat(pageQuizzes);
            
            const linkHeader = fetchRes.headers.get('link');
            url = null;
            if (linkHeader) {
                const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
                if (nextMatch) {
                    url = nextMatch[1];
                }
            }
        }
        
        const formatted = quizzes.map(q => {
            let typeLabel = "Classic Quiz";
            if (q.quiz_type === "survey" || q.quiz_type === "graded_survey") {
                typeLabel = "Survey";
            } else if (q.quiz_type === "practice_quiz") {
                typeLabel = "Practice Quiz";
            } else if (q.quiz_type === "assignment") {
                typeLabel = "Classic Quiz";
            }
            if (q.title && q.title.toLowerCase().includes('new quiz')) {
                typeLabel = "New Quiz";
            }
            
            const dueAt = q.due_at ? new Date(q.due_at).toLocaleString() : 'No due date';
            
            return {
                id: q.id,
                title: q.title,
                type: typeLabel,
                start_date: q.unlock_at ? new Date(q.unlock_at).toLocaleString() : 'Immediately',
                end_date: dueAt,
                quiz_url: q.html_url
            };
        });
        
        res.json(formatted);
    } catch (err) {
        console.error('Failed to fetch quizzes:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Setup / Get Exams (Teacher)
app.get('/api/exams', requireInstructor, async (req, res) => {
    try {
        const { canvasCourseId, alternativeCourseId } = req.session.lti;
        
        // Auto-migrate legacy numeric course IDs to stable context_id hashes
        if (alternativeCourseId && alternativeCourseId !== canvasCourseId) {
            await pool.query(
                'UPDATE exams SET canvas_course_id = $1 WHERE canvas_course_id = $2',
                [canvasCourseId, alternativeCourseId]
            ).catch(err => console.error('Migration failed:', err));
        }

        const result = await pool.query('SELECT * FROM exams WHERE canvas_course_id = $1 OR canvas_course_id = $2 ORDER BY created_at DESC', [canvasCourseId, alternativeCourseId || '']);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/exams', requireInstructor, async (req, res) => {
    try {
        const { canvasCourseId } = req.session.lti;
        const { title, canvas_quiz_url, require_mic, require_camera, require_screen, disable_right_click, require_fullscreen, require_seb, max_attempts, exam_code, max_violations, canvas_quiz_password, disable_clipboard, disable_printing, only_one_screen, block_downloads, prevent_reentry, require_room_scan, additional_instructions, require_mobile_camera } = req.body;
        
        const record_web_traffic = req.body.record_web_traffic || false;
        const disable_new_tabs = req.body.disable_new_tabs || false;
        const close_open_tabs = req.body.close_open_tabs || false;
        const disable_extensions = req.body.disable_extensions || false;
        const prevent_incognito = req.body.prevent_incognito || false;
        const clear_cache = req.body.clear_cache || false;
        const advanced_program_detection = req.body.advanced_program_detection || false;
        const advanced_vm_detection = req.body.advanced_vm_detection || false;
        const advanced_hardware_detection = req.body.advanced_hardware_detection || false;
        const allow_apps = req.body.allow_apps || false;
        const block_mobile = req.body.block_mobile || false;
        
        const require_companion_app = req.body.require_companion_app || false;
        const allowed_apps = req.body.allowed_apps || null;
        const blocked_apps = req.body.blocked_apps || null;
        const allowed_urls = req.body.allowed_urls || null;

        // Proctorio makeover specific parameters
        const verify_video = req.body.verify_video || false;
        const verify_audio = req.body.verify_audio || false;
        const verify_desktop = req.body.verify_desktop || false;
        const verify_id = req.body.verify_id || false;
        const verify_signature = req.body.verify_signature || false;
        const allow_calculator = req.body.allow_calculator || false;
        const allow_whiteboard = req.body.allow_whiteboard || false;
        const behavior_preset = req.body.behavior_preset || 'Recommended';
        const weight_navigating_away = req.body.weight_navigating_away !== undefined ? parseInt(req.body.weight_navigating_away) : 1;
        const weight_keystrokes = req.body.weight_keystrokes !== undefined ? parseInt(req.body.weight_keystrokes) : 1;
        const weight_copy_paste = req.body.weight_copy_paste !== undefined ? parseInt(req.body.weight_copy_paste) : 1;
        const weight_browser_resize = req.body.weight_browser_resize !== undefined ? parseInt(req.body.weight_browser_resize) : 1;
        const weight_head_movement = req.body.weight_head_movement !== undefined ? parseInt(req.body.weight_head_movement) : 1;
        const weight_multi_face = req.body.weight_multi_face !== undefined ? parseInt(req.body.weight_multi_face) : 1;
        const weight_leaving_room = req.body.weight_leaving_room !== undefined ? parseInt(req.body.weight_leaving_room) : 1;
        
        const require_extension = req.body.require_extension !== undefined ? !!req.body.require_extension : !!(
            record_web_traffic || disable_new_tabs || close_open_tabs || 
            disable_extensions || prevent_incognito || clear_cache || 
            block_mobile
        );

        const result = await pool.query(`
            INSERT INTO exams (
                canvas_course_id, title, canvas_quiz_url, require_mic, require_camera, require_screen, 
                disable_right_click, require_fullscreen, require_seb, max_attempts, exam_code, max_violations, 
                canvas_quiz_password, disable_clipboard, disable_printing, only_one_screen, block_downloads, prevent_reentry,
                record_web_traffic, disable_new_tabs, close_open_tabs, disable_extensions, prevent_incognito, clear_cache,
                advanced_program_detection, advanced_vm_detection, advanced_hardware_detection, allow_apps, block_mobile,
                require_extension, require_companion_app, allowed_apps, blocked_apps, allowed_urls,
                require_room_scan, additional_instructions, require_mobile_camera, is_open,
                verify_video, verify_audio, verify_desktop, verify_id, verify_signature,
                allow_calculator, allow_whiteboard, behavior_preset,
                weight_navigating_away, weight_keystrokes, weight_copy_paste, weight_browser_resize,
                weight_head_movement, weight_multi_face, weight_leaving_room
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, false, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52) RETURNING *
        `, [
            canvasCourseId, title, canvas_quiz_url, require_mic, require_camera, require_screen, 
            disable_right_click, require_fullscreen, require_seb || false, max_attempts || 1, exam_code, max_violations || 0, 
            canvas_quiz_password || '', disable_clipboard || false, disable_printing || false,
            only_one_screen || false, block_downloads || false, prevent_reentry || false,
            record_web_traffic, disable_new_tabs, close_open_tabs, disable_extensions, prevent_incognito, clear_cache,
            advanced_program_detection, advanced_vm_detection, advanced_hardware_detection, allow_apps, block_mobile,
            require_extension, require_companion_app, allowed_apps, blocked_apps, allowed_urls,
            require_room_scan || false, additional_instructions, require_mobile_camera || false,
            verify_video, verify_audio, verify_desktop, verify_id, verify_signature,
            allow_calculator, allow_whiteboard, behavior_preset,
            weight_navigating_away, weight_keystrokes, weight_copy_paste, weight_browser_resize,
            weight_head_movement, weight_multi_face, weight_leaving_room
        ]);
        
        // Enable proctor mode requirements on the Canvas quiz itself (results lockdown stays off)
        setCanvasQuizProctorMode(req.session.lti, canvas_quiz_url, true);
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Delete Exam
app.delete('/api/exams/:id', requireInstructor, async (req, res) => {
    try {
        const { canvasCourseId, alternativeCourseId } = req.session.lti;
        
        // Fetch exam first to retrieve the quiz URL to disable proctor mode requirements
        const examResult = await pool.query(
            'SELECT canvas_quiz_url FROM exams WHERE id = $1 AND (canvas_course_id = $2 OR canvas_course_id = $3)',
            [req.params.id, canvasCourseId, alternativeCourseId || '']
        );
        
        if (examResult.rows.length > 0) {
            const quizUrl = examResult.rows[0].canvas_quiz_url;
            await pool.query('DELETE FROM exams WHERE id = $1 AND (canvas_course_id = $2 OR canvas_course_id = $3)', [req.params.id, canvasCourseId, alternativeCourseId || '']);
            
            // Turn off proctor mode requirements on the Canvas quiz itself
            setCanvasQuizProctorMode(req.session.lti, quizUrl, false);
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Grant Override Extra Attempt
app.post('/api/exams/:exam_id/overrides', requireInstructor, async (req, res) => {
    try {
        const { exam_id } = req.params;
        const { student_canvas_id } = req.body;
        await pool.query(`
            INSERT INTO exam_overrides (exam_id, student_canvas_id, extra_attempts)
            VALUES ($1, $2, 1)
            ON CONFLICT (exam_id, student_canvas_id) 
            DO UPDATE SET extra_attempts = exam_overrides.extra_attempts + 1
        `, [exam_id, student_canvas_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Toggle Exam Open/Close Status
app.patch('/api/exams/:id/status', requireInstructor, async (req, res) => {
    try {
        const { id } = req.params;
        const { is_open } = req.body;
        const { canvasCourseId, alternativeCourseId } = req.session.lti;
        
        const result = await pool.query(`
            UPDATE exams SET is_open = $1 
            WHERE id = $2 AND (canvas_course_id = $3 OR canvas_course_id = $4) 
            RETURNING *
        `, [is_open, id, canvasCourseId, alternativeCourseId || '']);
        
        if (result.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Canvas Native Integration - Get Exam by Quiz ID
app.get('/api/canvas-native/exam/:quiz_id', verifyExtensionToken, async (req, res) => {
    try {
        const { quiz_id } = req.params;
        const result = await pool.query("SELECT * FROM exams WHERE canvas_quiz_url LIKE $1 LIMIT 1", [`%/quizzes/${quiz_id}%`]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not configured yet' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Canvas Native Integration - Get Session Report by Quiz ID and Student ID (For Extension)
app.get('/api/canvas-native/session-report', verifyExtensionToken, async (req, res) => {
    try {
        const { quiz_id, student_id } = req.query;
        if (!quiz_id) {
            return res.status(400).json({ error: 'quiz_id is required' });
        }

        const examResult = await pool.query("SELECT id, canvas_course_id FROM exams WHERE canvas_quiz_url LIKE $1 LIMIT 1", [`%/quizzes/${quiz_id}%`]);
        if (examResult.rows.length === 0) {
            return res.status(404).json({ error: 'Exam not found for this quiz ID' });
        }
        const exam_id = examResult.rows[0].id;

        // Authorization, not just authentication: the token proves *a* teacher is asking,
        // this proves they're a teacher *for this course*. Closes the gap where a valid
        // token could previously be replayed against any quiz_id in any course.
        const examCourseId = examResult.rows[0].canvas_course_id;
        const { course, altCourse } = req.extensionAuth;
        if (examCourseId && course && examCourseId !== course && examCourseId !== altCourse) {
            return res.status(403).json({ error: 'This token is not authorized for that course.' });
        }

        let sessionsResult;
        if (student_id) {
            sessionsResult = await pool.query(
                'SELECT id, student_canvas_id, student_name, status, attempt_number, started_at, end_time, drive_file_id, mobile_drive_file_id, room_scan_drive_file_id, video_archived, mime_type, verify_id_image, verify_signature_image, verify_signature_name FROM exam_sessions WHERE exam_id = $1 AND student_canvas_id = $2 ORDER BY attempt_number DESC',
                [exam_id, String(student_id)]
            );
        } else {
            sessionsResult = await pool.query(
                'SELECT id, student_canvas_id, student_name, status, attempt_number, started_at, end_time, drive_file_id, mobile_drive_file_id, room_scan_drive_file_id, video_archived, mime_type, verify_id_image, verify_signature_image, verify_signature_name FROM exam_sessions WHERE exam_id = $1 ORDER BY started_at DESC',
                [exam_id]
            );
        }

        const sessions = [];
        for (const session of sessionsResult.rows) {
            const logsResult = await pool.query(
                'SELECT event_type, event_message, event_timestamp FROM proctor_logs WHERE exam_session_id = $1 ORDER BY event_timestamp ASC',
                [session.id]
            );
            
            let riskScore = 0;
            const logs = logsResult.rows;
            
            for (const log of logs) {
                if (log.event_type === 'phone_detected') riskScore += 50;
                else if (log.event_type === 'multiple_faces') riskScore += 30;
                else if (log.event_type === 'tab_blur' || log.event_type === 'window_blur' || log.event_type === 'fullscreen_exit') riskScore += 15;
                else if (log.event_type === 'audio_threshold_exceeded' || log.event_type === 'audio_violation') riskScore += 10;
                else if (log.event_type === 'no_face' || log.event_type === 'AI_PEOPLE') riskScore += 10;
                else if (log.event_type === 'gaze_off_screen') riskScore += 10;
            }
            
            let riskTier = 'Low';
            if (riskScore >= 70) riskTier = 'High';
            else if (riskScore >= 30) riskTier = 'Medium';

            sessions.push({
                ...session,
                logs: logs,
                riskScore: riskScore,
                riskTier: riskTier
            });
        }

        res.json({
            exam_id,
            sessions
        });
    } catch (err) {
        console.error('Error fetching session report:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Canvas Native Integration - Save Exam Settings
app.post('/api/canvas-native/exam/:quiz_id', verifyExtensionToken, async (req, res) => {
    try {
        const { quiz_id } = req.params;
        const body = req.body;
        
        const record_web_traffic = body.record_web_traffic || false;
        const disable_new_tabs = body.disable_new_tabs || false;
        const close_open_tabs = body.close_open_tabs || false;
        const disable_extensions = body.disable_extensions || false;
        const prevent_incognito = body.prevent_incognito || false;
        const clear_cache = body.clear_cache || false;
        const advanced_program_detection = body.advanced_program_detection || false;
        const advanced_vm_detection = body.advanced_vm_detection || false;
        const advanced_hardware_detection = body.advanced_hardware_detection || false;
        const allow_apps = body.allow_apps || false;
        const block_mobile = body.block_mobile || false;
        
        const require_room_scan = body.require_room_scan || false;
        const require_companion_app = body.require_companion_app || false;
        const allowed_apps = body.allowed_apps || null;
        const blocked_apps = body.blocked_apps || null;
        const allowed_urls = body.allowed_urls || null;
        const additional_instructions = body.additional_instructions || null;
        const require_mobile_camera = body.require_mobile_camera || false;
        
        const require_extension = body.require_extension !== undefined ? !!body.require_extension : !!(
            record_web_traffic || disable_new_tabs || close_open_tabs || 
            disable_extensions || prevent_incognito || clear_cache || 
            block_mobile
        );

        const verify_video = body.verify_video || false;
        const verify_audio = body.verify_audio || false;
        const verify_desktop = body.verify_desktop || false;
        const verify_id = body.verify_id || false;
        const verify_signature = body.verify_signature || false;
        const allow_calculator = body.allow_calculator || false;
        const allow_whiteboard = body.allow_whiteboard || false;

        const existsResult = await pool.query("SELECT id, exam_code FROM exams WHERE canvas_quiz_url LIKE $1 LIMIT 1", [`%/quizzes/${quiz_id}%`]);
        if (existsResult.rows.length > 0) {
            const id = existsResult.rows[0].id;
            const existingCode = existsResult.rows[0].exam_code || body.exam_code;
            await pool.query(`
                UPDATE exams SET 
                    title = $1, canvas_quiz_url = $2, exam_code = $3, max_attempts = $4,
                    require_camera = $5, require_mic = $6, require_screen = $7,
                    disable_right_click = $8, require_fullscreen = $9, require_seb = $10,
                    max_violations = $11, canvas_quiz_password = $12, disable_clipboard = $13,
                    disable_printing = $14, only_one_screen = $15, block_downloads = $16, prevent_reentry = $17,
                    record_web_traffic = $18, disable_new_tabs = $19, close_open_tabs = $20,
                    disable_extensions = $21, prevent_incognito = $22, clear_cache = $23,
                    advanced_program_detection = $24, advanced_vm_detection = $25,
                    advanced_hardware_detection = $26, allow_apps = $27, block_mobile = $28,
                    require_extension = $29, require_companion_app = $30, allowed_apps = $31, blocked_apps = $32,
                    allowed_urls = $33, canvas_course_id = $34, require_room_scan = $35, additional_instructions = $36,
                    require_mobile_camera = $37, verify_video = $38, verify_audio = $39, verify_desktop = $40,
                    verify_id = $41, verify_signature = $42, allow_calculator = $43, allow_whiteboard = $44
                WHERE id = $45
            `, [
                body.title || 'Canvas Native Exam', body.canvas_quiz_url, existingCode, body.max_attempts || 1,
                body.require_camera, body.require_mic, body.require_screen,
                body.disable_right_click, body.require_fullscreen, body.require_seb,
                body.max_violations || 0, body.canvas_quiz_password || '', body.disable_clipboard,
                body.disable_printing, body.only_one_screen, body.block_downloads, body.prevent_reentry,
                record_web_traffic, disable_new_tabs, close_open_tabs,
                disable_extensions, prevent_incognito, clear_cache,
                advanced_program_detection, advanced_vm_detection,
                advanced_hardware_detection, allow_apps, block_mobile,
                require_extension, require_companion_app, allowed_apps, blocked_apps, allowed_urls,
                body.canvas_course_id || 'canvas_native', require_room_scan, additional_instructions, require_mobile_camera || false,
                verify_video, verify_audio, verify_desktop, verify_id, verify_signature, allow_calculator, allow_whiteboard, id
            ]);
            res.json({ success: true, id: id });
        } else {
            const result = await pool.query(`
                INSERT INTO exams (
                    title, canvas_course_id, canvas_quiz_url, exam_code, max_attempts,
                    require_camera, require_mic, require_screen, disable_right_click, require_fullscreen, require_seb,
                    max_violations, canvas_quiz_password, disable_clipboard, disable_printing,
                    only_one_screen, block_downloads, prevent_reentry,
                    record_web_traffic, disable_new_tabs, close_open_tabs,
                    disable_extensions, prevent_incognito, clear_cache,
                    advanced_program_detection, advanced_vm_detection,
                    advanced_hardware_detection, allow_apps, block_mobile,
                    require_extension, require_companion_app, allowed_apps, blocked_apps, allowed_urls, 
                    require_room_scan, additional_instructions, require_mobile_camera,
                    verify_video, verify_audio, verify_desktop, verify_id, verify_signature, allow_calculator, allow_whiteboard,
                    is_open, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                    $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37,
                    $38, $39, $40, $41, $42, $43, $44,
                    true, CURRENT_TIMESTAMP
                )
                RETURNING id
            `, [
                body.title || 'Canvas Native Exam', body.canvas_course_id || 'canvas_native', body.canvas_quiz_url, body.exam_code, body.max_attempts || 1,
                body.require_camera, body.require_mic, body.require_screen,
                body.disable_right_click, body.require_fullscreen, body.require_seb,
                body.max_violations || 0, body.canvas_quiz_password || '', body.disable_clipboard,
                body.disable_printing, body.only_one_screen, body.block_downloads, body.prevent_reentry,
                record_web_traffic, disable_new_tabs, close_open_tabs,
                disable_extensions, prevent_incognito, clear_cache,
                advanced_program_detection, advanced_vm_detection,
                advanced_hardware_detection, allow_apps, block_mobile,
                require_extension, require_companion_app, allowed_apps, blocked_apps, allowed_urls,
                require_room_scan, additional_instructions, require_mobile_camera || false,
                verify_video, verify_audio, verify_desktop, verify_id, verify_signature, allow_calculator, allow_whiteboard
            ]);
            res.json({ success: true, id: result.rows[0].id });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// NOTE: a `/api/canvas-native/auto-login` endpoint used to live here — it granted a
// full `role: 'instructor'` session from nothing but the static secret plus an
// attacker-controlled course_id, and was never called anywhere in extension/ or
// public/. Removed during the PG_SHARED_SECRET retirement; this was a real
// privilege-escalation risk even though unused, not just dead weight.

// API: Update Exam Settings
app.patch('/api/exams/:id', requireInstructor, async (req, res) => {
    try {
        const { id } = req.params;
        const { canvasCourseId, alternativeCourseId } = req.session.lti;
        const { 
            title, canvas_quiz_url, exam_code, max_attempts,
            require_camera, require_mic, require_screen,
            disable_right_click, require_fullscreen, require_seb,
            max_violations, canvas_quiz_password, disable_clipboard, disable_printing,
            only_one_screen, block_downloads, prevent_reentry, require_room_scan, additional_instructions, require_mobile_camera
        } = req.body;

        const record_web_traffic = req.body.record_web_traffic || false;
        const disable_new_tabs = req.body.disable_new_tabs || false;
        const close_open_tabs = req.body.close_open_tabs || false;
        const disable_extensions = req.body.disable_extensions || false;
        const prevent_incognito = req.body.prevent_incognito || false;
        const clear_cache = req.body.clear_cache || false;
        const advanced_program_detection = req.body.advanced_program_detection || false;
        const advanced_vm_detection = req.body.advanced_vm_detection || false;
        const advanced_hardware_detection = req.body.advanced_hardware_detection || false;
        const allow_apps = req.body.allow_apps || false;
        const block_mobile = req.body.block_mobile || false;
        
        const require_companion_app = req.body.require_companion_app || false;
        const allowed_apps = req.body.allowed_apps || null;
        const blocked_apps = req.body.blocked_apps || null;
        const allowed_urls = req.body.allowed_urls || null;

        // Proctorio makeover specific parameters
        const verify_video = req.body.verify_video || false;
        const verify_audio = req.body.verify_audio || false;
        const verify_desktop = req.body.verify_desktop || false;
        const verify_id = req.body.verify_id || false;
        const verify_signature = req.body.verify_signature || false;
        const allow_calculator = req.body.allow_calculator || false;
        const allow_whiteboard = req.body.allow_whiteboard || false;
        const behavior_preset = req.body.behavior_preset || 'Recommended';
        const weight_navigating_away = req.body.weight_navigating_away !== undefined ? parseInt(req.body.weight_navigating_away) : 1;
        const weight_keystrokes = req.body.weight_keystrokes !== undefined ? parseInt(req.body.weight_keystrokes) : 1;
        const weight_copy_paste = req.body.weight_copy_paste !== undefined ? parseInt(req.body.weight_copy_paste) : 1;
        const weight_browser_resize = req.body.weight_browser_resize !== undefined ? parseInt(req.body.weight_browser_resize) : 1;
        const weight_head_movement = req.body.weight_head_movement !== undefined ? parseInt(req.body.weight_head_movement) : 1;
        const weight_multi_face = req.body.weight_multi_face !== undefined ? parseInt(req.body.weight_multi_face) : 1;
        const weight_leaving_room = req.body.weight_leaving_room !== undefined ? parseInt(req.body.weight_leaving_room) : 1;
        
        const require_extension = req.body.require_extension !== undefined ? !!req.body.require_extension : !!(
            record_web_traffic || disable_new_tabs || close_open_tabs || 
            disable_extensions || prevent_incognito || clear_cache || 
            block_mobile
        );

        // Retrieve old quiz URL to handle changes
        const oldResult = await pool.query(
            'SELECT canvas_quiz_url FROM exams WHERE id = $1 AND (canvas_course_id = $2 OR canvas_course_id = $3)',
            [id, canvasCourseId, alternativeCourseId || '']
        );

        const result = await pool.query(`
            UPDATE exams SET 
                title = $1, canvas_quiz_url = $2, exam_code = $3, max_attempts = $4,
                require_camera = $5, require_mic = $6, require_screen = $7,
                disable_right_click = $8, require_fullscreen = $9, require_seb = $10,
                max_violations = $11, canvas_quiz_password = $12, 
                disable_clipboard = $13, disable_printing = $14,
                only_one_screen = $15, block_downloads = $16, prevent_reentry = $17,
                record_web_traffic = $18, disable_new_tabs = $19, close_open_tabs = $20,
                disable_extensions = $21, prevent_incognito = $22, clear_cache = $23,
                advanced_program_detection = $24, advanced_vm_detection = $25,
                advanced_hardware_detection = $26, allow_apps = $27, block_mobile = $28,
                require_extension = $29, require_companion_app = $30, allowed_apps = $31, blocked_apps = $32,
                allowed_urls = $33, require_room_scan = $34, additional_instructions = $35, 
                require_mobile_camera = $36,
                verify_video = $37, verify_audio = $38, verify_desktop = $39, verify_id = $40, verify_signature = $41,
                allow_calculator = $42, allow_whiteboard = $43, behavior_preset = $44,
                weight_navigating_away = $45, weight_keystrokes = $46, weight_copy_paste = $47, weight_browser_resize = $48,
                weight_head_movement = $49, weight_multi_face = $50, weight_leaving_room = $51,
                updated_at = NOW()
            WHERE id = $52 AND (canvas_course_id = $53 OR canvas_course_id = $54)
            RETURNING *
        `, [
            title, canvas_quiz_url, exam_code, max_attempts,
            require_camera, require_mic, require_screen,
            disable_right_click, require_fullscreen, require_seb,
            max_violations || 0, canvas_quiz_password || '', 
            disable_clipboard || false, disable_printing || false,
            only_one_screen || false, block_downloads || false, prevent_reentry || false,
            record_web_traffic, disable_new_tabs, close_open_tabs,
            disable_extensions, prevent_incognito, clear_cache,
            advanced_program_detection, advanced_vm_detection,
            advanced_hardware_detection, allow_apps, block_mobile,
            require_extension, require_companion_app, allowed_apps, blocked_apps, allowed_urls, 
            require_room_scan || false, additional_instructions, require_mobile_camera || false,
            verify_video, verify_audio, verify_desktop, verify_id, verify_signature,
            allow_calculator, allow_whiteboard, behavior_preset,
            weight_navigating_away, weight_keystrokes, weight_copy_paste, weight_browser_resize,
            weight_head_movement, weight_multi_face, weight_leaving_room,
            id, canvasCourseId, alternativeCourseId || ''
        ]);

        if (result.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });

        // Update Canvas settings (results lockdown stays off)
        if (canvas_quiz_url) {
            setCanvasQuizProctorMode(req.session.lti, canvas_quiz_url, true);
            
            // If the quiz URL changed, disable it on the previous quiz
            if (oldResult.rows.length > 0 && oldResult.rows[0].canvas_quiz_url !== canvas_quiz_url) {
                setCanvasQuizProctorMode(req.session.lti, oldResult.rows[0].canvas_quiz_url, false);
            }
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Helper to verify student exam access & handle resumption / prevent_reentry
async function verifyStudentExamAccess(exam, userId, ltiSession) {
    if (!exam.is_open) {
        throw new Error('This exam is currently closed by the instructor.');
    }
    
    // Check latest session status for resumption
    const latestSessionQuery = await pool.query(
        'SELECT * FROM exam_sessions WHERE exam_id = $1 AND student_canvas_id = $2 ORDER BY id DESC LIMIT 1', 
        [exam.id, userId]
    );
    const latestSession = latestSessionQuery.rows[0];
    let isResuming = false;
    
    if (latestSession) {
        if (latestSession.status === 'started') {
            isResuming = true;
        } else if (latestSession.status === 'unexpected') {
            if (exam.prevent_reentry) {
                const err = new Error('This exam does not allow re-entry. Since you closed, refreshed, or navigated away from the exam, you cannot resume it.');
                err.prevent_reentry_blocked = true;
                throw err;
            } else {
                isResuming = true;
            }
        }
    }

    // Sync allowed_attempts count from Canvas API if token is available
    let canvasMaxAttempts = exam.max_attempts;
    if (ltiSession) {
        try {
            const credentials = await getCanvasCredentials(ltiSession);
            if (credentials && credentials.canvas_api_token) {
                const match = exam.canvas_quiz_url ? exam.canvas_quiz_url.match(/\/quizzes\/(\d+)/) : null;
                const canvasQuizId = match ? match[1] : null;
                if (canvasQuizId) {
                    const courseId = ltiSession.alternativeCourseId || ltiSession.canvasCourseId || '1';
                    const fetchRes = await fetch(`${credentials.canvas_api_url}/courses/${courseId}/quizzes/${canvasQuizId}`, {
                        headers: { Authorization: `Bearer ${credentials.canvas_api_token}` }
                    });
                    if (fetchRes.ok) {
                        const quizData = await fetchRes.json();
                        if (quizData && typeof quizData.allowed_attempts !== 'undefined') {
                            canvasMaxAttempts = quizData.allowed_attempts;
                            // update DB to stay in sync
                            await pool.query('UPDATE exams SET max_attempts = $1 WHERE id = $2', [canvasMaxAttempts, exam.id]);
                            console.log(`[Sync Attempts] Successfully synced max_attempts = ${canvasMaxAttempts} for exam ID ${exam.id}`);
                        }
                    }
                }
            }
        } catch (syncErr) {
            console.warn('[Sync Attempts] Failed to sync quiz attempts from Canvas API:', syncErr.message);
        }
    }

    const sessionCountQuery = await pool.query(
        'SELECT COUNT(*) as attempt_count FROM exam_sessions WHERE exam_id = $1 AND student_canvas_id = $2', 
        [exam.id, userId]
    );
    const attemptCount = parseInt(sessionCountQuery.rows[0].attempt_count, 10);
    
    const overrideQuery = await pool.query(
        'SELECT extra_attempts FROM exam_overrides WHERE exam_id = $1 AND student_canvas_id = $2', 
        [exam.id, userId]
    );
    const extraAttempts = overrideQuery.rows.length > 0 ? parseInt(overrideQuery.rows[0].extra_attempts, 10) : 0;
    
    const totalAllowed = (canvasMaxAttempts === -1 || canvasMaxAttempts === null) ? Infinity : ((canvasMaxAttempts || 1) + extraAttempts);
    
    if (attemptCount >= totalAllowed && !isResuming) {
        const isCompleted = latestSession && (latestSession.status === 'completed' || latestSession.status === 'booted' || latestSession.status === 'abandoned');
        const err = new Error(`You have reached the maximum allowable attempts (${totalAllowed === Infinity ? 'Unlimited' : totalAllowed}) for this exam.`);
        err.already_completed = isCompleted;
        throw err;
    }

    const crypto = require('crypto');
    const auto_login_user_id = userId;
    const auto_login_expires = Math.floor(Date.now() / 1000) + 300; // 5 minutes validity
    const secret = AUTO_LOGIN_SIGNING_SECRET;
    const signData = `auto_login_user_id=${auto_login_user_id}&expires=${auto_login_expires}`;
    const auto_login_signature = crypto.createHmac('sha256', secret).update(signData).digest('hex');

    return {
        ...exam,
        auto_login_user_id,
        auto_login_expires,
        auto_login_signature,
        // Canvas's own quizzes_controller.rb (self-hosted, patched) checks this exact
        // param to bypass its native require_lockdown_browser gate on /take page loads
        // that come from us. Without it, Canvas re-triggers its own LDB redirect on
        // every iframe load of the quiz, colliding with our own launch flow in a loop.
        secure_proctor_secret: CANVAS_LAUNCH_SECRET
    };
}

// API: Get Exam details (For Student entering / pre-flight)
app.post('/api/exams/verify-code', requireAuth, async (req, res) => {
    try {
        const { canvasCourseId, alternativeCourseId, userId } = req.session.lti;
        const { exam_code } = req.body;
        
        const examResult = await pool.query('SELECT * FROM exams WHERE (canvas_course_id = $1 OR canvas_course_id = $2) AND exam_code = $3', [canvasCourseId, alternativeCourseId || '', exam_code]);
        if (examResult.rows.length === 0) return res.status(404).json({ error: 'Invalid exam code' });
        
        const exam = examResult.rows[0];
        const result = await verifyStudentExamAccess(exam, userId, req.session.lti);
        res.json(result);
    } catch (err) {
        let canvas_quiz_url = '';
        try {
            const { exam_code } = req.body;
            const { canvasCourseId, alternativeCourseId } = req.session.lti;
            const examResult = await pool.query('SELECT canvas_quiz_url FROM exams WHERE (canvas_course_id = $1 OR canvas_course_id = $2) AND exam_code = $3', [canvasCourseId, alternativeCourseId || '', exam_code]);
            if (examResult.rows.length > 0) canvas_quiz_url = examResult.rows[0].canvas_quiz_url;
        } catch (e) {}

        if (err.prevent_reentry_blocked) {
            return res.status(403).json({ error: err.message, prevent_reentry_blocked: true, canvas_quiz_url });
        }
        if (err.already_completed !== undefined) {
            return res.status(403).json({ error: err.message, already_completed: err.already_completed, canvas_quiz_url });
        }
        res.status(500).json({ error: err.message });
    }
});

// API: Verify and Authorize placement-based launch directly
app.post('/api/exams/verify-placement', requireAuth, async (req, res) => {
    try {
        const { canvasCourseId, userId } = req.session.lti;
        const { placement_id, exam_id } = req.body;
        
        let targetExamId = exam_id;
        if (!targetExamId && placement_id) {
            const placementResult = await pool.query('SELECT exam_id FROM exam_placements WHERE resource_link_id = $1', [placement_id]);
            if (placementResult.rows.length > 0) {
                targetExamId = placementResult.rows[0].exam_id;
            }
        }
        
        if (!targetExamId) {
            return res.status(404).json({ error: 'This Canvas placement is not configured yet. Please ask your instructor to link it to an exam.' });
        }
        
        const examResult = await pool.query('SELECT * FROM exams WHERE id = $1', [targetExamId]);
        if (examResult.rows.length === 0) return res.status(404).json({ error: 'Linked exam not found' });
        
        const exam = examResult.rows[0];
        const result = await verifyStudentExamAccess(exam, userId, req.session.lti);
        res.json(result);
    } catch (err) {
        let canvas_quiz_url = '';
        try {
            const { exam_id, placement_id } = req.body;
            let targetExamId = exam_id;
            if (!targetExamId && placement_id) {
                const placementResult = await pool.query('SELECT exam_id FROM exam_placements WHERE resource_link_id = $1', [placement_id]);
                if (placementResult.rows.length > 0) targetExamId = placementResult.rows[0].exam_id;
            }
            if (targetExamId) {
                const examResult = await pool.query('SELECT canvas_quiz_url FROM exams WHERE id = $1', [targetExamId]);
                if (examResult.rows.length > 0) canvas_quiz_url = examResult.rows[0].canvas_quiz_url;
            }
        } catch (e) {}

        if (err.prevent_reentry_blocked) {
            return res.status(403).json({ error: err.message, prevent_reentry_blocked: true, canvas_quiz_url });
        }
        if (err.already_completed !== undefined) {
            return res.status(403).json({ error: err.message, already_completed: err.already_completed, canvas_quiz_url });
        }
        res.status(500).json({ error: err.message });
    }
});

// API: Handle LTI ContentItemSelection signed return POST
app.get('/api/placements/lti-return', (req, res) => {
    pool.query('INSERT INTO api_debug_logs (endpoint, query_params, request_body) VALUES ($1, $2, $3)', [
        '/api/placements/lti-return',
        JSON.stringify(req.query),
        JSON.stringify(req.body)
    ]).catch(err => console.error('Failed to write api debug log:', err));

    const { content_item_return_url, exam_title, launch_url, lti_data } = req.query;
    if (!content_item_return_url) {
        return res.status(400).send('Missing content_item_return_url');
    }

    const consumerKey = process.env.LTI_KEY || 'proctor-lti-key';
    const consumerSecret = process.env.LTI_SECRET || 'proctor-lti-secret';

    const contentItems = {
        "@context": "http://purl.imsglobal.org/ctx/lti/v1/ContentItem",
        "@graph": [
            {
                "@type": "LtiLinkItem",
                "mediaType": "application/vnd.ims.lti.v1.ltilink",
                "url": launch_url,
                "title": exam_title,
                "text": exam_title,
                "placementAdvice": {
                    "presentationDocumentTarget": "iframe"
                }
            }
        ]
    };

    const params = {
        lti_message_type: 'ContentItemSelection',
        lti_version: 'LTI-1p0',
        content_items: JSON.stringify(contentItems),
        oauth_consumer_key: consumerKey,
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_nonce: crypto.randomBytes(16).toString('hex'),
        oauth_version: '1.0'
    };

    if (lti_data) {
        params.data = lti_data;
    }

    const signature = signLti1Response(content_item_return_url, params, consumerSecret);
    params.oauth_signature = signature;

    let formFields = '';
    for (let key in params) {
        const escapedVal = params[key].replace(/"/g, '&quot;');
        formFields += `<input type="hidden" name="${key}" value="${escapedVal}">\n`;
    }

    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Returning Content to Canvas...</title>
</head>
<body>
    <form id="lti-form" action="${content_item_return_url}" method="POST">
        ${formFields}
    </form>
    <script>
        document.getElementById('lti-form').submit();
    </script>
</body>
</html>
    `;
    res.send(html);
});

// API: Get active placement details
app.get('/api/placements/:resource_link_id', requireInstructor, async (req, res) => {
    try {
        const { resource_link_id } = req.params;
        const result = await pool.query('SELECT * FROM exam_placements WHERE resource_link_id = $1', [resource_link_id]);
        res.json(result.rows[0] || null);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Create or update placement mapping
app.post('/api/placements', requireInstructor, async (req, res) => {
    try {
        const { resource_link_id, exam_id } = req.body;
        const result = await pool.query(`
            INSERT INTO exam_placements (resource_link_id, exam_id)
            VALUES ($1, $2)
            ON CONFLICT (resource_link_id) 
            DO UPDATE SET exam_id = EXCLUDED.exam_id
            RETURNING *
        `, [resource_link_id, exam_id]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const crypto = require('crypto');

function signLti1Response(url, params, secret) {
    const consumerSecret = encodeURIComponent(secret) + '&';
    
    // Sort parameters
    const sortedKeys = Object.keys(params).sort();
    const parameterString = sortedKeys.map(key => {
        return `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`;
    }).join('&');
    
    const signatureBase = [
        'POST',
        encodeURIComponent(url),
        encodeURIComponent(parameterString)
    ].join('&');
    
    return crypto.createHmac('sha1', consumerSecret)
        .update(signatureBase)
        .digest('base64');
}

// API: Get Exam Session Status (used for blocker page polling)
app.get('/api/session/status', requireAuth, async (req, res) => {
    try {
        const token = req.query.token || (req.session.lti ? req.session.lti.sessionToken : null);
        if (!token) return res.status(400).json({ error: 'Missing session token' });

        const ltiResult = await pool.query('SELECT * FROM lti_sessions WHERE session_token = $1', [token]);
        if (ltiResult.rows.length === 0) return res.status(404).json({ error: 'LTI session not found' });
        const lti = ltiResult.rows[0];

        const examId = req.query.exam_id;
        let sessionResult = { rows: [] };
        if (lti.exam_session_id) {
            sessionResult = await pool.query('SELECT * FROM exam_sessions WHERE id = $1', [lti.exam_session_id]);
        }

        let quizUrl = '';
        const targetExamId = examId || (sessionResult.rows.length > 0 ? sessionResult.rows[0].exam_id : null);
        if (targetExamId) {
            const examResult = await pool.query('SELECT canvas_quiz_url FROM exams WHERE id = $1', [targetExamId]);
            quizUrl = examResult.rows.length > 0 ? examResult.rows[0].canvas_quiz_url : '';
        }

        if (sessionResult.rows.length === 0) {
            return res.json({ status: 'not_started', canvas_quiz_url: quizUrl });
        }

        res.json({ status: sessionResult.rows[0].status, canvas_quiz_url: quizUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Start Exam Session (Student)
app.post('/api/session/start', requireAuth, async (req, res) => {
    try {
        const { exam_id, verify_id_image, verify_signature_image, verify_signature_name } = req.body;
        const { userId, userName } = req.session.lti;

        // Check if there is an active/resumable session
        const latestSessionQuery = await pool.query(
            'SELECT * FROM exam_sessions WHERE exam_id = $1 AND student_canvas_id = $2 ORDER BY id DESC LIMIT 1',
            [exam_id, userId]
        );
        const latestSession = latestSessionQuery.rows[0];
        
        // Find if exam has prevent_reentry enabled
        const examResult = await pool.query('SELECT prevent_reentry FROM exams WHERE id = $1', [exam_id]);
        const exam = examResult.rows[0];
        const preventReentry = exam ? exam.prevent_reentry : false;

        let session;
        let next_chunk_index = 0;

        if (latestSession && (latestSession.status === 'started' || (latestSession.status === 'unexpected' && !preventReentry))) {
            // Resume the existing session
            session = latestSession;
            if (session.status === 'unexpected') {
                await pool.query("UPDATE exam_sessions SET status = 'started' WHERE id = $1", [session.id]);
                session.status = 'started';
            }
            
            // Determine next chunk index
            const chunkDir = path.join(os.tmpdir(), `chunks-${session.id}`);
            if (fs.existsSync(chunkDir)) {
                const files = fs.readdirSync(chunkDir);
                let maxIdx = -1;
                for (const file of files) {
                    const match = file.match(/^chunk-(\d+)\.dat$/);
                    if (match) {
                        const idx = parseInt(match[1], 10);
                        if (idx > maxIdx) maxIdx = idx;
                    }
                }
                if (maxIdx >= 0) {
                    next_chunk_index = maxIdx;
                }
            }
            console.log(`[Resume Session] Student ${userName} resuming session ${session.id}, next_chunk_index: ${next_chunk_index}`);
        } else {
            // Create a new session
            const countQuery = await pool.query('SELECT COUNT(*) as attempts FROM exam_sessions WHERE exam_id = $1 AND student_canvas_id = $2', [exam_id, userId]);
            const currentAttempts = parseInt(countQuery.rows[0].attempts, 10);
            const sessionResult = await pool.query(`
                INSERT INTO exam_sessions (exam_id, student_canvas_id, student_name, attempt_number, verify_id_image, verify_signature_image, verify_signature_name)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
            `, [exam_id, userId, userName, currentAttempts + 1, verify_id_image || null, verify_signature_image || null, verify_signature_name || null]);
            session = sessionResult.rows[0];
            console.log(`[New Session] Student ${userName} starting new session ${session.id}`);
        }

        if (session && req.session.lti && req.session.lti.sessionToken) {
            try {
                await pool.query(
                    'UPDATE lti_sessions SET exam_session_id = $1 WHERE session_token = $2',
                    [session.id, req.session.lti.sessionToken]
                );
                console.log(`[Link Session] Linked exam session ${session.id} to LTI session token ${req.session.lti.sessionToken}`);
            } catch (linkErr) {
                console.error('Failed to link exam session to LTI session:', linkErr);
            }
        }

        const crypto = require('crypto');
        const auto_login_user_id = userId;
        const auto_login_expires = Math.floor(Date.now() / 1000) + 300; // 5 minutes validity
        const secret = AUTO_LOGIN_SIGNING_SECRET;
        const signData = `auto_login_user_id=${auto_login_user_id}&expires=${auto_login_expires}`;
        const auto_login_signature = crypto.createHmac('sha256', secret).update(signData).digest('hex');

        res.json({
            ...session,
            next_chunk_index,
            auto_login_user_id,
            auto_login_expires,
            auto_login_signature
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Log Event (Tab switch, resize etc)
app.post('/api/session/log', requireAuth, async (req, res) => {
    try {
        const { exam_session_id, event_type, event_message } = req.body;
        await pool.query(`
            INSERT INTO proctor_logs (exam_session_id, event_type, event_message)
            VALUES ($1, $2, $3)
        `, [exam_session_id, event_type, event_message]);
        
        // Notify teacher via IO
        const examIdQuery = await pool.query('SELECT exam_id FROM exam_sessions WHERE id=$1', [exam_session_id]);
        if(examIdQuery.rows.length > 0) {
            io.to('teacher_' + examIdQuery.rows[0].exam_id).emit('proctor_log', {
                exam_session_id, event_type, event_message, timestamp: new Date()
            });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Log Event from Extension (bypasses LTI iframe parameters restriction)
app.post('/api/session/log-event-ext', requireAuth, async (req, res) => {
    try {
        const { event_type, event_message } = req.body;
        const userId = req.session.lti.userId;
        
        // Find active session
        const sessionRes = await pool.query(
            `SELECT id, exam_id FROM exam_sessions 
             WHERE student_canvas_id = $1 AND status = 'started' 
             ORDER BY id DESC LIMIT 1`, 
            [userId]
        );
        
        if (sessionRes.rows.length === 0) {
            return res.status(404).json({ error: 'No active session found' });
        }
        
        const exam_session_id = sessionRes.rows[0].id;
        const exam_id = sessionRes.rows[0].exam_id;
        
        await pool.query(`
            INSERT INTO proctor_logs (exam_session_id, event_type, event_message)
            VALUES ($1, $2, $3)
        `, [exam_session_id, event_type, event_message]);
        
        // Notify teacher via IO
        io.to('teacher_' + exam_id).emit('proctor_log', {
            exam_session_id, event_type, event_message, timestamp: new Date()
        });
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Log Web Traffic from Extension
app.post('/api/session/log-traffic', requireAuth, async (req, res) => {
    try {
        const { url } = req.body;
        const userId = req.session.lti.userId;
        
        // Find active session
        const sessionRes = await pool.query(
            `SELECT id, exam_id FROM exam_sessions 
             WHERE student_canvas_id = $1 AND status = 'started' 
             ORDER BY id DESC LIMIT 1`, 
            [userId]
        );
        
        if (sessionRes.rows.length === 0) {
            return res.status(404).json({ error: 'No active session found' });
        }
        
        const exam_session_id = sessionRes.rows[0].id;
        const exam_id = sessionRes.rows[0].exam_id;
        
        let domain = url;
        try {
            domain = new URL(url).hostname;
        } catch (e) {}
        
        const event_type = "Web Navigation";
        const event_message = `Visited website: ${domain} (Full URL: ${url})`;
        
        await pool.query(`
            INSERT INTO proctor_logs (exam_session_id, event_type, event_message)
            VALUES ($1, $2, $3)
        `, [exam_session_id, event_type, event_message]);
        
        // Notify teacher via IO
        io.to('teacher_' + exam_id).emit('proctor_log', {
            exam_session_id, event_type, event_message, timestamp: new Date()
        });
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper to assemble and upload video chunks in the background
async function assembleAndUploadSessionVideo(exam_session_id, total_chunks) {
    if (activeAssemblies.has(exam_session_id)) {
        console.log(`[Assemble] Assembly already in progress for session ${exam_session_id}. Aborting duplicate request.`);
        return;
    }
    activeAssemblies.add(exam_session_id);

    try {
        const chunkDir = path.join(os.tmpdir(), `chunks-${exam_session_id}`);
        
        // Wait up to 30s for all expected chunks to be written to disk
        if (total_chunks !== undefined && total_chunks !== null) {
            const expected = parseInt(total_chunks, 10);
            console.log(`[Assemble] Expecting ${expected} chunks for session ${exam_session_id}. Waiting for chunks...`);
            const startWait = Date.now();
            while (Date.now() - startWait < 30000) {
                if (fs.existsSync(chunkDir)) {
                    const files = fs.readdirSync(chunkDir);
                    if (files.length >= expected) {
                        console.log(`[Assemble] All ${expected} chunks are present on disk!`);
                        break;
                    }
                }
                await new Promise(r => setTimeout(r, 500));
            }
        }

        if (!fs.existsSync(chunkDir)) {
            console.log(`No local chunks found for session ${exam_session_id}`);
            return;
        }

        console.log(`Assembling video for session ${exam_session_id}...`);
        
        // Get all chunk files in order
        const files = fs.readdirSync(chunkDir).sort();
        if (files.length === 0) {
            console.log(`No chunk files in directory for session ${exam_session_id}`);
            return;
        }

        // Get student/exam info for nice filename and mime type
        const sessionInfo = await pool.query(`
            SELECT es.student_name, es.attempt_number, es.started_at, es.mime_type, e.title, e.require_mobile_camera 
            FROM exam_sessions es
            JOIN exams e ON es.exam_id = e.id
            WHERE es.id = $1
        `, [exam_session_id]);
        
        let studentName = 'student';
        let examTitle = 'exam';
        let attempt = 1;
        let startedAt = '';
        let studentNameRaw = 'student';
        let examTitleRaw = 'exam';
        let mimeTypeFromDb = 'video/webm';
        let sessionStartMs = 0;
        
        if (sessionInfo.rows.length > 0) {
            const s = sessionInfo.rows[0];
            studentNameRaw = s.student_name || 'student';
            examTitleRaw = s.title || 'exam';
            studentName = s.student_name ? s.student_name.replace(/[^a-z0-9]/gi, '_') : 'student';
            examTitle = s.title ? s.title.replace(/[^a-z0-9]/gi, '_') : 'exam';
            attempt = s.attempt_number || 1;
            startedAt = s.started_at ? new Date(s.started_at).toLocaleString('en-US', {
                timeZone: 'America/New_York',
                dateStyle: 'short',
                timeStyle: 'medium'
            }) + ' EST' : '';
            if (s.started_at) {
                sessionStartMs = new Date(s.started_at).getTime();
            }
            mimeTypeFromDb = s.mime_type || 'video/webm';
        }

        const isWebm = mimeTypeFromDb.includes('webm');
        const rawExt = isWebm ? 'webm' : 'mp4';
        const rawWebmPath = path.join(os.tmpdir(), `session-${exam_session_id}-raw.${rawExt}`);

        console.log(`[Assemble] Found ${files.length} chunk files in ${chunkDir}`);
        for (const file of files) {
            const filePath = path.join(chunkDir, file);
            const stats = fs.statSync(filePath);
            console.log(`[Assemble] Chunk file ${file} size: ${stats.size} bytes`);
        }

        const writeStream = fs.createWriteStream(rawWebmPath);

        for (const file of files) {
            const filePath = path.join(chunkDir, file);
            const data = fs.readFileSync(filePath);
            writeStream.write(data);
        }
        writeStream.end();

        // Wait for write to finish
        await new Promise((resolve) => writeStream.on('finish', resolve));

        const rawStats = fs.statSync(rawWebmPath);
        console.log(`[Assemble] Raw compiled video path: ${rawWebmPath}, total size: ${rawStats.size} bytes`);

        let tempOutFile = path.join(os.tmpdir(), `session-${exam_session_id}.${isWebm ? 'webm' : 'mp4'}`);
        let finalMimeType = mimeTypeFromDb;
        let finalExt = isWebm ? 'webm' : 'mp4';

        if (isWebm && process.env.TRANSCODE_TO_MP4 === 'true') {
            console.log(`[Assemble] TRANSCODE_TO_MP4 is enabled. Transcoding WebM to MP4 for session ${exam_session_id}...`);
            const mp4OutFile = path.join(os.tmpdir(), `session-${exam_session_id}.mp4`);
            try {
                await new Promise((resolve, reject) => {
                    const command = ffmpeg(rawWebmPath)
                        .outputOptions('-c:v libx264')
                        .outputOptions('-pix_fmt yuv420p')
                        .outputOptions('-preset ultrafast') // Use ultrafast preset to minimize CPU/RAM usage
                        .outputOptions('-crf 30')          // Lower quality/high compression to speed up transcoding
                        .outputOptions('-threads 2')        // Limit CPU threads to protect Canvas LMS resources
                        .outputOptions('-vsync vfr')
                        // The recorded WebM mixes a real-time mic track with a canvas video track
                        // throttled to a fixed fps — their clocks drift. Without correcting that
                        // drift, -vsync vfr can leave ffmpeg to stretch/compress the audio timeline
                        // to match, which is heard as pitch-shifted ("chipmunk"/slowed) audio.
                        .outputOptions('-af aresample=async=1000')
                        .outputOptions('-ar 44100')
                        .outputOptions('-c:a aac')
                        .on('start', (commandLine) => {
                            console.log(`Spawned FFmpeg with command: ${commandLine}`);
                        })
                        .on('end', () => {
                            clearTimeout(timeoutId);
                            resolve();
                        })
                        .on('error', (err) => {
                            clearTimeout(timeoutId);
                            reject(err);
                        });

                    const timeoutId = setTimeout(() => {
                        console.error(`Transcoding for session ${exam_session_id} timed out. Killing FFmpeg process.`);
                        command.kill('SIGKILL');
                    }, 120000); // 2 minutes

                    command.save(mp4OutFile);
                });
                console.log(`Successfully transcoded to MP4 for session ${exam_session_id}`);
                if (fs.existsSync(rawWebmPath)) fs.unlinkSync(rawWebmPath);
                tempOutFile = mp4OutFile;
                finalMimeType = 'video/mp4';
                finalExt = 'mp4';
            } catch (transcodeErr) {
                console.error(`Transcoding failed for session ${exam_session_id}, falling back to WebM:`, transcodeErr.message);
                tempOutFile = path.join(os.tmpdir(), `session-${exam_session_id}.webm`);
                fs.renameSync(rawWebmPath, tempOutFile);
                finalMimeType = 'video/webm';
                finalExt = 'webm';
            }
        } else {
            console.log(`[Assemble] Direct upload mode (no transcoding) for session ${exam_session_id}`);
            fs.renameSync(rawWebmPath, tempOutFile);
        }

        // Create dedicated attempt folder on Google Drive
        let attemptFolderId = null;
        try {
            const parentFolderId = await getFolderId();
            const folderName = `Proctor Report - ${examTitleRaw} - ${studentNameRaw} - Attempt #${attempt}`;
            console.log(`[Assemble] Creating Google Drive folder: "${folderName}"...`);
            attemptFolderId = await createFolder(folderName, parentFolderId);
            console.log(`[Assemble] Created folder successfully. Folder ID: ${attemptFolderId}`);
        } catch (folderErr) {
            console.error("[Assemble] Failed to create Google Drive folder, falling back to parent folder:", folderErr.message);
        }

        const finalTempFile = tempOutFile;
        const driveFileName = `${studentName}_${examTitle}_Session_${exam_session_id}_Attempt_${attempt}.${finalExt}`;

        console.log(`Uploading ${driveFileName} to Google Drive...`);
        const driveFileId = await uploadVideoToDrive(finalTempFile, driveFileName, finalMimeType, attemptFolderId);
        console.log(`Uploaded to Google Drive. File ID: ${driveFileId}`);

        // Check if there is an environment room scan video on disk and upload it
        let roomScanDriveFileId = null;
        const scanPath = path.join(os.tmpdir(), `roomscans`, `scan-${exam_session_id}.webm`);
        if (fs.existsSync(scanPath)) {
            const roomScanFileName = `${studentName}_${examTitle}_Session_${exam_session_id}_Attempt_${attempt}_RoomScan.webm`;
            console.log(`[Assemble] Found room scan on disk. Uploading ${roomScanFileName} to Google Drive...`);
            try {
                roomScanDriveFileId = await uploadVideoToDrive(scanPath, roomScanFileName, 'video/webm', attemptFolderId);
                console.log(`[Assemble] Uploaded room scan to Google Drive. File ID: ${roomScanDriveFileId}`);
                
                // Clean up the local room scan video file from /tmp
                fs.unlinkSync(scanPath);
            } catch (scanUpErr) {
                console.error("[Assemble] Failed to upload room scan to Google Drive:", scanUpErr.message);
            }
        }

        // Update database with Google Drive file ID and format
        let mobileDriveFileId = null;
        if (sessionInfo.rows.length > 0 && sessionInfo.rows[0].require_mobile_camera) {
            console.log(`[Assemble] Session requires mobile camera. Checking upload status...`);
            const startWait = Date.now();
            while (Date.now() - startWait < 90000) { // 90s timeout
                const status = mobileUploadStatus.get(exam_session_id);
                if (status && status.finished) {
                    console.log(`[Assemble] Mobile upload complete! Total chunks to compile: ${status.total}`);
                    break;
                }
                await new Promise(r => setTimeout(r, 1000));
            }

            const mobileChunkDir = path.join(os.tmpdir(), `chunks-mobile-${exam_session_id}`);
            if (fs.existsSync(mobileChunkDir)) {
                console.log(`[Assemble] Assembling mobile video for session ${exam_session_id}...`);
                const mobileFiles = fs.readdirSync(mobileChunkDir).sort();
                if (mobileFiles.length > 0) {
                    const rawMobilePath = path.join(os.tmpdir(), `session-${exam_session_id}-mobile-raw.${rawExt}`);
                    const mobileWriteStream = fs.createWriteStream(rawMobilePath);
                    for (const file of mobileFiles) {
                        const filePath = path.join(mobileChunkDir, file);
                        const data = fs.readFileSync(filePath);
                        mobileWriteStream.write(data);
                    }
                    mobileWriteStream.end();
                    await new Promise((resolve) => mobileWriteStream.on('finish', resolve));

                    let tempMobileOutFile = path.join(os.tmpdir(), `session-${exam_session_id}-mobile.${finalExt}`);
                    
                    if (isWebm && process.env.TRANSCODE_TO_MP4 === 'true') {
                        console.log(`[Assemble] Transcoding WebM to MP4 for secondary mobile video...`);
                        const mp4MobileOut = path.join(os.tmpdir(), `session-${exam_session_id}-mobile.mp4`);
                        try {
                            await new Promise((resolve, reject) => {
                                const command = ffmpeg(rawMobilePath)
                                    .outputOptions('-c:v libx264')
                                    .outputOptions('-pix_fmt yuv420p')
                                    .outputOptions('-preset ultrafast')
                                    .outputOptions('-crf 30')
                                    .outputOptions('-threads 2')
                                    .outputOptions('-vsync vfr')
                                    .outputOptions('-c:a aac')
                                    .on('end', () => {
                                        clearTimeout(timeoutId);
                                        resolve();
                                    })
                                    .on('error', (err) => {
                                        clearTimeout(timeoutId);
                                        reject(err);
                                    });
                                const timeoutId = setTimeout(() => {
                                    command.kill('SIGKILL');
                                    reject(new Error("Transcode timeout"));
                                }, 120000);
                                command.save(mp4MobileOut);
                            });
                            tempMobileOutFile = mp4MobileOut;
                            if (fs.existsSync(rawMobilePath)) fs.unlinkSync(rawMobilePath);
                        } catch(transErr) {
                            console.error("Mobile transcode failed, falling back:", transErr);
                            tempMobileOutFile = path.join(os.tmpdir(), `session-${exam_session_id}-mobile.webm`);
                            fs.renameSync(rawMobilePath, tempMobileOutFile);
                        }
                    } else {
                        fs.renameSync(rawMobilePath, tempMobileOutFile);
                    }

                    const driveMobileFileName = `${studentName}_${examTitle}_Session_${exam_session_id}_Attempt_${attempt}_Secondary.${finalExt}`;
                    console.log(`Uploading secondary mobile video ${driveMobileFileName} to Google Drive...`);
                    try {
                        mobileDriveFileId = await uploadVideoToDrive(tempMobileOutFile, driveMobileFileName, finalMimeType, attemptFolderId);
                        console.log(`Uploaded secondary mobile video. File ID: ${mobileDriveFileId}`);
                    } catch(upErr) {
                        console.error("Failed to upload secondary mobile video:", upErr);
                    }

                    // Clean up temp mobile out file and dir
                    try { if (fs.existsSync(tempMobileOutFile)) fs.unlinkSync(tempMobileOutFile); } catch(e){}
                    try {
                        const files = fs.readdirSync(mobileChunkDir);
                        for (const file of files) {
                            fs.unlinkSync(path.join(mobileChunkDir, file));
                        }
                        fs.rmdirSync(mobileChunkDir);
                    } catch(e){}
                }
            }
        }

        // Update database with Google Drive file ID and format
        await pool.query('UPDATE exam_sessions SET drive_file_id = $1, mime_type = $2, mobile_drive_file_id = $3, room_scan_drive_file_id = $4 WHERE id = $5', [driveFileId, finalMimeType, mobileDriveFileId, roomScanDriveFileId, exam_session_id]);

        // Upload Security logs to Google Drive as a Google Doc
        try {
            console.log(`Generating proctor logs Google Doc for session ${exam_session_id}...`);
            const logsQuery = await pool.query(`
                SELECT event_type, event_message, event_timestamp 
                FROM proctor_logs 
                WHERE exam_session_id = $1 
                ORDER BY event_timestamp ASC
            `, [exam_session_id]);

            const formatDuration = (ms) => {
                if (isNaN(ms) || ms < 0) ms = 0;
                const totalSeconds = Math.floor(ms / 1000);
                const hours = Math.floor(totalSeconds / 3600);
                const minutes = Math.floor((totalSeconds % 3600) / 60);
                const seconds = totalSeconds % 60;
                const pad = (num) => String(num).padStart(2, '0');
                if (hours > 0) {
                    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
                }
                return `${minutes}:${pad(seconds)}`;
            };

            let logRowsHtml = '';
            for (const row of logsQuery.rows) {
                let timestampStr = '';
                let videoMarker = '0:00';
                if (row.event_timestamp) {
                    const rowDate = new Date(row.event_timestamp);
                    timestampStr = rowDate.toLocaleTimeString('en-US', {
                        timeZone: 'America/New_York',
                        hour: 'numeric',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: true
                    }) + ' EST';

                    if (sessionStartMs) {
                        const offsetMs = rowDate.getTime() - sessionStartMs;
                        videoMarker = formatDuration(offsetMs);
                    }
                }
                const type = row.event_type || '';
                const msg = row.event_message || '';
                const typeClass = (type.toLowerCase() === 'error' || type.toLowerCase() === 'failed') ? 'class="error"' : (type.toLowerCase().includes('violation') || type.toLowerCase().includes('warning') ? 'class="warning"' : '');
                
                logRowsHtml += `<tr>
                    <td>${timestampStr}</td>
                    <td>${videoMarker}</td>
                    <td ${typeClass}>${type.toUpperCase()}</td>
                    <td>${msg}</td>
                </tr>`;
            }

            const reportGeneratedEST = new Date().toLocaleString('en-US', {
                timeZone: 'America/New_York',
                dateStyle: 'short',
                timeStyle: 'medium'
            }) + ' EST';

            const logsDocHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; line-height: 1.5; color: #333; }
  h1 { color: #1e3a8a; border-bottom: 2px solid #1e3a8a; padding-bottom: 5px; }
  .metadata { background: #f3f4f6; padding: 12px; border-radius: 6px; margin-bottom: 20px; }
  .metadata p { margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 15px; }
  th, td { padding: 8px 10px; border: 1px solid #cbd5e1; text-align: left; }
  th { background: #f1f5f9; font-weight: bold; }
  .error { color: #dc2626; font-weight: bold; }
  .warning { color: #d97706; font-weight: bold; }
</style>
</head>
<body>
  <h1>Security & Activity Timeline</h1>
  <div class="metadata">
    <p><strong>Student Name:</strong> ${studentNameRaw}</p>
    <p><strong>Exam Title:</strong> ${examTitleRaw}</p>
    <p><strong>Attempt Number:</strong> ${attempt}</p>
    <p><strong>Session ID:</strong> ${exam_session_id}</p>
    <p><strong>Started At:</strong> ${startedAt}</p>
    <p><strong>Report Generated:</strong> ${reportGeneratedEST}</p>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width: 25%;">Timestamp (EST)</th>
        <th style="width: 15%;">Video Marker</th>
        <th style="width: 15%;">Event Type</th>
        <th style="width: 45%;">Message</th>
      </tr>
    </thead>
    <tbody>
      ${logRowsHtml || '<tr><td colspan="4" style="text-align:center;">No logs found for this session.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

            const driveDocName = `${studentName}_${examTitle}_Session_${exam_session_id}_Attempt_${attempt}_Logs`;
            const docFileId = await uploadLogsToDriveDoc(logsDocHtml, driveDocName, attemptFolderId);
            console.log(`Logs Google Doc uploaded successfully. File ID: ${docFileId}`);
        } catch (docErr) {
            console.error(`Failed to upload logs Google Doc for session ${exam_session_id}:`, docErr.message);
        }

        // Clean up temporary files securely
        try {
            if (fs.existsSync(tempOutFile)) fs.unlinkSync(tempOutFile);
        } catch (cleanupErr) {
            console.error(`Failed to clean up temp out file for session ${exam_session_id}:`, cleanupErr.message);
        }
        try {
            fs.rmSync(chunkDir, { recursive: true, force: true });
        } catch (cleanupErr) {
            console.error(`Failed to clean up chunk directory for session ${exam_session_id}:`, cleanupErr.message);
        }
        console.log(`Cleaned up temp files for session ${exam_session_id}`);

    } catch (err) {
        console.error(`Failed to assemble and upload video for session ${exam_session_id}:`, err);
        try {
            await pool.query(
                'INSERT INTO proctor_logs (exam_session_id, event_type, event_message) VALUES ($1, $2, $3)',
                [exam_session_id, 'error', `Video Assembly/Upload failed: ${err.message}`]
            );
        } catch (dbErr) {
            console.error('Failed to log error to database:', dbErr);
        }
    } finally {
        activeAssemblies.delete(exam_session_id);
        mobileUploadStatus.delete(exam_session_id);
    }
}

// API: End Exam Session
app.post('/api/session/end', requireAuth, async (req, res) => {
    try {
        const { exam_session_id, status, total_chunks, exit_type } = req.body;
        if (exit_type === 'unexpected') {
            console.log(`[End Session] Unexpected exit for session ${exam_session_id}`);
            await pool.query("UPDATE exam_sessions SET status = 'unexpected' WHERE id = $1", [exam_session_id]);
            
            const examIdQuery = await pool.query('SELECT exam_id FROM exam_sessions WHERE id=$1', [exam_session_id]);
            if (examIdQuery.rows.length > 0) {
                io.to('teacher_' + examIdQuery.rows[0].exam_id).emit('student_status', { 
                    session_id: exam_session_id, status: 'unexpected' 
                });
            }
            return res.json({ success: true });
        }

        const finalStatus = status || 'completed';
        console.log(`[End Session] Ending session ${exam_session_id} with status: ${finalStatus}, total_chunks expected: ${total_chunks}`);
        await pool.query('UPDATE exam_sessions SET status=$1 WHERE id=$2', [finalStatus, exam_session_id]);
        
        const examIdQuery = await pool.query('SELECT exam_id FROM exam_sessions WHERE id=$1', [exam_session_id]);
        if(examIdQuery.rows.length > 0) {
            io.to('teacher_' + examIdQuery.rows[0].exam_id).emit('student_status', { 
                session_id: exam_session_id, status: finalStatus 
            });
        }

        // Notify mobile phone to stop recording
        const sessionLtiQuery = await pool.query('SELECT session_token FROM lti_sessions WHERE exam_session_id = $1', [exam_session_id]);
        if (sessionLtiQuery.rows.length > 0) {
            io.to('lti_' + sessionLtiQuery.rows[0].session_token).emit('mobile_stop_record');
        }

        // Trigger assembly and upload in background
        console.log(`[End Session] Triggering assembleAndUploadSessionVideo for session ${exam_session_id} with total_chunks: ${total_chunks}`);
        assembleAndUploadSessionVideo(exam_session_id, total_chunks);

        res.json({ success: true });
    } catch(err) {
        console.error('[End Session] Error ending session:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: External Submit notification from Canvas page (e.g. for iPad/iPhone fallback tab)
app.post('/api/session/external-submit', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Missing token' });

        const ltiResult = await pool.query('SELECT canvas_user_id FROM lti_sessions WHERE session_token = $1', [token]);
        if (ltiResult.rows.length > 0) {
            const userId = ltiResult.rows[0].canvas_user_id;
            
            const sessionQuery = await pool.query(
                "UPDATE exam_sessions SET status = 'completed' WHERE student_canvas_id = $1 AND (status = 'started' OR status = 'unexpected') RETURNING id, exam_id",
                [userId]
            );
            
            if (sessionQuery.rows.length > 0) {
                const session = sessionQuery.rows[0];
                console.log(`[External Submit] Session ${session.id} finalized successfully via external ping.`);
                
                io.to('teacher_' + session.exam_id).emit('student_status', { 
                    session_id: session.id, status: 'completed' 
                });
                
                assembleAndUploadSessionVideo(session.id);
            }
        }
        res.json({ success: true });
    } catch(err) {
        console.error('[External Submit] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Upload Mobile Video Chunk
app.post('/api/session/upload-mobile-chunk', async (req, res) => {
    const { chunk_index, token, base64_video } = req.body;
    try {
        if (!base64_video) throw new Error("Video payload was empty");
        
        const ltiResult = await pool.query('SELECT exam_session_id FROM lti_sessions WHERE session_token = $1', [token]);
        if (ltiResult.rows.length === 0 || !ltiResult.rows[0].exam_session_id) {
            throw new Error("No active exam session found for this token");
        }
        const exam_session_id = ltiResult.rows[0].exam_session_id;
        
        console.log(`[Upload Mobile Chunk] Received mobile chunk #${chunk_index} for session ${exam_session_id}`);
        
        const chunkDir = path.join(os.tmpdir(), `chunks-mobile-${exam_session_id}`);
        if (!fs.existsSync(chunkDir)) {
            fs.mkdirSync(chunkDir, { recursive: true });
        }
        
        const chunkPath = path.join(chunkDir, `chunk-${String(chunk_index).padStart(5, '0')}.dat`);
        const pureB64 = base64_video.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
        fs.writeFileSync(chunkPath, pureB64, 'base64');
        
        res.json({ success: true });
    } catch (err) {
        console.error('[Upload Mobile Chunk] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Receive Mobile Upload Complete Notification
app.post('/api/session/mobile-upload-complete', async (req, res) => {
    const { token, total_chunks } = req.body;
    try {
        const ltiResult = await pool.query('SELECT exam_session_id FROM lti_sessions WHERE session_token = $1', [token]);
        if (ltiResult.rows.length > 0 && ltiResult.rows[0].exam_session_id) {
            const exam_session_id = ltiResult.rows[0].exam_session_id;
            console.log(`[Mobile Complete] Mobile upload completed for session ${exam_session_id}. Total chunks: ${total_chunks}`);
            mobileUploadStatus.set(exam_session_id, { total: total_chunks, finished: true });
        }
        res.json({ success: true });
    } catch(err) {
        console.error('[Mobile Complete] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Upload Video Chunk directly via JSON payload to Bypass Form Boundaries
app.post('/api/session/upload-chunk', requireAuth, async (req, res) => {
    const { chunk_index, exam_session_id, base64_video } = req.body;
    try {
        if (!base64_video) throw new Error("Video payload was empty");
        console.log(`[Upload Chunk] Received chunk #${chunk_index} for session ${exam_session_id} (length: ${base64_video.length}), value preview: ${JSON.stringify(base64_video)}`);
        
        // Write chunk data to local temporary directory instead of DB
        const chunkDir = path.join(os.tmpdir(), `chunks-${exam_session_id}`);
        if (!fs.existsSync(chunkDir)) {
            fs.mkdirSync(chunkDir, { recursive: true });
            console.log(`[Upload Chunk] Created temporary chunk directory: ${chunkDir}`);
        }
        
        const chunkPath = path.join(chunkDir, `chunk-${String(chunk_index).padStart(5, '0')}.dat`);
        const pureB64 = base64_video.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
        fs.writeFileSync(chunkPath, pureB64, 'base64');
        console.log(`[Upload Chunk] Saved chunk #${chunk_index} to: ${chunkPath}`);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Upload Error', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Record the chosen MIME type for the session
app.patch('/api/session/:id/format', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { mime_type } = req.body;
        await pool.query('UPDATE exam_sessions SET mime_type = $1 WHERE id = $2', [mime_type || 'video/webm', id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Get Video Chunks for Playback (Binary Stream)
app.get('/api/session/video-playback/:session_id', requireInstructorOrExtensionToken, async (req, res) => {
    try {
        const { session_id } = req.params;
        const sessionInfo = (await pool.query('SELECT mime_type, drive_file_id FROM exam_sessions WHERE id = $1', [session_id])).rows[0];
        const mimeToUse = (sessionInfo && sessionInfo.mime_type) ? sessionInfo.mime_type : 'video/webm';
        
        let masterBuffer;
        if (sessionInfo && sessionInfo.drive_file_id) {
            // Fetch from Google Drive
            console.log(`Streaming video from Google Drive file: ${sessionInfo.drive_file_id}`);
            const driveStream = await downloadVideoFromDrive(sessionInfo.drive_file_id);
            const chunks = [];
            for await (const chunk of driveStream) {
                chunks.push(chunk);
            }
            masterBuffer = Buffer.concat(chunks);
        } else {
            // Legacy fallback to database
            const chunkResults = await pool.query(`
                SELECT video_data FROM video_chunks 
                WHERE exam_session_id = $1 
                ORDER BY chunk_index ASC
            `, [session_id]);
            
            if (chunkResults.rows.length === 0) {
                return res.status(404).json({ error: 'No video chunks found' });
            }

            const binaryChunks = [];
            for(let row of chunkResults.rows) {
                // Strip the Data URL prefix and whitespace
                const pureB64 = row.video_data.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
                binaryChunks.push(Buffer.from(pureB64, 'base64'));
            }
            masterBuffer = Buffer.concat(binaryChunks);
        }
        
        const cleanMime = mimeToUse.split(';')[0];
        
        // Support HTTP Range requests for full seekability (fast forward/rewind) in HTML5 video elements
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : masterBuffer.length - 1;
            const chunksize = (end - start) + 1;
            const file = masterBuffer.slice(start, end + 1);
            
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${masterBuffer.length}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': cleanMime
            });
            res.end(file);
        } else {
            res.setHeader('Content-Type', cleanMime);
            res.setHeader('Content-Length', masterBuffer.length);
            res.setHeader('Accept-Ranges', 'bytes');
            res.send(masterBuffer);
        }
    } catch (err) {
        console.error('Playback Error', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Get Mobile Video for Playback (Binary Stream)
app.get('/api/session/mobile-video-playback/:session_id', requireInstructorOrExtensionToken, async (req, res) => {
    try {
        const { session_id } = req.params;
        const sessionInfo = (await pool.query('SELECT mime_type, mobile_drive_file_id FROM exam_sessions WHERE id = $1', [session_id])).rows[0];
        
        if (!sessionInfo || !sessionInfo.mobile_drive_file_id) {
            return res.status(404).json({ error: 'No mobile video found for this session' });
        }
        
        const mimeToUse = sessionInfo.mime_type || 'video/webm';
        console.log(`Streaming mobile video from Google Drive file: ${sessionInfo.mobile_drive_file_id}`);
        const driveStream = await downloadVideoFromDrive(sessionInfo.mobile_drive_file_id);
        const chunks = [];
        for await (const chunk of driveStream) {
            chunks.push(chunk);
        }
        const masterBuffer = Buffer.concat(chunks);
        const cleanMime = mimeToUse.split(';')[0];
        
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : masterBuffer.length - 1;
            const chunksize = (end - start) + 1;
            const file = masterBuffer.slice(start, end + 1);
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${masterBuffer.length}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': cleanMime,
            });
            res.end(file);
        } else {
            res.setHeader('Content-Type', cleanMime);
            res.setHeader('Content-Length', masterBuffer.length);
            res.setHeader('Accept-Ranges', 'bytes');
            res.send(masterBuffer);
        }
    } catch (err) {
        console.error('Mobile Playback Error', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Database Status / Capacity Check
app.get('/api/db-status', requireInstructor, async (req, res) => {
    try {
        // Evaluate the raw byte footprint of the total uploaded sequence
        const result = await pool.query(`SELECT pg_total_relation_size('video_chunks') AS size_bytes`);
        res.json({ used_bytes: parseInt(result.rows[0].size_bytes || 0) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Redirect to Google Drive Vault folder
app.get('/api/exams/drive-folder', requireInstructor, async (req, res) => {
    try {
        const folderId = await getFolderId();
        res.redirect(`https://drive.google.com/drive/folders/${folderId}`);
    } catch (err) {
        console.error('Failed to get Drive folder ID:', err.message);
        res.status(500).send(`Failed to access Google Drive folder: ${err.message}`);
    }
});

// API: Delete specific attempt/session
app.delete('/api/sessions/:id', requireInstructor, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM exam_sessions WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Get Exam Report (Teacher)
app.get('/api/exams/:exam_id/reports', requireInstructor, async (req, res) => {
    try {
        const { exam_id } = req.params;
        const { canvasCourseId } = req.session.lti;
        
        const sessions = await pool.query('SELECT id, exam_id, student_canvas_id, student_name, status, started_at, attempt_number, video_archived, drive_file_id, mobile_drive_file_id FROM exam_sessions WHERE exam_id = $1', [exam_id]);
        const logs = await pool.query(`
            SELECT pl.* FROM proctor_logs pl 
            JOIN exam_sessions es ON pl.exam_session_id = es.id 
            WHERE es.exam_id = $1 ORDER BY pl.event_timestamp DESC
        `, [exam_id]);
        
        // Get unique attempted student count
        const attemptedResult = await pool.query(`
            SELECT COUNT(DISTINCT student_canvas_id) as attempted_count 
            FROM exam_sessions 
            WHERE exam_id = $1
        `, [exam_id]);
        const attemptedCount = parseInt(attemptedResult.rows[0].attempted_count || 0, 10);
        
        // Get enrolled student count (unique student_canvas_id or canvas_user_id that launched this course)
        const enrolledResult = await pool.query(`
            SELECT COUNT(DISTINCT canvas_user_id) as enrolled_count 
            FROM lti_sessions 
            WHERE (canvas_course_id = $1 OR alternative_canvas_course_id = $1) AND user_role = 'student'
        `, [canvasCourseId]);
        const enrolledCount = Math.max(
            parseInt(enrolledResult.rows[0].enrolled_count || 0, 10),
            attemptedCount
        );
        
        const reportResult = await pool.query('SELECT * FROM session_annotations WHERE exam_session_id IN (SELECT id FROM exam_sessions WHERE exam_id = $1)', [exam_id]);
        
        const report = sessions.rows.map(s => {
            return {
                ...s,
                logs: logs.rows.filter(l => l.exam_session_id === s.id),
                annotations: reportResult.rows.filter(a => a.exam_session_id === s.id)
            };
        });
        
        res.json({
            sessions: report,
            enrolled_count: enrolledCount
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Get Session Annotations
app.get('/api/session/:session_id/annotations', requireInstructor, async (req, res) => {
    try {
        const { session_id } = req.params;
        const result = await pool.query('SELECT * FROM session_annotations WHERE exam_session_id = $1 ORDER BY timestamp_seconds ASC', [session_id]);
        res.json({ annotations: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Add Session Annotation
app.post('/api/session/:session_id/annotations', requireInstructor, async (req, res) => {
    try {
        const { session_id } = req.params;
        const { timestamp_seconds, note } = req.body;
        const result = await pool.query(
            'INSERT INTO session_annotations (exam_session_id, timestamp_seconds, note) VALUES ($1, $2, $3) RETURNING *',
            [session_id, parseInt(timestamp_seconds, 10) || 0, note || '']
        );
        res.json({ success: true, annotation: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Delete Session Annotation
app.delete('/api/session/:session_id/annotations/:annotation_id', requireInstructor, async (req, res) => {
    try {
        const { annotation_id } = req.params;
        await pool.query('DELETE FROM session_annotations WHERE id = $1', [annotation_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper to set/update Boolean key in plist XML string
function setPlistBooleanKey(plistStr, keyName, value) {
    const regex = new RegExp(`(<key>${keyName}</key>\\s*)(<true\\/>|<false\\/>)`);
    const valTag = value ? '<true/>' : '<false/>';
    if (regex.test(plistStr)) {
        return plistStr.replace(regex, `$1${valTag}`);
    } else {
        // Append right before the closing dict tag
        return plistStr.replace(/(<\/dict>\s*<\/plist>\s*$)/, `\t<key>${keyName}</key>\n\t${valTag}\n$1`);
    }
}

// API: Generate Dynamic SEB Config
app.get('/api/seb/config/:token/:filename?', async (req, res) => {
    const { token } = req.params;
    try {
        // Verify token exists (basic sanity check)
        const result = await pool.query('SELECT * FROM lti_sessions WHERE session_token = $1', [token]);
        if (result.rows.length === 0) return res.status(404).send('Invalid or expired session');

        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        const exam_code = req.query.exam_code || '';
        const placement_id = req.query.placement_id || '';
        const exam_id = req.query.exam_id || '';
        let startUrl = `${baseUrl}/student.html?token=${token}&seb=true`;
        if (exam_code) startUrl += `&exam_code=${encodeURIComponent(exam_code)}`;
        if (placement_id) startUrl += `&placement_id=${encodeURIComponent(placement_id)}`;
        if (exam_id) startUrl += `&exam_id=${encodeURIComponent(exam_id)}`;
        startUrl = startUrl.replace(/&/g, '&amp;');

        // Fetch exam configuration to customize the SEB file settings
        let exam = null;
        if (exam_id) {
            const examResult = await pool.query('SELECT * FROM exams WHERE id = $1', [exam_id]);
            if (examResult.rows.length > 0) exam = examResult.rows[0];
        } else if (placement_id) {
            const placementResult = await pool.query('SELECT exam_id FROM exam_placements WHERE resource_link_id = $1', [placement_id]);
            if (placementResult.rows.length > 0) {
                const examResult = await pool.query('SELECT * FROM exams WHERE id = $1', [placementResult.rows[0].exam_id]);
                if (examResult.rows.length > 0) exam = examResult.rows[0];
            }
        } else if (exam_code) {
            const examResult = await pool.query('SELECT * FROM exams WHERE exam_code = $1', [exam_code]);
            if (examResult.rows.length > 0) exam = examResult.rows[0];
        }

        let sebConfig = '';
        const templatePath = path.join(__dirname, 'public', 'config.seb');

        if (fs.existsSync(templatePath)) {
            // Use User-provided template
            sebConfig = fs.readFileSync(templatePath, 'utf8');
            // Dynamically inject the startURL with the token
            // We look for the startURL key and replace the following <string> value
            const startUrlRegex = /(<key>startURL<\/key>\s*<string>)([^<]*)(<\/string>)/;
            if (startUrlRegex.test(sebConfig)) {
                sebConfig = sebConfig.replace(startUrlRegex, `$1${startUrl}$3`);
            } else {
                console.log('Template exists but startURL key not found or misformatted. Using fallback.');
            }

            // Inject or update quitURL
            const quitUrlStr = `${baseUrl}/api/seb/quit`;
            const quitUrlRegex = /(<key>quitURL<\/key>\s*<string>)([^<]*)(<\/string>)/;
            if (quitUrlRegex.test(sebConfig)) {
                sebConfig = sebConfig.replace(quitUrlRegex, `$1${quitUrlStr}$3`);
            } else {
                // Safely append to root dict right before the closing tags
                sebConfig = sebConfig.replace(/(<\/dict>\s*<\/plist>\s*$)/, `\t<key>quitURL</key>\n\t<string>${quitUrlStr}</string>\n$1`);
            }

            // Inject or update quitURLConfirm
            const quitUrlConfirmRegex = /(<key>quitURLConfirm<\/key>\s*)(<true\/>|<false\/>)/;
            if (quitUrlConfirmRegex.test(sebConfig)) {
                sebConfig = sebConfig.replace(quitUrlConfirmRegex, `$1<false/>`);
            } else {
                // Safely append to root dict right before the closing tags
                sebConfig = sebConfig.replace(/(<\/dict>\s*<\/plist>\s*$)/, `\t<key>quitURLConfirm</key>\n\t<false/>\n$1`);
            }
        }

        if (!sebConfig) {
            // Sane Default Fallback (as previously implemented)
            sebConfig = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>URLFilterEnable</key>
	<false/>
	<key>allowDisplayMirroring</key>
	<true/>
	<key>browserWindowAllowNewTab</key>
	<false/>
	<key>browserWindowAllowNewWindow</key>
	<false/>
	<key>browserWindowShowAddressBar</key>
	<false/>
	<key>browserWindowShowNavigationButtons</key>
	<false/>
	<key>newBrowserWindowByLinkPolicy</key>
	<integer>0</integer>
	<key>prohibitMultitasking</key>
	<true/>
	<key>showTaskBar</key>
	<false/>
	<key>startURL</key>
	<string>${startUrl}</string>
	<key>quitURL</key>
	<string>${baseUrl}/api/seb/quit</string>
	<key>quitURLConfirm</key>
	<false/>
</dict>
</plist>`;
        }

        // Apply exam constraints to the configuration dynamically
        if (exam) {
            // If only_one_screen is enabled, block display mirroring and secondary displays
            sebConfig = setPlistBooleanKey(sebConfig, 'allowDisplayMirroring', !exam.only_one_screen);
            sebConfig = setPlistBooleanKey(sebConfig, 'allowSecondaryDisplays', !exam.only_one_screen);
            // If block_downloads is enabled, block downloads
            sebConfig = setPlistBooleanKey(sebConfig, 'allowDownloads', !exam.block_downloads);
        }

        res.setHeader('Content-Type', 'application/seb');
        res.send(sebConfig);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// API: Quit SEB route (intercepted by SEB or displayed as a fallback complete page)
app.get('/api/seb/quit', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Exam Complete</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700&family=Plus+Jakarta+Sans:wght@400;600&display=swap" rel="stylesheet">
            <style>
                body {
                    font-family: 'Plus Jakarta Sans', sans-serif;
                    background: #f5f6f8;
                    color: #2d3b45;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    margin: 0;
                }
                .card {
                    background: white;
                    padding: 40px 30px;
                    border-radius: 16px;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.05);
                    text-align: center;
                    max-width: 450px;
                    width: 90%;
                    border: 1px solid rgba(0,0,0,0.06);
                }
                .icon {
                    font-size: 48px;
                    margin-bottom: 20px;
                }
                h1 {
                    font-family: 'Outfit', sans-serif;
                    font-size: 24px;
                    margin: 0 0 12px 0;
                    color: #008a00;
                }
                p {
                    color: #4a5c68;
                    font-size: 15px;
                    line-height: 1.6;
                    margin: 0 0 24px 0;
                }
                .btn {
                    display: inline-block;
                    background: #2d3b45;
                    color: white;
                    padding: 12px 24px;
                    border-radius: 8px;
                    text-decoration: none;
                    font-weight: 600;
                    font-size: 14px;
                    transition: all 0.2s;
                }
                .btn:hover {
                    background: #1e272e;
                    transform: translateY(-1px);
                }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="icon">🏁</div>
                <h1>Exam Complete!</h1>
                <p>Your proctored exam session has finished and your recording is securely uploaded. You may now safely exit Safe Exam Browser.</p>
                <a href="javascript:window.close()" class="btn">Close Window</a>
            </div>
        </body>
        </html>
    `);
});

const activeDisconnectTimers = new Map();

// Socket IO Real-Time
io.on('connection', (socket) => {
    socket.on('join_teacher', (exam_id) => {
        socket.join('teacher_' + exam_id);
    });

    socket.on('join_lti', (data) => { // { token }
        socket.join('lti_' + data.token);
    });

    socket.on('mobile_pair', async (data) => { // { token, exam_id }
        try {
            const { token, exam_id } = data;
            const ltiResult = await pool.query('SELECT canvas_user_id FROM lti_sessions WHERE session_token = $1', [token]);
            if (ltiResult.rows.length > 0) {
                socket.join('lti_' + token);
                socket.mobileData = { token, exam_id };
                console.log(`[Socket Mobile] Mobile linked successfully for LTI token ${token}`);
                io.to('lti_' + token).emit('mobile_paired', { success: true });
            } else {
                socket.emit('mobile_pair_error', { error: 'Invalid token' });
            }
        } catch (err) {
            console.error('[Socket Mobile] Pair error:', err);
            socket.emit('mobile_pair_error', { error: err.message });
        }
    });

    socket.on('laptop_begin_exam', (data) => { // { token }
        io.to('lti_' + data.token).emit('mobile_start_record');
    });

    socket.on('laptop_end_exam', (data) => { // { token }
        io.to('lti_' + data.token).emit('mobile_stop_record');
    });

    socket.on('mobile_violation', async (data) => {
        try {
            const { token, event_type, event_message } = data;
            const ltiResult = await pool.query('SELECT exam_session_id FROM lti_sessions WHERE session_token = $1', [token]);
            if (ltiResult.rows.length > 0 && ltiResult.rows[0].exam_session_id) {
                const sessionId = ltiResult.rows[0].exam_session_id;
                await pool.query(
                    'INSERT INTO proctor_logs (exam_session_id, event_type, event_message) VALUES ($1, $2, $3)',
                    [sessionId, event_type, event_message]
                );
                const sessionQuery = await pool.query('SELECT exam_id FROM exam_sessions WHERE id = $1', [sessionId]);
                if (sessionQuery.rows.length > 0) {
                    io.to('teacher_' + sessionQuery.rows[0].exam_id).emit('suspicious_activity', {
                        session_id: sessionId,
                        event_type: event_type,
                        event_message: event_message
                    });
                }
            }
        } catch(e){
            console.error('[Socket Mobile] Violation logging error:', e);
        }
    });

    socket.on('join_student', (data) => { // { exam_id, exam_session_id, student_name }
        socket.join('student_' + data.exam_session_id);
        socket.join('exam_' + data.exam_id);
        socket.studentData = data;
        io.to('teacher_' + data.exam_id).emit('student_status', { session_id: data.exam_session_id, name: data.student_name, status: 'online' });
        
        // Clear auto-save timer if student reconnected
        if (activeDisconnectTimers.has(data.exam_session_id)) {
            clearTimeout(activeDisconnectTimers.get(data.exam_session_id));
            activeDisconnectTimers.delete(data.exam_session_id);
            console.log(`Student reconnected to session ${data.exam_session_id}, cancelled auto-save`);
        }
    });
    socket.on('student_snapshot', (data) => {
        // data: { exam_id, exam_session_id, screenshot_data_url }
        io.to('teacher_' + data.exam_id).emit('snapshot_update', data);
    });

    socket.on('proctor_log', async (data) => {
        // data: { exam_session_id, event_type, event_message }
        try {
            await pool.query(
                'INSERT INTO proctor_logs (exam_session_id, event_type, event_message) VALUES ($1, $2, $3)',
                [data.exam_session_id, data.event_type, data.event_message]
            );
        } catch (err) {
            console.error('Failed to save proctor log:', err);
        }
    });

    socket.on('instructor_warning', (data) => {
        // data: { exam_session_id, message }
        io.to('student_' + data.exam_session_id).emit('instructor_warning', { message: data.message });
    });

    socket.on('instructor_broadcast', (data) => {
        // data: { exam_id, message }
        io.to('exam_' + data.exam_id).emit('instructor_warning', { message: data.message });
    });

    socket.on('disconnect', async () => {
        if (socket.mobileData) {
            const { token } = socket.mobileData;
            console.log(`[Socket Mobile] Mobile disconnected for LTI token ${token}`);
            io.to('lti_' + token).emit('mobile_disconnected');
            try {
                const ltiResult = await pool.query('SELECT exam_session_id FROM lti_sessions WHERE session_token = $1', [token]);
                if (ltiResult.rows.length > 0 && ltiResult.rows[0].exam_session_id) {
                    const sessionId = ltiResult.rows[0].exam_session_id;
                    await pool.query(
                        'INSERT INTO proctor_logs (exam_session_id, event_type, event_message) VALUES ($1, $2, $3)',
                        [sessionId, 'mobile_camera_lost', 'Secondary mobile camera connection was lost.']
                    );
                }
            } catch(e){}
        }

        if(socket.studentData) {
            const { exam_session_id, exam_id, student_name } = socket.studentData;
            io.to('teacher_' + exam_id).emit('student_status', { 
                session_id: exam_session_id, 
                name: student_name, 
                status: 'offline' 
            });

            // Start a 30-second grace period timer to finalize the session if they don't reconnect
            const timer = setTimeout(async () => {
                activeDisconnectTimers.delete(exam_session_id);
                try {
                    const sessionQuery = await pool.query('SELECT status FROM exam_sessions WHERE id = $1', [exam_session_id]);
                    if (sessionQuery.rows.length > 0 && (sessionQuery.rows[0].status === 'started' || sessionQuery.rows[0].status === 'unexpected')) {
                        // Check if the student completed the exam before disconnect
                        const endedQuery = await pool.query(
                            "SELECT id FROM proctor_logs WHERE exam_session_id = $1 AND event_type = 'exam_ended' LIMIT 1",
                            [exam_session_id]
                        );
                        const finalStatus = endedQuery.rows.length > 0 ? 'completed' : 'abandoned';
                        console.log(`Session ${exam_session_id} disconnected. Setting status to: ${finalStatus}. Auto-finalizing...`);
                        await pool.query("UPDATE exam_sessions SET status = $1 WHERE id = $2", [finalStatus, exam_session_id]);
                        assembleAndUploadSessionVideo(exam_session_id);
                    }
                } catch (e) {
                    console.error(`Error auto-finalizing session ${exam_session_id}:`, e);
                }
            }, 30000); // 30 seconds grace period

            activeDisconnectTimers.set(exam_session_id, timer);
        }
    });
});

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filepath) => {
        if (filepath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));
// Fallback protection for static entries
app.get('/', (req, res) => {
    if (req.session.lti && req.session.lti.role === 'student') return res.redirect('/student.html');
    res.redirect('/index.html');
});

app.post('/api/client-error', (req, res) => {
    console.log('--- CLIENT ERROR LOGGED ---', JSON.stringify(req.body, null, 2));
    res.json({ success: true });
});


initDatabase().then(() => {
    server.listen(PORT, () => {
        console.log(`Secure Exam Proctor running on port ${PORT}`);
    });
}).catch(console.error);

// API: Upload Room Scan Video
app.post('/api/session/room-scan', requireAuth, async (req, res) => {
    const { exam_session_id, base64_video } = req.body;
    try {
        if (!base64_video) throw new Error("Video payload was empty");
        console.log(`[Upload Room Scan] Received room scan for session ${exam_session_id}`);

        const scanDir = path.join(os.tmpdir(), `roomscans`);
        if (!fs.existsSync(scanDir)) {
            fs.mkdirSync(scanDir, { recursive: true });
        }

        const scanPath = path.join(scanDir, `scan-${exam_session_id}.webm`);
        const pureB64 = base64_video.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
        fs.writeFileSync(scanPath, pureB64, 'base64');
        
        // In a real app we'd upload to Drive, but for now we store locally and provide a route
        const roomScanUrl = `/api/session/room-scan-playback/${exam_session_id}`;
        
        // Update database with room scan URL (you would need to add a column for this if it doesn't exist, but we can just use the endpoint pattern)
        // Or store it in proctor_logs so the speedgrader can fetch it.
        await pool.query("INSERT INTO proctor_logs (exam_session_id, event_type, event_message, event_timestamp) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)", [exam_session_id, 'room_scan_video', roomScanUrl]);

        res.json({ success: true, url: roomScanUrl });
    } catch (err) {
        console.error('Room Scan Upload Error', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Room Scan Playback
app.get('/api/session/room-scan-playback/:session_id', requireInstructorOrExtensionToken, async (req, res) => {
    try {
        const { session_id } = req.params;
        const scanPath = path.join(os.tmpdir(), `roomscans`, `scan-${session_id}.webm`);
        
        if (fs.existsSync(scanPath)) {
            res.setHeader('Content-Type', 'video/webm');
            fs.createReadStream(scanPath).pipe(res);
        } else {
            // Check if there is a room_scan_drive_file_id in database!
            const dbQuery = await pool.query('SELECT room_scan_drive_file_id FROM exam_sessions WHERE id = $1', [session_id]);
            if (dbQuery.rows.length > 0 && dbQuery.rows[0].room_scan_drive_file_id) {
                const driveFileId = dbQuery.rows[0].room_scan_drive_file_id;
                console.log(`[Playback] Streaming room scan from Google Drive. File ID: ${driveFileId}`);
                res.setHeader('Content-Type', 'video/webm');
                const stream = await downloadVideoFromDrive(driveFileId);
                stream.pipe(res);
            } else {
                res.status(404).send('Room scan not found');
            }
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Upload Student ID Image
app.post('/api/session/upload-id', requireAuth, async (req, res) => {
    const { exam_session_id, base64_image } = req.body;
    try {
        if (!base64_image) throw new Error("Image payload was empty");
        console.log(`[Upload ID] Received ID verification image for session ${exam_session_id}`);

        const idDir = path.join(os.tmpdir(), `id_images`);
        if (!fs.existsSync(idDir)) {
            fs.mkdirSync(idDir, { recursive: true });
        }

        const idPath = path.join(idDir, `id-${exam_session_id}.png`);
        const pureB64 = base64_image.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
        fs.writeFileSync(idPath, pureB64, 'base64');
        
        const idViewUrl = `/api/session/view-id/${exam_session_id}`;
        
        // Log ID image in proctor_logs so the speedgrader can fetch it.
        await pool.query(
            "INSERT INTO proctor_logs (exam_session_id, event_type, event_message, event_timestamp) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)", 
            [exam_session_id, 'verify_id_image', idViewUrl]
        );

        res.json({ success: true, url: idViewUrl });
    } catch (err) {
        console.error('ID Image Upload Error', err);
        res.status(500).json({ error: err.message });
    }
});

// API: View ID Verification Image
app.get('/api/session/view-id/:session_id', requireInstructorOrExtensionToken, async (req, res) => {
    try {
        const { session_id } = req.params;
        const idPath = path.join(os.tmpdir(), `id_images`, `id-${session_id}.png`);
        
        if (fs.existsSync(idPath)) {
            res.setHeader('Content-Type', 'image/png');
            fs.createReadStream(idPath).pipe(res);
        } else {
            res.status(404).send('ID verification image not found');
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Upload Student Signature Image
app.post('/api/session/upload-signature', requireAuth, async (req, res) => {
    const { exam_session_id, base64_image, full_name } = req.body;
    try {
        if (!base64_image) throw new Error("Image payload was empty");
        console.log(`[Upload Signature] Received signature image for session ${exam_session_id}`);

        const sigDir = path.join(os.tmpdir(), `signatures`);
        if (!fs.existsSync(sigDir)) {
            fs.mkdirSync(sigDir, { recursive: true });
        }

        const sigPath = path.join(sigDir, `sig-${exam_session_id}.png`);
        const pureB64 = base64_image.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
        fs.writeFileSync(sigPath, pureB64, 'base64');
        
        const sigViewUrl = `/api/session/view-signature/${exam_session_id}`;
        
        // Log Signature in proctor_logs
        await pool.query(
            "INSERT INTO proctor_logs (exam_session_id, event_type, event_message, event_timestamp) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)", 
            [exam_session_id, 'verify_signature_image', sigViewUrl]
        );

        // Also create a regular log indicating academic integrity agreement signed
        await pool.query(
            "INSERT INTO proctor_logs (exam_session_id, event_type, event_message, event_timestamp) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)", 
            [exam_session_id, 'academic_integrity_agreement', `Student signed academic honesty agreement as "${full_name}".`]
        );

        res.json({ success: true, url: sigViewUrl });
    } catch (err) {
        console.error('Signature Upload Error', err);
        res.status(500).json({ error: err.message });
    }
});

// API: View Signature Image
app.get('/api/session/view-signature/:session_id', requireInstructorOrExtensionToken, async (req, res) => {
    try {
        const { session_id } = req.params;
        const sigPath = path.join(os.tmpdir(), `signatures`, `sig-${session_id}.png`);
        
        if (fs.existsSync(sigPath)) {
            res.setHeader('Content-Type', 'image/png');
            fs.createReadStream(sigPath).pipe(res);
        } else {
            res.status(404).send('Signature image not found');
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


