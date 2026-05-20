const http = require('http');
const https = require('https');

module.exports = (req, res) => {
    const dufsBase = (req.query.url || '').replace(/\/$/, '');
    const remotePath = req.query.path || '/';
    if (!dufsBase) return res.status(400).json({ error: 'url parametresi gerekli' });

    const targetUrl = dufsBase + remotePath;
    const protocol = targetUrl.startsWith('https') ? https : http;

    const proxyReq = protocol.get(targetUrl, { timeout: 600000 }, (proxyRes) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
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
};
