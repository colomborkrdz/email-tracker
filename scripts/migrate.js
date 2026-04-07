/**
 * One-time migration: transfers db/data.json → SQLite, assigned to a seed (founding) user.
 *
 * Required env vars:
 *   SEED_USER_EMAIL    - email for the founding user account
 *   SEED_USER_PASSWORD - password for the founding user account
 *   DB_PATH            - path to SQLite file (defaults to ./db/tracker.db)
 *
 * Usage:
 *   SEED_USER_EMAIL=you@example.com SEED_USER_PASSWORD=secret node scripts/migrate.js
 *
 * Idempotent: safe to run multiple times.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('../lib/db');
const { hashPassword } = require('../lib/auth');

const DATA_JSON_PATH = process.env.DATA_JSON_PATH || path.join(__dirname, '..', 'db', 'data.json');

async function migrate() {
  const seedEmail = process.env.SEED_USER_EMAIL;
  const seedPassword = process.env.SEED_USER_PASSWORD;

  if (!seedEmail || !seedPassword) {
    console.error('Error: SEED_USER_EMAIL and SEED_USER_PASSWORD env vars are required.');
    process.exit(1);
  }

  if (!fs.existsSync(DATA_JSON_PATH)) {
    console.log(`No data.json found at ${DATA_JSON_PATH}. Nothing to migrate.`);
    console.log('Seed user will still be created if it does not exist.');
  }

  // Create or find seed user
  let seedUser = db.getUserByEmail.get(seedEmail);
  if (!seedUser) {
    const passwordHash = await hashPassword(seedPassword);
    const userId = crypto.randomUUID();
    db.insertUser.run({
      id: userId,
      email: seedEmail,
      passwordHash,
      verificationToken: null,
      createdAt: new Date().toISOString(),
    });
    db.verifyUserEmail.run(userId); // founding user is pre-verified
    seedUser = db.getUserByEmail.get(seedEmail);
    console.log(`Created seed user: ${seedEmail} (id: ${seedUser.id})`);
  } else {
    console.log(`Seed user already exists: ${seedEmail} (id: ${seedUser.id})`);
  }

  if (!fs.existsSync(DATA_JSON_PATH)) return;

  const data = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf8'));
  const emails = Object.values(data.emails || {});
  const opens = data.opens || [];

  let emailsInserted = 0;
  let opensInserted = 0;
  let emailsSkipped = 0;
  let opensSkipped = 0;

  for (const email of emails) {
    const existing = db.getEmailByTrackId.get(email.trackId);
    if (existing) { emailsSkipped++; continue; }
    db.insertEmail.run({
      trackId: email.trackId,
      userId: seedUser.id,
      subject: email.subject || '(no subject)',
      recipient: email.recipient || '',
      bodyHtml: email.bodyHtml || '',
      createdAt: email.createdAt || new Date().toISOString(),
    });
    emailsInserted++;
  }

  for (const open of opens) {
    const emailExists = db.getEmailByTrackId.get(open.trackId);
    if (!emailExists) { opensSkipped++; continue; }
    try {
      db.insertOpen.run({
        id: open.id,
        trackId: open.trackId,
        timestamp: open.timestamp,
        ip: open.ip || '',
        userAgent: open.userAgent || '',
        city: open.city || '',
        region: open.region || '',
        country: open.country || '',
        viaProxy: open.viaProxy ? 1 : 0,
        scannerReason: open.scannerReason || null,
      });
      opensInserted++;
    } catch (e) {
      if (e.message.includes('UNIQUE constraint failed')) { opensSkipped++; }
      else throw e;
    }
  }

  console.log(`\nMigration complete:`);
  console.log(`  Emails: ${emailsInserted} inserted, ${emailsSkipped} skipped (already existed)`);
  console.log(`  Opens:  ${opensInserted} inserted, ${opensSkipped} skipped`);
  console.log(`  Seed user: ${seedEmail}`);
}

migrate().catch(err => { console.error('Migration failed:', err); process.exit(1); });
