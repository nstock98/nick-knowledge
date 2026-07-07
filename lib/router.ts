// AI intent router — files non-link WhatsApp messages into the right Notion
// database, using AI to pick the destination and fill in the fields.
// Uses lib/ai.ts: OpenAI first, automatic Claude fallback.
//
// Requires: NOTION_API_KEY, OPENAI_API_KEY (optionally ANTHROPIC_API_KEY for fallback).
// Database IDs are hardcoded below (they're stable); override via env if ever needed.

import { chatComplete } from './ai';

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';

export const DATABASES = {
  todo: process.env.NOTION_DB_TODO || '4169ffc07bd143ee9db197e328221a2a',
  workNotes: process.env.NOTION_DB_WORK || '29a5657786b2412d99c6d3cbb622eaa7',
  shopping: process.env.NOTION_DB_SHOPPING || 'f66c427da2cb45dd8e0c9894540f8e74',
  wishlist: process.env.NOTION_DB_WISHLIST || 'd1697ea27f304c1480fa94cc325d60a9',
  ideas: process.env.NOTION_DB_IDEAS || 'a75c4f3d5def4b50bd4e8b9ed1af442e',
  expenses: process.env.NOTION_DB_EXPENSES || '683baf3520224d68bdfb2d510eb852fe',
  subscriptions: process.env.NOTION_DB_SUBS || '04a86895d01b4bdbafdf63646e58b93a',
  selfImprovement: process.env.NOTION_DB_SELF || '4ddc286f57c0432596df45429a1cfb5a',
};

type Intent =
  | 'task'
  | 'work_note'
  | 'shopping'
  | 'wishlist'
  | 'idea'
  | 'expense'
  | 'subscription'
  | 'self_improvement'
  | 'question';

interface Routed {
  intent: Intent;
  title: string;
  // Optional AI-extracted fields (only some apply per intent):
  priority?: string; // High | Medium | Low
  area?: string; // Work | Personal | Side Hustle | Health | Finance | Home
  due?: string; // YYYY-MM-DD
  list?: string; // Groceries | Household | Fitness & Supps | Wishlist
  qty?: string;
  category?: string;
  price?: number;
  amount?: number;
  type?: string;
  project?: string;
  notes?: string;
  cadence?: string; // Weekly | Fortnightly | Monthly | Quarterly | Yearly
}

const CLASSIFY_PROMPT = `You are a router for Nick's Notion life dashboard. Given a short WhatsApp message, output STRICT JSON deciding where it should be filed. Today's date is {TODAY} (Melbourne).

Intents and their fields:
- "task"            → personal to-do. Fields: title, priority (High/Medium/Low), area (Work/Personal/Side Hustle/Health/Finance/Home), due (YYYY-MM-DD, only if stated/implied), notes
- "work_note"       → anything about Nick's construction/building job or career: site issues, variations, meetings, follow-ups, things to remember for work. Fields: title, type (To-Do/Note/Meeting/Variation/Follow-up/Career), project, notes
- "shopping"        → consumables to buy: groceries, household goods, supplements. Fields: title (the item), list (Groceries/Household/Fitness & Supps), qty
- "wishlist"        → lifestyle purchases he WANTS: clothes, tech, gear, experiences. Fields: title, category (Clothes/Tech/Home/Fitness/Experiences/Other), price (number, if stated), priority (Need/Want/Someday)
- "idea"            → business/automation/content/project/life ideas. Fields: title, type (Business/AI / Automation/Content/Project/Life), notes
- "expense"         → money already spent ("spent $40 on X", "paid X $Y"). Fields: title, amount (number), category (Rent/Groceries/Eating Out/Transport/Fitness/Subscriptions/Entertainment/Investing/Other)
- "subscription"    → a new recurring cost. Fields: title, amount (number), cadence (Weekly/Fortnightly/Monthly/Quarterly/Yearly), category (Streaming/Fitness/Software / AI/Utilities/Insurance/Other)
- "self_improvement"→ books/courses/podcasts/skills to work on. Fields: title, type (Book/Course/Podcast/Skill/Habit/Reflection), notes
- "question"        → the message asks a question or requests a plan/summary rather than capturing something. Fields: title (the question).

Rules: pick exactly one intent. Fill every field you reasonably can from the message; omit fields you can't infer. Titles should be clean and short (not the raw message). Output ONLY the JSON object.`;

export async function classifyMessage(message: string): Promise<Routed> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());
  const content = await chatComplete({
    system: CLASSIFY_PROMPT.replace('{TODAY}', today),
    user: message,
    maxTokens: 300,
    temperature: 0,
    json: true,
  });
  const parsed = JSON.parse(content || '{}');
  if (!parsed.intent) parsed.intent = 'task';
  if (!parsed.title) parsed.title = message.slice(0, 120);
  return parsed as Routed;
}

// --- Notion helpers -------------------------------------------------------

const t = (s: string | undefined, max = 1900) =>
  !s ? '' : s.length > max ? s.slice(0, max - 1) + '…' : s;

const title = (s: string) => ({ title: [{ text: { content: t(s, 200) } }] });
const rich = (s?: string) => (s ? { rich_text: [{ text: { content: t(s) } }] } : undefined);
const select = (s?: string) => (s ? { select: { name: s } } : undefined);
const date = (s?: string) => (s ? { date: { start: s } } : undefined);
const num = (n?: number) => (typeof n === 'number' && !isNaN(n) ? { number: n } : undefined);

function clean(obj: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

async function createPage(databaseId: string, properties: Record<string, any>): Promise<void> {
  const res = await fetch(`${NOTION_BASE}/pages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
  });
  if (!res.ok) throw new Error(`Notion create failed (${res.status}): ${await res.text()}`);
}

// --- Filing ---------------------------------------------------------------

// Files a routed item into its database. Returns a short human confirmation.
export async function fileItem(r: Routed): Promise<string> {
  switch (r.intent) {
    case 'task':
      await createPage(DATABASES.todo, clean({
        Task: title(r.title),
        Status: select('To Do'),
        Priority: select(r.priority || 'Medium'),
        Area: select(r.area || 'Personal'),
        Due: date(r.due),
        Notes: rich(r.notes),
      }));
      return `✅ To-Do: ${r.title}${r.due ? ` (due ${r.due})` : ''}`;
    case 'work_note':
      await createPage(DATABASES.workNotes, clean({
        Note: title(r.title),
        Type: select(r.type || 'Note'),
        Status: select('Open'),
        Project: rich(r.project),
        Date: date(r.due),
        Details: rich(r.notes),
      }));
      return `💼 Work Notes: ${r.title}`;
    case 'shopping':
      await createPage(DATABASES.shopping, clean({
        Item: title(r.title),
        List: select(r.list || 'Groceries'),
        Qty: rich(r.qty),
      }));
      return `🛒 Shopping List: ${r.title}`;
    case 'wishlist':
      await createPage(DATABASES.wishlist, clean({
        Item: title(r.title),
        Category: select(r.category || 'Other'),
        Price: num(r.price),
        Priority: select(r.priority || 'Want'),
        Status: select('Eyeing'),
      }));
      return `🛍️ Wishlist: ${r.title}`;
    case 'idea':
      await createPage(DATABASES.ideas, clean({
        Idea: title(r.title),
        Type: select(r.type || 'Life'),
        Stage: select('Spark'),
        Notes: rich(r.notes),
      }));
      return `💡 Ideas: ${r.title}`;
    case 'expense':
      await createPage(DATABASES.expenses, clean({
        Expense: title(r.title),
        Amount: num(r.amount),
        Category: select(r.category || 'Other'),
        Date: date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date())),
      }));
      return `💸 Expenses: ${r.title}${r.amount ? ` ($${r.amount})` : ''}`;
    case 'subscription':
      await createPage(DATABASES.subscriptions, clean({
        Name: title(r.title),
        Cost: num(r.amount),
        Cadence: select(r.cadence || 'Monthly'),
        Category: select(r.category || 'Other'),
        Active: { checkbox: true },
      }));
      return `🔁 Subscriptions: ${r.title}`;
    case 'self_improvement':
      await createPage(DATABASES.selfImprovement, clean({
        Title: title(r.title),
        Type: select(r.type || 'Skill'),
        Status: select('To Start'),
        Takeaways: rich(r.notes),
      }));
      return `📚 Self Improvement: ${r.title}`;
    default:
      throw new Error(`fileItem called with non-capture intent: ${r.intent}`);
  }
}
