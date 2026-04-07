const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function getJwtSecret() {
  if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET env var is not set. Server cannot start safely.');
    process.exit(1);
  }
  return process.env.JWT_SECRET;
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, getJwtSecret()); // throws on invalid or expired
}

module.exports = { hashPassword, comparePassword, signToken, verifyToken };
