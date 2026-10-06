// ── TELEMETRY ─────────────────────────────────────────────────────────────
// Sentry gets crashes and the failures the app catches; PostHog gets which
// screens are opened and which steps are finished, so we can see where
// inspectors get stuck. Loaded before js/app.js so errors while the app
// starts are caught too.
//
// What leaves the phone: screen and step names, counts, timings, the
// device type, error messages and stack traces, and the account's random
// id. Never client names, addresses, emails or phone numbers, dictation or
// transcripts, report text, photos or signatures. Nothing typed into the
// app is read here, and every outgoing text goes through scrubTelemetryText.
// Inspectors can turn it off in Menu › Data & backups.
//
// Only runs over https (the live site), so local testing sends nothing.

const SENTRY_DSN = '';   // Sentry project sayon-app (US). Empty = Sentry off.
const POSTHOG_KEY = 'phc_t8iTajrVTkmxHcKQzhFkjEQSjLvc5Q77iAi3hDUD5HLy'; // public project key, safe in the page
const POSTHOG_HOST = 'https://us.i.posthog.com';
const TELEMETRY_OFF_KEY = 'korva_telemetry_off';
const TELEMETRY_ID_KEY = 'korva_telemetry_id';
const TELEMETRY_QUEUE_KEY = 'korva_telemetry_queue';
const TELEMETRY_QUEUE_MAX = 300;   // events kept for later when there's no signal

function readTelemetryPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeTelemetryPref(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

let telemetryEnabled = false;   // set by restoreTelemetrySetting below

// Emails, long numbers (phones, licence and job numbers) and the query and
// hash of any web address (sign-in tokens ride in a reset link's hash).
function scrubTelemetryText(text) {
  return String(text ?? '')
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi, '[email]')
    .replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, '$1')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '[number]')
    .slice(0, 300);
}

function scrubTelemetryUrl(url) {
  try {
    const u = new URL(url, location.href);
    return u.origin + u.pathname;
  } catch {
    return scrubTelemetryText(url);
  }
}

// ── Sentry: errors ────────────────────────────────────────────────────────
let sentryReady = false;

function startSentry() {
  if (sentryReady || !telemetryEnabled || !SENTRY_DSN || !window.Sentry) return;
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: location.hostname,
    sendDefaultPii: false,
    // Console messages can hold whatever was being logged, so they stay out.
    integrations: (defaults) => defaults
      .filter((i) => i.name !== 'Breadcrumbs')
      .concat(Sentry.breadcrumbsIntegration({ console: false })),
    beforeBreadcrumb(crumb) {
      if (crumb.category === 'ui.input') return null;
      if (crumb.message) crumb.message = scrubTelemetryText(crumb.message);
      const d = crumb.data;
      if (d) {
        if (d.url) d.url = scrubTelemetryUrl(d.url);
        if (d.from) d.from = scrubTelemetryUrl(d.from);
        if (d.to) d.to = scrubTelemetryUrl(d.to);
      }
      return crumb;
    },
    beforeSend(event) {
      if (!telemetryEnabled) return null;
      if (event.request) {
        if (event.request.url) event.request.url = scrubTelemetryUrl(event.request.url);
        delete event.request.query_string;
        delete event.request.cookies;
      }
      if (event.message) event.message = scrubTelemetryText(event.message);
      (event.exception?.values || []).forEach((ex) => {
        if (ex.value) ex.value = scrubTelemetryText(ex.value);
        (ex.stacktrace?.frames || []).forEach((f) => { if (f.filename) f.filename = scrubTelemetryUrl(f.filename); });
      });
      delete event.extra;
      return event;
    },
  });
  sentryReady = true;
  if (telemetryUserId) Sentry.setUser({ id: telemetryUserId });
}

// For failures the app catches and carries on from (a PDF that wouldn't
// build, saved reports that couldn't be read). `where` names the step.
function reportError(err, where) {
  if (!sentryReady || !telemetryEnabled) return;
  const e = err instanceof Error ? err : new Error(String(err));
  Sentry.captureException(e, { tags: { where } });
}

// ── PostHog: screens and steps ────────────────────────────────────────────
let telemetryQueue = [];
try { telemetryQueue = JSON.parse(readTelemetryPref(TELEMETRY_QUEUE_KEY) || '[]'); } catch {}
if (!Array.isArray(telemetryQueue)) telemetryQueue = [];

let telemetryUserId = null;    // the Supabase account id once signed in
let telemetryFlushTimer = null;
let telemetryFlushing = false;

function telemetryRandomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
}

// PostHog groups events into sessions by a time-ordered (v7) UUID.
function telemetrySessionId() {
  const hex = Date.now().toString(16).padStart(12, '0');
  const rand = telemetryRandomId().replace(/-/g, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(13, 16)}-${rand.slice(16, 20)}-${rand.slice(20, 32)}`;
}
const telemetrySession = telemetrySessionId();

function telemetryAnonId() {
  let id = readTelemetryPref(TELEMETRY_ID_KEY);
  if (!id) { id = telemetryRandomId(); writeTelemetryPref(TELEMETRY_ID_KEY, id); }
  return id;
}

function telemetryDevice() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iOS'
    : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac OS X' : /Windows/.test(ua) ? 'Windows' : 'Other';
  const browser = /EdgA?\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const mobile = os === 'iOS' || os === 'Android';
  return { $os: os, $browser: browser, $device_type: mobile ? 'Mobile' : 'Desktop' };
}
const telemetryDeviceProps = telemetryDevice();

// Records one step. Props must be names, counts, timings or yes/no, never
// anything the inspector typed or said.
function track(event, props = {}) {
  if (!telemetryEnabled) return;
  const properties = {
    ...props,
    ...telemetryDeviceProps,
    distinct_id: telemetryUserId || telemetryAnonId(),
    $process_person_profile: !!telemetryUserId,
    $session_id: telemetrySession,
    $lib: 'sayon-web',
    $current_url: scrubTelemetryUrl(location.href),
    $host: location.host,
    $pathname: location.pathname,
    $screen_width: screen.width,
    $screen_height: screen.height,
    $viewport_width: innerWidth,
    installed: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    online: navigator.onLine,
  };
  telemetryQueue.push({ event, properties, timestamp: new Date().toISOString(), uuid: telemetryRandomId() });
  if (telemetryQueue.length > TELEMETRY_QUEUE_MAX) telemetryQueue.splice(0, telemetryQueue.length - TELEMETRY_QUEUE_MAX);
  saveTelemetryQueue();
  clearTimeout(telemetryFlushTimer);
  telemetryFlushTimer = setTimeout(flushTelemetry, telemetryQueue.length >= 20 ? 0 : 5000);
}

function saveTelemetryQueue() {
  writeTelemetryPref(TELEMETRY_QUEUE_KEY, telemetryQueue.length ? JSON.stringify(telemetryQueue) : null);
}

// Sends what's waiting. Events stay queued (on the phone) until PostHog
// takes them, so a subfloor with no signal loses nothing.
async function flushTelemetry() {
  if (!telemetryEnabled || telemetryFlushing || !telemetryQueue.length || !navigator.onLine) return;
  telemetryFlushing = true;
  const batch = telemetryQueue.slice(0, 50);
  try {
    const res = await fetch(POSTHOG_HOST + '/batch/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: POSTHOG_KEY, batch }),
      keepalive: true,
    });
    // 4xx other than rate limits means PostHog won't ever take these.
    if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
      const sent = new Set(batch.map((e) => e.uuid));
      telemetryQueue = telemetryQueue.filter((e) => !sent.has(e.uuid));
      saveTelemetryQueue();
    }
  } catch {
    // No signal or blocked: try again later.
  } finally {
    telemetryFlushing = false;
  }
  if (telemetryQueue.length && navigator.onLine) telemetryFlushTimer = setTimeout(flushTelemetry, 30000);
}

// Links this phone's earlier steps to the account. Only the random account
// id is sent, never the email or business name.
function telemetryIdentify(userId) {
  if (!userId || userId === telemetryUserId) return;
  const anon = telemetryAnonId();
  telemetryUserId = userId;
  if (sentryReady) Sentry.setUser({ id: userId });
  track('$identify', { $anon_distinct_id: anon });
}

function telemetrySignedOut() {
  track('signed_out');
  telemetryUserId = null;
  writeTelemetryPref(TELEMETRY_ID_KEY, null);  // a fresh random id for whoever signs in next
  if (sentryReady) Sentry.setUser(null);
}

function toggleTelemetrySetting() {
  const off = readTelemetryPref(TELEMETRY_OFF_KEY) === '1';
  writeTelemetryPref(TELEMETRY_OFF_KEY, off ? null : '1');
  restoreTelemetrySetting();
}

// Reads the setting (also after a backup is imported) and shows it.
function restoreTelemetrySetting() {
  const on = readTelemetryPref(TELEMETRY_OFF_KEY) !== '1';
  telemetryEnabled = on && location.protocol === 'https:';
  if (!telemetryEnabled) { telemetryQueue = []; saveTelemetryQueue(); }
  startSentry();
  const btn = document.getElementById('toggleTelemetry');
  if (btn) {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

restoreTelemetrySetting();
window.addEventListener('online', flushTelemetry);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushTelemetry(); });
track('app_opened');
