const nodemailer = require('nodemailer');

const BASE_URL = process.env.BASE_URL || 'https://track.mangacreativestudios.com';

async function sendVerificationEmail(toEmail, token) {
  const verifyUrl = `${BASE_URL}/api/auth/verify-email?token=${token}`;

  if (!process.env.SMTP_HOST) {
    console.log(`[email] SMTP not configured. Verification URL for ${toEmail}:`);
    console.log(`  ${verifyUrl}`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || 'Email Tracker <noreply@mangacreativestudios.com>',
    to: toEmail,
    subject: 'Verify your Email Tracker account',
    text: `Verify your account: ${verifyUrl}\n\nThis link expires in 24 hours.`,
    html: `
      <p>Thanks for signing up for Email Tracker.</p>
      <p><a href="${verifyUrl}">Click here to verify your email address</a></p>
      <p>Or copy this link: ${verifyUrl}</p>
      <p>This link expires in 24 hours.</p>
    `,
  });
}

module.exports = { sendVerificationEmail };
