// /api/waitlist.js — handles user/venue waitlist + event RSVPs + +1 invite-forward.
//
// Accepted shapes:
//   type='u'              user waitlist signup
//   type='v'              venue / partner signup (extra fields)
//   type='rsvp'           event RSVP (response: 'yes' | 'no' | 'forwarded')
//
// When type='rsvp' AND response='forwarded' (a +1 added by the original
// invitee), we ALSO send a transactional invite to the friend via Resend
// — they get a personalised email with their own one-tap RSVP link.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const {
    type, firstName, lastName, email, city, interest,
    venueName, companyName, address, venueType, role, phone,
    // RSVP-only fields
    response, campaign, referredBy, inviterFirstName,
  } = req.body;

  if (!email) return res.status(400).json({ error: 'Email is required' });

  const isVenue = type === 'v';
  const isRsvp  = type === 'rsvp';
  const rsvpResp = isRsvp ? String(response || '').toLowerCase() : '';
  const isForwarded = isRsvp && rsvpResp === 'forwarded';

  let labelName;
  if (isVenue) {
    labelName = 'Blackboard Venue Waitlist';
  } else if (isRsvp) {
    const camp = (campaign || 'Launch').replace(/[^a-zA-Z0-9 -]/g, '').slice(0, 40);
    const tag = isForwarded ? 'Forwarded' : (rsvpResp === 'yes' ? 'Yes' : 'No');
    labelName = `Blackboard ${camp} RSVP — ${tag}`;
  } else {
    labelName = 'Blackboard User Waitlist';
  }

  const payload = {
    first_name: isVenue ? (firstName || venueName) : (firstName || ''),
    last_name: isVenue ? '' : (lastName || ''),
    email,
    city,
    label_names: [labelName],
  };

  if (isVenue && (companyName || venueName)) payload.organization_name = companyName || venueName;
  if (isVenue && venueType) payload.title = venueType;
  if (isVenue && role) payload.seniority = role;
  if (isVenue && address) payload.street_address = address;
  if (interest) payload.present_raw_address = interest;
  if (phone) payload.direct_phone = phone;

  if (isRsvp) {
    const parts = [`Response: ${response}`];
    if (campaign) parts.push(`Campaign: ${campaign}`);
    if (referredBy) parts.push(`Referred by: ${referredBy}`);
    payload.present_raw_address = parts.join(' | ');
  }

  let apolloOk = false;
  let apolloData = null;
  try {
    const apolloRes = await fetch('https://api.apollo.io/v1/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': process.env.APOLLO_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    apolloData = await apolloRes.json();
    apolloOk = apolloRes.ok;
    if (!apolloOk) console.error('Apollo error:', apolloData);
  } catch (err) {
    console.error('Apollo network error:', err);
  }

  // For forwarded +1s, send the invite to the friend via Resend. We still
  // succeed if the Resend call fails — the contact is in Apollo and the
  // sender can be told to nudge manually.
  let inviteEmailOk = false;
  if (isForwarded && process.env.RESEND_API_KEY) {
    try {
      const friendName = (firstName || '').trim();
      const inviter = (inviterFirstName || '').trim() || (referredBy || 'A friend');
      const subject = friendName
        ? `${friendName}, you're invited — Blackboard launch party, Fri 19 Jun`
        : `You're invited — Blackboard launch party, Fri 19 Jun`;

      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: 'Blackboard <website@blackboarddeals.com>',
          to: [email],
          reply_to: referredBy || 'support@blackboarddeals.com',
          subject,
          html: buildInviteHtml({ friendEmail: email, friendName, inviter, campaign: campaign || 'Launch' }),
        }),
      });
      inviteEmailOk = resendRes.ok;
      if (!inviteEmailOk) {
        const errBody = await resendRes.text().catch(() => '');
        console.error('Resend error:', resendRes.status, errBody);
      }
    } catch (err) {
      console.error('Resend network error:', err);
    }
  }

  if (!apolloOk) {
    return res.status(500).json({ error: 'Failed to add to Apollo' });
  }
  return res.status(200).json({
    success: true,
    invited: isForwarded ? inviteEmailOk : null,
  });
}

function buildInviteHtml({ friendEmail, friendName, inviter, campaign }) {
  const enc = encodeURIComponent;
  const yes = `https://blackboarddeals.com/rsvp?email=${enc(friendEmail)}&rsvp=yes&campaign=${enc(campaign)}&ref=${enc(inviter)}`;
  const no  = `https://blackboarddeals.com/rsvp?email=${enc(friendEmail)}&rsvp=no&campaign=${enc(campaign)}&ref=${enc(inviter)}`;
  const greeting = friendName ? `${friendName} — ` : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0; padding:0; background:#060608;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#060608" style="background:#060608;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" bgcolor="#0d0d10" style="background:#0d0d10; max-width:600px; width:100%; font-family:Arial,Helvetica,sans-serif; color:#f7f7f5;">

  <tr><td style="padding:14px 24px; border-bottom:1px solid #2c2c34;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
      <td align="left" style="font-family:Arial,Helvetica,sans-serif; font-size:10px; letter-spacing:0.2em; text-transform:uppercase; color:#d4d4dc;">BLACKBOARDDEALS.COM</td>
      <td align="right" style="font-family:Arial,Helvetica,sans-serif; font-size:10px; letter-spacing:0.2em; text-transform:uppercase; color:#DAA520;">${inviter} invited you</td>
    </tr></table>
  </td></tr>

  <tr><td align="center" style="padding:36px 24px 10px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center"><tr>
      <td style="border:2px solid #ffffff; padding:12px 30px;">
        <span style="font-family:'Arial Black',Arial,Helvetica,sans-serif; font-size:20px; letter-spacing:0.4em; color:#ffffff; font-weight:900;">BLACKBOARD</span>
      </td>
    </tr></table>
  </td></tr>
  <tr><td align="center" style="padding:16px 24px 20px;">
    <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:0.32em; text-transform:uppercase; color:#DAA520; font-weight:bold;">YOU'RE INVITED TO THE LAUNCH PARTY</p>
  </td></tr>

  <tr><td align="center" style="padding:12px 12px; border-top:1px solid #2c2c34; border-bottom:1px solid #2c2c34;">
    <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:0.3em; text-transform:uppercase; color:#DAA520; font-weight:bold;">LAUNCH PARTY &nbsp;&#10022;&nbsp; LIVE MUSIC &nbsp;&#10022;&nbsp; RIVERSIDE BAR &nbsp;&#10022;&nbsp; NEARLY ONE YEAR</p>
  </td></tr>

  <tr><td align="center" style="padding:36px 32px 0;">
    <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:0.3em; text-transform:uppercase; color:#DAA520; font-weight:bold;">${greeting}YOU'RE ON THE LIST</p>
  </td></tr>
  <tr><td align="center" style="padding:18px 24px 0;">
    <h1 style="margin:0; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-weight:normal; font-size:42px; line-height:46px; color:#ffffff;">Glasses up,<br />we made it.</h1>
  </td></tr>
  <tr><td align="center" style="padding:18px 32px 24px;">
    <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:16px; line-height:1.55; color:#e8e8ec;"><strong style="color:#ffffff;">${inviter}</strong> wants you at the Blackboard launch party. Same one-tap RSVP, no faff.</p>
  </td></tr>

  <tr><td style="padding:0 24px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#DAA520" style="background:#DAA520;">
      <tr><td align="center" style="padding:14px 12px; font-family:Arial,Helvetica,sans-serif; font-size:12px; letter-spacing:0.16em; text-transform:uppercase; color:#0d0d10; font-weight:bold;">
        FRI 19 JUNE &middot; 7:30PM 'TIL LATE &middot; WEBREW KINGSTON
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:40px 32px 0;">
    <p style="margin:0 0 10px; font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:0.3em; text-transform:uppercase; color:#e8c878; font-weight:bold;">THE INVITE</p>
    <h2 style="margin:0 0 14px; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-weight:normal; font-size:26px; line-height:30px; color:#ffffff;">Come celebrate launch night.</h2>
    <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:1.7; color:#e8e8ec;">Nearly a year of work, finally live in the App Store and Google Play. We're raising a glass at WeBrew — live music, cold beer on the river, the whole team in the room. ${inviter} thinks you'd love it. We agree.</p>
  </td></tr>

  <tr><td style="padding:36px 24px 0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#14141a" style="background:#14141a; border:1px solid #2c2c34; border-left:3px solid #DAA520;">
      <tr><td style="padding:22px 24px;">
        <p style="margin:0 0 16px; font-family:Arial,Helvetica,sans-serif; font-size:10px; letter-spacing:0.3em; text-transform:uppercase; color:#e8c878; font-weight:bold;">THE DETAILS</p>
        <p style="margin:0 0 8px; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:1.6; color:#f7f7f5;"><strong style="color:#ffffff;">WeBrew</strong> &middot; 5 Ram Passage, Kingston upon Thames, KT1 1HH</p>
        <p style="margin:0 0 8px; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:1.6; color:#f7f7f5;"><strong style="color:#ffffff;">Fri 19 June</strong> &middot; Doors 7:30pm 'til late</p>
        <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:1.6; color:#f7f7f5;">Live music. Cold ones. A +1 is welcome.</p>
      </td></tr>
    </table>
  </td></tr>

  <tr><td align="center" style="padding:44px 32px 6px;">
    <p style="margin:0 0 8px; font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:0.3em; text-transform:uppercase; color:#e8c878; font-weight:bold;">SO - ARE YOU IN?</p>
    <p style="margin:0 0 22px; font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:0.22em; text-transform:uppercase; color:#7a7a82;">Tap one - we'll know</p>
  </td></tr>
  <tr><td align="center" style="padding:0 24px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center"><tr>
      <td bgcolor="#DAA520" style="background:#DAA520;">
        <a href="${yes}" target="_blank" style="display:inline-block; padding:16px 34px; font-family:Arial,Helvetica,sans-serif; font-size:13px; letter-spacing:0.22em; text-transform:uppercase; color:#0d0d10; text-decoration:none; font-weight:bold;">Yes - I'm in &nbsp;&rarr;</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td align="center" style="padding:14px 24px 0;">
    <a href="${no}" target="_blank" style="font-family:Arial,Helvetica,sans-serif; font-size:12px; letter-spacing:0.22em; text-transform:uppercase; color:#d4d4dc; text-decoration:underline;">Can't make it</a>
  </td></tr>

  <tr><td bgcolor="#060608" align="center" style="background:#060608; padding:44px 24px 18px; border-top:1px solid #2c2c34;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center"><tr>
      <td style="border:2px solid #ffffff; padding:8px 22px;">
        <span style="font-family:'Arial Black',Arial,Helvetica,sans-serif; font-size:14px; letter-spacing:0.36em; color:#ffffff; font-weight:900;">BLACKBOARD</span>
      </td>
    </tr></table>
  </td></tr>
  <tr><td bgcolor="#060608" align="center" style="background:#060608; padding:14px 24px 0;">
    <p style="margin:0; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-weight:normal; font-size:14px; color:#d4d4dc;">Nearly a year on. Liquid to lips.</p>
  </td></tr>
  <tr><td bgcolor="#060608" align="center" style="background:#060608; padding:18px 24px 36px;">
    <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:11px; line-height:1.55; color:#7a7a82;">
      ${inviter} thought you'd love this — that's why you got it.<br />
      WeBrew &middot; 5 Ram Passage, Kingston upon Thames, KT1 1HH
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}
