import { VercelRequest, VercelResponse } from '@vercel/node';

// --- Required environment variables (set these in Vercel Project Settings) ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
// The Twilio WhatsApp sender, e.g. 'whatsapp:+14155238886' (your sandbox number)
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
// Your own WhatsApp number, e.g. 'whatsapp:+61...'
const MY_WHATSAPP_NUMBER = process.env.MY_WHATSAPP_NUMBER;
// Optional but recommended: Vercel automatically sends this as a Bearer token
// when it invokes your cron job, if you set a CRON_SECRET env var. This stops
// randoms from hitting the endpoint and triggering Twilio sends on your dime.
const CRON_SECRET = process.env.CRON_SECRET;

const WHATSAPP_CHAR_LIMIT = 1500;

export default async (req: VercelRequest, res: VercelResponse) => {
  // Verify the request actually came from Vercel Cron (if CRON_SECRET is configured).
  if (CRON_SECRET) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const itemsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/knowledge_items?created_at=gte.${since}&order=created_at.asc&select=url,description,category,content_title,created_at`,
      {
        headers: {
          apikey: SUPABASE_KEY!,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );

    if (!itemsRes.ok) {
      const err = await itemsRes.text();
      console.error('Supabase fetch failed:', err);
      return res.status(500).json({ error: 'Failed to fetch items', details: err });
    }

    const items: Array<{
      url: string;
      description: string | null;
      category: string | null;
      content_title: string | null;
      created_at: string;
    }> = await itemsRes.json();

    const message = buildMessage(items);

    const twilioRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization:
            'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          From: TWILIO_WHATSAPP_FROM!,
          To: MY_WHATSAPP_NUMBER!,
          Body: message,
        }),
      }
    );

    if (!twilioRes.ok) {
      const err = await twilioRes.text();
      console.error('Twilio send failed:', err);
      return res.status(500).json({ error: 'Twilio send failed', details: err });
    }

    return res.status(200).json({ ok: true, itemCount: items.length });
  } catch (error) {
    console.error('Daily digest error:', error);
    return res.status(500).json({ error: 'Digest failed' });
  }
};

function buildMessage(
  items: Array<{
    url: string;
    description: string | null;
    category: string | null;
    content_title: string | null;
  }>
): string {
  if (items.length === 0) {
    return '📚 Second Brain — nothing filed in the last 24 hours.';
  }

  const byCategory: Record<string, typeof items> = {};
  for (const item of items) {
    const cat = item.category || 'Uncategorized';
    (byCategory[cat] ||= []).push(item);
  }

  const lines: string[] = [`📚 *Second Brain — ${items.length} filed today*`, ''];

  for (const [cat, catItems] of Object.entries(byCategory)) {
    lines.push(`*${cat}* (${catItems.length})`);
    for (const item of catItems) {
      const title = item.content_title || item.description || item.url;
      lines.push(`• ${title}`);
      lines.push(`  ${item.url}`);
    }
    lines.push('');
  }

  let message = lines.join('\n').trim();

  // Keep it well under WhatsApp's message size limits.
  if (message.length > WHATSAPP_CHAR_LIMIT) {
    message = message.slice(0, WHATSAPP_CHAR_LIMIT - 60) + '\n…(truncated — see the dashboard for the rest)';
  }

  return message;
}
