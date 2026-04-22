const fs = require('fs');

const files = ['server.js', 'public/js/app.js', 'public/js/student.js'];

files.forEach(f => {
    if (fs.existsSync(f)) {
        let text = fs.readFileSync(f, 'utf8');
        text = text.replace(/\\`/g, '`');
        text = text.replace(/\\\$/g, '$');
        fs.writeFileSync(f, text);
        console.log('Fixed', f);
    }
});
