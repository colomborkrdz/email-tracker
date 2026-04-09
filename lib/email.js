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

async function sendOpenNotification({ toEmail, subject, recipient, timestamp, city, country }) {
  const location = [city, country].filter(Boolean).join(', ') || 'Unknown location';
  const when = new Date(timestamp).toUTCString();

  if (!process.env.SMTP_PASS) {
    console.log(`[email] Open notification (no API key) → ${toEmail}: "${subject}" opened from ${location}`);
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
      subject: `${subject} was opened`,
      text: `Your tracked email was opened.\n\nSubject: ${subject}\nTo: ${recipient || '(no recipient)'}\nWhen: ${when}\nLocation: ${location}`,
      html: `
        <p>Your tracked email was opened.</p>
        <table>
          <tr><td><strong>Subject</strong></td><td>${subject}</td></tr>
          <tr><td><strong>To</strong></td><td>${recipient || '(no recipient)'}</td></tr>
          <tr><td><strong>When</strong></td><td>${when}</td></tr>
          <tr><td><strong>Location</strong></td><td>${location}</td></tr>
        </table>
        <p><a href="${BASE_URL}/app">View dashboard</a></p>
      `,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Resend API error ${res.status}: ${error}`);
  }
}

module.exports = { sendVerificationEmail, sendOpenNotification };
