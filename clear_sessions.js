
const { pool } = require('/opt/canvas-proctor/db.js');
pool.query("DELETE FROM exam_sessions WHERE exam_id = 25")
  .then(r => { console.log('CLEARED SESSIONS FOR EXAM 25. Deleted rows:', r.rowCount); process.exit(0); })
  .catch(e => { console.error('ERR:', e); process.exit(1); });
