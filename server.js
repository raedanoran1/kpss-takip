const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    // Clipboard API izinleri (kamera erişimi gibi tarayıcı güvenlik politikası için)
    res.setHeader('Permissions-Policy', 'clipboard-read=*, clipboard-write=*');
    next();
});

app.use(express.static(path.join(__dirname), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.wasm')) {
            res.setHeader('Content-Type', 'application/wasm');
        }
        if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
        if (filePath.endsWith('.mp3')) {
            res.setHeader('Content-Type', 'audio/mpeg');
        }
        if (filePath.endsWith('.woff2')) {
            res.setHeader('Content-Type', 'font/woff2');
        }
    }
}));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`KPSS Takip sunucusu calisiyor: http://0.0.0.0:${PORT}`);
});
