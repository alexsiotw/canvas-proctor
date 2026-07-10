
const { pool } = require('/opt/canvas-proctor/db.js');
pool.query("SELECT * FROM lti_sessions WHERE session_token = '22dc41fe-7dab-4d5a-a940-906751b9f1cd'")
  .then(r => { console.log('TOKEN_CHECK:', r.rows); process.exit(0); })
  .catch(e => { console.error('ERR:', e); process.exit(1); });
