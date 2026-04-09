const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'tracker.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    verification_token TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS emails (
    track_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL DEFAULT '(no subject)',
    recipient TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_emails_user_id ON emails(user_id);

  CREATE TABLE IF NOT EXISTS opens (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES emails(track_id) ON DELETE CASCADE,
    timestamp TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    via_proxy INTEGER NOT NULL DEFAULT 0,
    scanner_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_opens_track_id ON opens(track_id);
`);

// Add Stripe + trial + activity columns to users table (idempotent — try/catch each ALTER)
for (const sql of [
  `ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`,
  `ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE users ADD COLUMN trial_ends_at TEXT`,
  `ALTER TABLE users ADD COLUMN last_login TEXT`,
]) {
  try { db.prepare(sql).run(); } catch {}
}

// Backfill existing users: give them a 7-day trial if they have no Stripe customer yet
db.prepare(`
  UPDATE users SET subscription_status = 'trialing', trial_ends_at = ?
  WHERE subscription_status = 'none' AND stripe_customer_id IS NULL
`).run(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());

module.exports = {
  // Users
  getUserByEmail:              db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserById:                 db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByVerificationToken:  db.prepare('SELECT * FROM users WHERE verification_token = ?'),
  getUserByStripeCustomerId:   db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?'),
  insertUser:                  db.prepare(`
    INSERT INTO users (id, email, password_hash, email_verified, verification_token, created_at)
    VALUES (@id, @email, @passwordHash, 0, @verificationToken, @createdAt)
  `),
  verifyUserEmail:             db.prepare(`
    UPDATE users SET email_verified = 1, verification_token = NULL,
      subscription_status = 'trialing', trial_ends_at = @trialEndsAt
    WHERE id = @id
  `),
  updateStripeCustomer:        db.prepare(`
    UPDATE users SET stripe_customer_id = @stripeCustomerId, subscription_status = @subscriptionStatus WHERE id = @id
  `),
  updateSubscriptionStatus:        db.prepare(`UPDATE users SET subscription_status = ? WHERE stripe_customer_id = ?`),
  updateSubscriptionStatusById:    db.prepare(`UPDATE users SET subscription_status = ? WHERE id = ?`),
  updateLastLogin:                 db.prepare(`UPDATE users SET last_login = ? WHERE id = ?`),
  getAllUsers:                      db.prepare(`SELECT * FROM users ORDER BY created_at DESC`),

  // Emails
  getEmailsByUser:  db.prepare('SELECT * FROM emails WHERE user_id = ? ORDER BY created_at DESC'),
  getEmailByTrackId: db.prepare('SELECT * FROM emails WHERE track_id = ?'),
  insertEmail:      db.prepare(`
    INSERT INTO emails (track_id, user_id, subject, recipient, body_html, created_at)
    VALUES (@trackId, @userId, @subject, @recipient, @bodyHtml, @createdAt)
  `),
  updateEmail:      db.prepare(`
    UPDATE emails SET subject = @subject, recipient = @recipient
    WHERE track_id = @trackId AND user_id = @userId
  `),
  deleteEmail:      db.prepare('DELETE FROM emails WHERE track_id = ? AND user_id = ?'),

  // Opens
  getOpensByTrackId: db.prepare('SELECT * FROM opens WHERE track_id = ?'),
  insertOpen:        db.prepare(`
    INSERT INTO opens (id, track_id, timestamp, ip, user_agent, city, region, country, via_proxy, scanner_reason)
    VALUES (@id, @trackId, @timestamp, @ip, @userAgent, @city, @region, @country, @viaProxy, @scannerReason)
  `),
  // Retroactive rapid-fire patching: flip earlier hits from same IP/trackId within 60s window
  patchRapidFireOpens: db.prepare(`
    UPDATE opens SET via_proxy = 1, scanner_reason = 'rapid_fire_scanner'
    WHERE track_id = ? AND ip = ? AND via_proxy = 0 AND timestamp >= ?
  `),

  db,
};

// Seed user — upsert on startup
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
if (process.env.SEED_USER_EMAIL && process.env.SEED_USER_PASSWORD) {
  const email = process.env.SEED_USER_EMAIL.toLowerCase().trim();
  const hash = bcrypt.hashSync(process.env.SEED_USER_PASSWORD, 10);
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!existing) {
    db.prepare(`INSERT INTO users (id, email, password_hash, email_verified, verification_token, created_at) VALUES (?, ?, ?, 1, NULL, ?)`).run(crypto.randomUUID(), email, hash, new Date().toISOString());
    console.log('[db] Seed user created:', email);
  } else {
    db.prepare(`UPDATE users SET password_hash = ?, email_verified = 1 WHERE email = ?`).run(hash, email);
    console.log('[db] Seed user password updated:', email);
  }
}
