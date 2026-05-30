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

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

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
        const canvasCourseId = req.body.custom_canvas_course_id || req.body.context_id || 'demo_course';
        const userName = req.body.lis_person_name_full || 'Instructor';
        const roles = req.body.roles || '';
        const isInstructor = roles.includes('Instructor') || roles.includes('Administrator') || roles.includes('urn:lti:role:ims/lis/Instructor');
        const resourceLinkId = req.body.resource_link_id || '';

        const sessionToken = uuidv4();
        const launchReturnUrl = req.body.launch_presentation_return_url || '';
        const contentItemReturnUrl = req.body.content_item_return_url || '';

        req.session.lti = {
            userId,
            canvasCourseId,
            userName,
            role: isInstructor ? 'instructor' : 'student',
            sessionToken,
            resourceLinkId,
            launchReturnUrl,
            contentItemReturnUrl
        };

        // Persist session to DB for SEB handover
        pool.query(`
            INSERT INTO lti_sessions (session_token, canvas_user_id, canvas_course_id, user_name, user_role)
            VALUES ($1, $2, $3, $4, $5)
        `, [sessionToken, userId, canvasCourseId, userName, req.session.lti.role]).catch(err => console.error('Failed to persist LTI session', err));

        if (isInstructor) {
            let redirectUrl = `/index.html?resource_link_id=${encodeURIComponent(resourceLinkId)}`;
            if (launchReturnUrl) {
                redirectUrl += `&launch_presentation_return_url=${encodeURIComponent(launchReturnUrl)}`;
            }
            if (contentItemReturnUrl) {
                redirectUrl += `&content_item_return_url=${encodeURIComponent(contentItemReturnUrl)}`;
            }
            res.redirect(redirectUrl);
        } else {
            res.redirect(`/student.html?token=${sessionToken}${resourceLinkId ? '&placement_id=' + encodeURIComponent(resourceLinkId) : ''}`);
        }
    });
});

app.get('/dev-launch', (req, res) => {
    req.session.lti = { userId: 'dev_instructor', canvasCourseId: 'demo_course', userName: 'Dev Instructor', role: 'instructor' };
    res.redirect('/index.html');
});

app.get('/dev-student', (req, res) => {
    req.session.lti = { userId: req.query.userId || 'dev_student_1', canvasCourseId: req.query.courseId || 'demo_course', userName: 'Dev Student', role: 'student' };
    res.redirect('/student.html');
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

// API: Setup / Get Exams (Teacher)
app.get('/api/exams', requireInstructor, async (req, res) => {
    try {
        const { canvasCourseId } = req.session.lti;
        const result = await pool.query('SELECT * FROM exams WHERE canvas_course_id = $1 ORDER BY created_at DESC', [canvasCourseId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/exams', requireInstructor, async (req, res) => {
    try {
        const { canvasCourseId } = req.session.lti;
        const { title, canvas_quiz_url, require_mic, require_camera, require_screen, disable_right_click, require_fullscreen, require_seb, max_attempts, exam_code, max_violations, canvas_quiz_password } = req.body;
        
        const result = await pool.query(`
            INSERT INTO exams (canvas_course_id, title, canvas_quiz_url, require_mic, require_camera, require_screen, disable_right_click, require_fullscreen, require_seb, max_attempts, exam_code, max_violations, canvas_quiz_password, is_open)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false) RETURNING *
        `, [canvasCourseId, title, canvas_quiz_url, require_mic, require_camera, require_screen, disable_right_click, require_fullscreen, require_seb || false, max_attempts || 1, exam_code, max_violations || 0, canvas_quiz_password || '']);
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Delete Exam
app.delete('/api/exams/:id', requireInstructor, async (req, res) => {
    try {
        const { canvasCourseId } = req.session.lti;
        await pool.query('DELETE FROM exams WHERE id = $1 AND canvas_course_id = $2', [req.params.id, canvasCourseId]);
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
        const { canvasCourseId } = req.session.lti;
        
        const result = await pool.query(`
            UPDATE exams SET is_open = $1 
            WHERE id = $2 AND canvas_course_id = $3 
            RETURNING *
        `, [is_open, id, canvasCourseId]);
        
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
        const { canvasCourseId } = req.session.lti;
        const { 
            title, canvas_quiz_url, exam_code, max_attempts,
            require_camera, require_mic, require_screen,
            disable_right_click, require_fullscreen, require_seb,
            max_violations, canvas_quiz_password
        } = req.body;

        const result = await pool.query(`
            UPDATE exams SET 
                title = $1, canvas_quiz_url = $2, exam_code = $3, max_attempts = $4,
                require_camera = $5, require_mic = $6, require_screen = $7,
                disable_right_click = $8, require_fullscreen = $9, require_seb = $10,
                max_violations = $11, canvas_quiz_password = $12, updated_at = NOW()
            WHERE id = $13 AND canvas_course_id = $14
            RETURNING *
        `, [
            title, canvas_quiz_url, exam_code, max_attempts,
            require_camera, require_mic, require_screen,
            disable_right_click, require_fullscreen, require_seb,
            max_violations || 0, canvas_quiz_password || '', id, canvasCourseId
        ]);

        if (result.rows.length === 0) return res.status(404).json({ error: 'Exam not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Get Exam details (For Student entering / pre-flight)
app.post('/api/exams/verify-code', requireAuth, async (req, res) => {
    try {
        const { canvasCourseId, userId } = req.session.lti;
        const { exam_code } = req.body;
        
        const examResult = await pool.query('SELECT * FROM exams WHERE canvas_course_id = $1 AND exam_code = $2', [canvasCourseId, exam_code]);
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
        
        res.json(exam);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Verify and Authorize placement-based launch directly
app.post('/api/exams/verify-placement', requireAuth, async (req, res) => {
    try {
        const { canvasCourseId, userId } = req.session.lti;
        const { placement_id } = req.body;
        
        const placementResult = await pool.query('SELECT exam_id FROM exam_placements WHERE resource_link_id = $1', [placement_id]);
        if (placementResult.rows.length === 0) {
            return res.status(404).json({ error: 'This Canvas placement is not configured yet. Please ask your instructor to link it to an exam.' });
        }
        
        const exam_id = placementResult.rows[0].exam_id;
        const examResult = await pool.query('SELECT * FROM exams WHERE id = $1', [exam_id]);
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
        
        res.json(exam);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

// API: Handle LTI ContentItemSelection signed return POST
app.get('/api/placements/lti-return', requireInstructor, (req, res) => {
    const { content_item_return_url, exam_title, launch_url } = req.query;
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
        res.json(sessionResult.rows[0]);
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

// API: End Exam Session
app.post('/api/session/end', requireAuth, async (req, res) => {
    try {
        const { exam_session_id, status } = req.body;
        const finalStatus = status || 'completed';
        await pool.query('UPDATE exam_sessions SET status=$1 WHERE id=$2', [finalStatus, exam_session_id]);
        
        const examIdQuery = await pool.query('SELECT exam_id FROM exam_sessions WHERE id=$1', [exam_session_id]);
        if(examIdQuery.rows.length > 0) {
            io.to('teacher_' + examIdQuery.rows[0].exam_id).emit('student_status', { 
                session_id: exam_session_id, status: finalStatus 
            });
        }
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Upload Video Chunk directly via JSON payload to Bypass Form Boundaries
app.post('/api/session/upload-chunk', requireAuth, async (req, res) => {
    const { chunk_index, exam_session_id, base64_video } = req.body;
    try {
        if (!base64_video) throw new Error("Video payload was empty");
        
        await pool.query(`
            INSERT INTO video_chunks (exam_session_id, chunk_index, video_data)
            VALUES ($1, $2, $3)
        `, [exam_session_id, chunk_index, base64_video]);
        
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
        const sessionInfo = (await pool.query('SELECT mime_type FROM exam_sessions WHERE id = $1', [session_id])).rows[0];
        const mimeToUse = (sessionInfo && sessionInfo.mime_type) ? sessionInfo.mime_type : 'video/webm';
        
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
        
        const masterBuffer = Buffer.concat(binaryChunks);
        
        // Dynamic Content-Type based on what the student app reported
        res.setHeader('Content-Type', mimeToUse.split(';')[0]); // Use clean mime (e.g. video/webm)
        res.setHeader('Content-Length', masterBuffer.length);
        res.send(masterBuffer);
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

// API: Export Videos completely to ZIP safely via Stream
app.get('/api/exams/:id/export-videos', async (req, res) => {
    const { id } = req.params;
    try {
        const exam = (await pool.query('SELECT title, exam_code FROM exams WHERE id = $1', [id])).rows[0];
        if(!exam) return res.status(404).send('Exam Not found');

        const sessionResult = await pool.query(`
            SELECT id, student_canvas_id, student_name, attempt_number 
            FROM exam_sessions 
            WHERE exam_id = $1 AND status = 'completed' AND video_archived = false
        `, [id]);

        if (sessionResult.rows.length === 0) {
            return res.status(404).send('No valid video chunks found. Either the exam is empty, or chunks were already deleted!');
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${exam.title.replace(/[^a-z0-9]/gi, '_')}_Proctor_Vault.zip"`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        archive.on('error', (err) => { throw err; });

        for (const session of sessionResult.rows) {
            const chunkResult = await pool.query('SELECT video_data FROM video_chunks WHERE exam_session_id = $1 ORDER BY chunk_index ASC', [session.id]);
            if (chunkResult.rows.length === 0) continue;

            const binaryChunks = [];
            for(let row of chunkResult.rows) {
                // Strip the Data URL prefix (everything before the first comma) and whitespace
                const pureB64 = row.video_data.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
                binaryChunks.push(Buffer.from(pureB64, 'base64'));
            }
            const masterBlob = Buffer.concat(binaryChunks);
            
            const studentNameStr = session.student_name ? session.student_name.replace(/[^a-z0-9]/gi, '_') : session.student_canvas_id;
            archive.append(masterBlob, { name: `${studentNameStr}_Attempt_${session.attempt_number || 1}.webm` });
        }

        archive.finalize();
    } catch(err) {
        console.error(err);
        if (!res.headersSent) res.status(500).send('Error generating archive');
    }
});

// API: Purge Videos
app.delete('/api/exams/:id/videos-only', requireInstructor, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(`
            DELETE FROM video_chunks WHERE exam_session_id IN (
                SELECT id FROM exam_sessions WHERE exam_id = $1
            )
        `, [id]);
        
        await pool.query(`
            UPDATE exam_sessions SET video_archived = true, drive_folder_id = NULL WHERE exam_id = $1
        `, [id]);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Get Exam Report (Teacher)
app.get('/api/exams/:exam_id/reports', requireInstructor, async (req, res) => {
    try {
        const sessions = await pool.query('SELECT id, exam_id, student_canvas_id, student_name, status, started_at, attempt_number, video_archived FROM exam_sessions WHERE exam_id = $1', [req.params.exam_id]);
        const logs = await pool.query(`
            SELECT pl.* FROM proctor_logs pl 
            JOIN exam_sessions es ON pl.exam_session_id = es.id 
            WHERE es.exam_id = $1 ORDER BY pl.event_timestamp DESC
        `, [req.params.exam_id]);
        
        const report = sessions.rows.map(s => {
            return {
                ...s,
                logs: logs.rows.filter(l => l.exam_session_id === s.id)
            };
        });
        res.json(report);
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
        let startUrl = `${baseUrl}/student.html?token=${token}&seb=true`;
        if (exam_code) startUrl += `&exam_code=${encodeURIComponent(exam_code)}`;
        if (placement_id) startUrl += `&placement_id=${encodeURIComponent(placement_id)}`;
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
                // If regex fails (unlikely in valid plist), just append it to the dict if possible or fallback
                // For safety, if we can't inject, tell the dev
                console.log('Template exists but startURL key not found or misformatted. Using fallback.');
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
	<true/>
	<key>browserWindowAllowNewWindow</key>
	<true/>
	<key>browserWindowShowAddressBar</key>
	<true/>
	<key>browserWindowShowNavigationButtons</key>
	<true/>
	<key>newBrowserWindowByLinkPolicy</key>
	<integer>1</integer>
	<key>prohibitMultitasking</key>
	<false/>
	<key>showTaskBar</key>
	<true/>
	<key>startURL</key>
	<string>${startUrl}</string>
</dict>
</plist>`;
        }

        res.setHeader('Content-Type', 'application/seb');
        res.send(sebConfig);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Socket IO Real-Time
io.on('connection', (socket) => {
    socket.on('join_teacher', (exam_id) => {
        socket.join('teacher_' + exam_id);
    });

    socket.on('join_student', (data) => { // { exam_id, exam_session_id, student_name }
        socket.join('student_' + data.exam_session_id);
        socket.studentData = data;
        io.to('teacher_' + data.exam_id).emit('student_status', { session_id: data.exam_session_id, name: data.student_name, status: 'online' });
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

    socket.on('disconnect', () => {
        if(socket.studentData) {
            io.to('teacher_' + socket.studentData.exam_id).emit('student_status', { 
                session_id: socket.studentData.exam_session_id, 
                name: socket.studentData.student_name, 
                status: 'offline' 
            });
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
