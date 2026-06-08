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
const { uploadVideoToDrive, downloadVideoFromDrive, uploadLogsToDriveDoc, getFolderId } = require('./services/googleDrive');
const webmDurationFix = require('webm-duration-fix').default;
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

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
  <blti:title>Proctor Gateway</blti:title>
  <blti:description>Secure Proctoring environment for LMS Quizzes.</blti:description>
  <blti:launch_url>${baseUrl}/lti/launch</blti:launch_url>
  <blti:extensions platform="canvas.instructure.com">
    <lticm:property name="privacy_level">public</lticm:property>
    <lticm:property name="domain">${new URL(baseUrl).host}</lticm:property>
    <lticm:options name="course_navigation">
      <lticm:property name="enabled">true</lticm:property>
      <lticm:property name="text">Proctor Gateway</lticm:property>
      <lticm:property name="visibility">public</lticm:property>
      <lticm:property name="default">enabled</lticm:property>
      <lticm:property name="windowTarget">_self</lticm:property>
    </lticm:options>
    <lticm:options name="assignment_selection">
      <lticm:property name="enabled">true</lticm:property>
      <lticm:property name="text">Proctor Gateway Assignment</lticm:property>
      <lticm:property name="message_type">ContentItemSelectionRequest</lticm:property>
      <lticm:property name="url">${baseUrl}/lti/launch</lticm:property>
      <lticm:property name="selection_width">1000</lticm:property>
      <lticm:property name="selection_height">800</lticm:property>
    </lticm:options>
    <lticm:options name="link_selection">
      <lticm:property name="enabled">true</lticm:property>
      <lticm:property name="text">Proctor Gateway Module Item</lticm:property>
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
            let redirectUrl = `/index.html?resource_link_id=${encodeURIComponent(resourceLinkId)}`;
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
            res.redirect(`/student.html?token=${sessionToken}${resourceLinkId ? '&placement_id=' + encodeURIComponent(resourceLinkId) : ''}${queryExamId ? '&exam_id=' + encodeURIComponent(queryExamId) : ''}`);
        }
    });
});

app.get('/api/canvas-launch', async (req, res) => {
    const { user_id, user_name, course_id, quiz_id, secret } = req.query;
    if (secret !== 'canvas-proctor-shared-secret-key-998877') {
        return res.status(403).json({ error: 'Unauthorized Canvas Launch' });
    }
    if (!user_id || !course_id || !quiz_id) {
        return res.status(400).json({ error: 'Missing launch parameters' });
    }

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

        res.redirect(`/student.html?token=${sessionToken}&exam_id=${exam.id}`);
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
                    require_lockdown_browser_for_results: requireProctorMode
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
        const url = `${credentials.canvas_api_url}/courses/${courseId}/quizzes`;
        
        const fetchRes = await fetch(url, {
            headers: { Authorization: `Bearer ${credentials.canvas_api_token}` }
        });
        
        if (!fetchRes.ok) {
            const errText = await fetchRes.text();
            throw new Error(`Canvas API responded with status ${fetchRes.status}: ${errText}`);
        }
        
        const quizzes = await fetchRes.json();
        
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
        const { title, canvas_quiz_url, require_mic, require_camera, require_screen, disable_right_click, require_fullscreen, require_seb, max_attempts, exam_code, max_violations, canvas_quiz_password, disable_clipboard, disable_printing } = req.body;
        
        const result = await pool.query(`
            INSERT INTO exams (canvas_course_id, title, canvas_quiz_url, require_mic, require_camera, require_screen, disable_right_click, require_fullscreen, require_seb, max_attempts, exam_code, max_violations, canvas_quiz_password, disable_clipboard, disable_printing, is_open)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, false) RETURNING *
        `, [canvasCourseId, title, canvas_quiz_url, require_mic, require_camera, require_screen, disable_right_click, require_fullscreen, require_seb || false, max_attempts || 1, exam_code, max_violations || 0, canvas_quiz_password || '', disable_clipboard || false, disable_printing || false]);
        
        // Enable proctor mode requirements on the Canvas quiz itself
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

// API: Update Exam Settings
app.patch('/api/exams/:id', requireInstructor, async (req, res) => {
    try {
        const { id } = req.params;
        const { canvasCourseId, alternativeCourseId } = req.session.lti;
        const { 
            title, canvas_quiz_url, exam_code, max_attempts,
            require_camera, require_mic, require_screen,
            disable_right_click, require_fullscreen, require_seb,
            max_violations, canvas_quiz_password, disable_clipboard, disable_printing
        } = req.body;

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
                disable_clipboard = $13, disable_printing = $14, updated_at = NOW()
            WHERE id = $15 AND (canvas_course_id = $16 OR canvas_course_id = $17)
            RETURNING *
        `, [
            title, canvas_quiz_url, exam_code, max_attempts,
            require_camera, require_mic, require_screen,
            disable_right_click, require_fullscreen, require_seb,
            max_violations || 0, canvas_quiz_password || '', 
            disable_clipboard || false, disable_printing || false,
            id, canvasCourseId, alternativeCourseId || ''
        ]);

        if (result.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });

        // Update Canvas settings
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

// API: Get Exam details (For Student entering / pre-flight)
app.post('/api/exams/verify-code', requireAuth, async (req, res) => {
    try {
        const { canvasCourseId, alternativeCourseId, userId } = req.session.lti;
        const { exam_code } = req.body;
        
        const examResult = await pool.query('SELECT * FROM exams WHERE (canvas_course_id = $1 OR canvas_course_id = $2) AND exam_code = $3', [canvasCourseId, alternativeCourseId || '', exam_code]);
        if (examResult.rows.length === 0) return res.status(404).json({ error: 'Invalid exam code' });
        
        const exam = examResult.rows[0];
        
        if (!exam.is_open) {
            return res.status(403).json({ error: 'This exam is currently closed by the instructor.' });
        }
        
        const sessionCountQuery = await pool.query('SELECT COUNT(*) as attempt_count FROM exam_sessions WHERE exam_id = $1 AND student_canvas_id = $2', [exam.id, userId]);
        const attemptCount = parseInt(sessionCountQuery.rows[0].attempt_count, 10);
        
        const overrideQuery = await pool.query('SELECT extra_attempts FROM exam_overrides WHERE exam_id = $1 AND student_canvas_id = $2', [exam.id, userId]);
        const extraAttempts = overrideQuery.rows.length > 0 ? parseInt(overrideQuery.rows[0].extra_attempts, 10) : 0;
        
        const totalAllowed = (exam.max_attempts || 1) + extraAttempts;
        
        if (attemptCount >= totalAllowed) {
            return res.status(403).json({ error: `You have reached the maximum allowable attempts (${totalAllowed}) for this exam.` });
        }
        
        const crypto = require('crypto');
        const auto_login_user_id = userId;
        const auto_login_expires = Math.floor(Date.now() / 1000) + 300; // 5 minutes validity
        const secret = "canvas-proctor-shared-secret-key-998877";
        const signData = `auto_login_user_id=${auto_login_user_id}&expires=${auto_login_expires}`;
        const auto_login_signature = crypto.createHmac('sha256', secret).update(signData).digest('hex');

        res.json({
            ...exam,
            auto_login_user_id,
            auto_login_expires,
            auto_login_signature
        });
    } catch (err) {
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
        
        if (!exam.is_open) {
            return res.status(403).json({ error: 'This exam is currently closed by the instructor.' });
        }
        
        const sessionCountQuery = await pool.query('SELECT COUNT(*) as attempt_count FROM exam_sessions WHERE exam_id = $1 AND student_canvas_id = $2', [exam.id, userId]);
        const attemptCount = parseInt(sessionCountQuery.rows[0].attempt_count, 10);
        
        const overrideQuery = await pool.query('SELECT extra_attempts FROM exam_overrides WHERE exam_id = $1 AND student_canvas_id = $2', [exam.id, userId]);
        const extraAttempts = overrideQuery.rows.length > 0 ? parseInt(overrideQuery.rows[0].extra_attempts, 10) : 0;
        
        const totalAllowed = (exam.max_attempts || 1) + extraAttempts;
        
        if (attemptCount >= totalAllowed) {
            return res.status(403).json({ error: `You have reached the maximum allowable attempts (${totalAllowed}) for this exam.` });
        }
        
        const crypto = require('crypto');
        const auto_login_user_id = userId;
        const auto_login_expires = Math.floor(Date.now() / 1000) + 300; // 5 minutes validity
        const secret = "canvas-proctor-shared-secret-key-998877";
        const signData = `auto_login_user_id=${auto_login_user_id}&expires=${auto_login_expires}`;
        const auto_login_signature = crypto.createHmac('sha256', secret).update(signData).digest('hex');

        res.json({
            ...exam,
            auto_login_user_id,
            auto_login_expires,
            auto_login_signature
        });
    } catch (err) {
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

// API: Start Exam Session (Student)
app.post('/api/session/start', requireAuth, async (req, res) => {
    try {
        const { exam_id } = req.body;
        const { userId, userName } = req.session.lti;

        // Always create a new session since attempt constraints were checked in verify-code
        const countQuery = await pool.query('SELECT COUNT(*) as attempts FROM exam_sessions WHERE exam_id = $1 AND student_canvas_id = $2', [exam_id, userId]);
        const currentAttempts = parseInt(countQuery.rows[0].attempts, 10);
        const sessionResult = await pool.query(`
            INSERT INTO exam_sessions (exam_id, student_canvas_id, student_name, attempt_number)
            VALUES ($1, $2, $3, $4) RETURNING *
        `, [exam_id, userId, userName, currentAttempts + 1]);

        const crypto = require('crypto');
        const auto_login_user_id = userId;
        const auto_login_expires = Math.floor(Date.now() / 1000) + 300; // 5 minutes validity
        const secret = "canvas-proctor-shared-secret-key-998877";
        const signData = `auto_login_user_id=${auto_login_user_id}&expires=${auto_login_expires}`;
        const auto_login_signature = crypto.createHmac('sha256', secret).update(signData).digest('hex');

        res.json({
            ...sessionResult.rows[0],
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
            SELECT es.student_name, es.attempt_number, es.started_at, es.mime_type, e.title 
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
        
        if (sessionInfo.rows.length > 0) {
            const s = sessionInfo.rows[0];
            studentNameRaw = s.student_name || 'student';
            examTitleRaw = s.title || 'exam';
            studentName = s.student_name ? s.student_name.replace(/[^a-z0-9]/gi, '_') : 'student';
            examTitle = s.title ? s.title.replace(/[^a-z0-9]/gi, '_') : 'exam';
            attempt = s.attempt_number || 1;
            startedAt = s.started_at ? new Date(s.started_at).toISOString() : '';
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

        const tempOutFile = path.join(os.tmpdir(), `session-${exam_session_id}.mp4`);
        let finalMimeType = 'video/mp4';

        if (isWebm) {
            // Transcode WebM to MP4 using ffmpeg-static
            console.log(`Transcoding WebM to MP4 for session ${exam_session_id}...`);
            try {
                await new Promise((resolve, reject) => {
                    ffmpeg(rawWebmPath)
                        .outputOptions('-c:v libx264')
                        .outputOptions('-pix_fmt yuv420p')
                        .outputOptions('-preset superfast')
                        .outputOptions('-c:a aac')
                        .on('start', (commandLine) => {
                            console.log(`Spawned FFmpeg with command: ${commandLine}`);
                        })
                        .on('stderr', (stderrLine) => {
                            console.log(`[FFmpeg STDERR] ${stderrLine}`);
                        })
                        .on('end', resolve)
                        .on('error', reject)
                        .save(tempOutFile);
                });
                console.log(`Successfully transcoded to MP4 for session ${exam_session_id}`);
                if (fs.existsSync(rawWebmPath)) fs.unlinkSync(rawWebmPath);
            } catch (transcodeErr) {
                console.error(`Transcoding failed for session ${exam_session_id}, falling back to WebM:`, transcodeErr.message);
                // Fallback: Copy raw WebM to output path but keep .webm extension in Drive filename
                const fallbackOutFile = path.join(os.tmpdir(), `session-${exam_session_id}.webm`);
                fs.copyFileSync(rawWebmPath, fallbackOutFile);
                if (fs.existsSync(rawWebmPath)) fs.unlinkSync(rawWebmPath);
                finalMimeType = 'video/webm';
            }
        } else {
            // If already MP4, just rename/copy
            fs.renameSync(rawWebmPath, tempOutFile);
        }

        const finalExt = finalMimeType === 'video/mp4' ? 'mp4' : 'webm';
        const finalTempFile = finalExt === 'mp4' ? tempOutFile : path.join(os.tmpdir(), `session-${exam_session_id}.webm`);
        const driveFileName = `${studentName}_${examTitle}_Session_${exam_session_id}_Attempt_${attempt}.${finalExt}`;

        console.log(`Uploading ${driveFileName} to Google Drive...`);
        const driveFileId = await uploadVideoToDrive(finalTempFile, driveFileName, finalMimeType);
        console.log(`Uploaded to Google Drive. File ID: ${driveFileId}`);

        // Update database with Google Drive file ID and format
        await pool.query('UPDATE exam_sessions SET drive_file_id = $1, mime_type = $2 WHERE id = $3', [driveFileId, finalMimeType, exam_session_id]);

        // Upload Security logs to Google Drive as a Google Doc
        try {
            console.log(`Generating proctor logs Google Doc for session ${exam_session_id}...`);
            const logsQuery = await pool.query(`
                SELECT event_type, event_message, event_timestamp 
                FROM proctor_logs 
                WHERE exam_session_id = $1 
                ORDER BY event_timestamp ASC
            `, [exam_session_id]);

            let logRowsHtml = '';
            for (const row of logsQuery.rows) {
                const timestamp = row.event_timestamp ? new Date(row.event_timestamp).toISOString() : '';
                const type = row.event_type || '';
                const msg = row.event_message || '';
                const typeClass = (type.toLowerCase() === 'error' || type.toLowerCase() === 'failed') ? 'class="error"' : (type.toLowerCase().includes('violation') || type.toLowerCase().includes('warning') ? 'class="warning"' : '');
                
                logRowsHtml += `<tr>
                    <td>${timestamp}</td>
                    <td ${typeClass}>${type.toUpperCase()}</td>
                    <td>${msg}</td>
                </tr>`;
            }

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
    <p><strong>Report Generated:</strong> ${new Date().toISOString()}</p>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width: 25%;">Timestamp</th>
        <th style="width: 20%;">Event Type</th>
        <th style="width: 55%;">Message</th>
      </tr>
    </thead>
    <tbody>
      ${logRowsHtml || '<tr><td colspan="3" style="text-align:center;">No logs found for this session.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

            const driveDocName = `${studentName}_${examTitle}_Session_${exam_session_id}_Attempt_${attempt}_Logs`;
            const docFileId = await uploadLogsToDriveDoc(logsDocHtml, driveDocName);
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
    }
}

// API: End Exam Session
app.post('/api/session/end', requireAuth, async (req, res) => {
    try {
        const { exam_session_id, status, total_chunks } = req.body;
        const finalStatus = status || 'completed';
        console.log(`[End Session] Ending session ${exam_session_id} with status: ${finalStatus}, total_chunks expected: ${total_chunks}`);
        await pool.query('UPDATE exam_sessions SET status=$1 WHERE id=$2', [finalStatus, exam_session_id]);
        
        const examIdQuery = await pool.query('SELECT exam_id FROM exam_sessions WHERE id=$1', [exam_session_id]);
        if(examIdQuery.rows.length > 0) {
            io.to('teacher_' + examIdQuery.rows[0].exam_id).emit('student_status', { 
                session_id: exam_session_id, status: finalStatus 
            });
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
app.get('/api/session/video-playback/:session_id', requireInstructor, async (req, res) => {
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
        
        const sessions = await pool.query('SELECT id, exam_id, student_canvas_id, student_name, status, started_at, attempt_number, video_archived, drive_file_id FROM exam_sessions WHERE exam_id = $1', [exam_id]);
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
        
        const report = sessions.rows.map(s => {
            return {
                ...s,
                logs: logs.rows.filter(l => l.exam_session_id === s.id)
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

    socket.on('disconnect', () => {
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
                    if (sessionQuery.rows.length > 0 && sessionQuery.rows[0].status === 'started') {
                        console.log(`Session ${exam_session_id} abandoned by disconnect. Auto-finalizing...`);
                        await pool.query("UPDATE exam_sessions SET status = 'abandoned' WHERE id = $1", [exam_session_id]);
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

app.use(express.static(path.join(__dirname, 'public')));
// Fallback protection for static entries
app.get('/', (req, res) => {
    if (req.session.lti && req.session.lti.role === 'student') return res.redirect('/student.html');
    res.redirect('/index.html');
});

initDatabase().then(() => {
    server.listen(PORT, () => {
        console.log(`Proctor Gateway running on port ${PORT}`);
    });
}).catch(console.error);
