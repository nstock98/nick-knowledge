// Shared AI completion helper with automatic fallback.
// Tries OpenAI first; if the call fails for ANY reason (out of credits,
// rate limit, outage), retries the same request against the Claude API.
//
// Env vars:
//   OPENAI_API_KEY      — primary provider
//   OPENAI_MODEL        — optional, defaults to gpt-4o-mini
//   ANTHROPIC_API_KEY   — fallback provider (optional; if unset, no fallback)
//   ANTHROPIC_MODEL     — optional, defaults to claude-haiku-4-5

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

export interface ChatParams {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  json?: boolean; // caller expects a JSON object back
}

async function callOpenAI(p: ChatParams): Promise<string> {
  const body: any = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: p.user },
    ],
    max_tokens: p.maxTokens ?? 700,
    temperature: p.temperature ?? 0.6,
  };
  if (p.json) body.response_format = { type: 'json_object' };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('OpenAI returned an empty response');
  return content;
}

async function callClaude(p: ChatParams): Promise<string> {
  const system = p.json
    ? p.system + '\n\nRespond with ONLY a raw JSON object — no code fences, no commentary.'
    : p.system;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: p.maxTokens ?? 700,
      temperature: p.temperature ?? 0.6,
      system,
      messages: [{ role: 'user', content: p.user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  let content: string = (data.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('')
    .trim();
  if (!content) throw new Error('Claude returned an empty response');

  // Strip accidental code fences when JSON was requested.
  if (p.json) {
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  return content;
}

export async function chatComplete(p: ChatParams): Promise<string> {
  try {
    return await callOpenAI(p);
  } catch (openaiError) {
    console.error('OpenAI failed, trying Claude fallback:', openaiError);
    if (!ANTHROPIC_API_KEY) throw openaiError; // no fallback configured
    return await callClaude(p);
  }
}
