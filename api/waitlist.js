// /api/waitlist.js — bulletproof RSVP capture.
//
// Goal: a click on Yes/No or a +1 add must NEVER fail user-side. We try
// every available storage path (Apollo, Google Apps Script webhook, Resend
// notification) and log everything to stdout regardless — so even if every
// integration is misconfigured, the RSVP is still in Vercel's runtime logs
// and recoverable.
//
// Env vars (all optional — first one set wins, the rest run as belt-and-braces):
//   APOLLO_API_KEY                Apollo /v1/contacts (with label_names tag)
//   GOOGLE_SHEET_WEBHOOK_URL      Apps Script doPost(e) URL — posts JSON, appends a row
//   RESEND_API_KEY                Email notification to support@blackboarddeals.com
//
// Body shape:
//   type='u' | 'v' | 'rsvp'
//   email                         required
//   response='yes'|'no'|'forwarded'  RSVP type
//   firstName, lastName, city, campaign, referredBy, inviterFirstName … extras
//
// Response:
//   { success: true, captured: { apollo, sheet, notify, log },
//     apolloError?, sheetError?, notifyError? }
//
// success is true whenever email is valid; the user always sees "See you
// there". captured.log === true always — the RSVP is in Vercel logs and
// can be queried/exported from the dashboard.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const {
    type, firstName, lastName, email, city, interest,
    venueName, companyName, address, venueType, role, phone,
    response, campaign, referredBy, inviterFirstName,
  } = body;

  if (!email) return res.status(400).json({ error: 'Email is required' });

  const isVenue = type === 'v';
  const isRsvp  = type === 'rsvp';
  const rsvpResp = isRsvp ? String(response || '').toLowerCase() : '';
  const isForwarded = isRsvp && rsvpResp === 'forwarded';

  const camp = (campaign || 'Launch').replace(/[^a-zA-Z0-9 -]/g, '').slice(0, 40);
  // Labels are Apollo's "Lists". For event RSVPs we always tag with the base
  // list "BB Launch Party" so filtering that one list shows everyone, plus a
  // response-specific list for breakdown. Venue/user signups keep their
  // existing single-label routing.
  let labelNames;
  if (isVenue) labelNames = ['Blackboard Venue Waitlist'];
  else if (isRsvp) {
    const tag = isForwarded ? 'Forwarded' : (rsvpResp === 'yes' ? 'Yes' : 'No');
    labelNames = ['BB Launch Party', `BB Launch Party — ${tag}`];
  } else labelNames = ['Blackboard User Waitlist'];
  const labelName = labelNames[0];

  // Always log first — minimal recoverable record. Filter Vercel runtime
  // logs for "[RSVP]" or "[WAITLIST]" to recover all signups.
  const tag = isRsvp ? `RSVP:${rsvpResp}` : (isVenue ? 'VENUE' : 'USER');
  console.log(`[WAITLIST] tag=${tag}`, JSON.stringify({
    email, firstName, lastName, response, campaign: camp, referredBy,
    venueName, companyName, label: labelName, ts: new Date().toISOString(),
  }));

  // ---- Path 1: Apollo /v1/contacts ----
  let apolloOk = false, apolloError = null;
  if (process.env.APOLLO_API_KEY) {
    const payload = {
      first_name: isVenue ? (firstName || venueName) : (firstName || ''),
      last_name: isVenue ? '' : (lastName || ''),
      email,
      city,
      label_names: labelNames,
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
    try {
      const r = await fetch('https://api.apollo.io/v1/contacts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'x-api-key': process.env.APOLLO_API_KEY,
        },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      apolloOk = r.ok;
      if (!apolloOk) {
        apolloError = (data && (data.error || data.message)) || `HTTP ${r.status}`;
        console.error('[WAITLIST] Apollo error:', r.status, JSON.stringify(data).slice(0, 500));
      }
    } catch (e) {
      apolloError = String(e && e.message || e);
      console.error('[WAITLIST] Apollo network error:', apolloError);
    }
  } else {
    apolloError = 'APOLLO_API_KEY not set';
  }

  // ---- Path 2: Google Apps Script webhook ----
  // User creates an Apps Script bound to a Sheet; the script's doPost(e)
  // appends e.postData.contents as a new row. URL goes in env var
  // GOOGLE_SHEET_WEBHOOK_URL. See README/setup notes.
  let sheetOk = false, sheetError = null;
  if (process.env.GOOGLE_SHEET_WEBHOOK_URL) {
    try {
      const r = await fetch(process.env.GOOGLE_SHEET_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ts: new Date().toISOString(),
          type: tag,
          email, firstName: firstName || '', lastName: lastName || '',
          response: response || '', campaign: camp, referredBy: referredBy || '',
          label: labelName,
        }),
      });
      sheetOk = r.ok;
      if (!sheetOk) {
        sheetError = `HTTP ${r.status}`;
        console.error('[WAITLIST] Sheet error:', r.status);
      }
    } catch (e) {
      sheetError = String(e && e.message || e);
      console.error('[WAITLIST] Sheet network error:', sheetError);
    }
  }

  // ---- Path 3: Resend notification to support@ ----
  let notifyOk = false, notifyError = null;
  if (process.env.RESEND_API_KEY) {
    try {
      const subject = `[${tag}] ${email}`;
      const rows = [
        ['Type', tag], ['Email', email],
        ['First name', firstName || '—'], ['Response', response || '—'],
        ['Campaign', camp], ['Referred by', referredBy || '—'],
        ['Apollo label', labelName],
        ['Apollo', apolloOk ? 'OK' : (apolloError || 'skipped')],
        ['Sheet',  sheetOk  ? 'OK' : (sheetError || 'skipped')],
      ];
      const esc = s => String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
      const html = `<table style="font-family:sans-serif;border-collapse:collapse">${
        rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666"><b>${esc(k)}</b></td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('')
      }</table>`;
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: 'Blackboard <website@blackboarddeals.com>',
          to: ['support@blackboarddeals.com'],
          reply_to: email,
          subject, html,
        }),
      });
      notifyOk = r.ok;
      if (!notifyOk) {
        const errText = await r.text().catch(() => '');
        notifyError = `HTTP ${r.status} ${errText.slice(0, 200)}`;
        console.error('[WAITLIST] Resend notify error:', notifyError);
      }
    } catch (e) {
      notifyError = String(e && e.message || e);
      console.error('[WAITLIST] Resend notify network error:', notifyError);
    }
  } else {
    notifyError = 'RESEND_API_KEY not set';
  }

  // ---- Forwarded +1: also send the friend their personalised invite ----
  let inviteEmailOk = false;
  if (isForwarded && process.env.RESEND_API_KEY) {
    try {
      const friendName = (firstName || '').trim();
      const inviter = (inviterFirstName || '').trim() || (referredBy || 'A friend');
      const subject = friendName
        ? `${friendName}, you're invited — Blackboard launch party, Fri 19 Jun`
        : `You're invited — Blackboard launch party, Fri 19 Jun`;
      const r = await fetch('https://api.resend.com/emails', {
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
          html: buildInviteHtml({ friendEmail: email, friendName, inviter, campaign: camp }),
        }),
      });
      inviteEmailOk = r.ok;
      if (!inviteEmailOk) {
        const errText = await r.text().catch(() => '');
        console.error('[WAITLIST] +1 invite send error:', r.status, errText.slice(0, 200));
      }
    } catch (e) {
      console.error('[WAITLIST] +1 invite send network error:', e);
    }
  }

  // Always succeed — the log call above guarantees we have a record.
  return res.status(200).json({
    success: true,
    captured: {
      apollo: apolloOk,
      sheet:  sheetOk,
      notify: notifyOk,
      log:    true,
    },
    apolloError: apolloOk ? undefined : apolloError,
    sheetError:  sheetOk  ? undefined : sheetError,
    notifyError: notifyOk ? undefined : notifyError,
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
  <tr><td align="center" style="padding:36px 24px 10px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center"><tr>
      <td style="border:2px solid #ffffff; padding:12px 30px;">
        <span style="font-family:'Arial Black',Arial,Helvetica,sans-serif; font-size:20px; letter-spacing:0.4em; color:#ffffff; font-weight:900;">BLACKBOARD</span>
      </td>
    </tr></table>
  </td></tr>
  <tr><td align="center" style="padding:16px 24px 24px;">
    <p style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:0.32em; text-transform:uppercase; color:#DAA520; font-weight:bold;">${greeting}YOU'RE ON THE LIST</p>
  </td></tr>
  <tr><td align="center" style="padding:6px 24px 0;">
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
  <tr><td align="center" style="padding:36px 32px 0;">
    <p style="margin:0 0 8px; font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:0.3em; text-transform:uppercase; color:#e8c878; font-weight:bold;">SO - ARE YOU IN?</p>
  </td></tr>
  <tr><td align="center" style="padding:14px 24px 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center"><tr>
      <td bgcolor="#DAA520" style="background:#DAA520;">
        <a href="${yes}" target="_blank" style="display:inline-block; padding:16px 34px; font-family:Arial,Helvetica,sans-serif; font-size:13px; letter-spacing:0.22em; text-transform:uppercase; color:#0d0d10; text-decoration:none; font-weight:bold;">Yes - I'm in &nbsp;&rarr;</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td align="center" style="padding:14px 24px 40px;">
    <a href="${no}" target="_blank" style="font-family:Arial,Helvetica,sans-serif; font-size:12px; letter-spacing:0.22em; text-transform:uppercase; color:#d4d4dc; text-decoration:underline;">Can't make it</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
