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
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS exam_sessions (
        id SERIAL PRIMARY KEY,
        exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
        student_canvas_id VARCHAR(255) NOT NULL,
        student_name VARCHAR(500),
        status VARCHAR(50) DEFAULT 'started',
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        recording_folder_id TEXT,
        UNIQUE(exam_id, student_canvas_id)
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
