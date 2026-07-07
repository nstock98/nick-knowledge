// Runs on a schedule (see vercel.json) to fill in the title/excerpt for
// recently saved items — replaces the old Postgres pg_net/pg_cron enrichment
// pipeline now that storage has moved to Notion.

import { VercelRequest, VercelResponse } from '@vercel/node';
import { queryKnowledgeItems, updateKnowledgeItem } from '../lib/notion';

const CRON_SECRET = process.env.CRON_SECRET;
const BATCH_SIZE = 8; // keep small to stay well within Notion's rate limits and Vercel's execution time limit
const FETCH_TIMEOUT_MS = 6000;

function extractTitleAndDescription(html: string): { title?: string; description?: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
  const descMatch =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);

  const decode = (s: string) =>
    s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

  return {
    title: ogTitleMatch ? decode(ogTitleMatch[1]) : titleMatch ? decode(titleMatch[1]) : undefined,
    description: descMatch ? decode(descMatch[1]) : undefined,
  };
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SecondBrainBot/1.0)' },
    });
  } finally {
    clearTimeout(timeout);
  }
}

export default async (req: VercelRequest, res: VercelResponse) => {
  if (CRON_SECRET) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const pending = await queryKnowledgeItems({ missingExcerptOnly: true, pageSize: BATCH_SIZE });

    let enriched = 0;
    for (const item of pending) {
      if (!item.url) continue;
      try {
        const response = await fetchWithTimeout(item.url, FETCH_TIMEOUT_MS);
        if (!response.ok) continue;
        const html = await response.text();
        const { title, description } = extractTitleAndDescription(html);

        if (title || description) {
          await updateKnowledgeItem(item.id, { name: title, contentExcerpt: description });
          enriched++;
        }
      } catch (fetchError) {
        console.error(`Enrichment fetch failed for ${item.url}:`, fetchError);
      }
    }

    return res.status(200).json({ ok: true, checked: pending.length, enriched });
  } catch (error) {
    console.error('Enrichment error:', error);
    return res.status(500).json({ error: 'Enrichment failed', details: String(error) });
  }
};
