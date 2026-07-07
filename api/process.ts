import { VercelRequest, VercelResponse } from '@vercel/node';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const classifyItem = (description: string) => {
  const desc = description.toLowerCase();
  const patterns = {
    'Fitness': ['recipe', 'meal', 'protein', 'gym', 'workout', 'training', 'diet', 'nutrition', 'weight', 'bulk', 'cut', 'cook', 'food'],
    'Work': ['pm', 'construction', 'variation', 'eot', 'invoice', 'documentation', 'client', 'builder', 'project', 'automation', 'ai'],
    'Finance': ['invest', 'stock', 'etf', 'property', 'wealth', 'budget', 'finance', 'money', 'crypto', 'portfolio', 'share'],
    'Side Hustles': ['business', 'side', 'consulting', 'agency', 'freelance', 'startup', 'product', 'launch', 'growth', 'marketing', 'sales']
  };

  let bestMatch = 'Side Hustles';
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(patterns)) {
    const score = keywords.filter(kw => desc.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = category;
    }
  }
  return bestMatch;
};

const extractMetadata = (description: string) => {
  const metadata: any = {};
  const timeMatch = description.match(/(\d+)\s*(?:min|minute|hr|hour)/i);
  if (timeMatch) metadata.duration = timeMatch[0];
  const tagsMatch = description.match(/#\w+/g);
  if (tagsMatch) metadata.hashtags = tagsMatch;
  return metadata;
};

export default async (req: VercelRequest, res: VercelResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Twilio sends form-encoded data — fields are Body and From (capitalised)
    const message = req.body.Body || req.body.message;
    const from = req.body.From || req.body.from;

    if (!message || !from) {
      console.error('Missing fields. Received body:', JSON.stringify(req.body));
      return res.status(400).json({ error: 'Missing message or from', received: req.body });
    }

    const urlMatch = message.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
      // No URL in message — return 200 so Twilio doesn't retry
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send('<Response></Response>');
    }

    const url = urlMatch[0];
    const description = message.replace(url, '').replace(/^[\s\-]+/, '').trim();
    const category = classifyItem(description);
    const metadata = extractMetadata(description);
    const tags = description.split(/[\s,]+/).filter((t: string) => t.length > 1).slice(0, 5);

    const response = await fetch(`${SUPABASE_URL}/rest/v1/knowledge_items`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY!,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ url, description, category, tags, metadata, status: 'new' })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Supabase write failed:', error);
      return res.status(500).json({ error: 'Database write failed', details: error });
    }

    // Reply to the user via WhatsApp confirming what was saved
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(
      `<Response><Message>Saved to ${category}: ${url.substring(0, 60)}</Message></Response>`
    );

  } catch (error) {
    console.error('Processing error:', error);
    return res.status(500).json({ error: 'Processing failed' });
  }
};
