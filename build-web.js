const fs = require('fs');
const path = require('path');

const WWW = path.join(__dirname, 'www');

function copyRecursive(src, dest) {
    if (!fs.existsSync(src)) return;
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const item of fs.readdirSync(src)) {
            copyRecursive(path.join(src, item), path.join(dest, item));
        }
    } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    }
}

if (fs.existsSync(WWW)) fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW);

const items = [
    'index.html',
    'manifest.json',
    'pwa-manifest.json',
    'sw.js',
    'css',
    'js',
    'lib',
    'images',
    'icons',
    'fonts',
    'web_resources',
];

for (const item of items) {
    const src = path.join(__dirname, item);
    copyRecursive(src, path.join(WWW, item));
    console.log(`Kopyalandı: ${item}`);
}

console.log('\nBuild tamamlandı → www/ klasörü hazır.');
