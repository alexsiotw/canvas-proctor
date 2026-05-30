const { pool } = require('../db');

async function run() {
    try {
        const res = await pool.query('SELECT * FROM exam_placements LIMIT 5');
        console.log("PLACEMENTS:");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch(e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
run();
