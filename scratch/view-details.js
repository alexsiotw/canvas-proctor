const { pool } = require('../db');

async function run() {
    try {
        const res = await pool.query('SELECT id, title, canvas_quiz_url, created_at FROM exams ORDER BY created_at DESC LIMIT 5');
        console.log("LAST EXAMS:");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch(e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
run();
