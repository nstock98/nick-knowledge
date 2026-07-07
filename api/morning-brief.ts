// Morning brief cron (7:00am Melbourne — see vercel.json).
// 1. Sends a WhatsApp message with today's to-do list (overdue, due today,
//    high priority, plus open work items).
// 2. Runs the link-enrichment pass that used to be its own cron job, so we
//    stay within Vercel Hobby's 2-cron limit.

import { VercelRequest, VercelResponse } from '@vercel/node';
import { queryKnowledgeItems, updateKnowledgeItem } from '../lib/notion';
import { DATABASES } from '../lib/router';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
const MY_WHATSAPP_NUMBER = process.env.MY_WHATSAPP_NUMBER;
const CRON_SECRET = process.env.CRON_SECRET;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = '2022-06-28';

const WHATSAPP_CHAR_LIMIT = 1500;

interface TodoRow {
  title: string;
  priority: string;
  area: string;
  due?: string;
}

async function notionQuery(databaseId: string, body: any): Promise<any[]> {
  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion query failed (${res.status}): ${await res.text()}`);
  return (await res.json()).results || [];
}

const plain = (arr: any[] | undefined) => (arr || []).map((t: any) => t.plain_text).join('');

async function getOpenTodos(): Promise<TodoRow[]> {
  const results = await notionQuery(DATABASES.todo, {
    page_size: 50,
    filter: {
      or: [
        { property: 'Status', select: { equals: 'To Do' } },
        { property: 'Status', select: { equals: 'In Progress' } },
      ],
    },
  });
  return results.map((p: any) => ({
    title: plain(p.properties?.Task?.title),
    priority: p.properties?.Priority?.select?.name || 'Medium',
    area: p.properties?.Area?.select?.name || '',
    due: p.properties?.Due?.date?.start,
  }));
}

async function getOpenWorkItems(): Promise<string[]> {
  const results = await notionQuery(DATABASES.workNotes, {
    page_size: 20,
    filter: {
      and: [
        { property: 'Status', select: { does_not_equal: 'Closed' } },
        {
          or: [
            { property: 'Type', select: { equals: 'To-Do' } },
            { property: 'Type', select: { equals: 'Follow-up' } },
          ],
        },
      ],
    },
  });
  return results.map((p: any) => plain(p.properties?.Note?.title)).filter(Boolean);
}

function buildBrief(todos: TodoRow[], workItems: string[], todayISO: string): string {
  const overdue = todos.filter((t) => t.due && t.due < todayISO);
  const dueToday = todos.filter((t) => t.due === todayISO);
  const high = todos.filter((t) => t.priority === 'High' && (!t.due || t.due > todayISO));
  const rest = todos.filter(
    (t) => !overdue.includes(t) && !dueToday.includes(t) && !high.includes(t)
  );

  const lines: string[] = ['☀️ *Morning brief*', ''];

  const section = (label: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`*${label}*`);
    for (const item of items) lines.push(`• ${item}`);
    lines.push('');
  };

  section('⚠️ Overdue', overdue.map((t) => `${t.title} (was due ${t.due})`));
  section('📅 Due today', dueToday.map((t) => t.title));
  section('🔥 High priority', high.map((t) => t.title));
  section('💼 Open work items', workItems.slice(0, 5));
  section('📋 Also on the list', rest.slice(0, 5).map((t) => t.title));

  if (todos.length === 0 && workItems.length === 0) {
    lines.push('Nothing on the list — plan the day on the dashboard 🧠');
  }

  let message = lines.join('\n').trim();
  if (message.length > WHATSAPP_CHAR_LIMIT) {
    message = message.slice(0, WHATSAPP_CHAR_LIMIT - 60) + '\n…(more in Notion)';
  }
  return message;
}

// --- Enrichment (folded in from api/enrich-notion.ts) ----------------------

const BATCH_SIZE = 8;
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

async function runEnrichment(): Promise<number> {
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
  return enriched;
}

// --- Handler ---------------------------------------------------------------

export default async (req: VercelRequest, res: VercelResponse) => {
  if (CRON_SECRET) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const todayISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());

    const [todos, workItems] = await Promise.all([getOpenTodos(), getOpenWorkItems()]);
    const message = buildBrief(todos, workItems, todayISO);

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

    // Enrichment runs after the brief so a slow page never delays the message.
    const enriched = await runEnrichment();

    return res.status(200).json({ ok: true, todoCount: todos.length, workCount: workItems.length, enriched });
  } catch (error) {
    console.error('Morning brief error:', error);
    return res.status(500).json({ error: 'Morning brief failed', details: String(error) });
  }
};
