
const { pool } = require('/opt/canvas-proctor/db.js');
const examId = process.argv[2] || 26;
pool.query('SELECT id, title, is_open, max_attempts, exam_code, canvas_quiz_url, canvas_course_id FROM exams WHERE id = $1', [examId])
  .then(r => { console.log('EXAM:', r.rows); process.exit(0); })
  .catch(e => { console.error('ERR:', e); process.exit(1); });
