const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'db', 'data.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) return { emails: {}, opens: [] };
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const NGROK_URL = 'https://heteromorphic-supportively-wendy.ngrok-free.dev';

function isGoogleProxy(ip, ua) {
  return (ua && ua.includes('GoogleImageProxy')) ||
    ip.startsWith('66.102.') || ip.startsWith('66.249.') ||
    ip.startsWith('64.233.') || ip.startsWith('72.14.') ||
    ip.startsWith('74.125.') || ip.startsWith('209.85.');
}

function geoLookup(ip) {
  return new Promise((resolve) => {
    if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168') || ip.startsWith('10.')) {
      return resolve({ city: 'Local Network', country: 'localhost', region: '' });
    }
    const req = http.get(`http://ip-api.com/json/${ip}?fields=city,regionName,country,status`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.status === 'success') {
            resolve({ city: j.city, region: j.regionName, country: j.country });
          } else {
            resolve({ city: 'Unknown', region: '', country: 'Unknown' });
          }
        } catch { resolve({ city: 'Unknown', region: '', country: 'Unknown' }); }
      });
    });
    req.on('error', () => resolve({ city: 'Unknown', region: '', country: 'Unknown' }));
    req.setTimeout(3000, () => { req.abort(); resolve({ city: 'Unknown', region: '', country: 'Unknown' }); });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (pathname === '/pixel' && req.method === 'GET') {
    const trackId = parsed.query.id;
    if (trackId) {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      const userAgent = req.headers['user-agent'] || '';
      const googleProxy = isGoogleProxy(ip, userAgent);
      const geo = googleProxy
        ? { city: 'Gmail Proxy', region: '', country: 'Google' }
        : await geoLookup(ip);

      const db = loadDB();
      db.opens.push({
        id: crypto.randomUUID(),
        trackId,
        timestamp: new Date().toISOString(),
        ip,
        userAgent,
        city: geo.city,
        region: geo.region,
        country: geo.country,
        viaProxy: googleProxy,
      });
      saveDB(db);
      console.log(`Open logged: ${trackId} | ${googleProxy ? 'Gmail Proxy' : ip} | ${geo.city}, ${geo.country}`);
    }

    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': PIXEL.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    return res.end(PIXEL);
  }

  if (pathname === '/api/emails' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { subject, recipient, bodyHtml } = JSON.parse(body);
        const trackId = crypto.randomUUID();
        const db = loadDB();
        db.emails[trackId] = {
          trackId,
          subject: subject || '(no subject)',
          recipient: recipient || '',
          bodyHtml: bodyHtml || '',
          createdAt: new Date().toISOString(),
        };
        saveDB(db);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ trackId, pixelUrl: `${NGROK_URL}/pixel?id=${trackId}` }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (pathname === '/api/emails' && req.method === 'GET') {
    const db = loadDB();
    const result = Object.values(db.emails).map(email => {
      const opens = db.opens.filter(o => o.trackId === email.trackId);
      const locations = [...new Set(opens.map(o =>
        [o.city, o.country].filter(Boolean).join(', ')
      ))].filter(Boolean);
      return { ...email, openCount: opens.length, firstOpen: opens[0]?.timestamp || null, lastOpen: opens[opens.length - 1]?.timestamp || null, locations, opens };
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  if (pathname.startsWith('/api/emails/') && req.method === 'DELETE') {
    const trackId = pathname.split('/')[3];
    const db = loadDB();
    delete db.emails[trackId];
    db.opens = db.opens.filter(o => o.trackId !== trackId);
    saveDB(db);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/' || pathname === '/index.html') {
    const file = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(file));
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n✉  Email Tracker running at http://localhost:${PORT}`);
  console.log(`   Public URL: ${NGROK_URL}`);
  console.log(`   Dashboard:  http://localhost:${PORT}/\n`);
});
