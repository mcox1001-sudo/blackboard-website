export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { type, firstName, lastName, email, city, interest, venueName, companyName, address, venueType, role, phone } = req.body;

  if (!email) return res.status(400).json({ error: 'Email is required' });

  const isVenue = type === 'v';
  const labelName = isVenue ? 'Blackboard Venue Waitlist' : 'Blackboard User Waitlist';

  const payload = {
    first_name: isVenue ? (firstName || venueName) : firstName,
    last_name: isVenue ? '' : (lastName || ''),
    email,
    city,
    label_names: [labelName],
  };

  if (isVenue && (companyName || venueName)) payload.organization_name = companyName || venueName;
  if (isVenue && venueType) payload.title = venueType;
  if (isVenue && role) payload.seniority = role;
  if (isVenue && address) payload.street_address = address;
  if (!isVenue && interest) payload.present_raw_address = interest;
  if (phone) payload.direct_phone = phone;

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

    const data = await apolloRes.json();

    if (!apolloRes.ok) {
      console.error('Apollo error:', data);
      return res.status(500).json({ error: 'Failed to add to Apollo' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Waitlist error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
