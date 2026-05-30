const https = require('https');

https.get('https://canvas-proctor.onrender.com/student.html', {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
}, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
        console.log("STATUS:", res.statusCode);
        console.log("HAS SANDBOX IFRAME:", data.includes('sandbox="allow-same-origin'));
    });
}).on('error', err => {
    console.error("HTTP GET failed:", err.message);
});
