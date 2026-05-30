const https = require('https');

https.get('https://canvas-proctor.onrender.com/api/placements/lti-return?content_item_return_url=test', {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
}, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
        console.log("STATUS CODE:", res.statusCode);
        console.log("HEADERS:", JSON.stringify(res.headers, null, 2));
        console.log("BODY:", data);
    });
}).on('error', err => {
    console.error("HTTP GET failed:", err.message);
});
