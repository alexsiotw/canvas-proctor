const { Pool } = require('pg');
const dns = require('dns');
require('dotenv').config();

// Supabase may resolve to IPv6 which can fail on some networks
dns.setDefaultResultOrder('ipv4first');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS exams (
        id SERIAL PRIMARY KEY,
        canvas_course_id VARCHAR(255) NOT NULL,
        title VARCHAR(500) NOT NULL,
        canvas_quiz_url TEXT NOT NULL,
        require_mic BOOLEAN DEFAULT true,
        require_camera BOOLEAN DEFAULT true,
        require_screen BOOLEAN DEFAULT true,
        disable_right_click BOOLEAN DEFAULT true,
        require_fullscreen BOOLEAN DEFAULT true,
        is_open BOOLEAN DEFAULT false,
        require_seb BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS exam_sessions (
        id SERIAL PRIMARY KEY,
        exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
        student_canvas_id VARCHAR(255) NOT NULL,
        student_name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'started',
        recording_folder_id VARCHAR(255),
        video_archived BOOLEAN DEFAULT false,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        end_time TIMESTAMP,
        attempt_number INTEGER DEFAULT 1,
        UNIQUE(exam_id, student_canvas_id, attempt_number)
      );

      CREATE TABLE IF NOT EXISTS proctor_logs (
        id SERIAL PRIMARY KEY,
        exam_session_id INTEGER REFERENCES exam_sessions(id) ON DELETE CASCADE,
        event_type VARCHAR(100) NOT NULL,
        event_message TEXT,
        event_timestamp TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS lti_sessions (
        id SERIAL PRIMARY KEY,
        session_token VARCHAR(255) UNIQUE NOT NULL,
        canvas_user_id VARCHAR(255),
        canvas_course_id VARCHAR(255),
        user_name VARCHAR(500),
        user_role VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours'
      );
      
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS exam_code VARCHAR(50);
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS max_attempts INTEGER DEFAULT 1;
      ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS attempt_number INTEGER DEFAULT 1;
      ALTER TABLE exam_sessions DROP CONSTRAINT IF EXISTS exam_sessions_exam_id_student_canvas_id_key;

      CREATE TABLE IF NOT EXISTS exam_overrides (
        id SERIAL PRIMARY KEY,
        exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
        student_canvas_id VARCHAR(255) NOT NULL,
        extra_attempts INTEGER DEFAULT 1,
        UNIQUE(exam_id, student_canvas_id)
      );

      CREATE TABLE IF NOT EXISTS video_chunks (
        id SERIAL PRIMARY KEY,
        exam_session_id INTEGER REFERENCES exam_sessions(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        video_data TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Force add missing columns onto existing production tables implicitly without crashing
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS is_open BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS require_seb BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS max_violations INTEGER DEFAULT 0;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS canvas_quiz_password VARCHAR(255);
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS disable_clipboard BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS disable_printing BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS only_one_screen BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS block_downloads BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS prevent_reentry BOOLEAN DEFAULT false;
      
      -- Advanced extension-required columns
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS record_web_traffic BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS disable_new_tabs BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS close_open_tabs BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS disable_extensions BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS prevent_incognito BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS clear_cache BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS advanced_program_detection BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS advanced_vm_detection BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS advanced_hardware_detection BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS allow_apps BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS block_mobile BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS require_extension BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS require_companion_app BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS allowed_apps TEXT DEFAULT null;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS blocked_apps TEXT DEFAULT null;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS allowed_urls TEXT DEFAULT null;


      ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS video_archived BOOLEAN DEFAULT false;
      ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS mime_type VARCHAR(255) DEFAULT 'video/webm';
      ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS drive_file_id VARCHAR(255);
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS require_mobile_camera BOOLEAN DEFAULT false;
      
      -- New Proctorio UI alignment columns
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS verify_video BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS verify_audio BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS verify_desktop BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS verify_id BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS verify_signature BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS allow_calculator BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS allow_whiteboard BOOLEAN DEFAULT false;
      -- Opt-in: let phones/tablets take the exam in-browser without the Chrome extension.
      -- Default false so existing desktop lockdown exams are unchanged.
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS allow_mobile_devices BOOLEAN DEFAULT false;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS behavior_preset VARCHAR(100) DEFAULT 'Recommended';
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS weight_navigating_away INTEGER DEFAULT 1;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS weight_keystrokes INTEGER DEFAULT 1;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS weight_copy_paste INTEGER DEFAULT 1;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS weight_browser_resize INTEGER DEFAULT 1;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS weight_head_movement INTEGER DEFAULT 1;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS weight_multi_face INTEGER DEFAULT 1;
      ALTER TABLE exams ADD COLUMN IF NOT EXISTS weight_leaving_room INTEGER DEFAULT 1;
      -- When the MediaRecorder actually started, as distinct from when the
      -- session row was created.
      --
      -- started_at is stamped by /api/session/start, but recording cannot begin
      -- until the composite canvas has real camera frames (up to 4s) plus a
      -- warm-up delay, and only once Canvas signals the quiz opened. The gap is
      -- routinely 10s or more. Anchoring anything to started_at therefore both
      -- overstates the attempt length and shifts every log video-marker out of
      -- sync with the footage it points at.
      ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS recording_started_at TIMESTAMP;
      -- The phone may record a different container than the laptop (Safari gives
      -- MP4 where Chrome gives WebM), so the secondary recording needs its own.
      ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS mobile_mime_type VARCHAR(255);
      ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS mobile_drive_file_id VARCHAR(255);
      ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS room_scan_drive_file_id VARCHAR(255);
      ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS verify_id_image TEXT;
      ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS verify_signature_image TEXT;
      ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS verify_signature_name VARCHAR(500);
      ALTER TABLE lti_sessions ADD COLUMN IF NOT EXISTS alternative_canvas_course_id VARCHAR(255);
      ALTER TABLE lti_sessions ADD COLUMN IF NOT EXISTS debug_info TEXT;
      ALTER TABLE lti_sessions ADD COLUMN IF NOT EXISTS exam_session_id INTEGER;

      CREATE TABLE IF NOT EXISTS exam_placements (
        id SERIAL PRIMARY KEY,
        resource_link_id VARCHAR(255) UNIQUE NOT NULL,
        exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS session_annotations (
        id SERIAL PRIMARY KEY,
        exam_session_id INTEGER REFERENCES exam_sessions(id) ON DELETE CASCADE,
        timestamp_seconds INTEGER NOT NULL,
        note TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS api_debug_logs (
        id SERIAL PRIMARY KEY,
        endpoint VARCHAR(255) NOT NULL,
        query_params TEXT,
        request_body TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database tables initialized successfully');
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDatabase };
