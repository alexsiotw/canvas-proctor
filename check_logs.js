
const { pool } = require('/opt/canvas-proctor/db.js');
pool.query("SELECT * FROM api_debug_logs ORDER BY id DESC LIMIT 5")
  .then(r => { console.log('DEBUG_LOGS:', r.rows); process.exit(0); })
  .catch(e => { console.error('ERR:', e); process.exit(1); });
