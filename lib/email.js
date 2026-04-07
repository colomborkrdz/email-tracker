const BASE_URL = process.env.BASE_URL || 'https://track.mangacreativestudios.com';

async function sendVerificationEmail(toEmail, token) {
  const verifyUrl = `${BASE_URL}/api/auth/verify-email?token=${token}`;

  if (!process.env.SMTP_PASS) {
    console.log(`[email] Resend API key not configured. Verification URL for ${toEmail}:`);
    console.log(`  ${verifyUrl}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SMTP_PASS}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.SMTP_FROM,
      to: toEmail,
      subject: 'Verify your Email Tracker account',
      text: `Verify your account: ${verifyUrl}\n\nThis link expires in 24 hours.`,
      html: `
        <p>Thanks for signing up for Email Tracker.</p>
        <p><a href="${verifyUrl}">Click here to verify your email address</a></p>
        <p>Or copy this link: ${verifyUrl}</p>
        <p>This link expires in 24 hours.</p>
      `,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Resend API error ${res.status}: ${error}`);
  }
}

module.exports = { sendVerificationEmail };
