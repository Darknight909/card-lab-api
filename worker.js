const VERSION = '1.2.1';
const DEFAULT_ORIGIN = 'https://darknight909.github.io';
const VISION_MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

let ebayTokenCache = { token: null, expiresAt: 0 };

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
    const cors = corsHeaders(origin, allowedOrigin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'Card Lab API', version: VERSION, ebayConfigured: Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) }, 200, cors);
    }

    if (origin && origin !== allowedOrigin) {
      return json({ ok: false, error: 'Origin not allowed' }, 403, cors);
    }

    if (!env.CARDLAB_API_KEY) {
      return json({ ok: false, error: 'CARDLAB_API_KEY secret is not configured on the Worker.' }, 500, cors);
    }
    const auth = request.headers.get('Authorization') || '';
    if (auth !== `Bearer ${env.CARDLAB_API_KEY}`) {
      return json({ ok: false, error: 'Unauthorized' }, 401, cors);
    }

    if (url.pathname !== '/analyze' || request.method !== 'POST') {
      return json({ ok: false, error: 'Not found' }, 404, cors);
    }

    try {
      const body = await request.json();
      const front = validateImage(body.front, 'front');
      const back = validateImage(body.back, 'back');

      const [frontRead, backRead] = await Promise.all([
        inspectSide(env, 'front', front),
        inspectSide(env, 'back', back),
      ]);

      const provisional = provisionalIdentity(frontRead, backRead);
      let ebay = { configured: false, items: [], query: buildQuery(provisional) };
      if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
        try {
          ebay = await ebaySearch(env, buildQuery(provisional));
        } catch (e) {
          ebay = { configured: true, items: [], query: buildQuery(provisional), error: String(e?.message || e) };
        }
      }

      const analysis = await reconcile(env, frontRead, backRead, ebay.items || []);
      const query = buildQuery(analysis.identity || provisional);

      // If the refined identity materially differs, refresh eBay once.
      if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET && query && query !== ebay.query) {
        try { ebay = await ebaySearch(env, query); } catch {}
      }

      return json({
        ok: true,
        version: VERSION,
        analysis,
        ebay: {
          ...ebay,
          query,
          searchUrl: query ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}` : 'https://www.ebay.com/',
        },
        privacy: 'Images were sent to Cloudflare Workers AI for this analysis. This Worker does not save them to KV, R2, D1, or Durable Objects.',
      }, 200, cors);
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: cleanError(e) }, 400, cors);
    }
  },
};

function corsHeaders(origin, allowedOrigin) {
  const allow = !origin || origin === allowedOrigin ? (origin || allowedOrigin) : allowedOrigin;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}

function validateImage(value, label) {
  if (typeof value !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(value)) {
    throw new Error(`A ${label} card photo is required.`);
  }
  // Approximate 6 MB encoded cap per image. Frontend normally sends far less.
  if (value.length > 8_400_000) throw new Error(`${label} photo is too large. Retake or use a smaller image.`);
  return value;
}

async function inspectSide(env, side, image) {
  const question = `You are inspecting the ${side} of ONE raw collectible trading card from a phone photo. Return ONLY valid JSON, no markdown.

Do not invent text. Read visible text carefully. The card can be sports, TCG, or non-sport.
IMPORTANT YEAR RULE: distinguish the product/release year from statistics years, season years, copyright years, birth years, draft years, anniversary references, and historical design years. A statistics heading such as "2025 RECEIVING STATS" is NOT automatically the card's release year. If a copyright/product year is explicit, label its role. If release year cannot be established from this side alone, use null.
IMPORTANT CARD NUMBER RULE: card/set codes such as 91TF-2, US175, RA-TH, #123 are high-value identity clues. Copy exactly when legible.
For set/insert/parallel, only state an exact value if it is visible or strongly supported by the design/card code; otherwise use null and put clues in set_clues.

For condition, estimate only defects visible in THIS photo. Be conservative. A missing defect means "not visible", not proof it is absent. Surface defects are hard to assess under glare.
Centering should be a best visual estimate as percentages with the larger side first, for left/right and top/bottom, or null for borderless/uncertain designs.

JSON schema:
{
  "side":"${side}",
  "visible_text":["..."],
  "identity":{
    "subject":string|null,
    "team_or_affiliation":string|null,
    "brand":string|null,
    "exact_set_or_insert":string|null,
    "set_clues":["..."],
    "card_number":string|null,
    "variation_or_parallel":string|null,
    "release_year":number|null,
    "years_seen":[{"year":number,"role":"stats|copyright|release|design|birth|draft|unknown"}],
    "category":"Sports|TCG|Non-sport|Other|null"
  },
  "condition":{
    "corners":number,
    "edges":number,
    "surface":number,
    "focus_registration":number,
    "centering_lr":[number,number]|null,
    "centering_tb":[number,number]|null,
    "defects":{"crease":boolean,"dent":boolean,"stain":boolean,"scratch":boolean,"printline":boolean,"mark":boolean,"possible_alteration":boolean},
    "notes":["..."],
    "photo_confidence":number
  }
}
Scores are 1-10 in 0.5 increments. photo_confidence is 0-100.`;

  const raw = await env.AI.run(VISION_MODEL, {
    task: 'query', image, question, reasoning: false, temperature: 0.05, max_tokens: 2500, stream: false,
  });
  const text = modelText(raw);
  return parseModelJSON(text, `${side} vision`);
}

function provisionalIdentity(front, back) {
  const fi = front?.identity || {}, bi = back?.identity || {};
  const release = bi.release_year || fi.release_year || null;
  return {
    year: release,
    brand: bi.brand || fi.brand || null,
    set: bi.exact_set_or_insert || fi.exact_set_or_insert || null,
    subject: bi.subject || fi.subject || null,
    cardNo: bi.card_number || fi.card_number || null,
    variation: bi.variation_or_parallel || fi.variation_or_parallel || null,
    team: bi.team_or_affiliation || fi.team_or_affiliation || null,
    category: bi.category || fi.category || null,
  };
}

async function reconcile(env, front, back, ebayItems) {
  const ebayTitles = ebayItems.slice(0, 8).map(x => x.title).filter(Boolean);
  const prompt = `You reconcile front/back visual reads of ONE collectible card into a conservative pre-grade record. Return ONLY valid JSON, no markdown.

Rules:
1. Never use a stats season, birth year, draft year, or historical throwback-design year as the product release year merely because it is the largest/most prominent year. Use explicit copyright/product evidence and consistent marketplace titles when available.
2. Card number/code is a primary identifier. Preserve punctuation/case except obvious OCR errors.
3. eBay titles are corroborating clues only; they can be wrong. Prefer agreement across card code, manufacturer, player, and multiple titles.
4. Exact set/insert/parallel should be specific only when evidence supports it. Otherwise use the narrowest truthful name and set needs_review=true.
5. Condition scores should be the WORSE reasonable combined view across front/back, not an optimistic average. Photos cannot reliably prove absence of dents, micro-scratches, trimming, restoration, or hidden surface defects.
6. Centering: use the visual estimate from each corresponding side. Output larger percentage first. If uncertain/borderless, null.
7. Do NOT issue an official PSA/BGS/CGC/SGC grade. The app applies published grading standards separately.

FRONT READ:
${JSON.stringify(front)}

BACK READ:
${JSON.stringify(back)}

CURRENT EBAY LISTING TITLES (if available):
${JSON.stringify(ebayTitles)}

Return:
{
 "identity":{"year":number|null,"brand":string|null,"set":string|null,"subject":string|null,"cardNo":string|null,"variation":string|null,"team":string|null,"category":"Sports|TCG|Non-sport|Other|null"},
 "condition":{"corners":number,"edges":number,"surface":number,"focus":number,"front":{"lr":[number,number]|null,"tb":[number,number]|null},"back":{"lr":[number,number]|null,"tb":[number,number]|null},"defects":{"crease":boolean,"dent":boolean,"stain":boolean,"scratch":boolean,"printline":boolean,"mark":boolean,"possible_alteration":boolean},"notes":["..."]},
 "identity_confidence":number,
 "condition_confidence":number,
 "evidence":["..."],
 "needs_review":boolean,
 "review_reason":string|null
}`;

  const raw = await env.AI.run(TEXT_MODEL, {
    messages: [
      { role: 'system', content: 'You are a conservative trading-card identification and pre-grading reconciliation engine. Return one valid JSON object only.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.05,
    max_tokens: 1800,
    stream: false,
  });

  // Cloudflare JSON Mode may return the structured object under `response`
  // instead of as plain text. Accept both shapes. If reconciliation ever
  // fails, fall back to a conservative deterministic merge rather than
  // throwing away the entire card analysis.
  try {
    const result = structuredModelResult(raw, 'reconciliation');
    return normalizeAnalysis(result, front, back);
  } catch (e) {
    console.warn('Reconciliation fallback:', e);
    return fallbackReconcile(front, back);
  }
}


function structuredModelResult(raw, label) {
  if (!raw) throw new Error(`${label} returned no result.`);
  if (raw.response && typeof raw.response === 'object' && !Array.isArray(raw.response)) return raw.response;
  if (raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result)) return raw.result;
  const msg = raw.choices?.[0]?.message;
  if (msg?.parsed && typeof msg.parsed === 'object') return msg.parsed;
  if (typeof msg?.content === 'string') return parseModelJSON(msg.content, label);
  if (typeof raw.response === 'string') return parseModelJSON(raw.response, label);
  if (typeof raw.answer === 'string') return parseModelJSON(raw.answer, label);
  return parseModelJSON(modelText(raw), label);
}

function fallbackReconcile(front, back) {
  const fi = front?.identity || {}, bi = back?.identity || {};
  const fc = front?.condition || {}, bc = back?.condition || {};
  const choose = (a, b) => clean(a) || clean(b) || null;
  const worse = (a, b, d = 5) => {
    const vals = [Number(a), Number(b)].filter(Number.isFinite);
    return clampHalf(vals.length ? Math.min(...vals) : d, 1, 10);
  };
  const defects = {};
  for (const k of ['crease','dent','stain','scratch','printline','mark','possible_alteration']) {
    defects[k] = Boolean(fc.defects?.[k] || bc.defects?.[k]);
  }
  const years = [...(fi.years_seen || []), ...(bi.years_seen || [])];
  let year = Number(bi.release_year || fi.release_year) || null;
  // If the card itself says it is a 35th-anniversary treatment of a 1991 design,
  // 1991 + 35 = 2026 is a strong product-year clue. This also prevents a 2025
  // statistics heading from being mistaken for the release year.
  const clues = [fi.exact_set_or_insert, bi.exact_set_or_insert, ...(fi.set_clues||[]), ...(bi.set_clues||[]), ...(fi.visible_text||[]), ...(bi.visible_text||[])].join(' ');
  if (/35(?:th)?\s+anniversary/i.test(clues) && /1991/i.test(clues)) year = 2026;
  if (!year) {
    const release = years.find(x => x?.role === 'release');
    if (release?.year) year = Number(release.year);
  }
  return normalizeAnalysis({
    identity: {
      year,
      brand: choose(bi.brand, fi.brand),
      set: choose(bi.exact_set_or_insert, fi.exact_set_or_insert),
      subject: choose(bi.subject, fi.subject),
      cardNo: choose(bi.card_number, fi.card_number),
      variation: choose(bi.variation_or_parallel, fi.variation_or_parallel),
      team: choose(bi.team_or_affiliation, fi.team_or_affiliation),
      category: bi.category || fi.category || 'Other',
    },
    condition: {
      corners: worse(fc.corners, bc.corners),
      edges: worse(fc.edges, bc.edges),
      surface: worse(fc.surface, bc.surface),
      focus: worse(fc.focus_registration, bc.focus_registration),
      front: { lr: fc.centering_lr || null, tb: fc.centering_tb || null },
      back: { lr: bc.centering_lr || null, tb: bc.centering_tb || null },
      defects,
      notes: ['Automatic reconciliation used the conservative fallback because the structured AI response could not be read.'],
    },
    identity_confidence: 55,
    condition_confidence: 45,
    evidence: ['Front/back vision reads were merged conservatively.'],
    needs_review: true,
    review_reason: 'Structured reconciliation fallback used; verify identity before professional grading.',
  }, front, back);
}

function normalizeAnalysis(a, front, back) {
  const identity = a.identity || {};
  const c = a.condition || {};
  const clampScore = v => clampHalf(Number(v) || 1, 1, 10);
  const pair = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) ? normalizePair(p) : null;
  return {
    identity: {
      year: identity.year ? Number(identity.year) : null,
      brand: clean(identity.brand), set: clean(identity.set), subject: clean(identity.subject),
      cardNo: clean(identity.cardNo), variation: clean(identity.variation), team: clean(identity.team),
      category: ['Sports','TCG','Non-sport','Other'].includes(identity.category) ? identity.category : 'Other',
    },
    condition: {
      corners: clampScore(c.corners), edges: clampScore(c.edges), surface: clampScore(c.surface), focus: clampScore(c.focus),
      front: { lr: pair(c.front?.lr) || pair(front?.condition?.centering_lr), tb: pair(c.front?.tb) || pair(front?.condition?.centering_tb) },
      back: { lr: pair(c.back?.lr) || pair(back?.condition?.centering_lr), tb: pair(c.back?.tb) || pair(back?.condition?.centering_tb) },
      defects: {
        crease: Boolean(c.defects?.crease), dent: Boolean(c.defects?.dent), stain: Boolean(c.defects?.stain), scratch: Boolean(c.defects?.scratch),
        printline: Boolean(c.defects?.printline), mark: Boolean(c.defects?.mark), possible_alteration: Boolean(c.defects?.possible_alteration),
      },
      notes: Array.isArray(c.notes) ? c.notes.map(clean).filter(Boolean).slice(0, 8) : [],
    },
    identity_confidence: clamp(Number(a.identity_confidence) || 0, 0, 100),
    condition_confidence: clamp(Number(a.condition_confidence) || 0, 0, 100),
    evidence: Array.isArray(a.evidence) ? a.evidence.map(clean).filter(Boolean).slice(0, 10) : [],
    needs_review: Boolean(a.needs_review),
    review_reason: clean(a.review_reason),
  };
}

function modelText(raw) {
  if (typeof raw === 'string') return raw;
  if (!raw) return '';
  if (typeof raw.answer === 'string') return raw.answer;
  if (typeof raw.response === 'string') return raw.response;
  if (typeof raw.result === 'string') return raw.result;
  const content = raw.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(x => x?.text || '').join('\n');
  return JSON.stringify(raw);
}

function parseModelJSON(text, label) {
  if (typeof text !== 'string') throw new Error(`${label} returned no text.`);
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  throw new Error(`${label} returned an unreadable response. Try clearer photos.`);
}

function buildQuery(i = {}) {
  return [i.year, i.brand, i.set, i.subject, i.cardNo, i.variation].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

async function ebaySearch(env, query) {
  if (!query) return { configured: true, items: [], query };
  const token = await getEbayToken(env);
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '12');
  const r = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US', 'Accept': 'application/json' },
  });
  if (!r.ok) throw new Error(`eBay Browse API ${r.status}`);
  const data = await r.json();
  const items = (data.itemSummaries || []).slice(0, 12).map(x => ({
    itemId: x.itemId, title: x.title, price: x.price?.value ? Number(x.price.value) : null,
    currency: x.price?.currency || 'USD', image: x.image?.imageUrl || null, url: x.itemWebUrl || null,
    condition: x.condition || null,
  }));
  return { configured: true, items, query };
}

async function getEbayToken(env) {
  if (ebayTokenCache.token && ebayTokenCache.expiresAt > Date.now() + 60000) return ebayTokenCache.token;
  const basic = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!r.ok) throw new Error(`eBay OAuth ${r.status}`);
  const j = await r.json();
  ebayTokenCache = { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in || 7200) * 1000) };
  return ebayTokenCache.token;
}

function normalizePair(p) {
  let a = Number(p[0]), b = Number(p[1]);
  const total = a + b;
  if (!(total > 0)) return [50, 50];
  a = a / total * 100; b = 100 - a;
  return a >= b ? [round1(a), round1(b)] : [round1(b), round1(a)];
}
function clampHalf(v, min, max) { return Math.round(clamp(v, min, max) * 2) / 2; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round1(v) { return Math.round(v * 10) / 10; }
function clean(v) { return v == null ? null : String(v).trim().slice(0, 300) || null; }
function cleanError(e) { return String(e?.message || e || 'Unknown error').slice(0, 500); }
