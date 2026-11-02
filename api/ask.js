// ИИ-помощник Cryptocube: серверная прокси-функция Vercel.
// Ключи API хранятся только в переменных окружения Vercel и не попадают в браузер.
// Провайдеры пробуются по очереди: Groq → OpenRouter → любой OpenAI-совместимый (AI_*).
// Если первый не ответил или упёрся в лимит, вопрос уходит следующему.
//   GROQ_API_KEY        — ключ Groq (console.groq.com)
//   GROQ_MODEL          — по умолчанию llama-3.3-70b-versatile
//   OPENROUTER_API_KEY  — ключ OpenRouter (openrouter.ai)
//   OPENROUTER_MODEL    — бесплатная модель с суффиксом :free, по умолчанию meta-llama/llama-3.3-70b-instruct:free
//   AI_API_KEY, AI_BASE_URL, AI_MODEL — запасной вариант для любого другого провайдера

const LIMIT = 20, WINDOW_MS = 10 * 60 * 1000; // не больше 20 вопросов за 10 минут с одного IP
const hits = new Map();
const clip = (v, n) => String(v || '').slice(0, n);

function providers() {
  const env = process.env, list = [];
  if (env.GROQ_API_KEY) list.push({ name: 'groq', base: 'https://api.groq.com/openai/v1', key: env.GROQ_API_KEY, model: env.GROQ_MODEL || 'llama-3.3-70b-versatile' });
  if (env.OPENROUTER_API_KEY) list.push({ name: 'openrouter', base: 'https://openrouter.ai/api/v1', key: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    headers: { 'HTTP-Referer': env.SITE_URL || 'https://cryptocube-plum.vercel.app', 'X-Title': 'Cryptocube' } });
  if (env.AI_API_KEY && env.AI_BASE_URL) list.push({ name: 'custom', base: env.AI_BASE_URL.replace(/\/$/, ''), key: env.AI_API_KEY, model: env.AI_MODEL });
  return list;
}

function systemPrompt(ctx) {
  return [
    'Ты — помощник учебного тренажёра Cryptocube. Ученик проходит симулятор с ненастоящими деньгами.',
    'Отвечай по-русски, коротко и просто: 2–6 предложений, без markdown-заголовков.',
    'Объясняй понятия и помогай с текущим заданием наводящими подсказками, а не готовым ответом на экзамен.',
    'Никогда не проси и не принимай seed-фразы, приватные ключи, пароли и личные данные. Если ученик их прислал, скажи, что этого нельзя делать нигде.',
    'Не давай инвестиционных советов: не говори, что покупать или продавать, и не прогнозируй цены.',
    'Не помогай обходить закон, санкции, налоги и проверки KYC/AML. Приватные монеты объясняй только для законного использования.',
    'Помни: в РФ оплата товаров и услуг криптовалютой запрещена (259-ФЗ).',
    'Если вопрос не про криптовалюты и тренажёр, вежливо верни разговор к учёбе.',
    ctx ? `Сейчас ученик здесь: ${clip(ctx.cube, 80)}, грань ${clip(ctx.face, 120)}. Цель грани: ${clip(ctx.goal, 400)} Пояснение к грани: ${clip(ctx.explain, 700)}` : '',
  ].join('\n');
}

async function callProvider(p, messages) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(p.base + '/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key }, p.headers || {}),
      body: JSON.stringify({ model: p.model, temperature: 0.3, max_tokens: 500, messages }),
    });
    const j = await r.json().catch(() => ({}));
    const answer = r.ok && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (answer) return { answer: String(answer).trim() };
    console.error('AI provider error', p.name, r.status, JSON.stringify(j).slice(0, 300));
    return { status: r.status };
  } catch (e) {
    console.error('AI provider timeout', p.name);
    return { status: 504 };
  } finally { clearTimeout(timer); }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const list = providers();
  if (!list.length) return res.status(501).json({ error: 'not_configured' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) return res.status(429).json({ error: 'rate_limited' });
  recent.push(now); hits.set(ip, recent);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const msgs = Array.isArray(body && body.messages) ? body.messages.slice(-8) : [];
  const clean = msgs
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: clip(m.content, 1200) }));
  if (!clean.length || clean[clean.length - 1].role !== 'user') return res.status(400).json({ error: 'bad_request' });

  const messages = [{ role: 'system', content: systemPrompt(body.context) }, ...clean];
  let last = 502;
  for (const p of list) {
    const r = await callProvider(p, messages);
    if (r.answer) return res.status(200).json({ answer: r.answer, provider: p.name });
    last = r.status;
  }
  return res.status(last === 429 ? 429 : 502).json({ error: 'provider_error' });
};
