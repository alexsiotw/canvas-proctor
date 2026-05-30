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
        console.log("HAS SECURE EXAM TAB OPENED TEXT:", data.includes('Secure Exam Tab Opened'));
    });
}).on('error', err => {
    console.error("HTTP GET failed:", err.message);
});
