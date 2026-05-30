const { pool } = require('../db');

async function run() {
    try {
        const res = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema='public'
        `);
        console.log("TABLES:");
        console.log(res.rows.map(r => r.table_name));
    } catch(e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
run();
