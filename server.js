const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');

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

// Sertifikayı iPad'e yüklemek için indirme endpoint'i
app.get('/install-cert', (req, res) => {
    const certPath = path.resolve(__dirname, 'certs', 'cert.pem');
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="kpss-cert.pem"');
    res.sendFile(certPath);
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

const certPath = path.resolve(__dirname, 'certs', 'cert.pem');
const keyPath  = path.resolve(__dirname, 'certs', 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const sslOptions = {
        cert: fs.readFileSync(certPath),
        key:  fs.readFileSync(keyPath),
    };
    https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', () => {
        console.log(`KPSS Takip sunucusu (HTTPS): https://0.0.0.0:${PORT}`);
        console.log(`iPad'den eriş: https://192.168.1.36:${PORT}`);
        console.log(`Sertifika yükle: https://192.168.1.36:${PORT}/install-cert`);
    });
} else {
    http.createServer(app).listen(PORT, '0.0.0.0', () => {
        console.log(`KPSS Takip sunucusu (HTTP): http://0.0.0.0:${PORT}`);
        console.log('Uyari: certs/cert.pem bulunamadi, HTTP modunda calisiyor.');
    });
}
