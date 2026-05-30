const { pool } = require('../db');

async function run() {
    try {
        const res = await pool.query('SELECT * FROM lti_sessions ORDER BY created_at DESC LIMIT 5');
        console.log("LAST LTI SESSIONS:");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch(e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
run();
