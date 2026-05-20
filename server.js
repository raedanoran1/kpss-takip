const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');

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

app.get('/api/ngrok-url', (req, res) => {
    const ngrokApi = 'http://127.0.0.1:4040/api/tunnels';
    const reqOptions = { timeout: 3000 };
    const proxyReq = http.get(ngrokApi, reqOptions, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
            try {
                const json = JSON.parse(data);
                const httpsTunnel = (json.tunnels || []).find(t => t.proto === 'https');
                if (httpsTunnel) {
                    res.json({ url: httpsTunnel.public_url });
                } else {
                    res.status(404).json({ error: 'ngrok HTTPS tüneli bulunamadı' });
                }
            } catch (e) {
                res.status(500).json({ error: 'ngrok API yanıtı okunamadı' });
            }
        });
    });
    proxyReq.on('error', () => res.status(503).json({ error: 'ngrok çalışmıyor' }));
    proxyReq.on('timeout', () => { proxyReq.destroy(); res.status(503).json({ error: 'ngrok zaman aşımı' }); });
});

app.get('/api/dufs-proxy', (req, res) => {
    const dufsBase = (req.query.url || 'http://localhost:5000').replace(/\/$/, '');
    const remotePath = req.query.path || '/';
    const targetUrl = dufsBase + remotePath;

    const protocol = targetUrl.startsWith('https') ? https : http;
    const proxyReq = protocol.get(targetUrl, { timeout: 600000 }, (proxyRes) => {
        res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/octet-stream');
        if (proxyRes.headers['content-length']) {
            res.setHeader('Content-Length', proxyRes.headers['content-length']);
        }
        proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
        if (!res.headersSent) res.status(502).json({ error: 'DUFS sunucusuna ulaşılamadı: ' + err.message });
    });
    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).json({ error: 'Bağlantı zaman aşımı' });
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`KPSS Takip sunucusu calisiyor: http://0.0.0.0:${PORT}`);
});
