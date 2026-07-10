
const token = '22dc41fe-7dab-4d5a-a940-906751b9f1cd';
const exam_id = 25;

fetch('http://localhost:3000/api/exams/verify-placement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, exam_id })
})
.then(async res => {
    console.log('STATUS:', res.status);
    console.log('BODY:', await res.json());
    process.exit(0);
})
.catch(e => {
    console.error('ERR:', e);
    process.exit(1);
});
