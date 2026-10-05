/**
 * SAYON - Anthropic API Proxy + Audio Transcription + Stripe billing
 * Cloudflare Worker deployed as `korva` (korva.byronguyatt2.workers.dev).
 * The API keys are stored as Cloudflare secrets and never exposed to the
 * browser or public repo. See worker/README.md for setup and deploy steps.
 *
 * CHANGES FROM PREVIOUS VERSION (v8 -> v9):
 * Adds POST /send-email, so the app can email a report, quote, certificate
 * or invoice PDF to the client itself instead of going through the
 * phone's mail app. Sends through Resend (resend.com) with plain fetch.
 * Needs two new secrets; until both are set the route answers 501 and the
 * app keeps using the phone's mail app:
 *   RESEND_API_KEY - from Resend › API Keys
 *   MAIL_FROM      - the address it sends from, on a domain verified in
 *                    Resend, e.g. reports@yourdomain.com.au
 * The client sees the business's name as the sender and replies go to the
 * business's own email. Only signed-in users on an active plan or trial
 * can send, only PDFs can be attached, and sending doesn't use AI calls.
 * Every other path behaves exactly as v8 did.
 *
 * CHANGES FROM v7 -> v8:
 * Adds the Stripe billing routes that index.html already calls (see the
 * BILLING / STRIPE section there), plus the webhook Stripe needs to keep
 * the `subscriptions` table in sync:
 *   GET  /stripe/subscription-status    - caller's plan, status and usage
 *   POST /stripe/create-checkout-session - Stripe Checkout URL for a plan
 *   POST /stripe/create-portal-session   - Stripe Billing Portal URL
 *   POST /stripe/webhook                 - called by Stripe, not the app
 * Every other path behaves exactly as v7 did.
 *
 * NEW REQUIRED SECRETS for the /stripe/* routes:
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 *   STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO, STRIPE_PRICE_BUSINESS
 * The AI proxy keeps working without them; only billing needs them.
 *
 * Talks to the Stripe REST API with plain fetch (no npm packages), so this
 * file can still be pasted straight into the Cloudflare dashboard editor.
 *
 * CHANGES FROM v6 -> v7:
 * 1. BUG FIX, not just an addition: MAX_TOKENS_CEILING was 3000. The
 *    client (index.html) was fixed this session to request max_tokens:
 *    4096 for the main AI extraction call specifically because 3000 was
 *    too low for a long, multi-section dictation and was causing the
 *    Anthropic response to truncate mid-JSON (JSON.parse() then throwing
 *    "Unexpected EOF", silently dropping the whole extraction into the
 *    weaker offline fallback). But this Worker's
 *    `Math.min(requested, MAX_TOKENS_CEILING)` clamp was still silently
 *    pulling every request back down to 3000 regardless of what the
 *    client asked for - so that client-side fix was NOT actually taking
 *    effect against the real deployed Worker. Raised to 4096 to match.
 * 2. NEW: a `/transcribe` endpoint for Sayon's experimental, opt-in,
 *    higher-accuracy dictation path (see index.html's
 *    startAudioCapture()/tryServerSideTranscription() - there's a
 *    Settings toggle for it, off by default). Takes a multipart/form-data
 *    upload (an `audio` file field, an optional `initial_prompt` text
 *    field carrying Sayon's brand/species vocabulary for biasing), runs
 *    it through Workers AI's whisper-large-v3-turbo model, and returns
 *    { transcript }. Goes through the EXACT SAME CORS/Bearer-auth/plan-
 *    and-usage gate as the existing Anthropic proxy below before this
 *    endpoint is ever reached - nothing about this opens a new way in.
 *    Every existing caller only ever POSTs to the bare origin (no path),
 *    so routing by pathname is purely additive and changes nothing for
 *    them.
 * 3. NEW REQUIRED BINDING: this version needs a Workers AI binding named
 *    `AI` on this Worker, in addition to the existing ANTHROPIC_API_KEY
 *    and SUPABASE_SERVICE_ROLE_KEY secrets. Add it from the Cloudflare
 *    dashboard: Workers & Pages -> this Worker -> Settings -> Bindings ->
 *    Add -> "Workers AI" -> variable name `AI` -> Save/redeploy. (No new
 *    secret value to generate or paste - Workers AI bindings don't need
 *    an API key, just the binding itself.) Until that binding is added,
 *    /transcribe responds 501 rather than crashing, and logs why.
 *
 * CHANGES FROM v5 -> v6:
 * Removed the temporary `?debugcheck` endpoint, and internal error detail
 * is now logged with console.error instead of returned to the caller.
 *
 * CHANGES FROM v4 -> v5:
 * Plan/subscription gating and per-business AI usage counting against the
 * `subscriptions` table, using the SUPABASE_SERVICE_ROLE_KEY secret.
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const STRIPE_API = 'https://api.stripe.com/v1';
const RESEND_API = 'https://api.resend.com/emails';

// Same Supabase project the app itself talks to. The anon key is public
// (it's already embedded in the client app) - it identifies the project,
// it does not grant access by itself.
const SUPABASE_URL = 'https://bmjgvogxutwyeklxxeao.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtamd2b2d4dXR3eWVrbHh4ZWFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0NTczMTEsImV4cCI6MjEwNTAzMzMxMX0.Ov8xGhDMuAbUcWy7zbCiS01D6QCrlhDYxza3Fzls83U';

// Only allow requests that claim to come from your GitHub Pages site
const ALLOWED_ORIGINS = [
  'https://byronguyatt2-droid.github.io',
  'http://localhost',          // Capacitor's default Android origin
  'capacitor://localhost',     // Capacitor's default iOS origin
  'https://localhost',         // in case the iOS scheme is ever switched to the
                                // newer Capacitor "server" scheme later
  'null',                      // for opening index.html directly as a file
];

// Where Stripe sends people back to when the app's own return URL can't be
// used (Stripe only accepts http(s) URLs, so a Capacitor or file:// origin
// falls back to the hosted app).
const DEFAULT_APP_URL = 'https://byronguyatt2-droid.github.io/';

// The only model this proxy will ever call, regardless of what the caller
// asks for - stops it being used as a general-purpose proxy to a more
// expensive model.
const ALLOWED_MODEL = 'claude-sonnet-5';

// Hard ceiling on tokens generated per call, regardless of what the caller
// requests.
// FIX (v7): was 3000. index.html's processTranscript() now requests 4096
// (bumped there this session to stop long, multi-section dictations
// truncating mid-JSON) - but this ceiling was silently clamping every
// request back down to 3000 regardless, which meant that client-side fix
// had no real effect against this deployed Worker. Raised to match, with
// the same "real headroom, not just enough for today's case" reasoning.
const MAX_TOKENS_CEILING = 4096;

// Hard ceiling on characters of text accepted per call (summed across every
// text block in every message, whether content is a plain string or an
// array of blocks).
const MAX_INPUT_CHARS = 20000;

// Hard ceiling on total base64 image data accepted per call, summed across
// every image block in every message.
const MAX_IMAGE_BASE64_CHARS = 8000000;

// NEW (v7): hard ceiling on uploaded audio size for the /transcribe
// endpoint. ~20MB is generous headroom for a long multi-minute field
// recording at a reasonable compressed bitrate (a 10-minute AAC/Opus
// recording is typically a few MB), while still bounding worst-case
// memory/CPU and Workers AI cost per call.
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

// Monthly AI-call allowance per plan. Matches the tiers in the Sayon
// Pricing Strategy doc (Starter/Pro/Business) plus a 'trial' tier for the
// 14-day free trial. 'business' is "unlimited" in the sales copy but still
// fair-use capped here - see the pricing doc's rationale.
const PLAN_LIMITS = {
  trial: 50,
  starter: 150,
  pro: 400,
  business: 2000,
};
const DEFAULT_PLAN_LIMIT = PLAN_LIMITS.trial;

// Paid plans the app can ask Checkout for, and the secret holding each
// plan's Stripe Price ID.
const PLAN_PRICE_ENV = {
  starter: 'STRIPE_PRICE_STARTER',
  pro: 'STRIPE_PRICE_PRO',
  business: 'STRIPE_PRICE_BUSINESS',
};

// How old a webhook's signed timestamp may be before it's rejected as a
// possible replay (Stripe's own libraries use the same 5 minutes).
const WEBHOOK_TOLERANCE_SECONDS = 300;

// Limits on /send-email. A report with photos can run to several MB, so
// the attachment ceiling is generous (Resend accepts up to 40MB per email).
const MAX_EMAIL_ATTACHMENTS = 4;
const MAX_EMAIL_BASE64_CHARS = 25 * 1024 * 1024;
const MAX_EMAIL_TEXT_CHARS = 5000;
const MAX_EMAIL_SUBJECT_CHARS = 200;
const EMAIL_PATTERN = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Stripe calls this server-to-server: no Origin header and no Supabase
    // session, so it's authenticated by its signature instead and has to be
    // routed before the origin and session checks below.
    if (url.pathname === '/stripe/webhook') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      return handleStripeWebhook(request, env);
    }

    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const isStripeRoute = url.pathname.startsWith('/stripe/');
    if (request.method !== 'POST' && !(isStripeRoute && request.method === 'GET')) {
      return new Response('Method not allowed', { status: 405 });
    }

    const allowed = origin === 'null' || ALLOWED_ORIGINS.some(o => origin.startsWith(o));
    if (!allowed) {
      return new Response('Forbidden', { status: 403 });
    }

    // Real per-user authentication (added in v4): require and verify a
    // Supabase session token.
    const authHeader = request.headers.get('Authorization') || '';
    const tokenMatch = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!tokenMatch) {
      return new Response('Unauthorized: missing session token', { status: 401, headers: corsHeaders(origin) });
    }
    const verifiedUser = await verifySupabaseToken(tokenMatch[1]);
    if (!verifiedUser) {
      return new Response('Unauthorized: invalid or expired session', { status: 401, headers: corsHeaders(origin) });
    }

    if (isStripeRoute) {
      return handleStripeRoute(url.pathname, request, verifiedUser, env, origin);
    }

    // Sending email isn't an AI call, so it skips the AI usage gate below
    // and checks only that the plan is current.
    if (url.pathname === '/send-email') {
      return handleSendEmail(request, verifiedUser, env, origin);
    }

    // Plan/subscription gate. Runs after identity is confirmed, before we
    // spend anything calling Anthropic or Workers AI.
    const gate = await checkPlanAndUsage(verifiedUser.id, env);
    if (!gate.allowed) {
      return new Response(gate.message, { status: gate.status, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/transcribe') {
      return handleTranscribe(request, origin, gate, env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400, headers: corsHeaders(origin) });
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return new Response('Invalid request: messages required', { status: 400, headers: corsHeaders(origin) });
    }

    const inputText = collectText(body.messages);
    if (inputText.length > MAX_INPUT_CHARS) {
      return new Response(`Invalid request: input exceeds ${MAX_INPUT_CHARS} characters`, { status: 413, headers: corsHeaders(origin) });
    }

    const imageBase64Len = collectImageBase64Length(body.messages);
    if (imageBase64Len > MAX_IMAGE_BASE64_CHARS) {
      return new Response('Invalid request: image exceeds size limit', { status: 413, headers: corsHeaders(origin) });
    }

    const safeBody = {
      model: ALLOWED_MODEL,
      max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS_CEILING, MAX_TOKENS_CEILING),
      system: body.system,
      messages: body.messages,
    };

    const anthropicResponse = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(safeBody),
    });

    const data = await anthropicResponse.json();

    // Only count it against the plan if Anthropic actually served the call -
    // a failed call (bad key, Anthropic outage, etc.) shouldn't burn the
    // user's allowance.
    if (anthropicResponse.ok) {
      await recordUsage(gate.subscription, env);
    }

    return new Response(JSON.stringify(data), {
      status: anthropicResponse.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  },
};

async function verifySupabaseToken(token) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY },
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.id) return null;
    return user;
  } catch {
    return null;
  }
}

function serviceHeadersFor(env) {
  return {
    'Content-Type': 'application/json',
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
}

// Looks up the caller's business (via team_members), then that business's
// row in `subscriptions`, creating a fresh trial row if one is somehow
// missing. Uses the service_role key (bypasses RLS - this must never be the
// anon key, since the subscriptions table intentionally has no policies for
// anon/authenticated). Returns { ok: true, businessId, sub } or
// { ok: false, status, message }.
async function loadBusinessSubscription(userId, env) {
  const serviceHeaders = serviceHeadersFor(env);

  const tmRes = await fetch(
    `${SUPABASE_URL}/rest/v1/team_members?user_id=eq.${userId}&select=business_id&limit=1`,
    { headers: serviceHeaders }
  );
  if (!tmRes.ok) {
    const detail = await tmRes.text().catch(() => '');
    console.error(`loadBusinessSubscription: team_members lookup failed (HTTP ${tmRes.status}): ${detail}`);
    return { ok: false, status: 500, message: 'Could not verify account' };
  }
  const tmRows = await tmRes.json();
  if (!tmRows.length) {
    return { ok: false, status: 403, message: 'No business associated with this account' };
  }
  const businessId = tmRows[0].business_id;

  const subRes = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?business_id=eq.${businessId}&limit=1`,
    { headers: serviceHeaders }
  );
  if (!subRes.ok) {
    const detail = await subRes.text().catch(() => '');
    console.error(`loadBusinessSubscription: subscriptions lookup failed (HTTP ${subRes.status}): ${detail}`);
    return { ok: false, status: 500, message: 'Could not verify subscription' };
  }
  let subRows = await subRes.json();

  // Defensive: the businesses-insert trigger should always create this row,
  // but if an older business somehow doesn't have one, create a fresh trial
  // row rather than silently blocking or silently allowing.
  if (!subRows.length) {
    const createRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
      method: 'POST',
      headers: { ...serviceHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({ business_id: businessId }),
    });
    if (!createRes.ok) {
      const detail = await createRes.text().catch(() => '');
      console.error(`loadBusinessSubscription: subscription create failed (HTTP ${createRes.status}): ${detail}`);
      return { ok: false, status: 500, message: 'Could not initialize subscription' };
    }
    subRows = await createRes.json();
  }

  return { ok: true, businessId, sub: subRows[0] };
}

// Usage for the current calendar month - the counter is only physically
// reset on the next AI call, so a new month reads as 0 until then.
function effectiveUsage(sub) {
  const now = new Date();
  const periodStart = new Date(sub.period_start);
  const rolledOver = now.getUTCFullYear() !== periodStart.getUTCFullYear() || now.getUTCMonth() !== periodStart.getUTCMonth();
  return { rolledOver, effectiveUsed: rolledOver ? 0 : sub.ai_calls_used_this_period };
}

// Returns { allowed, status?, message?, subscription }.
async function checkPlanAndUsage(userId, env) {
  try {
    const found = await loadBusinessSubscription(userId, env);
    if (!found.ok) {
      return { allowed: false, status: found.status, message: found.message };
    }
    const sub = found.sub;

    if (sub.status === 'canceled') {
      return { allowed: false, status: 402, message: 'Subscription canceled — please resubscribe to continue using AI features' };
    }
    if (sub.status === 'trialing' && new Date(sub.trial_ends_at).getTime() < Date.now()) {
      return { allowed: false, status: 402, message: 'Your 14-day trial has ended — subscribe to keep using Sayon AI features' };
    }

    const { rolledOver, effectiveUsed } = effectiveUsage(sub);
    const limit = PLAN_LIMITS[sub.plan] ?? DEFAULT_PLAN_LIMIT;
    if (effectiveUsed >= limit) {
      return { allowed: false, status: 429, message: 'Monthly AI usage limit reached for your plan — upgrade or wait for next billing period' };
    }

    return {
      allowed: true,
      subscription: { id: sub.id, effectiveUsed, rolledOver, serviceHeaders: serviceHeadersFor(env) },
    };
  } catch (err) {
    console.error('checkPlanAndUsage: unexpected error: ' + (err && err.message ? err.message : String(err)));
    return { allowed: false, status: 500, message: 'Could not verify plan' };
  }
}

// Increments (or resets-then-increments) the usage counter for a
// subscription row that checkPlanAndUsage already fetched.
async function recordUsage(subscription, env) {
  if (!subscription) return;
  try {
    const patch = subscription.rolledOver
      ? { ai_calls_used_this_period: 1, period_start: new Date().toISOString() }
      : { ai_calls_used_this_period: subscription.effectiveUsed + 1 };

    await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?id=eq.${subscription.id}`, {
      method: 'PATCH',
      headers: subscription.serviceHeaders,
      body: JSON.stringify(patch),
    });
  } catch {
    // Best-effort - a failed usage write shouldn't fail the response the
    // user already received their AI result for.
  }
}

async function updateSubscriptionRow(filter, patch, env) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?${filter}`, {
    method: 'PATCH',
    headers: { ...serviceHeadersFor(env), 'Prefer': 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`subscriptions update failed (HTTP ${res.status}): ${detail}`);
  }
  return res.json();
}

// ── STRIPE: APP-FACING ROUTES ────────────────────────────────────────────

async function handleStripeRoute(pathname, request, user, env, origin) {
  const reply = (status, payload) => jsonResponse(status, payload, origin);

  try {
    const found = await loadBusinessSubscription(user.id, env);
    if (!found.ok) return reply(found.status, { message: found.message });
    const { businessId, sub } = found;

    if (pathname === '/stripe/subscription-status') {
      if (request.method !== 'GET') return reply(405, { message: 'Method not allowed' });
      const { effectiveUsed } = effectiveUsage(sub);
      return reply(200, {
        plan: sub.plan,
        status: sub.status,
        trial_ends_at: sub.trial_ends_at,
        ai_calls_used_this_period: effectiveUsed,
        limit: PLAN_LIMITS[sub.plan] ?? DEFAULT_PLAN_LIMIT,
        stripe_customer_id: sub.stripe_customer_id || null,
      });
    }

    if (request.method !== 'POST') return reply(405, { message: 'Method not allowed' });
    if (!env.STRIPE_SECRET_KEY) return reply(503, { message: 'Billing is not configured yet' });

    // Only the business owner can start or change paid billing - a
    // technician on the team shouldn't be able to put the business on a
    // plan or cancel it.
    const isOwner = await isBusinessOwner(businessId, user.id, env);
    if (!isOwner) return reply(403, { message: 'Only the business owner can manage billing' });

    let body = {};
    try { body = await request.json(); } catch { /* empty body is fine */ }

    if (pathname === '/stripe/create-checkout-session') {
      const plan = body.plan;
      const priceId = PLAN_PRICE_ENV[plan] && env[PLAN_PRICE_ENV[plan]];
      if (!priceId) return reply(400, { message: 'Unknown plan' });

      // Already paying: a second Checkout would start a second, parallel
      // subscription. Send them to the Billing Portal to switch plans instead.
      if (sub.stripe_subscription_id && sub.status !== 'canceled' && sub.stripe_customer_id) {
        const portal = await stripeRequest(env, 'POST', '/billing_portal/sessions', {
          customer: sub.stripe_customer_id,
          return_url: safeReturnUrl(body.cancelUrl, 'updated'),
        });
        return reply(200, { url: portal.url });
      }

      const customerId = sub.stripe_customer_id || await createStripeCustomer(businessId, user, env);

      const session = await stripeRequest(env, 'POST', '/checkout/sessions', {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: businessId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: safeReturnUrl(body.successUrl, 'success'),
        cancel_url: safeReturnUrl(body.cancelUrl, 'cancelled'),
        allow_promotion_codes: 'true',
        metadata: { business_id: businessId },
        subscription_data: { metadata: { business_id: businessId } },
      });
      return reply(200, { url: session.url });
    }

    if (pathname === '/stripe/create-portal-session') {
      if (!sub.stripe_customer_id) return reply(400, { message: 'No billing account yet - choose a plan first' });
      const portal = await stripeRequest(env, 'POST', '/billing_portal/sessions', {
        customer: sub.stripe_customer_id,
        return_url: safeReturnUrl(body.returnUrl, 'updated'),
      });
      return reply(200, { url: portal.url });
    }

    return reply(404, { message: 'Not found' });
  } catch (err) {
    console.error(`stripe route ${pathname} failed: ` + (err && err.message ? err.message : String(err)));
    return reply(502, { message: 'Billing request failed' });
  }
}

async function isBusinessOwner(businessId, userId, env) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/businesses?id=eq.${businessId}&select=owner_id&limit=1`,
    { headers: serviceHeadersFor(env) }
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return !!(rows.length && rows[0].owner_id === userId);
}

// Creates the Stripe customer for a business and saves its id straight
// away, so a cancelled checkout doesn't leave an orphan customer that the
// next attempt duplicates.
async function createStripeCustomer(businessId, user, env) {
  const customer = await stripeRequest(env, 'POST', '/customers', {
    email: user.email,
    metadata: { business_id: businessId },
  });
  await updateSubscriptionRow(`business_id=eq.${businessId}`, { stripe_customer_id: customer.id }, env);
  return customer.id;
}

// Return URLs come from the browser, so only ever send Stripe back to the
// app itself (never an arbitrary site), and fall back to the hosted app for
// non-http(s) origins like Capacitor that Stripe won't accept.
function safeReturnUrl(candidate, marker) {
  try {
    const u = new URL(candidate);
    if (u.origin === new URL(DEFAULT_APP_URL).origin || u.origin === 'http://localhost' || u.origin === 'https://localhost') {
      return u.toString();
    }
  } catch { /* fall through */ }
  return `${DEFAULT_APP_URL}?billing=${marker}`;
}

// ── STRIPE: WEBHOOK ──────────────────────────────────────────────────────
// Keeps the `subscriptions` row in step with Stripe: which plan was paid
// for, and whether it's active, past due or canceled. Subscribe the
// endpoint to the events listed in worker/README.md.

async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
    return new Response('Billing is not configured', { status: 503 });
  }

  const rawBody = await request.text();
  const valid = await verifyStripeSignature(rawBody, request.headers.get('Stripe-Signature') || '', env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Invalid signature', { status: 400 });

  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('Invalid JSON', { status: 400 }); }

  try {
    const obj = event.data && event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
        if (obj.mode === 'subscription' && obj.subscription) {
          const stripeSub = await stripeRequest(env, 'GET', `/subscriptions/${obj.subscription}`);
          await syncSubscription(stripeSub, env, obj.client_reference_id);
        }
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSubscription(obj, env);
        break;
      default:
        // Not an event we act on - acknowledge so Stripe doesn't retry it.
        break;
    }
  } catch (err) {
    // A 500 makes Stripe retry the event later, which is what we want if
    // Supabase or Stripe hiccupped.
    console.error(`stripe webhook ${event.type} failed: ` + (err && err.message ? err.message : String(err)));
    return new Response('Webhook handling failed', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Writes one Stripe subscription's state onto the business's row.
async function syncSubscription(stripeSub, env, fallbackBusinessId) {
  const businessId = (stripeSub.metadata && stripeSub.metadata.business_id) || fallbackBusinessId;
  const filter = businessId
    ? `business_id=eq.${businessId}`
    : `stripe_customer_id=eq.${encodeURIComponent(stripeSub.customer)}`;

  const existingRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?${filter}&limit=1`, { headers: serviceHeadersFor(env) });
  if (!existingRes.ok) throw new Error(`subscriptions lookup failed (HTTP ${existingRes.status})`);
  const existingRows = await existingRes.json();
  if (!existingRows.length) {
    console.error(`stripe webhook: no subscriptions row for subscription ${stripeSub.id}`);
    return;
  }
  const existing = existingRows[0];

  // An event for an older subscription (e.g. one replaced by a newer
  // checkout) mustn't overwrite the current one.
  if (existing.stripe_subscription_id && existing.stripe_subscription_id !== stripeSub.id && stripeSub.status === 'canceled') {
    return;
  }

  const priceId = stripeSub.items && stripeSub.items.data && stripeSub.items.data[0] && stripeSub.items.data[0].price && stripeSub.items.data[0].price.id;
  const plan = planForPrice(priceId, env);

  const patch = {
    status: mapStripeStatus(stripeSub.status),
    stripe_customer_id: stripeSub.customer,
    stripe_subscription_id: stripeSub.id,
  };
  if (plan) patch.plan = plan;
  else console.error(`stripe webhook: price ${priceId} doesn't match any STRIPE_PRICE_* secret - plan left unchanged`);

  // A brand-new paid subscription starts a fresh allowance rather than
  // carrying over what was used during the trial.
  if (existing.stripe_subscription_id !== stripeSub.id) {
    patch.ai_calls_used_this_period = 0;
    patch.period_start = new Date().toISOString();
  }

  await updateSubscriptionRow(`id=eq.${existing.id}`, patch, env);
}

function planForPrice(priceId, env) {
  if (!priceId) return null;
  for (const [plan, envName] of Object.entries(PLAN_PRICE_ENV)) {
    if (env[envName] === priceId) return plan;
  }
  return null;
}

// The subscriptions table only allows trialing/active/past_due/canceled.
function mapStripeStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    case 'paused':
      return 'past_due';
    default: // canceled, incomplete_expired
      return 'canceled';
  }
}

// Stripe-Signature is "t=<unix>,v1=<hex hmac>[,v1=...]"; the HMAC-SHA256
// is over "<t>.<raw body>" keyed with the endpoint's signing secret.
async function verifyStripeSignature(payload, header, secret) {
  const parts = header.split(',').map(p => p.split('='));
  const timestamp = (parts.find(([k]) => k === 't') || [])[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return signatures.some(sig => timingSafeEqual(sig, expected));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── STRIPE: API CLIENT ───────────────────────────────────────────────────

async function stripeRequest(env, method, path, params) {
  const init = {
    method,
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
  };
  if (params) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = encodeStripeParams(params);
  }
  const res = await fetch(`${STRIPE_API}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} failed (HTTP ${res.status}): ${data.error && data.error.message || 'unknown error'}`);
  }
  return data;
}

// Stripe takes form-encoded bodies with bracketed keys for nesting, e.g.
// line_items[0][price]=price_123&metadata[business_id]=abc.
function encodeStripeParams(params, prefix, out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') encodeStripeParams(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

// ── EMAIL ────────────────────────────────────────────────────────────────
// Sends the client their PDFs from the business, through Resend. The From
// address is always MAIL_FROM (a domain verified in Resend, so it isn't
// marked as spam); the business's name is shown as the sender and replies
// go to the business's own email. { check: true } only reports whether
// sending is set up, so the app knows which way to send before anyone taps.
async function handleSendEmail(request, user, env, origin) {
  const reply = (status, payload) => jsonResponse(status, payload, origin);

  let body;
  try { body = await request.json(); } catch { return reply(400, { message: 'Invalid JSON' }); }

  const configured = !!(env.RESEND_API_KEY && env.MAIL_FROM);
  if (body && body.check) return reply(200, { configured });
  if (!configured) return reply(501, { message: 'Email sending is not set up yet' });

  try {
    const found = await loadBusinessSubscription(user.id, env);
    if (!found.ok) return reply(found.status, { message: found.message });
    const sub = found.sub;
    const trialOver = sub.status === 'trialing' && new Date(sub.trial_ends_at).getTime() < Date.now();
    if (sub.status === 'canceled' || trialOver) {
      return reply(402, { message: 'Your plan has ended. Subscribe to send from SAYON' });
    }

    const to = cleanEmail(body.to);
    if (!to) return reply(400, { message: "The client's email address doesn't look right" });
    const subject = typeof body.subject === 'string' ? body.subject.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_EMAIL_SUBJECT_CHARS) : '';
    if (!subject) return reply(400, { message: 'The email needs a subject' });
    const text = typeof body.text === 'string' ? body.text.slice(0, MAX_EMAIL_TEXT_CHARS) : '';

    // PDFs only: every attachment must be named .pdf and its content must
    // start with the PDF signature ("%PDF" is "JVBER" in base64).
    const files = Array.isArray(body.attachments) ? body.attachments : [];
    if (!files.length || files.length > MAX_EMAIL_ATTACHMENTS) return reply(400, { message: 'Attach between 1 and 4 PDFs' });
    let totalChars = 0;
    const attachments = [];
    for (const f of files) {
      const filename = f && typeof f.filename === 'string' ? f.filename.replace(/[\\/\r\n"]+/g, '_').slice(0, 120) : '';
      const content = f && typeof f.content === 'string' ? f.content : '';
      if (!/\.pdf$/i.test(filename) || !content.startsWith('JVBER')) return reply(400, { message: 'Only PDFs can be attached' });
      totalChars += content.length;
      attachments.push({ filename, content });
    }
    if (totalChars > MAX_EMAIL_BASE64_CHARS) return reply(413, { message: 'The PDFs are too large to email' });

    const fromName = (typeof body.fromName === 'string' ? body.fromName : '').replace(/[<>"\r\n]+/g, '').trim().slice(0, 80) || 'SAYON';
    const replyTo = cleanEmail(body.replyTo);
    const copyTo = cleanEmail(body.copyTo);

    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `"${fromName}" <${env.MAIL_FROM}>`,
        to: [to],
        ...(copyTo && copyTo !== to ? { bcc: [copyTo] } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        text,
        attachments,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`send-email: Resend refused (HTTP ${res.status}): ${data && data.message ? data.message : 'unknown error'}`);
      return reply(502, { message: 'The email service didn\'t accept it. Try again, or send it from your mail app' });
    }
    return reply(200, { id: data.id || null });
  } catch (err) {
    console.error('send-email failed: ' + (err && err.message ? err.message : String(err)));
    return reply(502, { message: 'Could not send the email' });
  }
}

function cleanEmail(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  return v.length <= 254 && EMAIL_PATTERN.test(v) ? v : '';
}

// ── TRANSCRIBE ───────────────────────────────────────────────────────────

// NEW (v7): audio transcription endpoint for Sayon's experimental,
// opt-in higher-accuracy dictation path. Only ever reached after the same
// CORS/Bearer-auth/plan-gate checks in fetch() above have already passed
// for this request - see the routing comment there. Uses Cloudflare's own
// Workers AI Whisper model rather than a third-party API, so no new
// secret/API key is needed, only the Workers AI binding described in the
// version-history comment at the top of this file.
async function handleTranscribe(request, origin, gate, env) {
  if (!env.AI) {
    console.error('handleTranscribe: env.AI binding missing - add a Workers AI binding named "AI" to this Worker (Settings -> Bindings) and redeploy');
    return new Response('Transcription is not configured on this server yet', { status: 501, headers: corsHeaders(origin) });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return new Response('Invalid request: expected multipart/form-data', { status: 400, headers: corsHeaders(origin) });
  }

  const audioFile = form.get('audio');
  if (!audioFile || typeof audioFile.arrayBuffer !== 'function') {
    return new Response('Invalid request: "audio" file is required', { status: 400, headers: corsHeaders(origin) });
  }
  if (audioFile.size > MAX_AUDIO_BYTES) {
    return new Response(`Invalid request: audio exceeds ${Math.floor(MAX_AUDIO_BYTES / 1_000_000)}MB limit`, { status: 413, headers: corsHeaders(origin) });
  }

  // Optional - the client sends Sayon's brand/species vocabulary here to
  // bias recognition (see buildTranscriptionVocabHint() in index.html).
  // Capped defensively; this is a short hint, not arbitrary user text to
  // forward to the model unchecked.
  const initialPromptRaw = form.get('initial_prompt');
  const initialPrompt = typeof initialPromptRaw === 'string' ? initialPromptRaw.slice(0, 1000) : undefined;

  let aiResult;
  try {
    const audioBuffer = await audioFile.arrayBuffer();
    const base64Audio = arrayBufferToBase64(audioBuffer);
    aiResult = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: base64Audio,
      task: 'transcribe',
      language: 'en',
      ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
      vad_filter: true, // skip silent stretches - field recordings often have pauses between findings
    });
  } catch (err) {
    console.error('handleTranscribe: Workers AI call failed: ' + (err && err.message ? err.message : String(err)));
    return new Response('Transcription failed', { status: 502, headers: corsHeaders(origin) });
  }

  const transcript = aiResult && typeof aiResult.text === 'string' ? aiResult.text.trim() : '';
  if (!transcript) {
    return new Response('Transcription produced no text', { status: 502, headers: corsHeaders(origin) });
  }

  // Same usage metering as the Anthropic calls above - this is still an AI
  // feature spending the business's monthly allowance, not a free side
  // door around it.
  await recordUsage(gate.subscription, env);

  return new Response(JSON.stringify({ transcript }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// NEW (v7): converts an ArrayBuffer to a base64 string in fixed-size
// chunks. String.fromCharCode.apply(null, hugeArray) throws once the
// array gets into the tens of thousands of elements (a call-stack/
// argument-count limit, not a Worker-specific issue), so pushing a
// multi-MB recording through in one call would fail for exactly the
// longer recordings this endpoint most needs to handle correctly.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ── HELPERS ──────────────────────────────────────────────────────────────

function collectText(messages) {
  let text = '';
  for (const m of messages) {
    if (typeof m.content === 'string') {
      text += m.content;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') text += block.text;
      }
    }
  }
  return text;
}

function collectImageBase64Length(messages) {
  let len = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block && block.type === 'image' && block.source && block.source.type === 'base64' && typeof block.source.data === 'string') {
        len += block.source.data.length;
      }
    }
  }
  return len;
}

function jsonResponse(status, payload, origin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function corsHeaders(origin) {
  const isAllowed = origin === 'null' || ALLOWED_ORIGINS.some(o => origin.startsWith(o));
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
