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

// ================================================================
// Refuse to run in production on the fallback secrets above.
//
// Each of those `||` defaults exists so a developer can `node server.js` without
// a .env. The danger is that they are also *published* — this file is in git, so
// the fallback values are public knowledge. A single missing or misspelled
// variable in the production environment would silently downgrade the system to
// a publicly-known signing key, and nothing would look wrong: the app boots, the
// dashboard loads, tokens verify.
//
// What that actually costs: JWT_SIGNING_KEY signs the extension tokens accepted
// by requireInstructorOrExtensionToken, which guards video playback, room scans,
// ID photos and signatures. Anyone who can read this repo could mint themselves
// an instructor token and read student recordings. So this is a hard stop, not a
// warning — a proctoring server that cannot prove who an instructor is should
// not accept exams.
// ================================================================
// Secrets that are server-side only and can be rotated freely. If one of these
// still equals the value published in this repo, refuse to run.
const INSECURE_DEFAULTS = {
    JWT_SIGNING_KEY: 'dev-only-insecure-signing-key-DO-NOT-USE-IN-PRODUCTION',
    AUTO_LOGIN_SIGNING_SECRET: 'dev-only-insecure-auto-login-secret',
    // Signs the session cookie (see app.use(session(...)) below). With the
    // published fallback, a session cookie can be forged outright.
    SESSION_SECRET: 'proctor-secret-key'
};

// CANVAS_LAUNCH_SECRET is handled separately and deliberately more gently.
//
// It cannot be rotated unilaterally: the same value is embedded in every
// proctored quiz's launch configuration in Canvas and in the patched
// quizzes_controller.rb, so changing it here alone breaks every quiz launch.
// Hard-failing on the published value would therefore force an operator to
// choose between a server that will not start and a coordinated Canvas-side
// migration in the middle of a deploy. That is the wrong time to make them
// choose, and the predictable result is that the check gets deleted.
//
// So: require it to be *explicitly set* — an unset variable silently falling
// back is the failure this whole block exists to prevent — but if it is set to
// the published value, warn loudly and keep running.
const CANVAS_LAUNCH_SECRET_PUBLISHED = 'canvas-proctor-shared-secret-key-998877';

if (process.env.NODE_ENV === 'production') {
    const active = {
        JWT_SIGNING_KEY,
        AUTO_LOGIN_SIGNING_SECRET,
        CANVAS_LAUNCH_SECRET,
        SESSION_SECRET: process.env.SESSION_SECRET || 'proctor-secret-key'
    };
    const unsafe = Object.keys(INSECURE_DEFAULTS)
        .filter(name => active[name] === INSECURE_DEFAULTS[name]);

    if (unsafe.length > 0) {
        console.error('\n=============================================================');
        console.error(' ProctorGuard refused to start.');
        console.error('');
        console.error(' These secrets are still set to the built-in development');
        console.error(' fallback, which is published in this repository:');
        unsafe.forEach(name => console.error(`   - ${name}`));
        console.error('');
        console.error(' Generate a value for each and put it in .env:');
        console.error('   openssl rand -hex 32');
        console.error('=============================================================\n');
        process.exit(1);
    }

    if (!process.env.CANVAS_LAUNCH_SECRET) {
        console.error('\n=============================================================');
        console.error(' ProctorGuard refused to start.');
        console.error('');
        console.error(' CANVAS_LAUNCH_SECRET is not set, so the server would fall');
        console.error(' back to a value published in this repository without');
        console.error(' anything indicating it had done so.');
        console.error('');
        console.error(' Set it in .env to whatever your Canvas quizzes and patched');
        console.error(' quizzes_controller.rb are already configured with. If that');
        console.error(' is still the published value, set it to that value — it is');
        console.error(' recorded explicitly rather than assumed, and you will get a');
        console.error(' warning until it is rotated on both sides.');
        console.error('=============================================================\n');
        process.exit(1);
    }

    if (process.env.CANVAS_LAUNCH_SECRET === CANVAS_LAUNCH_SECRET_PUBLISHED) {
        console.warn('\n-------------------------------------------------------------');
        console.warn(' WARNING: CANVAS_LAUNCH_SECRET is the value published in this');
        console.warn(' repository. Anyone who can read the repo can forge a Canvas');
        console.warn(' launch. Rotating it requires changing, together:');
        console.warn('   1. CANVAS_LAUNCH_SECRET in .env');
        console.warn('   2. the launch URL on every proctored quiz in Canvas');
        console.warn('   3. the patched quizzes_controller.rb');
        console.warn(' Schedule that outside an exam window.');
        console.warn('-------------------------------------------------------------\n');
    }
}

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

// A `beforeunload` beacon is not proof the attempt is over. The student may be
// reloading, losing wifi for a moment, or being bounced by Canvas — all of which
// come back through /api/session/start and resume the same exam_session. If we
// assemble on that beacon we also delete the chunk directory, which destroys the
// chunks the resumed recording is still appending to. So an unexpected exit only
// *schedules* finalization, and resuming cancels it.
const pendingFinalizations = new Map(); // exam_session_id -> Timeout
const UNEXPECTED_EXIT_GRACE_MS = 3 * 60 * 1000;

app.set('trust proxy', 1);

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
// Sessions live in Postgres, not in process memory.
//
// express-session's default MemoryStore keeps every session in the Node heap,
// which for this application means a restart signs everyone out. On a proctoring
// server that is not a minor annoyance: `pm2 restart`, a deploy, or a crash-loop
// recovery in the middle of an exam window invalidates the session that
// requireAuth checks, and students lose their in-progress attempt. It also
// cannot survive running more than one process.
//
// createTableIfMissing lets the store provision its own table on first boot, so
// this needs no migration step.
const PgSession = require('connect-pg-simple')(session);

// Held in a variable so the socket.io layer can reuse exactly this middleware to
// resolve req.session on a handshake. The socket layer used to be completely
// unauthenticated; sharing the session is what lets it identify a caller at all.
const sessionMiddleware = session({
    store: new PgSession({
        pool,
        tableName: 'user_sessions',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'proctor-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
});

app.use(sessionMiddleware);

// Server logs, for remote diagnostics.
//
// This was previously unauthenticated and publicly reachable. console.log and
// console.error are intercepted into logFile above, and the application logs
// student names, Canvas user IDs, session identifiers and per-launch
// Referer/User-Agent — so this endpoint served a running transcript of exam
// activity to anyone who requested the URL.
//
// requireInstructor is the minimum bar. It is also gated behind
// ENABLE_DEV_ENDPOINTS because a diagnostic firehose should be switched on
// deliberately while debugging, not left listening during exams.
app.get('/api/server-logs', requireInstructor, (req, res) => {
    if (process.env.ENABLE_DEV_ENDPOINTS !== 'true') {
        return res.status(404).send('Not found');
    }
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

    // A signature check against a secret published in this repository proves nothing:
    // anyone who can read the source can sign their own launch and claim
    // roles=Instructor. Treat the fallback values as equivalent to no verification at
    // all rather than letting them look like security.
    if (!process.env.LTI_SECRET || consumerSecret === 'proctor-lti-secret') {
        if (process.env.ALLOW_UNSIGNED_LTI !== 'true') {
            console.error('[LTI] Refused launch: LTI_SECRET is unset or still the repository default.');
            return res.status(500).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;margin-top:100px;color:#374151;">
                <h2>ProctorGuard is not configured</h2>
                <p>The LTI shared secret has not been set on this server, so launches cannot be verified.</p>
                <p style="color:#6b7280;font-size:13px;">Administrator: set LTI_SECRET (and LTI_KEY) to match the Canvas External Tool configuration, then restart.</p>
            </body></html>`);
        }
        console.warn('[LTI] LTI_SECRET is unset or default; launches are effectively unverified.');
    }

    const provider = new lti.Provider(consumerKey, consumerSecret);
    provider.valid_request(req, (err, isValid) => {
        // ============================================================
        // The OAuth signature is now ENFORCED.
        //
        // This block previously logged "validation skipped/failed (expected in DEV)"
        // and then carried on regardless. Because the role is read straight from
        // req.body a few lines below, that meant a single unauthenticated POST —
        //
        //     POST /lti/launch   roles=Instructor&user_id=anything&context_id=anything
        //
        // — minted a full instructor session for anyone on the internet. Every
        // requireInstructor endpoint followed from that: all student recordings, all
        // reports, exam configuration, the Drive vault. It also defeated the socket
        // authentication added earlier, since the resulting cookie was a genuinely
        // issued instructor session.
        //
        // ALLOW_UNSIGNED_LTI exists only because refusing unsigned launches will take
        // the tool offline if the Canvas consumer key/secret pair is misconfigured.
        // It is a diagnostic escape hatch, not a setting to leave on.
        // ============================================================
        if (err || !isValid) {
            const reason = err ? err.message : 'signature did not validate';
            if (process.env.ALLOW_UNSIGNED_LTI === 'true') {
                console.warn('=================================================================');
                console.warn(` INSECURE: accepted an UNSIGNED LTI launch (${reason}).`);
                console.warn(' ALLOW_UNSIGNED_LTI=true is set, so anyone who can POST to');
                console.warn(' /lti/launch can mint an instructor session. Fix the Canvas');
                console.warn(' key/secret and remove this variable.');
                console.warn('=================================================================');
            } else {
                console.error(`[LTI] Rejected launch: ${reason}`);
                return res.status(401).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;margin-top:100px;color:#374151;">
                    <h2>This launch could not be verified</h2>
                    <p>ProctorGuard could not confirm this request came from Canvas, so it was refused.</p>
                    <p style="color:#6b7280;font-size:13px;">If you are an administrator: check that the consumer key and shared secret configured on the Canvas External Tool match LTI_KEY and LTI_SECRET on the server.</p>
                </body></html>`);
            }
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

// Gate for all /dev* and /api/dev/* endpoints. These are diagnostic-only and were
// previously WIDE OPEN to the public internet — /dev-student minted a student session
// with no auth, and /api/dev/* leaked config/logs/tmp listings. They're now off unless
// ENABLE_DEV_ENDPOINTS=true is explicitly set in the environment, so production is
// closed by default but you can flip the flag on the VPS when you genuinely need them.
function requireDevEndpoints(req, res, next) {
    if (process.env.ENABLE_DEV_ENDPOINTS === 'true') return next();
    return res.status(404).send('Not found');
}

app.get('/dev-student', requireDevEndpoints, (req, res) => {
    req.session.lti = { userId: req.query.userId || 'dev_student_1', canvasCourseId: req.query.courseId || 'demo_course', userName: 'Dev Student', role: 'student' };
    res.redirect('/student.html');
});

app.get('/api/dev/check-config', requireDevEndpoints, (req, res) => {
    const key = process.env.LTI_KEY || 'NOT_SET';
    const secret = process.env.LTI_SECRET || 'NOT_SET';
    // Only report presence/length — never echo the actual key or secret substrings,
    // even behind the dev gate, so an accidentally-enabled flag can't leak credentials.
    res.json({
        has_key: key !== 'NOT_SET',
        has_secret: secret !== 'NOT_SET',
        secret_length: secret === 'NOT_SET' ? 0 : secret.length,
        base_url: process.env.BASE_URL || 'NOT_SET'
    });
});

app.get('/api/dev/logs', requireDevEndpoints, (req, res) => {
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

app.get('/api/dev/debug-tmp', requireDevEndpoints, (req, res) => {
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

// ================================================================
// Session ownership
//
// requireAuth only proves "a valid LTI session exists", and every enrolled student
// has one. A number of endpoints took `exam_session_id` straight from the request
// body and acted on it, so any student could end a classmate's attempt, corrupt
// their recording, plant violations in their log, or overwrite their ID photo and
// signature — session ids being sequential integers.
//
// Instructors keep broad access (they legitimately act across their course). For
// everyone else the session must belong to them.
// ================================================================
async function assertSessionOwnership(req, res, exam_session_id) {
    if (!exam_session_id) {
        res.status(400).json({ error: 'Missing exam_session_id' });
        return false;
    }
    const lti = req.session && req.session.lti;
    if (!lti) {
        res.status(401).json({ error: 'Not authenticated.' });
        return false;
    }
    if (lti.role === 'instructor') return true;

    try {
        const r = await pool.query(
            'SELECT id FROM exam_sessions WHERE id = $1 AND student_canvas_id = $2',
            [exam_session_id, lti.userId]
        );
        if (r.rows.length === 0) {
            console.warn(`[Authz] User ${lti.userId} denied access to exam_session ${exam_session_id}.`);
            res.status(403).json({ error: 'This exam session does not belong to you.' });
            return false;
        }
        return true;
    } catch (err) {
        console.error('[Authz] Ownership check failed:', err.message);
        res.status(500).json({ error: 'Authorization check failed.' });
        return false;
    }
}

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

// ================================================================
// Optional second factor for the instructor dashboard.
//
// The primary gate is, and has always been, the LTI role check below: you cannot
// reach any instructor endpoint without a real signed Canvas launch that named
// you an instructor. The passcode is a deliberate *second* step for the shared
// classroom machine — the case where a teacher launches the dashboard, walks
// away, and leaves an authenticated session on screen in front of students.
//
// Previously this was dead code in two directions at once: the value was
// hardcoded here (and therefore public, since this file is in git), and
// `passcodeVerified` was written but never read, while the client waited for a
// `needs_passcode` flag the server never sent. So the overlay never appeared and
// the check never ran. It is now driven by INSTRUCTOR_PASSCODE.
//
// Leave INSTRUCTOR_PASSCODE unset and the feature is simply off — which is
// honest, rather than presenting a prompt that protects nothing.
// ================================================================
const INSTRUCTOR_PASSCODE = process.env.INSTRUCTOR_PASSCODE || '';
const PASSCODE_ENABLED = INSTRUCTOR_PASSCODE.length > 0;

// Bound guessing without locking a teacher out mid-exam: per-session, resets on
// success, and the window is short enough to be invisible to a legitimate typo.
const passcodeAttempts = new Map(); // sessionID -> { count, firstAttemptAt }
const PASSCODE_MAX_ATTEMPTS = 5;
const PASSCODE_WINDOW_MS = 5 * 60 * 1000;

function requireInstructor(req, res, next) {
    if (!req.session.lti || req.session.lti.role !== 'instructor') {
        return res.status(403).json({ error: 'Instructor access required.' });
    }
    if (PASSCODE_ENABLED && !req.session.passcodeVerified) {
        // needs_passcode is what apiFetch() in public/js/app.js watches for to
        // raise the overlay. Without this flag the client cannot tell "you are
        // not an instructor" apart from "you have not entered the passcode yet".
        return res.status(403).json({
            error: 'Passcode verification required.',
            needs_passcode: true
        });
    }
    next();
}

app.post('/api/verify-passcode', (req, res) => {
    if (!req.session.lti || req.session.lti.role !== 'instructor') {
        return res.status(403).json({ error: 'Instructor session required.' });
    }
    if (!PASSCODE_ENABLED) {
        // Nothing to verify against; don't pretend otherwise.
        req.session.passcodeVerified = true;
        return res.json({ success: true, passcode_disabled: true });
    }

    const key = req.sessionID;
    const now = Date.now();
    const record = passcodeAttempts.get(key);
    if (record && now - record.firstAttemptAt > PASSCODE_WINDOW_MS) {
        passcodeAttempts.delete(key);
    }
    const current = passcodeAttempts.get(key);
    if (current && current.count >= PASSCODE_MAX_ATTEMPTS) {
        const waitMs = PASSCODE_WINDOW_MS - (now - current.firstAttemptAt);
        return res.status(429).json({
            error: `Too many attempts. Try again in ${Math.ceil(waitMs / 60000)} minute(s).`
        });
    }

    const supplied = String(req.body.passcode ?? '');
    // Constant-time compare. Hash both sides first so the comparison operates on
    // equal-length buffers regardless of what was submitted — timingSafeEqual
    // throws on a length mismatch, and the length itself would otherwise leak.
    const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();
    const matches = crypto.timingSafeEqual(digest(supplied), digest(INSTRUCTOR_PASSCODE));

    if (matches) {
        passcodeAttempts.delete(key);
        req.session.passcodeVerified = true;
        return res.json({ success: true });
    }

    const updated = current || { count: 0, firstAttemptAt: now };
    updated.count += 1;
    passcodeAttempts.set(key, updated);
    res.status(400).json({ error: 'Incorrect passcode' });
});

// Who is signed in, for the dashboard chrome. The LTI launch already carries
// lis_person_name_full (see /lti/launch), but nothing ever handed it to the
// client, so the top bar rendered the literal placeholder "Instructor" for
// everyone, permanently.
//
// Deliberately requireAuth rather than requireInstructor: this only returns the
// viewer's own identity, and it must still resolve while the passcode overlay is
// up so the prompt can address the teacher by name.
app.get('/api/me', requireAuth, (req, res) => {
    const lti = req.session.lti || {};
    res.json({
        user_name: lti.userName || null,
        role: lti.role || null,
        course_id: lti.canvasCourseId || null,
        passcode_required: PASSCODE_ENABLED && !req.session.passcodeVerified
    });
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
    
    // Fallback Canvas credentials, now sourced from env vars instead of a hardcoded
    // admin token baked into source. CANVAS_API_TOKEN must be set in the VPS .env.
    // The old literal token that used to live here has been REMOVED and must be
    // rotated in Canvas (Account > Settings > Approved Integrations) since it was
    // previously committed to source. If the env var is unset we return no token and
    // let callers degrade gracefully (they all null-check canvas_api_token) rather
    // than fall back to a leaked secret.
    return {
        canvas_api_url: process.env.CANVAS_API_URL || 'https://canvas.siotw.net/api/v1',
        canvas_api_token: process.env.CANVAS_API_TOKEN || null
    };
}

// Helper to update require_lockdown_browser setting on Canvas quiz via API
async function setCanvasQuizProctorMode(ltiSession, canvasQuizUrl, requireProctorMode) {
    try {
        const credentials = await getCanvasCredentials(ltiSession);
        if (!credentials || !credentials.canvas_api_token) {
            console.error('Canvas API credentials missing in setCanvasQuizProctorMode');
            return { ok: false, error: 'Canvas API token is not configured, so quiz settings could not be applied in Canvas.' };
        }

        // Extract quiz ID from url
        const match = canvasQuizUrl.match(/\/quizzes\/(\d+)/);
        if (!match) {
            console.error('Could not extract quiz ID from URL:', canvasQuizUrl);
            return { ok: false, error: `Could not read a quiz ID from ${canvasQuizUrl}` };
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
            // Returned, not just logged. This call is what clears Canvas's
            // "required to view results" checkbox; when it fails silently the
            // quiz keeps whatever Canvas had, and the instructor is left
            // believing ProctorGuard applied a setting it never managed to send.
            // The most common cause is a missing or expired CANVAS_API_TOKEN.
            return { ok: false, error: `Canvas API ${fetchRes.status}: ${errText.slice(0, 200)}` };
        }

        console.log(`Canvas quiz ${quizId} proctor mode updated successfully to ${requireProctorMode}.`);
        return { ok: true };
    } catch (err) {
        console.error('Error in setCanvasQuizProctorMode:', err);
        return { ok: false, error: err.message };
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
        const allow_mobile_devices = req.body.allow_mobile_devices || false;
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
                weight_head_movement, weight_multi_face, weight_leaving_room, allow_mobile_devices
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, false, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52, $53) RETURNING *
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
            weight_head_movement, weight_multi_face, weight_leaving_room, allow_mobile_devices
        ]);
        
        // Enable proctor mode on the Canvas quiz, and explicitly clear Canvas's
        // "required to view results" flag. Awaited and reported: previously this
        // was fire-and-forget, so a failure left the quiz configured however
        // Canvas had it while the dashboard reported success.
        const canvasSync = await setCanvasQuizProctorMode(req.session.lti, canvas_quiz_url, true);

        res.json({
            ...result.rows[0],
            canvas_sync_ok: canvasSync ? canvasSync.ok : false,
            canvas_sync_error: canvasSync && !canvasSync.ok ? canvasSync.error : null
        });
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
            
            const logs = logsResult.rows;

            // Risk scoring.
            //
            // This was an unbounded running total, which produced "250% Suspicious"
            // on a genuine 18-second test attempt. Two separate faults:
            //
            //  1. Nothing clamped the result, so it was presented as a percentage
            //     while being free to exceed 100.
            //  2. Every occurrence of a type added its full weight, so one
            //     continuous behaviour dominated everything else. Talking through a
            //     single sentence out-scored a phone being detected five times over.
            //
            // Both matter because this number is the first thing an instructor sees
            // about a student. It has to be defensible, and "250% suspicious" for
            // muttering at your screen is not.
            //
            // Now: each category contributes its weight for the first occurrence and
            // diminishing amounts after, capped per category, and the total is
            // clamped to 100. Repetition still raises the score — it just cannot run
            // away, and a single behaviour can never fill the bar alone.
            const RISK_WEIGHTS = {
                phone_detected: 50,
                multiple_faces: 30,
                tab_blur: 15, window_blur: 15, fullscreen_exit: 15,
                app_backgrounded: 15, page_hidden: 15,
                audio_threshold_exceeded: 10, audio_violation: 10,
                voice_transcript: 10, voice_activity: 10,
                no_face: 10, AI_PEOPLE: 10,
                gaze_off_screen: 10,
                // Mobile browser sessions cannot capture screen / use extension
                // lockdown — surface as elevated review priority so "I misclicked"
                // is not all-green.
                mobile_browser_mode: 25,
                screen_share_unavailable: 20
            };

            // Categories that share a cap, so five names for "they looked away"
            // cannot each contribute a separate full allowance.
            const RISK_GROUPS = {
                tab_blur: 'focus', window_blur: 'focus', fullscreen_exit: 'focus',
                app_backgrounded: 'focus', page_hidden: 'focus',
                audio_threshold_exceeded: 'audio', audio_violation: 'audio',
                voice_transcript: 'audio', voice_activity: 'audio',
                no_face: 'face', AI_PEOPLE: 'face', multiple_faces: 'face'
            };

            const groupCounts = {};
            let riskScore = 0;

            for (const log of logs) {
                const weight = RISK_WEIGHTS[log.event_type];
                if (!weight) continue;

                const group = RISK_GROUPS[log.event_type] || log.event_type;
                const seen = groupCounts[group] || 0;
                groupCounts[group] = seen + 1;

                // 1st occurrence full weight, 2nd half, 3rd a third, then nothing.
                // Sustained behaviour reads as more serious than a one-off without
                // letting a chatty five seconds outweigh a phone on the desk.
                if (seen === 0) riskScore += weight;
                else if (seen === 1) riskScore += weight / 2;
                else if (seen === 2) riskScore += weight / 3;
            }

            riskScore = Math.min(100, Math.round(riskScore));

            let riskTier = 'Low';
            if (riskScore >= 70) riskTier = 'High';
            else if (riskScore >= 30) riskTier = 'Medium';

            // Backfill verify_* fields from logs when session columns were never
            // populated (uploads historically only wrote proctor_logs). Lets the
            // extension Review Center Verification tab and any other consumers
            // that read session.verify_id_image / verify_signature_* work for
            // both old and new attempts.
            let verify_id_image = session.verify_id_image;
            let verify_signature_image = session.verify_signature_image;
            let verify_signature_name = session.verify_signature_name;
            if (!verify_id_image) {
                const idLog = logs.find(l => l.event_type === 'verify_id_image');
                if (idLog && idLog.event_message) verify_id_image = idLog.event_message;
            }
            if (!verify_signature_image) {
                const sigLog = logs.find(l => l.event_type === 'verify_signature_image');
                if (sigLog && sigLog.event_message) verify_signature_image = sigLog.event_message;
            }
            if (!verify_signature_name) {
                const agreementLog = logs.find(l => l.event_type === 'academic_integrity_agreement');
                if (agreementLog && agreementLog.event_message) {
                    const m = agreementLog.event_message.match(/as\s+"([^"]+)"/i);
                    if (m) verify_signature_name = m[1];
                }
            }

            sessions.push({
                ...session,
                verify_id_image,
                verify_signature_image,
                verify_signature_name,
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
        const allow_mobile_devices = body.allow_mobile_devices || false;

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
                    verify_id = $41, verify_signature = $42, allow_calculator = $43, allow_whiteboard = $44,
                    allow_mobile_devices = $45
                WHERE id = $46
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
                verify_video, verify_audio, verify_desktop, verify_id, verify_signature, allow_calculator, allow_whiteboard,
                allow_mobile_devices, id
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
                    allow_mobile_devices,
                    is_open, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                    $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37,
                    $38, $39, $40, $41, $42, $43, $44, $45,
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
                verify_video, verify_audio, verify_desktop, verify_id, verify_signature, allow_calculator, allow_whiteboard,
                allow_mobile_devices
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
        const allow_mobile_devices = req.body.allow_mobile_devices || false;
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
                allow_mobile_devices = $52,
                updated_at = NOW()
            WHERE id = $53 AND (canvas_course_id = $54 OR canvas_course_id = $55)
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
            allow_mobile_devices,
            id, canvasCourseId, alternativeCourseId || ''
        ]);

        if (result.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });

        // Update Canvas settings. require_lockdown_browser_for_results is always
        // sent as false here, so saving an exam's settings is also the way to
        // clear that flag on a quiz where it somehow got switched on.
        let canvasSync = null;
        if (canvas_quiz_url) {
            canvasSync = await setCanvasQuizProctorMode(req.session.lti, canvas_quiz_url, true);

            // If the quiz URL changed, disable it on the previous quiz
            if (oldResult.rows.length > 0 && oldResult.rows[0].canvas_quiz_url !== canvas_quiz_url) {
                await setCanvasQuizProctorMode(req.session.lti, oldResult.rows[0].canvas_quiz_url, false);
            }
        }

        res.json({
            ...result.rows[0],
            canvas_sync_ok: canvasSync ? canvasSync.ok : null,
            canvas_sync_error: canvasSync && !canvasSync.ok ? canvasSync.error : null
        });
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
            // The student is back, so the deferred finalization queued by their
            // beforeunload beacon must not fire — it would assemble a partial video and
            // clear the chunks this resumed recording is about to extend.
            cancelPendingFinalization(session.id, 'student resumed the attempt');
            if (session.status === 'unexpected') {
                await pool.query("UPDATE exam_sessions SET status = 'started' WHERE id = $1", [session.id]);
                session.status = 'started';
            }

            // Determine next chunk index
            const chunkDir = path.join(os.tmpdir(), `chunks-${session.id}`);
            if (fs.existsSync(chunkDir)) {
                let maxIdx = -1;
                for (const file of fs.readdirSync(chunkDir)) {
                    const idx = parseChunkIndex(file);
                    if (idx !== null && idx > maxIdx) maxIdx = idx;
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
        if (!await assertSessionOwnership(req, res, exam_session_id)) return;
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

// Reassembling a MediaRecorder recording: chunk ordering, segment detection, and
// ffmpeg normalisation live in services/videoAssembly.js. See the comment at the
// top of that file for why the chunks cannot simply be concatenated.
const {
    parseChunkIndex,
    extractInitSegment,
    groupChunksIntoSegments,
    writeSegmentFile,
    readOrderedChunks,
    transcodeSegmentToMp4,
    concatMp4Segments
} = require('./services/videoAssembly');

async function logSessionEvent(exam_session_id, event_type, event_message) {
    try {
        await pool.query(
            'INSERT INTO proctor_logs (exam_session_id, event_type, event_message) VALUES ($1, $2, $3)',
            [exam_session_id, event_type, event_message]
        );
    } catch (err) {
        console.error(`[Assemble] Failed to write ${event_type} log for session ${exam_session_id}:`, err.message);
    }
}

function cancelPendingFinalization(exam_session_id, reason) {
    const timer = pendingFinalizations.get(exam_session_id);
    if (timer) {
        clearTimeout(timer);
        pendingFinalizations.delete(exam_session_id);
        console.log(`[Finalize] Cancelled deferred finalization for session ${exam_session_id} (${reason}).`);
    }
}

// Called when a student's page goes away without a clean submit. Waits out the
// grace period, then assembles only if the attempt really is over.
function scheduleUnexpectedFinalization(exam_session_id, total_chunks) {
    cancelPendingFinalization(exam_session_id, 'rescheduling');

    const timer = setTimeout(async () => {
        pendingFinalizations.delete(exam_session_id);
        try {
            const statusResult = await pool.query('SELECT status FROM exam_sessions WHERE id = $1', [exam_session_id]);
            const status = statusResult.rows.length > 0 ? statusResult.rows[0].status : null;
            if (status !== 'unexpected') {
                console.log(`[Finalize] Session ${exam_session_id} is now '${status}' — the clean end path owns assembly. Skipping.`);
                return;
            }

            // Chunks still arriving means the recording is alive; give it longer.
            const chunkDir = path.join(os.tmpdir(), `chunks-${exam_session_id}`);
            if (fs.existsSync(chunkDir)) {
                const newest = fs.readdirSync(chunkDir)
                    .map(f => {
                        try { return fs.statSync(path.join(chunkDir, f)).mtimeMs; } catch (e) { return 0; }
                    })
                    .reduce((max, ms) => Math.max(max, ms), 0);
                if (newest > 0 && Date.now() - newest < 60000) {
                    console.log(`[Finalize] Session ${exam_session_id} is still receiving chunks. Deferring again.`);
                    scheduleUnexpectedFinalization(exam_session_id, total_chunks);
                    return;
                }
            }

            console.log(`[Finalize] Grace period elapsed for session ${exam_session_id}. Assembling abandoned attempt.`);
            await logSessionEvent(exam_session_id, 'warning',
                'Attempt ended without a clean submit. The recording was assembled from the chunks that reached the server.');
            assembleAndUploadSessionVideo(exam_session_id, total_chunks);
        } catch (err) {
            console.error(`[Finalize] Deferred finalization failed for session ${exam_session_id}:`, err.message);
        }
    }, UNEXPECTED_EXIT_GRACE_MS);

    pendingFinalizations.set(exam_session_id, timer);
    console.log(`[Finalize] Deferred finalization for session ${exam_session_id} by ${UNEXPECTED_EXIT_GRACE_MS / 1000}s in case the student resumes.`);
}

// Helper to assemble and upload video chunks in the background
async function assembleAndUploadSessionVideo(exam_session_id, total_chunks) {
    if (activeAssemblies.has(exam_session_id)) {
        console.log(`[Assemble] Assembly already in progress for session ${exam_session_id}. Aborting duplicate request.`);
        return;
    }
    activeAssemblies.add(exam_session_id);

    try {
        const chunkDir = path.join(os.tmpdir(), `chunks-${exam_session_id}`);

        // Wait for the expected chunks to land on disk.
        //
        // `total_chunks` is the client's final chunk *index*, and after a resume
        // that index continues from where the previous run stopped — so it is not a
        // count of files. The old comparison (`files.length >= expected`) therefore
        // matched early on a resumed session and late on one that lost a chunk. Wait
        // on the highest index instead, and keep waiting while the sequence still
        // has holes, since a hole is what truncates the video.
        if (total_chunks !== undefined && total_chunks !== null) {
            const expected = parseInt(total_chunks, 10);
            console.log(`[Assemble] Expecting chunks up to #${expected} for session ${exam_session_id}. Waiting for chunks...`);
            const startWait = Date.now();
            while (Date.now() - startWait < 60000) {
                if (fs.existsSync(chunkDir)) {
                    const indices = fs.readdirSync(chunkDir)
                        .map(parseChunkIndex)
                        .filter(i => i !== null);
                    if (indices.length > 0) {
                        const highest = Math.max(...indices);
                        const lowest = Math.min(...indices);
                        const contiguous = indices.length === (highest - lowest + 1);
                        if (highest >= expected && contiguous) {
                            console.log(`[Assemble] All chunks up to #${expected} are present and contiguous.`);
                            break;
                        }
                    }
                }
                await new Promise(r => setTimeout(r, 500));
            }
        }

        if (!fs.existsSync(chunkDir)) {
            console.log(`No local chunks found for session ${exam_session_id}`);
            await logSessionEvent(exam_session_id, 'system_error',
                'No recording chunks were found on the server for this attempt. No video could be produced.');
            return;
        }

        console.log(`Assembling video for session ${exam_session_id}...`);
        
        const orderedChunks = readOrderedChunks(chunkDir);

        if (orderedChunks.length === 0) {
            console.log(`No chunk files in directory for session ${exam_session_id}`);
            await logSessionEvent(exam_session_id, 'system_error',
                'The recording directory for this attempt contained no usable chunks. No video could be produced.');
            return;
        }
        const files = orderedChunks.map(entry => entry.file);

        // Get student/exam info for nice filename and mime type
        const sessionInfo = await pool.query(`
            SELECT es.student_name, es.attempt_number, es.started_at, es.recording_started_at, es.end_time, es.mime_type, es.mobile_mime_type, e.title, e.require_mobile_camera
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
        let sessionEndMs = 0;
        let setupLeadInSec = 0;

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
            // The video timeline starts when the recorder started, not when the
            // session row was created. Fall back to started_at for attempts
            // recorded before recording_started_at existed.
            if (s.recording_started_at) {
                sessionStartMs = new Date(s.recording_started_at).getTime();
            } else if (s.started_at) {
                sessionStartMs = new Date(s.started_at).getTime();
            }
            setupLeadInSec = (s.recording_started_at && s.started_at)
                ? Math.max(0, (new Date(s.recording_started_at).getTime() - new Date(s.started_at).getTime()) / 1000)
                : 0;
            sessionEndMs = s.end_time ? new Date(s.end_time).getTime() : Date.now();
            mimeTypeFromDb = s.mime_type || 'video/webm';
        }

        const isWebm = mimeTypeFromDb.includes('webm');
        const rawExt = isWebm ? 'webm' : 'mp4';

        console.log(`[Assemble] Found ${files.length} chunk files in ${chunkDir}`);
        for (const entry of orderedChunks) {
            const stats = fs.statSync(path.join(chunkDir, entry.file));
            console.log(`[Assemble] Chunk file ${entry.file} size: ${stats.size} bytes`);
        }

        // Split the chunks into independently decodable runs before touching ffmpeg.
        const segments = groupChunksIntoSegments(chunkDir, orderedChunks);
        const lowestIndex = orderedChunks[0].index;
        const highestIndex = orderedChunks[orderedChunks.length - 1].index;
        const missingCount = (highestIndex - lowestIndex + 1) - orderedChunks.length;

        console.log(`[Assemble] Session ${exam_session_id}: chunks #${lowestIndex}-#${highestIndex}, ` +
            `${segments.length} recorder segment(s), ${missingCount} missing chunk(s).`);
        segments.forEach((seg, i) => {
            console.log(`[Assemble]   segment ${i + 1}: chunks #${seg.startIndex}-#${seg.endIndex} ` +
                `(${seg.files.length} files, ownHeader=${seg.hasOwnHeader}, gapBefore=${seg.precededByGap})`);
        });

        if (missingCount > 0) {
            await logSessionEvent(exam_session_id, 'warning',
                `Recording gap: ${missingCount} of ${highestIndex - lowestIndex + 1} expected chunks never reached the server ` +
                `(likely a network failure on the student's side). The video skips the affected moments.`);
        }

        // Runs that start after a gap have no header of their own. Recover them by
        // prefixing the initialisation bytes from the run that did have one, so a
        // dropped chunk costs the seconds around it instead of the rest of the exam.
        let initSegment = null;
        const headerSegment = segments.find(seg => seg.hasOwnHeader);
        if (headerSegment) {
            initSegment = extractInitSegment(path.join(chunkDir, headerSegment.files[0]));
            if (initSegment) {
                console.log(`[Assemble] Extracted ${initSegment.length}-byte init segment for header recovery.`);
            }
        }

        // Write each run out as its own container.
        const segmentRawPaths = [];
        const skippedSegments = [];
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const segPath = path.join(os.tmpdir(), `session-${exam_session_id}-seg${i}-raw.${rawExt}`);
            const written = writeSegmentFile(chunkDir, seg, segPath, initSegment);
            if (!written) {
                console.warn(`[Assemble] Segment ${i + 1} (chunks #${seg.startIndex}-#${seg.endIndex}) has no header and no init segment to borrow. Skipping.`);
                skippedSegments.push(seg);
                continue;
            }
            const stats = fs.statSync(segPath);
            console.log(`[Assemble] Segment ${i + 1} raw path: ${segPath}, size: ${stats.size} bytes` +
                (seg.needsInit ? ' (header recovered)' : ''));
            segmentRawPaths.push(segPath);
        }

        if (skippedSegments.length > 0) {
            const lostChunks = skippedSegments.reduce((sum, seg) => sum + seg.files.length, 0);
            await logSessionEvent(exam_session_id, 'system_error',
                `Recording damage: ${lostChunks} uploaded chunk(s) across ${skippedSegments.length} span(s) could not be decoded ` +
                `because no stream header was ever received for them. That footage is missing from the video.`);
        }

        if (segmentRawPaths.length === 0) {
            throw new Error(`No decodable recorder segments for session ${exam_session_id} (${orderedChunks.length} chunks on disk).`);
        }

        let tempOutFile = path.join(os.tmpdir(), `session-${exam_session_id}.${isWebm ? 'webm' : 'mp4'}`);
        let finalMimeType = mimeTypeFromDb;
        let finalExt = isWebm ? 'webm' : 'mp4';
        let assembledDurationSec = 0;

        // More than one segment can only be joined after each is normalised, so a
        // resumed recording is transcoded whether or not TRANSCODE_TO_MP4 is set, and
        // regardless of the source container. Concatenating two recorder runs at the
        // byte level gives the second run's timestamps a fresh start, so the file
        // reports the length of the first run and players stop there — that is the bug
        // this exists to prevent, and taking only the first segment instead would
        // discard the rest of the attempt outright.
        const mustTranscode = segmentRawPaths.length > 1;
        const wantTranscode = process.env.TRANSCODE_TO_MP4 === 'true';

        if (mustTranscode || (isWebm && wantTranscode)) {
            if (mustTranscode && !wantTranscode) {
                console.log(`[Assemble] ${segmentRawPaths.length} recorder segments present — transcoding despite TRANSCODE_TO_MP4 being off, since raw concatenation would truncate playback.`);
            } else {
                console.log(`[Assemble] TRANSCODE_TO_MP4 is enabled. Transcoding to MP4 for session ${exam_session_id}...`);
            }
            const mp4OutFile = path.join(os.tmpdir(), `session-${exam_session_id}.mp4`);
            const segmentMp4Paths = [];
            try {
                // Transcode each run independently and keep going if one fails. A
                // damaged span in the middle of an attempt should cost that span, not
                // the whole recording.
                for (let i = 0; i < segmentRawPaths.length; i++) {
                    const segMp4 = path.join(os.tmpdir(), `session-${exam_session_id}-seg${i}.mp4`);
                    try {
                        const segDuration = await transcodeSegmentToMp4(segmentRawPaths[i], segMp4);
                        if (segDuration <= 0 || !fs.existsSync(segMp4) || fs.statSync(segMp4).size === 0) {
                            throw new Error('produced no decodable output');
                        }
                        console.log(`[Assemble] Segment ${i + 1}/${segmentRawPaths.length} transcoded: ${segDuration.toFixed(1)}s`);
                        segmentMp4Paths.push(segMp4);
                        assembledDurationSec += segDuration;
                    } catch (segErr) {
                        console.error(`[Assemble] Segment ${i + 1}/${segmentRawPaths.length} failed (${segErr.message}). Continuing with the remaining segments.`);
                        try { if (fs.existsSync(segMp4)) fs.unlinkSync(segMp4); } catch (e) {}
                        await logSessionEvent(exam_session_id, 'system_error',
                            `A span of the recording (segment ${i + 1} of ${segmentRawPaths.length}) could not be decoded ` +
                            `and is missing from the video.`);
                    }
                }

                if (segmentMp4Paths.length === 0) {
                    throw new Error('no segment produced decodable output');
                }

                if (segmentMp4Paths.length === 1) {
                    fs.renameSync(segmentMp4Paths[0], mp4OutFile);
                } else {
                    const concatDuration = await concatMp4Segments(segmentMp4Paths, mp4OutFile, os.tmpdir());
                    if (concatDuration > 0) assembledDurationSec = concatDuration;
                    for (const segMp4 of segmentMp4Paths) {
                        try { if (fs.existsSync(segMp4)) fs.unlinkSync(segMp4); } catch (e) {}
                    }
                }

                console.log(`Successfully transcoded to MP4 for session ${exam_session_id} (${assembledDurationSec.toFixed(1)}s)`);
                tempOutFile = mp4OutFile;
                finalMimeType = 'video/mp4';
                finalExt = 'mp4';
            } catch (transcodeErr) {
                console.error(`Transcoding failed for session ${exam_session_id}, falling back to the raw recording:`, transcodeErr.message);
                const droppedSegments = segmentRawPaths.length - 1;
                await logSessionEvent(exam_session_id, 'system_error',
                    `Video transcoding failed (${transcodeErr.message}). The raw recording was preserved instead` +
                    (droppedSegments > 0
                        ? `, but only the first of ${segmentRawPaths.length} recorded spans could be kept — the video is incomplete.`
                        : `; it may not play past the first interruption.`));
                for (const segMp4 of segmentMp4Paths) {
                    try { if (fs.existsSync(segMp4)) fs.unlinkSync(segMp4); } catch (e) {}
                }
                tempOutFile = path.join(os.tmpdir(), `session-${exam_session_id}.${rawExt}`);
                fs.copyFileSync(segmentRawPaths[0], tempOutFile);
                finalMimeType = isWebm ? 'video/webm' : 'video/mp4';
                finalExt = rawExt;
            }
        } else {
            console.log(`[Assemble] Direct upload mode (no transcoding) for session ${exam_session_id}`);
            fs.renameSync(segmentRawPaths[0], tempOutFile);
        }

        for (const segRaw of segmentRawPaths) {
            try { if (fs.existsSync(segRaw)) fs.unlinkSync(segRaw); } catch (e) {}
        }

        // Compare what we produced against the window the recorder was actually
        // running. ffmpeg exits 0 when it stops early at corruption, so output
        // length is the only honest signal that footage went missing.
        //
        // Measuring from started_at instead made this fire on healthy attempts:
        // setup (camera warm-up, quiz load) happens before any footage exists, so
        // a 38-second session with a 13-second lead-in legitimately yields a
        // 25-second video. That is not loss, and reporting it as loss trains the
        // instructor to ignore the warning that matters.
        if (assembledDurationSec > 0 && sessionStartMs && sessionEndMs > sessionStartMs) {
            const recordedWindowSec = (sessionEndMs - sessionStartMs) / 1000;
            const coverage = assembledDurationSec / recordedWindowSec;
            console.log(`[Assemble] Session ${exam_session_id}: video ${assembledDurationSec.toFixed(1)}s vs ` +
                `recording window ${recordedWindowSec.toFixed(1)}s (${Math.round(coverage * 100)}% coverage; ` +
                `${setupLeadInSec.toFixed(1)}s setup lead-in excluded).`);
            if (recordedWindowSec > 30 && coverage < 0.85) {
                const shortfall = Math.round(recordedWindowSec - assembledDurationSec);
                console.warn(`[Assemble] Session ${exam_session_id} video is short by ${shortfall}s.`);
                await logSessionEvent(exam_session_id, 'system_error',
                    `Recording is shorter than the monitored window: ${Math.round(assembledDurationSec)}s of video for ` +
                    `${Math.round(recordedWindowSec)}s of recording (${Math.round(coverage * 100)}% covered, ` +
                    `${shortfall}s missing). This excludes the ${Math.round(setupLeadInSec)}s of setup before recording ` +
                    `began, so it reflects genuinely lost footage. Check the gap and upload warnings on this timeline.`);
            }
        }

        // Recorded once per attempt so the instructor can reconcile the video
        // length against the attempt length without assuming loss.
        if (setupLeadInSec >= 3) {
            await logSessionEvent(exam_session_id, 'info',
                `Recording began ${Math.round(setupLeadInSec)}s after the attempt started (camera warm-up and quiz load). ` +
                `The video is expected to be about that much shorter than the attempt duration.`);
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

            // The secondary recording goes through the same segment-aware pipeline as
            // the primary one. It previously used naive byte concatenation with no
            // gap or header handling, and derived its container from the *desktop*
            // mime type — so a phone recording MP4 inside a WebM session produced a
            // file labelled .webm that nothing could play.
            const mobileChunkDir = path.join(os.tmpdir(), `chunks-mobile-${exam_session_id}`);
            if (fs.existsSync(mobileChunkDir)) {
                console.log(`[Assemble] Assembling mobile video for session ${exam_session_id}...`);
                const mobileMime = (sessionInfo.rows[0].mobile_mime_type) || mimeTypeFromDb || 'video/webm';
                const mobileIsWebm = mobileMime.includes('webm');
                const mobileRawExt = mobileIsWebm ? 'webm' : 'mp4';

                const mobileOrdered = readOrderedChunks(mobileChunkDir);
                if (mobileOrdered.length > 0) {
                    const mobileSegments = groupChunksIntoSegments(mobileChunkDir, mobileOrdered);
                    const mobileHeaderSeg = mobileSegments.find(s => s.hasOwnHeader);
                    const mobileInit = mobileHeaderSeg
                        ? extractInitSegment(path.join(mobileChunkDir, mobileHeaderSeg.files[0]))
                        : null;

                    const mobileLowest = mobileOrdered[0].index;
                    const mobileHighest = mobileOrdered[mobileOrdered.length - 1].index;
                    const mobileMissing = (mobileHighest - mobileLowest + 1) - mobileOrdered.length;
                    console.log(`[Assemble] Mobile: chunks #${mobileLowest}-#${mobileHighest}, ` +
                        `${mobileSegments.length} segment(s), ${mobileMissing} missing.`);
                    if (mobileMissing > 0) {
                        await logSessionEvent(exam_session_id, 'warning',
                            `Secondary camera gap: ${mobileMissing} chunk(s) never reached the server. ` +
                            `The secondary recording skips those moments.`);
                    }

                    const mobileRawPaths = [];
                    for (let i = 0; i < mobileSegments.length; i++) {
                        const p = path.join(os.tmpdir(), `session-${exam_session_id}-mobile-seg${i}-raw.${mobileRawExt}`);
                        if (writeSegmentFile(mobileChunkDir, mobileSegments[i], p, mobileInit)) {
                            mobileRawPaths.push(p);
                        } else {
                            console.warn(`[Assemble] Mobile segment ${i + 1} has no usable header. Skipping.`);
                        }
                    }

                    let tempMobileOutFile = null;
                    let mobileFinalMime = mobileMime;
                    let mobileFinalExt = mobileRawExt;

                    if (mobileRawPaths.length === 0) {
                        console.error(`[Assemble] No decodable mobile segments for session ${exam_session_id}.`);
                        await logSessionEvent(exam_session_id, 'system_error',
                            'The secondary camera recording could not be decoded and no video was produced for it.');
                    } else if (mobileRawPaths.length > 1 || process.env.TRANSCODE_TO_MP4 === 'true') {
                        const mp4MobileOut = path.join(os.tmpdir(), `session-${exam_session_id}-mobile.mp4`);
                        const mobileMp4s = [];
                        try {
                            for (let i = 0; i < mobileRawPaths.length; i++) {
                                const segMp4 = path.join(os.tmpdir(), `session-${exam_session_id}-mobile-seg${i}.mp4`);
                                try {
                                    const dur = await transcodeSegmentToMp4(mobileRawPaths[i], segMp4);
                                    if (dur <= 0) throw new Error('no decodable output');
                                    mobileMp4s.push(segMp4);
                                } catch (segErr) {
                                    console.error(`[Assemble] Mobile segment ${i + 1} failed: ${segErr.message}`);
                                    try { if (fs.existsSync(segMp4)) fs.unlinkSync(segMp4); } catch (e) {}
                                }
                            }
                            if (mobileMp4s.length === 0) throw new Error('no mobile segment decoded');
                            if (mobileMp4s.length === 1) {
                                fs.renameSync(mobileMp4s[0], mp4MobileOut);
                            } else {
                                await concatMp4Segments(mobileMp4s, mp4MobileOut, os.tmpdir());
                                for (const m of mobileMp4s) {
                                    try { if (fs.existsSync(m)) fs.unlinkSync(m); } catch (e) {}
                                }
                            }
                            tempMobileOutFile = mp4MobileOut;
                            mobileFinalMime = 'video/mp4';
                            mobileFinalExt = 'mp4';
                        } catch (transErr) {
                            console.error("Mobile transcode failed, falling back to the raw first segment:", transErr.message);
                            tempMobileOutFile = path.join(os.tmpdir(), `session-${exam_session_id}-mobile.${mobileRawExt}`);
                            fs.copyFileSync(mobileRawPaths[0], tempMobileOutFile);
                        }
                    } else {
                        tempMobileOutFile = path.join(os.tmpdir(), `session-${exam_session_id}-mobile.${mobileRawExt}`);
                        fs.copyFileSync(mobileRawPaths[0], tempMobileOutFile);
                    }

                    for (const p of mobileRawPaths) {
                        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
                    }

                    if (tempMobileOutFile) {
                        const driveMobileFileName = `${studentName}_${examTitle}_Session_${exam_session_id}_Attempt_${attempt}_Secondary.${mobileFinalExt}`;
                        console.log(`Uploading secondary mobile video ${driveMobileFileName} to Google Drive...`);
                        try {
                            mobileDriveFileId = await uploadVideoToDrive(tempMobileOutFile, driveMobileFileName, mobileFinalMime, attemptFolderId);
                            console.log(`Uploaded secondary mobile video. File ID: ${mobileDriveFileId}`);
                        } catch(upErr) {
                            console.error("Failed to upload secondary mobile video:", upErr);
                        }
                        try { if (fs.existsSync(tempMobileOutFile)) fs.unlinkSync(tempMobileOutFile); } catch(e){}
                    }

                    // Delete only the chunks consumed, matching the primary path.
                    try {
                        for (const entry of mobileOrdered) {
                            const fp = path.join(mobileChunkDir, entry.file);
                            try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) {}
                        }
                        if (fs.existsSync(mobileChunkDir) && fs.readdirSync(mobileChunkDir).length === 0) {
                            fs.rmdirSync(mobileChunkDir);
                        }
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
        // Delete only the chunks this run actually consumed.
        //
        // This used to `rmSync` the whole directory. Assembly takes minutes — folder
        // creation, transcode, two Drive uploads — and a student who reloaded and
        // resumed is appending new chunks to that same directory the entire time.
        // Wiping it recursively at the end therefore deleted live footage, including
        // the header chunk the resumed run needed, which is how a long attempt ended
        // up as an unplayable or near-empty video.
        try {
            for (const file of files) {
                const filePath = path.join(chunkDir, file);
                try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
            }
            const remaining = fs.existsSync(chunkDir) ? fs.readdirSync(chunkDir) : [];
            if (remaining.length === 0) {
                try { fs.rmdirSync(chunkDir); } catch (e) {}
            } else {
                console.log(`[Assemble] Kept ${remaining.length} chunk(s) in ${chunkDir} that arrived after assembly began.`);
            }
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
        if (!await assertSessionOwnership(req, res, exam_session_id)) return;
        if (exit_type === 'unexpected') {
            console.log(`[End Session] Unexpected exit for session ${exam_session_id}`);
            await pool.query("UPDATE exam_sessions SET status = 'unexpected', end_time = COALESCE(end_time, NOW()) WHERE id = $1", [exam_session_id]);
            
            const examIdQuery = await pool.query('SELECT exam_id FROM exam_sessions WHERE id=$1', [exam_session_id]);
            if (examIdQuery.rows.length > 0) {
                io.to('teacher_' + examIdQuery.rows[0].exam_id).emit('student_status', { 
                    session_id: exam_session_id, status: 'unexpected' 
                });
            }
            // Assemble whatever chunks made it to disk — mobile browsers often die via
            // beforeunload/sendBeacon without a clean "completed" end, which previously
            // left drive_file_id null and Review Center showing "No Video".
            //
            // But do it on a delay. This beacon fires for an abandoned attempt AND for
            // a plain page reload, and the two are indistinguishable at this point.
            // Assembling immediately meant a student who reloaded mid-exam had their
            // chunk directory assembled and then deleted while the resumed recording
            // was still writing into it, which truncated the video to whatever had been
            // recorded before the reload. Resuming cancels this timer; a clean submit
            // supersedes it.
            const chunksHint = total_chunks !== undefined && total_chunks !== null
                ? total_chunks
                : undefined;
            console.log(`[End Session] Unexpected exit for session ${exam_session_id} — deferring assembly in case of resume`);
            scheduleUnexpectedFinalization(exam_session_id, chunksHint);
            return res.json({ success: true });
        }

        const finalStatus = status || 'completed';
        cancelPendingFinalization(exam_session_id, 'clean session end');
        console.log(`[End Session] Ending session ${exam_session_id} with status: ${finalStatus}, total_chunks expected: ${total_chunks}`);
        // Stamp end_time on the clean path too. It was only ever set on the
        // unexpected-exit path, so a normally submitted attempt had a NULL end
        // time and anything measuring attempt length had to guess.
        await pool.query(
            'UPDATE exam_sessions SET status=$1, end_time = COALESCE(end_time, NOW()) WHERE id=$2',
            [finalStatus, exam_session_id]
        );
        
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
                cancelPendingFinalization(session.id, 'external submit');

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

// API: Record the container the phone is recording in.
//
// The mobile assembly derived its extension from the session's mime_type, which is
// set by the *desktop* recorder. A phone recording MP4 inside a WebM session was
// therefore assembled and uploaded with the wrong container, which players reject.
app.post('/api/session/mobile-format', async (req, res) => {
    try {
        const { token, mime_type } = req.body;
        if (!token) return res.status(400).json({ error: 'Missing token' });
        const ltiResult = await pool.query('SELECT exam_session_id FROM lti_sessions WHERE session_token = $1', [token]);
        if (ltiResult.rows.length === 0 || !ltiResult.rows[0].exam_session_id) {
            return res.status(404).json({ error: 'No active exam session for this token' });
        }
        await pool.query(
            'UPDATE exam_sessions SET mobile_mime_type = $1 WHERE id = $2',
            [mime_type || 'video/webm', ltiResult.rows[0].exam_session_id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[Mobile Format] Error:', err.message);
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
        if (!await assertSessionOwnership(req, res, exam_session_id)) return;
        if (!base64_video) throw new Error("Video payload was empty");

        const index = parseInt(chunk_index, 10);
        if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid chunk index: ${chunk_index}`);

        // Write chunk data to local temporary directory instead of DB
        const chunkDir = path.join(os.tmpdir(), `chunks-${exam_session_id}`);
        if (!fs.existsSync(chunkDir)) {
            fs.mkdirSync(chunkDir, { recursive: true });
            console.log(`[Upload Chunk] Created temporary chunk directory: ${chunkDir}`);
        }

        const chunkPath = path.join(chunkDir, `chunk-${String(index).padStart(5, '0')}.dat`);
        const pureB64 = base64_video.replace(/^data:[^,]+,/, '').replace(/\s/g, '');

        // A base64 body whose length is not a multiple of 4 was cut off in transit —
        // by a proxy body limit or a dropped connection. Node would decode it
        // partially and silently, leaving a corrupt chunk that breaks the stream from
        // there on. Reject it so the client's retry can deliver it intact.
        if (pureB64.length === 0 || pureB64.length % 4 !== 0) {
            throw new Error(`Chunk #${index} payload is truncated (${pureB64.length} base64 chars).`);
        }

        // Write to a temp name and rename into place: assembly reads this directory
        // concurrently, and a half-written file looks exactly like a corrupt chunk.
        const stagingPath = `${chunkPath}.part`;
        fs.writeFileSync(stagingPath, pureB64, 'base64');
        fs.renameSync(stagingPath, chunkPath);
        console.log(`[Upload Chunk] Saved chunk #${index} for session ${exam_session_id} (${fs.statSync(chunkPath).size} bytes)`);

        res.json({ success: true });
    } catch (err) {
        console.error('Upload Error', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Mark the moment recording actually started.
//
// Called by the client immediately after mediaRecorder.start(), which is the
// first instant any footage exists. Everything that compares the video against
// the attempt — the shortfall check, the log timeline's video markers — anchors
// here rather than to started_at, otherwise the setup time gets counted as
// missing footage and every marker points a few seconds early.
app.post('/api/session/recording-started', requireAuth, async (req, res) => {
    try {
        const { exam_session_id } = req.body;
        if (!await assertSessionOwnership(req, res, exam_session_id)) return;
        // COALESCE so a resumed attempt keeps the original recording start.
        await pool.query(
            'UPDATE exam_sessions SET recording_started_at = COALESCE(recording_started_at, NOW()) WHERE id = $1',
            [exam_session_id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[Recording Started] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API: Record the chosen MIME type for the session
app.patch('/api/session/:id/format', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { mime_type } = req.body;
        if (!await assertSessionOwnership(req, res, id)) return;
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
            // Prefer live filesystem chunks (current upload path writes here), then legacy DB.
            const chunkDir = path.join(os.tmpdir(), `chunks-${session_id}`);
            if (fs.existsSync(chunkDir)) {
                // Live monitoring fallback: order by chunk index and stop at the first
                // hole, since a WebM stream is unreadable past a missing chunk anyway.
                const ordered = fs.readdirSync(chunkDir)
                    .map(file => ({ file, index: parseChunkIndex(file) }))
                    .filter(entry => entry.index !== null)
                    .sort((a, b) => a.index - b.index);

                const contiguous = [];
                for (const entry of ordered) {
                    if (contiguous.length > 0 && entry.index !== contiguous[contiguous.length - 1].index + 1) break;
                    contiguous.push(entry);
                }

                if (contiguous.length > 0) {
                    console.log(`[Playback] Assembling ${contiguous.length} of ${ordered.length} local disk chunks for session ${session_id}`);
                    const binaryChunks = contiguous.map(entry => fs.readFileSync(path.join(chunkDir, entry.file)));
                    masterBuffer = Buffer.concat(binaryChunks);
                }
            }
            if (!masterBuffer) {
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
        
        // recording_started_at is needed by the report view: the video timeline starts
        // when the recorder started, not when the attempt did, and without it every
        // "click to seek" flag lands late by the setup lead-in.
        const sessions = await pool.query('SELECT id, exam_id, student_canvas_id, student_name, status, started_at, recording_started_at, end_time, attempt_number, video_archived, drive_file_id, mobile_drive_file_id FROM exam_sessions WHERE exam_id = $1', [exam_id]);
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

// ================================================================
// Socket authentication
//
// This layer had none. `cors: { origin: '*' }` plus an open `connection` handler
// meant anyone who could reach the host — from any website, or curl — could emit
// `join_teacher(<exam_id>)` and start receiving student names, live proctor logs
// and `snapshot_update` webcam frames, with exam ids being small sequential
// integers. It was writable too: `proctor_log` inserted straight into the database
// from the payload, so integrity violations could be fabricated against any
// session by an unauthenticated stranger, and `instructor_warning` could put
// arbitrary text on any student's screen mid-exam.
//
// Identity now comes from one of two places, never from the payload:
//   * the express session cookie (instructor dashboard, and students whose
//     third-party cookies survive the Canvas iframe), or
//   * an LTI session token passed in the handshake, which is what the student
//     page and the mobile camera page use since their cookies often do not
//     survive that iframe.
//
// Every handler below authorizes against `socket.pgAuth` and derives ids from it.
// ================================================================
function runSessionMiddleware(socket) {
    return new Promise((resolve) => {
        sessionMiddleware(socket.request, {}, () => resolve());
    });
}

io.use(async (socket, next) => {
    try {
        // 1. Cookie-based session (instructor dashboard).
        try {
            await runSessionMiddleware(socket);
        } catch (e) { /* no usable cookie; fall through to token */ }

        const sess = socket.request.session;
        if (sess && sess.lti && sess.lti.userId) {
            socket.pgAuth = {
                userId: sess.lti.userId,
                role: sess.lti.role,
                courseId: sess.lti.canvasCourseId,
                altCourseId: sess.lti.alternativeCourseId || '',
                sessionToken: sess.lti.sessionToken || null,
                via: 'cookie'
            };
            return next();
        }

        // 2. Handshake token (student page, mobile camera page).
        const token = socket.handshake.auth && socket.handshake.auth.token;
        if (token) {
            const result = await pool.query(
                'SELECT * FROM lti_sessions WHERE session_token = $1 AND expires_at > NOW()',
                [token]
            );
            if (result.rows.length > 0) {
                const s = result.rows[0];
                socket.pgAuth = {
                    userId: s.canvas_user_id,
                    role: s.user_role,
                    courseId: s.canvas_course_id,
                    altCourseId: s.alternative_canvas_course_id || '',
                    sessionToken: s.session_token,
                    examSessionId: s.exam_session_id || null,
                    via: 'token'
                };
                return next();
            }
        }

        console.warn('[Socket] Rejected unauthenticated connection.');
        return next(new Error('unauthorized'));
    } catch (err) {
        console.error('[Socket] Auth error:', err.message);
        return next(new Error('unauthorized'));
    }
});

const isInstructorSocket = (socket) => socket.pgAuth && socket.pgAuth.role === 'instructor';

// Confirm the caller owns this exam_session before letting them write to it.
async function socketOwnsSession(socket, exam_session_id) {
    if (!socket.pgAuth || !exam_session_id) return false;
    try {
        const r = await pool.query(
            'SELECT id FROM exam_sessions WHERE id = $1 AND student_canvas_id = $2',
            [exam_session_id, socket.pgAuth.userId]
        );
        return r.rows.length > 0;
    } catch (e) {
        return false;
    }
}

// Confirm an instructor may view this exam (same Canvas course).
async function instructorOwnsExam(socket, exam_id) {
    if (!isInstructorSocket(socket)) return false;
    try {
        const r = await pool.query('SELECT canvas_course_id FROM exams WHERE id = $1', [exam_id]);
        if (r.rows.length === 0) return false;
        const courseId = String(r.rows[0].canvas_course_id);
        return courseId === String(socket.pgAuth.courseId) ||
               (socket.pgAuth.altCourseId && courseId === String(socket.pgAuth.altCourseId));
    } catch (e) {
        return false;
    }
}

// Socket IO Real-Time
io.on('connection', (socket) => {
    socket.on('join_teacher', async (exam_id) => {
        // Was: anyone could join any exam's teacher room and receive student
        // names, logs and webcam snapshots.
        if (!await instructorOwnsExam(socket, exam_id)) {
            console.warn(`[Socket] Refused join_teacher for exam ${exam_id} (role=${socket.pgAuth && socket.pgAuth.role}).`);
            return;
        }
        socket.join('teacher_' + exam_id);
    });

    socket.on('join_lti', (data) => { // { token }
        // Only your own LTI room.
        if (!data || !data.token || !socket.pgAuth || data.token !== socket.pgAuth.sessionToken) return;
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
        if (!data || !data.token || !socket.pgAuth || data.token !== socket.pgAuth.sessionToken) return;
        io.to('lti_' + data.token).emit('mobile_start_record');
    });

    socket.on('laptop_end_exam', (data) => { // { token }
        if (!data || !data.token || !socket.pgAuth || data.token !== socket.pgAuth.sessionToken) return;
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

    socket.on('join_student', async (data) => { // { exam_id, exam_session_id, student_name }
        if (!data || !await socketOwnsSession(socket, data.exam_session_id)) {
            console.warn(`[Socket] Refused join_student for session ${data && data.exam_session_id}.`);
            return;
        }
        // Bind the verified session to the socket so later events need not trust
        // anything the client sends.
        socket.pgAuth.examSessionId = data.exam_session_id;
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
        // Only forward a snapshot for the session this socket has been bound to,
        // otherwise anyone could inject frames into a teacher's live view.
        if (!data || !socket.pgAuth || !socket.pgAuth.examSessionId) return;
        if (String(data.exam_session_id) !== String(socket.pgAuth.examSessionId)) return;
        io.to('teacher_' + data.exam_id).emit('snapshot_update', data);
    });

    socket.on('proctor_log', async (data) => {
        // data: { event_type, event_message }
        //
        // The session id is taken from the authenticated socket, never from the
        // payload. Previously this inserted whatever id it was handed, with no
        // authentication at all, which allowed fabricating integrity violations
        // against any student.
        if (!data || !socket.pgAuth) return;
        // The socket connects at page load, before /api/session/start has linked an
        // exam_session to the LTI token, so resolve it lazily the first time a log
        // arrives. Without this, everything logged during the pre-flight wizard
        // would be silently dropped.
        let sessionId = socket.pgAuth.examSessionId;
        if (!sessionId && socket.pgAuth.sessionToken) {
            try {
                const r = await pool.query(
                    'SELECT exam_session_id FROM lti_sessions WHERE session_token = $1',
                    [socket.pgAuth.sessionToken]
                );
                if (r.rows.length > 0 && r.rows[0].exam_session_id) {
                    sessionId = r.rows[0].exam_session_id;
                    socket.pgAuth.examSessionId = sessionId;
                }
            } catch (e) { /* fall through to the drop below */ }
        }
        if (!sessionId) return;
        try {
            await pool.query(
                'INSERT INTO proctor_logs (exam_session_id, event_type, event_message) VALUES ($1, $2, $3)',
                [sessionId, data.event_type, data.event_message]
            );
        } catch (err) {
            console.error('Failed to save proctor log:', err);
        }
    });

    socket.on('instructor_warning', async (data) => {
        // data: { exam_session_id, message }
        if (!data || !isInstructorSocket(socket)) return;
        try {
            const r = await pool.query('SELECT exam_id FROM exam_sessions WHERE id = $1', [data.exam_session_id]);
            if (r.rows.length === 0) return;
            if (!await instructorOwnsExam(socket, r.rows[0].exam_id)) return;
        } catch (e) { return; }
        io.to('student_' + data.exam_session_id).emit('instructor_warning', { message: data.message });
    });

    socket.on('instructor_broadcast', async (data) => {
        // data: { exam_id, message }
        if (!data || !await instructorOwnsExam(socket, data.exam_id)) return;
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
                        await pool.query(
                            "UPDATE exam_sessions SET status = $1, end_time = COALESCE(end_time, NOW()) WHERE id = $2",
                            [finalStatus, exam_session_id]
                        );
                        // This is the path a phone exam usually takes: the OS kills the
                        // tab, the socket drops, and no clean end call ever arrives. The
                        // client is gone, so there is no chunk-count hint to wait on —
                        // pass the highest index already on disk so assembly still waits
                        // for in-flight uploads instead of grabbing a partial set.
                        const onDisk = (() => {
                            try {
                                const dir = path.join(os.tmpdir(), `chunks-${exam_session_id}`);
                                if (!fs.existsSync(dir)) return undefined;
                                const idx = readOrderedChunks(dir);
                                return idx.length > 0 ? idx[idx.length - 1].index : undefined;
                            } catch (e) { return undefined; }
                        })();
                        assembleAndUploadSessionVideo(exam_session_id, onDisk);
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


// Startup security self-check. Warns loudly (never hard-fails, so a missing env var
// can't take the server down) when a secret is still at its insecure built-in default
// or a required credential is unset. In production these warnings mean forgeable tokens
// or a broken Canvas integration and should be treated as must-fix.
function auditSecretsAtStartup() {
    const isProd = process.env.NODE_ENV === 'production';
    const problems = [];
    if (JWT_SIGNING_KEY === 'dev-only-insecure-signing-key-DO-NOT-USE-IN-PRODUCTION') {
        problems.push('JWT_SIGNING_KEY is unset — extension tokens are forgeable. Set a long random value.');
    }
    if (AUTO_LOGIN_SIGNING_SECRET === 'dev-only-insecure-auto-login-secret') {
        problems.push('AUTO_LOGIN_SIGNING_SECRET is unset — student auto-login HMACs are forgeable. Set a long random value.');
    }
    if (CANVAS_LAUNCH_SECRET === 'canvas-proctor-shared-secret-key-998877') {
        problems.push('CANVAS_LAUNCH_SECRET is at its legacy default — rotate it (and every quiz launch URL + the Canvas quizzes_controller.rb patch) when convenient.');
    }
    if (!process.env.CANVAS_API_TOKEN) {
        problems.push('CANVAS_API_TOKEN is unset — Canvas API calls (setting Require-Proctor mode, syncing attempts) will no-op. Set the freshly-rotated token in .env.');
    }
    if (problems.length) {
        const banner = isProd ? '🔴 PRODUCTION SECURITY WARNINGS' : '🟠 dev security notes';
        console.warn(`\n${'='.repeat(60)}\n${banner}\n${'='.repeat(60)}`);
        problems.forEach(p => console.warn('  • ' + p));
        console.warn('='.repeat(60) + '\n');
    } else {
        console.log('[Startup] Secret audit passed — all signing keys and credentials are configured.');
    }
}

initDatabase().then(() => {
    auditSecretsAtStartup();
    server.listen(PORT, () => {
        console.log(`Secure Exam Proctor running on port ${PORT}`);
    });
}).catch(console.error);

// API: Upload Room Scan Video
app.post('/api/session/room-scan', requireAuth, async (req, res) => {
    const { exam_session_id, base64_video } = req.body;
    try {
        if (!base64_video) throw new Error("Video payload was empty");
        if (!await assertSessionOwnership(req, res, exam_session_id)) return;
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
        if (!await assertSessionOwnership(req, res, exam_session_id)) return;
        console.log(`[Upload ID] Received ID verification image for session ${exam_session_id}`);

        const idDir = path.join(os.tmpdir(), `id_images`);
        if (!fs.existsSync(idDir)) {
            fs.mkdirSync(idDir, { recursive: true });
        }

        const idPath = path.join(idDir, `id-${exam_session_id}.png`);
        const pureB64 = base64_image.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
        fs.writeFileSync(idPath, pureB64, 'base64');
        
        const idViewUrl = `/api/session/view-id/${exam_session_id}`;
        
        // Log ID image in proctor_logs so the dashboard / extension review center can fetch it.
        await pool.query(
            "INSERT INTO proctor_logs (exam_session_id, event_type, event_message, event_timestamp) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)", 
            [exam_session_id, 'verify_id_image', idViewUrl]
        );

        // Also mirror onto exam_sessions so session-report consumers that read
        // verify_id_image (extension review center, older clients) see it without
        // needing to scan logs.
        if (exam_session_id) {
            await pool.query(
                'UPDATE exam_sessions SET verify_id_image = $1 WHERE id = $2',
                [idViewUrl, exam_session_id]
            );
        }

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
        if (!await assertSessionOwnership(req, res, exam_session_id)) return;
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

        // Mirror onto exam_sessions for extension / session-report consumers.
        if (exam_session_id) {
            await pool.query(
                'UPDATE exam_sessions SET verify_signature_image = $1, verify_signature_name = $2 WHERE id = $3',
                [sigViewUrl, full_name || null, exam_session_id]
            );
        }

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


