const VERSION = '10.0.0';
const DEFAULT_ORIGIN = 'https://darknight909.github.io';
const CONDITION_PRIMARY_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const CONDITION_FALLBACK_MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const CONDITION_REGION_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const GOOGLE_VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';
const FEATURE_FLAGS = Object.freeze({verifiedSourceFirst:true,sourceHierarchy:true,strictExactCode:true,negativeEvidence:true,frontBackPairCheck:true,referenceTemplates:true,referenceFrameDetection:true,nestedCardFrameGeometry:true,regionConditionSheets:true,stageCaching:true,targetedConditionConsensus:true,severityCondition:true,licenseFreeConditionFallback:true,serialParallelGate:true,adaptiveMarket:true,strictMarketFiltering:true,localFingerprintHints:true,coreIdentityGate:true,fieldProvenance:true,finalIntegrityGate:true,failClosed:true});
const PERFORMANCE_BUDGET_MS = Object.freeze({analysis:30000,identity:15000,condition:15000,reference:10000,market:8000});
const TRUSTED_CARD_DOMAINS = [
  'topps.com','fanaticscollect.com','paniniamerica.net','upperdeck.com','leaftradingcards.com',
  'beckett.com','tcdb.com','cardboardconnection.com','cardboardchecklist.com','sportscardspro.com'
];
const OFFICIAL_DOMAINS = ['topps.com','fanaticscollect.com','paniniamerica.net','upperdeck.com','leaftradingcards.com'];
const STRONG_REFERENCE_DOMAINS = ['beckett.com','tcdb.com','cardboardconnection.com','cardboardchecklist.com'];
const PARALLEL_WORDS = ['refractor','prizm','parallel','crackle','wave','x-fractor','xfractor','sepia','negative','aqua','blue','green','red','orange','pink','purple','gold','black','silver','rainbow','diamante','foil','shimmer','sparkle','atomic','mojo','superfractor','image variation','variation'];
const CARD_CODE_REJECT_WORDS = new Set([
  'TOPPS','PANINI','BOWMAN','UPPER','DECK','FLAGSHIP','FOOTBALL','BASEBALL','BASKETBALL',
  'HOCKEY','SOCCER','TRADING','CARD','CARDS','CHECKLIST','ANNIVERSARY','CHROME','PRIZM'
]);

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

function nowMs(){ return Date.now(); }
function cleanMs(v){ return Math.max(0, Math.round(Number(v)||0)); }
function budgetStatus(t={}){return {analysis:cleanMs(t.total)>PERFORMANCE_BUDGET_MS.analysis,identity:cleanMs(t.identity)>PERFORMANCE_BUDGET_MS.identity,condition:cleanMs(t.condition)>PERFORMANCE_BUDGET_MS.condition,reference:cleanMs(t.reference)>PERFORMANCE_BUDGET_MS.reference,market:cleanMs(t.market)>PERFORMANCE_BUDGET_MS.market};}
function qualityScore(q){
  const n=Number(q?.score);
  return Number.isFinite(n)?clamp(n,0,100):null;
}

function sanitizeTrustedHint(obj) {
  if (!obj || typeof obj!=='object') return null;
  const cardNo=clean(obj.cardNo)?.replace(/^#/,'')||null;
  if (!cardNo || !isPlausibleCardCode(cardNo,true)) return null;
  return {
    cardNo,
    year:validYear(obj.year),
    brand:normalizeBrand(obj.brand),
    set:clean(obj.set),
    subject:clean(obj.subject),
    variation:clean(obj.variation),
    source:clean(obj.source)||'local verified-card fingerprint',
  };
}
function applyTrustedHint(provisional,hint) {
  if (!hint) return provisional;
  const out={...provisional};
  out.cardCandidates=Array.isArray(out.cardCandidates)?[...out.cardCandidates]:[];
  if (!out.cardCandidates.some(x=>normalizeLooseToken(x.value)===normalizeLooseToken(hint.cardNo))) {
    out.cardCandidates.unshift({value:hint.cardNo,score:138,context:'local verified-card fingerprint hint',origin:'local-hint'});
  }
  if (!out.cardNo) out.cardNo=hint.cardNo;
  if (!out.year && hint.year) out.year=hint.year;
  if (!out.brand && hint.brand) out.brand=hint.brand;
  out.trustedHint=hint;
  return out;
}
function sanitizeConditionLock(obj) {
  if (!obj || typeof obj!=='object') return null;
  const sides=obj.sides||{};
  const front=sides.front?sanitizeConditionAssessment(sides.front):null;
  const back=sides.back?sanitizeConditionAssessment(sides.back):null;
  const combined=sanitizeConditionAssessment(obj);
  if (!front || !back || conditionCompleteness(front)<4 || conditionCompleteness(back)<4) return null;
  if (!combined || conditionCompleteness(combined)<4 || Number(combined.confidence||0)<45) return null;
  return {...combined,sides:{front,back},reused:true};
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
        conditionPrimaryModel: CONDITION_PRIMARY_MODEL,
        conditionFallbackModel: CONDITION_FALLBACK_MODEL,
        conditionRegionModel: CONDITION_REGION_MODEL,
        architecture: 'verified-source identity + structured inspection-sheet condition + nested card/frame centering + deterministic grading inputs + adaptive live market',
        featureFlags: FEATURE_FLAGS,
        performanceBudgetMs: PERFORMANCE_BUDGET_MS,
      }, 200, cors);
    }

    if (origin && origin !== allowedOrigin) return json({ ok: false, error: 'Origin not allowed' }, 403, cors);
    if (!env.CARDLAB_API_KEY) return json({ ok: false, error: 'CARDLAB_API_KEY secret is not configured on the Worker.' }, 500, cors);
    if ((request.headers.get('Authorization') || '') !== `Bearer ${env.CARDLAB_API_KEY}`) return json({ ok: false, error: 'Unauthorized' }, 401, cors);

    try {
      if (url.pathname === '/selftest' && request.method === 'GET') {
        const result=runSelfTests();
        return json({ok:result.ok,version:VERSION,selftest:result},result.ok?200:500,cors);
      }

      if (url.pathname === '/condition' && request.method === 'POST') {
        const body=await request.json();
        const front=validateImage(body.front,'front');
        const back=validateImage(body.back,'back');
        const frontInspection=body.frontInspection?validateImage(body.frontInspection,'front inspection'):front;
        const backInspection=body.backInspection?validateImage(body.backInspection,'back inspection'):back;
        const started=nowMs();
        const photoQuality={front:qualityScore(body?.photoQuality?.front),back:qualityScore(body?.photoQuality?.back)};
        let [frontCondition,backCondition]=await Promise.all([
          inspectConditionSide(env,'front',front,photoQuality.front,frontInspection),
          inspectConditionSide(env,'back',back,photoQuality.back,backInspection),
        ]);
        let condition=combineCondition(frontCondition,backCondition,photoQuality);
        let referenceTemplate=null;
        if (Array.isArray(body.referenceImages) && body.referenceImages.length && (condition.confidence<62 || conditionCompleteness(condition)<4)) {
          referenceTemplate=await buildReferenceTemplate(env,body.referenceImages.slice(0,3),body.identity||null).catch(()=>null);
          if(referenceTemplate){
            condition=await refineConditionWithReference(env,front,back,condition,referenceTemplate,photoQuality);
          }
        }
        return json({
          ok:true,version:VERSION,
          analysis:{condition,condition_confidence:condition.confidence,reference_template:referenceTemplate},
          diagnostics:{timingsMs:{condition:cleanMs(nowMs()-started)},conditionModels:{front:condition?.sides?.front?.modelPath||null,back:condition?.sides?.back?.modelPath||null},photoQuality,referenceTemplateUsed:Boolean(referenceTemplate),featureFlags:FEATURE_FLAGS,performanceBudgetMs:PERFORMANCE_BUDGET_MS}
        },200,cors);
      }

      if (url.pathname === '/market' && request.method === 'POST') {
        const body = await request.json();
        const identity = sanitizeLockedIdentity(body.identity);
        if (!identity) throw new Error('A verified card identity is required to refresh market listings.');
        const front = typeof body.front === 'string' && /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(body.front) ? body.front : null;
        const started=nowMs();
        const market = await getMarket(env, identity, front);
        return json({ ok:true, version:VERSION, market, ebay:market.ebay || null, diagnostics:{timingsMs:{market:cleanMs(nowMs()-started)},featureFlags:FEATURE_FLAGS,performanceBudgetMs:PERFORMANCE_BUDGET_MS} }, 200, cors);
      }

      if (url.pathname !== '/analyze' || request.method !== 'POST') return json({ ok: false, error: 'Not found' }, 404, cors);
      if (!env.GOOGLE_VISION_API_KEY) throw new Error('GOOGLE_VISION_API_KEY secret is not configured on the Worker.');

      const body = await request.json();
      const front = validateImage(body.front, 'front');
      const back = validateImage(body.back, 'back');
      const frontInspection = body.frontInspection ? validateImage(body.frontInspection,'front inspection') : front;
      const backInspection = body.backInspection ? validateImage(body.backInspection,'back inspection') : back;
      const frontIdentity = body.frontIdentity ? validateImage(body.frontIdentity,'front identity') : front;
      const backIdentity = body.backIdentity ? validateImage(body.backIdentity,'back identity') : back;
      const lockedIdentity = sanitizeLockedIdentity(body.identityLock);
      const lockedCondition = sanitizeConditionLock(body.conditionLock);
      const trustedHint = sanitizeTrustedHint(body.trustedHint);
      const requestStarted = nowMs();
      const conditionStarted = nowMs();
      let conditionDurationMs = 0;
      let identityDurationMs = 0;
      let marketDurationMs = 0;
      const photoQuality = {
        front: qualityScore(body?.photoQuality?.front),
        back: qualityScore(body?.photoQuality?.back),
      };

      const conditionPromise = lockedCondition
        ? Promise.resolve({...lockedCondition,reused:true}).then(x=>{conditionDurationMs=0;return x;})
        : Promise.all([
            inspectConditionSide(env, 'front', front, photoQuality.front, frontInspection),
            inspectConditionSide(env, 'back', back, photoQuality.back, backInspection),
          ]).then(([frontCondition, backCondition]) => {
            conditionDurationMs = nowMs() - conditionStarted;
            return combineCondition(frontCondition, backCondition, photoQuality);
          });

      let google = null;
      let webLookup = { configured:Boolean(env.TAVILY_API_KEY), used:false, query:'', queries:[], results:[], answer:null };
      let identityResult;
      const identityStarted = nowMs();

      if (lockedIdentity) {
        identityResult = {
          identity: lockedIdentity,
          identity_confidence: clamp(Number(body.identityConfidence) || 98, 70, 100),
          verification_status: 'locked',
          core_verification_status: 'locked',
          evidence: ['Previously verified core identity reused; online identity lookup skipped for this re-analysis.'],
          sources: Array.isArray(body.identitySources) ? body.identitySources.slice(0,12) : [],
          needs_review: false,
          review_reason: null,
          selected_card_code: lockedIdentity.cardNo || null,
          serial_number: clean(body.serialNumber),
          variant_status: lockedIdentity.variation ? 'locked' : 'not-established',
          field_confidence:{cardNo:99,subject:99,year:99,set:99,variation:lockedIdentity.variation?99:40,serialNumber:body.serialNumber?95:0},
          evidence_graph:{locked:{value:true,note:'Previously verified identity reused without re-querying identity sources.'}},
          reference_images:Array.isArray(body.referenceImages)?body.referenceImages.slice(0,8):[],
        };
      } else {
        const googleInitial = await googleVisionInitial(env, frontIdentity, backIdentity);
        let backWebFallback = null;
        if (googleWebStrength(googleInitial.front) < 2) {
          try { backWebFallback = await googleVisionWebOnly(env, backIdentity); }
          catch (e) { console.warn('Google back Web Detection fallback:', e); }
        }
        google = combineGoogleEvidence(googleInitial, backWebFallback);
        const provisional = applyTrustedHint(provisionalFromGoogle(google),trustedHint);

        if (env.TAVILY_API_KEY) {
          try { webLookup = await trustedCardLookup(env, provisional, google); }
          catch (e) {
            webLookup = { configured:true, used:true, query:'', queries:[], results:[], answer:null, error:cleanError(e) };
          }
        }

        identityResult = await resolveIdentityFromSources(env, google, provisional, webLookup, front, back);
        const pairValidation=validateFrontBackPair(google,identityResult.identity);
        identityResult.evidence_graph={...(identityResult.evidence_graph||{}),photoPair:pairValidation};
        if(pairValidation.status==='conflict'){
          identityResult.verification_status='unverified';
          identityResult.core_verification_status='unverified';
          identityResult.identity_confidence=Math.min(Number(identityResult.identity_confidence||0),45);
          identityResult.needs_review=true;
          identityResult.review_reason=`Front/back photo pair conflict: ${pairValidation.reasons.join('; ')}`;
          identityResult.evidence=[...(identityResult.evidence||[]),`Front/back pair validation failed: ${pairValidation.reasons.join('; ')}.`];
        }else if(pairValidation.status==='compatible'){
          identityResult.evidence=[...(identityResult.evidence||[]),'Front/back photo pair passed deterministic compatibility checks.'];
        }
      }
      identityDurationMs = nowMs() - identityStarted;

      if(!lockedIdentity && identityResult?.identity && (identityResult.sources||[]).length){
        try{
          const extraRefs=await discoverReferenceImagesFromSources(identityResult.sources,identityResult.identity);
          identityResult.reference_images=[...new Set([...(identityResult.reference_images||[]),...extraRefs])].slice(0,8);
        }catch{}
      }

      let condition = await conditionPromise;
      let referenceTemplate=null;
      let referenceDurationMs=0;
      const referenceStarted=nowMs();
      const referenceImages=identityResult.reference_images||[];
      const localCentering=body.localCentering||null;
      const needsReference=referenceImages.length && (
        Number(condition?.confidence||0)<62 ||
        conditionCompleteness(condition)<4 ||
        centeringNeedsReference(localCentering?.front) ||
        centeringNeedsReference(localCentering?.back)
      );
      if(needsReference){
        referenceTemplate=await buildReferenceTemplate(env,referenceImages.slice(0,3),identityResult.identity).catch(e=>{console.warn('Reference template:',e);return null});
        if(referenceTemplate){
          if(Number(condition?.confidence||0)<70 || conditionCompleteness(condition)<4){
            condition=await refineConditionWithReference(env,front,back,condition,referenceTemplate,photoQuality);
          }
          condition=await refineCenteringWithReference(env,front,back,condition,referenceTemplate,localCentering);
        }
      }
      condition=await rescueCenteringEvidence(env,front,back,condition,identityResult.identity,referenceTemplate,localCentering);
      referenceDurationMs=nowMs()-referenceStarted;

      const analysis = {
        identity: identityResult.identity,
        condition,
        identity_confidence: identityResult.identity_confidence,
        condition_confidence: condition.confidence,
        verification_status: identityResult.verification_status,
        core_verification_status: identityResult.core_verification_status || identityResult.verification_status,
        sources: identityResult.sources || [],
        evidence: identityResult.evidence || [],
        selected_card_code: identityResult.selected_card_code || identityResult.identity?.cardNo || null,
        serial_number: identityResult.serial_number || null,
        needs_review: Boolean(identityResult.needs_review),
        review_reason: identityResult.review_reason || null,
        variant_status: identityResult.variant_status || 'unknown',
        field_confidence: identityResult.field_confidence || {},
        evidence_graph: identityResult.evidence_graph || {},
        reference_images: identityResult.reference_images || [],
        reference_template: referenceTemplate,
      };
      analysis.integrity=finalAnalysisIntegrity(analysis);
      if(!analysis.integrity.ok){
        analysis.needs_review=true;
        analysis.review_reason=analysis.integrity.critical.join('; ');
        if(analysis.integrity.critical.some(x=>x.includes('identity')||x.includes('card code'))){
          analysis.verification_status='unverified';
          analysis.core_verification_status='unverified';
          analysis.identity_confidence=Math.min(Number(analysis.identity_confidence||0),45);
        }
        if(analysis.integrity.critical.some(x=>x.includes('condition')))analysis.condition_confidence=Math.min(Number(analysis.condition_confidence||0),40);
      }

      let market = emptyMarket(analysis.identity);
      const marketStarted = nowMs();
      if (identityMarketReady(analysis)) {
        try { market = await getMarket(env, analysis.identity, front); }
        catch (e) { market = { ...emptyMarket(analysis.identity), error:cleanError(e) }; }
      }
      marketDurationMs = nowMs() - marketStarted;

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
          identity: lockedIdentity ? 'Verified identity cache reused' : 'Physical OCR clues → strict full-card-number candidate → verified online-source hierarchy → front/back compatibility check → contradiction rejection → separate variant arbitration',
          condition: lockedCondition ? 'Validated condition stage cache reused' : 'Labeled inspection-sheet crops → structured Gemma categorical inspection → Moondream one-field repair only when needed → deterministic score mapping',
          centering: 'Local deterministic geometry first → nested physical-card + printed-frame detection → verified exact-reference comparison when available → suspicious perfect/extreme results rejected',
          grading: 'Calculated locally from published grading standards/guidelines',
          market: market.live ? 'Official eBay Browse API adaptive exact→broader search + image matching + strict post-filtering' : 'Web-indexed fallback with strict identity filtering',
        },
        diagnostics: {
          timingsMs: {
            identity: cleanMs(identityDurationMs),
            condition: cleanMs(conditionDurationMs),
            market: cleanMs(marketDurationMs),
            reference: cleanMs(referenceDurationMs),
            total: cleanMs(nowMs()-requestStarted),
          },
          stagesReused:{identity:Boolean(lockedIdentity),condition:Boolean(lockedCondition),market:false},
          localTrustedHintUsed:Boolean(trustedHint),
          referenceTemplateUsed:Boolean(referenceTemplate),
          conditionModels: {
            front: condition?.sides?.front?.modelPath || null,
            back: condition?.sides?.back?.modelPath || null,
          },
          photoQuality,
          variantStatus: analysis.variant_status,
          integrity: analysis.integrity,
          featureFlags: FEATURE_FLAGS,
          performanceBudgetMs: PERFORMANCE_BUDGET_MS,
          overBudget: budgetStatus({identity:identityDurationMs,condition:conditionDurationMs,market:marketDurationMs,reference:referenceDurationMs,total:nowMs()-requestStarted}),
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


function validateFrontBackPair(google, identity=null) {
  const frontText=String(google?.front?.fullText||'');
  const backText=String(google?.back?.fullText||'');
  const frontCodes=extractCardCandidates(frontText).filter(x=>Number(x.score||0)>=100);
  const backCodes=extractCardCandidates(backText).filter(x=>Number(x.score||0)>=100);
  const reasons=[];
  let status='compatible';

  if(frontCodes.length&&backCodes.length){
    const f=frontCodes[0]?.value,b=backCodes[0]?.value;
    if(f&&b&&normalizeLooseToken(f)!==normalizeLooseToken(b)&&!cardCodePrefix(f,b)){
      status='conflict';
      reasons.push(`front OCR card code ${f} conflicts with back OCR card code ${b}`);
    }
  }

  const frontBrand=normalizeBrand(detectBrandFromText(frontText));
  const backBrand=normalizeBrand(detectBrandFromText(backText));
  if(frontBrand&&backBrand&&normalizeTitle(frontBrand)!==normalizeTitle(backBrand)){
    status='conflict';
    reasons.push(`front manufacturer ${frontBrand} conflicts with back manufacturer ${backBrand}`);
  }

  if(identity?.subject){
    const fHas=containsSubject(frontText,identity.subject),bHas=containsSubject(backText,identity.subject);
    if(!fHas&&!bHas && status!=='conflict'){
      status='insufficient';
      reasons.push('subject name was not readable on either physical side');
    }
  }
  if(status==='compatible'&&!frontText&&!backText)status='insufficient';

  return {status,reasons,frontCodes:frontCodes.slice(0,3).map(x=>x.value),backCodes:backCodes.slice(0,3).map(x=>x.value),frontBrand,backBrand};
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

function strictCardCodePresent(text, token) {
  const rawToken=String(token||'').toUpperCase().trim().replace(/^#/,'');
  if(!rawToken)return false;
  const target=normalizeLooseToken(rawToken);
  const explicit=extractTrustedSourceCodes(String(text||''));
  if(explicit.some(x=>normalizeLooseToken(x)===target))return true;

  const parts=rawToken.split(/[-\s]+/).filter(Boolean).map(escapeRegex);
  const core=parts.join('[-\\s#]*');
  const re=new RegExp(`(^|[^A-Z0-9])${core}(?!\\s*[-/#]\\s*[A-Z0-9])($|[^A-Z0-9])`,'i');
  return re.test(String(text||''));
}
function cardCodePrefix(a,b){
  const A=normalizeLooseToken(a),B=normalizeLooseToken(b);
  return Boolean(A&&B&&A!==B&&(B.startsWith(A)||A.startsWith(B)));
}
function chooseBestPhysicalCardCandidate(list=[]){
  const a=[...(list||[])];
  if(!a.length)return null;
  a.sort((x,y)=>{
    const xp=String(x?.value||''),yp=String(y?.value||'');
    const xs=Number(x?.score||0),ys=Number(y?.score||0);
    if(cardCodePrefix(xp,yp)&&Math.abs(xs-ys)<=85)return yp.length-xp.length;
    return ys-xs || yp.length-xp.length;
  });
  return a[0]||null;
}
function sourceFullCodes(text){
  const out=new Set(extractTrustedSourceCodes(text).map(x=>String(x).toUpperCase()));
  for(const m of String(text||'').toUpperCase().match(/\b[A-Z0-9]{2,10}-[A-Z0-9]{1,8}(?:-[A-Z0-9]{1,8})?\b/g)||[]) {
    if(isPlausibleCardCode(m,true)) out.add(m);
  }
  return [...out];
}

function isPlausibleCardCode(value, explicit=false) {
  const v=String(value||'').toUpperCase().replace(/^#/,'').trim().replace(/\s*-\s*/g,'-');
  if (!v || !/[0-9]/.test(v) || isDateLikeCardCode(v)) return false;
  if (/^(19|20)\d{2}$/.test(v)) return false;
  if (v.length > (explicit ? 18 : 14)) return false;
  const parts=v.split(/[-_]/).filter(Boolean);
  if (parts.some(p=>CARD_CODE_REJECT_WORDS.has(p))) return false;
  if (parts.some(p=>/^(19|20)\d{2}$/.test(p)) && !explicit) return false;
  if (!explicit && !/[A-Z]/.test(v)) return false;
  return true;
}

function extractCardCandidates(text) {
  const raw = String(text || '').toUpperCase();
  const out = new Map();
  const add = (v, baseScore, index = 0, explicit=false) => {
    v = String(v || '').replace(/^#/, '').trim().replace(/\s*-\s*/g,'-').replace(/[),.;:]+$/,'');
    if (!isPlausibleCardCode(v, explicit)) return;
    const before = raw.slice(Math.max(0,index-42),index);
    const after = raw.slice(index+String(v).length,Math.min(raw.length,index+String(v).length+42));
    const ctx = `${before} ${after}`;
    let score = baseScore;
    if (/(?:CARD\s*(?:NO\.?|NUMBER|#)|NO\.?\s*#?)\s*[:#-]?\s*$/i.test(before)) score += 35;
    if (/\b(?:DOB|BORN|BIRTH|BIRTHDAY|DATE OF BIRTH|HT|HEIGHT|WT|WEIGHT)\b/i.test(ctx) && !/[A-Z]/.test(v) && baseScore<100) score -= 180;
    if (/\b(?:STATS?|STATISTICS|REC|YDS|AVG|TD|SEASON)\b/i.test(ctx) && !/[A-Z]/.test(v) && baseScore<100) score -= 80;
    if (score < 40) return;
    const old = out.get(v);
    if (!old || old.score < score) out.set(v, { value:v, score, context:cleanLong(ctx.replace(/\s+/g,' '),130), origin:'ocr' });
  };

  // OCR can split a card number at a line break, e.g. "91TF-" then "2".
  for (const m of raw.matchAll(/\b([A-Z0-9]{2,10})\s*-\s*(?:\r?\n|\s{2,})([A-Z0-9]{1,8})\b/g)) {
    add(`${m[1]}-${m[2]}`,165,m.index||0,true);
  }

  // OCR often inserts spaces/newlines around hyphens; normalize those into one code.
  const hyphenated = /\b[A-Z0-9]{1,10}\s*-\s*[A-Z0-9]{1,10}(?:\s*-\s*[A-Z0-9]{1,8})?\b/g;
  let m;
  while ((m=hyphenated.exec(raw))) add(m[0],150,m.index,false);

  const compact = /\b(?=[A-Z0-9]{3,14}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{3,14}\b/g;
  while ((m=compact.exec(raw))) add(m[0],88,m.index,false);

  const contextual = /(?:CARD\s*(?:NO\.?|NUMBER|#)|NO\.?\s*#?)\s*[:#-]?\s*([A-Z0-9]{1,10}(?:\s*-\s*[A-Z0-9]{1,10}){0,2})/gi;
  while ((m=contextual.exec(raw))) add(m[1],132,m.index + m[0].indexOf(m[1]),true);

  const hashCode = /#\s*([A-Z0-9]{1,10}(?:\s*-\s*[A-Z0-9]{1,10}){0,2})\b/g;
  while ((m=hashCode.exec(raw))) add(m[1],125,m.index + m[0].indexOf(m[1]),true);

  return [...out.values()].sort((a,b)=>b.score-a.score || b.value.length-a.value.length).slice(0,12);
}

function extractTrustedSourceCodes(text) {
  const raw=String(text||'').toUpperCase();
  const out=[];
  const seen=new Set();
  const push=v=>{
    v=String(v||'').replace(/^#/,'').trim().replace(/\s*-\s*/g,'-');
    if (!isPlausibleCardCode(v,true) || seen.has(v)) return;
    seen.add(v); out.push(v);
  };
  let m;
  const explicit=/(?:CARD\s*(?:NO\.?|NUMBER|#)|NO\.?\s*#?|#)\s*[:#-]?\s*([A-Z0-9]{1,10}(?:\s*-\s*[A-Z0-9]{1,10}){0,2})/gi;
  while ((m=explicit.exec(raw))) push(m[1]);
  return out.slice(0,8);
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
  const candidates = extractCardCandidates(`${g?.back?.fullText || ''}\n${g?.front?.fullText || ''}`);
  const brand = normalizeBrand(detectBrandFromText(`${ocr}\n${web}`));
  const years = extractYearsWithContext(ocr);
  const copyrightYears = years.filter(x => x.role === 'copyright').map(x => x.year);
  const bestGuess = [...(g?.front?.web?.bestGuessLabels || []), ...(g?.back?.web?.bestGuessLabels || [])][0] || null;
  return {
    year: copyrightYears.length ? Math.max(...copyrightYears) : null,
    brand,
    set: null,
    subject: null,
    cardNo: chooseBestPhysicalCardCandidate(candidates)?.value || null,
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
      pages.push({
        side,title:p.title,url:p.url,
        fullMatches:(p.fullMatchingImages||[]).length,
        partialMatches:(p.partialMatchingImages||[]).length,
        trustTier:domainTrust(p.url),
        referenceImages:[...(p.fullMatchingImages||[]),...(p.partialMatchingImages||[])].filter(Boolean).slice(0,4),
      });
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

function sourceEvidence(result, cardCode, subjectHint=null) {
  const text = `${result.title||''} ${result.content||''}`;
  const exactCode = cardCode ? strictCardCodePresent(text,cardCode) : false;
  const fullCodes=sourceFullCodes(text);
  const codeConflict=Boolean(cardCode && fullCodes.length && !fullCodes.some(x=>normalizeLooseToken(x)===normalizeLooseToken(cardCode)));
  const subjectMatch=subjectHint?containsSubject(text,subjectHint):null;
  return {...result,trustTier:domainTrust(result.url),exactCode,fullCodes,codeConflict,subjectMatch,domain:hostnameOf(result.url)};
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

function likelySubjectFromGoogle(google, cardCode=null) {
  const ocr=allGoogleText(google);
  const scored=new Map();
  const add=(name,pts)=>{
    name=clean(name);
    if(!name)return;
    const words=String(name).split(/\s+/).filter(Boolean);
    if(words.length<2||words.length>5||name.length>60)return;
    const key=normalizeTitle(name);
    if(!key)return;
    scored.set(key,{name,score:(scored.get(key)?.score||0)+pts});
  };
  for(const p of collectGooglePages(google)){
    const t=String(p.title||'');
    const sub=extractSubjectFromTitle(t,null,detectBrandFromText(t));
    if(!sub)continue;
    let pts=(p.fullMatches?10:p.partialMatches?5:2);
    if(containsSubject(ocr,sub))pts+=16;
    if(cardCode && strictCardCodePresent(t,cardCode))pts+=6;
    add(sub,pts);
  }
  for(const t of [...(google?.front?.web?.bestGuessLabels||[]),...(google?.back?.web?.bestGuessLabels||[])]){
    const sub=extractSubjectFromTitle(t,null,detectBrandFromText(t));
    if(sub)add(sub,containsSubject(ocr,sub)?12:3);
  }
  for(const e of [...(google?.front?.web?.entities||[]),...(google?.back?.web?.entities||[])]){
    const sub=extractSubjectFromTitle(e?.description||'',null,detectBrandFromText(e?.description||''));
    if(sub)add(sub,containsSubject(ocr,sub)?8:2);
  }
  return [...scored.values()].sort((a,b)=>b.score-a.score)[0]?.name||null;
}

async function trustedCardLookup(env, provisional, google) {
  const physicalCandidates=(provisional.cardCandidates||[]).slice(0,5);
  const bestPhysical=chooseBestPhysicalCardCandidate(physicalCandidates);
  const ordered=[bestPhysical,...physicalCandidates.filter(x=>x!==bestPhysical)].filter(Boolean);
  const brand=provisional.brand||'';
  const subjectHint=likelySubjectFromGoogle(google,bestPhysical?.value||provisional.cardNo);
  const merged=new Map(),queries=[];

  const addResults=(batch,code)=>{
    for(const x of batch?.results||[]){
      const y=sourceEvidence(x,code,subjectHint);
      const key=y.url||`${y.title}|${y.content}`;
      const prior=merged.get(key);
      const weight=(y.trustTier||0)*100+(y.exactCode?80:0)+(y.subjectMatch?55:0)-(y.codeConflict?90:0)+(y.score||0)*10;
      const priorWeight=prior?((prior.trustTier||0)*100+(prior.exactCode?80:0)+(prior.subjectMatch?55:0)-(prior.codeConflict?90:0)+(prior.score||0)*10):-Infinity;
      if(!prior||weight>priorWeight)merged.set(key,y);
    }
  };

  // Search the strongest physical-card candidate first. Most cards should finish
  // here, avoiding repeated paid searches. A second candidate is tried only when
  // the first produces no exact online record.
  for(const cand of ordered.slice(0,2)){
    const q=[subjectHint?`"${subjectHint}"`:'',`"${cand.value}"`,brand,'trading card checklist'].filter(Boolean).join(' ');
    queries.push(q);

    const [broad,official,reference]=await Promise.all([
      tavilySearch(env,q,12,TRUSTED_CARD_DOMAINS).catch(()=>({results:[]})),
      tavilySearch(env,q,8,OFFICIAL_DOMAINS).catch(()=>({results:[]})),
      tavilySearch(env,q,10,[...STRONG_REFERENCE_DOMAINS,'sportscardspro.com']).catch(()=>({results:[]})),
    ]);
    addResults(broad,cand.value);addResults(official,cand.value);addResults(reference,cand.value);

    const exact=[...merged.values()].filter(x=>
      x.exactCode &&
      (!subjectHint||x.subjectMatch) &&
      x.trustTier>=2 &&
      strictCardCodePresent(`${x.title||''} ${x.content||''}`,cand.value)
    );
    if(exact.length)break;
  }

  if(!merged.size){
    const q=[subjectHint?`"${subjectHint}"`:'',brand,collectGooglePages(google)[0]?.title||provisional.bestGuess||'','trading card checklist'].filter(Boolean).join(' ');
    if(q.trim()){queries.push(q);addResults(await tavilySearch(env,q,10,TRUSTED_CARD_DOMAINS).catch(()=>({results:[]})),bestPhysical?.value||provisional.cardNo)}
  }

  const results=[...merged.values()].sort((a,b)=>{
    const aw=(a.trustTier||0)*100+(a.exactCode?80:0)+(a.subjectMatch?55:0)-(a.codeConflict?90:0)+(a.score||0)*10;
    const bw=(b.trustTier||0)*100+(b.exactCode?80:0)+(b.subjectMatch?55:0)-(b.codeConflict?90:0)+(b.score||0)*10;
    return bw-aw;
  }).slice(0,22);

  return {
    configured:true,used:true,query:queries[0]||'',queries,answer:null,
    subjectHint,physicalCardCode:bestPhysical?.value||null,results,
    diagnostics:{candidateCountTried:Math.min(2,ordered.length),searchCallsEstimated:queries.length?Math.min(6,queries.length*3):0}
  };
}

function recoverTrustedCardCode(results, google, subjectHint=null, physicalCode=null) {
  const scored=new Map();
  const add=(code,score,domain)=>{
    if(!isPlausibleCardCode(code,true))return;
    if(physicalCode && !cardCodePrefix(code,physicalCode) && normalizeLooseToken(code)!==normalizeLooseToken(physicalCode)) return;
    const key=normalizeLooseToken(code);
    const old=scored.get(key)||{code,score:0,domains:new Set()};
    old.score+=score;
    if(domain)old.domains.add(domain);
    scored.set(key,old);
  };
  for(const r of results||[]){
    const text=`${r.title||''} ${r.content||''}`;
    if(subjectHint && !containsSubject(text,subjectHint))continue;
    const trust=Number(r.trustTier||domainTrust(r.url));
    for(const code of sourceFullCodes(text))add(code,trust>=4?80:trust===3?60:trust===2?25:8,hostnameOf(r.url));
  }
  for(const p of collectGooglePages(google)){
    if(subjectHint && !containsSubject(p.title||'',subjectHint))continue;
    for(const code of sourceFullCodes(p.title||''))add(code,p.fullMatches?45:p.partialMatches?20:6,hostnameOf(p.url));
  }
  const ranked=[...scored.values()].sort((a,b)=>(b.score+b.domains.size*25)-(a.score+a.domains.size*25));
  if(!ranked.length)return null;
  const top=ranked[0],second=ranked[1];
  if(second && (top.score+top.domains.size*25)-(second.score+second.domains.size*25)<25)return null;
  return top.code;
}

function separateSetAndVariation(setName, variation, evidenceTexts, serialNumber) {
  let set=clean(setName), v=clean(variation);
  if (!set) return {set:null,variation:v};
  const evidence=String((evidenceTexts||[]).join(' ')).toLowerCase();
  if (!v) {
    const words=[...PARALLEL_WORDS].sort((a,b)=>b.length-a.length);
    for (const word of words) {
      const re=new RegExp(`(?:\\\\s*[-–—:]\\\\s*)?\\\\b${escapeRegex(word)}\\\\b(?:\\\\s+parallel)?\\\\s*$`,'i');
      if (!re.test(set)) continue;
      const evidenceSupports=evidence.includes(word.toLowerCase());
      if (!evidenceSupports) continue;
      v=word.replace(/\b\w/g,m=>m.toUpperCase());
      set=clean(set.replace(re,'').replace(/\s*[-–—:]\s*$/,''));
      break;
    }
  }
  if (v && serialNumber && /\/\d+$/.test(serialNumber) && !new RegExp(`/\\d+$`).test(v)) {
    const total=String(serialNumber).split('/')[1];
    if (total) v=`${v} /${total}`;
  }
  return {set,variation:v};
}


function canonicalParallelName(word){
  if(!word)return null;
  return String(word).trim().replace(/\b\w/g,m=>m.toUpperCase()).replace('X-Fractor','X-Fractor').replace('Xfractor','X-Fractor');
}
function parallelNamesInText(text){
  const t=normalizeTitle(text);
  const found=[];
  for(const w of [...PARALLEL_WORDS].sort((a,b)=>b.length-a.length)){
    if(['parallel','variation'].includes(String(w).toLowerCase()))continue;
    const n=normalizeTitle(w);
    if(n && new RegExp(`(?:^|\\s)${escapeRegex(n)}(?:\\s|$)`,'i').test(t))found.push(canonicalParallelName(w));
  }
  return [...new Set(found)];
}
function denominatorNearParallel(text, parallel){
  const raw=String(text||'');
  const idx=raw.toLowerCase().indexOf(String(parallel||'').toLowerCase());
  if(idx<0)return null;
  const ctx=raw.slice(Math.max(0,idx-70),Math.min(raw.length,idx+String(parallel).length+90));
  const m=ctx.match(/(?:\/|out of\s+)(\d{1,5})\b/i);
  return m?Number(m[1]):null;
}
function buildVariantCatalog(sources, pages){
  const byName=new Map();
  const feed=(text,weight,source)=>{
    for(const name of parallelNamesInText(text)){
      const key=name.toLowerCase();
      const old=byName.get(key)||{name,weight:0,denominators:new Set(),sources:[]};
      old.weight+=weight;
      const d=denominatorNearParallel(text,name);
      if(Number.isFinite(d))old.denominators.add(d);
      if(source)old.sources.push(source);
      byName.set(key,old);
    }
  };
  for(const x of sources||[])feed(`${x.title||''} ${x.content||''}`,x.trustTier>=4?5:x.trustTier===3?4:2,x.url||x.domain);
  for(const p of pages||[])feed(p.title||'',p.fullMatches?6:p.partialMatches?3:1,p.url);
  return [...byName.values()].map(x=>({...x,denominators:[...x.denominators]})).sort((a,b)=>b.weight-a.weight);
}
function serialDenominator(serial){
  const m=String(serial||'').match(/\/\s*(\d{1,5})\b/);
  return m?Number(m[1]):null;
}

async function readSerialNumberVision(env,backImage,catalog){
  if(!backImage)return null;
  const denoms=[...new Set((catalog||[]).flatMap(x=>x.denominators||[]).filter(Number.isFinite))].sort((a,b)=>a-b);
  if(!denoms.length)return null;
  const prompt=`Read ONLY a collector serial number printed/stamped on the back of this trading card. Expected documented denominators for this exact card include: ${denoms.map(x=>'/'+x).join(', ')}.
Return ONLY JSON {"serial":string|null,"confidence":number,"evidence":string|null}.
A valid serial must be in numerator/denominator form such as 23/99. Do not use statistics, dates, jersey numbers, copyright years, or card number as serial numbering. If not clearly visible, return null.`;
  try{
    const raw=await env.AI.run(CONDITION_PRIMARY_MODEL,{messages:[{role:'system',content:'You are a precise OCR verifier for stamped trading-card serial numbering.'},{role:'user',content:prompt}],image:backImage,temperature:0,max_tokens:350,stream:false});
    const obj=structuredModelResult(raw,'serial verifier');
    const serial=extractSerialNumber(String(obj?.serial||''));
    const confidence=clamp(Math.round(Number(obj?.confidence)||0),0,100);
    if(!serial||confidence<80)return null;
    const denom=serialDenominator(serial);
    if(!denoms.includes(denom))return null;
    return {serial,confidence,evidence:clean(obj?.evidence)};
  }catch(e){console.warn('Serial vision verifier:',e);return null}
}
async function inspectVariantVisual(env,frontImage,catalog){
  if(!frontImage)return null;
  const candidates=(catalog||[]).filter(x=>x.weight>=4).slice(0,10);
  if(candidates.length<1)return null;
  const prompt=`The exact trading card is already established. Determine whether the photographed FRONT visibly matches one documented parallel candidate below.
CANDIDATES: ${JSON.stringify(candidates.map(x=>({name:x.name,numbered:x.denominators})))}
Return ONLY JSON {"candidate":string|null,"confidence":number,"visible_cues":[string]}.
Do not invent a parallel. A numbered candidate cannot be confirmed from front color alone; it may only be returned as a visual candidate, never as serial verification. If more than one candidate is plausible or cues are weak, return null.`;
  try{
    const raw=await env.AI.run(CONDITION_PRIMARY_MODEL,{messages:[{role:'system',content:'You are a conservative visual parallel classifier. Ambiguity must return null.'},{role:'user',content:prompt}],image:frontImage,temperature:0,max_tokens:500,stream:false});
    const obj=structuredModelResult(raw,'variant visual classifier');
    const name=clean(obj?.candidate),confidence=clamp(Math.round(Number(obj?.confidence)||0),0,100);
    const hit=candidates.find(x=>normalizeTitle(x.name)===normalizeTitle(name));
    if(!hit||confidence<90)return null;
    return {candidate:hit,confidence,visible_cues:Array.isArray(obj?.visible_cues)?obj.visible_cues.map(clean).filter(Boolean).slice(0,6):[]};
  }catch(e){console.warn('Variant visual classifier:',e);return null}
}
function resolveVariantEvidence(parsedVariation, serialNumber, sources, pages){
  const catalog=buildVariantCatalog(sources,pages);
  const denom=serialDenominator(serialNumber);
  const parsed=clean(parsedVariation);
  const conflicts=catalog.filter(x=>x.weight>=4);
  let variation=null,status='unknown',reason=null,matched=null;

  if(denom){
    const matches=catalog.filter(x=>x.denominators.includes(denom));
    if(matches.length===1){
      matched=matches[0];
      variation=`${matched.name} /${denom}`;
      status='verified';
    }else if(matches.length>1){
      status='unresolved';
      reason=`Serial denominator /${denom} maps to more than one documented parallel.`;
    }else if(parsed){
      const p=catalog.find(x=>normalizeTitle(x.name)===normalizeTitle(parsed.replace(/\/\d+.*/,'')));
      if(p && p.denominators.length && !p.denominators.includes(denom)){
        status='unresolved';
        reason=`Detected serial ${serialNumber} conflicts with the documented ${p.name} numbering.`;
      }else{
        status='unresolved';
        reason=`Serial ${serialNumber} was detected, but trusted sources did not map /${denom} to one unique parallel.`;
      }
    }else{
      status='unresolved';
      reason=`Serial ${serialNumber} was detected, but its parallel could not be mapped uniquely.`;
    }
  }else if(parsed){
    const pnames=parallelNamesInText(parsed);
    const p=pnames.length?catalog.find(x=>normalizeTitle(x.name)===normalizeTitle(pnames[0])):null;
    const strongDistinct=conflicts.map(x=>x.name);
    if(strongDistinct.length>1){
      status='unresolved';
      reason=`Trusted sources show multiple possible parallels (${strongDistinct.slice(0,4).join(', ')}), but no serial-number evidence confirms one.`;
    }else if(p && p.denominators.length){
      status='unresolved';
      reason=`${p.name} is documented as numbered /${p.denominators.join(' or /')}; serial-number evidence is required before accepting it.`;
    }else if(p && p.weight>=6){
      variation=p.name;
      status='probable';
      matched=p;
    }else{
      status='unresolved';
      reason='A parallel was suggested visually/textually but lacked enough independent evidence.';
    }
  }else if(conflicts.length>1){
    status='unresolved';
    reason=`Multiple documented parallels exist for this exact card (${conflicts.slice(0,4).map(x=>x.name).join(', ')}); Card Lab will not guess which one is pictured.`;
  }else{
    status='not-established';
  }
  return {variation,status,reason,catalog:catalog.slice(0,12),matched};
}


function evaluateCoreVerification(e={}) {
  const required=Boolean(e.codeSupported&&e.subjectSupported&&e.yearSupported&&e.setSupported);
  if(!required)return 'unverified';
  if(Number(e.contradictionCount||0)>0)return 'probable';
  if(Number(e.officialCount||0)>=1)return 'verified';
  if(Number(e.strongDomainCount||0)>=2)return 'verified';
  if(Number(e.strongCount||0)>=1 && e.physicalCodeSupported && e.physicalSubjectSupported)return 'verified';
  // A lower-tier exact online record is sufficient only when the photographed card
  // independently confirms BOTH the full card number and subject. Variant remains separate.
  if(Number(e.referenceCount||0)>=1 && e.physicalCodeSupported && e.physicalSubjectSupported)return 'verified';
  if((Number(e.strongCount||0)>=1 || Number(e.referenceCount||0)>=1) && (e.physicalCodeSupported||e.matchingImageSupport))return 'probable';
  return 'unverified';
}


function setNameFromExactSourceTitle(title,cardNo,subject){
  let t=String(title||'').replace(/<[^>]+>/g,' ').replace(/&[^;\s]+;/g,' ');
  if(subject){
    const words=String(subject).trim().split(/\s+/).filter(Boolean).map(escapeRegex);
    if(words.length)t=t.replace(new RegExp(`\\b${words.join('\\\\s+')}\\b`,'ig'),' ');
  }
  if(cardNo){
    const p=escapeRegex(String(cardNo)).replace(/[-\s]+/g,'[-\\\\s#]*');
    t=t.replace(new RegExp(`#?${p}\\b`,'ig'),' ');
  }
  // Remove bracketed parallel/variant descriptors and grading/value boilerplate.
  t=t.replace(/\[[^\]]+\]/g,' ')
     .replace(/\([^)]*(?:parallel|refractor|prizm|numbered|\/\d+)[^)]*\)/ig,' ')
     .replace(/\b(?:prices?|card prices?|ungraded values?|graded values?|psa|bgs|cgc|sgc|ebay|beckett marketplace)\b.*$/ig,' ')
     .replace(/\s*[|–—]\s*.*$/,' ')
     .replace(/\s+/g,' ').trim();
  // Strip a trailing generic "card/cards" but keep product wording.
  t=t.replace(/\b(?:trading\s+)?cards?\s*$/i,'').trim().replace(/[-–—:|]\s*$/,'').trim();
  return t.length>=5&&t.length<=120?t:null;
}
function deterministicIdentityFromExactSources(exactSources,selectedCode,subjectHint,provisional={}){
  const ordered=[...(exactSources||[])].sort((a,b)=>(b.trustTier||0)-(a.trustTier||0)||(b.score||0)-(a.score||0));
  const best=ordered[0]||null;
  const joined=ordered.map(x=>`${x.title||''} ${x.content||''}`).join(' ');
  const years=(joined.match(/\b(?:19|20)\d{2}\b/g)||[]).map(Number).filter(validYear);
  const subject=subjectHint&&ordered.some(x=>containsSubject(`${x.title||''} ${x.content||''}`,subjectHint))?subjectHint:null;
  return {
    year:years[0]||provisional.year||null,
    brand:normalizeBrand(detectBrandFromText(joined)||provisional.brand),
    set:best?setNameFromExactSourceTitle(best.title,selectedCode,subject):null,
    subject,
    cardNo:selectedCode||null,
  };
}

async function resolveIdentityFromSources(env, google, provisional, webLookup, frontImage=null, backImage=null) {
  const candidates=(provisional.cardCandidates||[]).slice(0,6);
  const pages=collectGooglePages(google);
  const physicalBest=chooseBestPhysicalCardCandidate(candidates);
  const subjectHint=webLookup?.subjectHint||likelySubjectFromGoogle(google,physicalBest?.value||provisional.cardNo);
  const trusted=(webLookup?.results||[]).map(x=>sourceEvidence(x,physicalBest?.value||provisional.cardNo,subjectHint));

  let selectedCode=physicalBest?.value||provisional.cardNo||null;
  const sourceExpanded=recoverTrustedCardCode(trusted,google,subjectHint,selectedCode);
  if(sourceExpanded && (!selectedCode || cardCodePrefix(sourceExpanded,selectedCode) || normalizeLooseToken(sourceExpanded)===normalizeLooseToken(selectedCode))) {
    if(!selectedCode || String(sourceExpanded).length>=String(selectedCode).length) selectedCode=sourceExpanded;
  }
  const longerPhysical=candidates
    .filter(x=>selectedCode&&cardCodePrefix(x.value,selectedCode)&&String(x.value).length>String(selectedCode).length)
    .sort((a,b)=>b.score-a.score||String(b.value).length-String(a.value).length)[0];
  if(longerPhysical && Number(longerPhysical.score||0)>=100) selectedCode=longerPhysical.value;

  const exactSources=trusted.filter(x=>{
    const text=`${x.title||''} ${x.content||''}`;
    return selectedCode && strictCardCodePresent(text,selectedCode) && (!subjectHint || containsSubject(text,subjectHint));
  });
  const contradictorySources=trusted.filter(x=>{
    const text=`${x.title||''} ${x.content||''}`;
    // Search results for neighboring cards/parallels are not contradictions.
    // Only a source that explicitly claims THIS exact full code for a different subject
    // is negative evidence against the core identity.
    return Boolean(selectedCode && strictCardCodePresent(text,selectedCode) && subjectHint && !containsSubject(text,subjectHint));
  });
  const exactGooglePages=pages.filter(x=>selectedCode&&strictCardCodePresent(x.title||'',selectedCode)&&(!subjectHint||containsSubject(x.title||'',subjectHint)));
  const evidenceBundle={
    selectedCardCode:selectedCode,
    subjectHint,
    physicalCardCode:physicalBest?.value||null,
    serialNumber:provisional.serialNumber,
    ocrFront:cleanLong(google.front?.fullText||'',4200),
    ocrBack:cleanLong(google.back?.fullText||'',5200),
    exactTrustedSources:exactSources.slice(0,10).map((x,i)=>({index:i,title:x.title,url:x.url,content:x.content,trustTier:x.trustTier})),
    googleMatchingPages:exactGooglePages.slice(0,8),
    googleBestGuess:[...(google.front?.web?.bestGuessLabels||[]),...(google.back?.web?.bestGuessLabels||[])].slice(0,6),
    contradictorySources:contradictorySources.slice(0,6).map(x=>({title:x.title,url:x.url,fullCodes:x.fullCodes,subjectMatch:x.subjectMatch})),
  };

  let parsed={};
  if (exactSources.length && env.AI) {
    const prompt=`Extract the identity of ONE trading card using ONLY the listed source evidence. The source pages, not OCR guesses, are the authority. Return one JSON object only.

Rules:
- The online trusted sources are authoritative. OCR and visual labels are lookup clues only.
- cardNo must be exactly the selectedCardCode if the trusted sources support it.
- subject must match subjectHint when the exact trusted sources support that same person/character.
- year must be the product/release year shown by a trusted source, never a birth/statistics/design year.
- set must preserve the actual product/set/insert wording from the sources, but exclude a color/parallel name when that parallel is separately identifiable.
- subject is the player/character/person on that exact card number.
- variation must be null unless the sources or matching-page evidence specifically identify a parallel/variation that matches the photographed card. If a source title ends with a known color/parallel (for example Green), put that in variation, not in set. Do not infer a color parallel from generic artwork.
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

  const sourceFallback=deterministicIdentityFromExactSources(exactSources,selectedCode,subjectHint,provisional);
  const identity={
    year:validYear(parsed.year)||validYear(sourceFallback.year),
    brand:normalizeBrand(parsed.brand||sourceFallback.brand||provisional.brand),
    set:clean(parsed.set)||clean(sourceFallback.set),
    subject:clean(parsed.subject)||clean(sourceFallback.subject),
    cardNo:clean(parsed.cardNo)?.replace(/^#/,'')||sourceFallback.cardNo||selectedCode||null,
    variation:clean(parsed.variation),
    team:clean(parsed.team),
    category:['Sports','TCG','Non-sport','Other'].includes(parsed.category)?parsed.category:(/\b(football|baseball|basketball|hockey|soccer|nfl|nba|mlb|nhl)\b/i.test(exactSources.map(x=>`${x.title||''} ${x.content||''}`).join(' '))?'Sports':'Other'),
  };

  if (selectedCode && normalizeLooseToken(identity.cardNo)!==normalizeLooseToken(selectedCode)) identity.cardNo=selectedCode;

  const sourceIdx=Array.isArray(parsed.source_indices)?parsed.source_indices.map(Number).filter(Number.isInteger):[];
  const used=sourceIdx.map(i=>exactSources[i]).filter(Boolean);
  const supporting=used.length?used:exactSources;
  const sourceTexts=supporting.map(x=>`${x.title||''} ${x.content||''}`);
  let serialNumber=provisional.serialNumber;
  const initialCatalog=buildVariantCatalog(exactSources,exactGooglePages);
  let serialVision=null;
  if(!serialNumber && initialCatalog.some(x=>(x.denominators||[]).length) && backImage){
    serialVision=await readSerialNumberVision(env,backImage,initialCatalog);
    if(serialVision)serialNumber=serialVision.serial;
  }
  const split=separateSetAndVariation(identity.set,identity.variation,[...sourceTexts,...exactGooglePages.map(p=>p.title||'')],serialNumber);
  identity.set=split.set;
  identity.variation=split.variation;
  let variantResolution=resolveVariantEvidence(identity.variation,serialNumber,exactSources,exactGooglePages);
  let variantVisual=null;
  if(variantResolution.status==='unresolved' && !serialNumber && frontImage){
    variantVisual=await inspectVariantVisual(env,frontImage,variantResolution.catalog);
    if(variantVisual && !(variantVisual.candidate.denominators||[]).length && variantVisual.candidate.weight>=6){
      variantResolution={...variantResolution,variation:variantVisual.candidate.name,status:'probable',matched:variantVisual.candidate,reason:'High-confidence visual cue matched a documented unnumbered parallel.'};
    }
  }
  identity.variation=variantResolution.variation;
  if (identity.subject && !sourceTexts.some(t=>containsSubject(t,identity.subject))) identity.subject=null;
  if (identity.year && !sourceTexts.some(t=>new RegExp(`\\b${identity.year}\\b`).test(t))) identity.year=null;
  if (identity.set && !sourceTexts.some(t=>containsSet(t,identity.set))) identity.set=null;
  if (identity.variation && variantResolution.status!=='verified' && variantResolution.status!=='probable') identity.variation=null;

  const uniqueStrongDomains=new Set(exactSources.filter(x=>x.trustTier>=3).map(x=>x.domain));
  const officialCount=exactSources.filter(x=>x.trustTier===4).length;
  const strongCount=exactSources.filter(x=>x.trustTier>=3).length;
  const googleFull=exactGooglePages.reduce((n,p)=>n+(p.fullMatches||0),0);
  const subjectSupported=Boolean(identity.subject && exactSources.some(x=>containsSubject(`${x.title||''} ${x.content||''}`,identity.subject)));
  const yearSupported=Boolean(identity.year && exactSources.some(x=>new RegExp(`\\b${identity.year}\\b`).test(`${x.title||''} ${x.content||''}`)));
  const setSupported=Boolean(identity.set && exactSources.some(x=>containsSet(`${x.title||''} ${x.content||''}`,identity.set)));
  const codeSupported=Boolean(identity.cardNo && exactSources.some(x=>strictCardCodePresent(`${x.title||''} ${x.content||''}`,identity.cardNo)));

  const physicalOcrText=`${google?.front?.fullText||''}\n${google?.back?.fullText||''}`;
  const physicalCodeSupported=Boolean(identity.cardNo && strictCardCodePresent(physicalOcrText,identity.cardNo));
  const physicalSubjectSupported=Boolean(identity.subject && containsSubject(physicalOcrText,identity.subject));
  const matchingImageSupport=Boolean(exactGooglePages.some(p=>(p.fullMatches||0)>0 || (p.partialMatches||0)>0));
  const contradictionCount=contradictorySources.length;
  const referenceCount=exactSources.filter(x=>x.trustTier>=2).length;

  const verification_status=evaluateCoreVerification({
    codeSupported,subjectSupported,yearSupported,setSupported,
    physicalCodeSupported,physicalSubjectSupported,matchingImageSupport,
    strongDomainCount:uniqueStrongDomains.size,officialCount,strongCount,referenceCount,contradictionCount
  });

  // Core card identity and variant identity are intentionally separate.
  // An unresolved parallel blocks market valuation, not the pre-grade pipeline.
  const core_verification_status=verification_status;

  let confidence=20;
  if (codeSupported) confidence+=30;
  if (subjectSupported) confidence+=18;
  if (yearSupported) confidence+=10;
  if (setSupported) confidence+=8;
  confidence+=Math.min(16,uniqueStrongDomains.size*8);
  confidence+=Math.min(8,officialCount*8);
  if (googleFull>0) confidence+=5;
  confidence-=Math.min(30,contradictionCount*12);
  if (identity.set) confidence+=5;
  if (verification_status==='unverified') confidence=Math.min(confidence,69);
  if (verification_status==='probable') confidence=Math.min(confidence,84);
  if (verification_status==='verified') confidence=Math.max(confidence,92);
  if (variantResolution.status==='verified') confidence+=3;
  if (variantResolution.status==='unresolved') confidence=Math.min(confidence,84);
  confidence=clamp(Math.round(confidence),0,99);

  const sources=exactSources.slice(0,10).map(x=>({title:x.title,url:x.url,domain:x.domain,trustTier:x.trustTier,exactCardCode:true}));
  const evidence=[];
  if (codeSupported) evidence.push(`Exact card code ${identity.cardNo} found in trusted online source${uniqueStrongDomains.size===1?'':'s'}.`);
  if (subjectSupported) evidence.push(`Trusted sources tie ${identity.subject} to ${identity.cardNo}.`);
  if (yearSupported) evidence.push(`Product year ${identity.year} is sourced online rather than inferred from card statistics.`);
  if (setSupported) evidence.push(`Set/insert identity is supported by the trusted exact-card sources.`);
  if (uniqueStrongDomains.size>=2) evidence.push(`${uniqueStrongDomains.size} independent established source domains agree on the exact card.`);
  if (physicalCodeSupported) evidence.push(`Physical-card OCR independently supports full card code ${identity.cardNo}.`);
  if (physicalSubjectSupported) evidence.push(`Physical-card OCR independently supports subject ${identity.subject}.`);
  if (matchingImageSupport) evidence.push('Google visual-web matching independently supports an exact-card page/image path.');
  if (contradictionCount) evidence.push(`${contradictionCount} conflicting source result${contradictionCount===1?' was':'s were'} rejected as negative evidence.`);
  if (serialNumber) evidence.push(`Serial-number evidence detected on the card: ${serialNumber}${serialVision?' (targeted visual/OCR verification)':''}.`);
  if (variantResolution.status==='verified') evidence.push(`Parallel ${identity.variation} was tied to the detected serial denominator by trusted-source evidence.`);
  if (variantResolution.status==='unresolved') evidence.push('Parallel/variation was intentionally withheld because the evidence conflicts or is incomplete.');

  let reviewReason=null;
  if (verification_status==='unverified') reviewReason='Exact core identity could not be established from trusted online sources.';
  else if (variantResolution.status==='unresolved') reviewReason=variantResolution.reason||'Core identity is established; parallel/variation still needs additional evidence.';
  else if (verification_status==='probable') reviewReason='Core identity is probable but additional corroboration is recommended.';

  const field_confidence={
    cardNo:codeSupported?clamp(88+uniqueStrongDomains.size*4,0,99):35,
    subject:subjectSupported?clamp(84+uniqueStrongDomains.size*4,0,99):35,
    year:yearSupported?clamp(82+uniqueStrongDomains.size*4,0,99):35,
    set:setSupported?clamp(80+uniqueStrongDomains.size*4,0,99):35,
    variation:variantResolution.status==='verified'?96:variantResolution.status==='probable'?78:variantResolution.status==='unresolved'?20:(identity.variation?55:40),
    serialNumber:serialNumber?(serialVision?Math.max(90,serialVision.confidence):92):0,
  };
  const evidence_graph={
    cardNo:{value:identity.cardNo,physicalOcr:physicalCodeSupported,matchingImageSupport,supportingDomains:[...new Set(exactSources.filter(x=>strictCardCodePresent(`${x.title||''} ${x.content||''}`,identity.cardNo)).map(x=>x.domain))]},
    subject:{value:identity.subject,physicalOcr:physicalSubjectSupported,supportingDomains:[...new Set(exactSources.filter(x=>containsSubject(`${x.title||''} ${x.content||''}`,identity.subject)).map(x=>x.domain))]},
    year:{value:identity.year,supportingDomains:[...new Set(exactSources.filter(x=>identity.year&&new RegExp(`\\b${identity.year}\\b`).test(`${x.title||''} ${x.content||''}`)).map(x=>x.domain))]},
    set:{value:identity.set,supportingDomains:[...new Set(exactSources.filter(x=>containsSet(`${x.title||''} ${x.content||''}`,identity.set)).map(x=>x.domain))]},
    variation:{value:identity.variation,status:variantResolution.status,reason:variantResolution.reason,candidates:variantResolution.catalog.map(x=>({name:x.name,denominators:x.denominators,weight:x.weight})),visualArbitration:variantVisual?{candidate:variantVisual.candidate.name,confidence:variantVisual.confidence,cues:variantVisual.visible_cues}:null},
    serialNumber:{value:serialNumber,source:serialNumber?(serialVision?'targeted back-photo serial verifier':'physical-card OCR'):null,evidence:serialVision?.evidence||null},
    provenance:{year:'trusted online source',set:'trusted online source',subject:'trusted online source',cardNo:'trusted online source + physical OCR clue',variation:identity.variation?'trusted source/serial or visual arbitration':'unresolved',serialNumber:serialNumber?(serialVision?'targeted visual OCR':'physical OCR'):'none'},
    contradictions:contradictorySources.slice(0,8).map(x=>({title:x.title,url:x.url,fullCodes:x.fullCodes,subjectMatch:x.subjectMatch})),
  };
  const reference_images=[...new Set(exactGooglePages
    .filter(p=>(p.fullMatches>0) || (p.partialMatches>0 && p.trustTier>=2))
    .flatMap(p=>p.referenceImages||[])
    .filter(Boolean))].slice(0,8);

  return {
    identity,
    identity_confidence:confidence,
    verification_status,
    evidence,
    sources,
    core_verification_status,
    needs_review:verification_status!=='verified' || variantResolution.status==='unresolved',
    review_reason:reviewReason,
    selected_card_code:selectedCode,
    serial_number:serialNumber,
    variant_status:variantResolution.status,
    field_confidence,
    evidence_graph,
    reference_images,
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


function finalAnalysisIntegrity(analysis){
  const issues=[],critical=[];
  const i=analysis?.identity||{},c=analysis?.condition||{};
  const core=analysis?.core_verification_status||analysis?.verification_status;
  if(['verified','locked'].includes(core)){
    for(const k of ['year','set','subject','cardNo'])if(!i[k])critical.push(`verified core identity missing ${k}`);
    if(analysis?.selected_card_code && normalizeLooseToken(analysis.selected_card_code)!==normalizeLooseToken(i.cardNo))critical.push('selected card code differs from displayed card number');
  }
  const complete=['corners','edges','surface','focus'].every(k=>conditionNumber(c[k])!==null);
  if(Number(analysis?.condition_confidence||0)>=45&&!complete)critical.push('condition confidence claims readiness while one or more condition fields are missing');
  for(const side of ['front','back']){
    const cent=c?.sides?.[side]?.centering;
    if(cent?.lr&&cent?.tb){
      const worst=Math.max(...cent.lr.map(Number),...cent.tb.map(Number));
      if(worst>68)critical.push(`${side} automatic centering exceeded 68/32 integrity ceiling`);
    }
  }
  if(analysis?.variant_status==='unresolved')issues.push('parallel/variation unresolved; market valuation must remain blocked');
  if(Number(analysis?.condition_confidence||0)<45)issues.push('condition evidence is not ready for grading');
  return {ok:critical.length===0,critical,issues};
}

function identityMarketReady(analysis) {
  const i=analysis?.identity||{};
  return Boolean(i.year && i.set && i.subject && i.cardNo &&
    ['verified','locked'].includes(analysis?.verification_status) &&
    analysis?.variant_status!=='unresolved');
}


async function runConditionPrimary(env, side, image, question) {
  const raw=await env.AI.run(CONDITION_PRIMARY_MODEL,{
    messages:[
      {role:'system',content:'You are a conservative trading-card condition inspector. Use only visible evidence from the supplied image.'},
      {role:'user',content:question},
    ],
    image,
    temperature:0,
    max_tokens:900,
    stream:false,
  });
  return {text:modelText(raw),model:CONDITION_PRIMARY_MODEL};
}

async function runConditionFallback(env, side, image, question) {
  const raw=await env.AI.run(CONDITION_FALLBACK_MODEL,{
    task:'query',image,question,reasoning:false,temperature:0,max_tokens:850,stream:false,
  });
  return {text:modelText(raw),model:CONDITION_FALLBACK_MODEL};
}


function conditionNumber(v){
  if(v===null||v===undefined||v==='')return null;
  const n=Number(v);
  return Number.isFinite(n)&&n>=1&&n<=10?n:null;
}
function conditionSupportText(x){
  return String([...(x?.notes||[]),...Object.entries(x?.defects||{}).filter(([,v])=>v).map(([k])=>k)].join(' ')).toLowerCase();
}
function conditionIntegrityIssues(x){
  if(!x||typeof x!=='object')return ['missing condition result'];
  const issues=[];
  const fields=['corners','edges','surface','focus'];
  const vals=fields.map(k=>conditionNumber(x[k])).filter(v=>v!==null);
  const support=conditionSupportText(x);
  const defectCount=Object.values(x?.defects||{}).filter(Boolean).length;
  if(vals.length===4 && vals.every(v=>v<=2) && defectCount===0) issues.push('catastrophic scores without visible defect evidence');
  const evidenceWords=/wear|damage|chip|whiten|round|soft|fuzz|scratch|scuff|crease|dent|stain|mark|print|line|registration|focus|surface loss|corner/i;
  for(const k of fields){
    const v=conditionNumber(x[k]);
    if(v!==null&&v<7&&defectCount===0&&!evidenceWords.test(support))issues.push(`${k} below 7 without supporting evidence`);
  }
  return [...new Set(issues)];
}
function sanitizeConditionAssessment(x){
  if(!x||typeof x!=='object')return null;
  const out={...x,defects:{...(x.defects||{})},notes:Array.isArray(x.notes)?[...x.notes]:[]};
  const issues=conditionIntegrityIssues(out);
  if(issues.some(z=>z.includes('catastrophic'))){
    for(const k of ['corners','edges','surface','focus'])out[k]=null;
    out.confidence=0;
    out.notes.push('Condition scores rejected because the model reported catastrophic values without corresponding visible defects.');
  }else{
    const support=conditionSupportText(out);
    const evidenceWords=/wear|damage|chip|whiten|round|soft|fuzz|scratch|scuff|crease|dent|stain|mark|print|line|registration|focus|surface loss|corner/i;
    const defectCount=Object.values(out.defects||{}).filter(Boolean).length;
    for(const k of ['corners','edges','surface','focus']){
      const v=conditionNumber(out[k]);
      if(v!==null&&v<7&&defectCount===0&&!evidenceWords.test(support)){
        out[k]=null;
        out.notes.push(`${k} score withheld because a sub-7 score lacked visible supporting evidence.`);
      }
    }
  }
  out.integrityIssues=conditionIntegrityIssues(out);
  return out;
}
function conditionNeedsArbitration(x){
  if(!x)return true;
  if(conditionCompleteness(x)<4)return true;
  if((x.integrityIssues||conditionIntegrityIssues(x)).length)return true;
  if(Number(x.agreement)>2)return true;
  return false;
}
function conditionNeedsConsensus(x) {
  if(!x || conditionIntegrityIssues(x).length)return true;
  if(conditionCompleteness(x)<4)return true;
  if(Number(x?.confidence||0)<35)return true;
  if(['corners','edges','surface','focus'].some(k=>{const v=conditionNumber(x?.[k]);return v!==null&&v<8.5}))return true;
  if(Object.values(x?.defects||{}).some(Boolean))return true;
  return false;
}

function calibrateConditionConfidence(x, photoQuality, agreement=null) {
  const complete=conditionCompleteness(x);
  if(complete<4)return Math.min(30,Number(x?.confidence||0));
  const q=Number.isFinite(Number(photoQuality))?clamp(Number(photoQuality),0,100):70;
  const model=clamp(Number(x?.confidence||0),0,100);
  let conf=44 + q*.34 + model*.16;
  if(Number.isFinite(agreement))conf += clamp((1.6-agreement)*10,-18,10);
  if(!(x?.notes||[]).length)conf-=6;
  return clamp(Math.round(conf),35,94);
}

function mergeConditionConsensus(a,b,side,photoQuality) {
  const out={side,defects:{},notes:[]};
  let diffSum=0,diffN=0,conflicts=0;
  for(const k of ['corners','edges','surface','focus']){
    const av=conditionNumber(a?.[k]),bv=conditionNumber(b?.[k]);
    if(av!==null&&bv!==null){
      const d=Math.abs(av-bv);diffSum+=d;diffN++;
      if(d>2){out[k]=null;conflicts++}
      else out[k]=clampHalf(Math.min(av,bv),1,10);
    }else out[k]=av!==null?av:bv!==null?bv:null;
  }
  for(const k of ['crease','dent','stain','scratch','printline','mark','possible_alteration'])out.defects[k]=Boolean(a?.defects?.[k]||b?.defects?.[k]);
  const agreement=diffN?diffSum/diffN:null;
  const centA=a?.centering,centB=b?.centering;
  const pairClose=(p,q)=>Array.isArray(p)&&Array.isArray(q)&&Math.abs(Math.max(...p)-Math.max(...q))<=7;
  out.centering={
    lr:pairClose(centA?.lr,centB?.lr)?centA.lr:null,
    tb:pairClose(centA?.tb,centB?.tb)?centA.tb:null,
    confidence:pairClose(centA?.lr,centB?.lr)&&pairClose(centA?.tb,centB?.tb)?Math.min(Number(centA?.confidence||0),Number(centB?.confidence||0)):0,
  };
  out.notes=Array.from(new Set([...(a?.notes||[]),...(b?.notes||[]),conflicts?'One or more condition categories were withheld because the two vision passes disagreed materially.':null].filter(Boolean))).slice(0,8);
  out.confidence=calibrateConditionConfidence(out,photoQuality,agreement);
  if(conflicts)out.confidence=Math.min(out.confidence,68);
  out.modelPath='Gemma 4 + Moondream consensus';
  out.agreement=agreement==null?null:+agreement.toFixed(2);
  return out;
}



function parseSeverityKV(text,side,photoQuality){
  const vals={};
  for(const line of String(text||'').split(/\r?\n/)){
    const m=line.trim().match(/^([A-Z_]+)\s*[:=]\s*(.*)$/i);
    if(m)vals[m[1].toUpperCase()]=m[2].trim();
  }
  const obj={defects:[],confidence:Number(String(vals.CONFIDENCE||'').match(/\d+/)?.[0]||0)};
  for(const k of ['CORNERS','EDGES','SURFACE','FOCUS']){
    obj[k.toLowerCase()]={severity:normalizeConditionSeverity(vals[k]),evidence:clean(vals[k+'_EVIDENCE'])};
  }
  const def=String(vals.DEFECTS||'').toLowerCase();
  if(def && !/\bnone\b/.test(def))obj.defects=def.split(/[,;|]/).map(x=>x.trim().replace(/[- ]/g,'_')).filter(Boolean);
  obj.center_lr=vals.CENTER_LR||null;obj.center_tb=vals.CENTER_TB||null;
  obj.center_confidence=Number(String(vals.CENTER_CONFIDENCE||'').match(/\d+/)?.[0]||0);
  return conditionFromSeverityObject(obj,side,photoQuality,'Moondream categorical');
}
function conditionInspectionPrompt(side){
  return `Inspect physical condition on the ${side} of a raw trading card.
The image may be a Card Lab INSPECTION SHEET: a full-card view plus enlarged labeled corner and edge crops from the SAME photograph. If labels are present, use the enlarged crops for corners/edges and the full-card view for surface/print registration.

Classify each category using ONLY:
NONE, MINUTE, MINOR, MODERATE, MAJOR, SEVERE, UNKNOWN.

Definitions:
- NONE: no visible issue at this image resolution.
- MINUTE: tiny issue visible only on close inspection.
- MINOR: small but clearly visible issue.
- MODERATE: obvious issue that would materially affect grade.
- MAJOR/SEVERE: substantial damage.
- UNKNOWN: image does not support a reliable judgment.

Do NOT identify the card. Do NOT assign numeric grades. Do NOT treat camera blur/glare/background as card damage.
MODERATE or worse MUST name the visible defect in evidence.
Return exactly these KEY=VALUE lines:
CORNERS=...
CORNERS_EVIDENCE=...
EDGES=...
EDGES_EVIDENCE=...
SURFACE=...
SURFACE_EVIDENCE=...
FOCUS=...
FOCUS_EVIDENCE=...
DEFECTS=NONE or comma-separated crease,dent,stain,scratch,printline,mark,possible_alteration
CONFIDENCE=0-100
CENTER_LR=UNKNOWN
CENTER_TB=UNKNOWN
CENTER_CONFIDENCE=0`;
}

function severityWordFromText(text){
  const m=String(text||'').toLowerCase().match(/\b(none|minute|minor|moderate|major|severe|unknown|clean|mint|tiny|trace|negligible|light|small|slight|medium|noticeable|heavy|significant|extreme|uncertain)\b/);
  return normalizeConditionSeverity(m?.[1]||'unknown');
}
function sanitizeModelEvidence(value){
  let t=String(value??'').replace(/```/g,' ').trim();
  if(!t)return null;
  t=t.split(/"\s*,\s*"(?:caption|finish_reason|metrics|usage|reasoning|model|id|object)"\s*:/i)[0];
  t=t.split(/\b(?:caption|finish_reason|metrics|usage|prompt_tokens|completion_tokens|decode_time_ms|input_tokens|output_tokens)\b\s*[:=]/i)[0];
  t=t.replace(/[}\]"]+\s*$/g,'').replace(/\\n/g,' ').replace(/\s+/g,' ').trim();
  if(!t)return null;
  if(/^(?:none|unknown|n\/?a|null|short visible evidence(?: or none)?|actual visible evidence|evidence)$/i.test(t))return null;
  if(/[{}[\]]/.test(t)||t.length>220)return null;
  return clean(t);
}

function evidenceFromLooseText(text){
  const t=String(text||'').replace(/```/g,' ').replace(/\r/g,' ').trim();
  if(!t)return null;
  const explicit=t.match(/EVIDENCE\s*[:=]\s*([^\n\r]*)/i)?.[1];
  let cleaned=explicit!=null?explicit:t.replace(/^(?:severity\s*[:=]\s*)?(?:none|minute|minor|moderate|major|severe|unknown)\b[\s|:;,-]*/i,'');
  cleaned=String(cleaned||'').replace(/^EVIDENCE\s*[:=]\s*/i,'').trim();
  return sanitizeModelEvidence(cleaned);
}
function defectsFromEvidence(notes=[]){
  const joined=String((notes||[]).join(' ')).toLowerCase();
  const out={};
  for(const k of ['crease','dent','stain','scratch','printline','mark','possible_alteration']){
    if(k==='printline')out[k]=/\bprint\s*line\b|\bprintline\b/.test(joined);
    else if(k==='possible_alteration')out[k]=/\balter(?:ed|ation)\b|\btrimmed\b/.test(joined);
    else out[k]=new RegExp(`\\b${k}\\b`,'i').test(joined);
  }
  return out;
}
function parseSeverityFlexible(text,side,photoQuality,modelPath){
  const raw=String(text||'').trim();
  if(raw){
    const cleaned=raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'');
    const a=cleaned.indexOf('{'),b=cleaned.lastIndexOf('}');
    if(a>=0&&b>a){
      try{
        const obj=JSON.parse(cleaned.slice(a,b+1));
        const out=conditionFromSeverityObject(obj,side,photoQuality,modelPath);
        if(out)return out;
      }catch{}
    }
  }
  const out=parseSeverityKV(raw,side,photoQuality);
  if(out)out.modelPath=modelPath;
  return out;
}
async function runMoondreamCategorical(env,side,image,photoQuality){
  try{
    const raw=await env.AI.run(CONDITION_FALLBACK_MODEL,{
      task:'query',image,question:conditionInspectionPrompt(side),reasoning:false,temperature:0,max_tokens:900,stream:false
    });
    return parseSeverityFlexible(modelText(raw),side,photoQuality,'Moondream inspection-sheet categorical');
  }catch(e){console.warn('Moondream categorical:',e);return null}
}
async function runRegionStructuredCategorical(env,side,image,photoQuality){
  const schema={
    type:'object',
    properties:{
      corners:{type:'object',properties:{severity:{type:'string'},evidence:{type:['string','null']}},required:['severity','evidence']},
      edges:{type:'object',properties:{severity:{type:'string'},evidence:{type:['string','null']}},required:['severity','evidence']},
      surface:{type:'object',properties:{severity:{type:'string'},evidence:{type:['string','null']}},required:['severity','evidence']},
      focus:{type:'object',properties:{severity:{type:'string'},evidence:{type:['string','null']}},required:['severity','evidence']},
      defects:{type:'array',items:{type:'string'}},
      confidence:{type:'number'}
    },
    required:['corners','edges','surface','focus','defects','confidence']
  };
  const prompt=`Inspect physical condition on the ${side} of a raw trading card.
The image may be a Card Lab inspection sheet containing a full-card view plus enlarged labeled corner and edge crops from the SAME photograph. Use the labeled enlargements for corners/edges and the full-card view for surface and print registration.

For corners, edges, surface, and focus classify severity as exactly one of:
none, minute, minor, moderate, major, severe, unknown.

Definitions:
none = no visible issue at this image resolution
minute = tiny issue visible only on close inspection
minor = small but clearly visible issue
moderate = obvious issue that materially affects grade
major/severe = substantial damage
unknown = insufficient visual evidence

Do not identify the card. Do not assign numeric condition scores. Do not treat glare, camera blur, shadows, or background as damage.
Moderate/major/severe must name the visible defect in evidence. Use unknown rather than guessing.`;

  try{
    const raw=await env.AI.run(CONDITION_REGION_MODEL,{
      messages:[
        {role:'system',content:'Inspect only visible trading-card condition. Return structured categorical observations and fail closed on uncertainty.'},
        {role:'user',content:prompt}
      ],
      image,
      response_format:{type:'json_schema',json_schema:schema},
      temperature:0,
      max_tokens:700,
      stream:false
    });
    let obj=null;
    try{obj=structuredModelResult(raw,'structured condition')}catch{}
    if(!obj){
      const txt=modelText(raw);
      try{obj=parseModelJSON(txt,'structured condition')}catch{}
    }
    const out=conditionFromSeverityObject(obj,side,photoQuality,'Gemma structured inspection-sheet categorical');
    return sanitizeConditionAssessment(out);
  }catch(e){
    console.warn('Gemma structured condition:',e);
    return null;
  }
}

async function runMoondreamTargetedField(env,side,image,field){
  const q=`Inspect ONLY the ${field} condition on the ${side} of this raw trading card.
The image may contain a full-card view plus enlarged labeled crops from the SAME photograph.
Respond on ONE LINE only.
Write SEVERITY= followed by exactly one allowed severity.
Then write | EVIDENCE=NONE if no defect is visible, otherwise write a concrete description of what is visibly wrong.
Do not repeat these instructions or any example wording.
Do not identify the card. Do not assign a numeric grade. Ignore glare/background/camera blur. UNKNOWN rather than guessing.`;
  try{
    const raw=await env.AI.run(CONDITION_FALLBACK_MODEL,{
      task:'query',image,question:q,reasoning:false,temperature:0,max_tokens:180,stream:false
    });
    const text=modelText(raw);
    let severity=normalizeConditionSeverity(
      text.match(/SEVERITY\s*[:=]\s*([A-Z]+)/i)?.[1] || severityWordFromText(text)
    );
    let evidence=sanitizeModelEvidence(text.match(/EVIDENCE\s*[:=]\s*([^\n\r]*)/i)?.[1]) || evidenceFromLooseText(text);
    if((CONDITION_SEVERITY_RANK[severity]??99)>=3&&!evidence)severity='unknown';
    return {severity,evidence,raw:cleanLong(text,500)};
  }catch(e){
    console.warn(`Moondream targeted ${side} ${field}:`,e);
    return {severity:'unknown',evidence:null,error:cleanError(e)};
  }
}

const CONDITION_SEVERITY_RANK=Object.freeze({none:0,minute:1,minor:2,moderate:3,major:4,severe:5,unknown:99});
const CONDITION_SEVERITY_SCORE=Object.freeze({none:10,minute:9.5,minor:8.5,moderate:7.5,major:6,severe:4});

function normalizeConditionSeverity(v){
  const x=String(v??'').toLowerCase().trim().replace(/[^a-z]/g,'');
  if(!x||['unknown','uncertain','na','null','unjudgeable'].includes(x))return 'unknown';
  if(['none','clean','mint','novisibleissue','nodefect'].includes(x))return 'none';
  if(['minute','tiny','trace','negligible'].includes(x))return 'minute';
  if(['minor','light','small','slight'].includes(x))return 'minor';
  if(['moderate','medium','noticeable'].includes(x))return 'moderate';
  if(['major','heavy','significant'].includes(x))return 'major';
  if(['severe','extreme','verymajor'].includes(x))return 'severe';
  return 'unknown';
}
function severityField(v){
  if(v&&typeof v==='object'&&!Array.isArray(v)){
    const evidence=sanitizeModelEvidence(v.evidence??v.note??v.reason);
    return {severity:normalizeConditionSeverity(v.severity??v.level??v.rating),evidence};
  }
  return {severity:normalizeConditionSeverity(v),evidence:null};
}
function conditionFromSeverityObject(obj,side,photoQuality,modelPath='severity vision'){
  if(!obj||typeof obj!=='object')return null;
  const out={side,defects:{},notes:[],severity:{},centering:{lr:null,tb:null,confidence:0},modelPath};
  let complete=0,evidenceCount=0;
  for(const k of ['corners','edges','surface','focus']){
    const f=severityField(obj[k]);
    out.severity[k]=f.severity;
    const rank=CONDITION_SEVERITY_RANK[f.severity];
    if(rank!==99){
      // Damage of moderate severity or worse requires the model to name what it saw.
      if(rank>=3 && !f.evidence){
        out[k]=null;
        out.severity[k]='unknown';
      }else{
        out[k]=CONDITION_SEVERITY_SCORE[f.severity];
        complete++;
        if(f.evidence){
          evidenceCount++;
          out.notes.push(`${k[0].toUpperCase()+k.slice(1)}: ${f.evidence}`);
        }
      }
    }else out[k]=null;
  }
  const defectList=Array.isArray(obj.defects)?obj.defects.map(x=>String(x).toLowerCase().replace(/[- ]/g,'_')):[];
  for(const k of ['crease','dent','stain','scratch','printline','mark','possible_alteration'])out.defects[k]=defectList.includes(k);
  const lr=parsePair(obj.center_lr??obj.centering?.lr),tb=parsePair(obj.center_tb??obj.centering?.tb);
  const centerConfidence=clamp(Math.round(Number(obj.center_confidence??obj.centering?.confidence)||0),0,100);
  if(lr&&tb)out.centering={lr,tb,confidence:centerConfidence};
  const rawConfidence=clamp(Math.round(Number(obj.confidence)||0),0,100);
  const q=Number.isFinite(Number(photoQuality))?clamp(Number(photoQuality),0,100):70;
  let conf=complete===4 ? 48 + q*.28 + rawConfidence*.20 + Math.min(8,evidenceCount*2) : Math.min(35,rawConfidence);
  if(defectList.length)conf-=3;
  out.confidence=clamp(Math.round(conf),0,94);
  out.rawModelConfidence=rawConfidence;
  return sanitizeConditionAssessment(out);
}
function severityNeedsSecond(x){
  if(!x||conditionCompleteness(x)<4||Number(x.confidence||0)<65)return true;
  if(Object.values(x.defects||{}).some(Boolean))return true;
  return ['corners','edges','surface','focus'].some(k=>{
    const sev=x?.severity?.[k]||'unknown';
    return (CONDITION_SEVERITY_RANK[sev]??99)>=2;
  });
}
function mergeSeverityConsensus(a,b,side,photoQuality){
  const out={side,defects:{},notes:[],severity:{},centering:{lr:null,tb:null,confidence:0},modelPath:'severity consensus'};
  let agreements=0,known=0,conflicts=0;
  for(const k of ['corners','edges','surface','focus']){
    const as=a?.severity?.[k]||'unknown',bs=b?.severity?.[k]||'unknown';
    const ar=CONDITION_SEVERITY_RANK[as]??99,br=CONDITION_SEVERITY_RANK[bs]??99;
    let chosen='unknown';
    if(ar===99&&br!==99)chosen=bs;
    else if(br===99&&ar!==99)chosen=as;
    else if(ar!==99&&br!==99){
      known++;
      if(Math.abs(ar-br)<=1){chosen=ar>=br?as:bs;agreements++}
      else conflicts++;
    }
    out.severity[k]=chosen;
    out[k]=chosen==='unknown'?null:CONDITION_SEVERITY_SCORE[chosen];
  }
  for(const k of ['crease','dent','stain','scratch','printline','mark','possible_alteration'])out.defects[k]=Boolean(a?.defects?.[k]||b?.defects?.[k]);
  const pairClose=(p,q)=>Array.isArray(p)&&Array.isArray(q)&&Math.abs(Math.max(...p.map(Number))-Math.max(...q.map(Number)))<=6;
  if(pairClose(a?.centering?.lr,b?.centering?.lr)&&pairClose(a?.centering?.tb,b?.centering?.tb)){
    out.centering={lr:a.centering.lr,tb:a.centering.tb,confidence:Math.min(Number(a.centering.confidence||0),Number(b.centering.confidence||0))};
  }
  out.notes=Array.from(new Set([...(a?.notes||[]),...(b?.notes||[]),conflicts?'Disputed condition categories were withheld pending arbitration.':null].filter(Boolean))).slice(0,10);
  const q=Number.isFinite(Number(photoQuality))?clamp(Number(photoQuality),0,100):70;
  const base=conditionCompleteness(out)===4 ? 52 + q*.28 + (known?agreements/known*18:0) : 28;
  out.confidence=clamp(Math.round(base-conflicts*10),0,92);
  out.disputedFields=['corners','edges','surface','focus'].filter(k=>out[k]===null);
  return sanitizeConditionAssessment(out);
}
async function runSeverityVision(env,model,side,image,photoQuality,targetFields=null){
  const fields=targetFields?.length?targetFields:['corners','edges','surface','focus'];
  const prompt=`Inspect ONLY visible physical condition on the ${side} of this raw trading card.
For each requested category (${fields.join(', ')}), classify severity using ONLY:
none, minute, minor, moderate, major, severe, unknown.

Return ONLY JSON:
{"corners":{"severity":"none|minute|minor|moderate|major|severe|unknown","evidence":string|null},
"edges":{"severity":"...","evidence":string|null},
"surface":{"severity":"...","evidence":string|null},
"focus":{"severity":"...","evidence":string|null},
"defects":["crease"|"dent"|"stain"|"scratch"|"printline"|"mark"|"possible_alteration"],
"confidence":number,
"center_lr":"55/45"|null,"center_tb":"52/48"|null,"center_confidence":number}

Rules:
- Do not identify the card.
- Do not output numeric condition scores.
- "none" means no visible defect at this photo resolution.
- moderate/major/severe MUST name the visible defect in evidence.
- focus means card print/registration, not camera sharpness.
- Centering must be null unless a true printed outer frame/border is clearly measurable.
- If uncertain, use unknown rather than guessing.`;
  try{
    let text='';
    if(model===CONDITION_FALLBACK_MODEL){
      const raw=await env.AI.run(model,{task:'query',image,question:prompt,reasoning:false,temperature:0,max_tokens:900,stream:false});
      text=modelText(raw);
    }else{
      const raw=await env.AI.run(model,{messages:[
        {role:'system',content:'You classify visible trading-card condition severity. Use categorical labels only and fail closed on uncertainty.'},
        {role:'user',content:prompt}
      ],image,temperature:0,max_tokens:900,stream:false});
      text=modelText(raw);
    }
    const obj=parseModelJSON(text,'condition severity');
    return conditionFromSeverityObject(obj,side,photoQuality,model===CONDITION_PRIMARY_MODEL?'Gemma 4 severity':'Moondream severity');
  }catch(e){console.warn('Severity condition vision:',model,e);return null}
}
async function runSeverityArbitrator(env,side,image,photoQuality,fields){
  if(!fields?.length)return null;
  return runSeverityVision(env,CONDITION_PRIMARY_MODEL,side,image,photoQuality,fields);
}

async function inspectConditionSide(env, side, image, photoQuality=null, inspectionImage=null) {
  const visual=inspectionImage||image;

  // Pass 1: structured Gemma vision on the inspection sheet.
  let primary=await runRegionStructuredCategorical(env,side,visual,photoQuality);

  // Pass 2: Moondream asks one tiny question per unresolved category. This uses
  // the documented query/answer interface and does not depend on another model license.
  const missing=['corners','edges','surface','focus'].filter(k=>!primary||primary[k]==null);
  if(missing.length){
    if(!primary){
      primary={side,defects:{crease:false,dent:false,stain:false,scratch:false,printline:false,mark:false,possible_alteration:false},
        notes:[],severity:{},centering:{lr:null,tb:null,confidence:0},confidence:0,modelPath:'Moondream targeted categorical'};
      for(const k of ['corners','edges','surface','focus'])primary[k]=null;
    }
    const targeted=await Promise.all(missing.map(k=>runMoondreamTargetedField(env,side,visual,k)));
    for(let i=0;i<missing.length;i++){
      const k=missing[i],r=targeted[i];
      const rank=CONDITION_SEVERITY_RANK[r?.severity||'unknown']??99;
      if(rank<99 && (rank<3 || r?.evidence)){
        primary.severity[k]=r.severity;
        primary[k]=CONDITION_SEVERITY_SCORE[r.severity];
        if(r.evidence)primary.notes.push(`${k[0].toUpperCase()+k.slice(1)}: ${r.evidence}`);
      }
    }
    const inferred=defectsFromEvidence(primary.notes);
    primary.defects={...(primary.defects||{}),...Object.fromEntries(
      Object.entries(inferred).map(([k,v])=>[k,Boolean(v||primary.defects?.[k])])
    )};
    primary=sanitizeConditionAssessment(primary);
  }

  // If all four categories are present, confidence is deterministic from image
  // quality and evidence completeness, not from a model's self-reported confidence.
  if(primary&&conditionCompleteness(primary)===4){
    const q=Number.isFinite(Number(photoQuality))?clamp(Number(photoQuality),0,100):70;
    const evidenceCount=(primary.notes||[]).length;
    const anyDefect=Object.values(primary.defects||{}).some(Boolean);
    let conf=60 + q*.22 + Math.min(10,evidenceCount*2);
    if(anyDefect)conf-=3;
    primary.confidence=clamp(Math.round(conf),62,92);
    primary.modelPath=(primary.modelPath||'Gemma structured') + (missing.length?' + Moondream targeted repair':'');
    return sanitizeConditionAssessment(primary);
  }

  if(primary){
    primary.confidence=Math.min(Number(primary.confidence||0),34);
    primary.notes=Array.from(new Set([...(primary.notes||[]),'One or more condition categories remained unsupported after structured and targeted inspection.'])).slice(0,10);
    return sanitizeConditionAssessment(primary);
  }

  return unknownConditionSide(side,'Condition inspection could not produce supported observations.');
}

async function runConditionArbitrator(env,side,image,fields){
  if(!fields?.length)return null;
  const prompt=`Re-check ONLY these condition fields on the ${side} of this raw trading card: ${fields.join(', ')}.
Return one JSON object with corners,edges,surface,focus,defects,confidence,notes. Fields not requested must be null.
Do not identify the card. Do not use 1 as a placeholder. A score below 7 requires a clearly visible named defect in notes or defects. If uncertain, return null.`;
  try{
    const raw=await env.AI.run(CONDITION_PRIMARY_MODEL,{
      messages:[
        {role:'system',content:'You are an independent dispute-resolution pass for visible trading-card condition. Fail closed on uncertainty.'},
        {role:'user',content:prompt}
      ],image,temperature:0,max_tokens:700,stream:false
    });
    const out=sanitizeConditionAssessment(parseConditionFlexible(modelText(raw),side));
    if(out)out.modelPath='Gemma 4 targeted arbitration';
    return out;
  }catch(e){console.warn('Condition arbitration:',e);return null}
}
function mergeConditionArbitration(base,arb,side,photoQuality){
  const out={...base,side,defects:{...(base?.defects||{})},notes:[...(base?.notes||[])]};
  for(const k of ['corners','edges','surface','focus']){
    const a=conditionNumber(out[k]),b=conditionNumber(arb?.[k]);
    if(a===null&&b!==null)out[k]=b;
    else if(a!==null&&b!==null&&Math.abs(a-b)<=1.5)out[k]=clampHalf(Math.min(a,b),1,10);
    else if(a!==null&&b!==null&&Math.abs(a-b)>2)out[k]=null;
  }
  for(const k of ['crease','dent','stain','scratch','printline','mark','possible_alteration'])out.defects[k]=Boolean(out.defects[k]||arb?.defects?.[k]);
  out.notes=Array.from(new Set([...out.notes,...(arb?.notes||[]),'A targeted third pass was used only for disputed condition fields.'])).slice(0,10);
  out.confidence=calibrateConditionConfidence(out,photoQuality,null);
  out.modelPath=`${base?.modelPath||'consensus'} + targeted arbitration`;
  return sanitizeConditionAssessment(out);
}

function safeRemoteImageUrl(value){
  try{
    const u=new URL(String(value||''));
    if(u.protocol!=='https:')return null;
    const h=u.hostname.toLowerCase();
    if(h==='localhost'||h.endsWith('.local')||/^127\./.test(h)||/^10\./.test(h)||/^192\.168\./.test(h)||/^169\.254\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h)||h==='::1')return null;
    return u.href;
  }catch{return null}
}
function arrayBufferToDataUrl(buf,type='image/jpeg'){
  const bytes=new Uint8Array(buf);let binary='';const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  return `data:${type};base64,${btoa(binary)}`;
}
async function fetchReferenceImageData(url){
  const safe=safeRemoteImageUrl(url);if(!safe)return null;
  const r=await fetch(safe,{headers:{'Accept':'image/*'}});
  if(!r.ok)return null;
  const type=String(r.headers.get('content-type')||'');
  if(!type.startsWith('image/'))return null;
  const len=Number(r.headers.get('content-length')||0);
  if(len>4_000_000)return null;
  const buf=await r.arrayBuffer();
  if(buf.byteLength>4_000_000)return null;
  return arrayBufferToDataUrl(buf,type.split(';')[0]||'image/jpeg');
}

function normalizedDetectionBox(obj){
  const b=obj?.box||obj||{};
  let xmin=Number(b.xmin??b.x_min??b.left),xmax=Number(b.xmax??b.x_max??b.right);
  let ymin=Number(b.ymin??b.y_min??b.top),ymax=Number(b.ymax??b.y_max??b.bottom);
  if(![xmin,xmax,ymin,ymax].every(Number.isFinite))return null;
  const max=Math.max(xmin,xmax,ymin,ymax);
  if(max>1.5&&max<=1000){xmin/=1000;xmax/=1000;ymin/=1000;ymax/=1000}
  if(xmin<0||ymin<0||xmax>1.02||ymax>1.02||xmax<=xmin||ymax<=ymin)return null;
  const score=Number(obj?.score??obj?.confidence);
  return {xmin,ymin,xmax,ymax,score:Number.isFinite(score)?score:null,label:clean(obj?.label)};
}
function boxArea(box){return box?(box.xmax-box.xmin)*(box.ymax-box.ymin):0}
function boxContains(outer,inner,tol=.015){
  return Boolean(outer&&inner&&inner.xmin>=outer.xmin-tol&&inner.ymin>=outer.ymin-tol&&inner.xmax<=outer.xmax+tol&&inner.ymax<=outer.ymax+tol);
}
function frameWithinCardMetrics(card,frame){
  if(!card||!frame||!boxContains(card,frame,.02))return null;
  const cw=card.xmax-card.xmin,ch=card.ymax-card.ymin;
  if(cw<=.05||ch<=.05)return null;
  const L=(frame.xmin-card.xmin)/cw,R=(card.xmax-frame.xmax)/cw;
  const T=(frame.ymin-card.ymin)/ch,B=(card.ymax-frame.ymax)/ch;
  const hsum=L+R,vsum=T+B;
  if(hsum<=.018||vsum<=.018)return null;
  if([L,R,T,B].some(v=>v<.004||v>.34))return null;
  const lr=[L/hsum*100,R/hsum*100],tb=[T/vsum*100,B/vsum*100];
  const worst=Math.max(...lr,...tb);
  const area=boxArea(frame)/boxArea(card);
  return {L,R,T,B,lr:lr.map(x=>+x.toFixed(1)),tb:tb.map(x=>+x.toFixed(1)),worst:+worst.toFixed(1),area:+area.toFixed(4)};
}
function suspiciousPerfectCentering(m){
  if(!m)return true;
  const near=(p,tol=.65)=>Array.isArray(p)&&Math.abs(Number(p[0])-50)<tol&&Math.abs(Number(p[1])-50)<tol;
  return near(m.lr)&&near(m.tb);
}
function modelObjects(raw){
  const seen=new Set();
  function walk(v,depth=0){
    if(!v||typeof v!=='object'||depth>6||seen.has(v))return [];
    seen.add(v);
    if(Array.isArray(v.objects))return v.objects;
    for(const key of ['response','result','data','output']){
      const found=walk(v[key],depth+1);
      if(found.length)return found;
    }
    return [];
  }
  return walk(raw);
}
async function detectBoxes(env,image,target,max_objects=8){
  const raw=await env.AI.run(CONDITION_FALLBACK_MODEL,{task:'detect',image,target,max_objects,stream:false});
  return modelObjects(raw).map(normalizedDetectionBox).filter(Boolean);
}
async function detectPrintedFrame(env,image){
  try{
    const [cards,frames]=await Promise.all([
      detectBoxes(env,image,'physical outer rectangular edges of the trading card',6),
      detectBoxes(env,image,'outermost printed rectangular frame or border inside the trading card',10)
    ]);
    const candidates=[];
    for(const card of cards){
      const cardArea=boxArea(card);
      if(cardArea<.20||cardArea>.99)continue;
      for(const frame of frames){
        const metrics=frameWithinCardMetrics(card,frame);
        if(!metrics)continue;
        if(metrics.area<.30||metrics.area>.96)continue;
        const cardScore=Number.isFinite(card.score)?card.score:.70;
        const frameScore=Number.isFinite(frame.score)?frame.score:.68;
        let rank=cardScore*.45+frameScore*.55-Math.max(0,metrics.worst-64)/120;
        if(suspiciousPerfectCentering(metrics))rank-=.12;
        candidates.push({cardBox:card,frameBox:frame,metrics,rank});
      }
    }
    candidates.sort((a,b)=>b.rank-a.rank);
    const best=candidates[0];
    if(!best)return null;
    let confidence=clamp(Math.round(best.rank*100),0,95);
    if(best.metrics.worst>68)confidence=Math.min(confidence,70);
    if(suspiciousPerfectCentering(best.metrics))confidence=Math.min(confidence,72);
    if(confidence<65)return null;
    return {...best.metrics,cardBox:best.cardBox,box:best.frameBox,confidence,source:'Moondream nested card/frame detection',suspiciousPerfect:suspiciousPerfectCentering(best.metrics)};
  }catch(e){console.warn('Printed-frame detection:',e);return null}
}
function framePatternDistance(a,b){
  if(!a||!b)return null;
  return Math.max(Math.abs(a.L-b.L),Math.abs(a.R-b.R),Math.abs(a.T-b.T),Math.abs(a.B-b.B));
}
function frameCenteringResult(frame,{verifiedReference=false,referenceDistance=null}={}){
  if(!frame)return null;
  let confidence=Number(frame.confidence||0);
  if(verifiedReference){
    if(!Number.isFinite(referenceDistance)||referenceDistance>.055)return null;
    if(frame.suspiciousPerfect && (referenceDistance>.018 || confidence<88))return null;
    confidence=Math.min(95,confidence+Math.round((.055-referenceDistance)*165));
  }else{
    // Vision-only centering is corroborative, not authoritative. Never accept
    // a suspicious/near-perfect default or an extreme measurement without a verified reference.
    if(frame.suspiciousPerfect||frame.worst>60||confidence<90)return null;
    confidence=Math.min(confidence,88);
  }
  if(frame.worst>68)return null;
  return {
    lr:frame.lr,tb:frame.tb,confidence,
    verifiedReference:Boolean(verifiedReference),
    source:verifiedReference?'nested printed frame matched verified exact-card reference':'high-confidence nested card/frame detection',
    reason:verifiedReference?'printed-frame margins were measured inside the physical card and matched a verified exact-card reference':'printed-frame margins were measured inside the detected physical card'
  };
}


function htmlMetaImages(html,baseUrl){
  const out=[];
  const add=u=>{try{const x=new URL(String(u||'').replace(/&amp;/g,'&'),baseUrl);if(/^https?:$/.test(x.protocol))out.push(x.href)}catch{}};
  for(const re of [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/ig,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/ig,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/ig,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/ig
  ]){let m;while((m=re.exec(html)))add(m[1])}
  return [...new Set(out)].slice(0,6);
}
async function discoverReferenceImagesFromSources(sources,identity){
  const out=[];
  for(const src of (sources||[]).slice(0,4)){
    const titleUrl=`${src.title||''} ${src.url||''}`;
    if(!strictCardCodePresent(titleUrl,identity?.cardNo)||!containsSubject(titleUrl,identity?.subject))continue;
    try{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),2200);
      const r=await fetch(src.url,{headers:{'User-Agent':'Mozilla/5.0 CardLab/9.0'},signal:controller.signal});
      clearTimeout(timer);
      if(!r.ok)continue;
      const type=r.headers.get('content-type')||'';
      if(!type.includes('text/html'))continue;
      const html=(await r.text()).slice(0,500000);
      out.push(...htmlMetaImages(html,src.url));
    }catch{}
  }
  return [...new Set(out)].slice(0,8);
}
async function buildReferenceTemplate(env,urls,identity){
  for(const u of urls||[]){
    try{
      const image=await fetchReferenceImageData(u);if(!image)continue;
      const prompt=`This is an online reference image for the exact trading-card identity ${JSON.stringify(identity||{})}.
Describe only stable printed/design features that can help distinguish intentional artwork from damage and help locate a true printed border/frame.
Return ONLY JSON:
{"border_style":"framed|borderless|mixed|unknown","measurable_frame":boolean,"intentional_design_marks":[string],"dominant_design_colors":[string],"foil_or_parallel_cues":[string],"notes":[string]}
Do not grade the reference card and do not infer the photographed user's card condition.`;
      const [raw,frameDetection]=await Promise.all([
        env.AI.run(CONDITION_PRIMARY_MODEL,{
          messages:[{role:'system',content:'Extract stable design-template facts from a trading-card reference image.'},{role:'user',content:prompt}],
          image,temperature:0,max_tokens:650,stream:false
        }),
        detectPrintedFrame(env,image)
      ]);
      const obj=structuredModelResult(raw,'reference template');
      return {
        sourceUrl:safeRemoteImageUrl(u),
        verifiedExactIdentity:true,
        border_style:['framed','borderless','mixed','unknown'].includes(obj?.border_style)?obj.border_style:'unknown',
        measurable_frame:Boolean(obj?.measurable_frame || frameDetection),
        frame_detection:frameDetection,
        intentional_design_marks:Array.isArray(obj?.intentional_design_marks)?obj.intentional_design_marks.map(clean).filter(Boolean).slice(0,8):[],
        dominant_design_colors:Array.isArray(obj?.dominant_design_colors)?obj.dominant_design_colors.map(clean).filter(Boolean).slice(0,8):[],
        foil_or_parallel_cues:Array.isArray(obj?.foil_or_parallel_cues)?obj.foil_or_parallel_cues.map(clean).filter(Boolean).slice(0,8):[],
        notes:Array.isArray(obj?.notes)?obj.notes.map(clean).filter(Boolean).slice(0,6):[],
      };
    }catch(e){console.warn('Reference image template attempt:',e)}
  }
  return null;
}
async function inspectConditionWithTemplate(env,side,image,template,photoQuality){
  const prompt=`Inspect ONLY visible physical condition on the ${side} of this raw trading card.
A verified exact-card reference established these intentional design facts:
${JSON.stringify(template)}
Do not count intentional printed/design features as damage and do not copy condition from the reference.
For corners, edges, surface, and print/focus classify severity only as none, minute, minor, moderate, major, severe, or unknown.
Use unknown rather than guessing. Moderate or worse requires named visible evidence.
Return ONLY JSON with keys corners, edges, surface, focus, defects, confidence; each category must be {"severity":string,"evidence":string|null}.`;
  try{
    const raw=await env.AI.run(CONDITION_PRIMARY_MODEL,{
      messages:[
        {role:'system',content:'Use the verified reference only as a design mask. Inspect the photographed card itself for physical condition.'},
        {role:'user',content:prompt}
      ],
      image,temperature:0,max_tokens:700,stream:false
    });
    let obj=null;
    try{obj=structuredModelResult(raw,'reference condition')}catch{}
    if(!obj){try{obj=parseModelJSON(modelText(raw),'reference condition')}catch{}}
    const out=conditionFromSeverityObject(obj,side,photoQuality,'Gemma + verified reference template');
    if(out){
      out.notes=Array.from(new Set([...(out.notes||[]),'Verified exact-card reference was used only as a design mask.'])).slice(0,9);
      if(conditionCompleteness(out)===4){
        const q=Number.isFinite(Number(photoQuality))?Number(photoQuality):70;
        out.confidence=clamp(Math.round(62+q*.22+Math.min(8,(out.notes||[]).length*2)),62,92);
      }
    }
    return sanitizeConditionAssessment(out);
  }catch(e){console.warn('Reference condition pass:',e);return null}
}

function betterConditionSide(a,b){
  if(!a)return b;if(!b)return a;
  const ac=conditionCompleteness(a),bc=conditionCompleteness(b);
  if(bc>ac)return b;if(ac>bc)return a;
  const ai=conditionIntegrityIssues(a).length,bi=conditionIntegrityIssues(b).length;
  if(bi<ai)return b;if(ai<bi)return a;
  return Number(b.confidence||0)>Number(a.confidence||0)+8?b:a;
}
async function refineConditionWithReference(env,front,back,condition,template,photoQuality){
  const oldFront=condition?.sides?.front,oldBack=condition?.sides?.back;
  const tasks=[];
  const frontNeed=!oldFront||conditionCompleteness(oldFront)<4||Number(oldFront.confidence||0)<58||conditionIntegrityIssues(oldFront).length;
  const backNeed=!oldBack||conditionCompleteness(oldBack)<4||Number(oldBack.confidence||0)<58||conditionIntegrityIssues(oldBack).length;
  tasks.push(frontNeed?inspectConditionWithTemplate(env,'front',front,template,photoQuality.front):Promise.resolve(null));
  tasks.push(backNeed?inspectConditionWithTemplate(env,'back',back,template,photoQuality.back):Promise.resolve(null));
  const [frontRef,backRef]=await Promise.all(tasks);
  const f=betterConditionSide(oldFront,frontRef);
  const b=betterConditionSide(oldBack,backRef);
  return combineCondition(f||unknownConditionSide('front','No reliable front condition result.'),b||unknownConditionSide('back','No reliable back condition result.'),photoQuality);
}
function centeringNeedsReference(meta){
  if(!meta)return false;
  if(meta.reliable===false)return true;
  const c=meta.values||meta;
  const pairs=[c.lr,c.tb].filter(Array.isArray);
  return pairs.some(p=>Math.max(...p.map(Number))>70);
}
async function inspectCenteringWithTemplate(env,side,image,template){
  if(template?.border_style==='borderless')return null;
  const userFrame=await detectPrintedFrame(env,image);
  if(!userFrame)return null;
  const refFrame=template?.frame_detection||null;
  if(refFrame){
    const distance=framePatternDistance(userFrame,refFrame);
    return frameCenteringResult(userFrame,{verifiedReference:true,referenceDistance:distance});
  }
  // Template says a measurable frame exists, but the reference detector could not
  // establish its box. Fall back to independent detection under a stricter gate.
  if(template?.measurable_frame)return frameCenteringResult(userFrame,{verifiedReference:false});
  return null;
}
async function inspectCenteringIndependent(env,side,image,identity,template=null){
  if(template?.border_style==='borderless')return null;
  if(template?.frame_detection)return inspectCenteringWithTemplate(env,side,image,template);
  const frame=await detectPrintedFrame(env,image);
  return frameCenteringResult(frame,{verifiedReference:false});
}

async function rescueCenteringEvidence(env,front,back,condition,identity,template,localCentering){
  if(!condition?.sides)return condition;
  const jobs=[];
  for(const [side,img] of [['front',front],['back',back]]){
    const existing=condition?.sides?.[side]?.centering;
    const existingOK=existing?.lr&&existing?.tb&&Number(existing.confidence||0)>=76;
    const need=centeringNeedsReference(localCentering?.[side])&&!existingOK;
    jobs.push(need?inspectCenteringIndependent(env,side,img,identity,template):Promise.resolve(null));
  }
  const [fc,bc]=await Promise.all(jobs);
  if(fc)condition.sides.front.centering=fc;
  if(bc)condition.sides.back.centering=bc;
  if(fc||bc)condition.notes=Array.from(new Set([...(condition.notes||[]),'Independent centering rescue was used only where local geometry could not establish a reliable result.'])).slice(0,10);
  return condition;
}

async function refineCenteringWithReference(env,front,back,condition,template,localCentering){
  if(!condition?.sides)return condition;
  const jobs=[];
  for(const [side,img] of [['front',front],['back',back]]){
    jobs.push(centeringNeedsReference(localCentering?.[side])?inspectCenteringWithTemplate(env,side,img,template):Promise.resolve(null));
  }
  const [fc,bc]=await Promise.all(jobs);
  if(fc)condition.sides.front.centering=fc;
  if(bc)condition.sides.back.centering=bc;
  if(fc||bc){
    condition.notes=Array.from(new Set([...(condition.notes||[]),'Reference-template centering was used only where local geometry was unreliable/extreme.'])).slice(0,10);
  }
  return condition;
}
function parseConditionFlexible(text, side) {
  const raw=String(text||'').trim();
  if (raw) {
    const cleaned=raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'');
    const a=cleaned.indexOf('{'), b=cleaned.lastIndexOf('}');
    if (a>=0 && b>a) {
      try {
        const obj=JSON.parse(cleaned.slice(a,b+1));
        return conditionFromObject(obj,side);
      } catch {}
    }
  }
  return parseConditionKV(raw,side);
}

function conditionFromObject(obj, side) {
  const score=v=>{
    if (v==null || /^(unknown|null|n\/a)$/i.test(String(v))) return null;
    const n=Number(String(v).match(/\d+(?:\.\d+)?/)?.[0]);
    return Number.isFinite(n)&&n>=1&&n<=10?clampHalf(n,1,10):null;
  };
  const defects=Array.isArray(obj?.defects)?obj.defects.map(x=>String(x).toLowerCase()):String(obj?.defects||'').toLowerCase().split(/[,;|]/).map(x=>x.trim());
  const has=k=>defects.some(x=>x.replace(/[- ]/g,'_')===k);
  const lr=parsePair(obj?.center_lr ?? obj?.CENTER_LR);
  const tb=parsePair(obj?.center_tb ?? obj?.CENTER_TB);
  const conf=clamp(Math.round(Number(obj?.confidence ?? obj?.CONFIDENCE) || 0),0,100);
  const centerConf=clamp(Math.round(Number(obj?.center_confidence ?? obj?.CENTER_CONFIDENCE) || 0),0,100);
  const notes=Array.isArray(obj?.notes)?obj.notes:[obj?.notes ?? obj?.NOTES];
  return sanitizeConditionAssessment({
    side,
    corners:score(obj?.corners ?? obj?.CORNERS),
    edges:score(obj?.edges ?? obj?.EDGES),
    surface:score(obj?.surface ?? obj?.SURFACE),
    focus:score(obj?.focus ?? obj?.FOCUS),
    defects:{crease:has('crease'),dent:has('dent'),stain:has('stain'),scratch:has('scratch'),printline:has('printline'),mark:has('mark'),possible_alteration:has('possible_alteration')},
    confidence:conf,
    centering:{lr,tb,confidence:lr&&tb?centerConf:0},
    notes:notes.map(clean).filter(Boolean).slice(0,6),
  });
}

async function normalizeConditionOutput(env, side, text) {
  const prompt=`Convert the following vision-model output into one JSON object. Do NOT add any observation, score, defect, or centering value that is not explicitly stated in the source. Missing/uncertain values must be null. Confidence must be 0 if the source states no confidence.

SOURCE (${side}):
${text}

RETURN ONLY:
{"corners":number|null,"edges":number|null,"surface":number|null,"focus":number|null,"defects":[],"confidence":number,"center_lr":string|null,"center_tb":string|null,"center_confidence":number,"notes":[]}`;
  try {
    const raw=await env.AI.run(TEXT_MODEL,{
      messages:[
        {role:'system',content:'You only normalize supplied text into JSON. Never infer missing visual facts.'},
        {role:'user',content:prompt}
      ],
      response_format:{type:'json_object'},
      temperature:0,
      max_tokens:700,
      stream:false
    });
    const obj=structuredModelResult(raw,'condition normalizer');
    const out=conditionFromObject(obj,side);
    out.notes.unshift('Condition response was normalized from the vision model without adding new visual judgments.');
    return out;
  } catch(e) {
    const out=unknownConditionSide(side,`Condition response could not be normalized: ${cleanError(e)}`);
    return out;
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
  return ['corners','edges','surface','focus'].filter(k=>conditionNumber(x?.[k])!==null).length;
}

function unknownConditionSide(side, note) {
  return {
    side,corners:null,edges:null,surface:null,focus:null,
    defects:{crease:false,dent:false,stain:false,scratch:false,printline:false,mark:false,possible_alteration:false},
    confidence:0,centering:{lr:null,tb:null,confidence:0},diagnostic:'unavailable',notes:[note]
  };
}

function combineCondition(front, back, photoQuality={}) {
  front=sanitizeConditionAssessment(front)||unknownConditionSide('front','Invalid front condition response.');
  back=sanitizeConditionAssessment(back)||unknownConditionSide('back','Invalid back condition response.');
  const worse = k => {
    const vals=[front?.[k],back?.[k]].map(conditionNumber).filter(v=>v!==null);
    return vals.length===2?clampHalf(Math.min(...vals),1,10):null;
  };
  const defects={};
  for(const k of ['crease','dent','stain','scratch','printline','mark','possible_alteration'])defects[k]=Boolean(front?.defects?.[k]||back?.defects?.[k]);
  const confs=[front?.confidence,back?.confidence].map(Number).filter(Number.isFinite);
  let confidence=confs.length===2?Math.round(Math.min(...confs)*.65 + ((confs[0]+confs[1])/2)*.35):0;
  const scores=['corners','edges','surface','focus'].map(worse);
  if(scores.some(v=>!Number.isFinite(v)))confidence=Math.min(confidence,40);
  return {
    corners:worse('corners'),edges:worse('edges'),surface:worse('surface'),focus:worse('focus'),
    defects,
    confidence:clamp(confidence,0,94),
    notes:Array.from(new Set([
      ...(front?.notes||[]).map(x=>`Front: ${x}`),
      ...(back?.notes||[]).map(x=>`Back: ${x}`),
      'Condition combines the worse supported front/back result; microscopic or hidden defects still require in-hand inspection.'
    ])).slice(0,12),
    sides:{front,back},
    photoQuality,
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
      queryStrategy:keyword.queries||[query],
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


function buildMarketQueries(identity={}){
  const exact=buildQuery(identity);
  const compact=[identity.year,identity.subject,identity.cardNo,identity.variation].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
  const broad=[identity.subject,identity.cardNo].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
  return [...new Set([exact,compact,broad].filter(Boolean))];
}
async function ebaySearchQueryWithToken(env,token,query,limit=30){
  const url=new URL(`${ebayApiBase(env)}/buy/browse/v1/item_summary/search`);
  url.searchParams.set('q',query);url.searchParams.set('limit',String(limit));
  const r=await fetch(url,{headers:{'Authorization':`Bearer ${token}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_US','Accept':'application/json'}});
  if(!r.ok){
    const t=await r.text().catch(()=> '');
    throw new Error(`eBay Browse keyword search ${r.status}${t?`: ${t.slice(0,180)}`:''}`);
  }
  const data=await r.json();
  return (data.itemSummaries||[]).map(mapEbayItem);
}
async function ebayKeywordSearchWithToken(env, token, identity) {
  const queries=buildMarketQueries(identity);
  const merged=new Map();
  const used=[];
  for(const q of queries){
    used.push(q);
    const items=await ebaySearchQueryWithToken(env,token,q,30);
    for(const x of items){
      const key=x.itemId||x.url||x.title;
      if(key&&!merged.has(key))merged.set(key,x);
    }
    const strong=[...merged.values()].map(x=>({...x,...scoreMarketItem(identity,x,false)})).filter(x=>x.matchScore>=75);
    if(strong.length>=10)break;
  }
  return {items:[...merged.values()],queries:used};
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
  const vals=(items||[]).map(x=>{
    const p=Number(x.price),ship=Number(x.shipping);
    if(!Number.isFinite(p)||p<0)return null;
    return p+(Number.isFinite(ship)&&ship>=0?ship:0);
  }).filter(Number.isFinite);
  if(!vals.length)return null;
  const sorted=[...vals].sort((a,b)=>a-b);
  const medianOf=a=>{const mid=Math.floor(a.length/2);return a.length%2?a[mid]:(a[mid-1]+a[mid])/2};
  const median=medianOf(sorted);
  const trim=sorted.length>=6?Math.max(1,Math.floor(sorted.length*.15)):0;
  const trimmed=trim?sorted.slice(trim,sorted.length-trim):sorted;
  const tMedian=medianOf(trimmed);
  const q1=sorted[Math.floor((sorted.length-1)*.25)],q3=sorted[Math.ceil((sorted.length-1)*.75)];
  const spread=median>0?(q3-q1)/median:1;
  let quality=25+Math.min(45,sorted.length*7)-Math.min(35,spread*35);
  quality=clamp(Math.round(quality),15,95);
  return {
    sampleSize:vals.length,
    low:+sorted[0].toFixed(2),
    median:+median.toFixed(2),
    high:+sorted[sorted.length-1].toFixed(2),
    trimmedLow:+trimmed[0].toFixed(2),
    trimmedMedian:+tMedian.toFixed(2),
    trimmedHigh:+trimmed[trimmed.length-1].toFixed(2),
    value:+tMedian.toFixed(2),
    quality,
    support:quality>=80?'strong':quality>=60?'moderate':quality>=40?'limited':'weak',
    spreadRatio:+spread.toFixed(3),
    includesShipping:true,
  };
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


function runSelfTests(){
  const tests=[];
  const add=(name,pass,details=null)=>tests.push({name,pass:Boolean(pass),details});
  add('card-code accepts exact alphanumeric code',isPlausibleCardCode('91TF-2')===true);
  add('card-code rejects product URL slug',isPlausibleCardCode('TOPPS-FLAGSHIP-1991')===false);

  const mockSources=[
    {title:'2026 Topps Flagship 1991 Topps Football #91TF-2 Travis Hunter Green /99',content:'Green parallel serial numbered /99',trustTier:3,url:'https://beckett.com/mock'},
    {title:'2026 Topps Flagship 1991 Topps Football #91TF-2 Travis Hunter Orange /25',content:'Orange parallel serial numbered /25',trustTier:3,url:'https://tcdb.com/mock'},
  ];
  const serial=resolveVariantEvidence('Orange','23/99',mockSources,[]);
  add('serial denominator resolves documented parallel',serial.status==='verified'&&serial.variation==='Green /99',serial);
  const conflict=resolveVariantEvidence('Orange',null,mockSources,[]);
  add('conflicting numbered parallels fail closed without serial',conflict.status==='unresolved'&&conflict.variation==null,conflict);

  const ms=marketStats([{price:10,shipping:2},{price:11,shipping:2},{price:12,shipping:2},{price:13,shipping:2},{price:14,shipping:2},{price:999,shipping:0}]);
  add('market outlier does not dominate raw value',Boolean(ms&&ms.value<25&&ms.trimmedHigh<50),ms);

  const merged=mergeConditionConsensus(
    {corners:9,edges:9,surface:9,focus:9,defects:{},confidence:30,centering:{lr:[52,48],tb:[51,49],confidence:70},notes:['pass A']},
    {corners:9.5,edges:9,surface:8.5,focus:9,defects:{},confidence:60,centering:{lr:[53,47],tb:[52,48],confidence:65},notes:['pass B']},
    'front',85
  );
  add('condition consensus preserves conservative scores',merged.corners===9&&merged.surface===8.5&&merged.confidence>=60,merged);

  const bogus=sanitizeConditionAssessment({side:'front',corners:1,edges:1,surface:1,focus:1,defects:{},confidence:90,centering:{lr:null,tb:null,confidence:0},notes:['No major visible defect flags']});
  add('catastrophic placeholder condition scores fail closed',conditionCompleteness(bogus)===0&&bogus.confidence===0,bogus);

  add('short card-code prefix cannot verify a longer different card',strictCardCodePresent('2026 Topps Brock Bowers #91TF-34','91TF')===false,null);
  add('full exact card code verifies correctly',strictCardCodePresent('2026 Topps Travis Hunter #91TF-2','91TF-2')===true,null);
  const chosen=chooseBestPhysicalCardCandidate([{value:'91TF',score:150},{value:'91TF-2',score:145}]);
  add('longer physical code is preserved over a near-equal prefix',chosen?.value==='91TF-2',chosen);
  const emptyCombined=combineCondition(unknownConditionSide('front','unknown'),unknownConditionSide('back','unknown'),{front:80,back:80});
  add('unknown condition values never coerce into score 1',emptyCombined.corners===null&&emptyCombined.edges===null&&emptyCombined.surface===null&&emptyCombined.focus===null,emptyCombined);

  const hint=applyTrustedHint({cardNo:null,cardCandidates:[]},{cardNo:'91TF-2',year:2026,source:'test'});
  add('local trusted fingerprint hint becomes a candidate, not a verdict',hint.cardCandidates?.[0]?.value==='91TF-2'&&hint.cardNo==='91TF-2',hint);

  const mq=buildMarketQueries({year:2026,set:'Topps Flagship 1991 Topps Football',subject:'Travis Hunter',cardNo:'91TF-2',variation:null});
  add('adaptive market search creates exact and safe broader queries',mq.length>=2&&mq[0].includes('91TF-2')&&mq.every(x=>x.includes('Travis Hunter')||x.includes('91TF-2')),mq);

  const sev=conditionFromSeverityObject({
    corners:{severity:'none',evidence:'four corners appear sharp'},
    edges:{severity:'minute',evidence:'tiny white speck on lower edge'},
    surface:{severity:'minor',evidence:'light visible surface mark'},
    focus:{severity:'none',evidence:'print registration appears clean'},
    defects:[],confidence:82,center_lr:'51/49',center_tb:'52/48',center_confidence:80
  },'front',95,'test');
  add('categorical severity maps deterministically to grading scores',sev.corners===10&&sev.edges===9.5&&sev.surface===8.5&&sev.focus===10,sev);

  const sevBad=conditionFromSeverityObject({
    corners:{severity:'major',evidence:null},edges:{severity:'none'},surface:{severity:'none'},focus:{severity:'none'},defects:[],confidence:95
  },'front',95,'test');
  add('major condition severity without named evidence fails closed',sevBad.corners===null,sevBad);

  const sourceFallback=deterministicIdentityFromExactSources([
    {title:'Travis Hunter [Green Crackle] #91TF-2 2026 Topps Flagship 1991 Topps Football Cards',content:'',trustTier:2,score:.9}
  ],'91TF-2','Travis Hunter',{brand:'Topps'});
  add('verified-source fallback extracts exact card facts without inventing them',sourceFallback.cardNo==='91TF-2'&&sourceFallback.subject==='Travis Hunter'&&sourceFallback.year===2026&&/Topps Flagship 1991 Topps Football/i.test(sourceFallback.set||''),sourceFallback);

  const coreTier2=evaluateCoreVerification({
    codeSupported:true,subjectSupported:true,yearSupported:true,setSupported:true,
    physicalCodeSupported:true,physicalSubjectSupported:true,matchingImageSupport:false,
    strongDomainCount:0,officialCount:0,strongCount:0,referenceCount:1,contradictionCount:0
  });
  add('exact online reference plus physical full-code and subject verifies core identity',coreTier2==='verified',coreTier2);

  const coreConflict=evaluateCoreVerification({
    codeSupported:true,subjectSupported:true,yearSupported:true,setSupported:true,
    physicalCodeSupported:true,physicalSubjectSupported:true,
    strongDomainCount:2,officialCount:0,strongCount:2,referenceCount:2,contradictionCount:1
  });
  add('exact subject contradiction prevents verified core status',coreConflict==='probable',coreConflict);

  const pairConflict=validateFrontBackPair({
    front:{fullText:'TOPPS CARD NO 91TF-2 Travis Hunter'},
    back:{fullText:'TOPPS CARD NO 91TF-34 Brock Bowers'}
  },{subject:'Travis Hunter'});
  add('front/back conflicting full card numbers are rejected',pairConflict.status==='conflict',pairConflict);

  const legacyNested=frameWithinCardMetrics(
    {xmin:.05,ymin:.03,xmax:.95,ymax:.97},
    {xmin:.11,ymin:.09,xmax:.87,ymax:.89}
  );
  add('printed-frame margins are measured inside the physical card',Boolean(legacyNested&&legacyNested.worst<60&&legacyNested.lr.length===2&&legacyNested.tb.length===2),legacyNested);

  const ordinary={...legacyNested,confidence:93,suspiciousPerfect:suspiciousPerfectCentering(legacyNested)};
  const frameResult=frameCenteringResult(ordinary,{verifiedReference:false});
  add('high-confidence non-perfect nested frame can corroborate centering',Boolean(frameResult&&frameResult.confidence>=80&&!ordinary.suspiciousPerfect),frameResult);

  const sevKV=parseSeverityFlexible(`CORNERS=NONE
CORNERS_EVIDENCE=sharp
EDGES=MINUTE
EDGES_EVIDENCE=tiny white speck
SURFACE=NONE
SURFACE_EVIDENCE=clean
FOCUS=NONE
FOCUS_EVIDENCE=registered
DEFECTS=NONE
CONFIDENCE=88`, 'front',95,'test-kv');
  add('inspection-sheet key-value severity output parses deterministically',Boolean(sevKV&&sevKV.corners===10&&sevKV.edges===9.5&&sevKV.surface===10),sevKV);

  const integrityGood=finalAnalysisIntegrity({
    identity:{year:2026,set:'Topps Flagship 1991 Topps Football',subject:'Travis Hunter',cardNo:'91TF-2'},
    selected_card_code:'91TF-2',verification_status:'verified',core_verification_status:'verified',
    condition:{corners:9.5,edges:9.5,surface:9,focus:10,sides:{front:{centering:{lr:[52,48],tb:[51,49]}},back:{centering:{lr:[53,47],tb:[50,50]}}}},
    condition_confidence:80,variant_status:'unresolved'
  });
  add('final integrity gate allows verified core with unresolved variant while flagging market hold',integrityGood.ok&&integrityGood.issues.some(x=>x.includes('market')),integrityGood);

  const nested=frameWithinCardMetrics(
    {xmin:.10,ymin:.05,xmax:.90,ymax:.95},
    {xmin:.16,ymin:.12,xmax:.84,ymax:.88}
  );
  add('nested card/frame geometry measures margins relative to physical card',Boolean(nested&&nested.worst<56&&nested.area<.9),nested);

  const perfect=frameWithinCardMetrics(
    {xmin:.10,ymin:.05,xmax:.90,ymax:.95},
    {xmin:.16,ymin:.12,xmax:.84,ymax:.88}
  );
  add('suspicious-perfect detector identifies exact 50/50 defaults',Boolean(perfect&&suspiciousPerfectCentering(perfect)),perfect);

  const loose='SEVERITY=MINOR | EVIDENCE=tiny white speck visible on lower edge';
  add('loose severity parser recovers categorical model output',severityWordFromText(loose)==='minor'&&/white speck/i.test(evidenceFromLooseText(loose)||''),{severity:severityWordFromText(loose),evidence:evidenceFromLooseText(loose)});

  const wrappedMoondream={response:{answer:'SEVERITY=MINOR | EVIDENCE=tiny white speck on lower edge',caption:null,finish_reason:'stop',metrics:{input_tokens:846,decode_time_ms:551}}};
  const wrappedText=modelText(wrappedMoondream);
  add('Workers AI wrapper is unwrapped without leaking metrics',wrappedText==='SEVERITY=MINOR | EVIDENCE=tiny white speck on lower edge'&&!/metrics|tokens|decode/i.test(wrappedText),wrappedText);

  const leaked='short visible evidence or NONE","caption":null,"finish_reason":"stop","metrics":{"input_tokens":846}';
  add('condition evidence sanitizer rejects wrapper contamination',sanitizeModelEvidence(leaked)===null,sanitizeModelEvidence(leaked));

  const nestedObjects=modelObjects({response:{objects:[{xmin:.1,ymin:.1,xmax:.9,ymax:.9,score:.9}]}});
  add('Moondream detect wrapper is recursively unwrapped',nestedObjects.length===1,nestedObjects);

  return {ok:tests.every(x=>x.pass),passed:tests.filter(x=>x.pass).length,total:tests.length,tests};
}

function modelText(raw) {
  const seen=new Set();
  function walk(v,depth=0){
    if(v==null||depth>6)return '';
    if(typeof v==='string')return v.trim();
    if(typeof v!=='object')return '';
    if(seen.has(v))return '';
    seen.add(v);
    for(const key of ['answer','output_text','text']){
      if(typeof v[key]==='string'&&v[key].trim())return v[key].trim();
    }
    const msg=v?.choices?.[0]?.message;
    if(typeof msg?.content==='string'&&msg.content.trim())return msg.content.trim();
    if(Array.isArray(msg?.content)){
      const joined=msg.content.map(x=>typeof x==='string'?x:(x?.text||x?.content||'')).filter(Boolean).join('\n').trim();
      if(joined)return joined;
    }
    if(typeof v.content==='string'&&v.content.trim())return v.content.trim();
    for(const key of ['response','result','data','output']){
      const t=walk(v[key],depth+1);
      if(t)return t;
    }
    return '';
  }
  return walk(raw);
}
function isModelEnvelopeObject(obj){
  if(!obj||typeof obj!=='object'||Array.isArray(obj))return false;
  return Object.keys(obj).some(k=>['metrics','usage','finish_reason','choices','model','object','created','caption','answer','response','result','reasoning'].includes(k));
}
function looksLikeStructuredPayload(obj){
  if(!obj||typeof obj!=='object'||Array.isArray(obj))return false;
  const payloadKeys=['year','brand','set','subject','cardNo','variation','team','category','confidence','corners','edges','surface','focus','defects','center_lr','center_tb','measurable','card_shape','border_style','measurable_frame','notes'];
  return payloadKeys.some(k=>Object.prototype.hasOwnProperty.call(obj,k));
}
function structuredModelResult(raw,label) {
  if(!raw) throw new Error(`${label} returned no result.`);
  const msg=raw?.choices?.[0]?.message;
  if(msg?.parsed && typeof msg.parsed==='object') return msg.parsed;
  if(typeof msg?.content==='string'){try{return parseModelJSON(msg.content,label)}catch{}}
  for(const candidate of [raw,raw?.response,raw?.result,raw?.data,raw?.output]){
    if(looksLikeStructuredPayload(candidate)&&!isModelEnvelopeObject(candidate))return candidate;
    if(candidate&&typeof candidate==='object'){
      const nested=modelText(candidate);
      if(nested){try{return parseModelJSON(nested,label)}catch{}}
    }
  }
  const text=modelText(raw);
  if(text)return parseModelJSON(text,label);
  throw new Error(`${label} returned no readable structured payload.`);
}
function extractBalancedJson(text){
  const s=String(text||'');
  for(let start=0;start<s.length;start++){
    if(s[start]!=='{')continue;
    let depth=0,inString=false,escape=false;
    for(let i=start;i<s.length;i++){
      const ch=s[i];
      if(inString){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')inString=false;continue}
      if(ch==='"'){inString=true;continue}
      if(ch==='{')depth++;
      else if(ch==='}'){
        depth--;
        if(depth===0){const piece=s.slice(start,i+1);try{return JSON.parse(piece)}catch{break}}
      }
    }
  }
  return null;
}
function parseModelJSON(text,label) {
  if(typeof text!=='string') throw new Error(`${label} returned no text.`);
  const cleaned=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'');
  try{return JSON.parse(cleaned)}catch{}
  const balanced=extractBalancedJson(cleaned);
  if(balanced)return balanced;
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
