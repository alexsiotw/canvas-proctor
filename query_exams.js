
const { pool } = require('/opt/canvas-proctor/db.js');
pool.query("SELECT id, title, canvas_course_id, canvas_quiz_url FROM exams ORDER BY id DESC")
  .then(r => { console.log('EXAMS:', r.rows); process.exit(0); })
  .catch(e => { console.error('ERR:', e); process.exit(1); });
