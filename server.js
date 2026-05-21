const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Permissions-Policy', 'clipboard-read=*, clipboard-write=*');
    next();
});

app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'index.html'));
});

app.get('/dufs-proxy', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'url parametresi gerekli' });
    let parsed;
    try { parsed = new URL(targetUrl); } catch(e) { return res.status(400).json({ error: 'Gecersiz URL' }); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const proxyReq = lib.get(targetUrl, (proxyRes) => {
        res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/octet-stream');
        if (proxyRes.headers['content-length']) {
            res.setHeader('Content-Length', proxyRes.headers['content-length']);
        }
        proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => {
        if (!res.headersSent) res.status(502).json({ error: e.message });
    });
});

app.use(express.static(path.resolve(__dirname), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
        if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript');
        if (filePath.endsWith('.mp3')) res.setHeader('Content-Type', 'audio/mpeg');
        if (filePath.endsWith('.woff2')) res.setHeader('Content-Type', 'font/woff2');
    }
}));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`KPSS Takip sunucusu: http://0.0.0.0:${PORT}`);
    console.log(`Dizin: ${__dirname}`);
});
