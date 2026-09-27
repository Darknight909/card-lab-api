const VERSION = '3.0.1';
const DEFAULT_ORIGIN = 'https://darknight909.github.io';
const CONDITION_MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const GOOGLE_VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';
const TRUSTED_CARD_DOMAINS = [
  'topps.com','fanaticscollect.com','paniniamerica.net','upperdeck.com','leaftradingcards.com',
  'beckett.com','tcdb.com','cardboardconnection.com','cardboardchecklist.com','sportscardspro.com'
];
const OFFICIAL_DOMAINS = ['topps.com','fanaticscollect.com','paniniamerica.net','upperdeck.com','leaftradingcards.com'];
const STRONG_REFERENCE_DOMAINS = ['beckett.com','tcdb.com','cardboardconnection.com','cardboardchecklist.com'];
const PARALLEL_WORDS = ['refractor','prizm','parallel','crackle','wave','x-fractor','xfractor','sepia','negative','aqua','blue','green','red','orange','pink','purple','gold','black','silver','rainbow','diamante','foil','shimmer','sparkle','atomic','mojo','superfractor','image variation','variation'];

let ebayTokenCache = { token: null, expiresAt: 0, cacheKey: null };

function ebayEnvironment(env) {
  return String(env.EBAY_ENV || 'sandbox').toLowerCase() === 'production'
    ? 'production'
    : 'sandbox';
}

function ebayApiBase(env) {
  return ebayEnvironment(env) === 'production'
    ? 'https://api.ebay.com'
    : 'https://api.sandbox.ebay.com';
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
    const cors = corsHeaders(origin, allowedOrigin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({
        ok: true,
        service: 'Card Lab API',
        version: VERSION,
        googleVisionConfigured: Boolean(env.GOOGLE_VISION_API_KEY),
        tavilyConfigured: Boolean(env.TAVILY_API_KEY),
        ebayConfigured: Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET),
        ebayEnvironment: ebayEnvironment(env),
        workersAIConfigured: Boolean(env.AI),
        architecture: 'verified-source identity + condition + live market',
      }, 200, cors);
    }

    if (origin && origin !== allowedOrigin) return json({ ok: false, error: 'Origin not allowed' }, 403, cors);
    if (!env.CARDLAB_API_KEY) return json({ ok: false, error: 'CARDLAB_API_KEY secret is not configured on the Worker.' }, 500, cors);
    if ((request.headers.get('Authorization') || '') !== `Bearer ${env.CARDLAB_API_KEY}`) return json({ ok: false, error: 'Unauthorized' }, 401, cors);

    try {
      if (url.pathname === '/market' && request.method === 'POST') {
        const body = await request.json();
        const identity = sanitizeLockedIdentity(body.identity);
        if (!identity) throw new Error('A verified card identity is required to refresh market listings.');
        const front = typeof body.front === 'string' && /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(body.front) ? body.front : null;
        const market = await getMarket(env, identity, front);
        return json({ ok:true, version:VERSION, market, ebay:market.ebay || null }, 200, cors);
      }

      if (url.pathname !== '/analyze' || request.method !== 'POST') return json({ ok: false, error: 'Not found' }, 404, cors);
      if (!env.GOOGLE_VISION_API_KEY) throw new Error('GOOGLE_VISION_API_KEY secret is not configured on the Worker.');

      const body = await request.json();
      const front = validateImage(body.front, 'front');
      const back = validateImage(body.back, 'back');
      const lockedIdentity = sanitizeLockedIdentity(body.identityLock);

      const conditionPromise = Promise.all([
        inspectConditionSide(env, 'front', front),
        inspectConditionSide(env, 'back', back),
      ]).then(([frontCondition, backCondition]) => combineCondition(frontCondition, backCondition));

      let google = null;
      let webLookup = { configured:Boolean(env.TAVILY_API_KEY), used:false, query:'', queries:[], results:[], answer:null };
      let identityResult;

      if (lockedIdentity) {
        identityResult = {
          identity: lockedIdentity,
          identity_confidence: clamp(Number(body.identityConfidence) || 98, 70, 100),
          verification_status: 'locked',
          evidence: ['Previously verified identity reused; online identity lookup skipped for this re-analysis.'],
          sources: Array.isArray(body.identitySources) ? body.identitySources.slice(0,12) : [],
          needs_review: false,
          review_reason: null,
          selected_card_code: lockedIdentity.cardNo || null,
          serial_number: clean(body.serialNumber),
        };
      } else {
        const googleInitial = await googleVisionInitial(env, front, back);
        let backWebFallback = null;
        if (googleWebStrength(googleInitial.front) < 2) {
          try { backWebFallback = await googleVisionWebOnly(env, back); }
          catch (e) { console.warn('Google back Web Detection fallback:', e); }
        }
        google = combineGoogleEvidence(googleInitial, backWebFallback);
        const provisional = provisionalFromGoogle(google);

        if (env.TAVILY_API_KEY) {
          try { webLookup = await trustedCardLookup(env, provisional, google); }
          catch (e) {
            webLookup = { configured:true, used:true, query:'', queries:[], results:[], answer:null, error:cleanError(e) };
          }
        }

        identityResult = await resolveIdentityFromSources(env, google, provisional, webLookup);
      }

      const condition = await conditionPromise;
      const analysis = {
        identity: identityResult.identity,
        condition,
        identity_confidence: identityResult.identity_confidence,
        condition_confidence: condition.confidence,
        verification_status: identityResult.verification_status,
        sources: identityResult.sources || [],
        evidence: identityResult.evidence || [],
        selected_card_code: identityResult.selected_card_code || identityResult.identity?.cardNo || null,
        serial_number: identityResult.serial_number || null,
        needs_review: Boolean(identityResult.needs_review),
        review_reason: identityResult.review_reason || null,
      };

      let market = emptyMarket(analysis.identity);
      if (identityMarketReady(analysis)) {
        try { market = await getMarket(env, analysis.identity, front); }
        catch (e) { market = { ...emptyMarket(analysis.identity), error:cleanError(e) }; }
      }

      return json({
        ok: true,
        version: VERSION,
        analysis,
        market,
        ebay: market.ebay || { configured:Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET), items:[], query:market.query, searchUrl:market.searchUrl },
        googleVision: google ? googlePublicSummary(google) : { configured:true, used:false, skippedBecauseIdentityLocked:true },
        webLookup: {
          configured: webLookup.configured,
          used: webLookup.used,
          query: webLookup.query,
          queries: webLookup.queries || [],
          results: (webLookup.results || []).slice(0, 10).map(x => ({ title:x.title, url:x.url, score:x.score, trustTier:x.trustTier, exactCode:x.exactCode })),
        },
        pipeline: {
          identity: lockedIdentity ? 'Verified identity lock reused' : 'Google OCR/Web Detection → trusted-source exact-card verification',
          condition: 'Cloudflare Workers AI visible-condition inspection with automatic retry on incomplete output',
          centering: 'Measured locally; vision cross-check is used only as a disagreement guard',
          grading: 'Calculated locally from published grading standards/guidelines',
          market: market.live ? 'Official eBay Browse API keyword/image matching' : 'Web-indexed fallback until eBay API credentials are connected',
        },
        privacy: 'Front/back images are sent transiently to Google Cloud Vision and Cloudflare Workers AI. If eBay API image search is configured, the front analysis image is also sent to eBay Browse API. Tavily receives text/search clues, not card images. This Worker does not persist images or collection data.',
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
  if (typeof value !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(value)) throw new Error(`A ${label} card photo is required.`);
  if (value.length > 10_500_000) throw new Error(`${label} photo is too large. Retake or choose a smaller image.`);
  return value;
}

function stripDataUrl(value) {
  const i = String(value || '').indexOf(',');
  return i >= 0 ? value.slice(i + 1) : value;
}

async function googleVisionInitial(env, front, back) {
  const payload = {
    requests: [
      {
        image: { content: stripDataUrl(front) },
        features: [
          { type: 'WEB_DETECTION', maxResults: 20 },
          { type: 'TEXT_DETECTION' },
        ],
      },
      {
        image: { content: stripDataUrl(back) },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      },
    ],
  };
  const data = await googleVisionRequest(env, payload);
  const responses = data.responses || [];
  return {
    front: parseGoogleResponse(responses[0], 'front'),
    back: parseGoogleResponse(responses[1], 'back'),
  };
}

async function googleVisionWebOnly(env, image) {
  const payload = { requests: [{ image: { content: stripDataUrl(image) }, features: [{ type: 'WEB_DETECTION', maxResults: 20 }] }] };
  const data = await googleVisionRequest(env, payload);
  return parseGoogleResponse(data.responses?.[0], 'back');
}

async function googleVisionRequest(env, payload) {
  const r = await fetch(`${GOOGLE_VISION_URL}?key=${encodeURIComponent(env.GOOGLE_VISION_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) {
    const message = data?.error?.message || text.slice(0, 300) || `HTTP ${r.status}`;
    throw new Error(`Google Vision ${r.status}: ${message}`);
  }
  for (const x of data.responses || []) {
    if (x?.error?.message) throw new Error(`Google Vision: ${x.error.message}`);
  }
  return data;
}

function parseGoogleResponse(r, side) {
  r ||= {};
  const web = r.webDetection || {};
  const textAnnotations = Array.isArray(r.textAnnotations) ? r.textAnnotations : [];
  const fullText = cleanLong(r.fullTextAnnotation?.text || textAnnotations[0]?.description || '', 12000);
  return {
    side,
    fullText,
    lines: fullText ? fullText.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 160) : [],
    web: {
      bestGuessLabels: (web.bestGuessLabels || []).map(x => clean(x.label)).filter(Boolean).slice(0, 8),
      entities: (web.webEntities || []).map(x => ({ description: clean(x.description), score: Number(x.score) || 0 })).filter(x => x.description).sort((a,b)=>b.score-a.score).slice(0, 20),
      pages: (web.pagesWithMatchingImages || []).map(x => ({
        url: cleanLong(x.url, 1200),
        title: clean(x.pageTitle),
        fullMatchingImages: (x.fullMatchingImages || []).map(y => cleanLong(y.url, 1200)).filter(Boolean).slice(0, 5),
        partialMatchingImages: (x.partialMatchingImages || []).map(y => cleanLong(y.url, 1200)).filter(Boolean).slice(0, 5),
      })).filter(x => x.url).slice(0, 20),
      fullMatchingImages: (web.fullMatchingImages || []).map(x => cleanLong(x.url, 1200)).filter(Boolean).slice(0, 20),
      partialMatchingImages: (web.partialMatchingImages || []).map(x => cleanLong(x.url, 1200)).filter(Boolean).slice(0, 20),
      visuallySimilarImages: (web.visuallySimilarImages || []).map(x => cleanLong(x.url, 1200)).filter(Boolean).slice(0, 20),
    },
  };
}

function googleWebStrength(read) {
  const w = read?.web || {};
  let score = 0;
  if ((w.fullMatchingImages || []).length) score += 3;
  if ((w.pages || []).length) score += 2;
  if ((w.partialMatchingImages || []).length) score += 1;
  if ((w.bestGuessLabels || []).length) score += 1;
  return score;
}

function combineGoogleEvidence(initial, backWebFallback) {
  const front = structuredClone(initial.front || { side: 'front', fullText: '', lines: [], web: {} });
  const back = structuredClone(initial.back || { side: 'back', fullText: '', lines: [], web: {} });
  if (backWebFallback?.web) back.web = backWebFallback.web;
  return { front, back, backWebFallbackUsed: Boolean(backWebFallback) };
}

function googlePublicSummary(g) {
  const summarize = r => ({
    ocrText: cleanLong(r?.fullText || '', 1600),
    bestGuessLabels: r?.web?.bestGuessLabels || [],
    webEntities: (r?.web?.entities || []).slice(0, 8),
    matchingPages: (r?.web?.pages || []).slice(0, 8).map(x => ({ title: x.title, url: x.url })),
    fullMatchCount: (r?.web?.fullMatchingImages || []).length,
    partialMatchCount: (r?.web?.partialMatchingImages || []).length,
  });
  return { configured: true, used: true, backWebFallbackUsed: g.backWebFallbackUsed, front: summarize(g.front), back: summarize(g.back) };
}

function allGoogleText(g) {
  return [g?.front?.fullText, g?.back?.fullText].filter(Boolean).join('\n');
}

function allGoogleWebText(g) {
  const parts = [];
  for (const r of [g?.front, g?.back]) {
    const w = r?.web || {};
    parts.push(...(w.bestGuessLabels || []));
    parts.push(...(w.entities || []).map(x => x.description));
    parts.push(...(w.pages || []).map(x => `${x.title || ''} ${x.url || ''}`));
  }
  return parts.filter(Boolean).join(' | ');
}


function normalizeLooseToken(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isDateLikeCardCode(v) {
  const s = String(v || '').trim();
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(s)) return true;
  if (/^\d{2}[-/.]\d{2}[-/.]\d{2}$/.test(s)) return true;
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s)) return true;
  return false;
}

function exactTokenPresent(text, token) {
  const t=String(text||'').toUpperCase();
  const raw=String(token||'').toUpperCase().trim();
  if (!raw) return false;
  const pattern=escapeRegex(raw).replace(/[-\s]+/g,'[-\\s#]*');
  return new RegExp(`(^|[^A-Z0-9])${pattern}($|[^A-Z0-9])`,'i').test(t);
}

function extractCardCandidates(text) {
  const raw = String(text || '').toUpperCase();
  const out = new Map();
  const add = (v, baseScore, index = 0) => {
    v = String(v || '').replace(/^#/, '').trim().replace(/[),.;:]+$/,'');
    if (!v || v.length > 24 || !/[0-9]/.test(v)) return;
    if (/^(19|20)\d{2}$/.test(v) || isDateLikeCardCode(v)) return;
    if (/^\d{1,2}$/.test(v) && baseScore<100) return;
    const before = raw.slice(Math.max(0,index-42),index);
    const after = raw.slice(index+String(v).length,Math.min(raw.length,index+String(v).length+42));
    const ctx = `${before} ${after}`;
    let score = baseScore;
    if (/(?:CARD\s*(?:NO\.?|NUMBER|#)|NO\.?\s*#?)\s*[:#-]?\s*$/i.test(before)) score += 35;
    if (/\b(?:DOB|BORN|BIRTH|BIRTHDAY|DATE OF BIRTH|HT|HEIGHT|WT|WEIGHT)\b/i.test(ctx) && !/[A-Z]/.test(v) && baseScore<100) score -= 180;
    if (/\b(?:STATS?|STATISTICS|REC|YDS|AVG|TD|SEASON)\b/i.test(ctx) && !/[A-Z]/.test(v) && baseScore<100) score -= 80;
    if (/^[0-9-]+$/.test(v) && v.includes('-')) return; // dates/stat strings, not normal card codes
    if (!/[A-Z]/.test(v) && !/(?:CARD\s*(?:NO\.?|NUMBER|#)|NO\.?\s*#?)/i.test(before)) score -= 35;
    if (score < 40) return;
    const old = out.get(v);
    if (!old || old.score < score) out.set(v, { value:v, score, context:cleanLong(ctx.replace(/\s+/g,' '),130) });
  };

  const patterns = [
    { re:/\b[A-Z0-9]{1,10}-[A-Z0-9]{1,10}(?:-[A-Z0-9]{1,8})?\b/g, score:145 },
    { re:/\b(?=[A-Z0-9]{3,16}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{3,16}\b/g, score:85 },
  ];
  for (const {re,score} of patterns) {
    let m;
    while ((m = re.exec(raw))) add(m[0],score,m.index);
  }
  const contextual = /(?:CARD\s*(?:NO\.?|NUMBER|#)|NO\.?\s*#?)\s*[:#-]?\s*([A-Z0-9-]{1,18})/gi;
  let m;
  while ((m=contextual.exec(raw))) add(m[1],125,m.index + m[0].indexOf(m[1]));
  const numericContext = /(?:CARD\s*(?:NO\.?|NUMBER|#)|NO\.?\s*#?)\s*[:#-]?\s*([0-9]{1,4})\b/gi;
  while ((m=numericContext.exec(raw))) add(m[1],115,m.index + m[0].indexOf(m[1]));
  const hashNumeric = /#\s*([0-9]{1,4})\b/g;
  while ((m=hashNumeric.exec(raw))) add(m[1],108,m.index + m[0].indexOf(m[1]));
  return [...out.values()].sort((a,b)=>b.score-a.score || b.value.length-a.value.length).slice(0,12);
}

function detectBrandFromText(text) {
  const t = String(text || '');
  const brands = ['Topps','Panini','Bowman','Upper Deck','Fleer','Donruss','Score','Leaf','O-Pee-Chee','SkyBox','Pacific'];
  for (const b of brands) if (new RegExp(`\\b${escapeRegex(b).replace(/\\ /g,'\\s+')}\\b`, 'i').test(t)) return b;
  return null;
}

function extractYearsWithContext(text) {
  const raw = String(text || '');
  const years = [];
  const re = /\b((?:19|20)\d{2})\b/g;
  let m;
  while ((m = re.exec(raw))) {
    const year = Number(m[1]);
    const before = raw.slice(Math.max(0, m.index - 50), m.index).toLowerCase();
    const after = raw.slice(m.index + 4, Math.min(raw.length, m.index + 65)).toLowerCase();
    const nearBefore = raw.slice(Math.max(0, m.index - 20), m.index).toLowerCase();
    const nearAfter = raw.slice(m.index + 4, Math.min(raw.length, m.index + 42)).toLowerCase();
    const ctx = `${before} ${after}`;
    let role = 'unknown';
    if (/(?:©|copyright|\bcopr\b)\s*$/.test(nearBefore) || /^\s*(?:copyright|all rights reserved|the .* company|topps|panini|upper deck)/.test(nearAfter)) role = 'copyright';
    // Prefer a birth marker immediately before the year over wider nearby stats text.
    else if (/(?:born|birth|dob)[^0-9]{0,12}$/.test(nearBefore)) role = 'birth';
    else if (/stats?|statistics|receiving|passing|rushing|season|career/.test(`${nearBefore} ${nearAfter}`)) role = 'stats';
    else if (/born|birth|dob/.test(`${nearBefore} ${nearAfter}`)) role = 'birth';
    else if (/draft/.test(`${nearBefore} ${nearAfter}`)) role = 'draft';
    else if (/anniversary|retro|throwback|design/.test(`${nearBefore} ${nearAfter}`)) role = 'design';
    else if (/all rights reserved|printed in|manufactured by/.test(nearAfter)) role = 'copyright';
    years.push({ year, role, context: cleanLong(ctx.replace(/\s+/g,' '), 150) });
  }
  return years.slice(0, 20);
}

function extractSerialNumber(text) {
  const raw = String(text || '');
  const hits = [];
  for (const m of raw.matchAll(/\b(?:SN\s*)?(\d{1,4})\s*\/\s*(\d{1,5})\b/gi)) {
    const n=Number(m[1]), total=Number(m[2]);
    if (total > 1 && n >= 0 && n <= total) hits.push({value:`${n}/${total}`,total,index:m.index||0});
  }
  return hits.sort((a,b)=>a.total-b.total)[0]?.value || null;
}

function provisionalFromGoogle(g) {
  const ocr = allGoogleText(g);
  const web = allGoogleWebText(g);
  const ocrCandidates = extractCardCandidates(`${g?.back?.fullText || ''}\n${g?.front?.fullText || ''}`);
  const webCandidates = extractCardCandidates(web);
  const candidates = [...ocrCandidates];
  for (const x of webCandidates) if (!candidates.some(y=>normalizeLooseToken(y.value)===normalizeLooseToken(x.value))) candidates.push({...x,score:x.score-10});
  candidates.sort((a,b)=>b.score-a.score);
  const brand = normalizeBrand(detectBrandFromText(`${ocr}\n${web}`));
  const years = extractYearsWithContext(ocr);
  const copyrightYears = years.filter(x => x.role === 'copyright').map(x => x.year);
  const bestGuess = [...(g?.front?.web?.bestGuessLabels || []), ...(g?.back?.web?.bestGuessLabels || [])][0] || null;
  return {
    year: copyrightYears.length ? Math.max(...copyrightYears) : null,
    brand,
    set: null,
    subject: null,
    cardNo: candidates[0]?.value || null,
    cardCandidates:candidates.slice(0,6),
    variation: null,
    team: null,
    category: null,
    years,
    bestGuess,
    serialNumber: extractSerialNumber(ocr),
  };
}

function collectGooglePages(g) {
  const pages = [];
  const seen = new Set();
  for (const [side, r] of [['front',g?.front],['back',g?.back]]) {
    for (const p of r?.web?.pages || []) {
      const key = p.url || p.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      pages.push({ side, title:p.title, url:p.url, fullMatches:(p.fullMatchingImages||[]).length, partialMatches:(p.partialMatchingImages||[]).length, trustTier:domainTrust(p.url) });
    }
  }
  return pages.slice(0, 24);
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./,''); } catch { return ''; }
}
function hostMatches(host, domain) { return host === domain || host.endsWith(`.${domain}`); }
function domainTrust(url) {
  const h=hostnameOf(url);
  if (OFFICIAL_DOMAINS.some(d=>hostMatches(h,d))) return 4;
  if (STRONG_REFERENCE_DOMAINS.some(d=>hostMatches(h,d))) return 3;
  if (hostMatches(h,'sportscardspro.com')) return 2;
  if (hostMatches(h,'ebay.com')) return 1;
  return 0;
}

function sourceEvidence(result, cardCode) {
  const text = `${result.title||''} ${result.content||''}`;
  const exactCode = cardCode ? exactTokenPresent(text,cardCode) : false;
  return {...result, trustTier:domainTrust(result.url), exactCode, domain:hostnameOf(result.url)};
}

function extractSubjectFromTitle(title, cardNo, brand) {
  let t=String(title||'').replace(/<[^>]+>/g,' ').replace(/&[^;\s]+;/g,' ');
  if (cardNo) t=t.replace(new RegExp(`(^|[^A-Z0-9])${escapeRegex(cardNo).replace(/[-\s]+/g,'[-\\\\s#]*')}($|[^A-Z0-9])`,'ig'),' ');
  if (brand) t=t.replace(new RegExp(`\\b${escapeRegex(brand)}\\b`,'ig'),' ');
  t=t.replace(/\b(?:19|20)\d{2}\b/g,' ')
     .replace(/\b(?:topps|panini|bowman|upper deck|donruss|score|leaf|flagship|chrome|prizm|football|baseball|basketball|hockey|soccer|trading|sports?|cards?|checklist|prices?|price|anniversary|refractor|parallel)\b/ig,' ')
     .replace(/\s*[|–—:]\s*(?:eBay|Beckett|PSA|TCDB|Trading Card Database).*$/i,' ')
     .replace(/[#()[\]{}]/g,' ').replace(/\s+/g,' ').trim();
  const chunks=t.split(/\s*[-–—|]\s*/).map(x=>x.trim()).filter(Boolean);
  for (const c of chunks) {
    const words=c.split(/\s+/).filter(Boolean);
    if (words.length>=2 && words.length<=5 && c.length<=60 && !/\b(?:insert|set|series|rookie|rc)\b/i.test(c)) return c;
  }
  const words=t.split(/\s+/).filter(Boolean);
  return words.length>=2&&words.length<=5&&t.length<=60?t:null;
}

function likelySubjectFromGoogle(google, cardCode) {
  const pages=collectGooglePages(google);
  for (const p of pages) {
    const t=String(p.title||'');
    if (cardCode && !exactTokenPresent(t,cardCode)) continue;
    const s=extractSubjectFromTitle(t,cardCode,detectBrandFromText(t));
    if (s) return s;
  }
  const labels=[...(google?.front?.web?.bestGuessLabels||[]),...(google?.back?.web?.bestGuessLabels||[])];
  for (const t of labels) {
    const s=extractSubjectFromTitle(t,cardCode,detectBrandFromText(t));
    if (s) return s;
  }
  return null;
}

async function trustedCardLookup(env, provisional, google) {
  const candidates = (provisional.cardCandidates || []).slice(0,3);
  const brand = provisional.brand || '';
  const likelySubject = likelySubjectFromGoogle(google,candidates[0]?.value);
  const queries=[];
  const merged=new Map();

  for (const cand of candidates) {
    const q=[`"${cand.value}"`, likelySubject?`"${likelySubject}"`:'', brand, 'trading card checklist'].filter(Boolean).join(' ');
    queries.push(q);
    const batch=await tavilySearch(env,q,10,TRUSTED_CARD_DOMAINS);
    for (const x of batch.results||[]) {
      const y=sourceEvidence(x,cand.value);
      const key=y.url||`${y.title}|${y.content}`;
      if (!merged.has(key) || (merged.get(key).score||0)<(y.score||0)) merged.set(key,y);
    }
    const exactStrong=[...merged.values()].filter(x=>x.exactCode&&x.trustTier>=3);
    const domains=new Set(exactStrong.map(x=>x.domain));
    if (domains.size>=2 || exactStrong.some(x=>x.trustTier===4)) break;
  }

  if (!merged.size) {
    const title=collectGooglePages(google)[0]?.title || provisional.bestGuess || '';
    if (title) {
      const q=`${title} trading card checklist`;
      queries.push(q);
      const batch=await tavilySearch(env,q,10,TRUSTED_CARD_DOMAINS);
      for (const x of batch.results||[]) merged.set(x.url||x.title,sourceEvidence(x,provisional.cardNo));
    }
  }

  const results=[...merged.values()].sort((a,b)=>{
    const at=(a.trustTier||0)*100+(a.exactCode?70:0)+(a.score||0)*10;
    const bt=(b.trustTier||0)*100+(b.exactCode?70:0)+(b.score||0)*10;
    return bt-at;
  }).slice(0,18);
  return {configured:true,used:true,query:queries[0]||'',queries,answer:null,results};
}

async function resolveIdentityFromSources(env, google, provisional, webLookup) {
  const candidates=(provisional.cardCandidates||[]).slice(0,5);
  const trusted=(webLookup?.results||[]).map(x=>sourceEvidence(x,provisional.cardNo));
  const pages=collectGooglePages(google);
  let selectedCode=null;
  let selectedScore=-Infinity;

  for (const c of candidates) {
    const exact=trusted.filter(x=>exactTokenPresent(`${x.title||''} ${x.content||''}`,c.value));
    const unique=new Set(exact.map(x=>x.domain));
    const tierPoints=exact.reduce((sum,x)=>sum+(x.trustTier>=4?5:x.trustTier===3?4:x.trustTier===2?2:0),0);
    const gp=pages.filter(p=>exactTokenPresent(p.title||'',c.value));
    const score=c.score + tierPoints*30 + unique.size*25 + gp.reduce((z,p)=>z+(p.fullMatches?25:p.partialMatches?8:3),0);
    if (score>selectedScore){selectedScore=score;selectedCode=c.value;}
  }
  if (!selectedCode) selectedCode=provisional.cardNo;

  const exactSources=trusted.filter(x=>selectedCode&&exactTokenPresent(`${x.title||''} ${x.content||''}`,selectedCode));
  const exactGooglePages=pages.filter(x=>selectedCode&&exactTokenPresent(x.title||'',selectedCode));
  const evidenceBundle={
    selectedCardCode:selectedCode,
    serialNumber:provisional.serialNumber,
    ocrFront:cleanLong(google.front?.fullText||'',4200),
    ocrBack:cleanLong(google.back?.fullText||'',5200),
    exactTrustedSources:exactSources.slice(0,10).map((x,i)=>({index:i,title:x.title,url:x.url,content:x.content,trustTier:x.trustTier})),
    googleMatchingPages:exactGooglePages.slice(0,8),
    googleBestGuess:[...(google.front?.web?.bestGuessLabels||[]),...(google.back?.web?.bestGuessLabels||[])].slice(0,6),
  };

  let parsed={};
  if (exactSources.length && env.AI) {
    const prompt=`Extract the identity of ONE trading card using ONLY the listed source evidence. The source pages, not OCR guesses, are the authority. Return one JSON object only.

Rules:
- cardNo must be exactly the selectedCardCode if the sources support it.
- year must be the product/release year shown by a trusted source, never a birth/statistics/design year.
- set must preserve the actual product/set/insert wording from the sources.
- subject is the player/character/person on that exact card number.
- variation must be null unless the sources or matching-page evidence specifically identify a parallel/variation that matches the photographed card. Do not infer a color parallel from generic artwork.
- team may be null.
- category is Sports, TCG, Non-sport, Other, or null.
- source_indices must name only exactTrustedSources entries actually supporting the identity.

EVIDENCE:
${JSON.stringify(evidenceBundle)}

RETURN:
{"year":number|null,"brand":string|null,"set":string|null,"subject":string|null,"cardNo":string|null,"variation":string|null,"team":string|null,"category":"Sports|TCG|Non-sport|Other|null","source_indices":[number]}`;
    try {
      const raw=await env.AI.run(TEXT_MODEL,{messages:[
        {role:'system',content:'You extract structured trading-card identity only from supplied source evidence. Never invent fields.'},
        {role:'user',content:prompt}
      ],response_format:{type:'json_object'},temperature:0,max_tokens:900,stream:false});
      parsed=structuredModelResult(raw,'source identity extractor')||{};
    } catch(e) { console.warn('Source identity extraction:',e); parsed={}; }
  }

  const identity={
    year:validYear(parsed.year),
    brand:normalizeBrand(parsed.brand||provisional.brand),
    set:clean(parsed.set),
    subject:clean(parsed.subject),
    cardNo:clean(parsed.cardNo)?.replace(/^#/,'')||selectedCode||null,
    variation:clean(parsed.variation),
    team:clean(parsed.team),
    category:['Sports','TCG','Non-sport','Other'].includes(parsed.category)?parsed.category:(/\b(football|baseball|basketball|hockey|soccer|nfl|nba|mlb|nhl)\b/i.test(exactSources.map(x=>`${x.title||''} ${x.content||''}`).join(' '))?'Sports':'Other'),
  };

  if (selectedCode && normalizeLooseToken(identity.cardNo)!==normalizeLooseToken(selectedCode)) identity.cardNo=selectedCode;

  const sourceIdx=Array.isArray(parsed.source_indices)?parsed.source_indices.map(Number).filter(Number.isInteger):[];
  const used=sourceIdx.map(i=>exactSources[i]).filter(Boolean);
  const supporting=used.length?used:exactSources;
  const sourceTexts=supporting.map(x=>`${x.title||''} ${x.content||''}`);
  if (identity.subject && !sourceTexts.some(t=>containsSubject(t,identity.subject))) identity.subject=null;
  if (identity.year && !sourceTexts.some(t=>new RegExp(`\\b${identity.year}\\b`).test(t))) identity.year=null;
  if (identity.set && !sourceTexts.some(t=>containsSet(t,identity.set))) identity.set=null;
  if (identity.variation && !sourceTexts.some(t=>containsVariation(t,identity.variation)) && !exactGooglePages.some(p=>containsVariation(p.title||'',identity.variation))) identity.variation=null;

  const uniqueStrongDomains=new Set(exactSources.filter(x=>x.trustTier>=3).map(x=>x.domain));
  const officialCount=exactSources.filter(x=>x.trustTier===4).length;
  const strongCount=exactSources.filter(x=>x.trustTier>=3).length;
  const googleFull=exactGooglePages.reduce((n,p)=>n+(p.fullMatches||0),0);
  const subjectSupported=Boolean(identity.subject && exactSources.some(x=>containsSubject(`${x.title||''} ${x.content||''}`,identity.subject)));
  const yearSupported=Boolean(identity.year && exactSources.some(x=>new RegExp(`\\b${identity.year}\\b`).test(`${x.title||''} ${x.content||''}`)));
  const setSupported=Boolean(identity.set && exactSources.some(x=>containsSet(`${x.title||''} ${x.content||''}`,identity.set)));
  const codeSupported=Boolean(identity.cardNo && exactSources.some(x=>exactTokenPresent(`${x.title||''} ${x.content||''}`,identity.cardNo)));

  let verification_status='unverified';
  if (codeSupported && subjectSupported && yearSupported && setSupported && (uniqueStrongDomains.size>=2 || (officialCount>=1 && strongCount>=1))) verification_status='verified';
  else if (codeSupported && subjectSupported && setSupported && strongCount>=1) verification_status='probable';

  let confidence=20;
  if (codeSupported) confidence+=30;
  if (subjectSupported) confidence+=18;
  if (yearSupported) confidence+=10;
  if (setSupported) confidence+=8;
  confidence+=Math.min(16,uniqueStrongDomains.size*8);
  confidence+=Math.min(8,officialCount*8);
  if (googleFull>0) confidence+=5;
  if (identity.set) confidence+=5;
  if (verification_status==='unverified') confidence=Math.min(confidence,69);
  if (verification_status==='probable') confidence=Math.min(confidence,84);
  if (verification_status==='verified') confidence=Math.max(confidence,90);
  confidence=clamp(Math.round(confidence),0,99);

  const sources=exactSources.slice(0,10).map(x=>({title:x.title,url:x.url,domain:x.domain,trustTier:x.trustTier,exactCardCode:true}));
  const evidence=[];
  if (codeSupported) evidence.push(`Exact card code ${identity.cardNo} found in trusted online source${uniqueStrongDomains.size===1?'':'s'}.`);
  if (subjectSupported) evidence.push(`Trusted sources tie ${identity.subject} to ${identity.cardNo}.`);
  if (yearSupported) evidence.push(`Product year ${identity.year} is sourced online rather than inferred from card statistics.`);
  if (setSupported) evidence.push(`Set/insert identity is supported by the trusted exact-card sources.`);
  if (uniqueStrongDomains.size>=2) evidence.push(`${uniqueStrongDomains.size} independent established source domains agree on the exact card.`);
  if (provisional.serialNumber) evidence.push(`Serial-number text detected on the card: ${provisional.serialNumber}.`);

  let reviewReason=null;
  if (verification_status==='unverified') reviewReason='Exact identity could not be established from trusted online sources.';
  else if (verification_status==='probable') reviewReason='Only one strong trusted-source path confirmed the exact card; additional corroboration is recommended.';

  return {
    identity,
    identity_confidence:confidence,
    verification_status,
    evidence,
    sources,
    needs_review:verification_status!=='verified',
    review_reason:reviewReason,
    selected_card_code:selectedCode,
    serial_number:provisional.serialNumber,
  };
}

function containsSubject(text, subject) {
  const words=String(subject||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(x=>x.length>1);
  const t=String(text||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ');
  if (!words.length) return false;
  const need=words.length<=2?words.length:Math.max(2,words.length-1);
  return words.filter(w=>new RegExp(`\\b${escapeRegex(w)}\\b`,'i').test(t)).length>=need;
}
function containsSet(text, setName) {
  const raw=String(setName||'').trim();
  if (!raw) return false;
  const t=normalizeTitle(text), s=normalizeTitle(raw);
  if (!s) return false;
  if (t.includes(s)) return true;
  const stop=new Set(['topps','panini','upper','deck','cards','card','trading','sports','football','baseball','basketball','hockey','soccer']);
  const words=s.split(' ').filter(w=>w.length>2&&!stop.has(w));
  if (!words.length) return false;
  const hits=words.filter(w=>new RegExp(`\\b${escapeRegex(w)}\\b`,'i').test(t)).length;
  return hits>=Math.max(1,Math.ceil(words.length*.8));
}

function containsVariation(text, variation) {
  const v=String(variation||'').toLowerCase().trim();
  if (!v || /^base(?:\b|$)/.test(v)) return /\bbase\b/i.test(String(text||''));
  const words=v.replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(x=>x.length>2 && !['card','parallel','variation'].includes(x));
  if (!words.length) return false;
  const t=String(text||'').toLowerCase();
  return words.every(w=>t.includes(w));
}

function sanitizeLockedIdentity(obj) {
  if (!obj || typeof obj!=='object') return null;
  const year=validYear(obj.year), set=clean(obj.set), subject=clean(obj.subject), cardNo=clean(obj.cardNo)?.replace(/^#/,'')||null;
  if (!year || !set || !subject || !cardNo) return null;
  return {
    year,
    brand:normalizeBrand(obj.brand),
    set,
    subject,
    cardNo,
    variation:clean(obj.variation),
    team:clean(obj.team),
    category:['Sports','TCG','Non-sport','Other'].includes(obj.category)?obj.category:'Other',
  };
}

function identityMarketReady(analysis) {
  const i=analysis?.identity||{};
  return Boolean(i.year && i.set && i.subject && i.cardNo && ['verified','locked'].includes(analysis?.verification_status));
}


async function inspectConditionSide(env, side, image) {
  const primaryQuestion = `Inspect ONLY the visible physical condition of the ${side} of one raw trading card.

Return SIMPLE KEY=VALUE lines, no markdown. If a category cannot be judged reliably from this single photo, use UNKNOWN rather than guessing.

Scores are 1-10 in 0.5 increments:
- 10 = no visible defect at this photo's resolution
- 9-9.5 = minute visible issue
- 8-8.5 = minor visible issue
- 7-7.5 = clearly visible moderate issue
- below 7 requires a clearly visible named defect; otherwise UNKNOWN

Also estimate PRINT CENTERING only if a clear printed border/design frame can be distinguished from the physical card edge. If not, use UNKNOWN.
CENTER_LR is left/right percentage, e.g. 55/45.
CENTER_TB is top/bottom percentage, e.g. 52/48.
CENTER_CONFIDENCE is 0-100.

Use exactly:
CORNERS=
EDGES=
SURFACE=
FOCUS=
DEFECTS=
CONFIDENCE=
CENTER_LR=
CENTER_TB=
CENTER_CONFIDENCE=
NOTES=

DEFECTS: comma-separated only from crease,dent,stain,scratch,printline,mark,possible_alteration, or NONE.
FOCUS is print/focus/registration quality visible on the card, not camera sharpness.
CONFIDENCE is 0-100 for how reliably this photo supports the condition scores.
NOTES must briefly name visible evidence for any score below 9.`;

  const fallbackQuestion = `Inspect this ${side} trading-card photo. Return ONLY these KEY=VALUE lines:
CORNERS=
EDGES=
SURFACE=
FOCUS=
DEFECTS=
CONFIDENCE=
CENTER_LR=
CENTER_TB=
CENTER_CONFIDENCE=
NOTES=
Use 1-10 scores in 0.5 increments or UNKNOWN. Do not invent defects. DEFECTS is NONE or crease,dent,stain,scratch,printline,mark,possible_alteration. Centering is printed-design centering only, formatted like 55/45, or UNKNOWN.`;

  try {
    const raw = await env.AI.run(CONDITION_MODEL, {
      task:'query', image, question:primaryQuestion, reasoning:true, temperature:0, max_tokens:1100, stream:false,
    });
    let parsed=parseConditionKV(modelText(raw),side);
    if (conditionCompleteness(parsed) >= 4 && parsed.confidence >= 30) return parsed;

    const retry = await env.AI.run(CONDITION_MODEL, {
      task:'query', image, question:fallbackQuestion, reasoning:false, temperature:0, max_tokens:700, stream:false,
    });
    const second=parseConditionKV(modelText(retry),side);
    if (conditionCompleteness(second) > conditionCompleteness(parsed) || second.confidence > parsed.confidence) {
      second.notes.unshift('Condition model required one automatic retry for a complete response.');
      parsed=second;
    }
    return parsed;
  } catch (e) {
    return unknownConditionSide(side, `Condition model unavailable: ${cleanError(e)}`);
  }
}

function parsePair(v) {
  const m=String(v||'').match(/(\d{1,3}(?:\.\d+)?)\s*[/:\-]\s*(\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  let a=Number(m[1]), b=Number(m[2]);
  if (!(a>0&&b>0)) return null;
  const total=a+b;
  if (total<95 || total>105) { a=a/total*100; b=b/total*100; }
  if (a<5||b<5||a>95||b>95) return null;
  return [+a.toFixed(1),+b.toFixed(1)];
}

function parseConditionKV(text, side) {
  const vals = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const m = rawLine.trim().replace(/^[-*]\s*/, '').match(/^([A-Z_]+)\s*[:=]\s*(.*)$/i);
    if (m) vals[m[1].toUpperCase()] = m[2].trim();
  }
  const value = k => {
    const v = vals[k];
    if (!v || /^(unknown|null|n\/a)$/i.test(v)) return null;
    return v;
  };
  const score = k => {
    const m = String(value(k) || '').match(/\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return n >= 1 && n <= 10 ? clampHalf(n,1,10) : null;
  };
  const defectText = String(value('DEFECTS') || '').toLowerCase();
  const has = k => defectText && !/\bnone\b/.test(defectText) && new RegExp(`\\b${k.replace('_','[_ -]?')}\\b`,'i').test(defectText);
  const centerLR=parsePair(value('CENTER_LR'));
  const centerTB=parsePair(value('CENTER_TB'));
  const centerConf=clamp(Math.round(Number(String(value('CENTER_CONFIDENCE')||'').match(/\d+(?:\.\d+)?/)?.[0]) || 0),0,100);
  const out = {
    side,
    corners:score('CORNERS'), edges:score('EDGES'), surface:score('SURFACE'), focus:score('FOCUS'),
    defects:{crease:has('crease'),dent:has('dent'),stain:has('stain'),scratch:has('scratch'),printline:has('printline'),mark:has('mark'),possible_alteration:has('possible_alteration')},
    confidence:clamp(Math.round(Number(String(value('CONFIDENCE')||'').match(/\d+(?:\.\d+)?/)?.[0]) || 0),0,100),
    centering:{lr:centerLR,tb:centerTB,confidence:centerLR&&centerTB?centerConf:0},
    notes:String(value('NOTES')||'').split(/\s*;\s*|\s*\|\s*/).map(clean).filter(Boolean).slice(0,6),
  };
  const scored=['corners','edges','surface','focus'].map(k=>out[k]).filter(Number.isFinite);
  const anyDefect=Object.values(out.defects).some(Boolean);
  if (scored.length===4 && scored.every(v=>v===1) && !anyDefect) {
    out.corners=out.edges=out.surface=out.focus=null;
    out.confidence=Math.min(out.confidence||30,30);
    out.notes.push('Condition scores withheld because the model output was internally inconsistent.');
  }
  for (const k of ['corners','edges','surface','focus']) {
    if (Number.isFinite(out[k]) && out[k]<7 && !anyDefect && !out.notes.length) out[k]=null;
  }
  return out;
}

function conditionCompleteness(x) {
  return ['corners','edges','surface','focus'].filter(k=>Number.isFinite(Number(x?.[k]))).length;
}

function unknownConditionSide(side, note) {
  return {
    side,corners:null,edges:null,surface:null,focus:null,
    defects:{crease:false,dent:false,stain:false,scratch:false,printline:false,mark:false,possible_alteration:false},
    confidence:0,centering:{lr:null,tb:null,confidence:0},notes:[note]
  };
}

function combineCondition(front, back) {
  const worse = k => {
    const vals=[front?.[k],back?.[k]].map(Number).filter(Number.isFinite);
    return vals.length===2?clampHalf(Math.min(...vals),1,10):null;
  };
  const defects={};
  for (const k of ['crease','dent','stain','scratch','printline','mark','possible_alteration']) defects[k]=Boolean(front?.defects?.[k]||back?.defects?.[k]);
  const confs=[front?.confidence,back?.confidence].map(Number).filter(Number.isFinite);
  let confidence=confs.length===2?Math.round((confs[0]+confs[1])/2):0;
  const scores=['corners','edges','surface','focus'].map(worse);
  if (scores.some(v=>!Number.isFinite(v))) confidence=Math.min(confidence,40);
  return {
    corners:worse('corners'),edges:worse('edges'),surface:worse('surface'),focus:worse('focus'),
    defects,
    confidence:clamp(confidence,0,95),
    notes:Array.from(new Set([...(front?.notes||[]).map(x=>`Front: ${x}`),...(back?.notes||[]).map(x=>`Back: ${x}`),'Condition combines the worse visible front/back result; microscopic or hidden defects cannot be ruled out from phone photos.'])).slice(0,10),
    sides:{front,back},
  };
}


async function tavilyCardLookup(env, provisional, google) {
  return trustedCardLookup(env, provisional, google);
}

async function tavilySearch(env, query, maxResults = 8, includeDomains = null) {
  const body={query,topic:'general',search_depth:'basic',max_results:maxResults,include_answer:false,include_raw_content:false,include_images:false};
  if (includeDomains?.length) body.include_domains=includeDomains;
  const r=await fetch('https://api.tavily.com/search',{
    method:'POST',
    headers:{'Authorization':`Bearer ${env.TAVILY_API_KEY}`,'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify(body),
  });
  if (!r.ok) {
    const t=await r.text().catch(()=> '');
    throw new Error(`Tavily search ${r.status}${t?`: ${t.slice(0,180)}`:''}`);
  }
  const j=await r.json();
  return {answer:clean(j.answer),results:(j.results||[]).map(x=>({title:clean(x.title),url:cleanLong(x.url,1200),content:cleanLong(x.content,1200),score:Number(x.score)||0}))};
}

function buildQuery(i={}) {
  return [i.year,i.set,i.subject,i.cardNo,i.variation && !/^base\b/i.test(i.variation)?i.variation:null].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
}
function ebaySearchUrl(query) { return query ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}` : 'https://www.ebay.com/'; }

function emptyMarket(identity={}) {
  const query=buildQuery(identity);
  return {
    configured:false,live:false,items:[],rawItems:[],gradedItems:[],query,searchUrl:ebaySearchUrl(query),
    source:'none',stats:{raw:null,graded:null},refreshedAt:new Date().toISOString(),ebay:{configured:false,items:[],query,searchUrl:ebaySearchUrl(query)}
  };
}

async function getMarket(env, identity, frontImage=null) {
  const query=buildQuery(identity);
  const searchUrl=ebaySearchUrl(query);
  if (!query) return emptyMarket(identity);

  if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
    const token=await getEbayToken(env);
    const keywordPromise=ebayKeywordSearchWithToken(env,token,identity);
    const imagePromise=frontImage?ebayImageSearchWithToken(env,token,frontImage).catch(e=>({items:[],error:cleanError(e)})):Promise.resolve({items:[]});
    const [keyword,image]=await Promise.all([keywordPromise,imagePromise]);
    const combined=combineEbayResults(identity,keyword.items||[],image.items||[]);
    const rawItems=combined.filter(x=>x.kind==='raw').slice(0,12);
    const gradedItems=combined.filter(x=>x.kind==='graded').slice(0,12);
    const items=combined.slice(0,16);
    const market={
      configured:true,live:true,items,rawItems,gradedItems,query,searchUrl,source:'eBay Browse API',environment:ebayEnvironment(env),
      stats:{raw:marketStats(rawItems),graded:marketStats(gradedItems)},
      refreshedAt:new Date().toISOString(),
      imageSearchUsed:Boolean(frontImage),
      ebay:{configured:true,environment:ebayEnvironment(env),items,query,searchUrl},
    };
    if (keyword.error) market.keywordError=keyword.error;
    if (image.error) market.imageError=image.error;
    return market;
  }

  if (env.TAVILY_API_KEY) {
    const b=await tavilySearch(env,`${query} eBay`,12,['ebay.com']);
    const items=(b.results||[]).map((x,idx)=>{
      const base={itemId:null,title:x.title,url:x.url,price:extractPrice(`${x.title||''} ${x.content||''}`),currency:'USD',image:null,condition:null,shipping:null,seller:null,buyingOptions:[],source:'web-indexed',imageMatched:false};
      const scored=scoreMarketItem(identity,base,false);
      return {...base,...scored,rank:idx};
    }).filter(x=>x.matchScore>=65).slice(0,10);
    const rawItems=items.filter(x=>x.kind==='raw'),gradedItems=items.filter(x=>x.kind==='graded');
    return {
      configured:true,live:false,items,rawItems,gradedItems,query,searchUrl,
      source:'Web-indexed eBay fallback',
      stats:{raw:marketStats(rawItems),graded:marketStats(gradedItems)},
      refreshedAt:new Date().toISOString(),
      ebay:{configured:false,items:[],query,searchUrl},
      note:'Connect eBay Browse API credentials for authoritative live listing prices and shipping details.',
    };
  }

  return emptyMarket(identity);
}

async function ebayKeywordSearchWithToken(env, token, identity) {
  const query=buildQuery(identity);
  const url=new URL(`${ebayApiBase(env)}/buy/browse/v1/item_summary/search`);
  url.searchParams.set('q',query);
  url.searchParams.set('limit','30');
  const r=await fetch(url,{headers:{'Authorization':`Bearer ${token}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_US','Accept':'application/json'}});
  if (!r.ok) {
    const t=await r.text().catch(()=> '');
    throw new Error(`eBay Browse keyword search ${r.status}${t?`: ${t.slice(0,180)}`:''}`);
  }
  const data=await r.json();
  return {items:(data.itemSummaries||[]).map(mapEbayItem)};
}

async function ebayImageSearchWithToken(env, token, image) {
  const url=new URL(`${ebayApiBase(env)}/buy/browse/v1/item_summary/search_by_image`);
  url.searchParams.set('limit','30');
  const r=await fetch(url,{
    method:'POST',
    headers:{'Authorization':`Bearer ${token}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_US','Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify({image:stripDataUrl(image)}),
  });
  if (!r.ok) {
    const t=await r.text().catch(()=> '');
    throw new Error(`eBay Browse image search ${r.status}${t?`: ${t.slice(0,180)}`:''}`);
  }
  const data=await r.json();
  return {items:(data.itemSummaries||[]).map(mapEbayItem)};
}

function mapEbayItem(x) {
  const shipping=(x.shippingOptions||[]).map(o=>o.shippingCost?.value?Number(o.shippingCost.value):null).filter(Number.isFinite)[0];
  return {
    itemId:x.itemId||null,
    legacyItemId:x.legacyItemId||null,
    title:clean(x.title),
    price:x.price?.value?Number(x.price.value):null,
    currency:x.price?.currency||'USD',
    image:x.image?.imageUrl||null,
    url:x.itemWebUrl||null,
    condition:x.condition||null,
    shipping:Number.isFinite(shipping)?shipping:null,
    seller:x.seller?{username:clean(x.seller.username),feedbackPercentage:Number(x.seller.feedbackPercentage)||null,feedbackScore:Number(x.seller.feedbackScore)||null}:null,
    buyingOptions:Array.isArray(x.buyingOptions)?x.buyingOptions:[],
    itemEndDate:x.itemEndDate||null,
    source:'ebay-api',
    imageMatched:false,
  };
}

function normalizeTitle(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function identitySubjectTokens(subject){return normalizeTitle(subject).split(' ').filter(x=>x.length>1)}
function gradedInfo(title) {
  const t=String(title||'').toUpperCase();
  const m=t.match(/\b(PSA|BGS|BECKETT|CGC|SGC)\s*(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)?\b/);
  if (!m) return {kind:'raw',gradingCompany:null,grade:null};
  const company=m[1]==='BECKETT'?'BGS':m[1];
  return {kind:'graded',gradingCompany:company,grade:m[2]?Number(m[2]):null};
}

function scoreMarketItem(identity,item,imageMatched=false) {
  const title=item.title||'';
  const norm=normalizeTitle(title);
  const code=normalizeLooseToken(identity.cardNo);
  const codeHit=Boolean(code && exactTokenPresent(title,identity.cardNo));
  const st=identitySubjectTokens(identity.subject);
  const subjectHits=st.filter(t=>new RegExp(`\\b${escapeRegex(t)}\\b`,'i').test(norm)).length;
  const subjectOK=st.length?subjectHits>=Math.max(1,Math.min(2,st.length)):false;
  const yearHit=identity.year?new RegExp(`\\b${identity.year}\\b`).test(title):false;
  const bad=/\b(lot of|card lot|break|box|case|pack|blaster|mega box|hobby box|digital|custom|reprint|proxy|you pick|pick your|mystery)\b/i.test(title);
  let score=0;
  if (codeHit) score+=48;
  if (subjectOK) score+=28;
  if (yearHit) score+=7;
  if (imageMatched) score+=18;
  const setWords=normalizeTitle(identity.set).split(' ').filter(w=>w.length>3&&!['football','baseball','basketball','hockey','cards','card'].includes(w));
  score+=Math.min(10,setWords.filter(w=>norm.includes(w)).length*3);
  if (bad) score-=80;

  const expectedVar=String(identity.variation||'').toLowerCase();
  const titleParallel=PARALLEL_WORDS.find(w=>norm.includes(normalizeTitle(w)));
  if (expectedVar && !/^base\b/.test(expectedVar)) {
    const varWords=normalizeTitle(expectedVar).split(' ').filter(w=>w.length>2);
    const varHits=varWords.filter(w=>norm.includes(w)).length;
    if (varWords.length && varHits===0) score-=20; else score+=Math.min(15,varHits*6);
  } else if (titleParallel) {
    score-=25; // unknown/base identity should reject obvious parallels instead of contaminating valuation
  }

  const g=gradedInfo(title);
  return {matchScore:score,codeHit,subjectOK,kind:g.kind,gradingCompany:g.gradingCompany,grade:g.grade};
}

function combineEbayResults(identity, keywordItems, imageItems) {
  const imageIds=new Set(imageItems.map(x=>x.itemId).filter(Boolean));
  const byId=new Map();
  for (const x of [...keywordItems,...imageItems]) {
    const key=x.itemId||x.url||x.title;
    if (!key) continue;
    if (!byId.has(key)) byId.set(key,{...x});
    else {
      const old=byId.get(key);
      byId.set(key,{...old,...x,image:old.image||x.image,url:old.url||x.url});
    }
  }
  const out=[];
  for (const x of byId.values()) {
    const imageMatched=Boolean(x.itemId&&imageIds.has(x.itemId));
    const scored=scoreMarketItem(identity,x,imageMatched);
    const y={...x,...scored,imageMatched};
    if (y.matchScore>=65) out.push(y);
  }
  // Preserve eBay's keyword relevance order as much as possible; only use score to
  // separate clearly stronger exact-card matches from weak tail results.
  const keywordOrder=new Map(keywordItems.map((x,i)=>[x.itemId||x.url||x.title,i]));
  out.sort((a,b)=>{
    const bucketA=a.matchScore>=90?0:a.matchScore>=75?1:2;
    const bucketB=b.matchScore>=90?0:b.matchScore>=75?1:2;
    if (bucketA!==bucketB) return bucketA-bucketB;
    return (keywordOrder.get(a.itemId||a.url||a.title)??999)-(keywordOrder.get(b.itemId||b.url||b.title)??999);
  });
  return out;
}

function marketStats(items) {
  const vals=(items||[]).map(x=>Number(x.price)).filter(v=>Number.isFinite(v)&&v>=0);
  if (!vals.length) return null;
  const sorted=[...vals].sort((a,b)=>a-b);
  const mid=Math.floor(sorted.length/2);
  const median=sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
  return {sampleSize:vals.length,low:+sorted[0].toFixed(2),median:+median.toFixed(2),high:+sorted[sorted.length-1].toFixed(2)};
}

function extractPrice(text) {
  const m=String(text||'').match(/\$\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.\d{2})?)/);
  return m?Number(m[1].replace(/,/g,'')):null;
}

async function ebaySearch(env, query) {
  if (!query) return {configured:Boolean(env.EBAY_CLIENT_ID&&env.EBAY_CLIENT_SECRET),items:[],query};
  const fakeIdentity={year:null,set:'',subject:'',cardNo:'',variation:null};
  const token=await getEbayToken(env);
  const url=new URL(`${ebayApiBase(env)}/buy/browse/v1/item_summary/search`);
  url.searchParams.set('q',query);url.searchParams.set('limit','20');
  const r=await fetch(url,{headers:{'Authorization':`Bearer ${token}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_US','Accept':'application/json'}});
  if(!r.ok)throw new Error(`eBay Browse API ${r.status}`);
  const data=await r.json();
  return {configured:true,environment:ebayEnvironment(env),items:(data.itemSummaries||[]).map(mapEbayItem),query};
}

async function getEbayToken(env) {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error('eBay client credentials are not configured.');
  }

  const base = ebayApiBase(env);
  const cacheKey = `${base}|${env.EBAY_CLIENT_ID}`;
  if (
    ebayTokenCache.token &&
    ebayTokenCache.cacheKey === cacheKey &&
    ebayTokenCache.expiresAt > Date.now() + 60000
  ) return ebayTokenCache.token;

  const basic = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const r = await fetch(`${base}/identity/v1/oauth2/token`, {
    method:'POST',
    headers:{
      'Authorization':`Basic ${basic}`,
      'Content-Type':'application/x-www-form-urlencoded',
      'Accept':'application/json'
    },
    body:'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });
  if(!r.ok){
    const t=await r.text().catch(()=> '');
    throw new Error(`eBay OAuth ${r.status}${t?`: ${t.slice(0,180)}`:''}`);
  }
  const j=await r.json();
  if (!j.access_token) throw new Error('eBay OAuth returned no access token.');
  ebayTokenCache={
    token:j.access_token,
    expiresAt:Date.now()+Number(j.expires_in||7200)*1000,
    cacheKey
  };
  return ebayTokenCache.token;
}

function structuredModelResult(raw,label) {
  if(!raw) throw new Error(`${label} returned no result.`);
  if(raw.response && typeof raw.response==='object' && !Array.isArray(raw.response)) return raw.response;
  if(raw.result && typeof raw.result==='object' && !Array.isArray(raw.result)) return raw.result;
  const msg=raw.choices?.[0]?.message;
  if(msg?.parsed && typeof msg.parsed==='object') return msg.parsed;
  if(typeof msg?.content==='string') return parseModelJSON(msg.content,label);
  if(typeof raw.response==='string') return parseModelJSON(raw.response,label);
  if(typeof raw.answer==='string') return parseModelJSON(raw.answer,label);
  return parseModelJSON(modelText(raw),label);
}
function modelText(raw) {
  if(typeof raw==='string') return raw;
  if(!raw) return '';
  if(typeof raw.answer==='string') return raw.answer;
  if(typeof raw.response==='string') return raw.response;
  if(typeof raw.result==='string') return raw.result;
  const c=raw.choices?.[0]?.message?.content;
  if(typeof c==='string') return c;
  if(Array.isArray(c)) return c.map(x=>x?.text||'').join('\n');
  return JSON.stringify(raw);
}
function parseModelJSON(text,label) {
  if(typeof text!=='string') throw new Error(`${label} returned no text.`);
  const cleaned=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'');
  try{return JSON.parse(cleaned)}catch{}
  const start=cleaned.indexOf('{'),end=cleaned.lastIndexOf('}');
  if(start>=0&&end>start){try{return JSON.parse(cleaned.slice(start,end+1))}catch{}}
  throw new Error(`${label} returned an unreadable response.`);
}

function normalizeBrand(value) {
  const raw=clean(value); if(!raw)return null;
  const brands=['Topps','Panini','Bowman','Upper Deck','Fleer','Donruss','Score','Leaf','O-Pee-Chee','SkyBox','Pacific'];
  const n=normalizeToken(raw);
  for(const b of brands){const bn=normalizeToken(b);if(n===bn)return b;if(Math.abs(n.length-bn.length)<=1&&levenshtein(n,bn)<=2)return b}
  return raw;
}
function normalizeToken(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'').replace(/0/g,'o').replace(/5/g,'s')}
function levenshtein(a,b){const m=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let prev=m[0];m[0]=i;for(let j=1;j<=b.length;j++){const tmp=m[j];m[j]=Math.min(m[j]+1,m[j-1]+1,prev+(a[i-1]===b[j-1]?0:1));prev=tmp}}return m[b.length]}
function validYear(v){const n=Number(v);return Number.isInteger(n)&&n>=1880&&n<=2100?n:null}
function clampHalf(v,min,max){return Math.round(clamp(v,min,max)*2)/2}
function clamp(v,min,max){return Math.max(min,Math.min(max,v))}
function clean(v){return v==null?null:String(v).trim().slice(0,300)||null}
function cleanLong(v,max=3000){return v==null?null:String(v).trim().slice(0,max)||null}
function cleanJoin(a,b){return [clean(a),clean(b)].filter(Boolean).join(' ')}
function cleanError(e){return String(e?.message||e||'Unknown error').slice(0,600)}
function escapeRegex(s){return String(s||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
