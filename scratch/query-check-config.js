const https = require('https');

https.get('https://canvas-proctor.onrender.com/api/dev/check-config', {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
}, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
        console.log("CONFIG STATUS:", res.statusCode);
        console.log(data);
    });
}).on('error', err => {
    console.error("HTTP GET failed:", err.message);
});
