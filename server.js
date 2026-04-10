const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const db = require('./lib/db');
const { isAutomatedScanner } = require('./lib/scanner');
const { geoLookup } = require('./lib/geo');
const { hashPassword, comparePassword, signToken, verifyToken } = require('./lib/auth');
const { sendVerificationEmail, sendOpenNotification } = require('./lib/email');
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const BASE_URL = process.env.BASE_URL || 'https://track.mangacreativestudios.com';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

// For Stripe webhooks only — returns raw Buffer, no parsing.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Returns userId if the request carries a valid JWT, otherwise sends 401 and returns null.
function requireAuth(req, res) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { json(res, 401, { error: 'Unauthorized' }); return null; }
  try {
    const payload = verifyToken(token);
    return payload.sub;
  } catch {
    json(res, 401, { error: 'Unauthorized' });
    return null;
  }
}

// Returns true if the authenticated user has an active subscription (or is seed/trialing).
// Sends 402 and returns false if not.
function requireSubscription(res, userId) {
  if (process.env.STRIPE_ENABLED !== 'true') return true;
  const user = db.getUserById.get(userId);
  if (!user) { json(res, 401, { error: 'Unauthorized' }); return false; }
  const isSeedUser = process.env.SEED_USER_EMAIL &&
    user.email === process.env.SEED_USER_EMAIL.toLowerCase().trim();
  if (isSeedUser) return true;
  if (user.subscription_status === 'active') return true;
  if (user.subscription_status === 'trialing' && user.trial_ends_at && new Date(user.trial_ends_at) > new Date()) return true;
  json(res, 402, { error: 'Subscription required' });
  return false;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // -------------------------------------------------------------------------
  // PIXEL — permanently public, no auth
  // -------------------------------------------------------------------------
  if (pathname === '/pixel' && req.method === 'GET') {
    const trackId = parsed.query.id;
    if (trackId) {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      const userAgent = req.headers['user-agent'] || '';
      const email = db.getEmailByTrackId.get(trackId);
      if (!email) {
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': PIXEL.length, 'Cache-Control': 'no-store' });
        return res.end(PIXEL);
      }
      const opens = db.getOpensByTrackId.all(trackId);

      const { viaProxy, scannerReason } = isAutomatedScanner(ip, userAgent, trackId, opens, email.created_at);
      const geo = viaProxy && scannerReason === 'google_proxy'
        ? { city: 'Gmail Proxy', region: '', country: 'Google' }
        : viaProxy
          ? { city: 'Scanner', region: '', country: 'Automated' }
          : await geoLookup(ip);

      db.insertOpen.run({
        id: crypto.randomUUID(),
        trackId,
        timestamp: new Date().toISOString(),
        ip,
        userAgent,
        city: geo.city,
        region: geo.region,
        country: geo.country,
        viaProxy: viaProxy ? 1 : 0,
        scannerReason: scannerReason || null,
      });

      // Notify owner on first real open (notified flag prevents duplicates)
      const isFirstRealOpen = !viaProxy && opens.filter(o => !o.via_proxy).length === 0;
      if (isFirstRealOpen && email.notified === 0) {
        db.markEmailNotified.run(trackId);
        const owner = db.getUserById.get(email.user_id);
        if (owner) {
          sendOpenNotification({
            toEmail: owner.email,
            subject: email.subject,
            recipient: email.recipient,
            timestamp: new Date().toISOString(),
            city: geo.city,
            country: geo.country,
          }).catch(e => console.error(`[notify] Failed to send open notification for ${trackId}:`, e.message));
        }
      }

      // Retroactively patch earlier rapid-fire hits from the same IP/trackId
      if (scannerReason === 'rapid_fire_scanner') {
        const cutoff = new Date(Date.now() - 60000).toISOString();
        db.patchRapidFireOpens.run(trackId, ip, cutoff);
      }

      console.log(`Open: ${trackId} | ${viaProxy ? `[${scannerReason}]` : ip} | ${geo.city}, ${geo.country}`);
    }

    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': PIXEL.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    return res.end(PIXEL);
  }

  // -------------------------------------------------------------------------
  // BILLING — Stripe webhook (raw body, no JWT, no readBody)
  // -------------------------------------------------------------------------
  if (pathname === '/api/billing/webhook' && req.method === 'POST') {
    if (!stripe) { res.writeHead(503); return res.end('Billing not configured'); }

    const rawBody = await readRawBody(req);
    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      console.error('[stripe] Webhook signature verification failed:', e.message);
      res.writeHead(400); return res.end('Webhook signature verification failed');
    }

    const stripeStatusMap = { active: 'active', past_due: 'past_due', canceled: 'canceled', unpaid: 'past_due' };

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const customerId = session.customer;
      const result = db.updateSubscriptionStatus.run('active', customerId);
      if (result.changes === 0) {
        // Fallback: stripe_customer_id not in DB (rare race). Try matching by email.
        const email = session.customer_details?.email || session.customer_email;
        if (email) {
          const user = db.getUserByEmail.get(email.toLowerCase().trim());
          if (user) {
            db.updateStripeCustomer.run({ stripeCustomerId: customerId, subscriptionStatus: 'active', id: user.id });
            console.warn(`[stripe] checkout.session.completed: linked ${customerId} to ${email} via email fallback`);
          } else {
            console.error(`[stripe] checkout.session.completed: no user for customer ${customerId} or email ${email}`);
          }
        } else {
          console.error(`[stripe] checkout.session.completed: no user for customer ${customerId}, no email fallback`);
        }
      } else {
        console.log('[stripe] checkout.session.completed — customer:', customerId);
      }
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const status = stripeStatusMap[sub.status] || 'none';
      db.updateSubscriptionStatus.run(status, sub.customer);
      console.log(`[stripe] subscription.updated — customer: ${sub.customer} status: ${status}`);
    } else if (event.type === 'customer.subscription.deleted') {
      db.updateSubscriptionStatus.run('canceled', event.data.object.customer);
      console.log('[stripe] subscription.deleted — customer:', event.data.object.customer);
    } else if (event.type === 'invoice.payment_failed') {
      db.updateSubscriptionStatus.run('past_due', event.data.object.customer);
      console.log('[stripe] invoice.payment_failed — customer:', event.data.object.customer);
    }

    res.writeHead(200); return res.end('ok');
  }

  // -------------------------------------------------------------------------
  // AUTH — signup
  // -------------------------------------------------------------------------
  if (pathname === '/api/auth/signup' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { email, password } = body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return json(res, 400, { error: 'Valid email is required' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return json(res, 400, { error: 'Password must be at least 8 characters' });
    }

    const existing = db.getUserByEmail.get(email.toLowerCase().trim());
    if (existing) return json(res, 409, { error: 'An account with that email already exists' });

    const passwordHash = await hashPassword(password);
    const verificationToken = crypto.randomUUID();
    const userId = crypto.randomUUID();

    db.insertUser.run({
      id: userId,
      email: email.toLowerCase().trim(),
      passwordHash,
      verificationToken,
      createdAt: new Date().toISOString(),
    });

    try { await sendVerificationEmail(email.toLowerCase().trim(), verificationToken); }
    catch (e) { console.error('Failed to send verification email:', e.message); }

    return json(res, 201, { message: 'Account created. Check your email to verify your account.' });
  }

  // -------------------------------------------------------------------------
  // AUTH — login
  // -------------------------------------------------------------------------
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { email, password } = body;
    if (!email || !password) return json(res, 400, { error: 'Email and password are required' });

    const user = db.getUserByEmail.get(email.toLowerCase().trim());
    const passwordOk = user && await comparePassword(password, user.password_hash);

    if (!user || !passwordOk) {
      return json(res, 401, { error: 'Invalid email or password' });
    }
    const isSeedUser = process.env.SEED_USER_EMAIL &&
      user.email === process.env.SEED_USER_EMAIL.toLowerCase().trim();
    if (!user.email_verified && !isSeedUser) {
      return json(res, 403, { error: 'Please verify your email before logging in' });
    }

    db.updateLastLogin.run(new Date().toISOString(), user.id);
    const token = signToken(user.id);
    return json(res, 200, { token });
  }

  // -------------------------------------------------------------------------
  // AUTH — verify email
  // -------------------------------------------------------------------------
  if (pathname === '/api/auth/verify-email' && req.method === 'GET') {
    const token = parsed.query.token;
    if (!token) { return json(res, 400, { error: 'Missing token' }); }

    const user = db.getUserByVerificationToken.get(token);
    if (!user) { return json(res, 400, { error: 'Invalid or expired verification link' }); }

    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.verifyUserEmail.run({ id: user.id, trialEndsAt });
    res.writeHead(302, { Location: '/login?verified=1' });
    return res.end();
  }

  // -------------------------------------------------------------------------
  // EMAILS — create
  // -------------------------------------------------------------------------
  if (pathname === '/api/emails' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return;
    if (!requireSubscription(res, userId)) return;

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const trackId = crypto.randomUUID();
    db.insertEmail.run({
      trackId,
      userId,
      subject: (body.subject || '(no subject)').trim() || '(no subject)',
      recipient: body.recipient || '',
      bodyHtml: body.bodyHtml || '',
      createdAt: new Date().toISOString(),
    });

    return json(res, 200, { trackId, pixelUrl: `${BASE_URL}/pixel?id=${trackId}` });
  }

  // -------------------------------------------------------------------------
  // EMAILS — list
  // -------------------------------------------------------------------------
  if (pathname === '/api/emails' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return;
    if (!requireSubscription(res, userId)) return;

    const emails = db.getEmailsByUser.all(userId);
    const result = emails.map(email => {
      const opens = db.getOpensByTrackId.all(email.track_id);
      const locations = [...new Set(
        opens.map(o => [o.city, o.country].filter(Boolean).join(', '))
      )].filter(Boolean);
      const realOpenCount = opens.filter(o => !o.via_proxy).length;
      return {
        trackId: email.track_id,
        subject: email.subject,
        recipient: email.recipient,
        createdAt: email.created_at,
        openCount: opens.length,
        realOpenCount,
        firstOpen: opens[0]?.timestamp || null,
        lastOpen: opens[opens.length - 1]?.timestamp || null,
        locations,
        opens: opens.map(o => ({
          id: o.id,
          trackId: o.track_id,
          timestamp: o.timestamp,
          ip: o.ip,
          userAgent: o.user_agent,
          city: o.city,
          region: o.region,
          country: o.country,
          viaProxy: !!o.via_proxy,
          scannerReason: o.scanner_reason,
        })),
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  // -------------------------------------------------------------------------
  // EMAILS — update
  // -------------------------------------------------------------------------
  if (pathname.startsWith('/api/emails/') && req.method === 'PATCH') {
    const userId = requireAuth(req, res);
    if (!userId) return;
    if (!requireSubscription(res, userId)) return;

    const parts = pathname.split('/');
    const trackId = parts[3];
    if (!trackId) return json(res, 404, { error: 'Not found' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { subject, recipient } = body;
    if ((subject !== undefined && typeof subject !== 'string') ||
        (recipient !== undefined && typeof recipient !== 'string')) {
      return json(res, 400, { error: 'subject and recipient must be strings' });
    }

    const email = db.getEmailByTrackId.get(trackId);
    if (!email || email.user_id !== userId) return json(res, 404, { error: 'Not found' });

    db.updateEmail.run({
      subject: subject !== undefined ? (subject.trim() || '(no subject)') : email.subject,
      recipient: recipient !== undefined ? recipient.trim() : email.recipient,
      trackId,
      userId,
    });

    return json(res, 200, { ok: true });
  }

  // -------------------------------------------------------------------------
  // EMAILS — delete
  // -------------------------------------------------------------------------
  if (pathname.startsWith('/api/emails/') && req.method === 'DELETE') {
    const userId = requireAuth(req, res);
    if (!userId) return;
    if (!requireSubscription(res, userId)) return;

    const parts = pathname.split('/');
    const trackId = parts[3];
    if (!trackId) return json(res, 404, { error: 'Not found' });

    const email = db.getEmailByTrackId.get(trackId);
    if (!email || email.user_id !== userId) return json(res, 404, { error: 'Not found' });

    db.deleteEmail.run(trackId, userId);
    return json(res, 200, { ok: true });
  }

  // -------------------------------------------------------------------------
  // BILLING — create Stripe Checkout session
  // -------------------------------------------------------------------------
  if (pathname === '/api/billing/create-checkout-session' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return;
    if (!stripe) return json(res, 503, { error: 'Billing not configured' });

    const user = db.getUserById.get(userId);
    if (!user) return json(res, 401, { error: 'Unauthorized' });

    try {
      let stripeCustomerId = user.stripe_customer_id;
      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({ email: user.email });
        stripeCustomerId = customer.id;
        db.updateStripeCustomer.run({ stripeCustomerId, subscriptionStatus: user.subscription_status, id: userId });
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
        success_url: `${BASE_URL}/billing?success=1`,
        cancel_url: `${BASE_URL}/billing?canceled=1`,
      });

      return json(res, 200, { url: session.url });
    } catch (e) {
      console.error('[stripe] create-checkout-session error:', e.message);
      return json(res, 502, { error: 'Could not create checkout session. Please try again.' });
    }
  }

  // -------------------------------------------------------------------------
  // BILLING — create Stripe Customer Portal session
  // -------------------------------------------------------------------------
  if (pathname === '/api/billing/create-portal-session' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return;
    if (!stripe) return json(res, 503, { error: 'Billing not configured' });

    const user = db.getUserById.get(userId);
    if (!user) return json(res, 401, { error: 'Unauthorized' });
    if (!user.stripe_customer_id) {
      return json(res, 400, { error: 'No billing account found. Subscribe first.' });
    }

    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripe_customer_id,
        return_url: `${BASE_URL}/billing`,
      });
      return json(res, 200, { url: session.url });
    } catch (e) {
      console.error('[stripe] create-portal-session error:', e.message);
      return json(res, 502, { error: 'Could not open billing portal. Please try again.' });
    }
  }

  // -------------------------------------------------------------------------
  // BILLING — get subscription status
  // -------------------------------------------------------------------------
  if (pathname === '/api/billing/status' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const user = db.getUserById.get(userId);
    return json(res, 200, {
      subscription_status: user.subscription_status,
      stripe_customer_id: user.stripe_customer_id,
      trial_ends_at: user.trial_ends_at,
    });
  }

  // -------------------------------------------------------------------------
  // ADMIN — list users
  // -------------------------------------------------------------------------
  if (pathname === '/api/admin/users' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const caller = db.getUserById.get(userId);
    const seedEmail = process.env.SEED_USER_EMAIL && process.env.SEED_USER_EMAIL.toLowerCase().trim();
    if (!caller || caller.email !== seedEmail) return json(res, 403, { error: 'Forbidden' });

    const users = db.getAllUsers.all().map(u => ({
      id: u.id,
      email: u.email,
      emailVerified: !!u.email_verified,
      subscriptionStatus: u.subscription_status,
      trialEndsAt: u.trial_ends_at,
      createdAt: u.created_at,
      lastLogin: u.last_login,
      isSeed: u.email === seedEmail,
    }));
    return json(res, 200, users);
  }

  // -------------------------------------------------------------------------
  // ADMIN — activate / deactivate user
  // -------------------------------------------------------------------------
  if (pathname.startsWith('/api/admin/users/') && req.method === 'PATCH') {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const caller = db.getUserById.get(userId);
    const seedEmail = process.env.SEED_USER_EMAIL && process.env.SEED_USER_EMAIL.toLowerCase().trim();
    if (!caller || caller.email !== seedEmail) return json(res, 403, { error: 'Forbidden' });

    const targetId = pathname.split('/')[4];
    if (!targetId) return json(res, 400, { error: 'User id required' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { action } = body;
    let result;
    if (action === 'activate') {
      result = db.updateSubscriptionStatusById.run('active', targetId);
    } else if (action === 'deactivate') {
      result = db.updateSubscriptionStatusById.run('none', targetId);
    } else {
      return json(res, 400, { error: 'action must be activate or deactivate' });
    }

    if (result.changes === 0) return json(res, 404, { error: 'User not found' });
    return json(res, 200, { ok: true });
  }

  // -------------------------------------------------------------------------
  // ADMIN — delete user
  // -------------------------------------------------------------------------
  if (pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const caller = db.getUserById.get(userId);
    const seedEmail = process.env.SEED_USER_EMAIL && process.env.SEED_USER_EMAIL.toLowerCase().trim();
    if (!caller || caller.email !== seedEmail) return json(res, 403, { error: 'Forbidden' });

    const targetId = pathname.split('/')[4];
    if (!targetId) return json(res, 400, { error: 'User id required' });

    const target = db.getUserById.get(targetId);
    if (!target) return json(res, 404, { error: 'User not found' });
    if (target.email === seedEmail) return json(res, 400, { error: 'Cannot delete the seed user' });

    db.db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
    return json(res, 200, { ok: true });
  }

  // -------------------------------------------------------------------------
  // ADMIN — delete user by email
  // -------------------------------------------------------------------------
  if (pathname === '/api/admin/delete-user' && req.method === 'DELETE') {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const caller = db.getUserById.get(userId);
    const seedEmail = process.env.SEED_USER_EMAIL && process.env.SEED_USER_EMAIL.toLowerCase().trim();
    if (!caller || caller.email !== seedEmail) return json(res, 403, { error: 'Forbidden' });

    let body;
    try { body = await readBody(req); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const email = body.email && typeof body.email === 'string' ? body.email.toLowerCase().trim() : null;
    if (!email) return json(res, 400, { error: 'email is required' });

    const target = db.getUserByEmail.get(email);
    if (!target) return json(res, 404, { error: 'User not found' });
    if (target.email === seedEmail) return json(res, 400, { error: 'Cannot delete the seed user' });

    db.db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    return json(res, 200, { ok: true, deleted: email });
  }

  // -------------------------------------------------------------------------
  // Static files
  // -------------------------------------------------------------------------
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(302, { Location: '/app' });
    return res.end();
  }

  if (pathname === '/app') {
    const file = path.join(__dirname, 'public', 'app.html');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(file));
    }
  }

  if (pathname === '/login') {
    const file = path.join(__dirname, 'public', 'login.html');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(file));
    }
  }

  if (pathname === '/billing') {
    const file = path.join(__dirname, 'public', 'billing.html');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(file));
    }
  }

  if (pathname === '/admin') {
    const file = path.join(__dirname, 'public', 'admin.html');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(file));
    }
  }

  if (pathname === '/nequi') {
    const file = path.join(__dirname, 'public', 'nequi.html');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(file));
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✉  Email Tracker running at http://localhost:${PORT}`);
  console.log(`   DB:         ${process.env.DB_PATH || './db/tracker.db'}`);
  console.log(`   Base URL:   ${BASE_URL}`);
  console.log(`   Dashboard:  http://localhost:${PORT}/app\n`);
});
