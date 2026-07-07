// Shared Notion API helper for the Second Brain project.
//
// Requires these environment variables:
//   NOTION_API_KEY      — the Internal Integration Secret from notion.so/my-integrations
//   NOTION_DATABASE_ID  — the "Saved Items" database ID (32-char string from its URL)
//
// The database is expected to have these properties (matching what actually
// got created in Notion — note "url" is lowercase and "Status" is Notion's
// built-in status type, not a plain select):
//   Name             (title)
//   url              (url)
//   Description      (text)
//   Category         (select: Work, Finance, Fitness, Food & Recipes, Side Hustles, Uncategorized)
//   Tags             (multi-select)
//   Content Excerpt  (text)
//   Status           (status: New, Reviewed, Archived)

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';

function notionHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

// Notion rich_text/title fields reject content over 2000 chars per block.
function truncate(text: string | undefined | null, max = 1900): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export interface KnowledgeItem {
  id: string;
  name: string;
  url: string;
  description: string;
  category: string;
  tags: string[];
  contentExcerpt: string;
  status: string;
  createdTime: string;
}

function parsePage(page: any): KnowledgeItem {
  const props = page.properties || {};
  return {
    id: page.id,
    name: (props.Name?.title || []).map((t: any) => t.plain_text).join(''),
    url: props.url?.url || '',
    description: (props.Description?.rich_text || []).map((t: any) => t.plain_text).join(''),
    category: props.Category?.select?.name || 'Uncategorized',
    tags: (props.Tags?.multi_select || []).map((t: any) => t.name),
    contentExcerpt: (props['Content Excerpt']?.rich_text || []).map((t: any) => t.plain_text).join(''),
    status: props.Status?.status?.name || 'New',
    createdTime: page.created_time,
  };
}

async function notionFetch(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${NOTION_BASE}${path}`, { ...init, headers: notionHeaders() });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Notion API ${path} failed (${res.status}): ${errText}`);
  }
  return res.json();
}

export async function createKnowledgeItem(params: {
  name: string;
  url: string;
  description: string;
  category: string;
  tags: string[];
}): Promise<void> {
  await notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Name: { title: [{ text: { content: truncate(params.name || 'Untitled', 200) } }] },
        url: { url: params.url || null },
        Description: { rich_text: [{ text: { content: truncate(params.description) } }] },
        Category: { select: { name: params.category } },
        Tags: {
          multi_select: (params.tags || [])
            .filter(Boolean)
            .slice(0, 10)
            .map((t) => ({ name: t.slice(0, 90) })),
        },
        Status: { status: { name: 'New' } },
      },
    }),
  });
}

export async function queryKnowledgeItems(
  params: {
    category?: string;
    sinceISO?: string;
    missingExcerptOnly?: boolean;
    pageSize?: number;
  } = {}
): Promise<KnowledgeItem[]> {
  const conditions: any[] = [];

  if (params.category) {
    conditions.push({ property: 'Category', select: { equals: params.category } });
  }
  if (params.sinceISO) {
    conditions.push({ timestamp: 'created_time', created_time: { on_or_after: params.sinceISO } });
  }
  if (params.missingExcerptOnly) {
    conditions.push({ property: 'Content Excerpt', rich_text: { is_empty: true } });
  }

  let filter: any = undefined;
  if (conditions.length === 1) filter = conditions[0];
  else if (conditions.length > 1) filter = { and: conditions };

  const body: any = {
    page_size: params.pageSize || 100,
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  };
  if (filter) body.filter = filter;

  const data = await notionFetch(`/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return (data.results || []).map(parsePage);
}

export async function updateKnowledgeItem(
  pageId: string,
  updates: { name?: string; contentExcerpt?: string }
): Promise<void> {
  const properties: any = {};
  if (updates.name) {
    properties.Name = { title: [{ text: { content: truncate(updates.name, 200) } }] };
  }
  if (updates.contentExcerpt) {
    properties['Content Excerpt'] = { rich_text: [{ text: { content: truncate(updates.contentExcerpt) } }] };
  }
  if (Object.keys(properties).length === 0) return;

  await notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  });
}
