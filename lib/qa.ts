// Shared AI Q&A logic: pulls relevant saved items from Notion as context,
// then asks the AI to generate an answer (workout plan, meal plan, etc.)
// grounded in what Nick has actually saved.
//
// Uses lib/ai.ts: OpenAI first, automatic Claude fallback if OpenAI fails.
// Requires: OPENAI_API_KEY (and optionally ANTHROPIC_API_KEY for fallback).

import { queryKnowledgeItems, KnowledgeItem } from './notion';
import { chatComplete } from './ai';

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Fitness: ['workout', 'gym', 'exercise', 'training', 'run', 'lift', 'cardio', 'muscle', 'strength'],
  'Food & Recipes': [
    'meal', 'recipe', 'food', 'cook', 'diet', 'nutrition', 'protein',
    'breakfast', 'lunch', 'dinner', 'snack', 'ingredient',
  ],
  Finance: ['invest', 'stock', 'portfolio', 'crypto', 'etf', 'wealth'],
  Work: ['client', 'invoice', 'construction', 'variation'],
  'Side Hustles': ['side hustle', 'startup idea', 'business idea', 'freelance gig'],
};

function detectCategory(question: string): string | undefined {
  const q = question.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => q.includes(kw))) return category;
  }
  return undefined;
}

function detectSince(question: string): string | undefined {
  const q = question.toLowerCase();
  const now = Date.now();
  if (q.includes('today')) return new Date(now - 24 * 60 * 60 * 1000).toISOString();
  if (/(this|past|last)\s+week/.test(q)) return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  if (/(this|past|last)\s+month/.test(q)) return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  return undefined;
}

function formatItemsForPrompt(items: KnowledgeItem[]): string {
  if (items.length === 0) {
    return '(No saved items matched this question. Answer using general knowledge, and mention that nothing specific was found in the saved items.)';
  }
  return items
    .map((item, i) => {
      const lines = [
        `${i + 1}. [${item.category}] ${item.name}`,
        item.description ? `   Note: ${item.description}` : '',
        item.contentExcerpt ? `   Excerpt: ${item.contentExcerpt}` : '',
        item.url ? `   Link: ${item.url}` : '',
        `   Saved: ${new Date(item.createdTime).toLocaleDateString()}`,
      ].filter(Boolean);
      return lines.join('\n');
    })
    .join('\n\n');
}

export async function answerQuestion(question: string): Promise<string> {
  const category = detectCategory(question);
  const sinceISO = detectSince(question);

  let items = await queryKnowledgeItems({ category, sinceISO, pageSize: 100 });

  // If a time+category scoped search comes back empty (e.g. nothing saved
  // *this week* specifically), widen to all-time for that category before
  // giving up.
  if (items.length === 0 && category && sinceISO) {
    items = await queryKnowledgeItems({ category, pageSize: 100 });
  }

  const context = formatItemsForPrompt(items);

  const systemPrompt = `You are Nick's personal assistant with access to his "Second Brain" — a collection of links, videos, and notes he's saved for himself (workouts, recipes, business ideas, etc.).

Use the saved items below as your primary source of inspiration and material when answering. Reference specific saved items by name when relevant. If the question includes constraints (budget, calories, protein, time, etc.), respect them precisely and briefly show your reasoning (rough calorie/protein totals, rough cost breakdown). If nothing saved is relevant, say so honestly and still give a helpful general answer. Keep answers practical and concise — this is often read on a phone or as a text message, so avoid unnecessary length.

Saved items:
${context}`;

  return chatComplete({
    system: systemPrompt,
    user: question,
    maxTokens: 700,
    temperature: 0.6,
  });
}
