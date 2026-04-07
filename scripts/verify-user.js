const db = require('../lib/db');

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/verify-user.js <email>');
  process.exit(1);
}

const user = db.getUserByEmail.get(email.toLowerCase().trim());
if (!user) {
  console.error(`No user found with email: ${email}`);
  process.exit(1);
}

if (user.email_verified) {
  console.log(`Already verified: ${email}`);
  process.exit(0);
}

db.verifyUserEmail.run(user.id);
console.log(`Verified: ${email}`);
