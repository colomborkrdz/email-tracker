const db = require('../lib/db');

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/delete-user.js <email>');
  process.exit(1);
}

const user = db.getUserByEmail.get(email.toLowerCase().trim());
if (!user) {
  console.error(`No user found with email: ${email}`);
  process.exit(1);
}

db.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
console.log(`Deleted user: ${email}`);
