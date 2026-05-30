const { pool } = require('../db');

async function run() {
    try {
        const res = await pool.query('SELECT id, canvas_course_id, title FROM exams');
        console.log("EXAMS IN DB:");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch(e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
run();
