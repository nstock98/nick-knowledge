import { VercelRequest, VercelResponse } from '@vercel/node';
import { createKnowledgeItem } from '../lib/notion';
import { answerQuestion } from '../lib/qa';
import { classifyMessage, fileItem } from '../lib/router';

// Escape a keyword for safe use inside a RegExp.
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Word-boundary match instead of naive substring match (prevents e.g. the
// Work keyword "ai" from matching inside "training", "maintenance", etc.)
const hasKeyword = (text: string, keyword: string) => {
  const re = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
  return re.test(text);
};

const classifyItem = (description: string): string => {
  const desc = description.toLowerCase();

  const patterns: Record<string, string[]> = {
    Work: ['pm', 'construction', 'variation', 'eot', 'invoice', 'documentation', 'client', 'builder', 'project', 'automation', 'ai'],
    Finance: ['invest', 'stock', 'etf', 'property', 'wealth', 'budget', 'finance', 'money', 'crypto', 'portfolio', 'share'],
    Fitness: ['gym', 'workout', 'training', 'exercise', 'lift', 'lifting', 'cardio', 'muscle', 'strength', 'reps', 'sets', 'run', 'running'],
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

  return bestMatch;
};

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default async (req: VercelRequest, res: VercelResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Twilio sends form-encoded data — fields are Body and From (capitalised)
  const message: string | undefined = req.body.Body || req.body.message;
  const from: string | undefined = req.body.From || req.body.from;

  if (!message || !from) {
    console.error('Missing fields. Received body:', JSON.stringify(req.body));
    return res.status(400).json({ error: 'Missing message or from', received: req.body });
  }

  res.setHeader('Content-Type', 'text/xml');

  const urlMatch = message.match(/https?:\/\/[^\s]+/);

  // No link in the message — use the AI router: either file it into the
  // right dashboard database (task, shopping, idea, expense, ...) or, if
  // it's a question, answer it from the Second Brain.
  if (!urlMatch) {
    const text = message.trim();
    if (!text) {
      return res.status(200).send('<Response></Response>');
    }

    try {
      const routed = await classifyMessage(text);

      if (routed.intent === 'question') {
        const answer = await answerQuestion(text);
        const truncated = answer.length > 1500 ? answer.slice(0, 1450) + '…' : answer;
        return res.status(200).send(`<Response><Message>${xmlEscape(truncated)}</Message></Response>`);
      }

      const confirmation = await fileItem(routed);
      return res.status(200).send(`<Response><Message>${xmlEscape(confirmation)}</Message></Response>`);
    } catch (routeError) {
      console.error('Routing error:', routeError);
      return res
        .status(200)
        .send('<Response><Message>Sorry, I had trouble with that one — try again in a bit.</Message></Response>');
    }
  }

  // A link is present — save it to Saved Items as before.
  try {
    const url = urlMatch[0];
    const description = message.replace(url, '').replace(/^[\s\-]+/, '').trim();
    const category = classifyItem(description);
    const tags = description.split(/[\s,]+/).filter((t: string) => t.length > 1).slice(0, 5);

    await createKnowledgeItem({
      name: description || url,
      url,
      description,
      category,
      tags,
    });

    return res.status(200).send(
      `<Response><Message>🔖 Saved to ${xmlEscape(category)}: ${xmlEscape(url.substring(0, 60))}</Message></Response>`
    );
  } catch (error) {
    console.error('Processing error:', error);
    return res.status(200).send('<Response><Message>Something went wrong saving that — try again.</Message></Response>');
  }
};
