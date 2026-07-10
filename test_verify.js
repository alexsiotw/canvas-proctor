
const http = require('http');

const data = JSON.stringify({
  exam_id: 25,
  token: '22dc41fe-7dab-4d5a-a940-906751b9f1cd'
});

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/exams/verify-placement',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('STATUS:', res.statusCode);
    console.log('RESPONSE:', body);
    process.exit(0);
  });
});

req.on('error', (e) => {
  console.error(e);
  process.exit(1);
});

req.write(data);
req.end();
