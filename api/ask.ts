import { VercelRequest, VercelResponse } from '@vercel/node';
import { answerQuestion } from '../lib/qa';

export default async (req: VercelRequest, res: VercelResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const question = (req.body?.question || '').toString().trim();
    if (!question) {
      return res.status(400).json({ error: 'Missing question' });
    }

    const answer = await answerQuestion(question);
    return res.status(200).json({ answer });
  } catch (error) {
    console.error('Ask error:', error);
    return res.status(500).json({ error: 'Failed to answer question', details: String(error) });
  }
};
