const VERSION = '2.0.0';
const DEFAULT_ORIGIN = 'https://darknight909.github.io';
const CONDITION_MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const GOOGLE_VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';

let ebayTokenCache = { token: null, expiresAt: 0 };

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
        workersAIConfigured: Boolean(env.AI),
      }, 200, cors);
    }

    if (origin && origin !== allowedOrigin) return json({ ok: false, error: 'Origin not allowed' }, 403, cors);
    if (!env.CARDLAB_API_KEY) return json({ ok: false, error: 'CARDLAB_API_KEY secret is not configured on the Worker.' }, 500, cors);
    if ((request.headers.get('Authorization') || '') !== `Bearer ${env.CARDLAB_API_KEY}`) return json({ ok: false, error: 'Unauthorized' }, 401, cors);
    if (url.pathname !== '/analyze' || request.method !== 'POST') return json({ ok: false, error: 'Not found' }, 404, cors);

    try {
      if (!env.GOOGLE_VISION_API_KEY) throw new Error('GOOGLE_VISION_API_KEY secret is not configured on the Worker.');

      const body = await request.json();
      const front = validateImage(body.front, 'front');
      const back = validateImage(body.back, 'back');

      // Run the independent photo-analysis paths concurrently. Google Vision is
      // authoritative for OCR + visual-web matching; Workers AI is used only for
      // visible physical-condition assistance.
      const [googleInitial, frontCondition, backCondition] = await Promise.all([
        googleVisionInitial(env, front, back),
        inspectConditionSide(env, 'front', front),
        inspectConditionSide(env, 'back', back),
      ]);

      // If the front image produced little/no visual-web evidence, try Web Detection
      // once on the back. This preserves accuracy without paying for two Web Detection
      // units on every card.
      let backWebFallback = null;
      if (googleWebStrength(googleInitial.front) < 2) {
        try { backWebFallback = await googleVisionWebOnly(env, back); }
        catch (e) { console.warn('Google back Web Detection fallback:', e); }
      }

      const google = combineGoogleEvidence(googleInitial, backWebFallback);
      const provisional = provisionalFromGoogle(google);

      let webLookup = { configured: Boolean(env.TAVILY_API_KEY), used: false, query: '', queries: [], results: [], answer: null };
      if (env.TAVILY_API_KEY) {
        try { webLookup = await tavilyCardLookup(env, provisional, google); }
        catch (e) {
          webLookup = { configured: true, used: true, query: buildLookupQueries(provisional, google)[0] || '', queries: [], results: [], answer: null, error: cleanError(e) };
        }
      }

      let identityResult;
      try { identityResult = await resolveIdentity(env, google, provisional, webLookup); }
      catch (e) {
        console.warn('Identity resolver fallback:', e);
        identityResult = deterministicIdentityFallback(google, provisional, webLookup);
      }
      identityResult = guardResolvedIdentity(identityResult, google, webLookup);

      const condition = combineCondition(frontCondition, backCondition);
      const analysis = {
        identity: identityResult.identity,
        condition,
        identity_confidence: identityResult.identity_confidence,
        condition_confidence: condition.confidence,
        evidence: identityResult.evidence,
        needs_review: identityResult.needs_review,
        review_reason: identityResult.review_reason,
      };

      const query = buildQuery(analysis.identity);
      let ebay = { configured: false, items: [], query };
      if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET && query) {
        try { ebay = await ebaySearch(env, query); }
        catch (e) { ebay = { configured: true, items: [], query, error: cleanError(e) }; }
      }

      let market = { configured: Boolean(env.TAVILY_API_KEY), items: [], query, searchUrl: ebaySearchUrl(query), source: 'none' };
      if (query) {
        if (ebay.configured && ebay.items?.length) {
          market = { configured: true, items: ebay.items.slice(0, 8), query, searchUrl: ebaySearchUrl(query), source: 'eBay Browse API' };
        } else if (env.TAVILY_API_KEY) {
          try { market = await tavilyEbayLookup(env, analysis.identity); }
          catch (e) { market.error = cleanError(e); }
        }
      }

      return json({
        ok: true,
        version: VERSION,
        analysis,
        ebay: { ...ebay, query, searchUrl: ebaySearchUrl(query) },
        market,
        googleVision: googlePublicSummary(google),
        webLookup: {
          configured: webLookup.configured,
          used: webLookup.used,
          query: webLookup.query,
          results: (webLookup.results || []).slice(0, 6).map(x => ({ title: x.title, url: x.url, score: x.score })),
        },
        pipeline: {
          identity: 'Google Vision Web Detection + Google OCR + web verification',
          condition: 'Cloudflare Workers AI photo inspection',
          centering: 'Calculated locally on device from card geometry/design borders',
          grading: 'Calculated locally from published grading standards/guidelines',
        },
        privacy: 'Front/back images are sent transiently to Google Cloud Vision and Cloudflare Workers AI. Tavily receives text/search clues, not card images. This Worker does not write images or collection data to KV, R2, D1, or Durable Objects.',
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

function extractCardCandidates(text) {
  const raw = String(text || '').toUpperCase();
  const out = new Map();
  const add = (v, score) => {
    v = String(v || '').replace(/^#/, '').trim();
    if (!v || v.length > 24) return;
    if (!/[0-9]/.test(v)) return;
    if (/^(19|20)\d{2}$/.test(v)) return;
    if (/^\d{1,2}$/.test(v)) return; // likely jersey/stat number, not enough evidence by itself
    const old = out.get(v) || 0;
    out.set(v, Math.max(old, score));
  };
  for (const m of raw.match(/\b[A-Z0-9]{1,10}-[A-Z0-9]{1,10}(?:-[A-Z0-9]{1,8})?\b/g) || []) add(m, 120);
  for (const m of raw.match(/\b(?=[A-Z0-9]{3,16}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{3,16}\b/g) || []) add(m, 70);
  for (const m of raw.match(/(?:CARD\s*(?:NO\.?|NUMBER|#)\s*[:#-]?\s*)([A-Z0-9-]{1,18})/g) || []) {
    const x = m.replace(/^.*?(?:NO\.?|NUMBER|#)\s*[:#-]?\s*/i, ''); add(x, 100);
  }
  for (const m of raw.match(/#\s*([0-9]{3,4})\b/g) || []) add(m.replace(/#\s*/, ''), 85);
  for (const m of raw.match(/\bNO\.?\s*[:#-]?\s*([0-9]{3,4})\b/g) || []) add(m.replace(/^.*?NO\.?\s*[:#-]?\s*/i, ''), 85);
  return [...out.entries()].map(([value, score]) => ({ value, score })).sort((a,b)=>b.score-a.score || b.value.length-a.value.length);
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
    // Use proximity, not the whole nearby line: a stats year is often only a few
    // characters away from a separate copyright year on card backs.
    if (/(?:©|copyright|\bcopr\b)\s*$/.test(nearBefore) || /^\s*(?:copyright|all rights reserved|the .* company|topps|panini|upper deck)/.test(nearAfter)) role = 'copyright';
    else if (/stats?|statistics|receiving|passing|rushing|season|career/.test(`${nearBefore} ${nearAfter}`)) role = 'stats';
    else if (/born|birth|dob/.test(`${nearBefore} ${nearAfter}`)) role = 'birth';
    else if (/draft/.test(`${nearBefore} ${nearAfter}`)) role = 'draft';
    else if (/anniversary|retro|throwback|design/.test(`${nearBefore} ${nearAfter}`)) role = 'design';
    else if (/all rights reserved|printed in|manufactured by/.test(nearAfter)) role = 'copyright';
    years.push({ year, role, context: cleanLong(ctx.replace(/\s+/g,' '), 150) });
  }
  return years.slice(0, 20);
}

function provisionalFromGoogle(g) {
  const ocr = allGoogleText(g);
  const web = allGoogleWebText(g);
  const candidates = extractCardCandidates(`${g?.back?.fullText || ''}\n${g?.front?.fullText || ''}`);
  const webCandidates = extractCardCandidates(web);
  const cardNo = candidates[0]?.value || webCandidates[0]?.value || null;
  const brand = normalizeBrand(detectBrandFromText(`${ocr}\n${web}`));
  const years = extractYearsWithContext(ocr);
  const copyrightYears = years.filter(x => x.role === 'copyright').map(x => x.year);
  const webYears = (web.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number).filter(validYear);
  const year = copyrightYears.length ? Math.max(...copyrightYears) : null;
  const bestGuess = [...(g?.front?.web?.bestGuessLabels || []), ...(g?.back?.web?.bestGuessLabels || [])][0] || null;
  return {
    year,
    brand,
    set: null,
    subject: null,
    cardNo,
    variation: null,
    team: null,
    category: null,
    years,
    webYears,
    bestGuess,
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
      pages.push({ side, title: p.title, url: p.url, fullMatches: (p.fullMatchingImages || []).length, partialMatches: (p.partialMatchingImages || []).length });
    }
  }
  return pages.slice(0, 20);
}

async function resolveIdentity(env, google, provisional, webLookup) {
  const evidence = {
    frontOCR: cleanLong(google.front?.fullText || '', 6500),
    backOCR: cleanLong(google.back?.fullText || '', 6500),
    exactCardCodeCandidates: extractCardCandidates(`${google.back?.fullText || ''}\n${google.front?.fullText || ''}`).slice(0, 8),
    ocrYearsWithContext: extractYearsWithContext(allGoogleText(google)),
    googleBestGuess: [...(google.front?.web?.bestGuessLabels || []), ...(google.back?.web?.bestGuessLabels || [])].slice(0, 8),
    googleEntities: [...(google.front?.web?.entities || []), ...(google.back?.web?.entities || [])].sort((a,b)=>b.score-a.score).slice(0, 15),
    googleMatchingPages: collectGooglePages(google),
    googleFullImageMatches: (google.front?.web?.fullMatchingImages || []).length + (google.back?.web?.fullMatchingImages || []).length,
    provisional,
    webSearchAnswer: webLookup?.answer || null,
    webSearchResults: (webLookup?.results || []).slice(0, 12).map(x => ({ title: x.title, url: x.url, content: x.content, score: x.score })),
  };

  const prompt = `Identify ONE collectible trading card from corroborated evidence. Google OCR and Google Web Detection are primary; live web-search results are independent verification. Return ONLY one valid JSON object.

STRICT RULES:
- Never invent a field.
- Exact alphanumeric card codes such as ABC-12, US175, RA-TH are much stronger identifiers than a jersey/uniform number.
- A statistics season, birth year, draft year, or throwback/design year is NOT the product release year unless independently corroborated.
- A Google page with a matching image is strong evidence; a full image match is stronger than a visually similar image.
- Prefer agreement among exact card code + subject + manufacturer + checklist/product page.
- Use the actual product/set/insert name, not a generic visual description.
- Do not call something a parallel/variation unless the evidence distinguishes it from base.
- category must be Sports, TCG, Non-sport, Other, or null.
- confidence is 0-100 and should exceed 90 only for a strongly corroborated exact card.

EVIDENCE:
${JSON.stringify(evidence)}

RETURN:
{"year":number|null,"brand":string|null,"set":string|null,"subject":string|null,"cardNo":string|null,"variation":string|null,"team":string|null,"category":"Sports|TCG|Non-sport|Other|null","confidence":number,"evidence":["short factual reason"],"needs_review":boolean,"review_reason":string|null}`;

  const raw = await env.AI.run(TEXT_MODEL, {
    messages: [
      { role: 'system', content: 'You are a conservative trading-card identity resolver. Use only supplied evidence. Return one JSON object only.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.01,
    max_tokens: 1200,
    stream: false,
  });
  const obj = structuredModelResult(raw, 'identity resolver');
  return normalizeIdentityResult(obj);
}

function normalizeIdentityResult(obj) {
  const category = ['Sports','TCG','Non-sport','Other'].includes(obj?.category) ? obj.category : null;
  const year = validYear(obj?.year);
  const identity = {
    year,
    brand: normalizeBrand(obj?.brand),
    set: clean(obj?.set),
    subject: clean(obj?.subject),
    cardNo: clean(obj?.cardNo)?.replace(/^#/, '') || null,
    variation: clean(obj?.variation),
    team: clean(obj?.team),
    category: category || 'Other',
  };
  return {
    identity,
    identity_confidence: clamp(Math.round(Number(obj?.confidence) || 0), 0, 100),
    evidence: Array.isArray(obj?.evidence) ? obj.evidence.map(clean).filter(Boolean).slice(0, 12) : [],
    needs_review: obj?.needs_review !== undefined ? Boolean(obj.needs_review) : true,
    review_reason: clean(obj?.review_reason),
  };
}

function deterministicIdentityFallback(google, provisional, webLookup) {
  const text = `${allGoogleText(google)}\n${allGoogleWebText(google)}\n${(webLookup?.results || []).map(x=>`${x.title} ${x.content}`).join('\n')}`;
  const cardCandidates = extractCardCandidates(`${google.back?.fullText || ''}\n${google.front?.fullText || ''}`);
  const cardNo = cardCandidates[0]?.value || provisional.cardNo || null;
  const brand = normalizeBrand(provisional.brand || detectBrandFromText(text));
  const pages = collectGooglePages(google);
  const bestTitle = pages.find(x => cardNo && String(x.title || '').toUpperCase().includes(cardNo))?.title || pages[0]?.title || null;
  const subject = extractSubjectFromTitle(bestTitle, cardNo, brand);
  const years = (String(bestTitle || '').match(/\b(?:19|20)\d{2}\b/g) || []).map(Number).filter(validYear);
  const year = years[0] || provisional.year || null;
  return {
    identity: { year, brand, set: null, subject, cardNo, variation: null, team: null, category: 'Other' },
    identity_confidence: cardNo && subject ? 70 : cardNo ? 58 : 35,
    evidence: [bestTitle ? `Google matching page: ${bestTitle}` : null, cardNo ? `OCR card-code candidate: ${cardNo}` : null].filter(Boolean),
    needs_review: true,
    review_reason: 'Identity was assembled without the full reconciliation model; review the card details.',
  };
}

function guardResolvedIdentity(result, google, webLookup) {
  const out = normalizeIdentityResult({ ...result.identity, confidence: result.identity_confidence, evidence: result.evidence, needs_review: result.needs_review, review_reason: result.review_reason });
  const ocr = allGoogleText(google);
  const webText = `${allGoogleWebText(google)} ${(webLookup?.results || []).map(x=>`${x.title} ${x.content}`).join(' ')}`;
  const exactCandidates = extractCardCandidates(`${google.back?.fullText || ''}\n${google.front?.fullText || ''}`);
  const strongCode = exactCandidates[0]?.score >= 100 ? exactCandidates[0].value : null;

  if (strongCode) {
    if (out.identity.cardNo && normalizeToken(out.identity.cardNo) !== normalizeToken(strongCode)) {
      out.needs_review = true;
      out.review_reason = cleanJoin(out.review_reason, `OCR strongly supports card code ${strongCode}; conflicting card-number output was replaced.`);
    }
    out.identity.cardNo = strongCode;
  }
  const brand = detectBrandFromText(`${ocr}\n${webText}`);
  if (brand) out.identity.brand = normalizeBrand(brand);

  // Guard against the most common card-back year error: statistics, birth,
  // draft, anniversary/design years must not displace a separately corroborated
  // copyright/product year.
  const yr = Number(out.identity.year);
  if (yr) {
    const allYearContexts = extractYearsWithContext(ocr);
    const contexts = allYearContexts.filter(x => x.year === yr);
    const nonProductRoles = new Set(['stats','birth','draft','design']);
    const onlyNonProduct = contexts.length && contexts.every(x => nonProductRoles.has(x.role));
    const webHasYear = new RegExp(`\\b${yr}\\b`).test(webText);
    const copyrightYears = [...new Set(allYearContexts.filter(x => x.role === 'copyright').map(x => x.year))].sort((a,b)=>b-a);
    const corroboratedCopyright = copyrightYears.find(y => new RegExp(`\\b${y}\\b`).test(webText));
    if (onlyNonProduct && corroboratedCopyright && corroboratedCopyright !== yr) {
      out.identity.year = corroboratedCopyright;
      out.identity_confidence = Math.min(Math.max(out.identity_confidence, 82), 94);
      out.needs_review = true;
      out.review_reason = cleanJoin(out.review_reason, `${yr} appears only in non-product context; corroborated copyright/web evidence supports ${corroboratedCopyright}.`);
    } else if (onlyNonProduct && !webHasYear) {
      out.identity.year = null;
      out.identity_confidence = Math.min(out.identity_confidence, 72);
      out.needs_review = true;
      out.review_reason = cleanJoin(out.review_reason, `${yr} appears only in non-product context and was not used as the product year.`);
    }
  }

  // Confidence gets a deterministic boost only when independent evidence agrees.
  const combined = `${ocr}\n${webText}`.toLowerCase();
  let support = 0;
  if (out.identity.cardNo && combined.includes(String(out.identity.cardNo).toLowerCase())) support += 2;
  if (out.identity.subject && combined.includes(String(out.identity.subject).toLowerCase())) support += 2;
  if (out.identity.brand && combined.includes(String(out.identity.brand).toLowerCase())) support += 1;
  if (out.identity.year && combined.includes(String(out.identity.year))) support += 1;
  if (collectGooglePages(google).length) support += 1;
  if ((google.front?.web?.fullMatchingImages || []).length + (google.back?.web?.fullMatchingImages || []).length) support += 2;
  if ((webLookup?.results || []).length) support += 1;
  const floor = support >= 8 ? 94 : support >= 6 ? 88 : support >= 4 ? 78 : 0;
  out.identity_confidence = Math.max(out.identity_confidence, floor);

  const complete = Boolean(out.identity.year && out.identity.brand && out.identity.set && out.identity.subject && out.identity.cardNo);
  if (complete && out.identity_confidence >= 85) {
    out.needs_review = false;
    out.review_reason = null;
  } else if (!out.review_reason) {
    out.needs_review = true;
    out.review_reason = 'Some exact identity fields remain weakly corroborated.';
  }
  out.evidence = Array.from(new Set([
    ...(out.evidence || []),
    strongCode ? `Google OCR read card code ${strongCode}.` : null,
    collectGooglePages(google).length ? 'Google Web Detection found matching webpages/images.' : null,
    webLookup?.used ? 'Independent web search was used to corroborate the identity.' : null,
  ].filter(Boolean))).slice(0, 12);
  return out;
}

function extractSubjectFromTitle(title, cardNo, brand) {
  let t = clean(title);
  if (!t) return null;
  t = t.replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, ' ');
  if (cardNo) t = t.replace(new RegExp(`#?${escapeRegex(cardNo)}`, 'ig'), ' ');
  if (brand) t = t.replace(new RegExp(`\\b${escapeRegex(brand)}\\b`, 'ig'), ' ');
  t = t.replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\b(?:trading|sports?)\s+cards?\b/ig, ' ').replace(/\bcard\b/ig, ' ');
  t = t.replace(/\s*[|–—:-]\s*(?:eBay|Beckett|PSA|TCDB|Trading Card Database).*$/i, ' ').replace(/\s+/g, ' ').trim();
  // Fallback extraction is intentionally conservative; long product titles are not names.
  if (t.split(' ').length >= 2 && t.split(' ').length <= 5 && t.length <= 60) return t;
  return null;
}

async function inspectConditionSide(env, side, image) {
  const question = `Inspect ONLY the visible physical condition of the ${side} of one raw trading card. Do not identify the card and do not estimate centering.

Return SIMPLE KEY=VALUE lines, no markdown. If a category cannot be judged reliably from this single photo, use UNKNOWN rather than guessing.

Scores are 1-10 in 0.5 increments:
- 10 = no visible defect at this photo's resolution
- 9-9.5 = minute visible issue
- 8-8.5 = minor visible issue
- 7-7.5 = clearly visible moderate issue
- below 7 requires a clearly visible named defect; otherwise UNKNOWN

Use exactly:
CORNERS=
EDGES=
SURFACE=
FOCUS=
DEFECTS=
CONFIDENCE=
NOTES=

DEFECTS: comma-separated only from crease,dent,stain,scratch,printline,mark,possible_alteration, or NONE.
FOCUS is print/focus/registration quality visible on the card, not camera sharpness.
CONFIDENCE is 0-100 for how reliably this photo supports the condition scores.
NOTES must briefly name visible evidence for any score below 9.`;

  try {
    const raw = await env.AI.run(CONDITION_MODEL, {
      task: 'query', image, question, reasoning: false, temperature: 0, max_tokens: 900, stream: false,
    });
    return parseConditionKV(modelText(raw), side);
  } catch (e) {
    return unknownConditionSide(side, `Condition model unavailable: ${cleanError(e)}`);
  }
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
  const out = {
    side,
    corners: score('CORNERS'), edges: score('EDGES'), surface: score('SURFACE'), focus: score('FOCUS'),
    defects: { crease:has('crease'), dent:has('dent'), stain:has('stain'), scratch:has('scratch'), printline:has('printline'), mark:has('mark'), possible_alteration:has('possible_alteration') },
    confidence: clamp(Math.round(Number(String(value('CONFIDENCE')||'').match(/\d+(?:\.\d+)?/)?.[0]) || 0), 0, 100),
    notes: String(value('NOTES') || '').split(/\s*;\s*|\s*\|\s*/).map(clean).filter(Boolean).slice(0, 6),
  };
  const scored = ['corners','edges','surface','focus'].map(k=>out[k]).filter(Number.isFinite);
  const anyDefect = Object.values(out.defects).some(Boolean);
  // Reject common malformed/placeholder output rather than contaminating a grade.
  if (scored.length === 4 && scored.every(v=>v===1) && !anyDefect) {
    out.corners=out.edges=out.surface=out.focus=null;
    out.confidence=Math.min(out.confidence||30,30);
    out.notes.push('Condition scores withheld because the model output was internally inconsistent.');
  }
  for (const k of ['corners','edges','surface','focus']) {
    if (Number.isFinite(out[k]) && out[k] < 7 && !anyDefect && !out.notes.length) out[k] = null;
  }
  return out;
}

function unknownConditionSide(side, note) {
  return { side, corners:null, edges:null, surface:null, focus:null, defects:{crease:false,dent:false,stain:false,scratch:false,printline:false,mark:false,possible_alteration:false}, confidence:0, notes:[note] };
}

function combineCondition(front, back) {
  const worse = k => {
    const vals = [front?.[k], back?.[k]].map(Number).filter(Number.isFinite);
    return vals.length === 2 ? clampHalf(Math.min(...vals),1,10) : null;
  };
  const defects = {};
  for (const k of ['crease','dent','stain','scratch','printline','mark','possible_alteration']) defects[k] = Boolean(front?.defects?.[k] || back?.defects?.[k]);
  const confs = [front?.confidence,back?.confidence].map(Number).filter(Number.isFinite);
  let confidence = confs.length === 2 ? Math.round((confs[0]+confs[1])/2) : 0;
  const scores = ['corners','edges','surface','focus'].map(worse);
  if (scores.some(v=>!Number.isFinite(v))) confidence = Math.min(confidence, 40);
  return {
    corners:worse('corners'), edges:worse('edges'), surface:worse('surface'), focus:worse('focus'),
    defects,
    confidence: clamp(confidence,0,95),
    notes: Array.from(new Set([...(front?.notes||[]).map(x=>`Front: ${x}`), ...(back?.notes||[]).map(x=>`Back: ${x}`), 'Condition combines the worse visible front/back result; microscopic or hidden defects cannot be ruled out from phone photos.'])).slice(0,10),
    sides: { front, back },
  };
}

async function tavilyCardLookup(env, provisional, google) {
  const queries = buildLookupQueries(provisional, google);
  if (!queries.length) return { configured:true, used:false, query:'', queries:[], results:[], answer:null };
  const batches = await Promise.all(queries.slice(0, 3).map(q => tavilySearch(env, q, 8)));
  const byUrl = new Map();
  for (const b of batches) for (const x of b.results || []) {
    const key = x.url || `${x.title}|${x.content}`;
    if (!byUrl.has(key) || (byUrl.get(key).score || 0) < (x.score || 0)) byUrl.set(key,x);
  }
  return { configured:true, used:true, query:queries[0], queries, answer:batches.map(x=>x.answer).filter(Boolean).join(' | ')||null, results:[...byUrl.values()].sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,14) };
}

function buildLookupQueries(i = {}, google) {
  const code = i.cardNo || extractCardCandidates(allGoogleText(google))[0]?.value || '';
  const brand = i.brand || normalizeBrand(detectBrandFromText(`${allGoogleText(google)} ${allGoogleWebText(google)}`)) || '';
  const bestGuess = i.bestGuess || '';
  const pages = collectGooglePages(google);
  const title = pages[0]?.title || '';
  const q=[];
  if (code) {
    q.push([`"${code}"`, brand, 'trading card checklist'].filter(Boolean).join(' '));
    q.push([`"${code}"`, 'Topps Panini Bowman Beckett TCDB trading card'].filter(Boolean).join(' '));
  }
  if (title) q.push(`${title} trading card checklist`);
  else if (bestGuess) q.push(`${bestGuess} ${brand} trading card checklist`);
  if (!q.length) {
    const ocr = allGoogleText(google).replace(/\s+/g,' ').slice(0,220);
    if (ocr) q.push(`${ocr} trading card identify`);
  }
  return [...new Set(q.map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean))];
}

async function tavilySearch(env, query, maxResults = 8, includeDomains = null) {
  const body = { query, topic:'general', search_depth:'basic', max_results:maxResults, include_answer:true, include_raw_content:false, include_images:false };
  if (includeDomains?.length) body.include_domains = includeDomains;
  const r = await fetch('https://api.tavily.com/search', {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${env.TAVILY_API_KEY}`, 'Content-Type':'application/json', 'Accept':'application/json' },
    body:JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> '');
    throw new Error(`Tavily search ${r.status}${t?`: ${t.slice(0,180)}`:''}`);
  }
  const j = await r.json();
  return { answer:clean(j.answer), results:(j.results||[]).map(x=>({title:clean(x.title),url:cleanLong(x.url,1200),content:cleanLong(x.content,900),score:Number(x.score)||0})) };
}

async function tavilyEbayLookup(env, identity = {}) {
  const query = buildQuery(identity);
  const searchUrl = ebaySearchUrl(query);
  if (!query) return { configured:true, items:[], query, searchUrl, source:'Tavily web-indexed eBay results' };
  const b = await tavilySearch(env, `${query} current eBay listing`, 10, ['ebay.com']);
  const items = (b.results||[]).slice(0,8).map(x=>({ title:x.title, url:x.url, price:extractPrice(`${x.title||''} ${x.content||''}`), content:x.content }));
  return { configured:true, items, query, searchUrl, source:'Tavily web-indexed eBay results' };
}

function extractPrice(text) {
  const m=String(text||'').match(/\$\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.\d{2})?)/);
  return m?Number(m[1].replace(/,/g,'')):null;
}

function buildQuery(i={}) {
  return [i.year,i.brand,i.set,i.subject,i.cardNo,i.variation].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
}
function ebaySearchUrl(query) { return query ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}` : 'https://www.ebay.com/'; }

async function ebaySearch(env, query) {
  if (!query) return { configured:true, items:[], query };
  const token = await getEbayToken(env);
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  url.searchParams.set('q',query); url.searchParams.set('limit','12');
  const r = await fetch(url, { headers:{ 'Authorization':`Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID':'EBAY_US', 'Accept':'application/json' } });
  if (!r.ok) throw new Error(`eBay Browse API ${r.status}`);
  const data=await r.json();
  const items=(data.itemSummaries||[]).slice(0,12).map(x=>({ itemId:x.itemId,title:x.title,price:x.price?.value?Number(x.price.value):null,currency:x.price?.currency||'USD',image:x.image?.imageUrl||null,url:x.itemWebUrl||null,condition:x.condition||null }));
  return { configured:true,items,query };
}

async function getEbayToken(env) {
  if (ebayTokenCache.token && ebayTokenCache.expiresAt > Date.now()+60000) return ebayTokenCache.token;
  const basic=btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const r=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{'Authorization':`Basic ${basic}`,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'});
  if(!r.ok) throw new Error(`eBay OAuth ${r.status}`);
  const j=await r.json(); ebayTokenCache={token:j.access_token,expiresAt:Date.now()+Number(j.expires_in||7200)*1000}; return ebayTokenCache.token;
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
