// ── BUSINESS SETTINGS SYNC ──────────────────────────────────────────────────
// Company details (with the logo, payment details and agreement wording), the
// quote price list and the invoice counter belong to the business, not the
// phone. They're kept in businesses.settings so a new phone, or a technician
// on the team, starts with them:
//   settings = { company: {..., updatedAt}, prices: {..., __updatedAt}, invoiceSeq }
// The owner's phone writes them; the team only reads (see
// supabase/business-settings.sql). Company details and prices each go by
// their own time, newest wins. The invoice counter takes the higher number,
// so two phones never hand out the same invoice number once both have synced.
const BUSINESS_SYNC_DELAY_MS = 1500;
let businessSyncTimer = null;

function isBusinessOwner() {
  return !!(authBusiness && authUser && authBusiness.owner_id === authUser.id);
}

function hasContent(obj) {
  return !!obj && Object.keys(obj).some(k => k !== 'updatedAt' && k !== '__updatedAt');
}

function localBusinessSettings() {
  return {
    company: getCompanyDetails(),
    prices: quotePriceMemory(),
    invoiceSeq: parseInt(readJSON(invoiceSeqKey(), 1000), 10) || 1000,
  };
}

// Writes what the account has that's newer than this phone's copy. Runs when
// the business loads, before the company form is filled in.
function applyCloudBusinessSettings() {
  const cloud = (authBusiness && authBusiness.settings) || {};
  const local = localBusinessSettings();
  try {
    if (hasContent(cloud.company) && (cloud.company.updatedAt || 0) > (local.company.updatedAt || 0)) {
      localStorage.setItem(companyStorageKey(), JSON.stringify(takeCloudCopy(cloud.company, local.company, 'updatedAt')));
    }
    if (hasContent(cloud.prices) && (cloud.prices.__updatedAt || 0) > (local.prices.__updatedAt || 0)) {
      localStorage.setItem(quotePricesStorageKey(), JSON.stringify(takeCloudCopy(cloud.prices, local.prices, '__updatedAt')));
    }
    if ((parseInt(cloud.invoiceSeq, 10) || 0) > local.invoiceSeq) {
      localStorage.setItem(invoiceSeqKey(), JSON.stringify(parseInt(cloud.invoiceSeq, 10)));
    }
  } catch (e) { console.warn('Could not apply business settings:', e); }
  // Settings made on this phone before syncing existed go up now.
  if (isBusinessOwner() && localSettingsAhead(cloud)) scheduleBusinessSync();
  renderCompanySettingsAccess();
}

// The account copy replaces this phone's, except for details this phone
// entered before syncing existed (no time on them): anything the account
// copy has blank is kept from the phone, so a near-empty copy pushed first
// by another browser can't wipe real details. The merged copy then goes up.
function takeCloudCopy(cloudPart, localPart, timeKey) {
  if (localPart[timeKey] || !hasContent(localPart)) return cloudPart;
  const merged = Object.assign({}, cloudPart);
  Object.keys(localPart).forEach(k => {
    const v = merged[k];
    if (v === undefined || v === null || v === '') merged[k] = localPart[k];
  });
  merged[timeKey] = Date.now();
  return merged;
}

function localSettingsAhead(cloud) {
  const local = localBusinessSettings();
  const newer = (mine, theirs, key) => hasContent(mine) && (!hasContent(theirs) || (mine[key] || 0) > (theirs[key] || 0));
  return newer(local.company, cloud.company, 'updatedAt') ||
    newer(local.prices, cloud.prices, '__updatedAt') ||
    local.invoiceSeq > (parseInt(cloud.invoiceSeq, 10) || 0);
}

// Called by everything that changes a synced setting.
function scheduleBusinessSync() {
  if (!isBusinessOwner() || !authSession) return;
  clearTimeout(businessSyncTimer);
  businessSyncTimer = setTimeout(pushBusinessSettings, BUSINESS_SYNC_DELAY_MS);
}

async function pushBusinessSettings() {
  businessSyncTimer = null;
  if (!isBusinessOwner() || !authSession) return;
  // Details from before syncing existed carry no time; stamping them makes
  // the account copy the one other phones take.
  if (!getCompanyDetails().updatedAt && hasContent(getCompanyDetails())) storeCompanyDetails(getCompanyDetails());
  if (!quotePriceMemory().__updatedAt && hasContent(quotePriceMemory())) storeQuotePriceMemory(quotePriceMemory());
  clearTimeout(businessSyncTimer);
  const settings = localBusinessSettings();
  // Never lower the counter another phone already pushed.
  const cloudSeq = parseInt(((authBusiness.settings || {}).invoiceSeq), 10) || 0;
  settings.invoiceSeq = Math.max(settings.invoiceSeq, cloudSeq);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/businesses?id=eq.${authBusiness.id}`, {
      method: 'PATCH',
      headers: { ...getAuthHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ settings }),
    });
    if (res.ok) authBusiness.settings = settings;
    else console.warn('Business settings not synced:', res.status);
  } catch (e) { /* offline: the next change or app open tries again */ }
}

// Technicians see the owner's details but can't change them.
function renderCompanySettingsAccess() {
  const owner = !authBusiness || isBusinessOwner();
  document.querySelectorAll('[data-company-setting]').forEach(el => { el.disabled = !owner; });
  const note = document.getElementById('companyTeamNote');
  if (note) note.hidden = owner;
}
