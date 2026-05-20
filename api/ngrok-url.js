const http = require('http');

module.exports = (req, res) => {
    const proxyReq = http.get('http://127.0.0.1:4040/api/tunnels', { timeout: 3000 }, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
            try {
                const json = JSON.parse(data);
                const httpsTunnel = (json.tunnels || []).find(t => t.proto === 'https');
                if (httpsTunnel) {
                    res.setHeader('Access-Control-Allow-Origin', '*');
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
    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        res.status(503).json({ error: 'ngrok zaman aşımı' });
    });
};
