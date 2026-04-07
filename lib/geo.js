const http = require('http');

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
    req.setTimeout(3000, () => { req.destroy(); resolve({ city: 'Unknown', region: '', country: 'Unknown' }); });
  });
}

module.exports = { geoLookup };
