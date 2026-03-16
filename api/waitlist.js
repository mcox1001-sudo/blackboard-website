const VENUE_LIST_ID = '69b84b8a6602c60011f98246';
const USER_LIST_ID  = '69b84b9790f07a00118df3c3';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { type, firstName, lastName, email, city, interest, venueName, venueType } = req.body;

  if (!email) return res.status(400).json({ error: 'Email is required' });

  const isVenue = type === 'v';
  const listId  = isVenue ? VENUE_LIST_ID : USER_LIST_ID;

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'x-api-key': process.env.APOLLO_API_KEY,
  };

  const payload = {
    first_name: isVenue ? (firstName || venueName) : firstName,
    last_name: isVenue ? '' : (lastName || ''),
    email,
    city,
  };

  if (isVenue && venueName) payload.organization_name = venueName;
  if (isVenue && venueType) payload.title = venueType;
  if (!isVenue && interest) payload.present_raw_address = interest;

  try {
    // 1. Create the contact
    const contactRes = await fetch('https://api.apollo.io/v1/contacts', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const contactData = await contactRes.json();

    if (!contactRes.ok) {
      console.error('Apollo contact error:', contactData);
      return res.status(500).json({ error: 'Failed to add to Apollo' });
    }

    const contactId = contactData.contact?.id;

    // 2. Add to the correct list
    if (contactId) {
      const listRes = await fetch(`https://api.apollo.io/v1/contact_lists/${listId}/add_contact_ids`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ contact_ids: [contactId] }),
      });

      if (!listRes.ok) {
        const text = await listRes.text();
        console.error('Apollo list error:', text);
        // Don't fail the whole request — contact was created successfully
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Waitlist error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
