const https = require('https');

https.get('https://canvas-proctor.onrender.com/js/student.js', {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
}, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
        console.log("STATUS:", res.statusCode);
        console.log("CONTAINS NEW UPLOAD CHUNK WITH TOKEN:", data.includes("token: sessionToken"));
        console.log("CONTAINS END EXAM WITH TOKEN:", data.includes("body: JSON.stringify({ exam_session_id: sessionInfo.id, token: sessionToken })"));
    });
}).on('error', err => {
    console.error("HTTP GET failed:", err.message);
});
