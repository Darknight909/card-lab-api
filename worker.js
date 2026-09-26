const VERSION = '1.4.0';
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
      return json({ ok: true, service: 'Card Lab API', version: VERSION, ebayConfigured: Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET), tavilyConfigured: Boolean(env.TAVILY_API_KEY) }, 200, cors);
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

      // Step 1: extract clues from the two photos.
      const provisional = provisionalIdentity(frontRead, backRead, null);

      // Step 2: verify those clues against the live web. Only text clues are
      // sent to Tavily; the card photos themselves are NOT sent to Tavily.
      let webLookup = { configured: Boolean(env.TAVILY_API_KEY), used: false, query: '', results: [], answer: null };
      if (env.TAVILY_API_KEY) {
        try {
          webLookup = await tavilyCardLookup(env, provisional, frontRead, backRead);
        } catch (e) {
          webLookup = { configured: true, used: true, query: buildLookupQuery(provisional, frontRead, backRead), results: [], answer: null, error: String(e?.message || e) };
        }
      }

      // Step 3: merge the visual evidence conservatively, then allow a strong
      // online match to fill/correct identity fields. Condition/grading data
      // always comes from the photos, never from web listings.
      const merged = fallbackReconcile(frontRead, backRead);
      const guarded = guardIdentity(merged, frontRead, backRead, null);
      let analysis = applyWebIdentity(guarded, webLookup, frontRead, backRead);
      try { analysis = await resolveIdentityFromWeb(env, analysis, webLookup, frontRead, backRead); } catch (e) { console.warn('Web identity resolver fallback:', e); }
      analysis = applyDeterministicIdentity(analysis, frontRead, backRead);
      analysis.identity_confidence = Math.max(analysis.identity_confidence || 0,
        analysis.web_match?.score >= 18 ? 94 : analysis.identity?.cardNo && analysis.identity?.subject && analysis.identity?.year ? 84 : analysis.identity?.cardNo && analysis.identity?.subject ? 76 : 60);
      analysis.condition_confidence = Math.max(analysis.condition_confidence || 0, 60);
      analysis.evidence = Array.from(new Set([
        ...(analysis.evidence || []),
        'Front/back photos used for condition analysis.',
        ...(webLookup.used ? ['Online lookup used to verify card identity from extracted text clues.'] : [])
      ])).slice(0, 10);

      const query = buildQuery(analysis.identity || provisional);
      let ebay = { configured: false, items: [], query };
      if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
        try {
          ebay = await ebaySearch(env, query);
        } catch (e) {
          ebay = { configured: true, items: [], query, error: String(e?.message || e) };
        }
      }

      // If the refined identity materially differs, refresh eBay once.
      if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET && query && query !== ebay.query) {
        try { ebay = await ebaySearch(env, query); } catch {}
      }

      let market = { configured: Boolean(env.TAVILY_API_KEY), items: [], query, searchUrl: query ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}` : 'https://www.ebay.com/' };
      if (env.TAVILY_API_KEY && query) {
        try { market = await tavilyEbayLookup(env, analysis.identity || provisional); }
        catch (e) { market.error = String(e?.message || e); }
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
        market,
        webLookup: { configured: webLookup.configured, used: webLookup.used, query: webLookup.query, results: (webLookup.results || []).slice(0, 5) },
        privacy: 'Images were sent to Cloudflare Workers AI for visual analysis. Tavily receives only extracted text clues/search terms, not the card images. Tavily is also used to find web-indexed current eBay listings. This Worker does not save images to KV, R2, D1, or Durable Objects.',
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
IMPORTANT CARD NUMBER RULE: card/set codes such as 91TF-2, US175, RA-TH, #123 are high-value identity clues. Copy exactly when legible. Do NOT treat a large uniform/jersey number, stat total, serial on equipment, or player number as the card number unless the card explicitly labels it as the card number.
For set/insert/parallel, only state an exact value if it is visible or strongly supported by the design/card code; otherwise use null and put clues in set_clues.
${side === 'back' ? `BACK-SIDE IDENTITY PRIORITY: read the top/upper card code, player/team line, manufacturer logo near the bottom, and the tiny copyright/legal line at the bottom. If the legal line gives a copyright year, record it in years_seen with role "copyright". A heading such as "2025 RECEIVING STATS" must be role "stats", never release. Stylized Topps logos must be returned as brand "Topps", not OCR-like variants.` : ''}

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

function provisionalIdentity(front, back, marks = null) {
  const fi = front?.identity || {}, bi = back?.identity || {}, mi = marks || {};
  const release = validYear(mi.release_year) || validYear(bi.release_year) || validYear(fi.release_year) || null;
  const cardCode = extractBestCardCode(front, back) || clean(mi.card_number) || clean(bi.card_number) || clean(fi.card_number) || null;
  return {
    year: release,
    brand: normalizeBrand(mi.manufacturer || bi.brand || fi.brand || detectBrandFromReads(front, back)),
    set: clean(mi.set_or_insert) || bi.exact_set_or_insert || fi.exact_set_or_insert || null,
    subject: clean(mi.subject) || bi.subject || fi.subject || null,
    cardNo: cardCode,
    variation: bi.variation_or_parallel || fi.variation_or_parallel || null,
    team: clean(mi.team) || bi.team_or_affiliation || fi.team_or_affiliation || null,
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


function allReadText(front, back) {
  const vals = [];
  for (const r of [front, back]) {
    if (!r) continue;
    const i = r.identity || {};
    vals.push(i.card_number, i.subject, i.brand, i.exact_set_or_insert, i.team_or_affiliation);
    if (Array.isArray(i.set_clues)) vals.push(...i.set_clues);
    if (Array.isArray(r.visible_text)) vals.push(...r.visible_text);
  }
  return vals.filter(Boolean).map(String);
}

function extractBestCardCode(front, back) {
  const texts = allReadText(front, back);
  const candidates = [];
  const add = (raw, score) => {
    const v = clean(raw);
    if (!v) return;
    const u = v.replace(/^#/, '').toUpperCase();
    if (!/[A-Z]/.test(u) && /^\d{1,3}$/.test(u)) return;
    if (u.length < 2 || u.length > 20) return;
    candidates.push({v:u, score});
  };
  for (const r of [back, front]) {
    const c = r?.identity?.card_number;
    if (c) add(c, /[A-Z].*\d|\d.*[A-Z]/i.test(c) ? 100 : 35);
  }
  const rx = /\b[A-Z0-9]{1,8}-[A-Z0-9]{1,8}\b/gi;
  const rx2 = /\b(?=[A-Z0-9]{3,12}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{3,12}\b/gi;
  for (const t of texts) {
    for (const m of String(t).match(rx) || []) add(m, 120);
    for (const m of String(t).match(rx2) || []) add(m, 70);
  }
  candidates.sort((a,b)=>b.score-a.score || b.v.length-a.v.length);
  return candidates[0]?.v || null;
}

function detectBrandFromReads(front, back) {
  const t = allReadText(front, back).join(' ');
  if (/\btopps\b/i.test(t)) return 'Topps';
  if (/\bpanini\b/i.test(t)) return 'Panini';
  if (/\bbowman\b/i.test(t)) return 'Bowman';
  if (/\bupper\s+deck\b/i.test(t)) return 'Upper Deck';
  if (/\bfleer\b/i.test(t)) return 'Fleer';
  if (/\bdonruss\b/i.test(t)) return 'Donruss';
  return null;
}

function applyDeterministicIdentity(out, front, back) {
  const code = extractBestCardCode(front, back);
  if (code) out.identity.cardNo = code;

  const text = allReadText(front, back).join(' ');
  const detectedBrand = detectBrandFromReads(front, back);
  if (detectedBrand) out.identity.brand = detectedBrand;

  if (/^91TF-\w+/i.test(code || '') && /35(?:th)?\s*anniversary/i.test(text)) {
    out.identity.brand = 'Topps';
    out.identity.year = 2026;
    out.identity.set = '1991 Topps Football 35th Anniversary';
    out.needs_review = false;
    out.review_reason = null;
    out.evidence = Array.from(new Set([...(out.evidence||[]), `Card code ${code}`, '35th Anniversary design cue']));
  }

  const years = [...(front?.identity?.years_seen || []), ...(back?.identity?.years_seen || [])];
  const y = Number(out.identity.year);
  if (y && !/^91TF-/i.test(code || '')) {
    const roles = years.filter(x => Number(x?.year) === y).map(x => String(x?.role || 'unknown'));
    if (roles.length && roles.every(r => ['stats','birth','draft','design','unknown','copyright'].includes(r)) && roles.includes('stats')) {
      out.identity.year = null;
      out.needs_review = true;
      out.review_reason = cleanJoin(out.review_reason, `${y} is supported only by non-release evidence.`);
    }
  }
  return out;
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
  const clues = [fi.exact_set_or_insert, bi.exact_set_or_insert, ...(fi.set_clues||[]), ...(bi.set_clues||[]), ...(front?.visible_text||[]), ...(back?.visible_text||[])].join(' ');
  if (/35(?:th)?\s+anniversary/i.test(clues) && /1991/i.test(clues)) year = 2026;
  if (!year) {
    const release = years.find(x => x?.role === 'release');
    if (release?.year) year = Number(release.year);
  }
  return normalizeAnalysis({
    identity: {
      year,
      brand: normalizeBrand(detectBrandFromReads(front, back) || choose(bi.brand, fi.brand)),
      set: choose(bi.exact_set_or_insert, fi.exact_set_or_insert),
      subject: choose(bi.subject, fi.subject),
      cardNo: extractBestCardCode(front, back) || choose(bi.card_number, fi.card_number),
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

function guardIdentity(analysis, front, back, marks = null) {
  const out = structuredClone(analysis);
  const fi = front?.identity || {}, bi = back?.identity || {}, mi = marks || {};

  // Normalize common stylized/OCR manufacturer errors (e.g. TRAPS -> Topps).
  out.identity.brand = normalizeBrand(mi.manufacturer || out.identity.brand || bi.brand || fi.brand);

  // Prefer the focused legal-line read over prominent statistics years.
  const yearEvidence = [...(fi.years_seen || []), ...(bi.years_seen || [])];
  const releaseEvidence = yearEvidence.find(x => String(x?.role || '') === 'release' && validYear(x?.year));
  const strongYear = validYear(mi.release_year) || validYear(releaseEvidence?.year);
  if (strongYear) {
    if (out.identity.year && out.identity.year !== strongYear) {
      out.needs_review = true;
      out.review_reason = cleanJoin(out.review_reason, `Year corrected to ${strongYear} from focused copyright/product evidence.`);
    }
    out.identity.year = strongYear;
  } else {
    const allYears = [...(fi.years_seen || []), ...(bi.years_seen || [])];
    const y = Number(out.identity.year);
    if (y) {
      const rolesForY = allYears.filter(x => Number(x?.year) === y).map(x => String(x?.role || 'unknown'));
      const onlyNonRelease = rolesForY.length && rolesForY.every(r => ['stats','birth','draft','design','unknown'].includes(r));
      if (onlyNonRelease && rolesForY.includes('stats')) {
        out.identity.year = null;
        out.needs_review = true;
        out.review_reason = cleanJoin(out.review_reason, `${y} appears only as a statistics year, so it was not used as the product year.`);
      }
    }
  }

  if (mi.card_number) out.identity.cardNo = clean(mi.card_number);
  if (mi.subject) out.identity.subject = clean(mi.subject);
  if (mi.team) out.identity.team = clean(mi.team);
  if (mi.set_or_insert && !out.identity.set) out.identity.set = clean(mi.set_or_insert);

  // Known 1991 Topps Football anniversary code family. The code itself plus
  // the 35th Anniversary front badge is stronger than a stats-year heading.
  const clueText = [out.identity.cardNo, out.identity.set, ...(fi.set_clues||[]), ...(bi.set_clues||[]), ...(mi.evidence||[]), ...(front?.visible_text||[]), ...(back?.visible_text||[])].filter(Boolean).join(' ');
  if (/^91TF-/i.test(out.identity.cardNo || '') && /35(?:th)?\s*anniversary/i.test(clueText)) {
    out.identity.brand = 'Topps';
    out.identity.year = 2026;
    if (!out.identity.set || /traps/i.test(out.identity.set)) out.identity.set = '1991 Topps Football 35th Anniversary';
  }

  return applyDeterministicIdentity(out, front, back);
}

function normalizeBrand(value) {
  const raw = clean(value);
  if (!raw) return null;
  const brands = ['Topps','Panini','Bowman','Upper Deck','Fleer','Donruss','Score','Leaf'];
  const n = normalizeToken(raw);
  for (const b of brands) {
    const bn = normalizeToken(b);
    if (n === bn) return b;
    if (Math.abs(n.length - bn.length) <= 1 && levenshtein(n, bn) <= 2) return b;
  }
  return raw;
}
function normalizeToken(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/0/g,'o').replace(/5/g,'s'); }
function levenshtein(a,b) {
  const m=Array.from({length:b.length+1},(_,i)=>i);
  for (let i=1;i<=a.length;i++) {
    let prev=m[0]; m[0]=i;
    for (let j=1;j<=b.length;j++) {
      const tmp=m[j];
      m[j]=Math.min(m[j]+1,m[j-1]+1,prev+(a[i-1]===b[j-1]?0:1));
      prev=tmp;
    }
  }
  return m[b.length];
}
function validYear(v) { const n=Number(v); return Number.isInteger(n) && n>=1880 && n<=2100 ? n : null; }
function cleanJoin(a,b) { return [clean(a),clean(b)].filter(Boolean).join(' '); }

function normalizeAnalysis(a, front, back) {
  const identity = a.identity || {};
  const c = a.condition || {};
  const clampScore = v => clampHalf(Number(v) || 1, 1, 10);
  const pair = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) ? normalizePair(p) : null;
  return {
    identity: {
      year: identity.year ? Number(identity.year) : null,
      brand: normalizeBrand(identity.brand), set: clean(identity.set), subject: clean(identity.subject),
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


async function tavilyCardLookup(env, provisional, front, back) {
  const queries = buildLookupQueries(provisional, front, back);
  if (!queries.length) return { configured: true, used: false, query: '', queries: [], results: [], answer: null };
  const batches = await Promise.all(queries.slice(0, 2).map(q => tavilySearch(env, q, 8)));
  const byUrl = new Map();
  for (const b of batches) for (const x of b.results || []) {
    const key = x.url || `${x.title}|${x.content}`;
    if (!byUrl.has(key) || (byUrl.get(key).score || 0) < (x.score || 0)) byUrl.set(key, x);
  }
  return {
    configured: true, used: true, query: queries[0], queries,
    answer: batches.map(x => x.answer).filter(Boolean).join(' | ') || null,
    results: [...byUrl.values()].sort((a,b)=>(b.score||0)-(a.score||0)).slice(0, 12),
  };
}

async function tavilySearch(env, query, maxResults = 8, includeDomains = null) {
  const body = { query, topic: 'general', search_depth: 'basic', max_results: maxResults, include_answer: true, include_raw_content: false, include_images: false };
  if (includeDomains?.length) body.include_domains = includeDomains;
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.TAVILY_API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Tavily search ${r.status}${t ? `: ${t.slice(0, 180)}` : ''}`);
  }
  const j = await r.json();
  return { answer: clean(j.answer), results: (j.results || []).map(x => ({ title: clean(x.title), url: clean(x.url), content: clean(x.content), score: Number(x.score) || 0 })) };
}

function buildLookupQueries(i = {}, front, back) {
  const rawText = allReadText(front, back).join(' ');
  const code = i.cardNo || extractCardCodeFromText(rawText);
  const subject = i.subject || front?.identity?.subject || back?.identity?.subject || '';
  const brand = normalizeBrand(i.brand || detectBrandFromReads(front, back)) || '';
  const setClues = [...(front?.identity?.set_clues || []), ...(back?.identity?.set_clues || [])].filter(Boolean).slice(0,3).join(' ');
  const q=[];
  if (code) q.push([`"${code}"`, subject && `"${subject}"`, brand, 'trading card checklist set year'].filter(Boolean).join(' '));
  if (subject) q.push([`"${subject}"`, code && `"${code}"`, brand, i.set || setClues, 'trading card'].filter(Boolean).join(' '));
  if (!q.length && rawText) q.push(`${rawText.slice(0,220)} trading card identify set card number`);
  return [...new Set(q.map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean))];
}

function buildLookupQuery(i = {}, front, back) { return buildLookupQueries(i, front, back)[0] || ''; }

function applyWebIdentity(analysis, web, front, back) {
  const out = structuredClone(analysis);
  if (!web?.used || !(web.results || []).length) return out;
  const base = out.identity || {};
  const scored = web.results.map(r => ({ ...r, matchScore: scoreWebResult(r, base, front, back) }))
    .sort((a,b) => b.matchScore - a.matchScore || b.score - a.score);
  const best = scored[0];
  if (!best || best.matchScore < 8) {
    out.needs_review = true;
    out.review_reason = cleanJoin(out.review_reason, 'Online search did not find a strong exact-card match.');
    return out;
  }

  const evidenceText = [best.title, best.content, web.answer].filter(Boolean).join(' | ');
  const cardNo = base.cardNo || extractCardCodeFromText(evidenceText);
  const subject = base.subject || extractSubjectFromBest(best, front, back);
  const brand = normalizeBrand(base.brand || detectBrandFromText(evidenceText));
  const year = chooseWebYear(best, web.answer, base.year, cardNo, subject);
  const set = chooseWebSet(best, brand, year, subject, cardNo, base.set);

  if (cardNo) base.cardNo = cardNo;
  if (subject) base.subject = subject;
  if (brand) base.brand = brand;
  if (year) base.year = year;
  if (set) base.set = set;

  out.identity = base;
  out.web_match = {
    score: best.matchScore, title: best.title, url: best.url,
  };
  if (best.matchScore >= 18 && base.cardNo && base.subject) {
    out.needs_review = false;
    out.review_reason = null;
    out.evidence = Array.from(new Set([...(out.evidence || []), `Online exact-match: ${best.title}`])).slice(0, 10);
  } else {
    out.needs_review = true;
    out.review_reason = cleanJoin(out.review_reason, 'Online match found but should be reviewed before professional grading.');
  }
  return applyDeterministicIdentity(out, front, back);
}

async function resolveIdentityFromWeb(env, analysis, web, front, back) {
  if (!web?.results?.length) return analysis;
  const clues = {
    visualIdentity: analysis.identity || {},
    cardCode: extractBestCardCode(front, back),
    visibleText: allReadText(front, back).slice(0, 30),
    searchAnswer: web.answer,
    searchResults: web.results.slice(0, 10).map(x => ({title:x.title,url:x.url,content:x.content})),
  };
  const prompt = `Identify ONE collectible trading card from visual text clues plus live web search results. Return ONLY valid JSON. Do not use a statistics season as the product release year. Treat an alphanumeric card code (example 91TF-2) as stronger evidence than a jersey number. Prefer exact checklist/manufacturer/database matches across multiple sources. If a field is not supportable, use null.\n\nINPUT:\n${JSON.stringify(clues)}\n\nRETURN:\n{"year":number|null,"brand":string|null,"set":string|null,"subject":string|null,"cardNo":string|null,"variation":string|null,"team":string|null,"category":"Sports|TCG|Non-sport|Other|null","confidence":number,"evidence":["..."]}`;
  const raw = await env.AI.run(TEXT_MODEL, {messages:[{role:'system',content:'You identify trading cards from corroborated web evidence. Return JSON only.'},{role:'user',content:prompt}],temperature:0.02,max_tokens:900,stream:false});
  const obj = parseModelJSON(modelText(raw), 'web identity');
  const out = structuredClone(analysis);
  out.identity ||= {};
  for (const k of ['year','brand','set','subject','cardNo','variation','team','category']) if (obj[k] !== null && obj[k] !== undefined && obj[k] !== '') out.identity[k] = k==='brand' ? normalizeBrand(obj[k]) : obj[k];
  out.identity_confidence = clamp(Number(obj.confidence)||out.identity_confidence||0,0,100);
  out.evidence = Array.from(new Set([...(out.evidence||[]), ...(Array.isArray(obj.evidence)?obj.evidence:[])])).slice(0,10);
  if (out.identity.cardNo && out.identity.subject && out.identity.year && out.identity.set && out.identity_confidence >= 75) { out.needs_review=false; out.review_reason=null; }
  return out;
}

async function tavilyEbayLookup(env, identity = {}) {
  const query = buildQuery(identity);
  const searchUrl = query ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}` : 'https://www.ebay.com/';
  if (!query) return {configured:true,items:[],query,searchUrl};
  const q = `${query} current eBay listing`;
  const b = await tavilySearch(env, q, 8, ['ebay.com']);
  const items = (b.results||[]).slice(0,6).map(x=>({title:x.title,url:x.url,price:extractPrice(`${x.title||''} ${x.content||''}`),content:x.content}));
  return {configured:true,items,query,searchUrl,source:'Tavily web-indexed eBay results'};
}
function extractPrice(text){const m=String(text||'').match(/\$\s*([0-9]{1,6}(?:\.[0-9]{2})?)/);return m?Number(m[1].replace(/,/g,'')):null;}

function scoreWebResult(r, i, front, back) {
  const t = `${r.title || ''} ${r.content || ''}`.toLowerCase();
  let s = 0;
  const has = v => v && t.includes(String(v).toLowerCase());
  if (has(i.cardNo)) s += 12;
  if (has(i.subject)) s += 8;
  if (has(i.brand)) s += 4;
  if (has(i.set)) s += 5;
  const clueText = allReadText(front, back).join(' ');
  if (/35(?:th)?\s*anniversary/i.test(clueText) && /35(?:th)?\s*anniversary/i.test(t)) s += 3;
  if (/beckett\.com|tcdb\.com|tradingcarddb\.com|cardboardconnection\.com|topps\.com|psacard\.com/i.test(r.url || '')) s += 3;
  s += Math.min(2, Math.max(0, Number(r.score) || 0) * 2);
  return Math.round(s * 10) / 10;
}

function chooseWebYear(best, answer, current, cardNo, subject) {
  const title = String(best?.title || '');
  const text = `${title} ${best?.content || ''} ${answer || ''}`;
  const titleYears = (title.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
  if (titleYears.length) {
    if (/35(?:th)?\s*anniversary/i.test(text) && titleYears.length > 1) return Math.max(...titleYears.filter(validYear));
    const first = validYear(titleYears[0]);
    if (first) return first;
  }
  const all = (text.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number).filter(validYear);
  if (all.length) {
    const recent = all.filter(y => y >= 2000);
    if (recent.length) return Math.max(...recent);
    return all[0];
  }
  return validYear(current);
}

function chooseWebSet(best, brand, year, subject, cardNo, current) {
  let title = clean(best?.title);
  if (!title) return current || null;
  title = title.replace(/\s*[|–—]\s*(eBay|Beckett|Trading Card Database|TCDB|PSA).*$/i, '');
  if (subject) title = title.replace(new RegExp(escapeRegex(subject), 'ig'), '');
  if (cardNo) title = title.replace(new RegExp(`#?${escapeRegex(cardNo)}`, 'ig'), '');
  if (year) title = title.replace(new RegExp(`\b${year}\b`, 'g'), '');
  if (brand) title = title.replace(new RegExp(`\b${escapeRegex(brand)}\b`, 'ig'), '');
  title = title.replace(/\b(card|football card|basketball card|baseball card)\b/ig, ' ')
    .replace(/^[\s:#|–—-]+|[\s:#|–—-]+$/g, '').replace(/\s+/g, ' ').trim();
  if (title.length >= 4 && title.length <= 120) return title;
  return current || null;
}

function extractCardCodeFromText(text) {
  const rx = /\b[A-Z0-9]{1,8}-[A-Z0-9]{1,8}\b/gi;
  const m = String(text || '').match(rx);
  return m?.[0]?.toUpperCase() || null;
}

function detectBrandFromText(text) {
  const t = String(text || '');
  for (const b of ['Topps','Panini','Bowman','Upper Deck','Fleer','Donruss','Score','Leaf']) {
    if (new RegExp(`\\b${escapeRegex(b)}\\b`, 'i').test(t)) return b;
  }
  return null;
}

function extractSubjectFromBest(best, front, back) {
  const known = [front?.identity?.subject, back?.identity?.subject].map(clean).filter(Boolean);
  for (const s of known) if ((best.title || '').toLowerCase().includes(s.toLowerCase())) return s;
  return known[0] || null;
}

function escapeRegex(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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
