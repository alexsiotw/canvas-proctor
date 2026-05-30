const { pool } = require('../db');

async function run() {
    try {
        const res = await pool.query('SELECT id, session_token, user_name, user_role, debug_info, created_at FROM lti_sessions ORDER BY created_at DESC LIMIT 1');
        console.log("LATEST SESSION:");
        console.log(JSON.stringify(res.rows[0], null, 2));
    } catch(e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
run();
