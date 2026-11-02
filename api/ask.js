// ИИ-помощник Cryptocube: серверная прокси-функция Vercel.
// Ключ API хранится только в переменных окружения Vercel и не попадает в браузер.
// Работает с любым OpenAI-совместимым API: Google Gemini (по умолчанию), Groq, OpenRouter.
//   AI_API_KEY  — ключ провайдера (обязательно)
//   AI_BASE_URL — адрес API, по умолчанию Gemini: https://generativelanguage.googleapis.com/v1beta/openai
//   AI_MODEL    — модель, по умолчанию gemini-2.5-flash

const BASE = (process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
const MODEL = process.env.AI_MODEL || 'gemini-2.5-flash';
const LIMIT = 20, WINDOW_MS = 10 * 60 * 1000; // не больше 20 вопросов за 10 минут с одного IP
const hits = new Map();

const clip = (v, n) => String(v || '').slice(0, n);

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (!process.env.AI_API_KEY) return res.status(501).json({ error: 'not_configured' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (list.length >= LIMIT) return res.status(429).json({ error: 'rate_limited' });
  list.push(now); hits.set(ip, list);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const msgs = Array.isArray(body && body.messages) ? body.messages.slice(-8) : [];
  const clean = msgs
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: clip(m.content, 1200) }));
  if (!clean.length || clean[clean.length - 1].role !== 'user') return res.status(400).json({ error: 'bad_request' });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.AI_API_KEY },
      body: JSON.stringify({ model: MODEL, temperature: 0.3, max_tokens: 500,
        messages: [{ role: 'system', content: systemPrompt(body.context) }, ...clean] }),
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('AI provider error', r.status, JSON.stringify(j).slice(0, 300)); return res.status(r.status === 429 ? 429 : 502).json({ error: 'provider_error' }); }
    const answer = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!answer) return res.status(502).json({ error: 'empty_answer' });
    return res.status(200).json({ answer: String(answer).trim() });
  } catch (e) {
    return res.status(504).json({ error: 'timeout' });
  } finally { clearTimeout(timer); }
};
