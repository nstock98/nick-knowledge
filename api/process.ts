import { VercelRequest, VercelResponse } from '@vercel/node';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Escape a keyword for safe use inside a RegExp.
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Word-boundary match instead of naive substring match.
// (Substring matching previously caused false positives — e.g. the Work
// keyword "ai" matched inside "training", "explain", "email", "maintain", etc.)
const hasKeyword = (text: string, keyword: string) => {
  const re = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
  return re.test(text);
};

const classifyItem = (description: string) => {
  const desc = description.toLowerCase();

  const patterns: Record<string, string[]> = {
    'Work': ['pm', 'construction', 'variation', 'eot', 'invoice', 'documentation', 'client', 'builder', 'project', 'automation', 'ai'],
    'Finance': ['invest', 'stock', 'etf', 'property', 'wealth', 'budget', 'finance', 'money', 'crypto', 'portfolio', 'share'],
    'Fitness': ['gym', 'workout', 'training', 'exercise', 'lift', 'lifting', 'cardio', 'muscle', 'strength', 'reps', 'sets', 'run', 'running'],
    'Food & Recipes': ['recipe', 'meal', 'cook', 'cooking', 'food', 'dinner', 'lunch', 'breakfast', 'ingredient', 'protein', 'diet', 'nutrition', 'snack', 'bulk', 'cut'],
    'Side Hustles': ['business', 'side', 'consulting', 'agency', 'freelance', 'startup', 'product', 'launch', 'growth', 'marketing', 'sales'],
  };

  let bestMatch = 'Uncategorized';
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(patterns)) {
    const score = keywords.filter((kw) => hasKeyword(desc, kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = category;
    }
  }

  // No keyword matched anything — be honest about it instead of
  // silently forcing every ambiguous item into "Side Hustles".
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
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ url, description, category, tags, metadata, status: 'new' }),
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
