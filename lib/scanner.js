const REAL_UA_PATTERNS = ['Mozilla', 'Chrome', 'Safari', 'Outlook'];
const KNOWN_SCANNER_RANGES = ['179.50.15.', '172.225.250.'];

// opens rows use SQLite snake_case columns: track_id, ip, timestamp, via_proxy
function isAutomatedScanner(ip, ua, trackId, opens, emailCreatedAt) {
  const now = Date.now();

  // Rapid-fire: 2+ hits from same IP for same trackId within 60s = scanner
  const recentSameIp = opens.filter(o =>
    o.track_id === trackId &&
    o.ip === ip &&
    (now - new Date(o.timestamp).getTime()) <= 60000
  );
  if (recentSameIp.length >= 1) {
    return { viaProxy: true, scannerReason: 'rapid_fire_scanner' };
  }

  // Known scanner IP ranges
  if (KNOWN_SCANNER_RANGES.some(range => ip.startsWith(range))) {
    return { viaProxy: true, scannerReason: 'known_scanner_range' };
  }

  // Google proxy: time-gated — after 600s a Google IP counts as a real human open
  const withinGoogleWindow = emailCreatedAt && (now - new Date(emailCreatedAt).getTime()) <= 600000;
  if (withinGoogleWindow) {
    if ((ua && ua.includes('GoogleImageProxy')) ||
        ip.startsWith('66.102.') || ip.startsWith('66.249.') ||
        ip.startsWith('64.233.') || ip.startsWith('72.14.') ||
        ip.startsWith('74.125.') || ip.startsWith('209.85.')) {
      return { viaProxy: true, scannerReason: 'google_proxy' };
    }
  }

  if (!ua) return { viaProxy: true, scannerReason: 'no_ua' };

  if (!REAL_UA_PATTERNS.some(p => ua.includes(p))) {
    return { viaProxy: true, scannerReason: 'suspicious_ua' };
  }

  return { viaProxy: false, scannerReason: null };
}

module.exports = { isAutomatedScanner, KNOWN_SCANNER_RANGES, REAL_UA_PATTERNS };
