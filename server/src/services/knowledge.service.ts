import { FAQ, KnowledgeArticle, Product, Service } from '../models/index.js';

const money = (price?: number, currency = 'INR') => (typeof price === 'number' ? new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(price) : undefined);

// Retrieves the knowledge the AI is allowed to answer from, scoped to what the
// customer's latest message is actually about (falls back to a small general slice
// so the system prompt never ships empty). This is intentionally simple text search
// rather than embeddings — swap this function's body for a vector search later
// without touching callers.
export async function retrieveKnowledge(query: string, limit = 6): Promise<string> {
  const clean = query.trim();
  const textFilter = clean.length >= 3 ? { $text: { $search: clean } } : {};
  const [products, services, faqs, articles] = await Promise.all([
    Product.find({ active: true, ...textFilter }).limit(limit).catch(() => []),
    Service.find({ active: true, ...textFilter }).limit(limit).catch(() => []),
    FAQ.find({ active: true, ...textFilter }).limit(limit).catch(() => []),
    KnowledgeArticle.find({ active: true, ...textFilter }).limit(limit).catch(() => []),
  ]);
  const [fallbackProducts, fallbackFaqs] = products.length || services.length || faqs.length || articles.length
    ? [[], []]
    : await Promise.all([Product.find({ active: true }).limit(4), FAQ.find({ active: true }).limit(4)]);

  const lines: string[] = [];
  for (const p of [...products, ...fallbackProducts]) lines.push(`Product: ${p.name}${p.category ? ` (${p.category})` : ''} — ${p.description ?? 'no description on file'}${p.price != null ? ` — Price: ${p.priceType === 'starting_at' ? 'starting at ' : ''}${money(p.price, p.currency)}` : ''}`);
  for (const s of services) lines.push(`Service: ${s.name}${s.category ? ` (${s.category})` : ''} — ${s.description ?? 'no description on file'}${s.price != null ? ` — Price: ${s.priceType === 'starting_at' ? 'starting at ' : ''}${money(s.price, s.currency)}` : ''}`);
  for (const f of [...faqs, ...fallbackFaqs]) lines.push(`FAQ: Q: ${f.question} A: ${f.answer}`);
  for (const a of articles) lines.push(`${a.category}: ${a.title} — ${a.content}`);
  return lines.join('\n');
}
