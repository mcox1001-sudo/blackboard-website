export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required' });
  }

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'website@blackboarddeals.com',
        to: [process.env.CONTACT_EMAIL || 'hello@blackboarddeals.com'],
        reply_to: email,
        subject: `New message from ${name} — blackboarddeals.com`,
        html: `
          <div style="font-family:sans-serif;max-width:560px">
            <h2 style="margin:0 0 16px">New contact message</h2>
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
            <hr style="margin:20px 0;border:none;border-top:1px solid #eee"/>
            <p style="white-space:pre-wrap">${message}</p>
          </div>
        `,
      }),
    });

    if (!resendRes.ok) {
      const err = await resendRes.json();
      console.error('Resend error:', err);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Contact error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
