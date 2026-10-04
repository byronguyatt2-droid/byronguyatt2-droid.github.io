// jsPDF loads from a CDN (see the <script src> tag above, in <head>). If that
// request fails — poor connectivity, a corporate/site firewall, an ad blocker,
// or the CDN being briefly down — `window.jspdf` never gets defined. The old
// code here did `const { jsPDF } = window.jspdf;`, which THROWS the instant
// window.jspdf is undefined. Because this is a single top-level <script>
// block, that throw aborted the rest of this script right here — every
// function and constant declared below (including SECTIONS) never ran, so
// the ENTIRE app silently broke: no section would open, nothing would
// respond, with no error shown to the technician. Given this app is meant to
// be used in the field (subfloors, rural properties, patchy signal), a
// flaky connection at page-load should never be able to take down report
// entry — only PDF export actually needs jsPDF, so we defer the failure to
// there instead of crashing everything up front.
let jsPDF = (window.jspdf && window.jspdf.jsPDF) || null;

// If jsPDF didn't load the first time, retry loading it on demand (e.g. when
// the technician's connection comes back and they try to generate a PDF)
// instead of forcing a full page reload.
function ensureJsPDFLoaded() {
  if (jsPDF) return Promise.resolve(jsPDF);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-jspdf-retry]');
    if (existing) existing.remove();
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.setAttribute('data-jspdf-retry', '1');
    s.onload = () => {
      jsPDF = (window.jspdf && window.jspdf.jsPDF) || null;
      if (jsPDF) resolve(jsPDF); else reject(new Error('jsPDF script loaded but did not define window.jspdf.jsPDF'));
    };
    s.onerror = () => reject(new Error('Could not load the PDF library — check your internet connection and try again.'));
    document.head.appendChild(s);
  });
}

// ── STATE ─────────────────────────────────────────────────────────────────
let isRecording = false;
let recognition = null;
let currentTranscript = '';
// FIX: the Web Speech API reports a per-result confidence score (0-1) that
// was never looked at - a garbled transcript from wind/background noise
// looked no different on screen from a clean one. This flag drives a
// visible warning the moment a low-confidence result comes back, so the
// technician notices while still on site and can redo that bit immediately
// instead of only discovering it later during report review.
let lowConfidenceFlagged = false;
// TEMP DEBUG — see matching comment near #confDebugLine in the HTML.
let confDebugLog = [];

// ── EXPERIMENTAL: server-side audio transcription (beta, opt-in) ──────────
// Runs ALONGSIDE the Web Speech API transcript above, never instead of it —
// the on-device transcript stays authoritative and the UI never waits on or
// blocks for this. It's opt-in and defaults OFF (see the toggle in Settings)
// because it means running a SECOND, independent microphone consumer
// (MediaRecorder, via its own getUserMedia stream) at the same time as an
// already-active Web Speech API recognition session — a combination that
// has not been confirmed safe on real iOS Safari hardware. The existing
// dictation flow is the core, working, business-critical feature of this
// app; nothing about this experiment is allowed to risk it. If it ever
// looks like it's interfering (see the onerror handler in
// startAudioCapture()), it self-disables for the rest of the session rather
// than keep retrying something that might be causing problems.
let audioCaptureEnabled = false;
let mediaRecorder = null;
let audioRecordedChunks = [];
let audioCaptureStream = null;
let audioCaptureSupportCache = null; // null = not checked yet; else true/false, cached
let audioCaptureFailedThisSession = false;
let serverTranscriptSuggestion = null;
let serverTranscriptOriginalText = null;

let reportData = {};
let editOn = false;
let activeEditEl = null;
let appInitialised = false; // tracks whether Korvus's one-time setup has run
// Tracks which signed-in account's data is currently live in reportData/the
// open form — see the reset block at the top of enterApp() for why this
// exists: without it, switching accounts in one browser tab (sign out, sign
// back in as someone else, no page reload) left the PREVIOUS account's
// in-progress report - and critically, its currentReportId - sitting in
// memory and on screen for the new account to unknowingly build on top of
// and save over.
let lastActiveAccountUserId = null;

// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// ONBOARDING
// ══════════════════════════════════════════════════════════════════════════
const OB_KEY = 'korva_onboarded_v1';

function shouldShowOnboarding() {
  return !localStorage.getItem(OB_KEY);
}

function showOnboarding() {
  document.getElementById('authScreen').style.display   = 'none';
  document.getElementById('onboardScreen').style.display = 'flex';
  // Pre-fill business name from auth metadata if available
  const meta = authUser?.user_metadata || {};
  if (meta.business_name) {
    const el = document.getElementById('ob-companyName');
    if (el) el.value = meta.business_name;
  }
  if (authBusiness?.name) {
    const el = document.getElementById('ob-companyName');
    if (el && !el.value) el.value = authBusiness.name;
  }
}

function obShowPanel(idx) {
  [0,1,2].forEach(i => {
    document.getElementById(`ob-panel-${i}`).style.display = i === idx ? 'flex' : 'none';
    const step = document.getElementById(`ob-step-${i}`);
    step.classList.remove('active','done');
    if (i < idx)  step.classList.add('done');
    if (i === idx) step.classList.add('active');
  });
}

function obNext(currentStep) {
  if (currentStep === 0) {
    // Save company details from onboarding
    const name    = document.getElementById('ob-companyName').value.trim();
    const licence = document.getElementById('ob-licence').value.trim();
    const phone   = document.getElementById('ob-phone').value.trim();
    const abn     = document.getElementById('ob-abn').value.trim();
    if (name) {
      document.getElementById('companyName').value    = name;
      document.getElementById('companyLicence').value = licence;
      document.getElementById('companyPhone').value   = phone;
      document.getElementById('companyABN').value     = abn;
      saveCompanyDetails();
      // Also save licence to inspector licence field
      if (licence) {
        const licEl = document.getElementById('inspectorLicence');
        if (licEl) { licEl.value = licence; reportData.inspectorLicence = licence; }
      }
    }
  }
  obShowPanel(currentStep + 1);
}

function obRunDemo() {
  const btn      = document.getElementById('obDemoBtn');
  const demoText = document.getElementById('obDemoText');
  const nextBtn  = document.getElementById('obDemoNext');

  btn.disabled = true;
  btn.textContent = 'Running…';
  demoText.classList.add('active');

  const phrase = 'Detached house, single storey, brick veneer walls, colorbond roof, concrete slab on ground, north facing, fine and dry, owner occupied.';
  let i = 0;
  demoText.textContent = '';

  // Typewriter effect
  const typeInterval = setInterval(() => {
    demoText.textContent = phrase.slice(0, i);
    i++;
    if (i > phrase.length) {
      clearInterval(typeInterval);
      // Flash each field as if populating
      setTimeout(() => {
        demoText.textContent = '✓ Fields extracted — Structure Type, Height, Wall Construction, Roof Type, Floor Type, Orientation, Weather, Occupancy';
        demoText.style.color = 'var(--green)';
        btn.style.display   = 'none';
        nextBtn.textContent  = 'Continue →';
        nextBtn.style.background  = 'var(--accent)';
        nextBtn.style.color       = 'white';
        nextBtn.style.border      = 'none';
      }, 600);
    }
  }, 22);
}

function obSkip() {
  localStorage.setItem(OB_KEY, '1');
  document.getElementById('onboardScreen').style.display = 'none';
  document.getElementById('mainMenu').style.display      = 'flex';
}

function obFinish() {
  localStorage.setItem(OB_KEY, '1');
  document.getElementById('onboardScreen').style.display = 'none';
  document.getElementById('mainMenu').style.display      = 'flex';
  // Open the sidebar so they can start a new job immediately
  setTimeout(() => {
    const drawer = document.getElementById('sidebarPanel');
    if (drawer && !drawer.classList.contains('open')) toggleDrawer();
  }, 400);
}

// ── ACCESS SECTION — NO LIMITATIONS TOGGLE ────────────────────────────────
// (toggleNoAccessIssues / syncAccessClearBtn removed — dead code, no
// #accessClearBtn/#accessClearLabel elements exist and nothing called them)

// ══════════════════════════════════════════════════════════════════════════
// OBSTRUCTION ZONE SELECTOR
// ══════════════════════════════════════════════════════════════════════════

const OBS_ZONES = {
  interior: {
    label: 'The Interior',
    items: [
      'Furniture',
      'Flooring',
      'Fixtures',
      'Items/belongings stored against wall',
      'Items/belongings stored to cupboards',
      'Limited access to skirting boards',
      'Limited access to skirting boards due to stored items in garage',
      'Locked room and storage to garage',
    ],
  },
  exterior: {
    label: 'The Exterior',
    items: [
      'Vegetation',
      'Stored Articles',
      'Air Conditioner Ducting',
      'Storage to garage walls',
      'Water Tanks',
    ],
  },
  subfloor: {
    label: 'Subfloor',
    items: [
      'Low Clearance',
      'Stored Articles',
      'Ducting',
      'Plumbing',
      'No access to subfloor',
      'Insulation',
    ],
  },
  roofvoid: {
    label: 'Roof Void',
    items: [
      'Insulation',
      'Sarking',
      'Air conditioning ducting',
      'Stored articles',
      'Low clearance to the outside edges of roof void',
      'Low clearance in roof void',
      'Item blocking access to manhole',
      'Height Restrictions',
      'Skillion Roof Design (no void)',
    ],
  },
  outbuildings: {
    label: 'Outbuildings',
    items: [
      'Stored Articles',
    ],
  },
  site: {
    label: 'The Site',
    items: [
      'Vegetation',
      'Stored Articles',
    ],
  },
  fences: {
    label: 'Fences',
    items: [
      'Vegetation',
      'Stored Articles',
    ],
  },
  retainingwalls: {
    label: 'Retaining Walls',
    items: [
      'Back Fill',
      'Abutting Timbers',
      'Vegetation',
      'Stored Articles',
    ],
  },
  landscapingtimbers: {
    label: 'Landscaping Timbers',
    items: [
      'Back Fill',
      'Abutting Timbers',
      'Vegetation',
      'Stored Articles',
    ],
  },
};
let obsSelectedZones  = {};
let obsNoObstructions = false;

function toggleNoObstructions() {
  obsNoObstructions = !obsNoObstructions;
  const btn   = document.getElementById('obsNoneBtn');
  const label = document.getElementById('obsNoneLabel');
  const wrap  = document.getElementById('obsZoneWrap');
  const items = document.getElementById('obsItemsWrap');
  if (obsNoObstructions) {
    obsSelectedZones = {};
    label.textContent = 'No obstructions — all areas accessible ✓';
    btn.style.background = 'rgba(var(--accent-rgb),0.12)';
    btn.style.borderColor = 'rgba(var(--accent-rgb),0.4)';
    btn.style.color = 'var(--accent2)';
    wrap.style.opacity = '0.3'; wrap.style.pointerEvents = 'none';
    if (items) items.innerHTML = '';
    reportData.obstructions    = 'NIL — No obstructions were noted at the time of inspection.';
    reportData.restrictedAccess = '';
  } else {
    label.textContent = 'No obstructions — all areas accessible';
    btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = '';
    wrap.style.opacity = ''; wrap.style.pointerEvents = '';
    reportData.obstructions = ''; reportData.restrictedAccess = '';
  }
  document.querySelectorAll('[id^="obsZone-"]').forEach(b => b.classList.remove('active'));
  updateProgress(); flushDraftSave();
}

function toggleObsZone(zoneId) {
  if (obsNoObstructions) return;
  const btn = document.getElementById('obsZone-' + zoneId);
  if (obsSelectedZones[zoneId]) { delete obsSelectedZones[zoneId]; btn.classList.remove('active'); }
  else { obsSelectedZones[zoneId] = []; btn.classList.add('active'); }
  renderObsItemPanels();
  syncObstructionData();
}

function toggleObsItem(zoneId, item) {
  if (!obsSelectedZones[zoneId]) obsSelectedZones[zoneId] = [];
  const idx = obsSelectedZones[zoneId].indexOf(item);
  if (idx >= 0) obsSelectedZones[zoneId].splice(idx, 1);
  else obsSelectedZones[zoneId].push(item);
  renderObsItemPanels();
  syncObstructionData();
}

function renderObsItemPanels() {
  const wrap = document.getElementById('obsItemsWrap');
  if (!wrap) return;
  const activeZones = Object.keys(obsSelectedZones);
  if (activeZones.length === 0) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = '<div class="obs-panels-wrap">' +
    activeZones.map(zoneId => {
      const zone = OBS_ZONES[zoneId]; if (!zone) return '';
      const selected = obsSelectedZones[zoneId] || [];
      const itemBtns = zone.items.map(item => {
        const safe = item.replace(/'/g, '&#39;');
        return `<button class="obs-item-btn${selected.includes(item) ? ' selected' : ''}"
          onclick="toggleObsItem('${zoneId}','${safe}')">${item}</button>`;
      }).join('');
      return `<div class="obs-zone-panel"><div class="obs-zone-panel-header">${zone.label}</div><div class="obs-items">${itemBtns}</div></div>`;
    }).join('') + '</div>';
}

function syncObstructionData() {
  const activeZones = Object.keys(obsSelectedZones);
  if (activeZones.length === 0) {
    reportData.obstructions = ''; reportData.restrictedAccess = '';
    updateProgress(); flushDraftSave(); return;
  }
  const zones = activeZones.map(id => OBS_ZONES[id]?.label).filter(Boolean).join(', ');
  const details = activeZones.map(zoneId => {
    const zone = OBS_ZONES[zoneId]; const items = obsSelectedZones[zoneId];
    if (!zone) return '';
    return items && items.length > 0 ? `${zone.label}: ${items.join(', ')}` : zone.label;
  }).filter(Boolean).join('. ');
  reportData.obstructions     = zones;
  reportData.restrictedAccess = details;
  updateProgress(); flushDraftSave();
}

function restoreObsState() {
  if (!reportData.obstructions) return;
  if (reportData.obstructions.startsWith('NIL')) {
    obsNoObstructions = true;
    const btn = document.getElementById('obsNoneBtn');
    const label = document.getElementById('obsNoneLabel');
    const wrap = document.getElementById('obsZoneWrap');
    if (btn) { btn.style.background='rgba(var(--accent-rgb),0.12)'; btn.style.borderColor='rgba(var(--accent-rgb),0.4)'; btn.style.color='var(--accent2)'; }
    if (label) label.textContent = 'No obstructions — all areas accessible ✓';
    if (wrap) { wrap.style.opacity='0.3'; wrap.style.pointerEvents='none'; }
    return;
  }
  const storedZones  = (reportData.obstructions || '').split(', ');
  const storedNature = (reportData.restrictedAccess || '').split('. ');
  Object.entries(OBS_ZONES).forEach(([zoneId, zone]) => {
    if (!storedZones.includes(zone.label)) return;
    obsSelectedZones[zoneId] = [];
    const btn = document.getElementById('obsZone-' + zoneId);
    if (btn) btn.classList.add('active');
    const detail = storedNature.find(n => n.startsWith(zone.label + ':'));
    if (detail) {
      const items = detail.replace(zone.label + ': ', '').split(', ');
      obsSelectedZones[zoneId] = items.filter(i => zone.items.includes(i));
    }
  });
  renderObsItemPanels();
}

// Called from populateFields() after a voice/AI extraction. The AI returns
// obstructions/restrictedAccess as free text (it has no knowledge of our
// fixed zone-chip taxonomy), so this does a best-effort match of that text
// against OBS_ZONES' zone labels and item names and auto-selects whatever
// it can confidently match — same "AI drafts, technician can always edit"
// model used elsewhere (compliance plate scan, photo ID): it pre-fills the
// chips, but every chip stays a normal toggle the technician can correct.
// Matching is deliberately scoped to just the AI's own obstructions/
// restrictedAccess text (not the whole transcript), which keeps false
// positives from generic words like "stored" very unlikely.
function applyObstructionExtraction(data) {
  const obsText = (data.obstructions || '').trim();
  const detailText = (data.restrictedAccess || '').trim();
  const combinedText = [obsText, detailText].filter(Boolean).join('. ');
  if (!combinedText) return;

  // The prompt is instructed to leave these null when nothing was
  // mentioned, so an explicit "nil/none" from the AI is rare — but don't
  // try to zone-match it if it happens.
  if (/^\s*(nil|none|no obstructions|n\/a)\b/i.test(combinedText)) return;

  if (obsNoObstructions) {
    // Technician went on to describe a real obstruction after previously
    // toggling "No obstructions" — trust the newer, more specific info.
    obsNoObstructions = false;
    const btn = document.getElementById('obsNoneBtn');
    const label = document.getElementById('obsNoneLabel');
    const wrap = document.getElementById('obsZoneWrap');
    if (btn) { btn.style.background=''; btn.style.borderColor=''; btn.style.color=''; }
    if (label) label.textContent = 'No obstructions — all areas accessible';
    if (wrap) { wrap.style.opacity=''; wrap.style.pointerEvents=''; }
  }

  const lower = combinedText.toLowerCase();
  let matchedAny = false;

  Object.entries(OBS_ZONES).forEach(([zoneId, zone]) => {
    let zoneHit = false;
    zone.items.forEach(item => {
      const words = item.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4);
      if (words.length && words.some(w => lower.includes(w))) {
        if (!obsSelectedZones[zoneId]) obsSelectedZones[zoneId] = [];
        if (!obsSelectedZones[zoneId].includes(item)) obsSelectedZones[zoneId].push(item);
        zoneHit = true;
      }
    });
    const zoneWords = zone.label.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4 && w !== 'the');
    if (!zoneHit && zoneWords.some(w => lower.includes(w))) {
      if (!obsSelectedZones[zoneId]) obsSelectedZones[zoneId] = [];
      zoneHit = true;
    }
    if (zoneHit) {
      matchedAny = true;
      const btn = document.getElementById('obsZone-' + zoneId);
      if (btn) btn.classList.add('active');
    }
  });

  if (matchedAny) {
    renderObsItemPanels();
    syncObstructionData();
    showToast('Obstruction zones auto-selected from voice — check they match what you described', 'info');
  } else {
    // Nothing in our fixed zone list matched what was said. There's no
    // freeform field to stash this in without inventing new UI, so surface
    // it rather than silently losing it — the technician selects manually.
    showToast(`Obstruction mentioned but not auto-matched: "${combinedText.slice(0, 120)}" — select the zone manually`, 'info');
  }
}

function setRestrictedAccess(hasRestrictions) {
  const yesBtn  = document.getElementById('resYesBtn');
  const noBtn   = document.getElementById('resNoBtn');
  const detail  = document.getElementById('resDetailWrap');

  if (hasRestrictions) {
    yesBtn.classList.add('active'); noBtn.classList.remove('active');
    if (detail) detail.style.display = '';
    if (!reportData.hinderedAreas) reportData.hinderedAreas = '';
  } else {
    noBtn.classList.add('active'); yesBtn.classList.remove('active');
    if (detail) detail.style.display = 'none';
    reportData.hinderedAreas      = 'NIL — No restricted access areas at time of inspection.';
    reportData.hinderedAreasDetail = '';
    const elA = document.getElementById('f-hinderedAreas');
    const elB = document.getElementById('f-hinderedAreasDetail');
    if (elA) { elA.textContent = '—'; elA.classList.remove('filled'); }
    if (elB) { elB.textContent = '—'; elB.classList.remove('filled'); }
  }
  updateProgress(); flushDraftSave();
}

function restoreResState() {
  if (!reportData.hinderedAreas) return;
  const isNo = reportData.hinderedAreas.startsWith('NIL');
  setRestrictedAccess(!isNo);
}

async function sendInvite() {
  if (!authBusiness) { showToast('Business account required to invite team members', 'error'); return; }
  const email = document.getElementById('inviteEmail').value.trim().toLowerCase();
  const btn   = document.getElementById('inviteBtn');
  if (!email || !email.includes('@')) { showToast('Enter a valid email address', 'error'); return; }

  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/invites`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Prefer': 'return=representation' },
      body: JSON.stringify({
        business_id: authBusiness.id,
        email,
        role: 'technician',
        invited_by: authUser.id,
      }),
    });

    if (!res.ok) { const err = await res.json(); showToast(err.message || 'Invite failed', 'error'); return; }
    await res.json();

    showToast(`Invite recorded for ${email} — ask them to sign up at the KORVUS app and they'll join your team automatically`, 'success');
    document.getElementById('inviteEmail').value = '';
    loadTeam();
  } catch(e) {
    showToast('Network error — please try again', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9l20-7z"/></svg> Send Invite`;
  }
}

async function loadTeam() {
  if (!authBusiness) return;
  const list = document.getElementById('teamList');
  if (!list) return;
  try {
    const membersRes = await fetch(
      `${SUPABASE_URL}/rest/v1/team_members?business_id=eq.${authBusiness.id}&order=joined_at.asc`,
      { headers: getAuthHeaders() }
    );
    const members = membersRes.ok ? await membersRes.json() : [];

    const invitesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/invites?business_id=eq.${authBusiness.id}&status=eq.pending&order=created_at.desc`,
      { headers: getAuthHeaders() }
    );
    const invites = invitesRes.ok ? await invitesRes.json() : [];

    teamMembersCache = members;
    const isOwner = !!(authBusiness && authUser && authBusiness.owner_id === authUser.id);
    renderTeam(members, invites, isOwner);
    const total = members.length + invites.length;
    const summary = document.getElementById('teamPanelSummary');
    if (summary) summary.textContent = total > 0 ? String(total) : '';

    const assignForm = document.getElementById('assignJobForm');
    if (assignForm) assignForm.style.display = isOwner ? 'flex' : 'none';
    if (isOwner) populateJobAssigneeSelect(members);
    loadTeamJobs();
  } catch(e) {
    if (list) list.innerHTML = '<div class="team-loading">Unable to load team</div>';
  }
}

function populateJobAssigneeSelect(members) {
  const select = document.getElementById('jobAssignee');
  if (!select) return;
  select.innerHTML = members.map(m =>
    `<option value="${m.user_id}">${escapeHtml(m.name || m.email)}${m.user_id === authUser?.id ? ' (you)' : ''}</option>`
  ).join('');
}

// ── Team job scheduling ─────────────────────────────────────────────────
// A lightweight appointment (address/date/time/notes) an owner assigns to a
// technician, stored in the `jobs` table. Separate from `reports`, which is
// the full inspection paperwork the tech fills in once they actually do the
// job. Visible to the whole team; only the owner can create or remove one.
async function loadTeamJobs() {
  if (!authBusiness) return;
  const list = document.getElementById('jobsList');
  if (!list) return;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/jobs?business_id=eq.${authBusiness.id}&order=job_date.asc,job_time.asc`,
      { headers: getAuthHeaders() }
    );
    const jobs = res.ok ? await res.json() : [];
    renderJobsList(jobs);
  } catch(e) {
    if (list) list.innerHTML = '<div class="team-loading">Unable to load schedule</div>';
  }
}

function renderJobsList(jobs) {
  const list = document.getElementById('jobsList');
  if (!list) return;
  if (jobs.length === 0) {
    list.innerHTML = '<div class="team-loading">No jobs scheduled yet.</div>';
    return;
  }
  const isOwner = !!(authBusiness && authUser && authBusiness.owner_id === authUser.id);
  const nameFor = (userId) => {
    const m = teamMembersCache.find(x => x.user_id === userId);
    return m ? (m.name || m.email) : 'Unassigned';
  };
  const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '';
  const fmtTime = (t) => {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
  };
  list.innerHTML = jobs.map(j => `
    <div class="team-job-item">
      <div class="team-job-info">
        <div class="team-job-addr">${escapeHtml(j.address || 'No address')}</div>
        <div class="team-job-meta">${fmtDate(j.job_date)}${j.job_time ? ' · ' + fmtTime(j.job_time) : ''} · ${escapeHtml(nameFor(j.assigned_to))}</div>
        ${j.notes ? `<div class="team-job-notes">${escapeHtml(j.notes)}</div>` : ''}
      </div>
      ${isOwner ? `<button class="team-job-delete" onclick="deleteJob('${j.id}')" aria-label="Remove job" title="Remove job">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>
      </button>` : ''}
    </div>
  `).join('');
}

async function assignJob() {
  if (!authBusiness || !authUser) return;
  const assignedTo = document.getElementById('jobAssignee').value;
  const address    = document.getElementById('jobAddressInput').value.trim();
  const date       = document.getElementById('jobDateInput').value;
  const time       = document.getElementById('jobTimeInput').value;
  const notes      = document.getElementById('jobNotesInput').value.trim();
  if (!address) { showToast('Enter a property address', 'error'); return; }
  if (!assignedTo) { showToast('Choose who to assign this job to', 'error'); return; }

  const btn = document.getElementById('assignJobBtn');
  btn.disabled = true;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/jobs`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Prefer': 'return=representation' },
      body: JSON.stringify({
        business_id: authBusiness.id,
        assigned_to: assignedTo,
        created_by:  authUser.id,
        address, notes,
        job_date: date || null,
        job_time: time || null,
      }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); showToast(err.message || 'Could not assign job', 'error'); return; }

    document.getElementById('jobAddressInput').value = '';
    document.getElementById('jobDateInput').value = '';
    document.getElementById('jobTimeInput').value = '';
    document.getElementById('jobNotesInput').value = '';
    showToast('Job assigned', 'success');
    loadTeamJobs();
  } catch(e) {
    showToast('Network error — please try again', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteJob(id) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/jobs?id=eq.${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    if (!res.ok) { showToast('Could not remove job', 'error'); return; }
    loadTeamJobs();
  } catch(e) {
    showToast('Network error — please try again', 'error');
  }
}

function renderTeam(members, invites, isOwner) {
  const list = document.getElementById('teamList');
  if (!list) return;
  if (members.length === 0 && invites.length === 0) {
    list.innerHTML = '<div class="team-loading">No team members yet — invite your first technician above.</div>';
    return;
  }
  const removeIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>`;
  list.innerHTML = [
    ...members.map(m => {
      const initial = escapeHtml((m.name || m.email || '?')[0].toUpperCase());
      const isYou = m.user_id === authUser?.id;
      const canRemove = isOwner && !isYou && m.role !== 'owner';
      const safeName = escapeHtml(m.name || m.email || '').replace(/'/g, "\\'");
      return `<div class="team-member">
        <div class="team-member-avatar">${initial}</div>
        <div class="team-member-info">
          <div class="team-member-name">${escapeHtml(m.name || m.email || '')}${isYou ? ' (you)' : ''}</div>
          <div class="team-member-email">${escapeHtml(m.email || '')}</div>
        </div>
        <span class="team-member-role ${m.role}">${escapeHtml(m.role || '')}</span>
        ${canRemove ? `<button class="team-job-delete" onclick="removeMember('${m.user_id}', '${safeName}')" aria-label="Remove team member" title="Remove from team">${removeIcon}</button>` : ''}
      </div>`;
    }),
    ...invites.map(i => {
      const safeEmail = escapeHtml(i.email || '').replace(/'/g, "\\'");
      return `<div class="team-member">
      <div class="team-member-avatar" style="background:rgba(255,182,72,0.1);color:var(--yellow)">?</div>
      <div class="team-member-info">
        <div class="team-member-name">${escapeHtml(i.email || '')}</div>
        <div class="team-member-email">Invite pending — awaiting sign-up</div>
      </div>
      <span class="team-member-role pending">Pending</span>
      ${isOwner ? `<button class="team-job-delete" onclick="cancelInvite('${i.id}', '${safeEmail}')" aria-label="Cancel invite" title="Cancel invite">${removeIcon}</button>` : ''}
    </div>`;
    }),
  ].join('');
}

async function removeMember(userId, name) {
  if (!authBusiness || !authUser) return;
  if (userId === authUser.id) { showToast("You can't remove yourself from the team", 'error'); return; }
  if (!confirm(`Remove ${name || 'this technician'} from your team? They'll lose access to the business account immediately.`)) return;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/team_members?business_id=eq.${authBusiness.id}&user_id=eq.${userId}`,
      { method: 'DELETE', headers: getAuthHeaders() }
    );
    if (!res.ok) { showToast('Could not remove team member', 'error'); return; }
    showToast('Team member removed', 'success');
    loadTeam();
  } catch(e) {
    showToast('Network error — please try again', 'error');
  }
}

async function cancelInvite(inviteId, email) {
  if (!confirm(`Cancel the pending invite for ${email}?`)) return;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/invites?id=eq.${inviteId}`,
      { method: 'DELETE', headers: getAuthHeaders() }
    );
    if (!res.ok) { showToast('Could not cancel invite', 'error'); return; }
    showToast('Invite cancelled', 'success');
    loadTeam();
  } catch(e) {
    showToast('Network error — please try again', 'error');
  }
}

async function checkAndAcceptInvite() {
  if (!authUser?.email) return;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/invites?email=eq.${encodeURIComponent(authUser.email)}&status=eq.pending&limit=1`,
      { headers: getAuthHeaders() }
    );
    if (!res.ok) return;
    const invites = await res.json();
    if (invites.length === 0) return;
    const invite = invites[0];

    // Add to team
    await fetch(`${SUPABASE_URL}/rest/v1/team_members`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        business_id: invite.business_id,
        user_id:     authUser.id,
        role:        invite.role || 'technician',
        name:        authUser.user_metadata?.name || authUser.email,
        email:       authUser.email,
      }),
    });

    // Mark accepted
    await fetch(`${SUPABASE_URL}/rest/v1/invites?id=eq.${invite.id}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ status: 'accepted' }),
    });

    // Load their business
    const bizRes = await fetch(
      `${SUPABASE_URL}/rest/v1/businesses?id=eq.${invite.business_id}&limit=1`,
      { headers: getAuthHeaders() }
    );
    if (bizRes.ok) {
      const rows = await bizRes.json();
      if (rows[0]) {
        authBusiness = rows[0];
        showToast(`Joined ${rows[0].name}`, 'success');
        // loadBusiness() (called right after this) no-ops once authBusiness is
        // already set, so this is the only chance this session gets to load
        // billing status for a technician who just accepted a team invite.
        loadBillingStatus();
      }
    }
  } catch(e) { console.warn('checkAndAcceptInvite:', e); }
}

// ══════════════════════════════════════════════════════════════════════════
// SPECIES INTELLIGENCE DATABASE
// Research-backed data for Australian termite species
// ══════════════════════════════════════════════════════════════════════════
const SPECIES_DB = {
  'Coptotermes acinaciformis': {
    commonName: 'Subterranean Termite',
    family: 'Rhinotermitidae',
    riskLevel: 'HIGH',
    riskLabel: 'EXTREME RISK',
    riskColor: 'risk',
    destructionRate: 'Responsible for more economic damage than all other Australian termite species combined. Colonies up to 1 million individuals.',
    distribution: 'Most widely distributed termite in Australia — found continent-wide except Tasmania and parts of coastal Victoria.',
    fieldID: [
      '🔑 MILKY FLUID TEST: Press a soldier with multigrips or a probe — a white milky fluid secretes from the fontanelle (a pore on the top of the head). This is the definitive on-site field test for Coptotermes. No other common Australian species does this.',
      '👀 DAMAGE PATTERN: Smooth, clean galleries running with the grain of the timber. Timber hollowed out leaving a thin outer shell — sounds hollow when sounded with a screwdriver handle. No grit or soil packed into the galleries.',
      '🪵 SURFACE SIGNS: Mud tubes on stumps, piers, and walls — often brown-grey, firm, and pencil-thin. Paint or plaster may blister or bubble where termites have hollowed the substrate behind it.',
      '⚠️ SECONDARY COLONY NOTE: Can establish above-ground satellite nests with zero soil contact where there is an alternative moisture source — roof leaks, wall-cavity plumbing leaks. If active Coptotermes are found in a roof void or high wall cavity with no obvious ground path, check for a nearby moisture source.',
    ],
    identification: [
      'Workers: cream-white, eyeless, 4–5mm',
      'Soldiers: pale body, teardrop-shaped head with large mandibles, 5–7mm',
      'KEY ID: When soldiers are pressed, a white milky fluid secretes from a pore (fontanelle) on the head — unique to Coptotermes',
      'Reproductives (alates): dark brown, 12mm with four large wings'
    ],
    nestTypes: [
      'Underground subterranean nests',
      'Root crown/base of living trees (eucalypts, peppercorns, English oaks)',
      'Subsidiary nests in wall cavities — especially near moisture sources',
      'Under concrete slabs and floor structures',
      'Can nest under patios and below ground-level masonry'
    ],
    behaviour: [
      'Forages day and night through extensive underground tunnel networks',
      'Workers travel up to 100m from the colony',
      'Prefers both softwoods (radiata pine) and hardwoods (ash, Tasmanian oak)',
      'Mud tubes visible on stumps, walls, piers — often the first sign of attack',
      'Hollows out timber leaving a thin exterior shell — sounds hollow when sounded',
      'Individual termites returned to colony after separation are accepted; termites from other colonies rejected'
    ],
    conduciveConditions: [
      'Leaking pipes, poor drainage, damp wood',
      'Decayed tree stumps in yard',
      'Timber-soil contact',
      'High moisture environments'
    ],
    treatmentRecommended: 'YES',
    treatmentOptions: [
      { product: 'Termidor (Fipronil)', type: 'Chemical Barrier', notes: 'Industry standard. Non-repellent, transfer effect, excellent soil binding. 8+ year protection. Preferred where moisture movement in soil.', toxicity: 'Moderate' },
      { product: 'Altriset (Chlorantraniliprole)', type: 'Chemical Barrier', notes: 'Lowest toxicity — exempt from poison scheduling in Australia. Paralyses muscles, stops feeding within hours. Up to 8 years. Higher cost.', toxicity: 'Very Low' },
      { product: 'Premise (Imidacloprid)', type: 'Chemical Barrier', notes: 'Non-repellent, water-soluble. Better soil penetration. Less durable in wet soils. Risk to bees/plants.', toxicity: 'Low–Moderate' },
      { product: 'Sentricon Baiting System', type: 'Bait Station', notes: 'Insect growth regulator. Slow-acting colony elimination. Useful where chemical barrier is not practical.', toxicity: 'Very Low' }
    ],
    inspectionFrequency: '6 months',
    specialFlags: [],
    fieldNotePrompts: [
      'Perform milky fluid test on soldiers — document result (positive = Coptotermes confirmed)',
      'Sound all accessible timbers in affected area — note extent of hollowing',
      'Check for subsidiary nests in wall cavities — common near moisture sources',
      'If found in roof void or high wall cavity, look for moisture source (leak, plumbing) nearby',
      'Inspect root crowns of trees within 50m of structure',
      'Document mud tube locations with photos if possible',
      'Recommend licensed builder assessment for structural integrity of damaged timbers'
    ]
  },

  'Coptotermes frenchi': {
    commonName: 'Subterranean Termite',
    family: 'Rhinotermitidae',
    riskLevel: 'HIGH',
    riskLabel: 'HIGH RISK',
    riskColor: 'risk',
    destructionRate: 'Significant economic pest in southern Australian states. Less aggressive than C. acinaciformis but still capable of severe structural damage.',
    distribution: 'Southern Australian states — common in Victoria, parts of NSW and SA. Less common than C. acinaciformis.',
    fieldID: [
      '🔑 MILKY FLUID TEST: Same as C. acinaciformis — press a soldier and check for white milky fluid from the fontanelle. Confirms genus (Coptotermes). Species differentiation between frenchi and acinaciformis requires specialist examination.',
      '👀 DAMAGE PATTERN: Similar to C. acinaciformis — smooth clean galleries with the grain, hollow-sounding timber. Geography and host tree preference assist in species confirmation.',
      '🌳 HOST PREFERENCE: More commonly associated with specific host trees — Eucalyptus melliodora (yellow box), E. polyanthemos (red box). If these are present on or near the property, note them.',
    ],
    identification: [
      'Very similar to C. acinaciformis — specialist identification required',
      'Soldiers: pale body, teardrop-shaped head, 5–7mm',
      'KEY ID: Milky fluid from fontanelle when pressed — same as C. acinaciformis',
      'Geography and host tree preference assist species confirmation'
    ],
    nestTypes: [
      'Root crowns and bases of living trees',
      'Underground subterranean nests',
      'Timber stumps'
    ],
    behaviour: [
      'Mainly a forest pest but can invade buildings',
      'Attacks both hardwood and softwood',
      'Not as aggressive as C. acinaciformis'
    ],
    conduciveConditions: ['Decayed timber', 'Moisture', 'Tree stumps near structure'],
    treatmentRecommended: 'YES',
    treatmentOptions: [
      { product: 'Termidor (Fipronil)', type: 'Chemical Barrier', notes: 'Non-repellent, transfer effect. Industry standard for Coptotermes species.', toxicity: 'Moderate' },
      { product: 'Altriset (Chlorantraniliprole)', type: 'Chemical Barrier', notes: 'Low toxicity alternative. Stops feeding within hours.', toxicity: 'Very Low' }
    ],
    inspectionFrequency: '6 months',
    specialFlags: [],
    fieldNotePrompts: [
      'Perform milky fluid test on soldiers — confirms Coptotermes genus',
      'Note nearby tree species — yellow box, red box are typical hosts for C. frenchi',
      'Confirm species where possible — C. frenchi and C. acinaciformis require specialist differentiation',
      'Check root crowns of nearby trees',
      'Sound all accessible timber in affected area'
    ]
  },

  'Schedorhinotermes': {
    commonName: 'Subterranean Termite',
    family: 'Rhinotermitidae',
    riskLevel: 'HIGH',
    riskLabel: 'HIGH RISK',
    riskColor: 'risk',
    destructionRate: 'Second most economically damaging termite genus in Australia. More damage to Australian homes than storms, floods and fires combined (alongside all subterranean species).',
    distribution: 'Widespread across eastern Australia. Most common damaging species in some regions including coastal NSW and QLD.',
    fieldID: [
      '🔑 TWO SOLDIER CASTES — KEY FIELD TEST: Look carefully at the soldiers. Schedorhinotermes is the ONLY common Australian genus with two distinct soldier sizes in the same colony. Major soldiers (5–7.5mm, large bulbous head) and minor soldiers (3–5.5mm, narrower head). If you see both sizes, this confirms the genus.',
      '👀 DAMAGE PATTERN: Patchy, irregular damage with large gouges — particularly around nails, screws and fixings where the timber is softer. Unlike Coptotermes (smooth galleries with the grain), Schedorhinotermes damage often looks more chaotic and chewed.',
      '🏗️ WORKINGS: Characteristic fragile plaster-like earthen deposits covering galleries — brownish-grey, finer texture than Coptotermes mud tubes. Easily crumbled between fingers. Often called "plastering".',
      '⚠️ DO NOT DISTURB: Schedorhinotermes is highly skittish. If you disturb active workings during the inspection, the colony may relocate before treatment can be applied. Minimise exposure of active galleries.',
    ],
    identification: [
      'TWO soldier castes — key distinguishing feature:',
      'Major soldiers: 5–7.5mm, bulbous head, large mandibles',
      'Minor soldiers: 3–5.5mm, narrower head, slender mandibles — appear first in developing colony',
      'Presence of major soldiers = mature, well-established colony with high damage potential',
      'Characteristic "plastering" earthen workings — fragile plaster-like deposits covering their galleries',
      'White cigar-shaped body, pale to dark brown head on both castes'
    ],
    nestTypes: [
      'Tree stumps and root crowns of living trees',
      'Under patios, fireplaces and buried timber',
      'Under houses — multiple small nest sites rather than one central nest',
      'Queen lays eggs one at a time (unlike other species) — slower colony development'
    ],
    behaviour: [
      'VERY SKITTISH — will relocate entire colony if disturbed during treatment',
      'Creates multiple satellite nests — difficult to fully locate',
      'Attack is concealed under characteristic fragile plastering',
      'Queens and kings can live over 20 years',
      'Workers and soldiers live 1–2 years'
    ],
    conduciveConditions: ['Tree stumps', 'Buried timber', 'Subfloor moisture', 'Timber-soil contact'],
    treatmentRecommended: 'YES',
    treatmentOptions: [
      { product: 'Termidor (Fipronil)', type: 'Chemical Barrier', notes: 'Non-repellent essential — repellent chemicals will cause colony relocation. Full perimeter treatment required.', toxicity: 'Moderate' },
      { product: 'Altriset (Chlorantraniliprole)', type: 'Chemical Barrier', notes: 'Non-repellent, low toxicity. Stops feeding within hours. Preferred where minimal disturbance required.', toxicity: 'Very Low' }
    ],
    inspectionFrequency: '6 months',
    specialFlags: [
      { type: 'warning', icon: '⚠', text: 'DO NOT DISTURB — Schedorhinotermes is highly skittish. Any disturbance to active workings during inspection or treatment may cause the colony to relocate to an untreated area of the property. Avoid drilling, hammering, or directly exposing active galleries where possible until treatment strategy is confirmed.' }
    ],
    fieldNotePrompts: [
      'Note whether BOTH major AND minor soldiers are present — two castes confirm genus, major soldiers indicate mature colony',
      'Describe plastering deposit locations and texture — photograph all visible deposits',
      'Note damage pattern — look for gouging around nails/fixings, which is characteristic of this genus',
      'Check for multiple nest sites — stumps, under patio, subfloor, fireplaces',
      'Advise client: DO NOT disturb active workings until treatment is underway',
      'Only use non-repellent treatments — repellent chemicals will cause colony relocation'
    ]
  },

  'Schedorhinotermes intermedius': {
    commonName: 'Subterranean Termite',
    family: 'Rhinotermitidae',
    riskLevel: 'HIGH',
    riskLabel: 'HIGH RISK',
    riskColor: 'risk',
    destructionRate: 'Major pest species along eastern coast. Second only to Coptotermes in economic damage.',
    distribution: 'Eastern coastline of Australia. Common throughout NSW, QLD, VIC.',
    fieldID: [
      '🔑 TWO SOLDIER CASTES: Major soldiers (larger, bulbous head) and minor soldiers (smaller, narrower head) present together — confirms Schedorhinotermes genus. Minor soldiers appear first in young colonies; presence of majors = well-established colony.',
      '👀 DAMAGE PATTERN: Patchy gouging damage particularly around nails and fixings. Fragile plaster-like earthen workings (plastering) covering galleries — crumbles easily when disturbed.',
      '⚠️ SKITTISH — DO NOT DISTURB active workings. Colony will relocate if galleries are exposed.',
    ],
    identification: [
      'Major soldiers: bulbous head, 5–7.5mm',
      'Minor soldiers: narrower head, ~4mm — appear first in young colonies',
      'Characteristic fragile plaster-like earthen workings',
      'Very similar to other Schedorhinotermes species'
    ],
    nestTypes: ['Tree stumps', 'Root crowns', 'Under properties and patios', 'Under fireplaces'],
    behaviour: [
      'VERY SKITTISH — colony will relocate if disturbed',
      'Multiple nest sites make full elimination difficult',
      'Major soldiers indicate established, high-risk colony'
    ],
    conduciveConditions: ['Tree stumps', 'Subfloor moisture', 'Timber-soil contact'],
    treatmentRecommended: 'YES',
    treatmentOptions: [
      { product: 'Termidor (Fipronil)', type: 'Chemical Barrier', notes: 'Non-repellent — critical for skittish species. Full perimeter.', toxicity: 'Moderate' },
      { product: 'Altriset (Chlorantraniliprole)', type: 'Chemical Barrier', notes: 'Non-repellent, lowest toxicity. Ideal for sensitive situations.', toxicity: 'Very Low' }
    ],
    inspectionFrequency: '6 months',
    specialFlags: [
      { type: 'warning', icon: '⚠', text: 'DO NOT DISTURB — Schedorhinotermes intermedius will relocate if colony is disturbed. Use non-repellent treatments only. Avoid directly exposing galleries before treatment.' }
    ],
    fieldNotePrompts: [
      'Note presence of major vs minor soldiers — major soldiers = mature colony',
      'Document all plastering deposit locations — photograph each one',
      'Note damage pattern — gouging around nails/fixings is characteristic',
      'Advise client not to disturb affected areas prior to treatment',
      'Confirm non-repellent treatment only — repellent chemicals cause relocation'
    ]
  },

  'Nasutitermes walkeri': {
    commonName: 'Tree Termite',
    family: 'Termitidae',
    riskLevel: 'MEDIUM',
    riskLabel: 'MODERATE RISK',
    riskColor: 'yellow',
    destructionRate: 'Capable of structural damage, particularly to hardwood. Less aggressive than Coptotermes but can damage buildings if left unchecked.',
    distribution: 'Eastern NSW and southeastern QLD. Found in mountains and coastal scrubland/wooded areas.',
    fieldID: [
      '🔑 POINTED SNOUT (NASUS): Nasutitermes soldiers have a distinctive pointed tube-like snout (nasus) on the front of the head instead of mandibles. They spray a sticky, amber-coloured defensive chemical from this snout when threatened — look for this if disturbed.',
      '👀 DARK MUD COVERING: Nasutitermes cover their workings and attacked timber with spacious, dark brown to black earthen material — distinctive dark mud galleries, often more open and roomy than Coptotermes workings. This dark colouring is a visual field ID marker.',
      '🌳 ARBOREAL NEST: Look for a brown papery-looking nest attached to a tree branch or trunk within 100m of the structure. Nasutitermes walkeri builds visible above-ground arboreal nests, typically in ironbark, stringybark, or tallowwood.',
    ],
    identification: [
      'Soldiers: rounded heads, long straight mandibles, yellowish-brown bodies, 5–7mm',
      'KEY ID: Pointed snout (nasus) on soldiers — sprays sticky defensive chemical instead of biting',
      'Arboreal nest visible on ironbark, stringybark, tallowwood trees',
      'Galleries extend down the trunk to maintain soil contact'
    ],
    nestTypes: [
      'Arboreal (tree) nests — attached to branches, commonly ironbark, stringybark, tallowwood',
      'Nest maintains soil contact via galleries running down tree trunk',
      'Kingfishers and lizards sometimes inhabit old nests'
    ],
    behaviour: [
      'Feeds on dead, decayed and weathered timber',
      'Can attack sound timber in buildings if given enough time undisturbed',
      'Nests are visible — easier to locate than subterranean species',
      'Covers attacked timber with characteristic dark brown to black earthen mud'
    ],
    conduciveConditions: ['Decayed timber', 'Weathered hardwood', 'Tree contact with structure'],
    treatmentRecommended: 'YES',
    treatmentOptions: [
      { product: 'Direct Nest Injection', type: 'Nest Treatment', notes: 'Locate arboreal nest in nearby trees. Inject nest and soil galleries with registered termiticide.', toxicity: 'Moderate' },
      { product: 'Termidor (Fipronil)', type: 'Chemical Barrier', notes: 'If nest cannot be located or eliminated, chemical barrier treatment around structure.', toxicity: 'Moderate' }
    ],
    inspectionFrequency: '12 months',
    specialFlags: [],
    fieldNotePrompts: [
      'Look for arboreal nest in nearby trees — check ironbark, stringybark, tallowwood within 100m',
      'Note whether nest has soil contact via trunk galleries',
      'Document the dark mud covering on attacked timber — photograph it',
      'Note if attack is on decayed vs sound timber — indicates severity of risk to structure',
      'Check whether galleries run from tree trunk down to ground and into structure'
    ]
  },

  'Nasutitermes exitiosus': {
    commonName: 'Snouted Termite',
    family: 'Termitidae',
    riskLevel: 'MEDIUM',
    riskLabel: 'MODERATE RISK',
    riskColor: 'yellow',
    destructionRate: 'Can cause extensive damage to hardwood structures, bridges, poles and fences. Most significant Nasutitermes pest species.',
    distribution: 'Southern QLD to NSW and Victoria, ACT region. Common in Canberra. Builds low mounds in open ground near eucalypts.',
    fieldID: [
      '🔑 POINTED SNOUT (NASUS): Like all Nasutitermes — soldiers have a pointed tube-like snout that sprays defensive chemical. No mandibles. Amber sticky fluid sprayed when threatened.',
      '👀 DARK MUD COVERING: Attacked timber is covered in spacious, very dark (brown to black) earthen galleries — distinctive visual field marker for this genus.',
      '⛰️ MOUND NEST: N. exitiosus builds distinctive low dome-shaped mounds above ground — 30–75cm high, 30–120cm wide base. Check open ground near eucalypts within 60m of the structure. The mound is often the easiest way to confirm this species.',
    ],
    identification: [
      'Soldiers: dark, almost black head, pointed nasute snout, 4–6mm',
      'Workers: cream-coloured, soft-bodied, eyeless',
      'Alates: 8–10mm, darker brown, compound eyes, four pale wings — emerge after rain',
      'Mound nests: dome-shaped, 30–75cm high, 30–120cm wide basal diameter',
      'Queen size 25–30mm — visible when mound is opened at ground level'
    ],
    nestTypes: [
      'Dome-shaped mounds above ground (30–75cm high)',
      'In drier areas: underground or in tree stumps/stumps leaving bare earth',
      'Wall cavities and under floors in some cases',
      'Nests under properties often undetected until floor collapses'
    ],
    behaviour: [
      'Feeds primarily on hardwoods — prefers sapwood',
      'Workers travel up to 50–60m from the nest',
      'Pine timbers are resistant to attack by this species',
      'Mound nests in urban areas less common — easier to spot and treat',
      'Covers attacked timber with characteristic dark to black earthen material'
    ],
    conduciveConditions: ['Hardwood timber in ground contact', 'Decayed wood', 'Proximity to eucalypts'],
    treatmentRecommended: 'YES',
    treatmentOptions: [
      { product: 'Direct Mound Injection', type: 'Nest Treatment', notes: 'Locate and inject the mound directly with registered termiticide. Inject surrounding soil. Usually straightforward since nest is visible.', toxicity: 'Moderate' },
      { product: 'Termidor (Fipronil)', type: 'Chemical Barrier', notes: 'Full perimeter treatment if mound cannot be directly treated.', toxicity: 'Moderate' }
    ],
    inspectionFrequency: '12 months',
    specialFlags: [],
    fieldNotePrompts: [
      'Look for dome-shaped mound nest in open ground near eucalypts within 60m',
      'Note mound dimensions, condition, and whether it appears active',
      'Document dark mud covering on attacked timber — photograph it',
      'Check under floors if no mound found above ground — can nest below floor level',
      'Note timber type attacked — hardwood sapwood is preferred; pine timbers are resistant'
    ]
  },

  'Mastotermes darwiniensis': {
    commonName: 'Giant Northern Termite / Darwin Termite',
    family: 'Mastotermitidae',
    riskLevel: 'HIGH',
    riskLabel: 'EXTREME RISK — SPECIALIST REQUIRED',
    riskColor: 'risk',
    destructionRate: 'Most primitive living termite. Under favourable conditions colonies can reach millions and destroy an untreated structure in months. Eats almost anything organic.',
    distribution: 'Northern Australia only — confined north of Tropic of Capricorn (tropical NT, far north QLD, northern WA). NOT found in southern states.',
    identification: [
      'Largest Australian termite species: 11–13mm body length',
      'Rounded yellow to reddish-brown head, short black mandibles',
      'Soldiers: long rectangular heads',
      'Most primitive living termite — shows similarities to cockroaches',
      'Lays eggs in bunches (like cockroaches) rather than singly',
      'Wings similar in design to cockroach wings'
    ],
    nestTypes: [
      'Subterranean nests — inconspicuous, NOT mound-building',
      'May also nest in trees or on top of posts',
      'Small ground mounds in some situations'
    ],
    behaviour: [
      'Eats almost anything organic: timber, leather, plastic, bagged salt, flour, damaged ivory, vegetation',
      'Can ringbark living trees by boring up into the trunk',
      'Agricultural pest of major significance — vegetable farming abandoned in parts of northern Australia',
      'Given irrigation and favourable conditions, colonies can reach millions rapidly',
      'Can destroy a building or its contents faster than any other termite species'
    ],
    conduciveConditions: ['Irrigation', 'Stored timber', 'Any organic material', 'Warm tropical conditions'],
    treatmentRecommended: 'YES',
    treatmentOptions: [
      { product: 'Specialist Treatment Required', type: 'Specialist', notes: 'Standard bait systems are ineffective against M. darwiniensis. Consult specialist — chemical treatment with registered termiticide, often requiring extensive soil treatment. Colony can reach millions — urgent action required.', toxicity: 'Varies' }
    ],
    inspectionFrequency: '3 months',
    specialFlags: [
      { type: 'danger', icon: '🚨', text: 'SPECIALIST TREATMENT REQUIRED — Mastotermes darwiniensis is the most destructive termite species in Australia. Standard bait systems are NOT effective. Immediate specialist intervention required. Under favourable conditions, colonies can destroy a structure within months.' },
      { type: 'info', icon: 'ℹ', text: 'LOCATION CHECK — M. darwiniensis is confined to northern Australia (north of Tropic of Capricorn). If found in southern states, confirm identification — possible misidentification or transported specimen.' }
    ],
    fieldNotePrompts: [
      'Confirm property location is north of Tropic of Capricorn — species distribution limited',
      'Document all materials affected — M. darwiniensis attacks a wide range of organic materials, not just timber',
      'Assess colony size — colonies under favourable conditions can be enormous',
      'Urgent referral to specialist recommended — standard treatments not effective'
    ]
  },

  'Cryptotermes brevis': {
    commonName: 'West Indian Drywood Termite',
    family: 'Kalotermitidae',
    riskLevel: 'HIGH',
    riskLabel: 'NOTIFIABLE PEST',
    riskColor: 'risk',
    destructionRate: 'Considered the most destructive drywood termite in the world. Multiple colonies can exist in one building simultaneously.',
    distribution: "Invasive species — found in QLD (particularly around Maryborough/Brisbane). Listed under Australia's Biosecurity Act 2015. Regularly intercepted at Australian border.",
    identification: [
      'Soldiers: 4–6mm, cigar-shaped white body, head is sloping and rough (phragmotic)',
      'Mandibles: very short and broad — distinctive',
      'No fontanelle present on head',
      'KEY ID: Does NOT require soil contact — lives entirely within dry timber',
      'Frass (faecal pellets) found near infested timber — key sign of drywood termite'
    ],
    nestTypes: [
      'Lives entirely within dry timber — no soil contact required',
      'Can infest construction timber, furniture, picture frames, wooden vessels',
      'Multiple colonies can exist independently in same building',
      'Can survive and be transported in furniture and goods'
    ],
    behaviour: [
      'Does not need free water or soil contact — unique among major pest species',
      'Forms colonies, feeds and reproduces within a single piece of wood',
      'Cannot be detected by standard moisture meter methods',
      'Frass (pellets) ejected from small holes in timber surface',
      'Infested items can transport the species — a biosecurity risk'
    ],
    conduciveConditions: ['Imported timber', 'Second-hand furniture', 'Any dry timber'],
    treatmentRecommended: 'YES',
    treatmentOptions: [
      { product: 'Whole-Building Fumigation', type: 'Fumigation', notes: 'Wrapping entire building in plastic and fumigating with sulfuryl fluoride. Required when multiple colonies present throughout the structure. Expensive and disruptive but thorough.', toxicity: 'High (during application)' },
      { product: 'Localised Treatment', type: 'Spot Treatment', notes: 'Injection of insecticide into gallery entry holes in affected timber. Suitable for single or limited infestations. Requires thorough survey to confirm scope.', toxicity: 'Moderate' },
      { product: 'Heat Treatment', type: 'Physical', notes: 'Heating structure or items to specific temperature to kill termites. Energy-intensive, requires specialised equipment.', toxicity: 'None' }
    ],
    inspectionFrequency: '6 months',
    specialFlags: [
      { type: 'danger', icon: '🚨', text: 'NOTIFIABLE PEST — Cryptotermes brevis is a regulated pest under the Australian Biosecurity Act 2015 and is a National Priority Plant Pest (NPPP). This finding must be reported to the relevant state biosecurity authority. Do not remove any infested timber or furniture from the property until directed by the authority.' },
      { type: 'warning', icon: '⚠', text: 'BIOSECURITY RISK — Infested furniture, timber or materials must not be moved from the property. Transportation of infested goods is how this species spreads. Advise client immediately.' }
    ],
    fieldNotePrompts: [
      'Document all infested items — timber members, furniture, frames, picture frames',
      'Look for frass (small pellets) ejected from holes in timber surface — key diagnostic sign',
      'Survey entire building — multiple independent colonies likely',
      'NOTIFY appropriate state biosecurity authority — required by law',
      'Advise client: do not remove any items from property until authorities confirm'
    ]
  },

  'Porotermes adamsoni': {
    commonName: 'Common Dampwood Termite',
    family: 'Termopsidae',
    riskLevel: 'MEDIUM',
    riskLabel: 'MODERATE RISK',
    riskColor: 'yellow',
    destructionRate: 'Rarely attacks sound timber. When it does, challenging to manage as standard termiticides are not registered for its control.',
    distribution: 'Southern coastal Australia — southern QLD to SA including ACT and Tasmania.',
    identification: [
      'Large species: workers and soldiers 10–15mm — noticeably larger than subterranean termites',
      'Pale-brown to reddish head, soft body typical of dampwood species',
      'Requires moist, decaying timber — key habitat indicator'
    ],
    nestTypes: [
      'Moist, decaying timber — trees, logs, garden structures',
      'Occasionally structural timber with persistent moisture issues'
    ],
    behaviour: [
      'Requires high moisture — not a threat to dry, well-maintained timber',
      'Associated with decayed and damp timber in houses',
      'Less mobile than subterranean species'
    ],
    conduciveConditions: ['Persistent leaks', 'Decayed timber', 'Poor ventilation', 'High subfloor moisture'],
    treatmentRecommended: 'YES',
    treatmentOptions: [
      { product: 'Structural Remediation', type: 'Physical', notes: 'PRIMARY TREATMENT — remove or replace affected decayed timber, eliminate moisture source. Termiticides are NOT registered for P. adamsoni control.', toxicity: 'None' },
      { product: 'Moisture Source Elimination', type: 'Environmental', notes: 'Address all moisture sources — plumbing leaks, drainage, ventilation. Without moisture, the species cannot sustain a colony in the structure.', toxicity: 'None' }
    ],
    inspectionFrequency: '12 months',
    specialFlags: [
      { type: 'warning', icon: '⚠', text: 'TREATMENT LIMITATION — Modern termiticides are NOT registered for the control of Porotermes adamsoni. Treatment is primarily structural: remove affected timber, eliminate all moisture sources, and improve ventilation. Termiticide application is not the appropriate response for this species.' }
    ],
    fieldNotePrompts: [
      'Identify and document all moisture sources — plumbing leaks, drainage issues, ventilation problems',
      'Note extent of timber decay — document which structural members are affected',
      'Advise plumber/builder assessment to eliminate moisture source as primary remediation',
      'Standard chemical barrier treatment is NOT appropriate — advise client accordingly'
    ]
  },

  'Heterotermes': {
    commonName: 'Subterranean Termite',
    family: 'Rhinotermitidae',
    riskLevel: 'MEDIUM',
    riskLabel: 'MODERATE RISK',
    riskColor: 'yellow',
    destructionRate: 'Generally considered less of a threat than Coptotermes or Schedorhinotermes, but can cause considerable damage in northern Australia.',
    distribution: 'Found across mainland Australia. More significant pest in northern Australia.',
    identification: [
      'Soldiers: similar appearance to Coptotermes but HEAD IS LONGER AND MORE RECTANGULAR',
      'Coptotermes soldiers have a teardrop-shaped head — key differentiation',
      'Often confused with Coptotermes in the field'
    ],
    nestTypes: ['Subterranean', 'Tree stumps', 'Decayed wood in soil'],
    behaviour: [
      'Forages underground like Coptotermes',
      'Less aggressive than Coptotermes in most regions',
      'Significant concern in northern Australia'
    ],
    conduciveConditions: ['Timber-soil contact', 'Moisture', 'Decayed wood'],
    treatmentRecommended: 'YES',
    treatmentOptions: [
      { product: 'Termidor (Fipronil)', type: 'Chemical Barrier', notes: 'Standard non-repellent chemical barrier treatment.', toxicity: 'Moderate' },
      { product: 'Altriset (Chlorantraniliprole)', type: 'Chemical Barrier', notes: 'Low toxicity alternative.', toxicity: 'Very Low' }
    ],
    inspectionFrequency: '12 months',
    specialFlags: [
      { type: 'info', icon: 'ℹ', text: 'IDENTIFICATION NOTE — Heterotermes soldiers are often confused with Coptotermes. Key difference: Heterotermes soldiers have a longer, more rectangular head vs the teardrop shape of Coptotermes. Confirm identification before finalising treatment recommendation.' }
    ],
    fieldNotePrompts: [
      'Confirm species identification — distinguish from Coptotermes by soldier head shape',
      'Document location and extent of activity'
    ]
  },

  'Microcerotermes': {
    commonName: 'Termite',
    family: 'Termitidae',
    riskLevel: 'MEDIUM',
    riskLabel: 'MODERATE RISK',
    riskColor: 'yellow',
    destructionRate: 'Less destructive than Coptotermes or Schedorhinotermes but can damage hardwood timber, fences, poles and structural timbers.',
    distribution: 'Most of mainland Australia. Species distribution varies: M. turneri (east coast QLD to Port Macquarie NSW), M. distinctus (inland NSW/VIC), M. serratus (QLD, WA, NT, SA).',
    fieldID: [
      '👀 NEST TYPE: Look for a visible mound or arboreal nest. Microcerotermes may build low on-ground mounds, underground nests, or small arboreal mounds with distinctive stalactite-like projections — sometimes found on fence posts or halfway up tree trunks.',
      '🔑 SOLDIER HEAD: Rectangular head profile on soldiers — broader and more box-shaped than the rounded or teardrop heads of Coptotermes/Schedorhinotermes. No milky fluid (unlike Coptotermes) and no pointed snout (unlike Nasutitermes).',
      '🪵 TIMBER ATTACKED: Predominantly hardwood — check hardwood fences, posts, and structural timbers. Less likely to attack softwood (pine).',
    ],
    identification: [
      'Soldiers: rectangular head',
      'Various nesting habits — on-ground mounds, underground, or arboreal mounds with stalactite-like formations',
      'Arboreal mounds sometimes found on fence posts or halfway up tree trunks'
    ],
    nestTypes: [
      'Some species build on-ground mounds',
      'Others nest underground',
      'Others build distinctive arboreal mounds with stalactites'
    ],
    behaviour: ['Damages hardwood timber', 'Less aggressive than major pest species'],
    conduciveConditions: ['Timber-soil contact', 'Decayed wood', 'Hardwood structures'],
    treatmentRecommended: 'YES',
    treatmentOptions: [
      { product: 'Termidor (Fipronil)', type: 'Chemical Barrier', notes: 'Standard chemical barrier treatment.', toxicity: 'Moderate' },
      { product: 'Direct Nest Treatment', type: 'Nest Treatment', notes: 'If mound/nest is visible and accessible, direct injection is effective.', toxicity: 'Moderate' }
    ],
    inspectionFrequency: '12 months',
    specialFlags: [],
    fieldNotePrompts: [
      'Note nesting type — on-ground mound, underground, or arboreal with stalactites',
      'Check fence posts and hardwood timber structures in yard',
      'Document affected timber type and extent'
    ]
  }
};

// Fuzzy matching keys — maps common shorthand and variations to full species entries
const SPECIES_ALIASES = {
  'coptotermes': 'Coptotermes acinaciformis',
  'coptotermes acinaciformis': 'Coptotermes acinaciformis',
  'c. acinaciformis': 'Coptotermes acinaciformis',
  'acinaciformis': 'Coptotermes acinaciformis',
  'coptotermes frenchi': 'Coptotermes frenchi',
  'c. frenchi': 'Coptotermes frenchi',
  'frenchi': 'Coptotermes frenchi',
  'schedorhinotermes': 'Schedorhinotermes',
  'schedorhinotermes intermedius': 'Schedorhinotermes intermedius',
  'schedorhinotermes spp': 'Schedorhinotermes',
  'schedorhinotermes spp.': 'Schedorhinotermes',
  's. intermedius': 'Schedorhinotermes intermedius',
  'nasutitermes walkeri': 'Nasutitermes walkeri',
  'n. walkeri': 'Nasutitermes walkeri',
  'walkeri': 'Nasutitermes walkeri',
  'nasutitermes exitiosus': 'Nasutitermes exitiosus',
  'n. exitiosus': 'Nasutitermes exitiosus',
  'exitiosus': 'Nasutitermes exitiosus',
  'nasutitermes': 'Nasutitermes exitiosus',
  'nasutitermes spp': 'Nasutitermes exitiosus',
  'nasutitermes spp.': 'Nasutitermes exitiosus',
  'mastotermes': 'Mastotermes darwiniensis',
  'mastotermes darwiniensis': 'Mastotermes darwiniensis',
  'giant northern termite': 'Mastotermes darwiniensis',
  'darwin termite': 'Mastotermes darwiniensis',
  'cryptotermes': 'Cryptotermes brevis',
  'cryptotermes brevis': 'Cryptotermes brevis',
  'west indian drywood': 'Cryptotermes brevis',
  'drywood termite': 'Cryptotermes brevis',
  'porotermes': 'Porotermes adamsoni',
  'porotermes adamsoni': 'Porotermes adamsoni',
  'dampwood termite': 'Porotermes adamsoni',
  'heterotermes': 'Heterotermes',
  'heterotermes spp': 'Heterotermes',
  'microcerotermes': 'Microcerotermes',
  'microcerotermes spp': 'Microcerotermes',
  'microcerotermes spp.': 'Microcerotermes',
};

function lookupSpecies(raw) {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/\.$/, '');
  const canonical = SPECIES_ALIASES[key] || SPECIES_ALIASES[key.split(' ').slice(0,2).join(' ')];
  if (canonical && SPECIES_DB[canonical]) return { name: canonical, data: SPECIES_DB[canonical] };
  // Try partial match on genus
  for (const [alias, name] of Object.entries(SPECIES_ALIASES)) {
    if (key.startsWith(alias.split(' ')[0]) && SPECIES_DB[name]) {
      return { name, data: SPECIES_DB[name] };
    }
  }
  return null;
}

const SECTIONS = {
  property:        { fields:['structureType','height','occupancyStatus','weatherConditions','wallConstruction','roofType','floorType','facadeDirection','constructionEra','standard'], total:10 },
  obstructions:    { fields:['obstructions','restrictedAccess','highRiskAreas'], total:3 },
  restrictions:    { fields:['hinderedAreas','hinderedAreasDetail'], total:2 },
  findings:        { fields:['findings'], total:1 },
  conducive:       { fields:['waterLeaks','moistureReadings','leakLocation','timberSoil','slabEdge','weepHoles'], total:6 },
  recommendations: { fields:['riskLevel','treatmentRecommended','treatmentType','inspectionFrequency'], total:4 },
  photos:          { fields:['photos'], total:1 },
  signoff:         { fields:['inspectorLicence','inspectorSignature','clientSignature'], total:3 }
};

const SYSTEM_PROMPT = `You are a data extraction AI for KORVUS, an Australian termite inspection app compliant with AS 3660.2-2017.
Extract structured data from a pest control technician's spoken inspection notes. Return ONLY a valid JSON object.

Known NSW termite species: Coptotermes acinaciformis, Coptotermes frenchi, Schedorhinotermes intermedius, Nasutitermes walkeri, Nasutitermes exitiosus, Microcerotermes spp., Heterotermes ferox, Cryptotermes brevis.

Known treatment products and systems:
- Non-repellent chemical barriers: Termidor (Fipronil), Altriset (Chlorantraniliprole), Phantom, Premise
- Repellent chemical barriers: Bifenthrin, Biflex, Maxxthor, Talstar
- Baiting / monitoring systems: Exterra, Sentricon, Trelona
- Existing physical/chemical management systems: HomeGuard Blue (reported with linear metres of perimeter + pipe penetration collars)

Construction era materials (for constructionEra field):
- "Pre-1920s": timber stumps, weatherboard, corrugated iron, no slab
- "1920s-1940s": early brick, fibro introduced, timber stumps
- "1945-1965": fibro widespread (asbestos cement), brick veneer emerging — HIGH asbestos likelihood
- "1965-1985": brick veneer dominant, concrete slab standard, fibro in extensions — HIGH asbestos likelihood
- "1985-2003": asbestos declining, concrete slab standard, Colorbond introduced — MODERATE asbestos likelihood
- "Post-2003": asbestos banned, lightweight cladding, engineered timber — NONE

Direct decade references map the same way even without material descriptions, e.g. "built in the 70s", "early 2000s", "looks like a 90s build", "probably 1950s era" — map the stated or implied decade to the matching era range above.

Fields (null if not mentioned):
{"propertyStreetAddress":string,"propertySuburb":string,"propertyState":"NSW" or "VIC" or "QLD" or "WA" or "SA" or "TAS" or "ACT" or "NT","propertyPostcode":string,"clientName":string,"structureType":string,"wallConstruction":string,"floorType":string,"roofType":string,"height":string,"facadeDirection":string,"occupancyStatus":string,"weatherConditions":string,"constructionEra":"Pre-1920s" or "1920s-1940s" or "1945-1965" or "1965-1985" or "1985-2003" or "Post-2003","hinderedAreas":string(readily accessible areas inspected),"obstructions":string(areas not inspected),"restrictedAccess":string(physical obstructions preventing inspection),"hinderedAreasDetail":string(restrictions limiting inspection),"highRiskAreas":string(areas that could NOT be accessed or inspected and should be prioritised for a follow-up inspection once access becomes available — this is never a location where termite activity was actually found, inspected, and already captured in findings[]),"findings":[{"termiteActivity":"ACTIVE" or "INACTIVE" or "NONE","species":string,"damageDescription":string,"activityLocation":string,"nestLocated":"YES" or "NO","structuralConcern":"YES" or "NO"}],"waterLeaks":"YES" or "NO","leakLocation":string,"moistureReadings":"YES" or "NO","timberSoil":"YES" or "NO","slabEdge":"CLEAR" or "OBSTRUCTED","weepHoles":"CLEAR" or "BRIDGED","existingSystem":string,"durableNoticePresent":"YES" or "NO","hardLandscaping":"YES" or "NO","zone25mmVisible":"YES" or "NO","softLandscaping":"YES" or "NO","zone75mmVisible":"YES" or "NO","antCapSoldered":"YES" or "NO" or "N/A","treatmentRecommended":"YES" or "NO","treatmentType":string,"inspectionFrequency":string,"riskLevel":"LOW" or "MEDIUM" or "HIGH"}

Rules:
- Return ONLY the JSON. No other text.
- findings is always an array. If there is only one finding, return an array with one object. If the technician describes two or more distinct termite findings at different locations (e.g. active under the rear steps AND inactive near the front piers), return each as a separate object in the findings array. A new finding is signalled by a clear location change, a different species, or an explicit contrast ("also", "separately", "another area", "and over near the..."). Never merge two locationally distinct findings into one entry.
- Format species properly e.g. "Coptotermes acinaciformis"
- Format treatment products properly e.g. "Termidor (Fipronil)", "HomeGuard Blue — 66 linear metres perimeter"
- If treatment mentioned without specific product, use "Chemical Barrier Treatment"
- Recognize conducive condition language: bark chip, timber in soil, garden bed against structure, high moisture, blocked weep holes, landscaping timbers, backfill soil
- Only set constructionEra if the technician gives enough information to infer it (construction type, age mentioned, or specific materials like fibro)
- existingSystem captures any termite management system already installed and identified via durable notice (e.g. HomeGuard Blue, Kordon, Termimesh). If the technician says there is no existing system, no barrier, or nothing installed, leave existingSystem as null — do NOT write "No", "None", "Nil", "N/A" or similar into this field. Only fill it with an actual system name or description.
- leakLocation: only relevant when waterLeaks is "YES". Capture WHERE the leak or moisture source is — this is not limited to ground level/slab. Listen for leaks anywhere in the structure: roof, ceiling, wall cavity, bathroom/wet area plumbing, hot water system, gutters, as well as subfloor or perimeter sources. This matters because subterranean termites can establish above-ground secondary colonies near a roof or wall-cavity leak with zero soil contact — a ground-level-only leak check would miss this. Leave null if waterLeaks is "YES" but no location was mentioned.
- moistureReadings and waterLeaks normally move together — a leak is a moisture source. Whenever waterLeaks is "YES", or the technician otherwise describes damp/wet timber, elevated moisture meter readings, or dampness of any kind, set moistureReadings to "YES" as well. Only leave moistureReadings "NO" or null despite a leak being mentioned if the technician explicitly distinguishes the two (e.g. confirms a leaking tap exists but the surrounding timber tested dry on the meter).
- highRiskAreas is strictly about areas the technician could NOT access or inspect, that are worth prioritising once access is available (e.g. a locked shed, an obstructed subfloor section, dense vegetation blocking a fence line). It must NEVER duplicate a location already captured in findings[].activityLocation — a room or area where termite activity was actually found and reported is a finding, not a "high risk area". Leave highRiskAreas null unless the technician clearly describes somewhere they couldn't get to.

EXISTING SYSTEM VERIFICATION (only relevant when existingSystem is identified):
- durableNoticePresent: "YES" if the technician confirms seeing the durable notice/sticker in the meter box (or mentions identifying the system via the notice — this implies it's present). "NO" if they specifically mention it's missing, damaged, or not found. Leave null if not mentioned.
- hardLandscaping / softLandscaping: whether hard surfaces (paths, pavers, driveways) or soft landscaping (garden beds, lawns) are adjacent to the perimeter — purely descriptive, not a pass/fail.
- zone25mmVisible: only relevant if hardLandscaping is YES — whether the 25mm inspection zone/gap is visible and maintained against hard surfaces.
- zone75mmVisible: only relevant if softLandscaping is YES — whether the 75mm inspection zone is visible and maintained against soft landscaping/soil.
- antCapSoldered: whether ant cap or strip shield joins are soldered (a gap here means termites could pass through undetected). Use "N/A" if the technician indicates the system doesn't use ant caps/strip shielding, or leave null if not mentioned at all.

CRITICAL — termiteActivity is a three-state field, not binary, and reflects real industry terminology:
- "ACTIVE": live termites were actually sighted by the technician (e.g. "live termites present", "found live workers", "termites moving in the gallery")
- "INACTIVE": evidence of termite workings, damage, mudding, or exit holes was found, but NO live termite was actually sighted (e.g. "old workings, nothing alive", "mud tubes present but no live termites seen", "evidence of past activity, doesn't look current"). This is a real and common finding — don't force it into ACTIVE or NONE just because something was found.
- "NONE": no termites and no evidence of termites or their workings at all.
- If species, damage description, or activity location are mentioned but the technician does NOT confirm a live sighting, default to "INACTIVE" rather than "ACTIVE" — never assume live presence just because damage or workings exist. Only set "ACTIVE" when live presence is explicitly or very clearly stated.
- If termiteActivity is "NONE", leave species/damageDescription/activityLocation/nestLocated/structuralConcern as null.

CRITICAL — damageDescription must NEVER contain a severity opinion:
- damageDescription captures ONLY what is objectively observable: the affected timber/element (e.g. "skirting board", "wall plate", "tree stump"), the specific location (e.g. "bedroom four, hallway", "rear section of property"), and visible characteristics (hollow sounding, mud tubes, bubbling paint, frass, exit holes, gallery patterns). This mirrors real AS 4349.3 report language such as "top wall plate timbers — bedroom four, lounge room, hallway."
- NEVER write or infer the words "minor", "moderate", "severe", "extensive", "significant", "extreme", or any other severity/extent-grading adjective into damageDescription, even if the technician uses one of these words themselves while speaking. If a technician says "it's pretty severe" or "just minor damage", DROP the severity adjective entirely and extract only the factual description that accompanies it (what, where). Do not paraphrase their severity opinion into different wording — omit it.
- Timber pest inspectors are not qualified to assess structural damage severity, and asserting it creates legal and insurance liability exposure if a severity opinion later contradicts an actual structural finding. This is a hard architectural rule, not a style preference.
- structuralConcern is a separate YES/NO flag, NOT a severity rating. Set to "YES" only if the technician's language suggests the damage may be structurally significant (e.g. "this is structural", "looks like it's gone through the load-bearing section", "could be holding up the roof", "extensive enough it might need an engineer") — this triggers a mandatory recommendation in the report that a builder or structural engineer be engaged, mirroring real industry practice where the inspector flags a structural concern without personally rating how bad it is. If unclear or not mentioned, leave as null rather than guessing "NO".

Handling real-world speech:
- SELF-CORRECTIONS: technicians often correct themselves mid-sentence ("brick veneer, no wait, actually it's weatherboard", "eastern side — sorry, western side"). Always use the FINAL corrected value, never the originally stated one, and never combine both into a single string.
- IMPLICIT FINDINGS: if species, damage description, or activity location are mentioned, that means termiteActivity should be "ACTIVE" or "INACTIVE" (see the three-state rule above for which one) — set it even if the technician never explicitly says "active" or "inactive". Conversely, if the technician says no termites, no activity, or nothing found, set termiteActivity to "NONE". Similarly, if a nest, mound, or nest workings are described anywhere in the transcript, set nestLocated to "YES" even if the technician doesn't use the phrase "nest located".
- UNCERTAINTY: technicians often hedge ("might be", "hard to tell", "looks like", "possibly"). Still extract their best-guess value for that field — don't leave it null just because they expressed uncertainty. Capture the hedge in the relevant notes-style detail only if a dedicated free-text field exists; otherwise just use their stated best guess.
- MIXED-TOPIC SPEECH: a single utterance may contain information for multiple sections at once (e.g. a findings description followed immediately by a conducive condition). Extract every relevant field regardless of which "section" it would visually belong to — do not stop extracting after the first topic.
- FILLER AND FALSE STARTS: ignore filler words ("um", "yeah", "so", "right", "like I said") and abandoned false starts ("we're at the— so the property is...") — extract only the substantive content that follows.
- NEGATIONS: pay close attention to "no", "not", "none", "clear of" — these flip YES/NO fields and risk levels. "No conducive conditions identified" should not be misread as a positive finding for any of the YES/NO conducive fields.

VOICE-DICTATION HOMOPHONE ERRORS:
Transcripts come from on-device voice dictation, not a human typist, and dictation engines frequently mishear pest-inspection jargon as a similar-sounding everyday word. When a literal reading of a word or phrase doesn't make sense in a pest-inspection context, silently correct it to the sensible reading rather than transcribing the mishearing — do not flag the correction or ask for clarification, just use the judgement an experienced inspector would use proofreading a colleague's dictation. Known patterns to watch for (this list is a starting point, not exhaustive — apply the same reasoning to any word that clearly doesn't fit context):
- "shed fence" → usually "shared fence" (a shared boundary fence line, not a garden shed)
- "strawberry" (e.g. "dense strawberry along the boundary") → usually "shrubbery"
- "insulation" immediately before "termite management system" or "barrier" → usually "installation"
- "bats" near roof void/manhole/ceiling → usually "batts" (roof/ceiling insulation batts), not the animal
- "access moisture" / "causing access moisture" → usually "excess moisture"
- "weep poles" → usually "weep holes"
- a garbled, vaguely Latin-sounding word (e.g. "copter terms") → likely a mangled genus name; match it to the closest species in the known-species list above (e.g. "Coptotermes")
- "construction error" → usually "construction era"
- a stray duplicated word or fragment immediately before the real word (e.g. "enact inactive", "separate separately") → drop the fragment, use the real word that follows
- "eastern bearer" (a structural timber member) → commonly mangled to "Easter Barra" / "Easter bearer" / similar — a bearer is a structural timber term, not a reference to the Easter holiday
- a phonetically plausible but contextually nonsensical phrase (e.g. "cold on", "quote on", "code on", "called on") immediately before "physical termite barrier" → almost always "Kordon", a termite barrier brand name
- PROPER NOUNS AND BRAND NAMES generally: dictation engines have no training data for niche industry brand names (Kordon, Termimesh, HomeGuard Blue, etc.) and will substitute the nearest common English words instead. When a product/brand-shaped slot in the sentence (e.g. "there's a ___ installed", "existing system is ___") is filled with ordinary words that don't fit grammatically or semantically, treat it as a mangled brand name and match it to the closest entry in the known products/systems list above rather than transcribing the literal (nonsensical) words.
Apply this reasoning generally: prioritise the pest-inspection-domain-sensible reading of a word over a literal transcription whenever the literal reading is nonsensical or clearly out of place in context.

riskLevel inference: technicians rarely state "overall risk is HIGH" directly — infer it from what was found, unless an explicit overall risk statement is given (which always takes precedence). riskLevel reflects relative property-level risk of attack (a legitimate, subjective, comparative rating under AS 4349.3/AEPMA guidance), NOT a damage severity judgement — these are different things:
- HIGH: termiteActivity is "ACTIVE" AND (structuralConcern is "YES" OR a nest located OR multiple significant conducive conditions together, e.g. timber-soil contact AND water leak AND high moisture)
- MEDIUM: termiteActivity is "ACTIVE" with no structural concern flagged, OR termiteActivity is "INACTIVE", OR one or two conducive conditions present with termiteActivity "NONE"
- LOW: termiteActivity is "NONE" and no, or only very minor, conducive conditions
- Only set riskLevel if there's enough information across the whole transcript to make this judgement — otherwise leave null.
- propertyStreetAddress/propertySuburb/propertyState/propertyPostcode/clientName: only fill these if the technician actually states the property address and/or client name out loud (this is common at the start of a recording, e.g. "inspection at 42 Smith Street, Chatswood, client John Mitchell"). Never guess, infer, or invent an address or client name from context. propertyState must be one of the 8 official Australian abbreviations shown above — convert a spoken state name (e.g. "New South Wales") to its abbreviation. Leave every one of these null if not clearly stated.`;

// System prompt for the "scan compliance plate" photo feature — a separate,
// narrow prompt (not the giant voice SYSTEM_PROMPT above) for reading a
// single photo of a termite management system durable notice/plate, usually
// found in the meter box. Kept intentionally small: one job, one small JSON
// shape, so it stays reliable in a way a broad multi-field extraction can't.
// NOTE: the "existingSystem" and "existingSystemOther" values below must
// stay in sync with the OPTIONS.existingsystem / SPECIFIC_SYSTEMS_BY_TYPE
// lists inside startEdit() — those are what the on-screen dropdowns offer.
const PLATE_SYSTEM_PROMPT = `You are reading a single photo of an Australian termite management system durable notice (a compliance plate or sticker, usually found in a home's meter box, subfloor access, or near the front entry). Your only job is to read what is printed on it and return a small JSON object — nothing else.

Respond with ONLY raw JSON (no markdown fences, no commentary), matching exactly this shape:
{"systemFound":"YES" or "NO","existingSystem":string or null,"existingSystemOther":string or null,"extraDetails":string or null}

Rules:
- If no durable notice/compliance plate is visible in the photo, or the text is too unclear to read with real confidence, return {"systemFound":"NO","existingSystem":null,"existingSystemOther":null,"extraDetails":null}. Do not guess.
- "existingSystem" must be EXACTLY one of these five strings (whichever matches the system type printed on the plate) — never invent a different value:
  "Physical Barrier"
  "Chemical Reticulation System"
  "Termite Baiting System"
  "Combination System — Physical + Chemical"
  "System Present — Type Unidentified"
  Only use "System Present — Type Unidentified" if the plate confirms a system exists but its type genuinely can't be determined from the text.
- "existingSystemOther" is the specific product/brand name printed on the plate — for example "Kordon", "HomeGuard Blue", "HomeGuard DPC", "HomeGuard TMB", "HomeGuard GT", "Termseal", "Smartfilm", "Termimesh", "Granitgard", "Greenzone", "Termguard", "Altis", "TermX", "TermStop", "Camilleri", "Cavtech", "Reterm", "Exterra", "Sentricon", "Trelona", "Nemesis". Use the exact brand name as printed, even if it isn't in this list. If no brand name is legible, return null for this field even when "existingSystem" is set.
- "extraDetails" is a short (under 140 characters) plain-text note of anything else useful and legible on the plate that doesn't fit the fields above — e.g. install date, installer/company name, licence number. Return null if nothing else is legible.
- Never fabricate a value for any field. If you're not confident, use null rather than guessing.`;

// System prompt for the "identify from photo" button on a finding's
// Species/Genus field. Deliberately biased toward the genus-level "... spp."
// and "not identified" fallbacks rather than a confident-sounding wrong
// species — this feeds a real inspection report, and species-level ID from
// a single phone photo is hard even for a person. Keep this list in sync
// with SPECIES_LIST (defined near startEdit(), used by the manual dropdown).
const INSECT_ID_SYSTEM_PROMPT = `You are looking at a single photo of an insect or insect-damage specimen collected during an Australian timber pest inspection. Identify it as best you can and return ONLY raw JSON (no markdown fences, no commentary), matching exactly this shape:
{"identified":"YES" or "NO","species":string or null,"confidence":"HIGH" or "MEDIUM" or "LOW" or null,"notes":string or null}

Rules:
- "species" must be EXACTLY one of the following values, copied verbatim — never invent a new one, and never write a species name that isn't in this list:
  Coptotermes acinaciformis
  Coptotermes frenchi
  Coptotermes lacteus
  Schedorhinotermes intermedius
  Schedorhinotermes actuosus
  Nasutitermes exitiosus
  Nasutitermes walkeri
  Nasutitermes magnus
  Heterotermes ferox
  Microcerotermes distinctus
  Microcerotermes implicatus
  Termes intermedius
  Cryptotermes brevis
  Cryptotermes primus
  Anobium punctatum — Furniture beetle
  Lyctus brunneus — Powder post beetle
  Hylotrupes bajulus — House longhorn beetle
  Coptotermes spp.
  Schedorhinotermes spp.
  Nasutitermes spp.
  Microcerotermes spp.
  Species not identified — further investigation required
- Exact species-level identification from a single photo is genuinely hard, even for an experienced entomologist — prefer the genus-level "... spp." option over guessing a specific species you aren't confident about. Only choose an exact species when the photo clearly shows that species' distinguishing features (soldier head shape and colour, mandible shape, body size for termites; body shape and size for the beetle species).
- If the insect in the photo isn't a termite or one of the listed timber pest beetles at all (an ant, a spider, an unrelated insect), or the photo doesn't show enough detail to say anything useful, set "identified":"NO", "species":null, "confidence":null, and briefly say why in "notes" (e.g. "appears to be an ant, not a termite" or "image too blurry to identify").
- "confidence" reflects how sure you are of the "species" value you chose — "HIGH" only when the diagnostic features are clearly visible, "MEDIUM" when reasonably confident but some uncertainty remains, "LOW" when it's a genuine best guess. Always include a confidence level whenever "species" is set.
- "notes" is a short (under 140 characters) plain-text explanation of the visible features behind this identification (e.g. "pale soldier head, elongated mandibles, consistent with Coptotermes"), or null when identified is "NO".
- This is a starting point for the inspector to confirm, never a final determination — never phrase "notes" as a certainty.`;

// ── SPLASH ────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  // Register service worker for offline support (PWA only — skip inside the
  // native app wrapper, where Capacitor's own WebView handles asset loading
  // and a service worker can cause stale-cache issues).
  if ('serviceWorker' in navigator && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
    navigator.serviceWorker.register('service-worker.js', { scope: './' }).catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  }

  const statusEl = document.getElementById('splashStatus');
  const messages = [
    'Initialising vocabulary…',
    'Loading NSW species reference…',
    'Preparing report template…',
  ];
  let msgIndex = 0;
  if (statusEl) {
    const cycle = setInterval(() => {
      msgIndex++;
      if (msgIndex < messages.length) {
        statusEl.style.opacity = '0';
        setTimeout(() => {
          statusEl.textContent = messages[msgIndex];
          statusEl.style.opacity = '1';
        }, 150);
      } else {
        clearInterval(cycle);
      }
    }, 700);
  }

  setTimeout(async () => {
    const splash = document.getElementById('splash');
    splash.style.opacity = '0';
    setTimeout(async () => {
      splash.style.display = 'none';

      // If we arrived here via a "reset your password" email link, Supabase
      // redirects back with the recovery tokens in the URL hash. Handle that
      // before anything else — it takes priority over any existing session.
      const recovery = parseRecoveryHash();
      if (recovery) {
        pendingRecoverySession = recovery;
        // Strip the tokens out of the visible URL/history now that we've read them.
        history.replaceState(null, '', window.location.pathname + window.location.search);
        document.getElementById('authScreen').style.display = 'flex';
        showAuth('authResetPassword');
        return;
      }

      const hasSession = await restoreAuthSession();
      if (hasSession) { enterApp(); }
      else { document.getElementById('authScreen').style.display = 'flex'; showAuth('authSignIn'); }
    }, 600);
  }, 2200);
});

// ── PLATFORM NAVIGATION ─────────────────────────────────────────────────
function openApp(appName) {
  if (appName === 'quote') { openQuote('menu'); return; }
  if (appName !== 'inspect') return;

  const menu = document.getElementById('mainMenu');
  const app = document.getElementById('app');
  menu.style.display = 'none';
  app.style.display = 'flex';

  if (!appInitialised) {
    appInitialised = true;
    initMobileView();
    initSignaturePads();
    enhanceFieldsWithNotes();
    renderSavedList();
    const restored = loadDraft();
    restoreSignaturePads(); restoreLicenceField();
    renderPhotoGrid();
    renderFindingsUI();
    restoreObsState();
    restoreResState();
    renderAllSectionPhotoGrids();
    // Restore conditional field visibility
    if (reportData.moistureReadings === 'YES') {
      const wrap = document.getElementById('waterLeakWrap');
      if (wrap) wrap.style.display = '';
      if (reportData.waterLeaks === 'YES') {
        const llWrap = document.getElementById('leakLocationWrap');
        if (llWrap) llWrap.style.display = '';
      }
    }
    if (restored) showToast('Restored unsaved work', 'info');
    if (!reportData.standard) setStandard('AS 3660.2-2017');
    enableKeyboardActivation();
    applyPanelCollapseStates();
    restoreA11ySettings();
    restoreAudioCaptureSetting();
    loadCompanyDetails();
    loadJobInfo();
    if (restored) lastLocalSaveAt = Date.now();
    updateSyncStatus();
    supabaseSyncOnOpen(); // pull any cloud reports not on this device
  }
}

// ── ACCESSIBILITY: keyboard activation for clickable divs ──────────────────
function enableKeyboardActivation() {
  document.querySelectorAll('.field-val[onclick]').forEach(el => {
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.addEventListener('keydown', (e) => {
      // Only act when the keydown originates on the div itself (keyboard-focused,
      // not yet in edit mode). Once startEdit() inserts a child <input>/<select>,
      // its keydown events bubble up to this same listener — without this guard,
      // every Enter/Space keystroke typed inside an open field would also
      // re-trigger startEdit() via el.click(), which silently ate every space
      // character typed into any text field and visually reset the field after
      // pressing Enter even though the value had already saved correctly.
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.click();
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// FIELD NOTES — expandable description sub-sections per field
// ══════════════════════════════════════════════════════════════════════════
let fieldNotes = {};
let activeNotesTargetKey = null; // which field's notes the voice popover is dictating into

function enhanceFieldsWithNotes() {
  document.querySelectorAll('.field-val[id^="f-"]').forEach(valEl => {
    const key = valEl.id.replace('f-', '');
    const fieldEl = valEl.closest('.field') || valEl.closest('.findings-gate-question');
    if (!fieldEl) return;
    const labelEl = fieldEl.querySelector('.field-label');
    if (!labelEl || labelEl.dataset.enhanced) return;
    labelEl.dataset.enhanced = '1';

    // Build notes panel — attached after the field-val directly, no pencil button
    const panel = document.createElement('div');
    panel.className = 'field-notes';
    panel.id = 'notes-' + key;
    panel.innerHTML = `
      <textarea class="field-notes-textarea" id="notes-text-${key}" placeholder="Add detail — location, description, observations…" oninput="onNotesInput('${key}')"></textarea>
      <div class="field-notes-bar">
        <button class="field-notes-mic" type="button" onclick="openNotesVoice('${key}')">
          <svg class="icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          Dictate
        </button>
        <span class="field-notes-charcount" id="notes-count-${key}"></span>
      </div>
    `;
    valEl.insertAdjacentElement('afterend', panel);
  });
}

function toggleFieldNotes(key) {
  // Don't open notes while the field value itself is being edited
  const fieldEl = document.getElementById('f-' + key);
  if (fieldEl && fieldEl.classList.contains('editing')) return;

  const panel = document.getElementById('notes-' + key);
  const toggle = document.getElementById('notes-toggle-' + key);
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  if (toggle) toggle.classList.toggle('open', isOpen);
  if (isOpen) {
    const ta = document.getElementById('notes-text-' + key);
    if (ta) setTimeout(() => ta.focus(), 50);
  }
}

function getSectionForKey(key) {
  for (const [sec, cfg] of Object.entries(SECTIONS)) {
    if (cfg.fields.includes(key)) return sec;
  }
  return 'property';
}

function getFieldLabel(valEl) {
  const fieldEl = valEl.closest('.field') || valEl.closest('.findings-gate-question');
  return fieldEl ? fieldEl.querySelector('.field-label') : valEl.previousElementSibling;
}

function onNotesInput(key) {
  const ta = document.getElementById('notes-text-' + key);
  if (!ta) return;
  fieldNotes[key] = ta.value;
  updateNotesIndicator(key);
  saveDraft();
}

function updateNotesIndicator(key) {
  const toggle = document.querySelector(`[onclick="toggleFieldNotes('${key}')"]`);
  const countEl = document.getElementById('notes-count-' + key);
  const hasContent = !!(fieldNotes[key] && fieldNotes[key].trim());
  if (toggle) toggle.classList.toggle('has-content', hasContent);
  if (countEl) countEl.textContent = hasContent ? `${fieldNotes[key].trim().length} chars` : '';
}

function restoreFieldNotes() {
  Object.entries(fieldNotes).forEach(([key, val]) => {
    const ta = document.getElementById('notes-text-' + key);
    if (ta && val) {
      ta.value = val;
      updateNotesIndicator(key);
    }
  });
}

// ── Targeted voice dictation into field notes ──────────────────────────────
function openNotesVoice(key) {
  activeNotesTargetKey = key;
  const popover = document.getElementById('voicePopover');
  const title = document.getElementById('voicePopoverTitleText');
  const fab = document.getElementById('micFab');

  // Get field label for context
  const panel = document.getElementById(`notes-${key}`);
  const fieldEl = panel ? (panel.closest('.field') || panel.closest('.findings-gate-question')) : null;
  const labelEl = fieldEl ? fieldEl.querySelector('.field-label') : null;
  const labelText = labelEl ? labelEl.textContent.replace('edit', '').trim() : 'this field';

  if (title) title.textContent = `Dictating: ${labelText}`;
  document.getElementById('extractBtn').style.display = 'none';
  document.getElementById('useTranscriptBtn').style.display = 'block';

  if (!popover.classList.contains('open')) {
    popover.classList.add('open');
    fab.classList.add('open');
  }

  // Pre-fill transcript box with existing notes if any
  const box = document.getElementById('transcriptBox');
  const existing = fieldNotes[key] || '';
  if (existing) {
    box.textContent = existing;
    box.classList.add('active');
    currentTranscript = existing;
  } else {
    box.textContent = 'Tap the mic and start speaking…';
    box.classList.remove('active');
    currentTranscript = '';
  }
  lowConfidenceFlagged = false;
  const warnElNotes = document.getElementById('lowConfidenceWarning');
  if (warnElNotes) warnElNotes.classList.remove('show');
  resetConfDebug();
  dismissCleanupSuggestion();
  dismissServerTranscript();
}

function useTranscriptForNotes() {
  if (!activeNotesTargetKey) return;
  const key = activeNotesTargetKey;
  const text = currentTranscript.trim();
  if (!text) {
    showToast('Nothing to add yet — speak first', 'error');
    return;
  }

  fieldNotes[key] = text;
  const ta = document.getElementById('notes-text-' + key);
  if (ta) ta.value = text;
  updateNotesIndicator(key);

  // Ensure the notes panel is open
  const panel = document.getElementById('notes-' + key);
  const toggle = document.querySelector(`[onclick="toggleFieldNotes('${key}')"]`);
  if (panel && !panel.classList.contains('open')) {
    panel.classList.add('open');
    if (toggle) toggle.classList.add('open');
  }

  saveDraft();
  showToast('Notes added', 'success');
  resetVoicePopoverToDefault();
  toggleVoicePopover(); // close popover
}

function resetVoicePopoverToDefault() {
  activeNotesTargetKey = null;
  const title = document.getElementById('voicePopoverTitleText');
  if (title) title.textContent = 'Voice Capture';
  document.getElementById('extractBtn').style.display = 'flex';
  document.getElementById('useTranscriptBtn').style.display = 'none';
  const box = document.getElementById('transcriptBox');
  box.textContent = 'Tap the mic and start speaking, or tap here to type instead.';
  box.classList.remove('active');
  currentTranscript = '';
  lowConfidenceFlagged = false;
  const warnElReset = document.getElementById('lowConfidenceWarning');
  if (warnElReset) warnElReset.classList.remove('show');
  resetConfDebug();
  dismissCleanupSuggestion();
  dismissServerTranscript();
}

// ── NATIVE SPEECH RECOGNITION ADAPTER ───────────────────────────────────────
// The browser's Web Speech API (window.SpeechRecognition) does not exist inside a
// Capacitor WKWebView on iOS — it only works in Safari itself. This class wraps the
// native @capacitor-community/speech-recognition plugin behind the same event-driven
// shape the rest of this file already uses (continuous/interimResults/lang props,
// start()/stop()/abort() methods, onresult/onerror/onend callbacks), so the existing
// startRecording() and hfStartListening() code below works unchanged on both platforms.
class NativeSpeechRecognition {
  constructor() {
    this.continuous = true;
    this.interimResults = true;
    this.lang = 'en-AU';
    this.maxAlternatives = 1;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this._listener = null;
    this._running = false;
  }

  async start() {
    const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SpeechRecognition;
    if (!plugin) { this._fail('not-available'); return; }

    try {
      const perm = await plugin.requestPermissions();
      const granted = !perm || !perm.speechRecognition || perm.speechRecognition === 'granted';
      if (!granted) { this._fail('not-allowed'); return; }
    } catch (e) { this._fail('not-allowed'); return; }

    try {
      this._listener = await plugin.addListener('partialResults', (data) => {
        const matches = (data && data.matches) || [];
        if (!matches.length || !this.onresult) return;
        // Native partial results deliver the whole phrase-so-far, not per-segment chunks
        // like the Web Speech API — treat every update as still-interim until the session
        // actually ends below, at which point we commit one final result.
        this.onresult({ resultIndex: 0, results: [ { isFinal: false, 0: { transcript: matches[0] } } ] });
      });
    } catch (e) { /* non-fatal — proceed without live partials */ }

    this._running = true;
    let finalMatches = null;

    // The device/Simulator doesn't always have every locale's speech model
    // available (the iOS Simulator in particular usually only ships en-US) —
    // when that happens the plugin throws "Failed to initialize recognizer".
    // A single session still only understands one English variant at a time
    // (there's no "understand every accent at once" mode), but different
    // variants are still broadly accent-tolerant — so try the locale best
    // suited to this app's actual users first (Australian English, for
    // local terms and slang), then cascade through other major English
    // variants until we find one this specific device actually supports,
    // so the app works regardless of which language packs happen to be
    // installed rather than failing outright. Once we find a locale that
    // actually initializes on this device, remember it for next time so
    // hands-free mode (which restarts a session every ~1.2s pause) isn't
    // repeatedly retrying locales already known to fail here.
    const ENGLISH_LOCALE_FALLBACKS = ['en-AU', 'en-GB', 'en-US', 'en-NZ', 'en-CA', 'en-IE', 'en-ZA', 'en-IN'];
    const langsToTry = NativeSpeechRecognition._workingLang
      ? [NativeSpeechRecognition._workingLang]
      : [...new Set([this.lang || 'en-AU', ...ENGLISH_LOCALE_FALLBACKS])];
    let lastErr = null, started = false;
    for (const lang of langsToTry) {
      try {
        const res = await plugin.start({ language: lang, partialResults: true, popup: false });
        finalMatches = res && res.matches;
        NativeSpeechRecognition._workingLang = lang;
        started = true;
        break;
      } catch (e) {
        lastErr = e;
        const msg = ((e && (e.errorMessage || e.message)) || '') + '';
        if (!/initialize/i.test(msg)) break; // a different kind of error — don't mask it by retrying
      }
    }
    if (!started) {
      this._running = false;
      this._removeListener();
      this._fail((lastErr && (lastErr.errorMessage || lastErr.message)) || 'unknown');
      return;
    }

    this._running = false;
    this._removeListener();
    if (finalMatches && finalMatches.length && this.onresult) {
      this.onresult({ resultIndex: 0, results: [ { isFinal: true, 0: { transcript: finalMatches[0] } } ] });
    }
    if (this.onend) this.onend();
  }

  async stop() {
    if (!this._running) return;
    try {
      const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SpeechRecognition;
      if (plugin) await plugin.stop();
    } catch (e) {}
  }

  abort() { this.stop(); }

  _removeListener() {
    if (this._listener) { try { this._listener.remove(); } catch (e) {} this._listener = null; }
  }

  _fail(reason) {
    this._removeListener();
    if (this.onerror) this.onerror({ error: reason });
  }
}

function getSpeechRecognitionCtor() {
  const isNative = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
  const hasNativePlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SpeechRecognition;
  if (isNative && hasNativePlugin) return NativeSpeechRecognition;
  if (isNative) return null; // native app, plugin not installed yet — no browser fallback exists here
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// ── VOICE ─────────────────────────────────────────────────────────────────
function toggleRecording() {
  isRecording ? stopRecording() : startRecording();
}

// Evidence-based correction for specific, repeated mishearings documented
// during real-device dictation testing (iOS Safari, 2 Oct 2026) — NOT a
// general-purpose fuzzy matcher. Each entry here is a pattern that was
// observed to fail the SAME way more than once, with the correction scoped
// tightly enough (surrounding context required) that it shouldn't touch
// unrelated speech. Add to this list only once a mishearing has been seen
// to repeat — a one-off garble isn't worth the false-positive risk.
function correctKnownMishearings(text) {
  if (!text) return text;
  // "Kordon" (termite barrier brand) has never once been recognised
  // correctly in testing - it comes back as a phonetically similar common
  // phrase instead. Scoped to only fire directly before "physical termite
  // barrier" so it can't misfire on an unrelated use of e.g. "quote on".
  // "caught on" added after a second test run produced yet another variant -
  // this word clearly has no stable "wrong" spelling, so expect to keep
  // adding to this alternation as new variants turn up.
  text = text.replace(/\b(cold on|quote on|code on|called on|coded on|caught on)\b(?=\s+physical termite barrier)/gi, 'Kordon');
  // "bearer" (a structural timber term) has now been seen mangled three
  // different ways across two test rounds: "Easter Barra", "eastern
  // barrel" (direction word correct, only "bearer" wrong this time), and
  // bare "subfloor barer". Handled as three narrow, evidence-based
  // patterns rather than one broad fuzzy match, since "barrel" alone is a
  // real, common word that could legitimately appear elsewhere.
  text = text.replace(/\beaster\s+(?:barra|barrow|bearer)\b/gi, 'eastern bearer');
  text = text.replace(/\b(eastern|western|northern|southern)\s+barrel\b/gi, '$1 bearer');
  text = text.replace(/\bsubfloor\s+barer\b/gi, 'subfloor bearer');
  // The three below mirror patterns already vetted in SYSTEM_PROMPT's
  // homophone-handling section (so they're evidence-based, not new guesses)
  // - ported here so they're also visible/fixed in the transcript box
  // itself and still work on the offline (no-AI) extraction path, not just
  // when the AI call succeeds.
  text = text.replace(/\binsulation\b(?=\s+(?:termite management system|barrier))/gi, 'installation');
  text = text.replace(/\baccess moisture\b/gi, 'excess moisture');
  text = text.replace(/\bweep poles\b/gi, 'weep holes');
  // "strawberry" directly before "along the boundary" (or similar) only -
  // left narrower than the AI prompt's version since "strawberry" alone is
  // a real word that could legitimately come up (e.g. a garden bed).
  text = text.replace(/\bstrawberry\b(?=\s+(?:along|growing along|against)\s+the\s+boundary)/gi, 'shrubbery');
  return text;
}

// Generic safety net for brand/product names and species genera Korvus
// knows about, on top of the specific evidence-based corrections above.
// UNLIKE those, this has no real-world evidence of how each term actually
// gets misheard - most of these haven't been tested yet. It's a defensive
// net, not a documented fix: word-level similarity against the known list,
// deliberately conservative (short words are skipped entirely, and the
// allowed edit distance is small) so it only ever nudges a word that's
// ALREADY close to a known term - it can't invent a brand name from
// nothing, and multi-word species names (e.g. "Coptotermes acinaciformis")
// are intentionally left to the AI's contextual reasoning in SYSTEM_PROMPT
// instead, since fuzzy-matching a whole Latin phrase word-by-word is much
// less reliable than matching a single distinctive brand/genus word.
const KORVUS_BRAND_VOCAB = [
  'Kordon', 'Termidor', 'Altriset', 'Phantom', 'Bifenthrin',
  'Biflex', 'Maxxthor', 'Talstar', 'Exterra', 'Sentricon', 'Trelona',
  'Termimesh', 'HomeGuard',
  // "Premise" deliberately excluded - one character away from the
  // ordinary, legitimate word "premises" ("nothing of concern on the
  // premises"), which a real test case caught being falsely corrected to
  // "Premise". Left to SYSTEM_PROMPT's contextual AI reasoning instead,
  // where full-sentence context can tell the two apart safely.
];
const KORVUS_GENUS_VOCAB = [
  'Coptotermes', 'Schedorhinotermes', 'Nasutitermes', 'Microcerotermes',
  'Heterotermes', 'Cryptotermes',
];

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Returns the closest vocab term if `word` is close-but-not-identical to
// it (within maxDistanceRatio of the term's length), else null. Exact
// matches return null too - nothing to correct.
function fuzzyMatchVocab(word, vocab, maxDistanceRatio, minWordLength) {
  const w = word.toLowerCase();
  if (w.length < minWordLength) return null;
  let best = null, bestDist = Infinity;
  for (const term of vocab) {
    const t = term.toLowerCase();
    if (w === t) return null;
    const dist = levenshteinDistance(w, t);
    const maxAllowed = Math.floor(t.length * maxDistanceRatio);
    if (dist > 0 && dist <= maxAllowed && dist < bestDist) {
      best = term; bestDist = dist;
    }
  }
  return best;
}

function applyVocabSafetyNet(text) {
  if (!text) return text;
  return text.replace(/[A-Za-z][A-Za-z'-]*/g, (word) => {
    const brandMatch = fuzzyMatchVocab(word, KORVUS_BRAND_VOCAB, 0.3, 5);
    if (brandMatch) return brandMatch;
    const genusMatch = fuzzyMatchVocab(word, KORVUS_GENUS_VOCAB, 0.3, 6);
    if (genusMatch) return genusMatch;
    return word;
  });
}

// ── AI TRANSCRIPT CLEANUP (suggest-and-confirm, never automatic) ──────────
// Unlike correctKnownMishearings()/applyVocabSafetyNet() above, which only
// ever nudge a word that's ALREADY close to something known, this asks the
// AI to reason about genuinely garbled stretches of the transcript - the
// "Shut up Scott Stratford Number Double" kind of result that doesn't
// resemble anything on a word-list. That's real signal loss, not a simple
// mishearing, and an AI asked to "fix" it can't recover what was actually
// said - it can only invent something plausible. For a transcript that
// becomes evidence in a professional report, a confident-looking
// fabrication slipping through unnoticed is worse than an obviously
// garbled one, so this NEVER touches the transcript on its own. It always
// shows the inspector exactly what it would change and waits for Apply.
const TRANSCRIPT_CLEANUP_PROMPT = `You are proofreading a voice-dictated transcript from an Australian termite/pest inspection technician (KORVUS app). The transcript came from on-device speech recognition and may contain mishearings - a garbled word or phrase standing in for the real one, based on how it sounds.

Your job: produce a corrected version of the transcript, fixing ONLY mishearings you can confidently resolve from context - the same judgement an experienced inspector would use proofreading a colleague's dictation. Known categories to watch for: brand/product names (Kordon, Termidor, Altriset, Phantom, Bifenthrin, Biflex, Maxxthor, Talstar, Exterra, Sentricon, Trelona, Termimesh, HomeGuard Blue), species names (e.g. Coptotermes acinaciformis), and pest-inspection technical terms (e.g. "bearer", "weep holes", "shrubbery", "installation", "subfloor").

CRITICAL: if a stretch of the transcript is too garbled to confidently reconstruct - not a mispronounced word, but content that doesn't resemble anything sensible in a pest-inspection context at all - do NOT invent or guess what it might have meant. Leave that exact stretch exactly as transcribed, and set hasUncertainSections to true. It is always better to leave garbage as garbage than to fabricate plausible-sounding content for a professional report. Only rewrite what you're genuinely confident about.

Return ONLY valid JSON, no other text: {"cleaned": string, "hasUncertainSections": boolean}`;

let cleanupSuggestion = null;
let cleanupOriginalText = null;

async function suggestTranscriptCleanup() {
  if (!currentTranscript.trim()) return;
  const btn = document.getElementById('cleanupSuggestBtn');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
  cleanupOriginalText = currentTranscript;

  try {
    const res = await fetch('https://korva.byronguyatt2.workers.dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        // Bumped alongside processTranscript()'s limit (see the matching
        // comment there) - a long continuous dictation's cleaned-up
        // transcript plus JSON wrapper can get close to the old ceiling too.
        max_tokens: 2500,
        system: TRANSCRIPT_CLEANUP_PROMPT,
        messages: [{ role: 'user', content: currentTranscript }]
      })
    });
    const rawBody = await res.text();
    let data;
    try { data = JSON.parse(rawBody); }
    catch { throw new Error(`HTTP ${res.status}: ${rawBody.slice(0, 200) || '(empty response)'}`); }
    if (!res.ok || data.error) {
      const errMsg = data.error?.message || data.error?.type || `HTTP ${res.status}`;
      throw new Error('API error: ' + errMsg);
    }
    if (data.stop_reason === 'max_tokens') {
      throw new Error('AI response was cut off (transcript too long for the response limit)');
    }
    const text = data.content.map(i => i.text || '').join('');
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!parsed || typeof parsed.cleaned !== 'string') throw new Error('Unexpected response shape');
    cleanupSuggestion = parsed;
    showCleanupSuggestion(parsed);
  } catch (err) {
    const reason = ((err && err.message) ? String(err.message) : 'unknown error').slice(0, 140);
    showToast('AI cleanup unavailable: ' + reason, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

function showCleanupSuggestion(suggestion) {
  const panel = document.getElementById('cleanupPanel');
  const textEl = document.getElementById('cleanupPanelText');
  const noteEl = document.getElementById('cleanupPanelNote');
  if (!panel || !textEl) return;
  textEl.textContent = suggestion.cleaned;
  if (noteEl) noteEl.style.display = suggestion.hasUncertainSections ? 'block' : 'none';
  panel.style.display = 'block';
}

function applyCleanupSuggestion() {
  if (!cleanupSuggestion) return;
  // If the transcript changed since this suggestion was generated (the
  // inspector kept editing, or started a new recording), the suggestion no
  // longer matches what's in the box - dismiss rather than silently
  // overwrite edits the inspector made in the meantime.
  if (currentTranscript !== cleanupOriginalText) {
    showToast('Transcript changed since this suggestion was made — dismissed rather than risk overwriting your edits', 'error');
    dismissCleanupSuggestion();
    return;
  }
  currentTranscript = cleanupSuggestion.cleaned;
  const box = document.getElementById('transcriptBox');
  if (box) {
    box.textContent = currentTranscript;
    box.classList.add('active');
  }
  showToast('Cleanup applied — review before extracting', 'success');
  dismissCleanupSuggestion();
}

function dismissCleanupSuggestion() {
  cleanupSuggestion = null;
  cleanupOriginalText = null;
  const panel = document.getElementById('cleanupPanel');
  if (panel) panel.style.display = 'none';
}

// TEMP DEBUG — see matching comment near #confDebugLine in the HTML.
function resetConfDebug() {
  confDebugLog = [];
  const el = document.getElementById('confDebugLine');
  if (el) el.textContent = '';
}

// ── EXPERIMENTAL AUDIO CAPTURE / SERVER-SIDE TRANSCRIPTION ─────────────────
// See the long comment at the state declarations above for why this is
// opt-in and defaults off. Everything below is written so that if any part
// of it fails — unsupported browser, mic busy, network error, the Worker
// endpoint not existing yet — the technician sees nothing different at all:
// the existing Web Speech transcript is already complete and usable by the
// time any of this would matter.

function toggleAudioCaptureSetting() {
  audioCaptureEnabled = !audioCaptureEnabled;
  const btn = document.getElementById('toggleAudioCapture');
  if (btn) btn.classList.toggle('on', audioCaptureEnabled);
  try { localStorage.setItem('korva_audio_capture_enabled', audioCaptureEnabled ? '1' : '0'); } catch (e) {}
  // Re-arm the self-disable guard whenever the technician deliberately
  // turns this back on, so a failure from a much earlier session (or a
  // since-fixed bug) doesn't permanently lock the toggle into a no-op.
  if (audioCaptureEnabled) audioCaptureFailedThisSession = false;
}

function restoreAudioCaptureSetting() {
  try {
    audioCaptureEnabled = localStorage.getItem('korva_audio_capture_enabled') === '1';
    const btn = document.getElementById('toggleAudioCapture');
    if (btn) btn.classList.toggle('on', audioCaptureEnabled);
  } catch (e) {}
}

function isAudioCaptureSupported() {
  if (audioCaptureSupportCache !== null) return audioCaptureSupportCache;
  audioCaptureSupportCache = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function' && typeof window.MediaRecorder === 'function');
  return audioCaptureSupportCache;
}

function pickAudioMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  // audio/mp4 first: that's what iOS Safari (the primary target device for
  // this app) actually supports and records in — webm/ogg are Chrome/Firefox
  // formats Safari's MediaRecorder doesn't produce.
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return ''; // let the browser pick its own default rather than fail outright
}

function stopAudioCaptureTracks() {
  if (audioCaptureStream) {
    try { audioCaptureStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  }
  audioCaptureStream = null;
}

// Starts a SECOND, independent mic capture purely for the experimental
// higher-accuracy path — called from startRecording() only when the opt-in
// setting is on. Every failure path here is silent (console.warn only): the
// primary Web Speech transcript already has its own separate mic access via
// recognition.start() and is unaffected either way.
async function startAudioCapture() {
  audioRecordedChunks = [];
  if (!audioCaptureEnabled || audioCaptureFailedThisSession || !isAudioCaptureSupported()) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCaptureStream = stream;
    const mimeType = pickAudioMimeType();
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioRecordedChunks.push(e.data);
    };
    mediaRecorder.onerror = (e) => {
      // If the recorder itself throws mid-session, don't keep trying on
      // every future recording this session — something about this
      // device/combination isn't working, and the dictation feature it
      // runs alongside must never be put at risk chasing it.
      console.warn('Audio capture error — disabling experimental audio transcription for the rest of this session:', e && e.error);
      audioCaptureFailedThisSession = true;
      stopAudioCaptureTracks();
    };
    mediaRecorder.start();
  } catch (err) {
    console.warn('Audio capture unavailable this recording (speech-recognition transcript is unaffected):', err && err.message);
    mediaRecorder = null;
    audioCaptureStream = null;
  }
}

// Stops the parallel recording (if any) and resolves with a Blob once the
// recorder has actually flushed its last chunk, or null if nothing was
// captured / capture wasn't running. Never rejects.
function stopAudioCapture() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      stopAudioCaptureTracks();
      resolve(null);
      return;
    }
    const recorder = mediaRecorder;
    const mimeType = recorder.mimeType || 'audio/webm';
    recorder.onstop = () => {
      stopAudioCaptureTracks();
      const chunks = audioRecordedChunks;
      audioRecordedChunks = [];
      resolve(chunks.length ? new Blob(chunks, { type: mimeType }) : null);
    };
    try { recorder.stop(); } catch (e) { stopAudioCaptureTracks(); resolve(null); }
    mediaRecorder = null;
  });
}

// Vocabulary hint sent to the transcription backend (Whisper's
// initial_prompt biases recognition toward words it's given, without
// forcing them). Reads from the same brand/genus lists the client-side
// safety net above uses, rather than duplicating them, so the two stay in
// sync automatically as that vocabulary grows.
function buildTranscriptionVocabHint() {
  return 'Australian termite and pest inspection terms: ' +
    [...KORVUS_BRAND_VOCAB, ...KORVUS_GENUS_VOCAB].join(', ') +
    ', bearer, subfloor, weep holes, shrubbery, conducive conditions, slab edge, Kordon.';
}

// Uploads the captured audio to the Worker's transcription endpoint and, on
// a clean result, offers it as a suggestion — the same suggest-and-confirm
// pattern as AI cleanup above, for the same reason: this has never run in
// real field conditions, and silently swapping out a transcript the
// technician can already see and trust is a bigger risk than a wording fix.
// On ANY failure (network error, non-2xx, Worker AI error, bad
// response shape) this fails completely silently — console.warn only — so
// the Web Speech transcript already in the box remains exactly as if this
// feature didn't exist.
//
// Served by the Worker's /transcribe route (worker/worker.js, v7+), which
// expects multipart `audio` + optional `initial_prompt` and returns
// { transcript }.
async function tryServerSideTranscription(blob) {
  if (!blob) return;
  try {
    const formData = new FormData();
    const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    formData.append('audio', blob, `recording.${ext}`);
    formData.append('initial_prompt', buildTranscriptionVocabHint());
    const res = await fetch(`${KORVA_WORKER_URL}/transcribe`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + getAuthToken() },
      body: formData,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || typeof data.transcript !== 'string' || !data.transcript.trim()) throw new Error('Unexpected response shape');
    showServerTranscriptionSuggestion(data.transcript.trim());
  } catch (err) {
    console.warn('Server-side transcription unavailable this recording — keeping the on-device transcript:', err && err.message);
  }
}

function showServerTranscriptionSuggestion(transcript) {
  // Guard against a slow response landing after the technician already
  // moved on (extracted, started a new recording, navigated away) — only
  // show it if we're still looking at the same transcript this capture
  // started with.
  if (currentTranscript !== serverTranscriptOriginalText) return;
  serverTranscriptSuggestion = transcript;
  const panel = document.getElementById('serverTranscriptPanel');
  const textEl = document.getElementById('serverTranscriptPanelText');
  if (!panel || !textEl) return;
  textEl.textContent = transcript;
  panel.style.display = 'block';
}

function applyServerTranscript() {
  if (!serverTranscriptSuggestion) return;
  if (currentTranscript !== serverTranscriptOriginalText) {
    showToast('Transcript changed since this alternate version was generated — dismissed rather than risk overwriting your edits', 'error');
    dismissServerTranscript();
    return;
  }
  currentTranscript = serverTranscriptSuggestion;
  const box = document.getElementById('transcriptBox');
  if (box) { box.textContent = currentTranscript; box.classList.add('active'); }
  showToast('Switched to the server transcription — review before extracting', 'success');
  dismissServerTranscript();
}

function dismissServerTranscript() {
  serverTranscriptSuggestion = null;
  serverTranscriptOriginalText = null;
  const panel = document.getElementById('serverTranscriptPanel');
  if (panel) panel.style.display = 'none';
}

function startRecording() {
  const SR = getSpeechRecognitionCtor();
  if (!SR) { showToast('Speech recognition not supported — tap the transcript box to type instead', 'error'); return; }

  lowConfidenceFlagged = false;
  const warnEl0 = document.getElementById('lowConfidenceWarning');
  if (warnEl0) warnEl0.classList.remove('show');
  resetConfDebug();
  dismissCleanupSuggestion();
  dismissServerTranscript();

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-AU';

  // Safari re-delivers results it has already finalised (the same index
  // comes back as final again, or the same phrase arrives as a fresh final
  // result a moment later), which doubled phrases like "Wall construction
  // Wall construction". Commit each result index once, and drop a final
  // chunk that exactly repeats the one just committed.
  let committedUpTo = -1;
  let lastFinalText = '';
  let lastFinalAt = 0;

  recognition.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        if (i <= committedUpTo) continue;
        committedUpTo = i;
        const rawChunk = e.results[i][0].transcript.trim();
        const now = Date.now();
        if (rawChunk.toLowerCase() === lastFinalText && now - lastFinalAt < 3000) continue;
        lastFinalText = rawChunk.toLowerCase();
        lastFinalAt = now;
        let finalChunk = e.results[i][0].transcript;
        // Some platforms never populate confidence (comes back as exactly
        // 0 or undefined) - treat that as "unknown", not "low", so this
        // doesn't false-flag every result on devices that don't support it.
        const conf = e.results[i][0].confidence;
        if (typeof conf === 'number' && conf > 0 && conf < 0.6) {
          lowConfidenceFlagged = true;
        }
        // TEMP DEBUG — see matching comment near #confDebugLine in the HTML.
        confDebugLog.push(typeof conf === 'number' ? conf.toFixed(2) : String(conf));
        if (confDebugLog.length > 8) confDebugLog.shift();
        const confEl = document.getElementById('confDebugLine');
        if (confEl) confEl.textContent = 'DEBUG conf: ' + confDebugLog.join(', ');

        finalChunk = correctKnownMishearings(finalChunk);
        finalChunk = applyVocabSafetyNet(finalChunk);
        final += finalChunk + ' ';
      }
      else interim += e.results[i][0].transcript;
    }
    currentTranscript += final;
    const box = document.getElementById('transcriptBox');
    box.textContent = currentTranscript + interim;
    box.classList.add('active');
    const warnEl = document.getElementById('lowConfidenceWarning');
    if (warnEl) warnEl.classList.toggle('show', lowConfidenceFlagged);
  };

  recognition.onerror = (e) => {
    // FIX: this used to silently discard the error entirely, so when
    // recognition failed or produced garbage there was no way to tell
    // whether it was a network drop, a mic/permission problem, no speech
    // detected, or something else — every failure looked identical from
    // the outside. Surface the actual reason (console + toast) so a bad
    // field test can actually be diagnosed instead of guessed at.
    const reason = (e && e.error) ? e.error : 'unknown';
    console.warn('Speech recognition error:', reason);
    const messages = {
      'network': 'Lost connection to the speech service — recording stopped. Dictation needs a working internet connection; try again somewhere with better signal.',
      'no-speech': 'No speech detected — recording stopped.',
      'audio-capture': 'Microphone not available — check mic permission and that no other app is using it.',
      'not-allowed': 'Microphone permission denied — enable it in your browser/device settings.',
      'service-not-allowed': 'Speech service not allowed — check your browser/device permissions.',
      'language-not-supported': 'This device doesn\'t support en-AU speech recognition.',
    };
    showToast(messages[reason] || `Speech recognition stopped (${reason})`, 'error');
    stopRecording();
  };
  recognition.start();
  isRecording = true;
  document.getElementById('voiceBtn').classList.add('recording');
  document.getElementById('voiceBtnText').textContent = 'Recording… Tap to Stop';
  document.getElementById('waveform').classList.add('show');
  document.getElementById('extractBtn').disabled = true;

  // EXPERIMENTAL, opt-in (see the state-declaration comment above) — started
  // AFTER recognition.start() so the primary, working dictation path is
  // already underway before this second, unproven mic consumer gets
  // involved at all. Fire-and-forget: startAudioCapture() handles its own
  // errors internally and never throws.
  startAudioCapture();
}

// Resolves once recognition has delivered its last result. Web Speech
// sends the final phrase in onresult AFTER stop(), so anything that reads
// currentTranscript right after stopping misses it. Falls back after 2s in
// case onend never fires (e.g. stop() after an error already ended it).
function waitForRecognitionEnd(rec) {
  if (!rec) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 2000);
    rec.onend = () => { clearTimeout(timer); resolve(); };
  });
}

function stopRecording() {
  const recognitionEnded = waitForRecognitionEnd(recognition);
  if (recognition) recognition.stop();
  isRecording = false;
  document.getElementById('voiceBtn').classList.remove('recording');
  document.getElementById('voiceBtnText').textContent = 'Tap to Speak';
  document.getElementById('waveform').classList.remove('show');
  if (currentTranscript.trim()) document.getElementById('extractBtn').disabled = false;
  recognitionEnded.then(() => {
    if (!isRecording && currentTranscript.trim()) document.getElementById('extractBtn').disabled = false;
  });

  // EXPERIMENTAL, opt-in — everything above this point has already
  // completed exactly as it always has, regardless of what happens below.
  // This resolves in the background and, on a clean result, offers it as a
  // suggestion (see tryServerSideTranscription). Any failure is silent.
  // The snapshot that showServerTranscriptionSuggestion() compares against
  // is taken only after the last phrase has landed - taken earlier, that
  // late phrase made the transcript "changed" and the suggestion was
  // silently dropped.
  if (audioCaptureEnabled && !audioCaptureFailedThisSession) {
    Promise.all([stopAudioCapture(), recognitionEnded]).then(([blob]) => {
      serverTranscriptOriginalText = currentTranscript;
      tryServerSideTranscription(blob);
    });
  } else {
    stopAudioCaptureTracks();
  }
}

// ── MANUAL TRANSCRIPT EDITING ────────────────────────────────────────────
// The transcript box is editable directly (not just filled by voice), so
// extraction can be tested or used without a working microphone, and so a
// technician can quickly fix a mis-heard word or type in a noisy/quiet
// environment instead of speaking.
function clearTranscriptPlaceholderIfNeeded(el) {
  if (!el.classList.contains('active')) el.textContent = '';
}

function onTranscriptEdited(el) {
  currentTranscript = el.textContent;
  const hasText = currentTranscript.trim().length > 0;
  el.classList.toggle('active', hasText);
  const extractBtn = document.getElementById('extractBtn');
  if (extractBtn) extractBtn.disabled = !hasText;
}

function usePrompt(el) {
  // Make sure the popover is in default (extraction) mode, not notes-dictation mode
  if (activeNotesTargetKey) resetVoicePopoverToDefault();

  const popover = document.getElementById('voicePopover');
  const fab = document.getElementById('micFab');
  if (!popover.classList.contains('open')) {
    popover.classList.add('open');
    fab.classList.add('open');
  }

  currentTranscript = el.dataset.prompt;
  const box = document.getElementById('transcriptBox');
  box.textContent = currentTranscript;
  box.classList.add('active');
  document.getElementById('extractBtn').disabled = false;
}

// ══════════════════════════════════════════════════════════════════════════
// HANDS-FREE MODE
// ══════════════════════════════════════════════════════════════════════════
let handsFreeMode    = false;
let hfRecognition    = null;
let hfAwake          = false;
let hfSilenceTimer   = null;
let hfSessionText    = '';
let hfExtracting     = false;    // true while Claude API call is in flight

const HF_WAKE_WORDS  = [
  // Correct
  'hey korvus','hi korvus','okay korvus','ok korvus','korvus',
  // Common misrecognitions of "Korva"
  'hey korvus','hi korvus','hey cobra','hi cobra',
  'hey corner','hi corner','hey karma','hi karma',
  'hey carver','hi carver','hey corva','hi corva',
  'hey corba','hi corba','hey cova','hi cova',
  'hey kurva','hi kurva','hey curva','hi curva',
  'okay cover','ok cover','okay cobra','ok cobra',
];
const HF_STOP_WORDS  = ['stop korvus','pause korvus','stop listening','done korvus'];
const HF_SILENCE_MS  = 2200;

const HF_SECTION_KEYWORDS = {
  property:        ['property','property details','structure type','building details','property section'],
  obstructions:    ['obstructions','obstruction','areas not inspected','obstructed','hindered'],
  restrictions:    ['restrictions','restriction','restricted access','restricted areas'],
  findings:        ['findings','finding','termite activity','termites','species','timber pest'],
  conducive:       ['conducive','conducive conditions','moisture','water leak','timber to soil'],
  recommendations: ['recommendations','recommendation','treatment','susceptibility','risk level'],
  photos:          ['photos','photo section'],
  signoff:         ['sign off','signoff','signature'],
};

const HF_SECTION_NAMES = {
  property:'property details', obstructions:'obstructions', restrictions:'restrictions',
  findings:'findings', conducive:'conducive conditions', recommendations:'recommendations',
  photos:'photos', signoff:'sign off',
};

// ── Soft audio tone (replaces TTS for wake response — avoids mic conflict) ──
function hfPlayTone(freq = 880, duration = 120, vol = 0.3) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration/1000);
    osc.start(); osc.stop(ctx.currentTime + duration/1000);
    setTimeout(() => ctx.close(), duration + 100);
  } catch(e) {}
}

// ── TTS — only used AFTER extraction, never during listening ────────────
function korvaSpeak(text, onDone) {
  if (!window.speechSynthesis) { onDone && onDone(); return; }
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'en-AU'; utt.rate = 1.15; utt.pitch = 1.0;
  const voices = window.speechSynthesis.getVoices();
  const v = voices.find(v => v.lang.startsWith('en-AU')) || voices.find(v => v.lang.startsWith('en-'));
  if (v) utt.voice = v;
  utt.onend  = () => { onDone && onDone(); };
  utt.onerror = () => { onDone && onDone(); };
  window.speechSynthesis.speak(utt);
}

// ── Status display ───────────────────────────────────────────────────────
function hfSetStatus(state, text) {
  const dot = document.getElementById('hfStatusDot');
  const txt = document.getElementById('hfStatusText');
  if (dot) dot.className = 'hf-status-dot ' + (state || '');
  if (txt) txt.textContent = text;
}

// ── Section routing ──────────────────────────────────────────────────────
function hfDetectSection(text) {
  for (const [section, keywords] of Object.entries(HF_SECTION_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) return section;
  }
  return null;
}

function getCurrentSectionId() {
  const visible = document.querySelector('.report-section:not([style*="display: none"])');
  return visible ? visible.id.replace('section-', '') : null;
}

// ── Core: single persistent recognition session ──────────────────────────
function hfStartListening() {
  if (!handsFreeMode) return;
  const SR = getSpeechRecognitionCtor();
  if (!SR) {
    showToast('Speech recognition not supported on this browser', 'error');
    handsFreeMode = false; hfUpdateUI(); return;
  }

  // Clean up any existing session first
  if (hfRecognition) {
    try { hfRecognition.onend = null; hfRecognition.abort(); } catch(e) {}
    hfRecognition = null;
  }

  const rec = new SR();
  rec.continuous      = true;
  rec.interimResults  = true;
  rec.lang            = 'en-AU';
  rec.maxAlternatives = 1;
  hfRecognition = rec;

  let interimBuffer = '';
  let hfWatchdog     = null; // native-only: forces a "final" on a speech pause (see below)
  let lastInterim    = '';

  rec.onresult = (e) => {
    if (hfExtracting) return; // ignore input while Claude is processing

    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const text   = result[0].transcript.toLowerCase().trim();

      if (result.isFinal) {
        interimBuffer = '';
        clearTimeout(hfWatchdog);
        lastInterim = '';

        // ── Stop words ──
        if (HF_STOP_WORDS.some(w => text.includes(w))) {
          hfDeactivate(true);
          return;
        }

        if (!hfAwake) {
          // ── Wake word detection ──
          if (HF_WAKE_WORDS.some(w => text.includes(w))) {
            hfAwake = true;
            hfSessionText = '';
            // Strip wake word from any trailing content
            let afterWake = result[0].transcript;
            HF_WAKE_WORDS.forEach(w => {
              afterWake = afterWake.replace(new RegExp(w, 'gi'), '').trim();
            });
            // Two-tone confirmation beep
            hfPlayTone(660, 80, 0.25);
            setTimeout(() => hfPlayTone(880, 100, 0.25), 110);
            hfSetStatus('active', 'Listening — speak your details…');
            document.getElementById('waveform').classList.add('show');
            if (afterWake.length > 3) {
              hfSessionText = afterWake + ' ';
              hfResetSilenceTimer();
            }
          }
          return; // not awake yet — ignore all other speech
        }

        // ── Section navigation ──
        const detectedSection = hfDetectSection(text);
        if (detectedSection) {
          showSection(detectedSection);
          // Strip the section keyword from the session text to avoid confusing the AI
          let stripped = result[0].transcript;
          Object.values(HF_SECTION_KEYWORDS).flat().forEach(kw => {
            stripped = stripped.replace(new RegExp(kw, 'gi'), '').trim();
          });
          if (stripped.length > 3) {
            hfSessionText += stripped + ' ';
          }
        } else {
          hfSessionText += result[0].transcript + ' ';
        }

        // Update live transcript
        hfUpdateTranscriptDisplay();
        hfResetSilenceTimer();

      } else {
        // Interim — show live preview. On native (Capacitor) platforms the
        // recognizer only ever emits ONE final, right when we call
        // rec.stop() — unlike the browser's Web Speech API, which fires a
        // fresh "final" every time you pause. Without that, "Hey Korvus"
        // (and everything said after it) would sit forever as an interim
        // preview and never actually commit or trigger extraction. This
        // watchdog recreates that pause-based segmentation ourselves: if
        // the live transcript stops growing for a beat, stop the session
        // (which yields a final) and let onend restart a fresh one.
        interim = result[0].transcript;
        if (interim !== lastInterim) {
          lastInterim = interim;
          clearTimeout(hfWatchdog);
          hfWatchdog = setTimeout(() => { try { rec.stop(); } catch(e) {} }, 1200);
        }
      }
    }

    // Show interim text live
    if (hfAwake && interim) {
      const box = document.getElementById('transcriptBox');
      if (box) box.textContent = (hfSessionText + interim).trim();
    }
  };

  rec.onerror = (e) => {
    if (e.error === 'no-speech') return; // expected — ignore
    if (e.error === 'not-allowed') {
      showToast('Microphone permission denied — enable in browser settings', 'error');
      handsFreeMode = false; hfUpdateUI(); return;
    }
    // For other errors, restart after a short delay
    if (handsFreeMode) setTimeout(() => hfStartListening(), 500);
  };

  rec.onend = () => {
    // Auto-restart unless we intentionally stopped or are extracting
    if (handsFreeMode && !hfExtracting) {
      setTimeout(() => hfStartListening(), 250);
    }
  };

  hfSetStatus('listening', 'Listening for "Hey Korvus"…');
  try { rec.start(); } catch(e) {
    setTimeout(() => hfStartListening(), 500);
  }
}

function hfResetSilenceTimer() {
  clearTimeout(hfSilenceTimer);
  if (hfSessionText.trim().length > 10) {
    hfSilenceTimer = setTimeout(() => hfAutoExtract(), HF_SILENCE_MS);
  }
}

function hfUpdateTranscriptDisplay() {
  const box = document.getElementById('transcriptBox');
  if (box) {
    box.textContent = hfSessionText.trim();
    box.classList.toggle('active', !!hfSessionText.trim());
  }
}

// ── Auto-extract on silence ──────────────────────────────────────────────
async function hfAutoExtract() {
  const text = hfSessionText.trim();
  if (!text || text.length < 8 || hfExtracting) return;

  hfExtracting   = true;
  hfSessionText  = '';
  hfAwake        = false; // reset — require "Hey Korvus" again after each extract
  clearTimeout(hfSilenceTimer);
  document.getElementById('waveform').classList.remove('show');
  hfSetStatus('processing', 'Extracting with AI…');

  // Single low beep to signal extraction starting
  hfPlayTone(440, 100, 0.2);

  currentTranscript = text;
  document.getElementById('extractBtn').disabled = false;

  try {
    await processTranscript();
    await new Promise(r => setTimeout(r, 500));

    // Check for auto-advance
    const sectionOrder = ['property','obstructions','restrictions','findings','conducive','recommendations','photos','signoff'];    const currentSection = getCurrentSectionId();
    const cfg = currentSection && SECTIONS[currentSection];
    let advanced = false;

    if (cfg) {
      const filled = cfg.fields.filter(k => reportData[k] !== undefined && reportData[k] !== null).length;
      const idx = sectionOrder.indexOf(currentSection);
      if (filled >= cfg.total && idx >= 0 && idx < sectionOrder.length - 1) {
        const nextSection = sectionOrder[idx + 1];
        showSection(nextSection);
        advanced = true;
        hfSetStatus('listening', 'Listening for "Hey Korvus"…');
        // Double beep = section complete, advanced
        hfPlayTone(660, 80, 0.25);
        setTimeout(() => hfPlayTone(880, 120, 0.3), 110);
        korvaSpeak(`Got it. Moving to ${HF_SECTION_NAMES[nextSection]}.`);
      }
    }

    if (!advanced) {
      // Single confirmation beep = fields filled, same section
      hfPlayTone(660, 100, 0.25);
      hfSetStatus('listening', 'Listening for "Hey Korvus"…');
    }

  } catch(e) {
    hfSetStatus('listening', 'Listening for "Hey Korvus"…');
  } finally {
    hfExtracting = false;
  }
}

// ── Toggle ───────────────────────────────────────────────────────────────
function toggleHandsFreeMode() {
  handsFreeMode = !handsFreeMode;
  hfUpdateUI();
  if (handsFreeMode) {
    hfAwake = false; hfSessionText = ''; hfExtracting = false;
    const popover = document.getElementById('voicePopover');
    const fab = document.getElementById('micFab');
    if (!popover.classList.contains('open')) {
      popover.classList.add('open'); fab.classList.add('open');
    }
    hfStartListening();
  } else {
    hfDeactivate(false);
    window.speechSynthesis && window.speechSynthesis.cancel();
  }
}

function hfDeactivate(sayGoodbye = false) {
  clearTimeout(hfSilenceTimer);
  hfAwake = false; hfExtracting = false; hfSessionText = '';
  if (hfRecognition) {
    try { hfRecognition.onend = null; hfRecognition.abort(); } catch(e) {}
    hfRecognition = null;
  }
  document.getElementById('waveform').classList.remove('show');
  hfSetStatus('', 'Hands-free off');
  if (sayGoodbye) {
    handsFreeMode = false;
    hfUpdateUI();
    hfPlayTone(440, 200, 0.2);
  }
}

function hfUpdateUI() {
  const toggle = document.getElementById('handsFreeToggle');
  const status = document.getElementById('hfStatus');
  const fab    = document.getElementById('micFab');
  if (toggle) toggle.classList.toggle('on', handsFreeMode);
  if (status) status.style.display = handsFreeMode ? 'flex' : 'none';
  const voiceBtn = document.getElementById('voiceBtn');
  if (voiceBtn) voiceBtn.style.opacity = handsFreeMode ? '0.4' : '1';
  // Show HF active state on the FAB
  if (fab) {
    fab.title = handsFreeMode ? 'Hands-free ON — say "Hey Korvus"' : 'Tap to speak';
    fab.style.boxShadow = handsFreeMode
      ? '0 0 0 3px rgba(var(--accent-rgb),0.4), 0 8px 24px rgba(var(--accent-rgb),0.3)'
      : '';
  }
}
let pendingSpeciesMatch = null; // holds the confirmed species match to apply

function triggerSpeciesIntelligence(rawSpeciesValue) {
  const match = lookupSpecies(rawSpeciesValue);
  if (!match) return;

  pendingSpeciesMatch = match;

  // Show confirmation prompt
  const confirm = document.getElementById('speciesConfirm');
  const confirmName = document.getElementById('speciesConfirmName');
  if (confirm && confirmName) {
    confirmName.textContent = match.name;
    confirm.style.display = 'block';
    confirm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function confirmSpecies() {
  if (!pendingSpeciesMatch) return;

  const { name, data } = pendingSpeciesMatch;

  // Pre-fill related fields where appropriate
  const prefills = {};
  if (data.riskLevel && !reportData.riskLevel) prefills.riskLevel = data.riskLevel;
  if (data.treatmentRecommended && !reportData.treatmentRecommended) prefills.treatmentRecommended = data.treatmentRecommended;
  if (data.inspectionFrequency && !reportData.inspectionFrequency) prefills.inspectionFrequency = data.inspectionFrequency;
  if (data.treatmentOptions && data.treatmentOptions.length > 0 && !reportData.treatmentType) {
    prefills.treatmentType = data.treatmentOptions[0].product + ' — ' + data.treatmentOptions[0].type;
  }

  Object.entries(prefills).forEach(([key, val]) => {
    const el = document.getElementById('f-' + key);
    if (el) {
      renderField(el, key, val);
      reportData[key] = val;
    }
  });

  if (Object.keys(prefills).length > 0) {
    updateProgress();
    saveDraft();
  }

  // Hide confirm, show intelligence panel
  document.getElementById('speciesConfirm').style.display = 'none';
  showSpeciesIntel(name, data, prefills);

  pendingSpeciesMatch = null;
}

function dismissSpeciesConfirm() {
  document.getElementById('speciesConfirm').style.display = 'none';
  pendingSpeciesMatch = null;
}

function closeSpeciesIntel() {
  document.getElementById('speciesIntel').style.display = 'none';
}

function showSpeciesIntel(name, data, prefills = {}) {
  const panel = document.getElementById('speciesIntel');
  const title = document.getElementById('speciesIntelName');
  const body = document.getElementById('speciesIntelBody');
  if (!panel || !body) return;

  title.textContent = name + (data.commonName ? ' — ' + data.commonName : '');
  body.innerHTML = buildSpeciesIntelHTML(data, prefills);
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function buildSpeciesIntelHTML(data, prefills) {
  let html = '';

  // On-site field identification — rendered first, most useful in the moment
  if (data.fieldID && data.fieldID.length > 0) {
    html += `<div class="intel-section intel-section-field-id">
      <div class="intel-section-title">🔍 On Site — What to Look For</div>
      <div class="intel-list">`;
    data.fieldID.forEach(item => {
      html += `<div class="intel-item intel-field-id-item">${item}</div>`;
    });
    html += `</div></div>`;
  }

  // Special flags (warnings, danger notices)
  if (data.specialFlags && data.specialFlags.length > 0) {
    data.specialFlags.forEach(flag => {
      html += `
        <div class="species-flag ${flag.type}">
          <span class="species-flag-icon">${flag.icon}</span>
          <span class="species-flag-text">${flag.text}</span>
        </div>`;
    });
  }

  // Destruction rate / significance
  if (data.destructionRate) {
    html += `<div class="intel-section">
      <div class="intel-section-title">Significance</div>
      <div class="intel-item">${data.destructionRate}</div>
    </div>`;
  }

  // Identification markers
  if (data.identification && data.identification.length > 0) {
    html += `<div class="intel-section">
      <div class="intel-section-title">Identification</div>
      <div class="intel-list">`;
    data.identification.forEach(item => {
      html += `<div class="intel-item">${item}</div>`;
    });
    html += `</div></div>`;
  }

  // Nest locations
  if (data.nestTypes && data.nestTypes.length > 0) {
    html += `<div class="intel-section">
      <div class="intel-section-title">Nest Locations</div>
      <div class="intel-list">`;
    data.nestTypes.forEach(item => {
      html += `<div class="intel-item">${item}</div>`;
    });
    html += `</div></div>`;
  }

  // Behaviour
  if (data.behaviour && data.behaviour.length > 0) {
    html += `<div class="intel-section">
      <div class="intel-section-title">Behaviour</div>
      <div class="intel-list">`;
    data.behaviour.forEach(item => {
      html += `<div class="intel-item">${item}</div>`;
    });
    html += `</div></div>`;
  }

  // Treatment options
  if (data.treatmentOptions && data.treatmentOptions.length > 0) {
    html += `<div class="intel-section">
      <div class="intel-section-title">Treatment Options</div>
      <div class="intel-treatments">`;
    data.treatmentOptions.forEach(opt => {
      html += `<div class="intel-treatment">
        <div class="intel-treatment-header">
          <span class="intel-treatment-product">${opt.product}</span>
          <span class="intel-treatment-type">${opt.type}</span>
        </div>
        <div class="intel-treatment-notes">${opt.notes}</div>
        <div class="intel-treatment-toxicity">Toxicity: ${opt.toxicity}</div>
      </div>`;
    });
    html += `</div></div>`;
  }

  // What was pre-filled
  const prefilledKeys = Object.keys(prefills);
  if (prefilledKeys.length > 0) {
    const labels = {
      riskLevel: 'Risk Level', treatmentRecommended: 'Treatment Recommended',
      treatmentType: 'Treatment Type', inspectionFrequency: 'Re-inspection Frequency'
    };
    const filled = prefilledKeys.map(k => labels[k] || k).join(', ');
    html += `<div class="intel-prefilled">
      <svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
      Pre-filled in Recommendations tab: ${filled} — review and adjust there as needed
    </div>`;
  }

  // Field note prompts
  if (data.fieldNotePrompts && data.fieldNotePrompts.length > 0) {
    html += `<div class="intel-section">
      <div class="intel-section-title">Field Note Prompts</div>
      <div class="intel-prompts">`;
    data.fieldNotePrompts.forEach(prompt => {
      html += `<div class="intel-prompt-item">${prompt}</div>`;
    });
    html += `</div></div>`;
  }

  return html;
}

// ── AI EXTRACTION ─────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// OFFLINE FALLBACK EXTRACTION ENGINE
// Runs when the API is unreachable — pattern matching against the most
// common Australian inspection phrases. Catches ~65% of typical dictation.
// ══════════════════════════════════════════════════════════════════════════

function offlineExtract(transcript) {
  const t = transcript.toLowerCase();
  const result = {};

  // ── PROPERTY DETAILS ──────────────────────────────────────────────────
  const structureTypes = [
    [/detached\s+house|standalone\s+house|separate\s+house/,      'Detached house'],
    [/semi.detached|semi\s+detached/,                              'Semi-detached'],
    [/terrace|townhouse|town\s+house/,                             'Terrace / townhouse'],
    [/duplex/,                                                     'Duplex'],
    // FIX: "granny flat" contains the substring "flat", so it was always
    // matched by the generic Unit/apartment check below first (loop breaks
    // on first match) and 'Granny flat' could never actually be reported -
    // the more specific pattern has to be checked first.
    [/granny\s+flat|secondary\s+dwelling/,                         'Granny flat'],
    [/unit|apartment|flat/,                                        'Unit / apartment'],
    [/commercial|warehouse|industrial/,                            'Commercial building'],
  ];
  for (const [rx, val] of structureTypes) { if (rx.test(t)) { result.structureType = val; break; } }

  const wallTypes = [
    [/brick\s+veneer/,                         'Brick veneer'],
    [/double\s+brick|solid\s+brick/,           'Double brick'],
    [/weatherboard|timber\s+clad/,             'Weatherboard'],
    [/fibro|fibre\s+cement|cement\s+sheet/,    'Fibro / cement sheet'],
    [/rendered|render/,                        'Rendered masonry'],
    [/lightweight|colorbond\s+wall|metal\s+clad/, 'Lightweight cladding'],
  ];
  for (const [rx, val] of wallTypes) { if (rx.test(t)) { result.wallConstruction = val; break; } }

  const floorTypes = [
    // FIX: "combination slab and timber floor" contains the substring
    // "timber floor", so it was always matched by that check below first
    // and 'Combination slab / timber' could never actually be reported -
    // the more specific pattern has to be checked first.
    [/combination|combo\s+slab/,                              'Combination slab / timber'],
    [/concrete\s+slab|slab\s+on\s+ground|slab\s+foundation/, 'Concrete slab on ground'],
    [/timber\s+suspended|suspended\s+timber|timber\s+floor/,  'Timber suspended floor'],
    [/elevated\s+timber|stumps|on\s+stumps/,                  'Elevated timber (stumps)'],
  ];
  for (const [rx, val] of floorTypes) { if (rx.test(t)) { result.floorType = val; break; } }

  const roofTypes = [
    [/colorbond|metal\s+roof|steel\s+roof/,        'Colorbond metal'],
    [/concrete\s+tile|monier/,                     'Tiled — concrete'],
    [/terracotta\s+tile|terra\s+cotta/,            'Tiled — terracotta'],
    [/corrugated\s+iron|galv/,                     'Corrugated iron'],
    [/flat\s+roof|membrane/,                       'Flat membrane'],
  ];
  for (const [rx, val] of roofTypes) { if (rx.test(t)) { result.roofType = val; break; } }

  if (/double\s+storey|two\s+stor/i.test(t))       result.height = 'Double storey';
  else if (/single\s+storey|one\s+stor/i.test(t))  result.height = 'Single storey';
  else if (/split\s+level/i.test(t))               result.height = 'Split level';
  else if (/three\s+stor|multi.stor/i.test(t))     result.height = 'Three storey+';

  if (/fine\s+and\s+dry|sunny|clear\s+sky/i.test(t))      result.weatherConditions = 'Fine and dry';
  else if (/overcast|cloudy/i.test(t))                     result.weatherConditions = 'Overcast';
  else if (/light\s+rain|drizzl/i.test(t))                 result.weatherConditions = 'Light rain';
  else if (/heavy\s+rain|pouring/i.test(t))                result.weatherConditions = 'Heavy rain';
  else if (/humid/i.test(t))                               result.weatherConditions = 'Humid';
  else if (/wind/i.test(t))                                result.weatherConditions = 'Windy';

  if (/north.east|north east/i.test(t))     result.facadeDirection = 'North-east';
  else if (/south.east|south east/i.test(t)) result.facadeDirection = 'South-east';
  else if (/south.west|south west/i.test(t)) result.facadeDirection = 'South-west';
  else if (/north.west|north west/i.test(t)) result.facadeDirection = 'North-west';
  else if (/\bnorth\b/i.test(t))             result.facadeDirection = 'North';
  else if (/\bsouth\b/i.test(t))             result.facadeDirection = 'South';
  else if (/\beast\b/i.test(t))              result.facadeDirection = 'East';
  else if (/\bwest\b/i.test(t))              result.facadeDirection = 'West';

  if (/occupied|owner.occupied|tenant/i.test(t))   result.occupancyStatus = 'Occupied — residential';
  else if (/vacant|empty|unoccupied/i.test(t))     result.occupancyStatus = 'Vacant';
  else if (/renovati/i.test(t))                    result.occupancyStatus = 'Under renovation';

  if (/pre.1920|before\s+1920/i.test(t))           result.constructionEra = 'Pre-1920s';
  else if (/1920|1930|1940/i.test(t))              result.constructionEra = '1920s-1940s';
  else if (/1945|1950|1960/i.test(t))              result.constructionEra = '1945-1965';
  else if (/1965|1970|1975|1980/i.test(t))         result.constructionEra = '1965-1985';
  else if (/1985|1990|1995|2000/i.test(t))         result.constructionEra = '1985-2003';
  else if (/post.2003|after\s+2003|2005|2010|2015|2020/i.test(t)) result.constructionEra = 'Post-2003';

  // ── ACCESS ────────────────────────────────────────────────────────────
  const accessPhrase = (rx) => {
    const m = transcript.match(rx);
    return m ? m[1]?.trim() : null;
  };
  const hinderedM = transcript.match(/hinder[^.]*?[—\-:]?\s*([A-Z][^.]+\.?)/i);
  if (hinderedM) result.hinderedAreas = hinderedM[1].trim();
  const noAccessM = transcript.match(/(?:not\s+inspect|no\s+access|inaccessib)[^.]*?[—\-:]?\s*([A-Z][^.]+\.?)/i);
  if (noAccessM) result.obstructions = noAccessM[1].trim();

  // ── FINDINGS ──────────────────────────────────────────────────────────
  const finding = {};

  // FIX: "inactive" contains the substring "active", so the old ACTIVE
  // check (tested first) matched it before this INACTIVE check ever ran -
  // every "old/inactive damage, no live termites" transcript was silently
  // misreported as ACTIVE. INACTIVE/NONE are now checked first, and the
  // ACTIVE pattern uses a negative lookbehind so "inactive" can never match
  // it even if wording changes in the future.
  // FIX: natural negated phrasing like "no active termite activity was
  // observed" or "no live termites found" was falling straight through to
  // the ACTIVE/INACTIVE checks below, because the words "active" and
  // "live" are still literally present even though the sentence means the
  // opposite - the exact same bug class as the ACTIVE/INACTIVE ordering
  // fix already applied further down, just recurring in different wording.
  // Checked first, ahead of everything else.
  if (/no\s+(?:current\s+|live\s+)?active|not\s+active|no\s+live\s+termites?/i.test(t))
    finding.termiteActivity = 'NONE';
  else if (/inactive|evidence\s+only|old\s+workings|old\s+mud/i.test(t))
    finding.termiteActivity = 'INACTIVE';
  else if (/no\s+(?:termite\s+)?(?:activity|evidence|finding|workings)/i.test(t))
    finding.termiteActivity = 'NONE';
  // FIX: the old (?<!in)active guard only excluded a literal "in" prefix,
  // so an unrelated word like "reactive" (as in "the owner was reactive
  // and cooperative") still matched and wrongly flagged ACTIVE termite
  // activity. \bactive\b requires "active" to be its own whole word, which
  // excludes "inactive"/"reactive"/"proactive" etc. without needing to
  // enumerate every possible prefix.
  else if (/\bactive\b|live\s+termite|workers|soldiers\s+observed/i.test(t))
    finding.termiteActivity = 'ACTIVE';

  // Species
  const speciesMap = [
    [/coptotermes\s+acin|c\.\s*acin/i,          'Coptotermes acinaciformis'],
    [/coptotermes\s+fren|c\.\s*fren/i,           'Coptotermes frenchi'],
    [/coptotermes/i,                             'Coptotermes spp.'],
    [/schedorhinotermes/i,                       'Schedorhinotermes spp.'],
    [/nasutitermes/i,                            'Nasutitermes spp.'],
    [/microcerotermes/i,                         'Microcerotermes spp.'],
    [/cryptotermes/i,                            'Cryptotermes brevis'],
    [/heterotermes/i,                            'Heterotermes spp.'],
  ];
  for (const [rx, val] of speciesMap) { if (rx.test(t)) { finding.species = val; break; } }

  // FIX: these only ever checked for the positive phrasing, so "no
  // structural concern was noted" / "no nest was located" still matched
  // (the words "structural concern" / "nest located" are literally present
  // in the negated sentence too) and silently flipped the field to YES -
  // the opposite of what was actually said. Negation is now checked first.
  if (/no\s+structural\s+concern|no\s+structural\s+damage/i.test(t))
    finding.structuralConcern = 'NO';
  else if (/structural\s+concern|structural\s+damage|load.bearing|engineer|builder\s+referral/i.test(t))
    finding.structuralConcern = 'YES';

  if (/no\s+nest\s+(?:was\s+|is\s+)?located|no\s+nest\s+found|nest\s+not\s+located/i.test(t))
    finding.nestLocated = 'NO';
  else if (/nest\s+located|found\s+nest|nest\s+found/i.test(t))
    finding.nestLocated = 'YES';

  // Location — look for common positional phrases
  const locM = transcript.match(/(?:located?|found|present|observed)\s+(?:in|at|on|to)\s+(?:the\s+)?([^,.]+(?:subfloor|roof\s+void|wall|bearer|joist|stump|slab|bathroom|kitchen|living|bedroom|external|internal|eastern|western|northern|southern)[^,.]*)/i);
  if (locM) finding.activityLocation = locM[1].trim();

  // Damage description
  const dmgM = transcript.match(/(?:mud\s+(?:galleries?|tubes?)|hollow\s+sounding?|damaged?\s+timber|workings?)[^.]+\./i);
  if (dmgM) finding.damageDescription = dmgM[0].trim();

  if (Object.keys(finding).length > 0) result.findings = [{ id: 'offline_' + Date.now(), ...finding }];

  // ── CONDUCIVE ─────────────────────────────────────────────────────────
  // FIX (both below): "no water leak detected" contains the substring
  // "leak detected", and "moisture readings are normal" contains the
  // substring "moisture reading" (singular is a prefix of "readings") - so
  // the YES check matched first in both cases and the negation was never
  // reached. NO is now checked first.
  if (/no\s+(?:water\s+)?leak|no\s+moisture\s+source/i.test(t))             result.waterLeaks = 'NO';
  else if (/water\s+leak|leaking|leak\s+detected|moisture\s+source/i.test(t)) result.waterLeaks = 'YES';

  if (/no\s+moisture|moisture\s+(?:readings?\s+)?(?:are\s+)?(?:normal|clear|fine)/i.test(t)) result.moistureReadings = 'NO';
  else if (/high\s+moisture|elevated\s+moisture|moisture\s+detected|moisture\s+reading/i.test(t)) result.moistureReadings = 'YES';

  if (/timber.to.soil|timber\s+in\s+(?:direct\s+)?soil|soil\s+contact/i.test(t))  result.timberSoil = 'YES';
  else if (/no\s+timber.to.soil|no\s+soil\s+contact/i.test(t))                    result.timberSoil = 'NO';

  if (/weep\s+holes?\s+(?:are\s+)?bridged|bridged\s+weep/i.test(t))               result.weepHoles = 'BRIDGED';
  else if (/weep\s+holes?\s+(?:are\s+)?clear|clear\s+weep/i.test(t))              result.weepHoles = 'CLEAR';

  if (/slab\s+edge\s+(?:is\s+)?obstructed|obstructed\s+slab/i.test(t))            result.slabEdge = 'OBSTRUCTED';
  else if (/slab\s+edge\s+(?:is\s+)?clear|clear\s+slab/i.test(t))                 result.slabEdge = 'CLEAR';

  // FIX: a brand/system keyword appearing in a sentence that actually
  // DENIES one is present ("no reticulation system ... installed") was
  // still matching below and fabricating an existingSystem value - the
  // same negation bug class as elsewhere in this function. The app's own
  // AI prompt (SYSTEM_PROMPT) is explicit that "no system installed"
  // should leave existingSystem null, never guess a value - matched here.
  const existingSystemDenied = /no\s+(?:existing\s+)?(?:reticulation|baiting|barrier)\s+system|no\s+physical\s+barrier|not\s+currently\s+installed|nothing\s+(?:currently\s+)?installed/i.test(t);

  const existingM = existingSystemDenied ? null :
    /termguard|altis|termx\b|termstop|camilleri|cavtech|reterm|reticulation\s+system/i.test(t) ? 'Chemical Reticulation System' :
    /exterra|sentricon|trelona|nemesis|baiting\s+system/i.test(t)                              ? 'Termite Baiting System' :
    /homeguard|kordon|termseal|smartfilm|termimesh|granitgard|greenzone|physical\s+barrier/i.test(t) ? 'Physical Barrier' :
    /combination\s+system|physical\s+and\s+chemical/i.test(t)                                  ? 'Combination System — Physical + Chemical' :
    null;
  if (existingM) {
    result.existingSystem = existingM;
    // Also capture specific product name if mentioned
    const specificM =
      /homeguard\s+blue/i.test(t) ? 'HomeGuard Blue' :
      /homeguard\s+dpc/i.test(t)  ? 'HomeGuard DPC' :
      /homeguard\s+tmb/i.test(t)  ? 'HomeGuard TMB' :
      /homeguard/i.test(t)        ? 'HomeGuard' :
      /termguard/i.test(t)        ? 'Termguard' :
      /kordon/i.test(t)           ? 'Kordon' :
      /termimesh/i.test(t)        ? 'Termimesh' :
      /termseal/i.test(t)         ? 'Termseal' :
      /greenzone/i.test(t)        ? 'Greenzone' :
      /granitgard/i.test(t)       ? 'Granitgard' :
      /altis/i.test(t)            ? 'Altis' :
      /exterra/i.test(t)          ? 'Exterra' :
      /sentricon/i.test(t)        ? 'Sentricon' :
      /trelona/i.test(t)          ? 'Trelona' :
      /nemesis/i.test(t)          ? 'Nemesis' :
      null;
    if (specificM) result.existingSystemOther = specificM;
  }

  // ── RECOMMENDATIONS ───────────────────────────────────────────────────
  // FIX: "no treatment required" contains the literal substring "treatment
  // required", so the YES check below matched first and the negation was
  // never reached - same bug class as the others fixed in this pass.
  if (/no\s+treatment\s+required|treatment\s+(?:is\s+)?not\s+required/i.test(t))
    result.treatmentRecommended = 'NO';
  else if (/treatment\s+(?:is\s+)?required|recommend\s+treatment|treat(?:ment)?\s+recommended/i.test(t))
    result.treatmentRecommended = 'YES';

  if (/high\s+(?:risk|susceptibility)|susceptibility[^.]*high/i.test(t))    result.riskLevel = 'HIGH';
  else if (/medium\s+(?:risk|susceptibility)|moderate/i.test(t))            result.riskLevel = 'MEDIUM';
  else if (/low\s+(?:risk|susceptibility)/i.test(t))                         result.riskLevel = 'LOW';

  if (/three\s+months?|3\s+months?/i.test(t))           result.inspectionFrequency = '3 months';
  else if (/six\s+months?|6\s+months?/i.test(t))        result.inspectionFrequency = '6 months';
  else if (/twelve\s+months?|annual|every\s+year|12\s+months?/i.test(t))
    result.inspectionFrequency = '12 months (annual)';

  // Treatment type
  const txMap = [
    [/termidor|fipronil/i,              'Chemical barrier — Termidor (Fipronil)'],
    [/altriset|chlorantraniliprole/i,   'Chemical barrier — Altriset (Chlorantraniliprole)'],
    [/biflex|bifenthrin/i,              'Chemical barrier — Biflex (Bifenthrin)'],
    [/exterra/i,                        'Baiting system — Exterra'],
    [/sentricon/i,                      'Baiting system — Sentricon'],
    [/trelona/i,                        'Baiting system — Trelona'],
    [/homeguard/i,                      'Physical barrier — HomeGuard'],
    [/kordon/i,                         'Physical barrier — Kordon'],
    [/localised\s+treatment/i,          'Localised treatment only'],
  ];
  for (const [rx, val] of txMap) { if (rx.test(t)) { result.treatmentType = val; break; } }

  // ── JOB DETAILS ───────────────────────────────────────────────────────
  // FIX: this required a literal lowercase "inspector" - a transcript that
  // starts a sentence with "Inspector ..." (capitalized, as speech-to-text
  // output and typed notes both commonly do) silently failed to match at
  // all, so the inspector's name was dropped more often than it was caught.
  // NOTE: only the "I"/"i" is made case-insensitive here (not a blanket /i
  // on the whole regex) - a blanket /i would also make the name-capture
  // group's [A-Z] match lowercase letters, so a trailing lowercase word
  // like "attended" would get greedily absorbed into the captured name.
  const inspectorM = transcript.match(/[Ii]nspector(?:\s+is)?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (inspectorM) result.inspector = inspectorM[1];

  return result;
}

async function processTranscript() {
  if (!currentTranscript.trim()) return;
  setAI('thinking', 'Extracting data...');
  document.getElementById('extractBtn').disabled = true;

  try {
    const res = await fetch('https://korva.byronguyatt2.workers.dev', {
      method: 'POST',
      // FIX: the worker has required a Bearer session token since v4 (see
      // korva-worker-CLEAN-v5.js) - every call here was missing it, so the
      // worker was silently rejecting every real request with 401 and the
      // app was falling back to the offline pattern-matching extractor
      // every single time, without ever actually reaching the AI.
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        // FIX: was 3000 - a long, multi-section dictation (several findings,
        // full property details, existing-system verification fields all at
        // once) produces a JSON response that can exceed that, which gets
        // cut off mid-structure. JSON.parse() on a truncated response throws
        // ("JSON Parse error: Unexpected EOF" on Safari), which silently
        // dropped the WHOLE extraction into the weaker offline fallback -
        // exactly the cases where the richer AI reasoning (brand names,
        // homophones, multi-finding handling) was needed most. Bumped with
        // real headroom rather than just enough for today's test case.
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: currentTranscript }]
      })
    });

    // The worker can reject a request (e.g. a failed origin check) with a
    // plain-text body like "Forbidden" rather than JSON — parse defensively
    // so that text surfaces as-is instead of a confusing JSON-parse error.
    const rawBody = await res.text();
    let data;
    try {
      data = JSON.parse(rawBody);
    } catch {
      throw new Error(`HTTP ${res.status}: ${rawBody.slice(0, 200) || '(empty response)'}`);
    }

    if (!res.ok || data.error) {
      const errMsg = data.error?.message || data.error?.type || `HTTP ${res.status}`;
      throw new Error('API error: ' + errMsg);
    }

    // FIX: if the response was cut off at the token limit, say so plainly
    // instead of letting JSON.parse() below throw an opaque "Unexpected
    // EOF" that's indistinguishable from any other malformed-response bug.
    if (data.stop_reason === 'max_tokens') {
      throw new Error('AI response was cut off (transcript too long for the response limit) — falling back to offline mode');
    }

    const text = data.content.map(i => i.text || '').join('');
    const extracted = JSON.parse(text.replace(/```json|```/g, '').trim());
    populateFields(extracted);
    setAI('ready', 'Data extracted');
    showToast('Fields populated', 'success');

  } catch(err) {
    // ── OFFLINE FALLBACK ───────────────────────────────────────────────
    // Surface the real reason in the toast itself (not just the console) —
    // this is the one signal that actually tells us WHY the AI call failed
    // (a network error, a CORS/origin rejection, a bad API key, an invalid
    // model, etc.) without needing to dig through Xcode's device console.
    const reason = ((err && err.message) ? String(err.message) : 'unknown error').slice(0, 140);
    console.warn('API unavailable — running offline extraction:', reason);
    try {
      const extracted = offlineExtract(currentTranscript);
      const fieldCount = Object.keys(extracted).length;
      if (fieldCount > 0) {
        populateFields(extracted);
        setAI('ready', 'Offline extraction used');
        showToast(`Offline mode — ${fieldCount} field${fieldCount !== 1 ? 's' : ''} extracted. AI unavailable: ${reason}`, 'info');
      } else {
        setAI('ready', 'No fields recognised');
        showToast(`Offline mode — no fields recognised. AI unavailable: ${reason}`, 'error');
        document.getElementById('extractBtn').disabled = false;
        return;
      }
    } catch(offlineErr) {
      setAI('ready', 'Extraction failed');
      showToast(`Extraction failed: ${reason}`, 'error');
      document.getElementById('extractBtn').disabled = false;
      return;
    }
  }

  if (window.innerWidth <= 768) toggleVoicePopover();
  currentTranscript = '';
  const box = document.getElementById('transcriptBox');
  box.textContent = 'Tap the mic and start speaking, or tap here to type instead.';
  box.classList.remove('active');
  lowConfidenceFlagged = false;
  const warnElDone = document.getElementById('lowConfidenceWarning');
  if (warnElDone) warnElDone.classList.remove('show');
  resetConfDebug();
  dismissCleanupSuggestion();
  dismissServerTranscript();
}

// ── COMPLIANCE PLATE SCAN ───────────────────────────────────────────────
// Photographs a termite management system durable notice/plate and asks
// the AI to read it, then fills existingSystem/existingSystemOther/
// durableNoticePresent the same way populateFields() already does for
// voice extraction — same "AI drafts, technician can always edit" model,
// just a photo instead of a transcript as the input.
async function scanCompliancePlate() {
  const btn = document.getElementById('scanPlateBtn');
  const btnText = document.getElementById('scanPlateBtnText');
  if (btn && btn.disabled) return; // already running

  let base64 = null;
  let mediaType = 'image/jpeg';

  const isNative = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
  const cameraPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera;

  try {
    if (isNative && cameraPlugin) {
      const photo = await cameraPlugin.getPhoto({
        quality: 70,
        allowEditing: false,
        resultType: 'base64',
        source: 'PROMPT', // lets the technician choose Camera or an existing photo
        direction: 'REAR',
      });
      if (!photo || !photo.base64String) return; // cancelled
      base64 = photo.base64String;
      mediaType = photo.format === 'png' ? 'image/png' : 'image/jpeg';
    } else {
      base64 = await pickImageFileAsBase64();
      if (!base64) return; // cancelled
    }
  } catch (e) {
    const msg = ((e && e.message) || '') + '';
    if (!/cancel/i.test(msg)) {
      showToast('Could not open the camera — check camera permission in Settings', 'error');
    }
    return;
  }

  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = 'Reading plate…';
  setAI('thinking', 'Reading compliance plate...');

  try {
    const res = await fetch('https://korva.byronguyatt2.workers.dev', {
      method: 'POST',
      // FIX: the worker has required a Bearer session token since v4 (see
      // korva-worker-CLEAN-v5.js) - every call here was missing it, so the
      // worker was silently rejecting every real request with 401 and the
      // app was falling back to the offline pattern-matching extractor
      // every single time, without ever actually reaching the AI.
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        system: PLATE_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'Read this termite management system durable notice and return the JSON described in your instructions.' },
          ],
        }],
      }),
    });

    const rawBody = await res.text();
    let data;
    try {
      data = JSON.parse(rawBody);
    } catch {
      throw new Error(`HTTP ${res.status}: ${rawBody.slice(0, 200) || '(empty response)'}`);
    }

    if (!res.ok || data.error) {
      const errMsg = data.error?.message || data.error?.type || `HTTP ${res.status}`;
      throw new Error('API error: ' + errMsg);
    }

    const text = data.content.map(i => i.text || '').join('');
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    if (parsed.systemFound === 'YES') {
      const update = {};
      if (parsed.existingSystem) update.existingSystem = parsed.existingSystem;
      if (parsed.existingSystemOther) update.existingSystemOther = parsed.existingSystemOther;
      update.durableNoticePresent = 'YES';
      populateFields(update);
      const label = [parsed.existingSystemOther, parsed.existingSystem].filter(Boolean).join(' — ') || 'system identified';
      showToast(`Plate read: ${label}`, 'success');
      if (parsed.extraDetails) {
        setTimeout(() => showToast(parsed.extraDetails, 'info'), 1600);
      }
    } else {
      showToast("Couldn't read a compliance plate clearly in that photo — try again with better light, or enter it manually", 'info');
    }
    setAI('ready', 'Ready');

  } catch (err) {
    console.warn('Plate scan failed:', err);
    showToast('Could not read the plate — check your connection and try again', 'error');
    setAI('ready', 'Ready');
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Take a photo of the durable notice';
  }
}

// Web/PWA fallback for scanCompliancePlate() — no native Camera plugin there.
function pickImageFileAsBase64() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.split(',')[1] || null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

// ── INSECT / SPECIES PHOTO ID ───────────────────────────────────────────
// Analyses a photo the technician already attached via the normal Add
// Photos flow (reportData.photos) — deliberately opt-in per photo, not
// automatic on upload, since not every photo taken during an inspection is
// of a specimen worth identifying. Writes the result into that photo's own
// caption (only if it's still empty) as a plain-language suggestion — never
// into a Finding directly. The technician decides whether and where to use
// it, same "AI drafts, technician confirms" model as everywhere else here.
async function analyzeGalleryPhoto(photoId) {
  const photo = (reportData.photos || []).find(p => p.id === photoId);
  if (!photo || !photo.dataUrl) return;

  const btn = document.getElementById('analyzeBtn-' + photoId);
  if (btn && btn.disabled) return; // already running

  const match = /^data:([^;]+);base64,(.+)$/.exec(photo.dataUrl);
  if (!match) { showToast('Could not read that photo', 'error'); return; }
  const mediaType = match[1];
  const base64 = match[2];

  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing…'; }
  setAI('thinking', 'Analyzing photo...');

  try {
    const res = await fetch('https://korva.byronguyatt2.workers.dev', {
      method: 'POST',
      // FIX: the worker has required a Bearer session token since v4 (see
      // korva-worker-CLEAN-v5.js) - every call here was missing it, so the
      // worker was silently rejecting every real request with 401 and the
      // app was falling back to the offline pattern-matching extractor
      // every single time, without ever actually reaching the AI.
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        system: INSECT_ID_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'Identify the insect or insect damage shown in this photo and return the JSON described in your instructions.' },
          ],
        }],
      }),
    });

    const rawBody = await res.text();
    let data;
    try {
      data = JSON.parse(rawBody);
    } catch {
      throw new Error(`HTTP ${res.status}: ${rawBody.slice(0, 200) || '(empty response)'}`);
    }

    if (!res.ok || data.error) {
      const errMsg = data.error?.message || data.error?.type || `HTTP ${res.status}`;
      throw new Error('API error: ' + errMsg);
    }

    const text = data.content.map(i => i.text || '').join('');
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    if (parsed.identified === 'YES' && parsed.species) {
      const confLabel = parsed.confidence ? parsed.confidence.toLowerCase() + ' confidence' : 'unconfirmed';
      const note = `Possible ID: ${parsed.species} (${confLabel})`;
      if (!photo.caption || !photo.caption.trim()) {
        photo.caption = note;
        renderPhotoGrid();
        saveDraft();
      }
      showToast(`${note} — please confirm before adding to a finding`, 'success');
      if (parsed.notes) {
        setTimeout(() => showToast(parsed.notes, 'info'), 1600);
      }
    } else {
      showToast(parsed.notes || "Couldn't identify anything with confidence in that photo", 'info');
    }
    setAI('ready', 'Ready');

  } catch (err) {
    console.warn('Photo analysis failed:', err);
    showToast('Could not analyze the photo — check your connection and try again', 'error');
    setAI('ready', 'Ready');
  } finally {
    renderPhotoGrid(); // restores the button (re-render clears the disabled/label override above)
  }
}

// ── FIELD RENDERING ───────────────────────────────────────────────────────
function renderField(el, key, val) {
  el.classList.remove('editing');
  const yesNoKeys = ['nestLocated','waterLeaks','moistureReadings','timberSoil','treatmentRecommended'];

  if (key === 'structuralConcern') {
    el.innerHTML = val === 'YES'
      ? '<span class="risk-tag risk-high">YES — Builder/Engineer Referral Required</span>'
      : '<span class="no-tag">NO</span>';
  } else if (key === 'termiteActivity') {
    const cls = val==='ACTIVE'?'risk-high':val==='INACTIVE'?'risk-medium':'risk-low';
    const label = val==='ACTIVE'?'ACTIVE — live termites sighted':val==='INACTIVE'?'INACTIVE — evidence only, no live sighting':'NONE';
    el.innerHTML = `<span class="risk-tag ${cls}">${escapeHtml(label)}</span>`;
  } else if (key === 'durableNoticePresent' || key === 'zone25mmVisible' || key === 'zone75mmVisible') {
    // these should be YES for a properly verifiable system — NO is the concerning answer
    el.innerHTML = val === 'YES' ? '<span class="yes-tag">YES</span>' : '<span class="no-tag" style="background:rgba(255,77,106,0.14);color:var(--risk);">NO</span>';
  } else if (key === 'antCapSoldered') {
    const cls = val === 'NO' ? 'background:rgba(255,77,106,0.14);color:var(--risk);' : '';
    el.innerHTML = val === 'N/A' ? '<span class="no-tag">N/A</span>' : `<span class="${val==='YES'?'yes-tag':'no-tag'}" style="${cls}">${escapeHtml(val)}</span>`;
  } else if (key === 'hardLandscaping' || key === 'softLandscaping') {
    // presence is informational, not inherently a concern either way
    el.innerHTML = val === 'YES' ? '<span class="yes-tag">YES</span>' : '<span class="no-tag">NO</span>';
  } else if (yesNoKeys.includes(key)) {
    el.innerHTML = val === 'YES' ? '<span class="yes-tag">YES</span>' : '<span class="no-tag">NO</span>';
  } else if (key === 'riskLevel') {
    const cls = val==='HIGH'?'risk-high':val==='MEDIUM'?'risk-medium':'risk-low';
    el.innerHTML = `<span class="risk-tag ${cls}">${escapeHtml(val)}</span>`;
  } else if (key === 'slabEdge') {
    el.innerHTML = val==='CLEAR' ? '<span class="no-tag">CLEAR</span>' : '<span class="yes-tag">OBSTRUCTED</span>';
  } else if (key === 'weepHoles') {
    el.innerHTML = val==='CLEAR' ? '<span class="no-tag">CLEAR</span>' : '<span class="yes-tag">BRIDGED</span>';
  } else {
    el.textContent = val;
  }

  el.classList.add('filled', 'flash');
  setTimeout(() => el.classList.remove('flash'), 500);

  // Trigger species intelligence layer when species field is populated
  if (key === 'species' && val && val !== '—') {
    setTimeout(() => triggerSpeciesIntelligence(val), 400);
  }
}

function populateFields(data) {
  // Handle findings array from AI extraction
  if (data.findings && Array.isArray(data.findings) && data.findings.length > 0) {
    const incoming = data.findings.map(f => ({
      id: genFindingId(),
      termiteActivity: f.termiteActivity || null,
      species: f.species || null,
      damageDescription: f.damageDescription || null,
      activityLocation: f.activityLocation || null,
      nestLocated: f.nestLocated || null,
      structuralConcern: f.structuralConcern || null,
    }));

    // A technician typically records in short bursts as they move through a
    // property (one recording per room/area), not one long monologue — each
    // recording is sent to extraction on its own with no memory of earlier
    // ones. Previously this REPLACED reportData.findings wholesale, so a
    // second dictation pass about a new area silently wiped out whatever was
    // already captured from the first one. Now we append instead, unless the
    // only "existing" finding is still the untouched blank placeholder.
    const existing = getFindings();
    const existingHasData = existing.some(f =>
      f.termiteActivity || f.species || f.damageDescription || f.activityLocation || f.nestLocated || f.structuralConcern
    );

    if (existingHasData) {
      const combined = [...existing, ...incoming];
      reportData.findings = combined.slice(0, MAX_FINDINGS);
      if (combined.length > MAX_FINDINGS) {
        showToast(`Only ${MAX_FINDINGS} findings can be tracked per report — some new ones weren't added. Review and merge manually if needed.`, 'info');
      }
    } else {
      reportData.findings = incoming;
    }
    renderFindingsUI();
  } else if (data.termiteActivity !== undefined) {
    // Backward compatibility: AI returned flat fields — wrap into findings[0]
    const existing = getFindings();
    existing[0] = {
      ...existing[0],
      termiteActivity: data.termiteActivity || null,
      species: data.species || null,
      damageDescription: data.damageDescription || null,
      activityLocation: data.activityLocation || null,
      nestLocated: data.nestLocated || null,
      structuralConcern: data.structuralConcern || null,
    };
    renderFindingsUI();
  }

  // Obstructions/restrictedAccess have no plain field-val element of their
  // own — the Obstructions section represents them entirely through the
  // zone-chip selector (obsSelectedZones -> syncObstructionData()). The
  // generic field loop below only ever writes into an element with id
  // 'f-'+key, so without this block the AI's obstructions/restrictedAccess
  // text was silently dropped on the floor every time: never written to
  // reportData, and the chips never got selected. This was the root cause
  // of a real voice test showing zero obstruction chips selected even
  // though the technician clearly described obstructed areas.
  applyObstructionExtraction(data);

  // Job/client details spoken by the technician (e.g. the address at the
  // start of a recording) — separate from reportData, mapped onto the Job
  // Details inputs directly. Only fills a field that's still empty, so it
  // never overwrites something the technician already typed themselves.
  const jobFieldMap = {
    propertyStreetAddress: 'jobAddress',
    propertySuburb: 'jobSuburb',
    propertyState: 'jobState',
    propertyPostcode: 'jobPostcode',
    clientName: 'jobClient',
  };
  let jobFieldsChanged = false;
  Object.entries(jobFieldMap).forEach(([key, elId]) => {
    const val = data[key];
    if (!val) return;
    const el = document.getElementById(elId);
    if (el && !el.value.trim()) {
      el.value = val;
      jobFieldsChanged = true;
    }
  });
  if (jobFieldsChanged) updateJob();

  // All non-findings fields
  const skip = new Set(['findings','termiteActivity','species','damageDescription','activityLocation','nestLocated','structuralConcern','propertyStreetAddress','propertySuburb','propertyState','propertyPostcode','clientName','obstructions','restrictedAccess']);
  const entries = Object.entries(data).filter(([key, val]) => !skip.has(key) && val !== null && val !== undefined && document.getElementById('f-' + key));

  entries.forEach(([key, val], i) => {
    const el = document.getElementById('f-' + key);
    setTimeout(() => {
      reportData[key] = val;
      // FIX: apply the same cross-field cascade manual edits get (reveal/
      // hide dependent fields, clear fields that are no longer valid) - see
      // applyFieldCascade's comment for why this matters here specifically.
      applyFieldCascade(key, String(val), el);
      renderField(el, key, reportData[key]);
      updateProgress();
      checkAsbestosFlag();
      checkSystemVerify();
      checkSecondaryColonyFlag();
    }, i * 70);
  });

  setTimeout(() => {
    autoReveal(data);
    saveDraft();
  }, entries.length * 70 + 50);
}

// ── MULTI-FINDING ENGINE ─────────────────────────────────────────────────
// reportData.findings is an array of finding objects. Each has:
// { id, termiteActivity, species, damageDescription, activityLocation, nestLocated, structuralConcern }
// The array always has at least one entry. "Add Finding" appends another.
const MAX_FINDINGS = 6;

function genFindingId() {
  return 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function getFindings() {
  if (!reportData.findings || !Array.isArray(reportData.findings) || reportData.findings.length === 0) {
    reportData.findings = [{ id: genFindingId(), termiteActivity: null }];
  }
  return reportData.findings;
}

function addFinding() {
  const findings = getFindings();
  if (findings.length >= MAX_FINDINGS) return;
  findings.push({ id: genFindingId(), termiteActivity: null });
  renderFindingsUI();
  updateProgress();
  saveDraft();
}

function removeFinding(id) {
  const findings = getFindings();
  if (findings.length <= 1) return; // always keep at least one
  reportData.findings = findings.filter(f => f.id !== id);
  renderFindingsUI();
  updateProgress();
  saveDraft();
}

function setFindingField(id, key, val) {
  const finding = getFindings().find(f => f.id === id);
  if (!finding) return;
  finding[key] = val;
  renderFindingsUI();
  updateProgress();
  saveDraft();
}

// Renders an activity chip label
function activityLabel(val) {
  if (val === 'ACTIVE')   return 'ACTIVE — live termites sighted';
  if (val === 'INACTIVE') return 'INACTIVE — evidence only';
  if (val === 'NONE')     return 'NONE — nothing found';
  return 'Set activity status';
}

// Generates the HTML for one finding card
function findingCardHTML(finding, index, total) {
  const id = finding.id;
  const act = finding.termiteActivity;
  const chipClass = act ? act : 'unset';
  const showDetails = act === 'ACTIVE' || act === 'INACTIVE';
  const showNone = act === 'NONE';
  const label = total === 1 ? 'Primary Finding' : `Finding ${index + 1}`;

  const fv = (key, type, display) => {
    const val = finding[key];
    let inner;
    if (key === 'structuralConcern') {
      inner = val === 'YES'
        ? '<span class="risk-tag risk-high">YES — Builder/Engineer Referral Required</span>'
        : val === 'NO' ? '<span class="no-tag">NO</span>' : '—';
    } else if (key === 'nestLocated') {
      inner = val === 'YES' ? '<span class="yes-tag">YES</span>' : val === 'NO' ? '<span class="no-tag">NO</span>' : '—';
    } else {
      inner = val ? escapeHtml(val) : '—';
    }
    const filled = val ? ' filled' : '';
    return `<div class="field-val${filled}" onclick="startFindingEdit('${id}','${key}','${type}')">${inner}</div>`;
  };

  return `
    <div class="finding-card" id="finding-card-${id}">
      <div class="finding-card-header">
        <span class="finding-card-label">${label}</span>
        <span class="finding-activity-chip ${chipClass}">${act ? act : '—'}</span>
        ${total > 1 ? `<button class="finding-remove-btn" onclick="removeFinding('${id}')" title="Remove this finding">✕</button>` : ''}
      </div>
      <div class="finding-card-body">
        <!-- Activity gate -->
        <div class="findings-gate" style="margin:8px 14px 0">
          <div class="findings-gate-question">
            <div class="field-label">Termite Activity Status</div>
            <div class="field-val findings-gate-val${act ? ' filled' : ''}" onclick="startFindingEdit('${id}','termiteActivity','activity')">${act ? `<span class="risk-tag ${act==='ACTIVE'?'risk-high':act==='INACTIVE'?'risk-medium':'risk-low'}">${escapeHtml(activityLabel(act))}</span>` : '—'}</div>
          </div>
          ${!act ? `<p class="findings-gate-hint">Answer this question to continue. Active = live termites sighted. Inactive = evidence only. None = nothing found.</p>` : ''}
        </div>
        ${showDetails ? `
        <div class="findings-details" style="display:block">
          <div class="section-fields">
            <div class="field"><div class="field-label">Species / Genus</div>${fv('species','specieslist')}</div>
            <div class="field field-wide"><div class="field-label">Damage Description (location, extent, what's visible — no severity opinion)</div>${fv('damageDescription','text')}</div>
            <div class="field"><div class="field-label">Location of Activity</div>${fv('activityLocation','text')}</div>
            <div class="field"><div class="field-label">Workings / Nest Located</div>${fv('nestLocated','yesno')}</div>
            <div class="field"><div class="field-label">Damage Appears to Compromise Structure?</div>${fv('structuralConcern','yesno')}</div>
          </div>
          ${act === 'INACTIVE' ? `<div class="inactive-reminder" style="display:flex"><svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg><span>Inactive workings can mean termites have temporarily abandoned the area, not that the risk is gone. Continued, regular inspections remain essential.</span></div>` : ''}
          ${finding.structuralConcern === 'YES' ? `<div class="warn-note" style="background:rgba(255,77,106,0.08);border-color:rgba(255,77,106,0.3);color:var(--risk);margin:0 0 10px"><svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>Structural concern flagged — PDF will include mandatory builder/engineer referral for this finding.</div>` : ''}
        </div>` : ''}
        ${showNone ? `<div class="findings-none" style="display:flex;margin:8px 0 6px"><span class="findings-none-icon"><svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg></span><span>No activity or evidence found at this location.</span></div>` : ''}
      </div>
    </div>`;
}

function renderFindingsUI() {
  const list = document.getElementById('findingsList');
  const addBtn = document.getElementById('addFindingBtn');
  const noneEl = document.getElementById('findingsNone');
  if (!list) return;

  const findings = getFindings();
  list.innerHTML = findings.map((f, i) => findingCardHTML(f, i, findings.length)).join('');

  if (addBtn) {
    const atCap = findings.length >= MAX_FINDINGS;
    addBtn.disabled = atCap;
    addBtn.classList.toggle('at-cap', atCap);
    addBtn.style.display = findings.every(f => f.termiteActivity === 'NONE') ? 'none' : '';
  }

  // Show the all-none banner only if every finding is NONE
  const allNone = findings.length > 0 && findings.every(f => f.termiteActivity === 'NONE');
  if (noneEl) noneEl.style.display = allNone ? 'flex' : 'none';
}

// Called when a field inside a finding card is tapped
let activeFindingEdit = null;

function openActivitySheet(findingId) {
  activeFindingEdit = { findingId, key: 'termiteActivity' };
  const overlay = document.getElementById('activitySheetOverlay');
  if (overlay) overlay.classList.add('open');
}

function closeActivitySheet() {
  const overlay = document.getElementById('activitySheetOverlay');
  if (overlay) overlay.classList.remove('open');
  activeFindingEdit = null;
}

function commitFromSheet(value) {
  if (!activeFindingEdit) return;
  const { findingId } = activeFindingEdit;
  closeActivitySheet();
  commitFindingEdit(findingId, 'termiteActivity', value);
}

function startFindingEdit(findingId, key, type) {
  activeFindingEdit = { findingId, key };

  const finding = getFindings().find(f => f.id === findingId);
  if (!finding) return;

  // Activity status → open the persistent bottom sheet
  if (type === 'activity') {
    openActivitySheet(findingId);
    return;
  }

  // For yesno fields, toggle directly
  if (type === 'yesno') {
    const cur = finding[key];
    const next = cur === 'YES' ? 'NO' : 'YES';
    commitFindingEdit(findingId, key, next);
    return;
  }

  // For species, show a dropdown select
  if (type === 'specieslist') {
    const cardEl = document.getElementById('finding-card-' + findingId);
    if (!cardEl) return;
    const fieldEl = cardEl.querySelector(`[onclick*="startFindingEdit('${findingId}','${key}'"]`);
    if (!fieldEl) return;
    const cur = finding[key] || '';
    const options = SPECIES_LIST;
    const sel = document.createElement('select');
    sel.className = 'field-edit-input';
    sel.style.width = '100%';
    sel.innerHTML = `<option value="">— Select species —</option>` +
      options.map(o => `<option value="${o}" ${cur===o?'selected':''}>${o}</option>`).join('');
    sel.addEventListener('change', () => {
      commitFindingEdit(findingId, key, sel.value);
      fieldEl.innerHTML = sel.value || '—';
      if (sel.value) fieldEl.classList.add('filled');
      sel.replaceWith(fieldEl);
    });
    fieldEl.replaceWith(sel);
    sel.focus();
    return;
  }
  const cardEl = document.getElementById('finding-card-' + findingId);
  if (!cardEl) return;
  const fieldEl = cardEl.querySelector(`[onclick*="startFindingEdit('${findingId}','${key}'"]`);
  if (!fieldEl) return;
  const cur = finding[key] || '';
  const ta = document.createElement('input');
  ta.className = 'field-edit-input';
  ta.type = 'text';
  ta.style.width = '100%';
  ta.value = cur;
  ta.placeholder = 'Type value...';

  const actions = document.createElement('div');
  actions.className = 'edit-actions';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'edit-confirm-btn';
  confirmBtn.textContent = '✓ Confirm';
  confirmBtn.type = 'button';
  confirmBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    commitFindingEdit(findingId, key, ta.value.trim());
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'edit-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    activeFindingEdit = null;
    renderFindingsUI();
  });

  actions.appendChild(confirmBtn);
  actions.appendChild(cancelBtn);

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;width:100%';
  wrap.appendChild(ta);
  wrap.appendChild(actions);

  fieldEl.replaceWith(wrap);
  ta.focus();
  ta.select();
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commitFindingEdit(findingId, key, ta.value.trim()); }
    if (e.key === 'Escape') { activeFindingEdit = null; renderFindingsUI(); }
  });
}

function commitFindingEdit(findingId, key, value) {
  activeFindingEdit = null;
  const finding = getFindings().find(f => f.id === findingId);
  if (!finding) return;
  finding[key] = value || null;
  if (key === 'species' && value) {
    setTimeout(() => triggerSpeciesIntelligence(value), 400);
  }
  // Check if we should prompt about high risk areas
  if (key === 'termiteActivity') {
    setTimeout(() => checkHighRiskPrompt(), 400);
  }
  renderFindingsUI();
  updateProgress();
  saveDraft();
}

// ── HIGH RISK AREA PROMPT ────────────────────────────────────────────────
// If any finding has active or inactive termites, and there are uninspected
// areas logged, but high risk areas hasn't been filled — prompt the tech
function checkHighRiskPrompt() {
  const findings = getFindings();
  const hasActivity = findings.some(f =>
    f.termiteActivity === 'ACTIVE' || f.termiteActivity === 'INACTIVE'
  );
  const hasObstructions = !!(reportData.obstructions && reportData.obstructions.trim() &&
    !reportData.obstructions.includes('N/A'));
  const hasHighRisk = !!(reportData.highRiskAreas && reportData.highRiskAreas.trim() &&
    !reportData.highRiskAreas.includes('N/A'));

  const prompt = document.getElementById('highRiskPrompt');
  if (!prompt) return;

  if (hasActivity && hasObstructions && !hasHighRisk) {
    prompt.style.display = 'flex';
  } else {
    prompt.style.display = 'none';
  }
}

function dismissHighRiskPrompt() {
  const prompt = document.getElementById('highRiskPrompt');
  if (prompt) prompt.style.display = 'none';
}

function goToHighRiskAreas() {
  dismissHighRiskPrompt();
  showSection('obstructions');
  setTimeout(() => {
    const el = document.getElementById('f-highRiskAreas');
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); startEdit(el, 'highRiskAreas', 'text'); }
  }, 300);
}

// checkFindingsGate now just re-renders — the gate logic is inside each card
function checkFindingsGate() {
  renderFindingsUI();
}

// ── EXISTING SYSTEM VERIFICATION ────────────────────────────────────────
// "existingSystem" is free text, so a technician typing "No", "None", "Nil",
// "N/A" etc. must NOT count as an identified system — only an actual system
// name/description should reveal the verification checklist.
const NO_SYSTEM_VALUES = new Set([
  '', '—', 'no', 'none', 'nil', 'na', 'n a', 'n/a', 'not applicable',
  'no system', 'nothing', 'no existing system', 'not identified',
  'no system identified', 'no system present', 'no system found', 'no system installed'
]);
function hasIdentifiedSystem(value) {
  if (!value) return false;
  const norm = value.trim().toLowerCase().replace(/[.!\-–—]/g, '').replace(/\s+/g, ' ').trim();
  return !NO_SYSTEM_VALUES.has(norm);
}

function checkSystemVerify() {
  const block = document.getElementById('systemVerify');
  if (!block) return;

  const hasSystem = hasIdentifiedSystem(reportData.existingSystem);
  block.style.display = hasSystem ? 'block' : 'none';
  if (!hasSystem) return;

  const flag = document.getElementById('systemVerifyFlag');
  const flagText = document.getElementById('systemVerifyFlagText');
  if (!flag) return;

  const concerns = [];
  if (reportData.durableNoticePresent === 'NO') concerns.push('durable notice sticker not found in meter box');
  if (reportData.hardLandscaping === 'YES' && reportData.zone25mmVisible === 'NO') concerns.push('25mm inspection zone not visible against hard landscaping');
  if (reportData.softLandscaping === 'YES' && reportData.zone75mmVisible === 'NO') concerns.push('75mm inspection zone not visible against soft landscaping');
  if (reportData.antCapSoldered === 'NO') concerns.push('ant cap / strip shield joins not soldered — shielding inadequate');

  if (concerns.length > 0) {
    flagText.textContent = 'Verification concern' + (concerns.length > 1 ? 's' : '') + ': ' + concerns.join('; ') + '. Recommend rectification and re-verification of the existing system.';
    flag.style.display = 'flex';
  } else {
    flag.style.display = 'none';
  }
}

// ── SECONDARY / SATELLITE COLONY REMINDER ───────────────────────────────
// Subterranean termites can establish an above-ground colony with zero soil
// contact if there's an alternative moisture source (roof leak, wall-cavity
// plumbing leak). leakLocation is free text, so this is necessarily a
// best-effort keyword check, not a hard gate — false negatives just mean no
// reminder shown, which is no worse than the field not existing at all.
const ABOVE_GROUND_LEAK_KEYWORDS = [
  'roof', 'ceiling', 'wall cavity', 'gutter', 'ridge', 'attic', 'sarking',
  'upstairs', 'second storey', 'second story', 'second floor', 'ensuite',
  'bathroom', 'shower', 'hot water', 'skylight', 'flashing', 'downpipe'
];
function isAboveGroundLeak(text) {
  if (!text) return false;
  const norm = text.toLowerCase();
  return ABOVE_GROUND_LEAK_KEYWORDS.some(k => norm.includes(k));
}

function checkSecondaryColonyFlag() {
  const banner = document.getElementById('secondaryColonyReminder');
  if (!banner) return;
  banner.style.display = isAboveGroundLeak(reportData.leakLocation) ? 'flex' : 'none';
}

const HIGH_ASBESTOS_ERAS = ['1945-1965', '1965-1985'];
const MODERATE_ASBESTOS_ERAS = ['1920s-1940s', '1985-2003'];

function checkAsbestosFlag() {
  const era = reportData.constructionEra;
  const banner = document.getElementById('asbestosBanner');
  if (!banner) return;

  if (HIGH_ASBESTOS_ERAS.includes(era)) {
    banner.style.display = 'flex';
    banner.querySelector('.asb-text').textContent =
      `Construction era (${era}) carries a HIGH likelihood of asbestos-containing materials (fibro, ACM sheeting). Note as observation only — do not disturb. Recommend licensed asbestos assessor if suspected ACM is identified.`;
  } else if (MODERATE_ASBESTOS_ERAS.includes(era)) {
    banner.style.display = 'flex';
    banner.querySelector('.asb-text').textContent =
      `Construction era (${era}) carries a MODERATE likelihood of asbestos-containing materials. Note as observation only — do not disturb if suspected.`;
  } else {
    banner.style.display = 'none';
  }
}

function autoReveal(data) {
  // FIX: an explicitly empty array (e.g. the AI returning findings: [] to
  // mean "nothing found") was still treated as "this section has new
  // data", jumping the user straight to a section that has nothing in it.
  // Only a non-empty value counts as real data to navigate to.
  const hasRealData = (v) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);
  for (const [sec, cfg] of Object.entries(SECTIONS)) {
    if (cfg.fields.some(f => hasRealData(data[f]))) {
      showSection(sec);
      return;
    }
  }
}

// ── EDIT MODE ─────────────────────────────────────────────────────────────
function toggleEdit() {
  editOn = !editOn;
  const body = document.getElementById('reportBody');
  const btn = document.getElementById('editBtn');
  const banner = document.getElementById('editBanner');

  if (editOn) {
    body.classList.add('edit-mode');
    btn.classList.add('active');
    btn.innerHTML = '<svg class="icon " width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Done Editing';
    banner.classList.add('show');
    showToast('Edit mode on — tap any field', 'info');
  } else {
    commitActive();
    body.classList.remove('edit-mode');
    btn.classList.remove('active');
    btn.innerHTML = '<svg class="icon " width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>Edit Mode';
    banner.classList.remove('show');
    showToast('Changes saved', 'success');
  }
}

// Global species list — used by both startEdit and startFindingEdit
const SPECIES_LIST = [
  'Coptotermes acinaciformis', 'Coptotermes frenchi', 'Coptotermes lacteus',
  'Schedorhinotermes intermedius', 'Schedorhinotermes actuosus',
  'Nasutitermes exitiosus', 'Nasutitermes walkeri', 'Nasutitermes magnus',
  'Heterotermes ferox', 'Microcerotermes distinctus', 'Microcerotermes implicatus',
  'Termes intermedius', 'Cryptotermes brevis', 'Cryptotermes primus',
  'Anobium punctatum — Furniture beetle', 'Lyctus brunneus — Powder post beetle',
  'Hylotrupes bajulus — House longhorn beetle',
  'Coptotermes spp.', 'Schedorhinotermes spp.', 'Nasutitermes spp.',
  'Microcerotermes spp.', 'Species not identified — further investigation required',
];

function startEdit(el, key, type) {
  if (!editOn) return;
  if (el.classList.contains('editing')) return;
  commitActive();
  activeEditEl = el;
  el.classList.add('editing');

  const cur = reportData[key] || '';
  const OPTIONS = {
    yesno:       ['YES','NO','N/A'],
    yesnona:     ['YES','NO','N/A'],
    activity:    ['ACTIVE','INACTIVE','NONE'],
    risk:        ['LOW','MEDIUM','HIGH'],
    slabedge:    ['CLEAR','OBSTRUCTED'],
    weepholes:   ['CLEAR','BRIDGED'],
    era:         ['Pre-1920s','1920s-1940s','1945-1965','1965-1985','1985-2003','Post-2003'],
    standard:    ['AS 3660.1-2014','AS 3660.2-2017','AS 3660.3-2014','AS 4349.0-2007','AS 4349.1-2007','AS 4349.3-2010'],
    structuretype: [
      'Detached house',
      'Semi-detached',
      'Terrace / townhouse',
      'Duplex',
      'Unit / apartment',
      'Granny flat',
      'Commercial building',
      'Other',
    ],
    wallconstruction: [
      'Brick veneer',
      'Double brick',
      'Weatherboard',
      'Fibro / cement sheet',
      'Rendered masonry',
      'Lightweight cladding',
      'Mixed construction',
      'Other',
    ],
    floortype: [
      'Concrete slab on ground',
      'Timber suspended floor',
      'Elevated timber (stumps)',
      'Combination slab / timber',
      'Other',
    ],
    rooftype: [
      'Colorbond metal',
      'Tiled — concrete',
      'Tiled — terracotta',
      'Corrugated iron',
      'Flat membrane',
      'Mixed',
      'Other',
    ],
    height: [
      'Single storey',
      'Double storey',
      'Split level',
      'Three storey+',
    ],
    facadedirection: [
      'North',
      'North-east',
      'East',
      'South-east',
      'South',
      'South-west',
      'West',
      'North-west',
    ],
    occupancystatus: [
      'Occupied — residential',
      'Owner occupied',
      'Tenanted',
      'Vacant',
      'Under renovation',
      'Commercial / industrial',
      'Other',
    ],
    treatmenttype: [
      'Chemical barrier — Termidor (Fipronil)',
      'Chemical barrier — Altriset (Chlorantraniliprole)',
      'Chemical barrier — Biflex (Bifenthrin)',
      'Baiting system — Exterra',
      'Baiting system — Sentricon',
      'Baiting system — Trelona',
      'Physical barrier — HomeGuard',
      'Physical barrier — Kordon',
      'Combination treatment',
      'Localised treatment only',
      'To be quoted separately',
    ],
    reinspection: [
      '3 months',
      '6 months',
      '12 months (annual)',
      '12 months — per management system spec',
      '6 months — elevated risk',
      '3 months — active infestation follow-up',
    ],
    specieslist: SPECIES_LIST,

    inspectionareas: [
      // Subfloor
      'Subfloor — general',
      'Subfloor — eastern elevation',
      'Subfloor — western elevation',
      'Subfloor — northern elevation',
      'Subfloor — southern elevation',
      'Subfloor — central',
      'Subfloor — perimeter',
      // Roof void
      'Roof void — general',
      'Roof void — eastern elevation',
      'Roof void — western elevation',
      'Roof void — northern elevation',
      'Roof void — southern elevation',
      // Internal
      'Internal — wall cavities',
      'Internal — bathroom',
      'Internal — kitchen',
      'Internal — laundry',
      'Internal — garage',
      'Internal — living areas',
      'Internal — bedrooms',
      // External
      'External — perimeter',
      'External — eastern elevation',
      'External — western elevation',
      'External — northern elevation',
      'External — southern elevation',
      // Other
      'Garden structures',
      'Fence lines',
      'Outbuildings',
      'All areas — no exclusions',
    ],

    obstructiontype: [
      'Stored goods / personal items',
      'Floor coverings',
      'Wall linings / plasterboard',
      'Fixed ceilings',
      'Thermal insulation',
      'Air conditioning ducting',
      'Furniture',
      'Safety concern — unsafe access',
      'Subfloor — insufficient clearance',
      'Subfloor — access hatch too small',
      'Subfloor — water / flooding present',
      'Roof void — insulation blanket',
      'Roof void — unsafe structure',
      'No access provided — locked',
      'Vegetation / overgrowth',
      'Earth / soil build-up',
      'Building materials / debris',
    ],

    restrictiontype: [
      'Furnished — items could not be moved',
      'Partial floor covering — some areas obscured',
      'Limited subfloor clearance — crawl inspection only',
      'Roof void — restricted by ducting',
      'Wet conditions at time of inspection',
      'Occupied property — full inspection limited',
      'Inspection distance limited — over 3.6m above ground',
      'Below ground timbers — not included in scope',
    ],

    leaklocation: [
      'Hot water system / service',
      'Roof void — general',
      'Roof — flashing failure',
      'Roof — valley / junction',
      'Wall cavity — bathroom',
      'Wall cavity — kitchen',
      'Wall cavity — laundry',
      'Wall cavity — general',
      'Subfloor — plumbing',
      'Subfloor — stormwater',
      'Subfloor — surface water ingress',
      'Air conditioning unit / condensate',
      'Downpipe / gutter overflow',
      'Shower recess — waterproofing failure',
      'External — garden irrigation',
      'External — surface drainage issue',
    ],

    existingsystem: [
      'Physical Barrier',
      'Chemical Reticulation System',
      'Termite Baiting System',
      'Combination System — Physical + Chemical',
      'System Present — Type Unidentified',
    ],
    weatherconditions: [
      'Fine and dry',
      'Overcast',
      'Light rain',
      'Heavy rain',
      'Humid',
      'Windy',
      'Other',
    ],
  };

  // Context-aware specific system names — options depend on what type was selected
  const SPECIFIC_SYSTEMS_BY_TYPE = {
    'Physical Barrier': [
      'HomeGuard Blue', 'HomeGuard DPC', 'HomeGuard TMB', 'HomeGuard GT',
      'Kordon', 'Termseal', 'Smartfilm', 'Termimesh', 'Granitgard', 'Greenzone',
    ],
    'Chemical Reticulation System': [
      'Termguard', 'Altis', 'TermX', 'TermStop', 'Camilleri', 'Cavtech', 'Reterm',
    ],
    'Termite Baiting System': [
      'Exterra', 'Sentricon', 'Trelona', 'Nemesis',
    ],
    'Combination System — Physical + Chemical': [
      'HomeGuard Blue', 'HomeGuard DPC', 'HomeGuard TMB', 'Kordon', 'Termseal',
      'Termguard', 'Altis', 'TermX', 'Exterra', 'Sentricon', 'Trelona',
    ],
    'System Present — Type Unidentified': [
      'HomeGuard Blue', 'HomeGuard DPC', 'HomeGuard TMB', 'HomeGuard GT',
      'Kordon', 'Termseal', 'Smartfilm', 'Termimesh', 'Granitgard', 'Greenzone',
      'Termguard', 'Altis', 'TermX', 'TermStop', 'Camilleri', 'Cavtech',
      'Exterra', 'Sentricon', 'Trelona', 'Nemesis',
    ],
  };

  // Dynamic lookup for specific system options based on current type selection
  if (type === 'existingsystemspecific') {
    const currentType = reportData.existingSystem || '';
    const specificOptions = SPECIFIC_SYSTEMS_BY_TYPE[currentType] || Object.values(SPECIFIC_SYSTEMS_BY_TYPE).flat().filter((v,i,a)=>a.indexOf(v)===i).sort();
    OPTIONS['existingsystemspecific'] = specificOptions;
  }
  if (OPTIONS[type]) {
    input = document.createElement('select');
    input.innerHTML = OPTIONS[type].map(o => `<option value="${o}" ${cur===o?'selected':''}>${o}</option>`).join('');
    input.addEventListener('change', () => commitEdit(el, key, input.value));
    input.addEventListener('blur',   () => commitEdit(el, key, input.value));
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = cur;
    input.placeholder = 'Type value...';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); commitEdit(el, key, input.value); }
      if (e.key === 'Escape') cancelEdit(el, key);
    });
    // No blur-to-commit on text fields — use the confirm button instead
    // (blur fires unpredictably on mobile when keyboard dismisses)

    // Build confirm / cancel action bar
    const actions = document.createElement('div');
    actions.className = 'edit-actions';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'edit-confirm-btn';
    confirmBtn.textContent = '✓ Confirm';
    confirmBtn.type = 'button';
    confirmBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      commitEdit(el, key, input.value);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'edit-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit(el, key);
    });

    actions.appendChild(confirmBtn);
    actions.appendChild(cancelBtn);

    el.innerHTML = '';
    el.appendChild(input);
    el.appendChild(actions);
    input.focus();
    input.select();
    return; // skip the generic el.innerHTML / appendChild below
  }

  el.innerHTML = '';
  el.appendChild(input);
  input.focus();
  if (input.tagName === 'INPUT') input.select();
}

// FIX: this cross-field logic (hide/reveal dependent fields, auto-fill or
// clear a field when a related one changes) used to live only inside
// commitEdit - which only runs when a TECHNICIAN manually edits a field by
// hand. But voice/AI extraction (populateFields, the app's core input
// method) writes values into reportData directly and never called any of
// this, so dictating "no moisture detected" after an earlier pass had
// recorded a water leak left reportData.waterLeaks='YES' and a leak
// location sitting there uncleared - a genuinely self-contradictory report
// (moisture: NO, but water leak: YES at a specific spot) with no visible
// sign anything was wrong. Same gap for treatmentRecommended's auto-fill.
// Pulled out into one shared function both paths call, so there's only one
// place this logic can drift out of sync again.
function applyFieldCascade(key, value, el) {
  if (key === 'standard') setStandard(value.trim(), true);

  if (key === 'existingSystem') {
    // Clear specific name when type changes — it may no longer be valid
    reportData.existingSystemOther = '';
    const specificEl = document.getElementById('f-existingSystemOther');
    if (specificEl) { specificEl.classList.remove('filled'); specificEl.textContent = '—'; }
    checkSystemVerify();
  }

  // Show water leak fields only when moisture detected = YES
  if (key === 'moistureReadings') {
    const wrap = document.getElementById('waterLeakWrap');
    if (wrap) {
      if (value === 'YES') {
        wrap.style.display = '';
      } else {
        wrap.style.display = 'none';
        // Clear water leak and location if moisture is NO
        reportData.waterLeaks = 'NO';
        reportData.leakLocation = '';
        const wlEl = document.getElementById('f-waterLeaks');
        const llEl = document.getElementById('f-leakLocation');
        const llWrap = document.getElementById('leakLocationWrap');
        if (wlEl) { wlEl.textContent = 'NO'; wlEl.classList.add('filled'); }
        if (llEl) { llEl.textContent = '—'; llEl.classList.remove('filled'); }
        if (llWrap) llWrap.style.display = 'none';
      }
    }
  }

  // Show leak location only when water leaks = YES
  if (key === 'waterLeaks') {
    const llWrap = document.getElementById('leakLocationWrap');
    if (llWrap) llWrap.style.display = value === 'YES' ? '' : 'none';
    if (value === 'NO') {
      reportData.leakLocation = '';
      const llEl = document.getElementById('f-leakLocation');
      if (llEl) { llEl.textContent = '—'; llEl.classList.remove('filled'); }
    }
  }

  // Auto-fill treatment type based on treatment required answer
  if (key === 'treatmentRecommended') {
    const typeEl = document.getElementById('f-treatmentType');
    if (value === 'NO') {
      reportData.treatmentType = 'No treatment required at this time';
      if (typeEl) { typeEl.textContent = 'No treatment required at this time'; typeEl.classList.add('filled'); }
    } else if (value === 'YES') {
      if (reportData.treatmentType === 'No treatment required at this time') {
        reportData.treatmentType = '';
        if (typeEl) { typeEl.textContent = '—'; typeEl.classList.remove('filled'); }
      }
    }
  }
}

function commitEdit(el, key, value) {
  el.classList.remove('editing');
  el.innerHTML = ''; // clear input + actions bar before re-rendering

  if (!value || !value.trim()) {
    // Nothing to save — restore previous value or show placeholder
    const prev = reportData[key];
    if (prev) renderField(el, key, prev);
    else { el.classList.remove('filled'); el.textContent = '—'; }
    activeEditEl = null;
    return;
  }

  reportData[key] = value.trim();
  applyFieldCascade(key, value.trim(), el);

  renderField(el, key, value.trim());

  const label = getFieldLabel(el);
  if (label && !label.querySelector('.edited-dot')) {
    const dot = document.createElement('span');
    dot.className = 'edited-dot';
    label.appendChild(dot);
  }

  activeEditEl = null;
  updateProgress();
  checkFindingsGate();
  checkSystemVerify();
  checkSecondaryColonyFlag();
  if (key === 'standard') {
    const sel = document.getElementById('standardSelect');
    if (sel) sel.value = value.trim();
  }
  saveDraft();
}

function cancelEdit(el, key) {
  const prev = reportData[key];
  if (prev) renderField(el, key, prev);
  else { el.classList.remove('editing','filled'); el.textContent = '—'; }
  el.classList.remove('editing');
  activeEditEl = null;
}

function commitActive() {
  if (activeEditEl && activeEditEl.classList.contains('editing')) {
    const input = activeEditEl.querySelector('input, select');
    if (input && input.value.trim()) {
      const key = activeEditEl.id.replace('f-', '');
      commitEdit(activeEditEl, key, input.value);
    } else if (input) {
      cancelEdit(activeEditEl, activeEditEl.id.replace('f-', ''));
    }
  }
}

// ── NAV ───────────────────────────────────────────────────────────────────
function showSection(name) {
  Object.keys(SECTIONS).forEach(s => {
    const el = document.getElementById('section-' + s);
    if (el) {
      if (s === name) {
        el.style.display = 'block';
        // Restart animation
        el.style.animation = 'none';
        void el.offsetWidth; // force reflow
        el.style.animation = '';
      } else {
        el.style.display = 'none';
      }
    }
    const tab = document.getElementById('tab-' + s);
    if (tab) tab.classList.toggle('active', s === name);
  });

  // Scroll active tab into view
  const activeTab = document.getElementById('tab-' + name);
  if (activeTab) activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

// ── PROGRESS ──────────────────────────────────────────────────────────────
function updateProgress() {
  // FIX: this duplicated calculateCompletion()'s old plain-presence check
  // independently, so the same bug (a routine render lazily creating a
  // placeholder finding via getFindings(), silently marking the Findings
  // tab "Complete" with a green dot and enabling its Next button even with
  // zero real finding data) showed up here too - now sharing one
  // definition (isFieldFilled) so this can't drift out of sync again.
  let filled = 0, total = 0;
  Object.entries(SECTIONS).forEach(([sec, cfg]) => {
    const f = cfg.fields.filter(k => isFieldFilled(k)).length;
    filled += f; total += cfg.total;

    const dot = document.getElementById('dot-' + sec);
    const sts = document.getElementById('sts-' + sec);
    const nextBtn = document.getElementById('next-btn-' + sec);

    if (f === 0) {
      if (dot) dot.className = 'tab-dot';
      if (sts) { sts.className = 'sec-badge empty'; sts.textContent = 'Not started'; }
      if (nextBtn) nextBtn.classList.remove('visible');
    } else if (f < cfg.total) {
      if (dot) dot.className = 'tab-dot partial';
      if (sts) { sts.className = 'sec-badge partial'; sts.textContent = 'In progress'; }
      if (nextBtn) nextBtn.classList.remove('visible');
    } else {
      if (dot) dot.className = 'tab-dot done';
      if (sts) { sts.className = 'sec-badge done'; sts.textContent = 'Complete'; }
      if (nextBtn) nextBtn.classList.add('visible');
    }
  });

  const pct = Math.round((filled / total) * 100);
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('generateBtn').disabled = filled === 0;

  const ringFill = document.getElementById('progressRingFill');
  const ringText = document.getElementById('progressRingText');
  if (ringFill && ringText) {
    const circumference = 65.97;
    const offset = circumference - (pct / 100) * circumference;
    ringFill.style.strokeDashoffset = offset;
    ringFill.classList.toggle('complete', pct === 100);
    ringText.textContent = pct + '%';
  }
}

// ── SIGNATURE PADS ──────────────────────────────────────────────────────
// Canvases use a fixed intrinsic bitmap size (640×220) regardless of their
// CSS display size, so drawing works correctly even if the pad was never
// visible at "natural" size — coordinates are scaled to the bitmap on every
// pointer event rather than relying on a resize-on-show step.
const SIGNATURE_PADS = {};
const SIG_KEY = { inspector: 'inspectorSignature', client: 'clientSignature' };
function sigCap(which) { return which.charAt(0).toUpperCase() + which.slice(1); }

function initSignaturePads() {
  ['inspector', 'client'].forEach(which => {
    const canvas = document.getElementById('sigCanvas' + sigCap(which));
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#f2f3f5';

    let drawing = false, lastX = 0, lastY = 0, hasStroke = false;

    function posFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      const pt = e.touches && e.touches.length ? e.touches[0] : e;
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return { x: (pt.clientX - rect.left) * scaleX, y: (pt.clientY - rect.top) * scaleY };
    }

    function start(e) {
      e.preventDefault();
      drawing = true; hasStroke = true;
      const p = posFromEvent(e); lastX = p.x; lastY = p.y;
      const ph = document.getElementById('sigPlaceholder' + sigCap(which));
      if (ph) ph.style.display = 'none';
    }
    function move(e) {
      if (!drawing) return;
      e.preventDefault();
      const p = posFromEvent(e);
      ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
      lastX = p.x; lastY = p.y;
    }
    function end() {
      if (!drawing) return;
      drawing = false;
      if (hasStroke) saveSignature(which);
    }

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    SIGNATURE_PADS[which] = { canvas, ctx };
  });
}

function saveSignature(which) {
  const pad = SIGNATURE_PADS[which];
  if (!pad) return;
  reportData[SIG_KEY[which]] = pad.canvas.toDataURL('image/png');
  setSignatureStatus(which, true);
  updateProgress();
  saveDraft();
}

function clearSignature(which) {
  const pad = SIGNATURE_PADS[which];
  if (!pad) return;
  pad.ctx.clearRect(0, 0, pad.canvas.width, pad.canvas.height);
  delete reportData[SIG_KEY[which]];
  const ph = document.getElementById('sigPlaceholder' + sigCap(which));
  if (ph) ph.style.display = 'flex';
  setSignatureStatus(which, false);
  updateProgress();
  saveDraft();
}

function clearAllSignaturePads() {
  ['inspector', 'client'].forEach(which => clearSignature(which));
}

function setSignatureStatus(which, signed) {
  const status = document.getElementById('sigStatus' + sigCap(which));
  if (status) {
    status.textContent = signed ? 'Signed' : 'Not signed';
    status.classList.toggle('signed', signed);
  }
}

// Redraws saved signature images onto their canvases — used after a draft
// or saved report is loaded, since reportData may now contain signatures
// captured in an earlier session.
function restoreLicenceField() {
  const el = document.getElementById('inspectorLicence');
  if (el) el.value = reportData.inspectorLicence || '';
}

function restoreSignaturePads() {
  ['inspector', 'client'].forEach(which => {
    const pad = SIGNATURE_PADS[which];
    if (!pad) return;
    const dataUrl = reportData[SIG_KEY[which]];
    pad.ctx.clearRect(0, 0, pad.canvas.width, pad.canvas.height);
    const ph = document.getElementById('sigPlaceholder' + sigCap(which));
    if (dataUrl) {
      const img = new Image();
      img.onload = () => pad.ctx.drawImage(img, 0, 0, pad.canvas.width, pad.canvas.height);
      img.src = dataUrl;
      if (ph) ph.style.display = 'none';
      setSignatureStatus(which, true);
    } else {
      if (ph) ph.style.display = 'flex';
      setSignatureStatus(which, false);
    }
  });
}

// ── PHOTO ATTACHMENTS ────────────────────────────────────────────────────
// Raw phone photos (1-5MB+) are far too large to store in localStorage at
// any realistic volume, so every photo is resized and re-encoded as a
// compressed JPEG client-side before it's ever added to reportData. A hard
// per-report cap keeps a single report from being able to exhaust the
// shared localStorage quota on its own.
const MAX_PHOTOS_PER_REPORT = 12;
const PHOTO_MAX_DIMENSION = 1280;

function genPhotoId() {
  return 'photo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Resizes/re-encodes a single File to a compressed JPEG dataURL, returning
// {dataUrl, width, height} so the PDF can preserve the correct aspect ratio
// later without needing to re-decode the image.
function compressPhotoFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode image'));
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > PHOTO_MAX_DIMENSION || h > PHOTO_MAX_DIMENSION) {
          if (w >= h) { h = Math.round(h * (PHOTO_MAX_DIMENSION / w)); w = PHOTO_MAX_DIMENSION; }
          else { w = Math.round(w * (PHOTO_MAX_DIMENSION / h)); h = PHOTO_MAX_DIMENSION; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        let dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        // Re-compress harder if a particularly busy/detailed photo still came out large
        if (dataUrl.length > 300000) dataUrl = canvas.toDataURL('image/jpeg', 0.5);
        resolve({ dataUrl, width: w, height: h });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── SECTION-AWARE PHOTO SYSTEM ─────────────────────────────────────────────
// Photos are stored per-section in reportData.photosBySection
// The old reportData.photos array is kept for backward compatibility (general photos tab)

const MAX_SECTION_PHOTOS = 6;
const SECTION_PHOTO_KEYS = ['obstructions','restrictions','findings','conducive','recommendations'];

function getSectionPhotos(section) {
  if (!reportData.photosBySection) reportData.photosBySection = {};
  if (!reportData.photosBySection[section]) reportData.photosBySection[section] = [];
  return reportData.photosBySection[section];
}

async function handleSectionPhotoFiles(fileList, section) {
  const files = Array.from(fileList || []);
  // Reset the input so the same file can be selected again
  const input = document.getElementById(`sectionPhotoInput-${section}`);
  if (input) input.value = '';
  if (!files.length) return;

  const existing = getSectionPhotos(section);
  const remaining = MAX_SECTION_PHOTOS - existing.length;
  if (remaining <= 0) { showToast(`Photo limit reached for this section (${MAX_SECTION_PHOTOS})`, 'error'); return; }
  const toProcess = files.slice(0, remaining);
  if (files.length > toProcess.length) showToast(`Only added ${toProcess.length} of ${files.length} photos`, 'warn');

  for (const file of toProcess) {
    try {
      const { dataUrl, width, height } = await compressPhotoFile(file);
      existing.push({ id: genPhotoId(), dataUrl, width, height, caption: '' });
    } catch(e) { showToast('Could not process photo', 'error'); }
  }
  renderSectionPhotoGrid(section);
  updateProgress();
  saveDraft();
}

function removeSectionPhoto(id, section) {
  if (!reportData.photosBySection?.[section]) return;
  reportData.photosBySection[section] = reportData.photosBySection[section].filter(p => p.id !== id);
  renderSectionPhotoGrid(section);
  updateProgress();
  saveDraft();
}

function updateSectionPhotoCaption(id, section, value) {
  const photos = getSectionPhotos(section);
  const photo = photos.find(p => p.id === id);
  if (photo) { photo.caption = value; saveDraft(); }
}

function renderSectionPhotoGrid(section) {
  const grid  = document.getElementById(`sectionPhotoGrid-${section}`);
  const count = document.getElementById(`sectionPhotoCount-${section}`);
  const btn   = document.getElementById(`sectionPhotoBtn-${section}`);
  if (!grid) return;
  const photos = getSectionPhotos(section);
  if (count) count.textContent = `${photos.length}/${MAX_SECTION_PHOTOS} photos`;
  if (btn) btn.disabled = photos.length >= MAX_SECTION_PHOTOS;
  if (photos.length === 0) {
    grid.innerHTML = '<div class="section-photo-empty">No photos added</div>';
    return;
  }
  grid.innerHTML = photos.map(p => `
    <div class="section-photo-card">
      <img src="${p.dataUrl}" alt="Photo">
      <div class="section-photo-body">
        <input class="photo-caption-input" type="text" placeholder="Caption…"
               value="${escapeHtml(p.caption||'')}"
               oninput="updateSectionPhotoCaption('${p.id}','${section}',this.value)">
        <button class="photo-remove-btn" onclick="removeSectionPhoto('${p.id}','${section}')">Remove</button>
      </div>
    </div>
  `).join('');
}

function renderAllSectionPhotoGrids() {
  SECTION_PHOTO_KEYS.forEach(s => renderSectionPhotoGrid(s));
}

// ── LEGACY GENERAL PHOTOS (Photos tab) ─────────────────────────────────────
async function handlePhotoFiles(fileList) {
  const files = Array.from(fileList || []);
  document.getElementById('photoFileInput').value = '';
  if (!files.length) return;

  if (!reportData.photos) reportData.photos = [];
  const remaining = MAX_PHOTOS_PER_REPORT - reportData.photos.length;
  if (remaining <= 0) { showToast(`Photo limit reached (${MAX_PHOTOS_PER_REPORT} per report)`, 'error'); return; }
  const toProcess = files.slice(0, remaining);
  if (files.length > toProcess.length) showToast(`Only added ${toProcess.length} of ${files.length} — limit reached`, 'error');

  for (const file of toProcess) {
    try {
      const { dataUrl, width, height } = await compressPhotoFile(file);
      reportData.photos.push({ id: genPhotoId(), dataUrl, width, height, caption: '' });
    } catch(e) { showToast('Could not process one of the selected photos', 'error'); }
  }
  renderPhotoGrid();
  updateProgress();
  saveDraft();
}

function removePhoto(id) {
  if (!reportData.photos) return;
  reportData.photos = reportData.photos.filter(p => p.id !== id);
  if (reportData.photos.length === 0) delete reportData.photos;
  renderPhotoGrid();
  updateProgress();
  saveDraft();
}

function updatePhotoCaption(id, value) {
  if (!reportData.photos) return;
  const photo = reportData.photos.find(p => p.id === id);
  if (photo) { photo.caption = value; saveDraft(); }
}

function renderPhotoGrid() {
  const grid = document.getElementById('photoGrid');
  const empty = document.getElementById('photoEmptyState');
  const countEl = document.getElementById('photoCount');
  const addBtn = document.getElementById('addPhotoBtn');
  if (!grid) return;

  const photos = reportData.photos || [];
  countEl.textContent = `${photos.length} of ${MAX_PHOTOS_PER_REPORT} photos attached`;
  countEl.classList.toggle('at-cap', photos.length >= MAX_PHOTOS_PER_REPORT);
  addBtn.disabled = photos.length >= MAX_PHOTOS_PER_REPORT;

  if (photos.length === 0) {
    grid.style.display = 'none';
    empty.style.display = 'block';
    grid.innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  grid.style.display = 'grid';
  grid.innerHTML = photos.map(p => `
    <div class="photo-card">
      <img src="${p.dataUrl}" alt="Inspection photo">
      <div class="photo-card-body">
        <input class="photo-caption-input" type="text" placeholder="What does this show?"
               value="${escapeHtml(p.caption || '')}"
               oninput="updatePhotoCaption('${p.id}', this.value)">
        <div class="photo-card-footer">
          <button class="photo-analyze-btn" id="analyzeBtn-${p.id}" onclick="analyzeGalleryPhoto('${p.id}')">Analyze</button>
          <button class="photo-remove-btn" onclick="removePhoto('${p.id}')">Remove</button>
        </div>
      </div>
    </div>
  `).join('');
}

// ── DRAWER & VOICE POPOVER ────────────────────────────────────────────────
function toggleDrawer() {
  const sidebar = document.getElementById('sidebarPanel');
  const overlay = document.getElementById('drawerOverlay');
  const btn = document.getElementById('hamburgerBtn');
  const dock = document.getElementById('micDock');
  const isOpen = sidebar.classList.toggle('open');
  overlay.classList.toggle('open', isOpen);
  btn.classList.toggle('open', isOpen);
  if (dock) dock.classList.toggle('drawer-is-open', isOpen);
}

function toggleJobPanel() {
  togglePanel('jobPanelToggle', 'korva_jobpanel_collapsed');
}

function togglePanel(toggleOrPanelId, storageKey) {
  // Accept either the toggle button's id (job panel) or a panel container id (saved/settings)
  let panel = document.getElementById(toggleOrPanelId);
  if (!panel) return;
  if (!panel.classList.contains('job-panel') && !panel.classList.contains('saved-panel') && !panel.classList.contains('settings-panel')) {
    panel = panel.closest('.job-panel, .saved-panel, .settings-panel');
  }
  if (!panel) return;
  const collapsed = panel.classList.toggle('collapsed');
  try { localStorage.setItem(storageKey, collapsed ? '1' : '0'); } catch (e) {}
}

function applyPanelCollapseStates() {
  try {
    if (localStorage.getItem('korva_jobpanel_collapsed') === '1') {
      document.querySelector('.job-panel').classList.add('collapsed');
    } else {
      document.querySelector('.job-panel').classList.remove('collapsed');
    }
    if (localStorage.getItem('korva_savedpanel_collapsed') === '1') {
      document.getElementById('savedPanel').classList.add('collapsed');
    } else {
      document.getElementById('savedPanel').classList.remove('collapsed');
    }
    // Settings/Accessibility/Demo panels default to collapsed; only expand if explicitly opened before
    if (localStorage.getItem('korva_settingspanel_collapsed') === '0') {
      document.getElementById('settingsPanel').classList.remove('collapsed');
    } else {
      document.getElementById('settingsPanel').classList.add('collapsed');
    }
    if (localStorage.getItem('korva_a11ypanel_collapsed') === '0') {
      document.getElementById('accessibilityPanel').classList.remove('collapsed');
    } else {
      document.getElementById('accessibilityPanel').classList.add('collapsed');
    }
    const billingPanelEl = document.getElementById('billingPanel');
    if (billingPanelEl) {
      if (localStorage.getItem('korva_billingpanel_collapsed') === '0') {
        billingPanelEl.classList.remove('collapsed');
      } else {
        billingPanelEl.classList.add('collapsed');
      }
    }
    // demoPanel: not yet built (no matching HTML section exists) — guarded
    // so it degrades silently instead of throwing inside this try block.
    const demoPanelEl = document.getElementById('demoPanel');
    if (demoPanelEl) {
      if (localStorage.getItem('korva_demopanel_collapsed') === '0') {
        demoPanelEl.classList.remove('collapsed');
      } else {
        demoPanelEl.classList.add('collapsed');
      }
    }
  } catch (e) {}
}

function toggleVoicePopover() {
  const popover = document.getElementById('voicePopover');
  const fab = document.getElementById('micFab');
  const isOpen = popover.classList.toggle('open');
  fab.classList.toggle('open', isOpen);

  // If closing while in notes-dictation mode, reset to default
  if (!isOpen && activeNotesTargetKey) {
    resetVoicePopoverToDefault();
  }

  // Stop any active recording when closing
  if (!isOpen && isRecording) {
    stopRecording();
  }
}

function initMobileView() {
  // No-op: layout is now responsive via drawer + popover for all screen sizes
}

function getFullAddress() {
  return formatAddress(
    document.getElementById('jobAddress').value.trim(),
    document.getElementById('jobSuburb').value.trim(),
    document.getElementById('jobState').value.trim(),
    document.getElementById('jobPostcode').value.trim());
}

function formatAddress(street, suburb, state, postcode) {
  const line2 = [suburb, [state, postcode].filter(Boolean).join(' ')].filter(Boolean).join(' ');
  return [street, line2].filter(Boolean).join(', ');
}

function updateJob() {
  const addr = getFullAddress();
  const headerJob = document.getElementById('headerJob');
  headerJob.textContent = addr || 'No job loaded';
  headerJob.classList.toggle('has-job', !!addr);
  document.getElementById('reportSubtitle').textContent = addr
    ? `${addr} · Speak to populate fields`
    : 'Enter job details and speak to populate fields';

  const summary = document.getElementById('jobPanelSummary');
  if (summary) {
    const client = document.getElementById('jobClient').value.trim();
    const parts = [addr, client].filter(Boolean);
    summary.textContent = parts.length ? parts.join(' · ') : 'No job set';
  }

  saveDraft();
}

// ── APPLICABLE STANDARD ──────────────────────────────────────────────────
// (updateStandard() removed — dead code, no #standardSelect element exists
// and nothing called it; setStandard() below is the real active path)

function setStandard(val, fromHeader = false) {
  reportData.standard = val;

  const el = document.getElementById('f-standard');
  if (el) renderField(el, 'standard', val);

  if (!fromHeader) {
    const sel = document.getElementById('standardSelect');
    if (sel) sel.value = val;
  }

  updateProgress();
}

// ══════════════════════════════════════════════════════════════════════════
// PERSISTENCE — SAVED REPORTS (localStorage)
// ══════════════════════════════════════════════════════════════════════════
// FIX: this used to be a single flat key shared by every signed-in account on
// a device, the same bug class as the old COMPANY_KEY. The original design
// dealt with that by WIPING this key on every sign-in/sign-out of a
// different user and relying on supabaseSyncOnOpen() to pull that account's
// reports back down from the cloud. That works eventually, but
// saveCurrentReport() pushes to the cloud in the background (non-blocking) -
// so switching accounts again within a few seconds of saving, before that
// background push has actually landed in Supabase, meant switching BACK
// showed the just-saved report as gone (confirmed live: saved "12 New
// street" on one account, switched away and back, and the dashboard dropped
// back from 5 jobs to 4 - the report never left the cloud, the LOCAL cache
// had just been wiped and the resync raced the still-in-flight save).
// Scoping this per-account like COMPANY_KEY removes the race entirely: each
// account reads its own key, which is never touched by another account
// switching in, so a just-saved report is there instantly with no network
// round trip needed to reappear.
const STORAGE_KEY = 'korva_saved_reports'; // legacy flat key, pre-multi-tenant - kept only for one-time migration below
const DRAFT_KEY = 'korva_draft';
let currentReportId = null;

function reportsStorageKey() {
  return (authUser && authUser.id) ? `korva_saved_reports_${authUser.id}` : STORAGE_KEY;
}

// One-time migration: whoever happens to be the first to sign in after this
// fix inherits whatever was sitting in the old shared flat key (there's no
// reliable way to tell which account it "belonged" to, but it was a single
// shared key before multi-tenant scoping existed, so there was only ever
// meant to be one real account's data in it on a given device). Consumes
// the legacy key so it's only ever handed out once.
function migrateLegacySavedReports() {
  if (!authUser || !authUser.id) return;
  const perUserKey = reportsStorageKey();
  try {
    if (localStorage.getItem(perUserKey)) return; // this account already has its own
    const legacy = localStorage.getItem(STORAGE_KEY);
    if (!legacy) return;
    localStorage.setItem(perUserKey, legacy);
    localStorage.removeItem(STORAGE_KEY);
  } catch(e) {}
}

// ── JOB INFO ─────────────────────────────────────────────────────────────
// Per-report job tracking fields — saved into reportData and draft.
const JOB_INFO_FIELDS = ['jobOrderId','jobInvoiceNo','jobInspectionType','jobInspectionDate','jobInspectionTime',
                          'jobReferral','jobFee','jobPaymentStatus','jobClientPhone',
                          'jobClientEmail','jobNotes'];

function saveJobInfo() {
  JOB_INFO_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) reportData[id] = el.value;
  });
  saveDraft();
}

function loadJobInfo() {
  JOB_INFO_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && reportData[id] !== undefined) el.value = reportData[id];
  });
}

function clearJobInfo() {
  JOB_INFO_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
    delete reportData[id];
  });
}
// Stored separately from report data, per-business, used on every report.
//
// FIX: this used to be a single flat key shared by every signed-in business on
// a device ('korva_company' with no business id in it at all). On a shared
// device - or simply the same browser the developer used while building the
// app - whichever business saved its letterhead details first (here, the
// original "Baz Pest Co" account) kept showing for every OTHER business that
// signed in afterwards on that same browser, including inside their generated
// PDF reports (getCompanyDetails() feeds the report cover/letterhead directly).
// Scoping the key by authBusiness.id gives each signed-in business its own
// independent record, so switching accounts can never leak one business's
// name/licence/phone/ABN/logo into another business's reports.
const COMPANY_KEY = 'korva_company'; // legacy flat key, pre-multi-tenant - kept only for one-time migration below

function companyStorageKey() {
  return (authBusiness && authBusiness.id) ? `korva_company_${authBusiness.id}` : COMPANY_KEY;
}

// One-time migration for accounts that already had data under the old flat
// key before this fix shipped. We only claim it for the business whose name
// matches what was actually stored there - otherwise we'd be guessing which
// business the legacy blob belongs to, and a wrong guess would just recreate
// the same cross-account leak this fix is meant to close. If nothing matches,
// the legacy blob is simply left in place, unused, which is harmless.
function migrateLegacyCompanyDetails() {
  if (!authBusiness || !authBusiness.id) return;
  const perBizKey = companyStorageKey();
  try {
    if (localStorage.getItem(perBizKey)) return; // this business already has its own record
    const legacy = localStorage.getItem(COMPANY_KEY);
    if (!legacy) return;
    const d = JSON.parse(legacy);
    if (d && d.name && authBusiness.name &&
        d.name.trim().toLowerCase() === authBusiness.name.trim().toLowerCase()) {
      localStorage.setItem(perBizKey, legacy);
    }
  } catch(e) {}
}

function saveCompanyDetails() {
  // Merge into the existing record rather than replacing it outright —
  // the logo (set separately, via file upload) has to survive an edit
  // to any of these text fields.
  const details = getCompanyDetails();
  details.name    = document.getElementById('companyName').value.trim();
  details.licence = document.getElementById('companyLicence').value.trim();
  details.phone   = document.getElementById('companyPhone').value.trim();
  details.abn     = document.getElementById('companyABN').value.trim();
  try { localStorage.setItem(companyStorageKey(), JSON.stringify(details)); } catch(e) {}
}

function loadCompanyDetails() {
  try {
    const stored = localStorage.getItem(companyStorageKey());
    // Always reset first - otherwise switching to a business with no saved
    // details yet would keep showing whatever the previous business left in
    // these inputs from earlier in the same page session.
    document.getElementById('companyName').value    = '';
    document.getElementById('companyLicence').value = '';
    document.getElementById('companyPhone').value   = '';
    document.getElementById('companyABN').value     = '';
    if (!stored) { renderCompanyLogoPreview(null); return; }
    const d = JSON.parse(stored);
    if (d.name)    document.getElementById('companyName').value    = d.name;
    if (d.licence) document.getElementById('companyLicence').value = d.licence;
    if (d.phone)   document.getElementById('companyPhone').value   = d.phone;
    if (d.abn)     document.getElementById('companyABN').value     = d.abn;
    renderCompanyLogoPreview(d.logo || null);
  } catch(e) {}
}

function getCompanyDetails() {
  try {
    const stored = localStorage.getItem(companyStorageKey());
    return stored ? JSON.parse(stored) : {};
  } catch(e) { return {}; }
}

const LOGO_MAX_DIMENSION = 240;

function handleCompanyLogoUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('Choose an image file', 'error');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => showToast('Could not read that file', 'error');
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => showToast('Could not read that image', 'error');
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > LOGO_MAX_DIMENSION || h > LOGO_MAX_DIMENSION) {
        if (w >= h) { h = Math.round(h * (LOGO_MAX_DIMENSION / w)); w = LOGO_MAX_DIMENSION; }
        else { w = Math.round(w * (LOGO_MAX_DIMENSION / h)); h = LOGO_MAX_DIMENSION; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/png');
      try {
        const details = getCompanyDetails();
        details.logo = dataUrl;
        details.logoWidth = w;
        details.logoHeight = h;
        localStorage.setItem(companyStorageKey(), JSON.stringify(details));
        renderCompanyLogoPreview(dataUrl);
        showToast('Logo saved', 'success');
      } catch (e) {
        showToast('Could not save logo — try a smaller image', 'error');
      }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function removeCompanyLogo() {
  const details = getCompanyDetails();
  delete details.logo;
  delete details.logoWidth;
  delete details.logoHeight;
  try { localStorage.setItem(companyStorageKey(), JSON.stringify(details)); } catch(e) {}
  renderCompanyLogoPreview(null);
}

function renderCompanyLogoPreview(dataUrl) {
  const preview = document.getElementById('companyLogoPreview');
  const removeBtn = document.getElementById('companyLogoRemoveBtn');
  if (!preview) return;
  if (dataUrl) {
    preview.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = 'Company logo';
    preview.appendChild(img);
    if (removeBtn) removeBtn.style.display = '';
  } else {
    preview.innerHTML = '<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L5 21"/></svg>';
    if (removeBtn) removeBtn.style.display = 'none';
  }
}
// Reports save to localStorage first (instant) then sync to Supabase in the
// background. The app works fully offline — Supabase is backup/cloud copy.
const SUPABASE_URL  = 'https://bmjgvogxutwyeklxxeao.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtamd2b2d4dXR3eWVrbHh4ZWFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0NTczMTEsImV4cCI6MjEwNTAzMzMxMX0.Ov8xGhDMuAbUcWy7zbCiS01D6QCrlhDYxza3Fzls83U';

// ── AUTH STATE ───────────────────────────────────────────────────────────
let authSession  = null;   // current Supabase session
let authUser     = null;   // current user object
let authBusiness = null;   // current business object
let pendingRecoverySession = null; // { access_token, refresh_token } from a password-reset email link, until submitted
let teamMembersCache = []; // last-loaded team roster, reused by the job-assignment dropdown

function getAuthToken() {
  return authSession?.access_token || SUPABASE_KEY;
}

function getAuthHeaders(extra = {}) {
  const token = getAuthToken();
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${token}`,
    ...extra,
  };
}

// ── SESSION PERSISTENCE ──────────────────────────────────────────────────
function saveSession(session) {
  try {
    localStorage.setItem('korva_session', JSON.stringify(session));
  } catch(e) {}
}

function loadSession() {
  try {
    const s = localStorage.getItem('korva_session');
    return s ? JSON.parse(s) : null;
  } catch(e) { return null; }
}

function clearSession() {
  try { localStorage.removeItem('korva_session'); } catch(e) {}
  authSession = null; authUser = null; authBusiness = null;
  resetBillingDisplay();
}

// ── BILLING / STRIPE ─────────────────────────────────────────────────────
// Talks to the new /stripe/* routes on the same Worker that already proxies
// AI calls (see korva-worker-with-stripe.js). NOT live until that Worker
// version is deployed and real Stripe keys/price IDs are configured — until
// then these calls will fail gracefully and the UI explains why instead of
// breaking silently.
const KORVA_WORKER_URL = 'https://korva.byronguyatt2.workers.dev';
let billingStatusCache = null;

function resetBillingDisplay() {
  const el = document.getElementById('billingStatusText');
  if (el) el.textContent = 'Sign in to see your plan.';
  const manageBtn = document.getElementById('manageBillingBtn');
  if (manageBtn) manageBtn.style.display = 'none';
  billingStatusCache = null;
}

async function loadBillingStatus() {
  const el = document.getElementById('billingStatusText');
  const manageBtn = document.getElementById('manageBillingBtn');
  if (!authUser) return;
  if (el) el.textContent = 'Loading…';
  try {
    const res = await fetch(`${KORVA_WORKER_URL}/stripe/subscription-status`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + getAuthToken() },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const sub = await res.json();
    billingStatusCache = sub;
    const planLabel = (sub.plan || 'trial').charAt(0).toUpperCase() + (sub.plan || 'trial').slice(1);
    if (el) {
      if (sub.status === 'trialing') {
        const daysLeft = sub.trial_ends_at ? Math.max(0, Math.ceil((new Date(sub.trial_ends_at) - Date.now()) / 86400000)) : null;
        el.textContent = `Free trial${daysLeft !== null ? ` — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : ''} · ${sub.ai_calls_used_this_period ?? 0}/${sub.limit ?? '?'} AI extractions used`;
      } else {
        el.textContent = `${planLabel} plan — ${sub.ai_calls_used_this_period ?? 0}/${sub.limit ?? '?'} AI extractions used this period`;
      }
    }
    if (manageBtn) manageBtn.style.display = sub.stripe_customer_id ? '' : 'none';
  } catch (e) {
    // Expected right now — the Stripe Worker routes aren't deployed yet.
    // Fails quietly to a plain message rather than breaking the Billing panel.
    if (el) el.textContent = 'Billing isn\'t set up yet — check back soon.';
    console.warn('loadBillingStatus unavailable (expected until Stripe Worker is deployed):', e.message);
  }
}

// Strips any existing query string / hash and attaches a `billing=` marker
// so handleBillingReturn() can tell, on the way back from Stripe, whether
// checkout succeeded or was cancelled and react accordingly.
function billingReturnUrl(marker) {
  return window.location.origin + window.location.pathname + '?billing=' + marker;
}

async function openCheckout(plan) {
  if (!authUser) { showToast('Sign in first', 'error'); return; }
  try {
    const res = await fetch(`${KORVA_WORKER_URL}/stripe/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
      body: JSON.stringify({
        plan,
        successUrl: billingReturnUrl('success'),
        cancelUrl: billingReturnUrl('cancelled'),
      }),
    });
    const rawBody = await res.text();
    let data;
    try { data = JSON.parse(rawBody); } catch { throw new Error(rawBody.slice(0, 200) || `HTTP ${res.status}`); }
    if (!res.ok || !data.url) throw new Error(data && data.message || rawBody || `HTTP ${res.status}`);
    window.location.href = data.url;
  } catch (e) {
    showToast('Billing isn\'t fully set up yet — try again once Stripe is connected.', 'error');
    console.warn('openCheckout failed (expected until Stripe is configured):', e.message);
  }
}

// Called once on app entry — notices if we've just been bounced back from
// a Stripe Checkout or Billing Portal redirect (see billingReturnUrl above)
// and reacts: toast + refresh the plan display, then scrubs the marker out
// of the URL so refreshing the page doesn't re-show the toast.
function handleBillingReturn() {
  try {
    const params = new URLSearchParams(window.location.search);
    const billing = params.get('billing');
    if (!billing) return;

    if (billing === 'success') {
      showToast('Subscription updated — thanks!', 'success');
      loadBillingStatus();
    } else if (billing === 'cancelled') {
      showToast('Checkout cancelled — no changes made', 'info');
    } else if (billing === 'updated') {
      loadBillingStatus();
    }

    params.delete('billing');
    const newSearch = params.toString();
    history.replaceState(null, '', window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash);
  } catch (e) {
    console.warn('handleBillingReturn error:', e.message);
  }
}

async function openBillingPortal() {
  if (!authUser) { showToast('Sign in first', 'error'); return; }
  try {
    const res = await fetch(`${KORVA_WORKER_URL}/stripe/create-portal-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
      body: JSON.stringify({ returnUrl: billingReturnUrl('updated') }),
    });
    const rawBody = await res.text();
    let data;
    try { data = JSON.parse(rawBody); } catch { throw new Error(rawBody.slice(0, 200) || `HTTP ${res.status}`); }
    if (!res.ok || !data.url) throw new Error(data && data.message || rawBody || `HTTP ${res.status}`);
    window.location.href = data.url;
  } catch (e) {
    showToast('Could not open billing portal — try again shortly.', 'error');
    console.warn('openBillingPortal failed:', e.message);
  }
}

// ── AUTH API CALLS ───────────────────────────────────────────────────────
async function supabaseAuth(endpoint, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // FIX: callers (signIn/signUp) were written against the older OAuth2-style
  // error shape ({error: {message: '...'}}) and checked `if (data.error)`.
  // Supabase Auth's current API returns failures as {code, error_code, msg}
  // instead - there is no `.error` property at all - so a wrong password or
  // nonexistent account was falling through the `if (data.error)` check as
  // if it were a successful login, then crashing on `data.user.id` (data.user
  // is undefined on an error response), which got caught by the generic
  // try/catch and mislabeled as "Network error — please try again." Every
  // failed sign-in hit this, 100% reproducibly, regardless of connectivity.
  // Normalizing here means every existing `data.error` / `data.error.message`
  // check downstream keeps working, whichever shape Supabase actually sent.
  if (!res.ok && !data.error) {
    data.error = {
      code: data.error_code || (typeof data.error === 'string' ? data.error : null),
      message: data.msg || data.error_description || 'Request failed',
    };
  }
  return data;
}

// ── PASSWORD RESET (via emailed recovery link) ───────────────────────────
// Supabase's "forgot password" email links back to this app with
// #access_token=...&refresh_token=...&type=recovery in the URL hash. Read it
// once at boot, then let the user set a new password with it.
function parseRecoveryHash() {
  const hash = window.location.hash || '';
  if (!hash || hash.indexOf('type=recovery') === -1) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const access_token = params.get('access_token');
  if (!access_token) return null;
  return { access_token, refresh_token: params.get('refresh_token') || null };
}

async function submitPasswordReset() {
  const pw     = document.getElementById('rpPassword').value;
  const pw2    = document.getElementById('rpPasswordConfirm').value;
  const errEl  = document.getElementById('rpError');
  const btn    = document.getElementById('rpBtn');

  errEl.textContent = '';
  if (!pw || pw.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  if (pw !== pw2) { errEl.textContent = 'Passwords do not match.'; return; }
  if (!pendingRecoverySession?.access_token) {
    errEl.textContent = 'This reset link has expired — please request a new one.';
    return;
  }

  btn.disabled = true; btn.textContent = 'Updating…';
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${pendingRecoverySession.access_token}`,
      },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errEl.textContent = data.msg || data.error_description || data.error?.message || 'Could not update password — the link may have expired.';
      return;
    }
    pendingRecoverySession = null;
    document.getElementById('rpPassword').value = '';
    document.getElementById('rpPasswordConfirm').value = '';
    showAuth('authSignIn');
    showToast('Password updated — sign in with your new password', 'success');
  } catch(e) {
    errEl.textContent = 'Network error — please try again.';
  } finally {
    btn.disabled = false; btn.textContent = 'Update Password';
  }
}

async function refreshSession(refreshToken) {
  try {
    const data = await supabaseAuth('token?grant_type=refresh_token', { refresh_token: refreshToken });
    if (data.access_token) {
      authSession = data;
      saveSession(data);
      return true;
    }
  } catch(e) {}
  return false;
}

// ── BACKGROUND AUTH REFRESH ──────────────────────────────────────────────
// Supabase access tokens are short-lived (~1hr). Inspectors often keep the
// app open for an entire job (or a full day in the field) without ever
// reloading it, which previously meant the token would silently expire
// mid-session and every Supabase call would start failing with no retry.
// This keeps the session alive proactively so that never happens.
let authAutoRefreshTimer = null;
const AUTH_AUTO_REFRESH_CHECK_MS = 5 * 60 * 1000;   // re-check every 5 minutes
const AUTH_REFRESH_LEAD_SECONDS  = 10 * 60;         // refresh once within 10 min of expiry

async function maybeRefreshAuthSession() {
  if (!authSession?.refresh_token) return;
  const exp = authSession.expires_at || 0;
  const now = Math.floor(Date.now() / 1000);
  if (now > exp - AUTH_REFRESH_LEAD_SECONDS) {
    await refreshSession(authSession.refresh_token);
  }
}

function startAuthAutoRefresh() {
  stopAuthAutoRefresh();
  authAutoRefreshTimer = setInterval(maybeRefreshAuthSession, AUTH_AUTO_REFRESH_CHECK_MS);
}

function stopAuthAutoRefresh() {
  if (authAutoRefreshTimer) { clearInterval(authAutoRefreshTimer); authAutoRefreshTimer = null; }
}

// ── SIGN UP ──────────────────────────────────────────────────────────────
async function signUp() {
  const name     = document.getElementById('suName').value.trim();
  const business = document.getElementById('suBusiness').value.trim();
  const email    = document.getElementById('suEmail').value.trim();
  const password = document.getElementById('suPassword').value;
  const errEl    = document.getElementById('suError');
  const btn      = document.getElementById('suBtn');

  errEl.textContent = '';
  if (!name || !business || !email || !password) { errEl.textContent = 'Please fill in all fields.'; return; }
  if (password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }

  btn.disabled = true; btn.textContent = 'Creating account…';
  try {
    // Store business name locally — survives the email confirmation redirect
    localStorage.setItem('korva_pending_business', business);

    const data = await supabaseAuth('signup', {
      email, password,
      data: { name, business_name: business },
    });
    if (data.error) { errEl.textContent = data.error.message || 'Sign up failed.'; return; }

    if (data.access_token) {
      // Email confirmation is disabled on this project, so Supabase already handed back
      // a working session — log the new user straight in instead of telling them to check
      // an email that will never need to arrive.
      authSession = data;
      authUser    = data.user;
      saveSession(data);
      localStorage.setItem('korva_last_user_id', data.user.id);

      await checkAndAcceptInvite();
      await loadBusiness();
      startAuthAutoRefresh();
      enterApp();
      return;
    }

    // Fallback for if email confirmation is ever turned back on for this project —
    // Supabase then returns a user with no session until the confirmation link is clicked.
    document.getElementById('authConfirmEmail').textContent = email;
    showAuth('authConfirm');
  } catch(e) {
    errEl.textContent = 'Network error — please try again.';
  } finally {
    btn.disabled = false; btn.textContent = 'Create Account';
  }
}

// ── SIGN IN ──────────────────────────────────────────────────────────────
async function signIn() {
  const email    = document.getElementById('siEmail').value.trim();
  const password = document.getElementById('siPassword').value;
  const errEl    = document.getElementById('siError');
  const btn      = document.getElementById('siBtn');

  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Please enter your email and password.'; return; }

  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const data = await supabaseAuth('token?grant_type=password', { email, password });
    if (data.error) {
      // Branch on the stable error code, not the message text, which Supabase
      // can reword between API versions (see supabaseAuth()'s normalization).
      errEl.textContent = data.error.code === 'invalid_credentials' || data.error.message === 'Invalid login credentials'
        ? 'Incorrect email or password.' : (data.error.message || 'Sign in failed.');
      return;
    }
    authSession = data;
    authUser    = data.user;
    saveSession(data);

    // Saved reports are now scoped per-account (reportsStorageKey()), so a
    // different user signing in on this device simply reads their OWN key -
    // nothing to wipe here any more. An in-progress unsaved draft is still
    // cleared, since that one genuinely shouldn't follow a different account.
    const prevUserId = localStorage.getItem('korva_last_user_id');
    if (prevUserId && prevUserId !== data.user.id) {
      localStorage.removeItem(DRAFT_KEY);
    }
    localStorage.setItem('korva_last_user_id', data.user.id);

    await checkAndAcceptInvite();
    await loadBusiness();
    startAuthAutoRefresh();
    enterApp();
  } catch(e) {
    errEl.textContent = 'Network error — please try again.';
  } finally {
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

// ── FORGOT PASSWORD ──────────────────────────────────────────────────────
async function forgotPassword() {
  const email = document.getElementById('fpEmail').value.trim();
  const errEl = document.getElementById('fpError');
  const btn   = document.getElementById('fpBtn');

  errEl.textContent = '';
  if (!email) { errEl.textContent = 'Enter your email address.'; return; }

  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    // Send the reset link back to wherever this app is currently being served
    // from, so clicking it in the user's email returns them straight to the
    // in-app "set a new password" screen instead of a dead end.
    const redirectTo = encodeURIComponent(window.location.origin + window.location.pathname);
    await fetch(`${SUPABASE_URL}/auth/v1/recover?redirect_to=${redirectTo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY },
      body: JSON.stringify({ email }),
    });
    errEl.style.color = 'var(--green)';
    errEl.textContent = 'Reset link sent — check your email.';
  } catch(e) {
    errEl.textContent = 'Network error — please try again.';
  } finally {
    btn.disabled = false; btn.textContent = 'Send Reset Link';
  }
}

// ── SIGN OUT ─────────────────────────────────────────────────────────────
async function signOut() {
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${getAuthToken()}` },
    });
  } catch(e) {}
  stopAuthAutoRefresh();
  clearSession();
  localStorage.removeItem('korva_last_user_id');
  // Saved reports are scoped per-account now (reportsStorageKey()) and stay
  // put under their own key when you sign out - exactly like company
  // details already did - so they're instantly there again next time you
  // sign back in, with no dependency on a fresh cloud pull landing in time.
  localStorage.removeItem(DRAFT_KEY);
  document.getElementById('mainMenu').style.display  = 'none';
  document.getElementById('app').style.display       = 'none';
  document.getElementById('authScreen').style.display = 'flex';
  showAuth('authSignIn');
}

// Makes sure the current user has a team_members row for authBusiness.
// Needed because older accounts could end up with a business but no
// team_members row (e.g. the insert silently failed before the RLS fix).
// Safe to call repeatedly — it's a no-op once the row exists.
async function ensureOwnerTeamMember() {
  try {
    const chk = await fetch(
      `${SUPABASE_URL}/rest/v1/team_members?business_id=eq.${authBusiness.id}&user_id=eq.${authUser.id}&limit=1`,
      { headers: getAuthHeaders() }
    );
    if (!chk.ok) return;
    const rows = await chk.json();
    if (rows.length > 0) return; // already there
    const meta = authUser.user_metadata || {};
    await fetch(`${SUPABASE_URL}/rest/v1/team_members`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        business_id: authBusiness.id,
        user_id: authUser.id,
        role: 'owner',
        name: meta.name || authUser.email,
        email: authUser.email,
      }),
    });
  } catch(e) { console.warn('ensureOwnerTeamMember error:', e); }
}

// ── BUSINESS LOAD ────────────────────────────────────────────────────────
// FIX: loadBusiness() used to be a plain check-then-create with no lock -
// "is authBusiness already set? no -> look for an existing business row ->
// none found -> create one." Two overlapping calls (confirmed live: sign-in
// retried minutes apart after the team_members 500 below made it LOOK like
// something had failed, each a fresh call since authBusiness resets on
// reload) could both pass the "none found" check before either one's POST
// landed, and both would create a business row for the same owner - exactly
// what happened to two of the real test accounts (two "Korva Pest Control"
// rows, two "JC Pest Control" rows, same owner_id each time, confirmed via
// the businesses table and edge_logs). There's also no unique constraint on
// businesses.owner_id at the database level, so nothing stopped it there
// either. This in-flight lock makes every call for the same page session
// share one real attempt instead of racing - a second caller just awaits
// the first one's result instead of starting its own.
let _loadBusinessInFlight = null;
async function loadBusiness() {
  if (!authUser) return;
  if (authBusiness) return; // already loaded (e.g. by checkAndAcceptInvite) — don't overwrite it
  if (_loadBusinessInFlight) return _loadBusinessInFlight;
  _loadBusinessInFlight = _loadBusinessImpl().finally(() => { _loadBusinessInFlight = null; });
  return _loadBusinessInFlight;
}
async function _loadBusinessImpl() {
  try {
    // First try to find existing business for this user (as owner)
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/businesses?owner_id=eq.${authUser.id}&limit=1`,
      { headers: getAuthHeaders() }
    );
    if (res.ok) {
      const rows = await res.json();
      if (rows.length > 0) {
        authBusiness = rows[0];
        await ensureOwnerTeamMember();
        loadBillingStatus();
        return;
      }
    }

    // Not an owner — check if they're already a team member of someone
    // else's business (a returning technician, whose invite was accepted
    // in an earlier session, so there's no pending invite left to catch this)
    const tmRes = await fetch(
      `${SUPABASE_URL}/rest/v1/team_members?user_id=eq.${authUser.id}&limit=1`,
      { headers: getAuthHeaders() }
    );
    if (tmRes.ok) {
      const tmRows = await tmRes.json();
      if (tmRows.length > 0) {
        const bizRes = await fetch(
          `${SUPABASE_URL}/rest/v1/businesses?id=eq.${tmRows[0].business_id}&limit=1`,
          { headers: getAuthHeaders() }
        );
        if (bizRes.ok) {
          const bizRows = await bizRes.json();
          if (bizRows.length > 0) {
            authBusiness = bizRows[0];
            loadBillingStatus();
            return;
          }
        }
      }
    }

    // No business found — try to create one
    // Get business name from: signup metadata → localStorage → email prefix
    const meta = authUser.user_metadata || {};
    const storedName = localStorage.getItem('korva_pending_business');
    const bizName = meta.business_name || storedName ||
                    authUser.email.split('@')[0].replace(/[^a-zA-Z0-9 ]/g,' ').trim();

    const cr = await fetch(`${SUPABASE_URL}/rest/v1/businesses`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Prefer': 'return=representation' },
      body: JSON.stringify({ name: bizName, owner_id: authUser.id }),
    });

    if (cr.ok) {
      const created = await cr.json();
      authBusiness = Array.isArray(created) ? created[0] : created;
      localStorage.removeItem('korva_pending_business');

      // Add owner as team member
      await fetch(`${SUPABASE_URL}/rest/v1/team_members`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          business_id: authBusiness.id,
          user_id: authUser.id,
          role: 'owner',
          name: meta.name || authUser.email,
          email: authUser.email,
        }),
      });
      loadBillingStatus();
    }
  } catch(e) { console.warn('loadBusiness error:', e); }
}

// ── ENTER APP ─────────────────────────────────────────────────────────────
function enterApp() {
  document.getElementById('authScreen').style.display   = 'none';
  document.getElementById('onboardScreen').style.display = 'none';
  handleBillingReturn(); // notice + clean up a return from Stripe Checkout/Portal, if that's why we're here

  // FIX: a DIFFERENT account just became active than whichever one was last
  // active in this browser tab (sign out, then sign back in as someone else,
  // with no page reload in between). signIn()'s "previous user" check only
  // clears localStorage (STORAGE_KEY/DRAFT_KEY) - it never touches the LIVE
  // in-memory reportData object, the already-rendered form fields, or
  // currentReportId, because those only exist once the Inspect module has
  // been opened (appInitialised). Left alone, the new account would see the
  // previous account's open report (job/client details, property fields,
  // findings, everything) still sitting on screen, and worse: saving under
  // the new account would reuse the PREVIOUS account's currentReportId,
  // which Supabase's RLS then silently rejects on sync (it updates a report
  // row owned by a different user) - the local save still looks successful,
  // but the cloud copy never lands, which is exactly the "report didn't save
  // onto this account" behaviour found during live testing. Forcing a full
  // reset here - the same reset newReport() does - closes all of that off.
  if (appInitialised && authUser && lastActiveAccountUserId && lastActiveAccountUserId !== authUser.id) {
    resetReportState();
    document.getElementById('jobAddress').value = '';
    document.getElementById('jobSuburb').value = '';
    document.getElementById('jobState').value = '';
    document.getElementById('jobPostcode').value = '';
    document.getElementById('jobClient').value = '';
    document.getElementById('jobInspector').value = '';
    updateJob();
    currentReportId = null;
    clearDraft();
    // Saved reports are scoped per-account (reportsStorageKey()), same as
    // company details - no wipe needed here any more. An earlier version of
    // this fix DID wipe the list here and relied on supabaseSyncOnOpen() to
    // pull it back from the cloud, but that raced saveCurrentReport()'s
    // non-blocking background push: switching away and back again within a
    // few seconds of saving could show the just-saved report as missing,
    // because the local copy had just been deleted and the cloud copy
    // hadn't landed yet. Per-account keys mean nothing ever gets deleted on
    // a switch - the previous account's reports stay exactly where they
    // were, under their own key, completely untouched.
    renderSavedList();
  }
  lastActiveAccountUserId = authUser ? authUser.id : lastActiveAccountUserId;

  // One-time claim of whatever was sitting in the old shared flat key,
  // same idea as migrateLegacyCompanyDetails() below. Harmless no-op once
  // this account already has its own per-user key (which it will, after
  // the first time this runs).
  migrateLegacySavedReports();

  if (authBusiness) {
    // Claim any pre-fix legacy data for this business, then load this
    // business's own (now correctly per-id scoped) record. loadCompanyDetails()
    // clears the inputs before loading, which matters here: signOut() doesn't
    // reload the page or reset these fields, so without that clear, switching
    // accounts in one browser tab without a refresh would otherwise carry the
    // PREVIOUS business's still-filled-in company inputs into this business's
    // first save.
    migrateLegacyCompanyDetails();
    loadCompanyDetails();
    if (!document.getElementById('companyName').value) {
      document.getElementById('companyName').value = authBusiness.name || '';
      saveCompanyDetails();
    }
  }
  renderProfileMenu();
  loadTeam();
  migrateLocalReportsToCloud();

  // FIX: this was the actual cause of "reports aren't saving after logging
  // out" (it isn't a server problem — the reports were always safely in
  // Supabase the whole time, confirmed directly against the database).
  // supabaseSyncOnOpen() is what pulls an account's cloud-saved reports
  // DOWN into this device's local list so the Dashboard can show them — but
  // it only ever lived inside openApp('inspect')'s one-time setup block,
  // which runs once per browser tab no matter how many times someone signs
  // out and back in without a full page reload. So: the FIRST account
  // opened in a tab got its cloud reports pulled down once, same as always
  // - but every account after that (a different account switching in, OR
  // the same account signing out and back in, since signOut() wipes the
  // local report list on purpose) got NOTHING re-downloaded, and the
  // Dashboard correctly-but-misleadingly reported "No saved reports yet on
  // this device." Calling it here too means every real sign-in restores
  // that account's cloud reports to this device, not just the first one.
  supabaseSyncOnOpen();

  // New users see onboarding; returning users go straight to the menu
  if (shouldShowOnboarding()) {
    showOnboarding();
  } else {
    document.getElementById('mainMenu').style.display = 'flex';
  }
}

function renderProfileMenu() {
  if (!authUser) return;
  const meta = authUser.user_metadata || {};
  const name = meta.name || authUser.email.split('@')[0];
  const initials = name.trim().split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase() || '?';
  const initialsEl = document.getElementById('profileInitials');
  if (initialsEl) initialsEl.textContent = initials;
  const nameEl = document.getElementById('profileName');
  if (nameEl) nameEl.textContent = name;
  const emailEl = document.getElementById('profileEmail');
  if (emailEl) emailEl.textContent = authUser.email;
  const bizRow = document.getElementById('profileBusinessRow');
  if (bizRow) {
    if (authBusiness) {
      const isOwner = authBusiness.owner_id === authUser.id;
      document.getElementById('profileBusinessName').textContent = authBusiness.name || '';
      const badge = document.getElementById('profileRoleBadge');
      badge.textContent = isOwner ? 'Owner' : 'Technician';
      badge.className = 'profile-role-badge ' + (isOwner ? 'owner' : 'technician');
      bizRow.style.display = 'flex';
    } else {
      bizRow.style.display = 'none';
    }
  }
}
function toggleProfileMenu() {
  const dd = document.getElementById('profileDropdown');
  if (!dd) return;
  const opening = !dd.classList.contains('open');
  dd.classList.toggle('open', opening);
  if (opening) {
    renderProfileMenu();
    setTimeout(() => document.addEventListener('click', handleProfileMenuOutsideClick), 0);
  } else {
    document.removeEventListener('click', handleProfileMenuOutsideClick);
  }
}
function handleProfileMenuOutsideClick(e) {
  const wrap = document.getElementById('profileMenuWrap');
  if (wrap && !wrap.contains(e.target)) closeProfileMenu();
}
function closeProfileMenu() {
  const dd = document.getElementById('profileDropdown');
  if (dd) dd.classList.remove('open');
  document.removeEventListener('click', handleProfileMenuOutsideClick);
}
function openSettingsFromProfile() {
  closeProfileMenu();
  const sidebar = document.getElementById('sidebarPanel');
  if (sidebar && !sidebar.classList.contains('open')) toggleDrawer();
  const panel = document.getElementById('settingsPanel');
  if (panel && panel.classList.contains('collapsed')) {
    togglePanel('settingsPanel', 'korva_settingspanel_collapsed');
  }
  setTimeout(() => { if (panel) panel.scrollIntoView({behavior:'smooth', block:'start'}); }, 250);
}
function signOutFromProfile() {
  closeProfileMenu();
  if (confirm('Sign out of KORVUS?')) signOut();
}

// ── AUTH UI HELPERS ──────────────────────────────────────────────────────
function showAuth(panel) {
  ['authSignIn','authSignUp','authForgot','authConfirm','authResetPassword'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === panel ? 'flex' : 'none';
  });
  // Fix: ensure displayed card uses flex column
  const active = document.getElementById(panel);
  if (active) active.style.flexDirection = 'column';
}

// ── SESSION RESTORE ON LOAD ──────────────────────────────────────────────
async function restoreAuthSession() {
  const stored = loadSession();
  if (!stored?.access_token) return false;

  // Check if token is still valid (exp is in seconds)
  const exp = stored.expires_at || 0;
  const now = Math.floor(Date.now() / 1000);

  if (now < exp - 60) {
    authSession = stored;
    authUser    = stored.user;
    // Saved reports are scoped per-account (reportsStorageKey()) - nothing
    // to clear here for a switched user any more, just the unsaved draft.
    const prevUserId = localStorage.getItem('korva_last_user_id');
    if (prevUserId && prevUserId !== stored.user?.id) {
      localStorage.removeItem(DRAFT_KEY);
    }
    if (stored.user?.id) localStorage.setItem('korva_last_user_id', stored.user.id);
    await loadBusiness();
    startAuthAutoRefresh();
    return true;
  }

  // Try to refresh
  if (stored.refresh_token) {
    const ok = await refreshSession(stored.refresh_token);
    if (ok) {
      authUser = authSession.user;
      await loadBusiness();
      startAuthAutoRefresh();
      return true;
    }
  }

  clearSession();
  return false;
}

// ── STABLE DEVICE ID (still used as fallback) ────────────────────────────
function getDeviceId() {
  let id = localStorage.getItem('korva_device_id');
  if (!id) {
    id = 'dev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    localStorage.setItem('korva_device_id', id);
  }
  return id;
}

// ── SUPABASE REPORT SYNC (now auth-aware) ────────────────────────────────
async function supabaseSave(entry) {
  if (!authSession) return; // only sync when authenticated
  try {
    const row = {
      device_id:   getDeviceId(),
      user_id:     authUser?.id || null,
      business_id: authBusiness?.id || null,
      report_id:   entry.id,
      address:     entry.address || null,
      client:      entry.client || null,
      inspector:   entry.inspector || null,
      saved_at:    new Date(entry.savedAt).toISOString(),
      data:        entry,
    };
    // FIX: this POST previously had no on_conflict target, so
    // Prefer: resolution=merge-duplicates had nothing to tell it which
    // unique constraint to upsert against (report_id is unique, but the
    // request never said so, and id - the real primary key - isn't in the
    // payload at all). The first save of a report (brand new report_id)
    // always worked, a plain 201 insert. But re-saving the SAME report
    // (e.g. "add more stuff" after already saving once) tried another
    // plain insert, hit reports_report_id_key, and Postgres/PostgREST
    // rejected it with 409 - confirmed live in production logs
    // (POST | 409 | .../rest/v1/reports). That 409 does trigger the
    // "could not sync to your account" toast below, but to the user it
    // just looked like "reports aren't saving" since the whole point of
    // re-saving is to update the existing one. on_conflict=report_id makes
    // this a real upsert: same report_id updates the existing row instead
    // of colliding with it.
    const res = await fetch(`${SUPABASE_URL}/rest/v1/reports?on_conflict=report_id`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.warn('Supabase save failed:', detail);
      // FIX: this used to fail completely silently - "Report saved" already
      // showed from the local save, so a rejected cloud sync (e.g. RLS
      // blocking a write to a report row that doesn't belong to the current
      // account/business) was invisible until someone noticed the report
      // missing elsewhere. Surface it so "saved" never quietly means
      // "saved on this device only, and the server said no."
      showToast('Saved on this device, but could not sync to your account', 'error');
      updateSyncStatus('cloud_error');
    }
  } catch(e) {
    console.warn('Supabase sync error:', e.message);
    showToast('Saved on this device, but could not sync to your account', 'error');
    updateSyncStatus('cloud_error');
  }
}

// ── ONE-TIME MIGRATION: reports saved locally before auth was enabled ──────
// (e.g. anything created while login was bypassed) never made it to
// Supabase, since supabaseSave() no-ops without a session. Push them up
// the first time each device gets a real logged-in session, so nothing
// from that period is silently orphaned on one device.
async function migrateLocalReportsToCloud() {
  if (!authSession) return;
  const MIGRATION_KEY = 'korva_local_migrated_v1';
  if (localStorage.getItem(MIGRATION_KEY)) return;

  try {
    const local = getSavedReports();
    if (local.length > 0) {
      for (const entry of local) {
        await supabaseSave(entry);
      }
      showToast(`Backed up ${local.length} local report${local.length > 1 ? 's' : ''} to your account`, 'info');
    }
  } catch (e) {
    console.warn('Local report migration failed:', e.message);
    return; // don't set the flag — try again next session
  }
  localStorage.setItem(MIGRATION_KEY, '1');
}

async function supabaseDelete(reportId) {
  if (!authSession) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/reports?report_id=eq.${encodeURIComponent(reportId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
  } catch(e) { console.warn('Supabase delete error:', e.message); }
}

async function supabaseLoadAll() {
  if (!authSession) return null;
  try {
    const filter = authUser?.id
      ? `user_id=eq.${authUser.id}&order=saved_at.desc`
      : `device_id=eq.${encodeURIComponent(getDeviceId())}&order=saved_at.desc`;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/reports?${filter}`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows.map(r => r.data);
  } catch(e) { console.warn('Supabase load error:', e.message); return null; }
}

async function supabaseSyncOnOpen() {
  if (!authSession) return;
  const cloudReports = await supabaseLoadAll();
  if (!cloudReports || cloudReports.length === 0) return;
  const local = getSavedReports();
  const localIds = new Set(local.map(r => r.id));
  const newFromCloud = cloudReports.filter(r => !localIds.has(r.id));
  if (newFromCloud.length > 0) {
    const merged = [...newFromCloud, ...local].sort((a,b) => (b.savedAt||0) - (a.savedAt||0));
    setSavedReports(merged);
    renderSavedList();
    showToast(`Restored ${newFromCloud.length} report${newFromCloud.length > 1 ? 's' : ''} from cloud`, 'info');
  }
}

// saveDraft() is called on nearly every keystroke and on every signature
// stroke, so it's debounced into a single write a short delay after the
// last call rather than writing to localStorage on every individual event.
// flushDraftSave() does the real work and is also called directly when the
// page is about to be hidden/closed, so a debounce in progress is never
// lost if the technician backgrounds or closes the app mid-edit.
let saveDraftTimer = null;
let saveDraftFailureNotified = false;
const SAVE_DRAFT_DEBOUNCE_MS = 400;

function saveDraft() {
  if (saveDraftTimer) clearTimeout(saveDraftTimer);
  saveDraftTimer = setTimeout(flushDraftSave, SAVE_DRAFT_DEBOUNCE_MS);
}

function flushDraftSave() {
  if (saveDraftTimer) { clearTimeout(saveDraftTimer); saveDraftTimer = null; }
  try {
    const draft = {
      jobAddress: document.getElementById('jobAddress').value,
      jobSuburb: document.getElementById('jobSuburb').value,
      jobState: document.getElementById('jobState').value,
      jobPostcode: document.getElementById('jobPostcode').value,
      jobClient: document.getElementById('jobClient').value,
      jobInspector: document.getElementById('jobInspector').value,
      reportData: { ...reportData },
      fieldNotes: { ...fieldNotes },
      currentReportId,
      savedAt: Date.now(),
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    saveDraftFailureNotified = false; // a later successful save clears the throttle
    lastLocalSaveAt = Date.now();
    updateSyncStatus('saved');
  } catch (e) {
    // Previously a silent fail. Now surfaced once per failure episode so the
    // technician knows in-progress work (including a just-captured signature)
    // may not be persisting, without spamming a toast on every keystroke.
    if (!saveDraftFailureNotified) {
      saveDraftFailureNotified = true;
      showToast('Could not save your progress — device storage may be full', 'error');
    }
    updateSyncStatus('error');
  }
}

// ── SYNC / SAVE STATUS INDICATOR ────────────────────────────────────────
// A technician working in a subfloor, basement, or a regional job with no
// signal needs to see their work is safe on-device even when it hasn't (or
// can't yet) reach the cloud — this makes that state visible instead of
// leaving them guessing whether "Save Report" actually did anything.
let lastLocalSaveAt = null;

function updateSyncStatus(state) {
  const el = document.getElementById('syncStatus');
  const textEl = document.getElementById('syncStatusText');
  if (!el || !textEl) return;
  el.classList.remove('saved', 'offline', 'error');

  if (!navigator.onLine) {
    el.classList.add('offline');
    textEl.textContent = lastLocalSaveAt
      ? 'Saved on this device — will sync when back online'
      : 'Offline — saving to this device only';
    return;
  }
  if (state === 'error') {
    el.classList.add('error');
    textEl.textContent = 'Could not save — check device storage';
    return;
  }
  if (state === 'cloud_error') {
    el.classList.add('error');
    textEl.textContent = 'Saved on this device — could not sync to your account';
    return;
  }
  if (state === 'saved' || lastLocalSaveAt) {
    el.classList.add('saved');
    textEl.textContent = (typeof authSession !== 'undefined' && authSession)
      ? 'Saved & syncing to your account'
      : 'Saved on this device';
    return;
  }
  textEl.textContent = 'Not saved yet';
}

window.addEventListener('online', () => updateSyncStatus());
window.addEventListener('offline', () => updateSyncStatus());

// Make sure a pending debounced save is never lost if the app is backgrounded
// or closed before the debounce timer would otherwise have fired.
document.addEventListener('visibilitychange', () => { if (document.hidden) flushDraftSave(); });
window.addEventListener('pagehide', flushDraftSave);
window.addEventListener('beforeunload', flushDraftSave);

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return false;
    const draft = JSON.parse(raw);

    // Don't restore empty drafts
    if (!draft.reportData || Object.keys(draft.reportData).length === 0) {
      if (!draft.jobAddress && !draft.jobClient) return false;
    }

    document.getElementById('jobAddress').value = draft.jobAddress || '';
    document.getElementById('jobSuburb').value = draft.jobSuburb || '';
    document.getElementById('jobState').value = draft.jobState || '';
    document.getElementById('jobPostcode').value = draft.jobPostcode || '';
    document.getElementById('jobClient').value = draft.jobClient || '';
    document.getElementById('jobInspector').value = draft.jobInspector || '';
    updateJob();

    reportData = { ...draft.reportData };
    fieldNotes = { ...(draft.fieldNotes || {}) };
    currentReportId = draft.currentReportId || null;

    Object.keys(reportData).forEach(key => {
      const el = document.getElementById('f-' + key);
      if (el) renderField(el, key, reportData[key]);
    });

    restoreFieldNotes();

    const sel = document.getElementById('standardSelect');
    if (sel && reportData.standard) sel.value = reportData.standard;

    updateProgress();
    checkAsbestosFlag();
    checkFindingsGate();
    checkSystemVerify();
    checkSecondaryColonyFlag();
    restoreSignaturePads(); restoreLicenceField();
    renderPhotoGrid();
    renderFindingsUI();

    // FIX: this was a third independent copy of the same plain-presence
    // check already found to overcount the Findings section elsewhere
    // (see isFieldFilled) - sharing it here too so reopening a draft can't
    // land on the wrong tab for the same reason.
    let bestSection = 'property', bestCount = -1;
    Object.entries(SECTIONS).forEach(([sec, cfg]) => {
      const count = cfg.fields.filter(k => isFieldFilled(k)).length;
      if (count > bestCount) { bestCount = count; bestSection = sec; }
    });
    showSection(bestSection);

    return true;
  } catch (e) {
    console.error('Failed to load draft', e);
    return false;
  }
}

function clearDraft() {
  if (saveDraftTimer) { clearTimeout(saveDraftTimer); saveDraftTimer = null; }
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
}

function getSavedReports() {
  try {
    const raw = localStorage.getItem(reportsStorageKey());
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to read saved reports', e);
    return [];
  }
}

function setSavedReports(reports) {
  try {
    localStorage.setItem(reportsStorageKey(), JSON.stringify(reports));
    return true;
  } catch (e) {
    console.error('Failed to save reports', e);
    showToast('Could not save — storage full or unavailable', 'error');
    return false;
  }
}

function calculateCompletion() {
  let filled = 0, total = 0;
  Object.values(SECTIONS).forEach(cfg => {
    filled += cfg.fields.filter(k => isFieldFilled(k)).length;
    total += cfg.total;
  });
  return Math.round((filled / total) * 100);
}

// FIX: a plain "is this key present" check silently overcounted the
// Findings section. getFindings() (called during routine UI renders, not
// just user action) lazily creates a placeholder finding object with
// termiteActivity:null the first time anything reads the findings list -
// so reportData.findings was non-null/non-undefined on almost every report
// from the moment the page rendered once, even with zero real data
// recorded, and the progress bar silently counted that section as "done".
// Centralising the "filled" check here (rather than a one-off inline
// special case) also makes it the obvious place to extend if another
// field ever needs more than a bare presence check.
function isFieldFilled(key) {
  if (reportData[key] === undefined || reportData[key] === null) return false;
  if (key === 'findings') {
    return Array.isArray(reportData.findings) &&
      reportData.findings.some(f => f && (f.termiteActivity || f.species || f.damageDescription || f.activityLocation));
  }
  if (key === 'standard') {
    // resetReportState()/loadReport() force reportData.standard to
    // 'AS 3660.2-2017' before the technician has touched anything, so its
    // bare presence isn't evidence of real progress - every brand-new report
    // would otherwise show a few % complete and "In progress" on Property
    // before a single field is entered. Only count it once they've actually
    // picked a different standard, since that's the only signal we have
    // that this field was deliberately engaged with.
    return reportData.standard !== 'AS 3660.2-2017';
  }
  return true;
}

function saveCurrentReport() {
  const street = document.getElementById('jobAddress').value.trim();
  if (!street) {
    showToast('Enter a property address before saving', 'error');
    document.getElementById('jobAddress').focus();
    return;
  }

  const reports = getSavedReports();
  const id = currentReportId || ('report_' + Date.now());

  const entry = {
    id,
    address: getFullAddress(),
    jobAddress: street,
    jobSuburb: document.getElementById('jobSuburb').value.trim(),
    jobState: document.getElementById('jobState').value.trim(),
    jobPostcode: document.getElementById('jobPostcode').value.trim(),
    client: document.getElementById('jobClient').value.trim(),
    inspector: document.getElementById('jobInspector').value.trim(),
    reportData: { ...reportData },
    fieldNotes: { ...fieldNotes },
    savedAt: Date.now(),
    completion: calculateCompletion(),
  };

  const existingIndex = reports.findIndex(r => r.id === id);
  if (existingIndex >= 0) {
    reports[existingIndex] = entry;
  } else {
    reports.unshift(entry);
  }

  if (setSavedReports(reports)) {
    currentReportId = id;
    showToast('Report saved', 'success');
    renderSavedList();
    saveDraft();
    lastLocalSaveAt = Date.now();
    updateSyncStatus('saved');
    supabaseSave(entry); // background cloud sync — non-blocking
  }
}

function loadReport(id) {
  const reports = getSavedReports();
  const entry = reports.find(r => r.id === id);
  if (!entry) return;

  // Reset current state
  resetReportState();

  // Restore job fields
  document.getElementById('jobAddress').value = entry.jobAddress || entry.address || '';
  document.getElementById('jobSuburb').value = entry.jobSuburb || '';
  document.getElementById('jobState').value = entry.jobState || '';
  document.getElementById('jobPostcode').value = entry.jobPostcode || '';
  document.getElementById('jobClient').value = entry.client || '';
  document.getElementById('jobInspector').value = entry.inspector || '';
  updateJob();

  // Restore report data
  reportData = { ...entry.reportData };
  fieldNotes = { ...(entry.fieldNotes || {}) };
  currentReportId = entry.id;

  // Re-render all fields
  Object.keys(reportData).forEach(key => {
    const el = document.getElementById('f-' + key);
    if (el) renderField(el, key, reportData[key]);
  });

  restoreFieldNotes();

  const sel = document.getElementById('standardSelect');
  if (sel) sel.value = reportData.standard || 'AS 3660.2-2017';
  if (!reportData.standard) setStandard('AS 3660.2-2017');

  updateProgress();
  checkAsbestosFlag();
  checkFindingsGate();
  checkSystemVerify();
  checkSecondaryColonyFlag();
  restoreSignaturePads(); restoreLicenceField();
  loadJobInfo();
  renderPhotoGrid();

  // Reveal the section with the most data, default to property
  let bestSection = 'property', bestCount = -1;
  Object.entries(SECTIONS).forEach(([sec, cfg]) => {
    const count = cfg.fields.filter(k => isFieldFilled(k)).length;
    if (count > bestCount) { bestCount = count; bestSection = sec; }
  });
  showSection(bestSection);
  saveDraft();

  showToast(`Loaded: ${entry.address}`, 'info');
  if (window.innerWidth <= 768 && document.getElementById('sidebarPanel').classList.contains('open')) {
    toggleDrawer();
  }
}

function deleteReport(id, event) {
  if (event) event.stopPropagation();
  const reports = getSavedReports().filter(r => r.id !== id);
  setSavedReports(reports);
  if (currentReportId === id) currentReportId = null;
  renderSavedList();
  showToast('Report deleted', 'info');
  supabaseDelete(id); // background cloud delete — non-blocking
}

function clearAllSavedReports() {
  const reports = getSavedReports();
  if (reports.length === 0) {
    showToast('No saved reports to clear', 'info');
    return;
  }
  if (!confirm(`Delete all ${reports.length} saved report${reports.length === 1 ? '' : 's'} from this device? This cannot be undone.`)) {
    return;
  }
  setSavedReports([]);
  currentReportId = null;
  renderSavedList();
  showToast('All saved reports cleared', 'success');
}

// ══════════════════════════════════════════════════════════════════════════
// DATA EXPORT / IMPORT
// ══════════════════════════════════════════════════════════════════════════
function exportAllData() {
  try {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('korva_')) {
        data[key] = localStorage.getItem(key);
      }
    }

    const backup = {
      app: 'KORVUS',
      exportedAt: new Date().toISOString(),
      version: 1,
      data,
    };

    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const date = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `korvus_backup_${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const reportCount = getSavedReports().length;
    showToast(`Exported ${reportCount} saved report${reportCount === 1 ? '' : 's'} and preferences`, 'success');
  } catch (e) {
    console.error('Export failed', e);
    showToast('Export failed — see console for details', 'error');
  }
}

function importAllData(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    let backup;
    try {
      backup = JSON.parse(e.target.result);
    } catch (err) {
      showToast('That file isn\'t valid — could not read it', 'error');
      return;
    }

    if (!backup || typeof backup !== 'object' || !backup.data || backup.app !== 'KORVUS') {
      showToast('That doesn\'t look like a KORVUS backup file', 'error');
      return;
    }

    const incomingReports = (() => {
      try {
        return JSON.parse(backup.data['termiteai_saved_reports'] || '[]');
      } catch (err) {
        return [];
      }
    })();

    const existingReports = getSavedReports();
    const mode = existingReports.length > 0
      ? confirm(
          `This backup contains ${incomingReports.length} report${incomingReports.length === 1 ? '' : 's'}.\n\n` +
          `You currently have ${existingReports.length} saved on this device.\n\n` +
          `Click OK to MERGE (keep both, skipping duplicates by address+date), or Cancel to REPLACE everything with the backup.`
        )
      : true; // nothing to lose, just load it in

    let finalReports;
    if (mode === true && existingReports.length > 0) {
      // Merge: keep existing + add incoming ones that don't already exist (by id)
      const existingIds = new Set(existingReports.map(r => r.id));
      const newOnes = incomingReports.filter(r => !existingIds.has(r.id));
      finalReports = [...existingReports, ...newOnes];
    } else if (existingReports.length === 0) {
      finalReports = incomingReports;
    } else {
      // Replace
      finalReports = incomingReports;
    }

    try {
      // Restore saved reports
      setSavedReports(finalReports);

      // Restore preferences (accessibility, panel states) but not the in-progress draft,
      // to avoid overwriting work the user has open right now
      Object.entries(backup.data).forEach(([key, value]) => {
        if (key === 'korva_saved_reports' || key === 'korva_draft') return;
        try { localStorage.setItem(key, value); } catch (err) {}
      });

      renderSavedList();
      restoreA11ySettings();
      restoreAudioCaptureSetting();
      applyPanelCollapseStates();
      showToast(`Imported ${finalReports.length} report${finalReports.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      console.error('Import failed', err);
      showToast('Import failed — see console for details', 'error');
    }
  };

  reader.onerror = () => showToast('Could not read that file', 'error');
  reader.readAsText(file);

  // Reset the file input so the same file can be re-selected later if needed
  document.getElementById('importFileInput').value = '';
}

// ══════════════════════════════════════════════════════════════════════════
// ACCESSIBILITY SETTINGS
// ══════════════════════════════════════════════════════════════════════════
function setTextSize(size) {
  document.body.classList.remove('text-size-large', 'text-size-xl');
  if (size === 'large') document.body.classList.add('text-size-large');
  if (size === 'xl') document.body.classList.add('text-size-xl');

  document.querySelectorAll('#textSizeControl .text-size-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === size);
  });

  try { localStorage.setItem('korva_a11y_textsize', size); } catch (e) {}
}

function toggleA11y(className, btnId, storageKey) {
  const on = document.body.classList.toggle(className);
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.toggle('on', on);
  try { localStorage.setItem(storageKey, on ? '1' : '0'); } catch (e) {}
}

const COLOUR_VISION_ACCENTS = {
  none:          { accent: '#0D9488', accent2: '#2DD4C0', accent3: '#0A6E65', rgb: '13,148,136' }, // teal (default)
  protanopia:    { accent: '#4d8aff', accent2: '#7aa8ff', accent3: '#2f5fd6', rgb: '77,138,255' }, // blue — stays distinct from lime/amber for red-green deficiency
  deuteranopia:  { accent: '#4d8aff', accent2: '#7aa8ff', accent3: '#2f5fd6', rgb: '77,138,255' }, // blue — same reasoning, most common type
  tritanopia:    { accent: '#ff4dc4', accent2: '#ff7dd6', accent3: '#d62fa0', rgb: '255,77,196' }, // magenta — stays distinct from red/green for blue-yellow deficiency
};

function setColourVisionMode(mode) {
  const colours = COLOUR_VISION_ACCENTS[mode] || COLOUR_VISION_ACCENTS.none;
  document.documentElement.style.setProperty('--accent', colours.accent);
  document.documentElement.style.setProperty('--accent2', colours.accent2);
  document.documentElement.style.setProperty('--accent3', colours.accent3);
  document.documentElement.style.setProperty('--accent-rgb', colours.rgb);
  try { localStorage.setItem('korva_a11y_colorvision', mode); } catch (e) {}
}

function restoreA11ySettings() {
  try {
    const textSize = localStorage.getItem('korva_a11y_textsize');
    if (textSize && textSize !== 'normal') setTextSize(textSize);

    if (localStorage.getItem('korva_a11y_contrast') === '1') {
      document.body.classList.add('high-contrast');
      document.getElementById('toggleHighContrast').classList.add('on');
    }
    if (localStorage.getItem('korva_a11y_touch') === '1') {
      document.body.classList.add('large-touch');
      document.getElementById('toggleLargeTouch').classList.add('on');
    }
    if (localStorage.getItem('korva_a11y_motion') === '1') {
      document.body.classList.add('reduce-motion');
      document.getElementById('toggleReduceMotion').classList.add('on');
    }
    const cvd = localStorage.getItem('korva_a11y_colorvision');
    if (cvd && cvd !== 'none') {
      setColourVisionMode(cvd);
      const sel = document.getElementById('colourVisionSelect');
      if (sel) sel.value = cvd;
    }
  } catch (e) {}
}

function newReport() {
  resetReportState();
  document.getElementById('jobAddress').value = '';
  document.getElementById('jobSuburb').value = '';
  document.getElementById('jobState').value = '';
  document.getElementById('jobPostcode').value = '';
  document.getElementById('jobClient').value = '';
  document.getElementById('jobInspector').value = '';
  updateJob();
  currentReportId = null;
  clearDraft();
  showSection('property');
  showToast('New report started', 'info');
}

function resetReportState() {
  reportData = {};
  fieldNotes = {};
  pendingSpeciesMatch = null;
  window.__lastPdfBlob = null;
  window.__lastPdfName = null;
  const shareBtn = document.getElementById('shareBtn');
  if (shareBtn) shareBtn.style.display = 'none';
  clearJobInfo();
  const confirm = document.getElementById('speciesConfirm');
  const intel = document.getElementById('speciesIntel');
  if (confirm) confirm.style.display = 'none';
  if (intel) intel.style.display = 'none';
  // Clear all field displays
  Object.values(SECTIONS).forEach(cfg => {
    cfg.fields.forEach(key => {
      const el = document.getElementById('f-' + key);
      if (el) {
        el.classList.remove('filled', 'flash');
        el.innerHTML = '—';
      }
      // Remove edited-dot indicators
      const label = el ? getFieldLabel(el) : null;
      if (label) {
        const dot = label.querySelector('.edited-dot');
        if (dot) dot.remove();
      }
      // Clear notes
      const ta = document.getElementById('notes-text-' + key);
      if (ta) ta.value = '';
      const panel = document.getElementById('notes-' + key);
      if (panel) panel.classList.remove('open');
      updateNotesIndicator(key);
    });
  });
  updateProgress();
  const banner = document.getElementById('asbestosBanner');
  if (banner) banner.style.display = 'none';
  checkFindingsGate();
  checkSystemVerify();
  checkSecondaryColonyFlag();
  clearAllSignaturePads();
  renderPhotoGrid();
  renderFindingsUI();
  setStandard('AS 3660.2-2017');
}

// ── DASHBOARD (single-user preview) ─────────────────────────────────────
// Reads the same saved-reports data already on this device. This is a
// preview: it has no concept of "who" saved a report, since login is
// currently bypassed. Once real accounts are back, this becomes the
// technician's own view and an owner-only team-wide view is added
// alongside it — the stat-gathering logic here does not need to change,
// only what it's filtered by.
function openDashboard() {
  document.getElementById('dashboardOverlay').classList.add('open');
  const isOwner = !!(authBusiness && authUser && authBusiness.owner_id === authUser.id);
  const teamTabBtn = document.getElementById('dashTabTeam');
  if (teamTabBtn) teamTabBtn.style.display = isOwner ? '' : 'none';
  switchDashboardTab('overview');
}

function closeDashboard() {
  document.getElementById('dashboardOverlay').classList.remove('open');
  stopScheduleAutoRefresh();
}

let dashboardActiveTab = 'overview';

function switchDashboardTab(tab) {
  dashboardActiveTab = tab;
  const overviewBtn = document.getElementById('dashTabOverview');
  const scheduleBtn = document.getElementById('dashTabSchedule');
  const teamBtn     = document.getElementById('dashTabTeam');
  if (overviewBtn) overviewBtn.classList.toggle('active', tab === 'overview');
  if (scheduleBtn) scheduleBtn.classList.toggle('active', tab === 'schedule');
  if (teamBtn) teamBtn.classList.toggle('active', tab === 'team');
  const subtitleEl = document.getElementById('dashboardSubtitle');
  if (subtitleEl) {
    subtitleEl.textContent = tab === 'team' ? 'All reports synced from your business — owner view'
      : tab === 'schedule' ? 'This device\'s upcoming jobs, plus anything assigned to you'
      : 'Reports saved on this device — preview';
  }
  if (tab === 'schedule') { renderSchedule(); startScheduleAutoRefresh(); }
  else if (tab === 'team') { renderTeamDashboard(); stopScheduleAutoRefresh(); }
  else { renderDashboard(); stopScheduleAutoRefresh(); }
}

// ── SCHEDULE (agenda view) ─────────────────────────────────────────────────
// Merges two sources into one agenda, grouped into Today / Tomorrow / This
// Week / Later / Past: reports the technician has saved locally with an
// Inspection Date, and jobs a business owner has assigned to them via the
// Team panel (stored in Supabase, so they can arrive from someone else's
// device). The assigned-jobs half is fetched async and can't block the
// instant local render, so renderSchedule() paints local data immediately
// and re-renders once the cloud fetch resolves — and again periodically
// while this tab stays open, so a schedule change a boss makes elsewhere
// shows up here without the technician having to do anything.
let scheduleAutoRefreshTimer = null;
const SCHEDULE_AUTO_REFRESH_MS = 25000;

function startScheduleAutoRefresh() {
  stopScheduleAutoRefresh();
  scheduleAutoRefreshTimer = setInterval(refreshAssignedJobsForSchedule, SCHEDULE_AUTO_REFRESH_MS);
}

function stopScheduleAutoRefresh() {
  if (scheduleAutoRefreshTimer) { clearInterval(scheduleAutoRefreshTimer); scheduleAutoRefreshTimer = null; }
}

function renderSchedule() {
  renderScheduleAgenda([]);
  refreshAssignedJobsForSchedule();
}

async function refreshAssignedJobsForSchedule() {
  if (!authSession || !authUser) return;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/jobs?assigned_to=eq.${authUser.id}&order=job_date.asc,job_time.asc`,
      { headers: getAuthHeaders() }
    );
    if (!res.ok) return;
    const jobs = await res.json();
    renderScheduleAgenda(jobs);
  } catch(e) { /* silent — the schedule still shows local reports either way */ }
}

function renderScheduleAgenda(assignedJobs) {
  const body = document.getElementById('dashboardBody');
  if (!body) return;
  // Guard against a slow async response landing after the technician has
  // already switched away from the Schedule tab.
  const scheduleBtn = document.getElementById('dashTabSchedule');
  if (!scheduleBtn || !scheduleBtn.classList.contains('active')) return;

  const reports = getSavedReports();
  const localItems = reports
    .filter(r => r.reportData && r.reportData.jobInspectionDate)
    .map(r => ({
      date: r.reportData.jobInspectionDate,
      time: r.reportData.jobInspectionTime || '',
      address: r.address || 'No address',
      client: r.client || '',
      assigned: false,
    }));
  const assignedItems = (assignedJobs || [])
    .filter(j => j.job_date)
    .map(j => ({
      date: j.job_date,
      time: j.job_time || '',
      address: j.address || 'No address',
      client: j.notes || '',
      assigned: true,
    }));

  const all = [...localItems, ...assignedItems];
  if (all.length === 0) {
    body.innerHTML = '<div class="dashboard-empty">No scheduled jobs yet.<br>Set an Inspection Date on a job to see it here.</div>';
    return;
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const weekAhead = new Date();
  weekAhead.setDate(weekAhead.getDate() + 7);
  const weekAheadStr = weekAhead.toISOString().slice(0, 10);

  const sorted = [...all].sort((a, b) =>
    (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));

  const groups = { 'Today': [], 'Tomorrow': [], 'This Week': [], 'Later': [], 'Past': [] };
  sorted.forEach(item => {
    const d = item.date;
    if (d < todayStr) groups['Past'].push(item);
    else if (d === todayStr) groups['Today'].push(item);
    else if (d === tomorrowStr) groups['Tomorrow'].push(item);
    else if (d <= weekAheadStr) groups['This Week'].push(item);
    else groups['Later'].push(item);
  });

  const fmtTime = (t) => {
    if (!t) return '—';
    const [h, m] = t.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
  };
  const fmtDateShort = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

  let html = '';
  ['Today', 'Tomorrow', 'This Week', 'Later', 'Past'].forEach(groupName => {
    const items = groups[groupName];
    if (items.length === 0) return;
    html += `<div class="schedule-group-label">${groupName}</div>`;
    html += items.map(item => `
      <div class="schedule-item">
        <div class="schedule-item-time">${fmtTime(item.time)}</div>
        <div class="schedule-item-body">
          <div class="schedule-item-addr">${escapeHtml(item.address)}${item.assigned ? '<span class="schedule-item-badge">Assigned</span>' : ''}</div>
          <div class="schedule-item-meta">${fmtDateShort(item.date)}${item.client ? ' · ' + escapeHtml(item.client) : ''}</div>
        </div>
      </div>
    `).join('');
  });

  body.innerHTML = html;
}

function parseFeeToNumber(feeStr) {
  if (!feeStr) return 0;
  const n = parseFloat(String(feeStr).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}

function renderDashboard() {
  const body = document.getElementById('dashboardBody');
  if (!body) return;
  const reports = getSavedReports();

  if (reports.length === 0) {
    body.innerHTML = '<div class="dashboard-empty">No saved reports yet on this device.</div>';
    return;
  }

  const now = Date.now();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  const thisWeek = reports.filter(r => now - r.savedAt <= oneWeekMs);

  const totalJobs = reports.length;
  const jobsThisWeek = thisWeek.length;
  const avgCompletion = Math.round(
    reports.reduce((sum, r) => sum + (r.completion || 0), 0) / totalJobs
  );
  const totalRevenue = reports.reduce((sum, r) => sum + parseFeeToNumber(r.reportData && r.reportData.jobFee), 0);

  const sorted = [...reports].sort((a, b) => b.savedAt - a.savedAt).slice(0, 8);

  const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const fmtMoney = (n) => n > 0 ? `$${n.toLocaleString('en-AU', { maximumFractionDigits: 0 })}` : '—';

  body.innerHTML = `
    <div class="dashboard-stat-grid">
      <div class="dashboard-stat-card">
        <div class="dashboard-stat-value">${totalJobs}</div>
        <div class="dashboard-stat-label">Total Jobs</div>
      </div>
      <div class="dashboard-stat-card">
        <div class="dashboard-stat-value">${jobsThisWeek}</div>
        <div class="dashboard-stat-label">This Week</div>
      </div>
      <div class="dashboard-stat-card">
        <div class="dashboard-stat-value">${avgCompletion}%</div>
        <div class="dashboard-stat-label">Avg. Completion</div>
      </div>
      <div class="dashboard-stat-card">
        <div class="dashboard-stat-value">${fmtMoney(totalRevenue)}</div>
        <div class="dashboard-stat-label">Recorded Fees</div>
      </div>
    </div>
    <div class="dashboard-section-label">Recent Jobs</div>
    <div>
      ${sorted.map(r => `
        <div class="dashboard-recent-item">
          <div>
            <div class="dashboard-recent-addr">${escapeHtml(r.address || 'No address')}</div>
            <div class="dashboard-recent-meta">${fmtDate(r.savedAt)}${r.client ? ' · ' + escapeHtml(r.client) : ''}</div>
          </div>
          <div class="dashboard-recent-completion">${r.completion || 0}%</div>
        </div>
      `).join('')}
    </div>
  `;
}

async function renderTeamDashboard() {
  const body = document.getElementById('dashboardBody');
  if (!body) return;
  const isOwner = !!(authBusiness && authUser && authBusiness.owner_id === authUser.id);
  if (!isOwner || !authBusiness) {
    body.innerHTML = '<div class="dashboard-empty">Team view is only available to business owners.</div>';
    return;
  }
  body.innerHTML = '<div class="dashboard-empty">Loading team activity…</div>';
  try {
    const [reportsRes, membersRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/reports?business_id=eq.${authBusiness.id}&order=saved_at.desc`, { headers: getAuthHeaders() }),
      fetch(`${SUPABASE_URL}/rest/v1/team_members?business_id=eq.${authBusiness.id}`, { headers: getAuthHeaders() }),
    ]);
    // Guard against a slow response landing after the owner has already switched tabs
    const teamBtn = document.getElementById('dashTabTeam');
    if (!teamBtn || !teamBtn.classList.contains('active')) return;

    if (!reportsRes.ok) {
      body.innerHTML = '<div class="dashboard-empty">Could not load team reports.<br>Your account may not yet have permission to read your team\'s data — see the note in Settings.</div>';
      return;
    }

    const rows    = await reportsRes.json();
    const members = membersRes.ok ? await membersRes.json() : [];
    const nameByUserId = {};
    members.forEach(m => { nameByUserId[m.user_id] = m.name || m.email || 'Unknown'; });

    if (rows.length === 0) {
      body.innerHTML = '<div class="dashboard-empty">No reports synced from your team yet.<br>Reports appear here once a technician saves one while signed in.</div>';
      return;
    }

    const now = Date.now();
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    const thisWeek = rows.filter(r => now - new Date(r.saved_at).getTime() <= oneWeekMs);

    const totalJobs    = rows.length;
    const jobsThisWeek  = thisWeek.length;
    // .filter(Boolean) - a legacy/anonymous report with no user_id (e.g. synced
    // before auth was required) would otherwise count as its own "technician",
    // inflating this headcount for a row nobody actually did.
    const activeTechs   = new Set(rows.map(r => r.user_id).filter(Boolean)).size;
    const totalRevenue  = rows.reduce((sum, r) => sum + parseFeeToNumber(r.data && r.data.reportData && r.data.reportData.jobFee), 0);

    const byTech = {};
    rows.forEach(r => {
      const uid = r.user_id || 'unknown';
      if (!byTech[uid]) byTech[uid] = { count: 0, revenue: 0 };
      byTech[uid].count++;
      byTech[uid].revenue += parseFeeToNumber(r.data && r.data.reportData && r.data.reportData.jobFee);
    });
    const techBreakdown = Object.entries(byTech)
      .map(([uid, stats]) => ({ name: nameByUserId[uid] || 'Unknown', ...stats }))
      .sort((a, b) => b.count - a.count);

    const recent = rows.slice(0, 8);
    const fmtDate  = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    const fmtMoney = (n) => n > 0 ? `$${n.toLocaleString('en-AU', { maximumFractionDigits: 0 })}` : '—';
    const initials = (name) => (name || '?').trim().split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase();

    body.innerHTML = `
      <div class="dashboard-stat-grid">
        <div class="dashboard-stat-card">
          <div class="dashboard-stat-value">${totalJobs}</div>
          <div class="dashboard-stat-label">Team Jobs</div>
        </div>
        <div class="dashboard-stat-card">
          <div class="dashboard-stat-value">${jobsThisWeek}</div>
          <div class="dashboard-stat-label">This Week</div>
        </div>
        <div class="dashboard-stat-card">
          <div class="dashboard-stat-value">${activeTechs}</div>
          <div class="dashboard-stat-label">Active Technicians</div>
        </div>
        <div class="dashboard-stat-card">
          <div class="dashboard-stat-value">${fmtMoney(totalRevenue)}</div>
          <div class="dashboard-stat-label">Recorded Fees</div>
        </div>
      </div>
      <div class="dashboard-section-label">By Technician</div>
      <div class="team-list" style="margin-bottom:18px">
        ${techBreakdown.map(t => `
          <div class="team-member">
            <div class="team-member-avatar">${escapeHtml(initials(t.name))}</div>
            <div class="team-member-info">
              <div class="team-member-name">${escapeHtml(t.name)}</div>
              <div class="team-member-email">${t.count} job${t.count === 1 ? '' : 's'}${t.revenue > 0 ? ' · ' + fmtMoney(t.revenue) : ''}</div>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="dashboard-section-label">Recent Team Activity</div>
      <div>
        ${recent.map(r => `
          <div class="dashboard-recent-item">
            <div>
              <div class="dashboard-recent-addr">${escapeHtml(r.address || 'No address')}</div>
              <div class="dashboard-recent-meta">${fmtDate(r.saved_at)} · ${escapeHtml(nameByUserId[r.user_id] || 'Unknown')}${r.client ? ' · ' + escapeHtml(r.client) : ''}</div>
            </div>
            <div class="dashboard-recent-completion">${(r.data && r.data.completion) || 0}%</div>
          </div>
        `).join('')}
      </div>
    `;
  } catch(e) {
    console.warn('renderTeamDashboard error:', e);
    body.innerHTML = '<div class="dashboard-empty">Could not load team activity — check your connection.</div>';
  }
}

function renderSavedList() {
  const list = document.getElementById('savedList');
  const allReports = getSavedReports();
  const summary = document.getElementById('savedPanelSummary');

  if (allReports.length === 0) {
    list.innerHTML = '<div class="saved-empty">No saved reports yet — fill in a job and tap "Save Report"</div>';
    if (summary) summary.textContent = 'None saved';
    return;
  }

  if (summary) summary.textContent = `${allReports.length} saved`;

  const searchEl = document.getElementById('savedSearchInput');
  const query = searchEl ? searchEl.value.trim().toLowerCase() : '';

  let reports = allReports;
  if (query) {
    reports = allReports.filter(r => {
      const haystack = [r.address, r.client, r.jobSuburb, r.jobPostcode, r.inspector]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  // Sort newest first
  reports.sort((a, b) => b.savedAt - a.savedAt);

  if (reports.length === 0) {
    list.innerHTML = `<div class="saved-empty">No matches for "${escapeHtml(searchEl.value.trim())}"</div>`;
    return;
  }

  list.innerHTML = reports.map(r => {
    const date = new Date(r.savedAt);
    const dateStr = date.toLocaleDateString('en-AU', { day:'numeric', month:'short' });
    const risk = r.reportData.riskLevel || 'none';
    const addr = r.address || 'Untitled property';
    return `
      <div class="saved-item" onclick="loadReport('${r.id}')">
        <div class="saved-item-info">
          <div class="saved-item-address">${escapeHtml(addr)}</div>
          <div class="saved-item-meta">
            <span>${dateStr}</span>
            <span class="saved-item-risk ${risk}">${risk === 'none' ? 'N/A' : risk}</span>
            <span class="saved-item-pct">${r.completion}%</span>
          </div>
        </div>
        <button class="saved-item-delete" onclick="deleteReport('${r.id}', event)" title="Delete">✕</button>
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── STATUS / TOAST ────────────────────────────────────────────────────────
function setAI(state, text) {
  document.getElementById('aiStatus').textContent = text;
  document.getElementById('aiDot').className = 'ai-dot' + (state === 'thinking' ? ' thinking' : '');
}

function showToast(msg, type = 'default') {
  const t = document.getElementById('toast');
  clearTimeout(t._timeout);

  const svgIcon = (path) => `<svg class="icon toast-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

  const icons = {
    success: svgIcon('<path d="M20 6 9 17l-5-5"/>'),
    error: svgIcon('<path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    info: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
    default: svgIcon('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="4" r="2" fill="currentColor"/>'),
  };

  t.innerHTML = `${icons[type] || icons.default}<span>${escapeHtml(String(msg))}</span>`;
  t.className = 'toast show toast-' + type;

  t._timeout = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── PDF GENERATION ────────────────────────────────────────────────────────
async function shareReport() {
  const blob = window.__lastPdfBlob;
  const fname = window.__lastPdfName || 'KORVUS_Report.pdf';
  if (!blob) {
    showToast('Generate the PDF first', 'error');
    return;
  }

  const file = new File([blob], fname, { type: 'application/pdf' });

  // Web Share API — works on iOS Safari and Android Chrome
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: 'KORVUS Inspection Report',
        text: `Timber Pest Inspection Report — ${getFullAddress() || 'Property'}`,
        files: [file],
      });
    } catch(e) {
      if (e.name !== 'AbortError') {
        // User cancelled share — not an error
        showToast('Share cancelled', 'info');
      }
    }
    return;
  }

  // Fallback for desktop / unsupported browsers — re-download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
  showToast('PDF downloaded — share from your Downloads folder', 'info');
}

function generateReport() {
  const btn = document.getElementById('generateBtn');
  const originalText = btn.innerHTML;
  btn.innerHTML = 'Generating…';
  btn.disabled = true;
  btn.style.opacity = '0.7';

  // Defer to next tick so the UI updates before the (synchronous) PDF build
  setTimeout(() => {
    ensureJsPDFLoaded().then(() => {
      return _buildAndDownloadPDF();
    }).catch((e) => {
      console.error('PDF generation failed:', e);
      showToast((e && e.message) || 'Could not generate the PDF — check your connection and try again', 'error');
    }).finally(() => {
      btn.innerHTML = originalText;
      btn.disabled = false;
      btn.style.opacity = '';
    });
  }, 50);
}

// ── SHARED PDF PIECES ── used by the inspection report and the quote PDF
// (js/quote.js) so both documents carry the same brand.
const PDF_COLORS = {
  white:       [255, 255, 255],
  pageBg:      [250, 251, 252],
  // Text
  ink:         [12,  18,  28],
  inkLight:    [55,  70,  88],
  inkMuted:    [115, 130, 148],
  // Accent — Prometho metallic teal
  accent:      [13,  148, 136],
  accentDark:  [8,   100,  92],
  accentLight: [200, 238, 234],
  // Structure
  rule:        [208, 218, 228],
  ruleLight:   [230, 237, 244],
  rowAlt:      [245, 248, 251],
  headerBg:    [10,  15,  22],
  // Status
  danger:      [192,  48,  38],
  warn:        [175, 112,  16],
  safe:        [40,  148,  72],
  // Cover
  coverDark:   [10,  15,  22],
  coverMid:    [20,  30,  46],
};

// Logo mark for the dark header band: the uploaded company logo on a white
// tile, falling back to the default K mark.
function drawPdfCompanyMark(doc, company) {
  const C = PDF_COLORS;
  if (company.logo) {
    try {
      const boxX = 12, boxY = 12, boxW = 24, boxH = 24, pad = 3;
      doc.setFillColor(...C.white); doc.roundedRect(boxX, boxY, boxW, boxH, 3, 3, 'F');
      const natW = company.logoWidth || 1, natH = company.logoHeight || 1;
      const maxW = boxW - pad*2, maxH = boxH - pad*2;
      let drawW = maxW, drawH = maxW * (natH / natW);
      if (drawH > maxH) { drawH = maxH; drawW = maxH * (natW / natH); }
      doc.addImage(company.logo, 'PNG', boxX + (boxW-drawW)/2, boxY + (boxH-drawH)/2, drawW, drawH, undefined, 'FAST');
      return;
    } catch (e) {}
  }
  doc.setFillColor(...C.accent); doc.roundedRect(14, 14, 20, 20, 3, 3, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(...C.coverDark);
  doc.text('K', 24, 27.5, { align:'center' });
}

// Gets a finished PDF off the device. Inside the native app wrapper there is
// no Downloads folder for a browser-style <a download> click to land in — it
// silently does nothing — so go straight to the native Share sheet there.
// Browsers / PWA get a Safari-compatible blob download.
async function deliverPdfBlob(blob, fname, { title, text, readyToast }) {
  const isNative = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
  if (isNative) {
    const file = new File([blob], fname, { type: 'application/pdf' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title, text, files: [file] });
        showToast(readyToast, 'success');
      } catch(e) {
        if (e.name !== 'AbortError') showToast('Share cancelled', 'info');
      }
    } else {
      showToast('PDF ready — tap Share to save or send it', 'info');
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 300);
    showToast('PDF downloaded', 'success');
  } catch(e) {
    // Fallback — open PDF in new tab
    window.open(url, '_blank');
    showToast('PDF opened in new tab — save from there', 'info');
  }
}

async function _buildAndDownloadPDF() {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 15, CW = W - M * 2;
  const address   = getFullAddress() || 'Address Not Set';
  const client    = document.getElementById('jobClient').value    || 'Not specified';
  const inspector = document.getElementById('jobInspector').value || 'Not specified';
  const today = new Date().toLocaleDateString('en-AU', { day:'numeric', month:'long', year:'numeric' });
  const reportId = 'TA-' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '-' + Math.floor(Math.random()*9000+1000);
  let y = 0;

  const STANDARD_NAMES = {
    'AS 3660.1-2014': 'New Building Work',
    'AS 4349.0-2007': 'Inspection of Buildings — General Requirements',
    'AS 3660.2-2017': 'Existing Buildings',
    'AS 3660.3-2014': 'Assessment Criteria',
    'AS 4349.1-2007': 'Building Inspections',
    'AS 4349.3-2010': 'Pre-Purchase Timber Pest',
  };
  const standard = reportData.standard || 'AS 3660.2-2017';
  const standardName = STANDARD_NAMES[standard] || '';
  const standardLabel = standardName ? `${standard} — ${standardName}` : standard;

  const C = PDF_COLORS;


  function newPage() { doc.addPage(); y = 20; }
  function gap(n=5) { y += n; }

  let pageNum = 1;

  // ── PAGE HEADER ──────────────────────────────────────────────────────────
  function compactHeader(sectionLabel) {
    pageNum++;
    const reportTitle = standard.startsWith('AS 4349') ? 'TIMBER PEST & BUILDING REPORT' : 'TERMITE INSPECTION REPORT';
    // White page — thin top band in dark
    doc.setFillColor(...C.headerBg); doc.rect(0, 0, W, 13, 'F');
    doc.setFillColor(...C.accent);   doc.rect(0, 0, 4, 13, 'F');
    // Report title
    doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(235,228,218);
    doc.text(reportTitle, 9, 8.5);
    // Address centred
    const addr = getFullAddress() || '';
    if (addr) {
      const addrTrunc = addr.length > 52 ? addr.slice(0,51)+'…' : addr;
      doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(170,160,148);
      doc.text(addrTrunc, W/2, 8.5, { align:'center' });
    }
    // Section label + page number
    doc.setTextColor(170,160,148); doc.setFontSize(7);
    doc.text(`${sectionLabel}  ·  ${pageNum}`, W-M, 8.5, { align:'right' });
    // Thin orange rule below header
    doc.setFillColor(...C.accent); doc.rect(0, 13, W, 0.6, 'F');
    // Light rule below that
    doc.setFillColor(...C.ruleLight); doc.rect(0, 13.6, W, 0.4, 'F');
    y = 22;
  }

  // ── SECTION TITLE ─────────────────────────────────────────────────────────
  function sectionTitle(title, num) {
    if (y > 260) newPage();
    gap(4);
    // Number badge
    if (num) {
      doc.setFillColor(...C.accent); doc.roundedRect(M, y, 7, 7, 1, 1, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.white);
      doc.text(String(num), M+3.5, y+5.2, { align:'center' });
    }
    // Title
    const titleX = num ? M+10 : M;
    doc.setFont('helvetica','bold'); doc.setFontSize(10.5); doc.setTextColor(...C.ink);
    doc.text(title, titleX, y+5.5);
    // Full-width orange rule
    doc.setFillColor(...C.accent); doc.rect(M, y+8, CW, 0.7, 'F');
    y += 14;
  }

  // ── DATA ROW ──────────────────────────────────────────────────────────────
  let _rowShade = false;
  function row(label, value) {
    const v     = String(value || '');
    const isEmpty = !value && value !== 0;
    const LABEL_W = 60;
    doc.setFontSize(8.5);
    const wrapped = isEmpty ? ['—'] : doc.splitTextToSize(v, CW - LABEL_W - 6);
    const rowH = Math.max(8, wrapped.length * 4.5 + 4);
    if (y + rowH > 277) { newPage(); _rowShade = false; }

    // Alternating shade
    if (_rowShade) { doc.setFillColor(...C.rowAlt); doc.rect(M, y, CW, rowH, 'F'); }
    _rowShade = !_rowShade;

    // Bottom rule
    doc.setDrawColor(...C.ruleLight); doc.setLineWidth(0.25);
    doc.line(M, y+rowH, M+CW, y+rowH);

    // Orange left indicator on filled rows
    if (!isEmpty) { doc.setFillColor(...C.accent); doc.rect(M, y, 1.5, rowH, 'F'); }

    // Label
    doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(...C.inkMuted);
    doc.text(label.toUpperCase(), M+4, y+5.5);

    // Value — colour-coded
    if (isEmpty) {
      doc.setTextColor(...C.rule); doc.setFont('helvetica','italic');
    } else if (['YES','HIGH','OBSTRUCTED','BRIDGED','ACTIVE'].includes(v)) {
      doc.setTextColor(...C.danger); doc.setFont('helvetica','bold');
    } else if (['NO','LOW','CLEAR','NONE'].includes(v)) {
      doc.setTextColor(...C.safe); doc.setFont('helvetica','bold');
    } else if (['MEDIUM','INACTIVE','MODERATE'].includes(v)) {
      doc.setTextColor(...C.warn); doc.setFont('helvetica','bold');
    } else {
      doc.setTextColor(...C.ink); doc.setFont('helvetica','normal');
    }
    doc.setFontSize(8.5);
    doc.text(wrapped, M+LABEL_W, y+5.5);
    y += rowH;
  }

  function resetRowShade() { _rowShade = false; }

  // ── RISK BANNER ───────────────────────────────────────────────────────────
  function riskBanner(level) {
    if (y > 268) newPage();
    gap(4);
    const col = level==='HIGH' ? C.danger : level==='MEDIUM' ? C.warn : C.safe;
    const bgTint = level==='HIGH' ? [253,242,240] : level==='MEDIUM' ? [253,247,234] : [239,249,237];

    // Tinted background box
    doc.setFillColor(...bgTint); doc.roundedRect(M, y, CW, 18, 2, 2, 'F');
    // Coloured left bar
    doc.setFillColor(...col); doc.roundedRect(M, y, 4, 18, 2, 2, 'F');
    doc.rect(M+2, y, 2, 18, 'F'); // square off right edge
    // Border
    doc.setDrawColor(...col); doc.setLineWidth(0.6);
    doc.roundedRect(M, y, CW, 18, 2, 2, 'D');

    // Labels
    doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
    doc.text('RISK OF TERMITE ATTACK', M+8, y+6);
    doc.setFont('helvetica','bold'); doc.setFontSize(15); doc.setTextColor(...col);
    doc.text(level || 'NOT ASSESSED', M+8, y+14.5);
    doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(...C.inkLight);
    doc.text(standard, W-M-4, y+14.5, { align:'right' });
    y += 24;
  }

  // ── DISCLAIMER ────────────────────────────────────────────────────────────
  function disclaimer(text) {
    doc.setFont('helvetica','italic'); doc.setFontSize(7.5); doc.setTextColor(...C.inkMuted);
    const lines = doc.splitTextToSize(text, CW - 5);
    const blockH = lines.length * 4 + 3;
    if (y + blockH > 280) newPage();
    // Subtle left bar
    doc.setFillColor(...C.ruleLight); doc.rect(M, y, 1.5, blockH-2, 'F');
    doc.text(lines, M+4, y+1); y += blockH + 2;
    doc.setFont('helvetica','normal');
  }

  // ── STRUCTURAL CONCERN BOX ────────────────────────────────────────────────
  function referralBox() {
    const text = 'STRUCTURAL CONCERN FLAGGED: The damage described above appears to potentially affect structural elements. This inspector is not qualified to assess structural damage severity or load-bearing capacity. A licensed builder or structural engineer should be engaged to determine the extent of any structural impact before proceeding.';
    doc.setFont('helvetica','bold'); doc.setFontSize(8);
    const lines = doc.splitTextToSize(text, CW-10);
    const blockH = lines.length*4.2+8;
    if (y + blockH > 280) newPage();
    // Light red background
    doc.setFillColor(253,242,240); doc.roundedRect(M, y, CW, blockH, 2, 2, 'F');
    doc.setDrawColor(...C.danger); doc.setLineWidth(0.6);
    doc.roundedRect(M, y, CW, blockH, 2, 2, 'D');
    doc.setFillColor(...C.danger); doc.roundedRect(M, y, 4, blockH, 2, 2, 'F');
    doc.rect(M+2, y, 2, blockH, 'F');
    doc.setTextColor(...C.danger);
    doc.text(lines, M+7, y+6);
    y += blockH+4;
    doc.setFont('helvetica','normal'); doc.setTextColor(...C.ink);
  }

  // ── PHOTO GALLERY ─────────────────────────────────────────────────────────
  // ── PDF SECTION PHOTO RENDERER ─────────────────────────────────────────
  function renderSectionPhotosInPDF(sectionKey, label) {
    const photos = (reportData.photosBySection || {})[sectionKey] || [];
    if (photos.length === 0) return;

    gap(4);
    if (y + 10 > 275) newPage();

    // Photo section sub-header
    doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
    doc.text('PHOTOGRAPHIC EVIDENCE — ' + label.toUpperCase(), M, y); y += 4;
    doc.setFillColor(...C.ruleLight); doc.rect(M, y, CW, 0.4, 'F'); y += 5;

    const photoW = (CW - 4) / 2;
    const photoH = photoW * 0.65;

    let col = 0;
    let rowStartY = y;

    photos.forEach((p, idx) => {
      const x = M + col * (photoW + 4);
      if (y + photoH + 18 > 278) { newPage(); rowStartY = y; col = 0; }

      try {
        const fmt = p.dataUrl.includes('data:image/png') ? 'PNG' : 'JPEG';
        doc.addImage(p.dataUrl, fmt, x, y, photoW, photoH, undefined, 'FAST');
        doc.setDrawColor(...C.rule); doc.setLineWidth(0.3);
        doc.rect(x, y, photoW, photoH, 'D');
        if (p.caption && p.caption.trim()) {
          doc.setFont('helvetica','normal'); doc.setFontSize(6.5); doc.setTextColor(...C.inkLight);
          const capLines = doc.splitTextToSize(p.caption.trim(), photoW - 2);
          doc.text(capLines[0], x, y + photoH + 4);
        }
      } catch(e) {
        // If image fails, draw placeholder
        doc.setFillColor(...C.rowAlt); doc.rect(x, y, photoW, photoH, 'F');
        doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
        doc.text('[Photo unavailable]', x + photoW/2, y + photoH/2, { align:'center' });
      }

      col++;
      if (col >= 2) {
        col = 0;
        y += photoH + 14;
        rowStartY = y;
      }
    });

    if (col > 0) y += photoH + 14;
    gap(4);
  }

  function photoPlaceholder(label) {
    // No longer used for placeholder — real photos are rendered by renderSectionPhotosInPDF
    return;
  }

  function photoGallery() {
    const photos = reportData.photos;
    if (!photos || !photos.length) return;
    sectionTitle('PHOTOGRAPHIC EVIDENCE', '9');
    const gutter = 6, colW = (CW - gutter) / 2, maxImgH = 58, captionGap = 4;
    function computeBox(p) {
      let w = colW, h = w * (p.height / p.width);
      if (h > maxImgH) { h = maxImgH; w = h * (p.width / p.height); }
      return { w, h };
    }
    for (let i = 0; i < photos.length; i += 2) {
      const rowPhotos = [photos[i], photos[i+1]].filter(Boolean);
      const boxes = rowPhotos.map(computeBox);
      const capLines = rowPhotos.map((p, idx) => doc.splitTextToSize(p.caption || `Photo ${i+idx+1}`, colW));
      const capHeights = capLines.map(lines => lines.length * 3.6);
      const rowHeight = Math.max(...boxes.map((b,idx) => b.h + captionGap + capHeights[idx]));
      if (y + rowHeight > 280) newPage();
      rowPhotos.forEach((p, idx) => {
        const colX = M + idx * (colW + gutter);
        const box = boxes[idx];
        const imgX = colX + (colW - box.w) / 2;
        try { doc.addImage(p.dataUrl, 'JPEG', imgX, y, box.w, box.h); } catch(e) {}
        doc.setDrawColor(...C.rule); doc.setLineWidth(0.3);
        doc.rect(imgX, y, box.w, box.h, 'D');
        doc.setFont('helvetica','italic'); doc.setFontSize(7.5); doc.setTextColor(...C.inkMuted);
        doc.text(capLines[idx], colX, y + box.h + captionGap);
      });
      y += rowHeight + 8;
    }
    gap(4);
  }

  // ── NOTES BLOCK ───────────────────────────────────────────────────────────
  const FIELD_LABELS = {
    structureType:'Structure Type', wallConstruction:'Wall Construction', floorType:'Floor Type', roofType:'Roof Type',
    height:'Height', facadeDirection:'Orientation', occupancyStatus:'Occupancy Status', weatherConditions:'Weather Conditions',
    constructionEra:'Year / Period of Construction', standard:'Applicable Standard',
    hinderedAreas:'Readily Accessible Areas Inspected', obstructions:'Areas Not Inspected', restrictedAccess:'Obstructions', hinderedAreasDetail:'Restrictions', highRiskAreas:'High Risk Areas',
    termiteActivity:'Termite Activity Status', species:'Species', damageDescription:'Damage Description', activityLocation:'Location of Activity', nestLocated:'Workings / Nest Located', structuralConcern:'Structural Concern Flagged',
    waterLeaks:'Water Leaks', leakLocation:'Location of Moisture Ingress', moistureReadings:'Moisture Readings', timberSoil:'Timber-to-Soil Contact', slabEdge:'Slab Edge Concealed', weepHoles:'Weep Holes (Clear / Bridged)', existingSystem:'Existing System',
    durableNoticePresent:'Durable Notice Present', hardLandscaping:'Hard Landscaping Adjacent', zone25mmVisible:'25mm Inspection Zone Visible', softLandscaping:'Soft Landscaping Adjacent', zone75mmVisible:'75mm Inspection Zone Visible', antCapSoldered:'Ant Cap Joins Soldered',
    treatmentRecommended:'Treatment Recommended', treatmentType:'Treatment Type', inspectionFrequency:'Inspection Frequency', riskLevel:'Risk of Termite Attack',
  };

  function notesBlock(sectionKey) {
    const keys = (SECTIONS[sectionKey] && SECTIONS[sectionKey].fields) || [];
    const notes = keys.map(k => [k, (fieldNotes[k]||'').trim()]).filter(([,v]) => v.length > 0);
    if (notes.length === 0) return;
    if (y > 250) newPage();
    gap(3);
    doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
    doc.text('ADDITIONAL NOTES', M, y); y += 5;
    notes.forEach(([key, text]) => {
      if (y > 270) newPage();
      doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...C.accentDark);
      doc.text((FIELD_LABELS[key] || key) + ':', M, y); y += 4.5;
      doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(...C.ink);
      const wrapped = doc.splitTextToSize(text, CW-4);
      if (y + wrapped.length*4 > 280) newPage();
      doc.text(wrapped, M+2, y); y += wrapped.length*4+4;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COVER PAGE
  // ═══════════════════════════════════════════════════════════════════════════
  // White cover — professional, clean, client-facing

  // Full white page
  doc.setFillColor(...C.white); doc.rect(0, 0, W, 297, 'F');

  // Top dark header band
  doc.setFillColor(...C.coverDark); doc.rect(0, 0, W, 52, 'F');
  // Orange accent stripe at top
  doc.setFillColor(...C.accent); doc.rect(0, 0, W, 3, 'F');
  // Orange left edge
  doc.setFillColor(...C.accent); doc.rect(0, 0, 4, 52, 'F');

  const company = getCompanyDetails();

  drawPdfCompanyMark(doc, company);

  if (company.name) {
    doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(240,234,224);
    doc.text(company.name, 40, 22);
    const sub = [];
    if (company.licence) sub.push(`Lic: ${company.licence}`);
    if (company.phone)   sub.push(company.phone);
    if (company.abn)     sub.push(`ABN: ${company.abn}`);
    if (sub.length) {
      doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(160,150,138);
      doc.text(sub.join('   ·   '), 40, 29);
    }
  } else {
    doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(240,234,224);
    doc.text('KORVUS', 40, 22);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(160,150,138);
    doc.text('Intelligent Inspection Platform', 40, 29);
  }

  // Date in top-right corner of header
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(160,150,138);
  doc.text(today, W-8, 22, { align:'right' });

  // ── TITLE BLOCK ───────────────────────────────────────────────────────────
  // Report type label
  const reportTypeLabel = standard.startsWith('AS 4349') ? 'TIMBER PEST & BUILDING' : 'TIMBER PEST';
  doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...C.accent);
  doc.text(reportTypeLabel, M, 70);

  // Large report title
  doc.setFont('helvetica','bold'); doc.setFontSize(34); doc.setTextColor(...C.ink);
  doc.text('INSPECTION', M, 88);
  doc.text('REPORT', M, 104);

  // Orange underline
  doc.setFillColor(...C.accent); doc.rect(M, 107, 32, 2, 'F');

  // Standard reference
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...C.inkLight);
  doc.text('Prepared in accordance with', M, 118);
  doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...C.ink);
  doc.text(standardLabel, M, 125);

  // ── PROPERTY DETAILS CARD ──────────────────────────────────────────────────
  const jobInfo = {
    orderId:       reportData.jobOrderId || '',
    invoiceNo:     reportData.jobInvoiceNo || '',
    type:          reportData.jobInspectionType || '',
    time:          reportData.jobInspectionTime || '',
    fee:           reportData.jobFee || '',
    paymentStatus: reportData.jobPaymentStatus || '',
    clientPhone:   reportData.jobClientPhone || '',
    clientEmail:   reportData.jobClientEmail || '',
  };

  const coverRows = [
    ['PROPERTY ADDRESS',  address],
    ['CLIENT',            client],
    ['CLIENT PHONE',      reportData.jobClientPhone || ''],
    ['INSPECTOR',         inspector],
    ['PEST LICENCE NO.',  reportData.inspectorLicence || ''],
    ['DATE OF INSPECTION',today],
    ['INSPECTION TIME',   reportData.jobInspectionTime || ''],
    ['INSPECTION TYPE',   reportData.jobInspectionType || ''],
    ['ORDER / JOB ID',    reportData.jobOrderId || ''],
    ['INVOICE NO.',       reportData.jobInvoiceNo || ''],
    ['REPORT REFERENCE',  reportId],
  ].filter(([, v]) => v);

  const cardY = 136;
  const cardH = 10 + coverRows.length * 11;

  // Card shadow (subtle)
  doc.setFillColor(235,232,228); doc.roundedRect(M+1, cardY+1, CW, cardH, 3, 3, 'F');
  // Card background
  doc.setFillColor(...C.white); doc.roundedRect(M, cardY, CW, cardH, 3, 3, 'F');
  // Card border
  doc.setDrawColor(...C.rule); doc.setLineWidth(0.5);
  doc.roundedRect(M, cardY, CW, cardH, 3, 3, 'D');
  // Orange left stripe
  doc.setFillColor(...C.accent); doc.roundedRect(M, cardY, 4, cardH, 3, 3, 'F');
  doc.rect(M+2, cardY, 2, cardH, 'F');

  let cy = cardY + 9;
  coverRows.forEach(([label, val]) => {
    doc.setFont('helvetica','bold'); doc.setFontSize(6); doc.setTextColor(...C.inkMuted);
    doc.text(label, M+8, cy);
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...C.ink);
    const vWrapped = doc.splitTextToSize(String(val), CW-72);
    doc.text(vWrapped[0], M+55, cy);
    cy += 11;
  });

  // ── RISK ASSESSMENT BADGE ─────────────────────────────────────────────────
  const riskLvl   = reportData.riskLevel || null;
  const riskBadgeY = cardY + cardH + 10;
  const riskCol    = riskLvl==='HIGH' ? C.danger : riskLvl==='MEDIUM' ? C.warn : riskLvl==='LOW' ? C.safe : C.inkMuted;
  const riskBgCol  = riskLvl==='HIGH' ? [253,242,240] : riskLvl==='MEDIUM' ? [253,247,234] : riskLvl==='LOW' ? [239,249,237] : [248,246,243];

  if (riskBadgeY < 265) {
    doc.setFillColor(...riskBgCol); doc.roundedRect(M, riskBadgeY, CW, 20, 3, 3, 'F');
    doc.setDrawColor(...riskCol); doc.setLineWidth(0.8);
    doc.roundedRect(M, riskBadgeY, CW, 20, 3, 3, 'D');
    doc.setFillColor(...riskCol); doc.roundedRect(M, riskBadgeY, 4, 20, 3, 3, 'F');
    doc.rect(M+2, riskBadgeY, 2, 20, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
    doc.text('RISK OF TERMITE ATTACK', M+8, riskBadgeY+7);
    doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...riskCol);
    doc.text(riskLvl || 'PENDING ASSESSMENT', M+8, riskBadgeY+16);
    // Show species from first active finding if present
    const firstSpecies = (reportData.findings || []).find(f => f.species)?.species || reportData.species;
    if (firstSpecies) {
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...C.inkLight);
      doc.text(firstSpecies, W-M-5, riskBadgeY+16, { align:'right' });
    }
  }

  // ── COVER FOOTER ──────────────────────────────────────────────────────────
  doc.setFillColor(...C.rowAlt); doc.rect(0, 284, W, 13, 'F');
  doc.setFillColor(...C.accent); doc.rect(0, 284, W, 0.6, 'F');
  doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
  const footerPreparedBy = company.name ? `Prepared by ${company.name}` : 'Generated via KORVUS';
  doc.text(footerPreparedBy, M, 291);
  doc.text('This report does not conclusively determine that the property is free of termites.', W/2, 291, { align:'center' });
  doc.setFont('helvetica','bold'); doc.setTextColor(...C.accent);
  doc.text(today, W-M, 291, { align:'right' });

  // ─────────────────────────────────────────────────────────────────────
  // PAGE 2 — CLIENT, PROPERTY & SUMMARY
  // ─────────────────────────────────────────────────────────────────────
  newPage();
  compactHeader('Client & Property Details');
  resetRowShade();

  sectionTitle('CLIENT & JOB DETAILS', '1');
  const co = getCompanyDetails();
  if (co.name)    row('Inspecting Company', co.name);
  if (co.licence) row('Pest Control Licence', co.licence);
  if (co.phone)   row('Company Phone', co.phone);
  if (co.abn)     row('ABN', co.abn);
  // Address and client name are always required
  row('Property Inspected', address);
  row('Client Name', client);
  // Optional client contact fields — only print if filled
  const clientPhone = reportData.jobClientPhone || document.getElementById('jobClientPhone')?.value?.trim();
  const clientEmail = reportData.jobClientEmail || document.getElementById('jobClientEmail')?.value?.trim();
  if (clientPhone) row('Client Phone', clientPhone);
  if (clientEmail) row('Client Email', clientEmail);
  // Inspector and date always print
  row('Inspection Date', today);
  const inspectionTime = reportData.jobInspectionTime || document.getElementById('jobInspectionTime')?.value?.trim();
  if (inspectionTime) row('Inspection Time', inspectionTime);
  // Optional job tracking fields
  const orderId    = reportData.jobOrderId    || document.getElementById('jobOrderId')?.value?.trim();
  const invoiceNo  = reportData.jobInvoiceNo  || document.getElementById('jobInvoiceNo')?.value?.trim();
  const inspType   = reportData.jobInspectionType || document.getElementById('jobInspectionType')?.value?.trim();
  const fee        = reportData.jobFee        || document.getElementById('jobFee')?.value?.trim();
  if (inspType)   row('Inspection Type', inspType);
  if (orderId)    row('Order / Job ID', orderId);
  if (invoiceNo)  row('Invoice No.', invoiceNo);
  if (fee)        row('Fee (inc. GST)', fee);
  gap(8);
  newPage();
  compactHeader('Property Details');
  resetRowShade();

  sectionTitle('PROPERTY DETAILS', '2');
  row('Structure Type', reportData.structureType); row('Wall Construction', reportData.wallConstruction);
  row('Floor Type', reportData.floorType); row('Roof Type', reportData.roofType);
  row('Height', reportData.height); row('Orientation', reportData.facadeDirection);
  row('Occupancy Status', reportData.occupancyStatus); row('Weather Conditions', reportData.weatherConditions);
  row('Year / Period of Construction', reportData.constructionEra); row('Applicable Standard', reportData.standard);
  if (reportData.existingSystem) {
    gap(3);
    row('Existing Termite Management System', reportData.existingSystem);
    if (reportData.existingSystemOther) row('Specific System Name', reportData.existingSystemOther);
  }
  if (reportData.constructionEra && (reportData.constructionEra === '1945-1965' || reportData.constructionEra === '1965-1985')) {
    gap(3);
    disclaimer('⚠ Construction era indicates a HIGH likelihood of asbestos-containing materials (fibro/ACM sheeting). Noted as observation only — not disturbed. Recommend licensed asbestos assessor if suspected ACM identified.');
  } else if (reportData.constructionEra && (reportData.constructionEra === '1920s-1940s' || reportData.constructionEra === '1985-2003')) {
    gap(3);
    disclaimer('⚠ Construction era indicates a MODERATE likelihood of asbestos-containing materials. Noted as observation only.');
  }
  notesBlock('property');
  gap(4);
  renderSectionPhotosInPDF('general', 'Property');

  // ─────────────────────────────────────────────────────────────────────
  // PAGE 3 — SCOPE, RISK & FINDINGS
  // ─────────────────────────────────────────────────────────────────────
  newPage();
  compactHeader('Scope, Risk & Findings');
  resetRowShade();

  // ── UNDETECTED TIMBER PEST RISK ASSESSMENT ──────────────────────────
  // Per AS 4349.3 — rate overall risk of undetected activity given
  // access limitations, obstructions and restrictions noted
  sectionTitle('UNDETECTED TIMBER PEST RISK ASSESSMENT', '3');
  resetRowShade();

  const hasObstruction = !!(reportData.obstructions && reportData.restrictedAccess);
  const hasRestriction = !!(reportData.hinderedAreas && !reportData.hinderedAreas.includes('N/A'));
  const hasActivity    = (reportData.findings || []).some(f => f.termiteActivity === 'ACTIVE' || f.termiteActivity === 'INACTIVE');
  const risk           = reportData.riskLevel || 'NOT ASSESSED';

  const undetectedRisk = hasActivity && hasObstruction ? 'HIGH' :
                         hasObstruction || (hasActivity && hasRestriction) ? 'MODERATE-HIGH' :
                         hasRestriction ? 'MODERATE' : 'LOW-MODERATE';

  const undetectedCol = undetectedRisk === 'HIGH' ? C.danger :
                        undetectedRisk === 'MODERATE-HIGH' ? C.warn :
                        undetectedRisk === 'MODERATE' ? [160, 100, 20] : C.safe;
  const undetectedBg  = undetectedRisk === 'HIGH' ? [253,242,240] :
                        undetectedRisk.includes('MODERATE') ? [253,247,234] : [239,249,237];

  // Risk box
  if (y + 22 > 278) newPage();
  doc.setFillColor(...undetectedBg); doc.roundedRect(M, y, CW, 22, 2, 2, 'F');
  doc.setDrawColor(...undetectedCol); doc.setLineWidth(0.6); doc.roundedRect(M, y, CW, 22, 2, 2, 'D');
  doc.setFillColor(...undetectedCol); doc.roundedRect(M, y, 4, 22, 2, 2, 'F'); doc.rect(M+2, y, 2, 22, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
  doc.text('RISK OF UNDETECTED TIMBER PEST ACTIVITY', M+8, y+7);
  doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...undetectedCol);
  doc.text(undetectedRisk, M+8, y+17);
  doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(...C.inkLight);
  const undetectedNote = undetectedRisk === 'HIGH'
    ? 'Active or inactive termites found with uninspected areas. Further invasive inspection strongly recommended.'
    : undetectedRisk === 'MODERATE-HIGH'
    ? 'Access was limited or obstructed. Concealed activity cannot be ruled out in uninspected areas.'
    : undetectedRisk === 'MODERATE'
    ? 'Some areas were restricted. Regular monitoring and follow-up inspection recommended.'
    : 'All readily accessible areas were inspected. Regular inspection programme should continue.';
  const noteLines = doc.splitTextToSize(undetectedNote, CW - 80);
  doc.text(noteLines, W-M-5, y+10, { align:'right', maxWidth: 80 });
  y += 28;
  gap(4);
  disclaimer('This rating reflects the risk of timber pest activity existing but not being detected at the time of inspection, due to access limitations. It is not an assessment of pest pressure or building susceptibility.');
  gap(6);

  // ── OBSTRUCTIONS ──────────────────────────────────────────────────────
  newPage();
  compactHeader('Obstructions & Restrictions');
  resetRowShade();
  sectionTitle('OBSTRUCTIONS', '4');
  resetRowShade();
  const noObstructions = !reportData.obstructions && !reportData.restrictedAccess && !reportData.highRiskAreas;
  // Question row
  if (y + 14 > 278) newPage();
  doc.setFillColor(...C.rowAlt); doc.rect(M, y, CW, 12, 'F');
  doc.setFillColor(...C.accent); doc.rect(M, y, 1.5, 12, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(...C.inkMuted);
  doc.text('WERE THERE OBSTRUCTIONS THAT MAY CONCEAL POSSIBLE TIMBER PEST ACTIVITY?', M+4, y+5);
  const obsAns = noObstructions ? 'NO' : 'YES';
  const obsCol = noObstructions ? C.safe : C.danger;
  doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...obsCol);
  doc.text(obsAns, W-M-4, y+8, { align:'right' });
  y += 14;
  if (!noObstructions) {
    row('Areas Not Inspected', reportData.obstructions);
    row('Nature of Obstruction', reportData.restrictedAccess);
    if (reportData.highRiskAreas) row('High Risk Areas — Access Recommended', reportData.highRiskAreas);
    gap(3);
    disclaimer('A further, more invasive inspection is strongly recommended of all obstructed areas once access is provided or obstructions are removed. It must be assumed that timber pest activity may exist in these areas.');
  }
  notesBlock('obstructions');
  renderSectionPhotosInPDF('obstructions', 'Obstructions');
  gap(8);

  // ── RESTRICTIONS ──────────────────────────────────────────────────────
  if (y > 150) { newPage(); compactHeader('Restrictions'); resetRowShade(); }
  else { gap(6); doc.setFillColor(...C.ruleLight); doc.rect(M, y, CW, 0.5, 'F'); gap(6); }
  sectionTitle('RESTRICTIONS', '5');
  resetRowShade();
  const noRestrictions = !reportData.hinderedAreas || reportData.hinderedAreas.includes('N/A');
  if (y + 14 > 278) newPage();
  doc.setFillColor(...C.rowAlt); doc.rect(M, y, CW, 12, 'F');
  doc.setFillColor(...C.accent); doc.rect(M, y, 1.5, 12, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(...C.inkMuted);
  doc.text('WERE THERE CONDITIONS THAT RESTRICTED BUT DID NOT PREVENT INSPECTION?', M+4, y+5);
  const resAns = noRestrictions ? 'NO' : 'YES';
  const resCol = noRestrictions ? C.safe : C.warn;
  doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...resCol);
  doc.text(resAns, W-M-4, y+8, { align:'right' });
  y += 14;
  if (!noRestrictions) {
    row('Areas Where Inspection Was Restricted', reportData.hinderedAreas);
    row('Nature of Restriction', reportData.hinderedAreasDetail);
    gap(3);
    disclaimer('Areas where inspection was limited may contain concealed timber pest activity or damage. Restricted areas should be assessed once limitations are resolved.');
  }
  notesBlock('restrictions');
  renderSectionPhotosInPDF('restrictions', 'Restrictions');
  gap(8);

  // ── TIMBER PEST FINDINGS ─────────────────────────────────────────────
  newPage();
  compactHeader('Timber Pest Findings');
  resetRowShade();
  sectionTitle('TIMBER PEST FINDINGS', '6');

  const findings = (reportData.findings && reportData.findings.length > 0)
    ? reportData.findings
    : [{ termiteActivity: reportData.termiteActivity, species: reportData.species, damageDescription: reportData.damageDescription, activityLocation: reportData.activityLocation, nestLocated: reportData.nestLocated, structuralConcern: reportData.structuralConcern }];

  // ── Premium finding card renderer ────────────────────────────────────
  function findingCard(f, idx) {
    const activity  = (f.termiteActivity || 'NONE').toUpperCase();
    const isActive  = activity === 'ACTIVE';
    const isInactive= activity === 'INACTIVE';
    const actCol    = isActive ? C.danger : isInactive ? C.warn : C.inkMuted;
    const actBg     = isActive ? [253,242,240] : isInactive ? [253,247,234] : [248,246,243];
    const actLabel  = isActive ? 'LIVE TERMITES PRESENT' : isInactive ? 'EVIDENCE ONLY — NO LIVE TERMITES' : 'NO ACTIVITY FOUND';

    const descLines = f.damageDescription ? doc.splitTextToSize(f.damageDescription, CW-10).length : 0;
    const locLines  = f.activityLocation  ? doc.splitTextToSize(f.activityLocation,  CW-10).length : 0;
    const cardEstH  = 18 + 14 + (f.species ? 12 : 0) + (descLines * 4.5 + 8) + (locLines * 4.5 + 8) + (f.nestLocated ? 10 : 0) + (f.structuralConcern === 'YES' ? 20 : 0) + 8;

    if (y + Math.min(cardEstH, 60) > 275) newPage();

    const cardStartY = y;
    const bodyPad = 6;
    const bodyX   = M + bodyPad;
    const bodyW   = CW - bodyPad * 2;

    // Header
    const headerH = 13;
    doc.setFillColor(...actBg); doc.rect(M, y, CW, headerH, 'F');
    doc.setFillColor(...actCol); doc.rect(M, y, 4, headerH, 'F');
    doc.setDrawColor(...actCol); doc.setLineWidth(0.5);
    doc.line(M, y+headerH, M+CW, y+headerH);
    doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
    doc.text(`FINDING ${idx + 1}`, M+8, y+5.5);
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...actCol);
    doc.text(actLabel, M+8, y+10.5);
    doc.setFillColor(...actCol); doc.circle(M+CW-6, y+7, 3, 'F');
    y += headerH + 5;

    // Species
    if (f.species && f.species.trim()) {
      const speciesMatch = lookupSpecies(f.species);
      const riskTag = speciesMatch ? speciesMatch.data.riskLabel || '' : '';
      const riskCol2 = riskTag.includes('EXTREME') ? C.danger : riskTag.includes('HIGH') ? [180,100,20] : C.inkMuted;
      doc.setFillColor(245,243,240); doc.roundedRect(bodyX, y, bodyW, 10, 1, 1, 'F');
      doc.setDrawColor(...C.rule); doc.setLineWidth(0.3); doc.roundedRect(bodyX, y, bodyW, 10, 1, 1, 'D');
      doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
      doc.text('SPECIES / GENUS', bodyX+4, y+4.5);
      doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...C.ink);
      doc.text(f.species, bodyX+4, y+8.5);
      if (riskTag) {
        doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...riskCol2);
        doc.text(riskTag, M+CW-bodyPad-4, y+8.5, { align:'right' });
      }
      y += 14;
    }

    // Was a nest found?
    if (y > 272) newPage();
    doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(...C.inkMuted);
    doc.text('TERMITE NEST FOUND?', bodyX, y); y += 4.5;
    const nestVal = f.nestLocated === 'YES' ? 'YES' : 'NO';
    const nestCol = f.nestLocated === 'YES' ? C.danger : C.safe;
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
    doc.setTextColor(...nestCol);
    doc.text(nestVal, bodyX, y); y += 7;

    // Location
    if (f.activityLocation && f.activityLocation.trim()) {
      if (y > 272) newPage();
      doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(...C.inkMuted);
      doc.text('LOCATION OF ACTIVITY', bodyX, y); y += 4.5;
      doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(...C.ink);
      const locW = doc.splitTextToSize(f.activityLocation, bodyW);
      if (y + locW.length*4.5 > 278) newPage();
      doc.text(locW, bodyX, y); y += locW.length * 4.5 + 5;
    }

    // Damage description
    if (f.damageDescription && f.damageDescription.trim()) {
      if (y > 265) newPage();
      doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(...C.inkMuted);
      doc.text('DAMAGE / WORKINGS DESCRIPTION', bodyX, y); y += 4.5;
      doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(...C.ink);
      const descW = doc.splitTextToSize(f.damageDescription, bodyW);
      if (y + descW.length*4.5 > 278) newPage();
      doc.text(descW, bodyX, y); y += descW.length * 4.5 + 5;
    }

    // Structural concern
    if (f.structuralConcern === 'YES') {
      if (y > 268) newPage();
      y += 2;
      const scText = 'STRUCTURAL CONCERN — The damage observed appears to affect structural elements. Engage a licensed builder or structural engineer to assess load-bearing impact before any work proceeds.';
      const scLines = doc.splitTextToSize(scText, bodyW-8);
      const scH = scLines.length*4+8;
      doc.setFillColor(253,242,240); doc.roundedRect(bodyX, y, bodyW, scH, 1.5, 1.5, 'F');
      doc.setDrawColor(...C.danger); doc.setLineWidth(0.5); doc.roundedRect(bodyX, y, bodyW, scH, 1.5, 1.5, 'D');
      doc.setFillColor(...C.danger); doc.roundedRect(bodyX, y, 3, scH, 1.5, 1.5, 'F');
      doc.rect(bodyX+1.5, y, 1.5, scH, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...C.danger);
      doc.text(scLines, bodyX+6, y+5.5);
      y += scH + 4;
    }

    y += 3;
    doc.setDrawColor(...C.rule); doc.setLineWidth(0.4);
    doc.rect(M, cardStartY, CW, y - cardStartY, 'D');
    y += 8;
  }

  findings.forEach((f, idx) => findingCard(f, idx));

  gap(2);
  disclaimer('This inspection describes the location and visible extent of timber pest activity only. It does not assess structural damage severity — a licensed builder or structural engineer must be engaged for that purpose. Where live termites are found, concealed activity must be assumed in all areas not inspected.');
  notesBlock('findings');
  gap(4);
  renderSectionPhotosInPDF('findings', 'Timber Pest Findings');

  // ─────────────────────────────────────────────────────────────────────
  // PAGE 4 — CONDUCIVE CONDITIONS, RECOMMENDATIONS, SIGN-OFF
  // ─────────────────────────────────────────────────────────────────────
  newPage();
  compactHeader('Conducive Conditions & Recommendations');
  resetRowShade();

  sectionTitle('CONDUCIVE CONDITIONS', '7');
  resetRowShade();

  // ── Moisture group ─────────────────────────────────────────────────────
  const hasMoisture = reportData.waterLeaks || reportData.moistureReadings || reportData.leakLocation;
  if (hasMoisture) {
    if (y > 250) newPage();
    doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
    doc.text('MOISTURE & DRAINAGE', M, y); y += 4;
    doc.setFillColor(...C.ruleLight); doc.rect(M, y, CW, 0.4, 'F'); y += 4;
  }
  row('Water Leaks', reportData.waterLeaks);
  row('Moisture Detected', reportData.moistureReadings);
  if (reportData.waterLeaks === 'YES' || reportData.leakLocation) {
    row('Location of Moisture Ingress', reportData.leakLocation);
    if (isAboveGroundLeak(reportData.leakLocation)) {
      gap(2);
      // Above-ground leak callout — amber warning box
      const alertText = 'ABOVE-GROUND LEAK — Subterranean termites can establish a secondary moisture-dependent colony in roof voids and wall cavities with no soil contact. Inspect timbers adjacent to this leak location specifically.';
      const alertLines = doc.splitTextToSize(alertText, CW-10);
      const alertH = alertLines.length*4+8;
      if (y + alertH > 278) newPage();
      doc.setFillColor(253,247,234); doc.roundedRect(M,y,CW,alertH,2,2,'F');
      doc.setDrawColor(...C.warn); doc.setLineWidth(0.5); doc.roundedRect(M,y,CW,alertH,2,2,'D');
      doc.setFillColor(...C.warn); doc.roundedRect(M,y,4,alertH,2,2,'F'); doc.rect(M+2,y,2,alertH,'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...C.warn);
      doc.text(alertLines, M+7, y+5.5); y += alertH+4;
    }
  }
  gap(4);

  // ── Physical barriers group ────────────────────────────────────────────
  const hasBarriers = reportData.timberSoil || reportData.slabEdge || reportData.weepHoles || reportData.highRiskAreas;
  if (hasBarriers) {
    if (y > 250) newPage();
    doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
    doc.text('PHYSICAL BARRIERS & CONSTRUCTION', M, y); y += 4;
    doc.setFillColor(...C.ruleLight); doc.rect(M, y, CW, 0.4, 'F'); y += 4;
    resetRowShade();
  }
  row('Timber-to-Soil Contact', reportData.timberSoil);
  row('Slab Edge Concealed', reportData.slabEdge);
  row('Weep Holes', reportData.weepHoles);
  if (reportData.highRiskAreas) row('Areas of Concern', reportData.highRiskAreas);
  gap(4);

  // ── Existing system group ──────────────────────────────────────────────
  if (reportData.existingSystem) {
    if (y > 245) newPage();
    doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
    doc.text('EXISTING TERMITE MANAGEMENT SYSTEM', M, y); y += 4;
    doc.setFillColor(...C.ruleLight); doc.rect(M, y, CW, 0.4, 'F'); y += 4;
    resetRowShade();
    row('Existing System — Type', reportData.existingSystem);
    if (reportData.existingSystemOther) row('Specific System Name', reportData.existingSystemOther);

    if (hasIdentifiedSystem(reportData.existingSystem)) {
      row('Durable Notice Present (Meter Box)', reportData.durableNoticePresent);
      row('Hard Landscaping Adjacent', reportData.hardLandscaping);
      row('25mm Inspection Zone Visible', reportData.zone25mmVisible);
      row('Soft Landscaping Adjacent', reportData.softLandscaping);
      row('75mm Inspection Zone Visible', reportData.zone75mmVisible);
      row('Ant Cap / Strip Shield Joins Soldered', reportData.antCapSoldered);

      const concerns = [];
      if (reportData.durableNoticePresent === 'NO') concerns.push('Durable notice sticker not found in meter box');
      if (reportData.hardLandscaping === 'YES' && reportData.zone25mmVisible === 'NO') concerns.push('25mm inspection zone not visible against hard landscaping');
      if (reportData.softLandscaping === 'YES' && reportData.zone75mmVisible === 'NO') concerns.push('75mm inspection zone not visible against soft landscaping');
      if (reportData.antCapSoldered === 'NO') concerns.push('Ant cap / strip shield joins not soldered');

      if (concerns.length > 0) {
        gap(3);
        const cText = 'SYSTEM VERIFICATION CONCERN: ' + concerns.join('. ') + '. These checks verify the system can still be properly inspected — not its effectiveness. Recommend rectification and re-inspection.';
        const cLines = doc.splitTextToSize(cText, CW-10);
        const cH = cLines.length*4+8;
        if (y + cH > 278) newPage();
        doc.setFillColor(253,242,240); doc.roundedRect(M,y,CW,cH,2,2,'F');
        doc.setDrawColor(...C.danger); doc.setLineWidth(0.5); doc.roundedRect(M,y,CW,cH,2,2,'D');
        doc.setFillColor(...C.danger); doc.roundedRect(M,y,4,cH,2,2,'F'); doc.rect(M+2,y,2,cH,'F');
        doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...C.danger);
        doc.text(cLines, M+7, y+5.5); y += cH+4;
      }
    }
    gap(4);
  }

  notesBlock('conducive');
  gap(4);
  renderSectionPhotosInPDF('conducive', 'Conducive Conditions');

  newPage();
  compactHeader('Recommendations');
  resetRowShade();

  sectionTitle('RECOMMENDATIONS', '8');
  resetRowShade();
  row('Risk of Termite Attack', reportData.riskLevel);
  row('Treatment Recommended', reportData.treatmentRecommended);
  row('Treatment Type', reportData.treatmentType);
  row('Re-inspection Interval', reportData.inspectionFrequency);
  notesBlock('recommendations');
  renderSectionPhotosInPDF('recommendations', 'Recommendations');
  gap(4);
  disclaimer('Note: standard home and contents insurance policies in Australia typically do not cover damage caused by termites or other timber pests. Treatment and any resulting repairs are generally the responsibility of the property owner.');
  gap(8);

  photoGallery();

  // ─────────────────────────────────────────────────────────────────────
  // CONCLUSION + TERMS & CONDITIONS
  // ─────────────────────────────────────────────────────────────────────
  newPage();
  compactHeader('Scope of Inspection & Definitions');
  resetRowShade();

  // ── WHAT IS A TIMBER PEST INSPECTION? ───────────────────────────────────
  sectionTitle('WHAT IS A TIMBER PEST INSPECTION?', '');
  gap(2);

  function infoPara(text) {
    const wrapped = doc.splitTextToSize(text, CW);
    if (y + wrapped.length * 4.3 > 278) newPage();
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...C.inkLight);
    doc.text(wrapped, M, y); y += wrapped.length * 4.3 + 4;
  }
  function infoHeading(text) {
    if (y > 265) newPage();
    gap(3);
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...C.ink);
    doc.text(text, M, y); y += 6;
  }

  infoPara('A timber pest inspection is a visual, non-invasive inspection of a property for evidence of timber pest activity, damage, and conditions conducive to timber pest attack. The inspection is carried out by a qualified timber pest inspector in accordance with the applicable Australian Standard and is limited to those areas and sections of the property that are safely and reasonably accessible at the time of inspection.');

  infoHeading('What timber pests are covered?');
  infoPara('This inspection covers subterranean termites (white ants), drywood termites, wood borers, and wood decay fungi (rot) where evidence is observable in accessible areas. These are the timber pests defined in AS 4349.3-2010.');

  infoHeading('What does "non-invasive" mean?');
  infoPara('This inspection does not involve moving furniture, lifting floor coverings, cutting into walls, removing ceiling linings, dismantling built-in cabinetry, or any other action that could cause damage to the property or its contents. The inspector uses visual observation, a probe or screwdriver for tapping and sounding, and a moisture meter where appropriate. Splinter testing of structural timbers in the subfloor or roof void may be carried out where it can be done safely and with the property owner\'s consent.');

  infoHeading('What is "Reasonable Access"?');
  infoPara('Reasonable access is defined in AS 4349.3-2010 as access to areas of the property that can be inspected without the need to remove, move, or dismantle any fixed or stored items, and which can be reached using a 3.6m ladder or less from the ground. Subfloor areas require a minimum clearance of 400mm under the lowest bearer, and roof voids require an access opening of at least 450mm x 400mm. Areas not meeting these criteria are outside the scope of this inspection.');

  infoHeading('What are "Readily Accessible Areas"?');
  infoPara('Readily accessible areas are those parts of the property that can be reached and observed without the need to remove or disturb furniture, stored goods, floor coverings, wall or ceiling linings, insulation, or fixed cabinetry. The inspector is not required — and does not — move or displace any items during this inspection.');

  infoHeading('Does this inspection guarantee the property is free of termites?');
  infoPara('No. A visual, non-invasive inspection of this type cannot detect timber pest activity or damage concealed within walls, under floors, inside structural timbers, or in any area that was not accessible at the time of inspection. Termites frequently operate within concealed spaces without external evidence. This report reflects the observable condition of the property at the specific date and time of inspection only. Regular professional re-inspections are the most effective ongoing protection available.');

  // ── DEFINITIONS ──────────────────────────────────────────────────────────
  gap(6);
  sectionTitle('DEFINITIONS', '');
  gap(2);

  const defs = [
    ['Timber Pests', 'Subterranean termites, drywood termites, borers of seasoned timber, and wood decay fungi (rot) as defined in AS 4349.3-2010.'],
    ['Visual Inspection', 'An inspection conducted by an inspector who uses their unaided visual faculties, and may use a probe, screwdriver, or moisture meter, to observe accessible areas of the property for evidence of timber pest activity, damage, and conducive conditions.'],
    ['Reasonable Access', 'Access to areas of a building that are safe, accessible, and do not require any removal, dismantling, or disturbance of fixed or stored items. Access is via a standard 3.6m ladder from ground level. Subfloor access requires minimum 400mm clearance; roof void access requires minimum 450mm x 400mm opening.'],
    ['Readily Accessible Area', 'An area that can be inspected without moving furniture, stored goods, floor coverings, wall or ceiling linings, insulation, or personal possessions.'],
    ['Obstructions', 'Physical items or conditions that prevent a complete visual inspection of an accessible area, including but not limited to furniture, stored goods, floor coverings, insulation, and vegetation. The inspector is not required to move obstructions.'],
    ['Restrictions', 'Physical, safety, or design constraints that prevent the inspector from entering an area under the applicable Australian Standard, including subfloor clearance below 400mm, access hatch dimensions below minimum standard, unsafe structures, asbestos risk, or height beyond safe ladder reach.'],
    ['Conducive Conditions', 'Conditions that may attract termites or provide conditions favourable to timber pest activity, including moisture, timber-to-soil contact, inadequate drainage, and conditions that compromise the integrity of an existing termite management system.'],
    ['Active Termites', 'Live termites sighted by the inspector during the inspection.'],
    ['Inactive / Evidence Only', 'Evidence of past termite activity including workings, mudding, damaged timber, and galleries, where no live termites were sighted. This finding is equally significant as active termites and warrants immediate professional attention.'],
  ];

  defs.forEach(([term, def]) => {
    if (y + 14 > 278) newPage();
    doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...C.ink);
    doc.text(term + ':', M, y); y += 4.5;
    const wrapped = doc.splitTextToSize(def, CW - 4);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(...C.inkLight);
    doc.text(wrapped, M + 3, y); y += wrapped.length * 4 + 5;
  });

  gap(4);

  // ── IMPORTANT NOTICE ─────────────────────────────────────────────────────
  if (y + 28 > 278) newPage();
  doc.setFillColor(...C.accentLight); doc.roundedRect(M, y, CW, 28, 2, 2, 'F');
  doc.setFillColor(...C.accent); doc.roundedRect(M, y, 3, 28, 2, 2, 'F'); doc.rect(M+1.5, y, 1.5, 28, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...C.accentDark);
  doc.text('IMPORTANT NOTICE', M+7, y+7);
  doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(...C.ink);
  const noticeLines = doc.splitTextToSize('This inspection fee covers the cost of the inspection and report only. Treatment of any timber pest activity or damage identified, and any remedial work required, is not included in this fee and is the responsibility of the property owner. Standard home and contents insurance policies do not cover termite damage. If you have concerns about your coverage, contact your insurer directly.', CW - 14);
  doc.text(noticeLines, M+7, y+13);
  y += 34;

  newPage();
  compactHeader('Conclusion');
  resetRowShade();

  // ── CONCLUSION ─────────────────────────────────────────────────────
  sectionTitle('CONCLUSION', '');
  gap(2);

  const conclusionItems = [
    ['Treatment of timber pest activity is required', findings.some(f => f.termiteActivity === 'ACTIVE') ? 'YES — SEE FINDINGS' : 'NO'],
    ['A termite management proposal is recommended', reportData.treatmentRecommended === 'YES' ? 'YES' : 'NO'],
    ['Removal of conducive conditions is necessary', (reportData.waterLeaks === 'YES' || reportData.timberSoil === 'YES' || reportData.weepHoles === 'BRIDGED') ? 'YES — SEE CONDUCIVE CONDITIONS' : 'NO'],
    ['Risk of termite attack', reportData.riskLevel || 'NOT ASSESSED'],
    ['Next inspection recommended in', reportData.inspectionFrequency || '12 months (annual)'],
  ];

  conclusionItems.forEach(([label, value], i) => {
    if (y + 9 > 278) newPage();
    const isYes = value.startsWith('YES');
    const isNo  = value === 'NO';
    const dotCol = isYes ? C.danger : isNo ? C.safe : C.accent;
    doc.setFillColor(...dotCol); doc.circle(M+4, y+4.5, 4, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...C.white);
    doc.text(String(i+1), M+4, y+7, { align:'center' });
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(...C.inkLight);
    doc.text(label, M+12, y+5.5);
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
    const valCol = isYes ? C.danger : isNo ? C.safe : C.ink;
    doc.setTextColor(...valCol);
    doc.text(value, W-M-4, y+5.5, { align:'right' });
    doc.setDrawColor(...C.ruleLight); doc.setLineWidth(0.3);
    doc.line(M, y+10, M+CW, y+10);
    y += 12;
  });
  gap(8);

  newPage();
  compactHeader('Terms & Conditions of Inspection');
  resetRowShade();

  sectionTitle('TERMS & CONDITIONS OF INSPECTION', '9');

  const TC = { font:'helvetica', size:8, color:[50,44,38], leading:4.4 };
  const TCH = [28,24,20];

  function tcHeading(text) {
    if (y > 268) newPage();
    gap(4);
    // Subtle teal left bar for each clause heading
    doc.setFillColor(...C.accent); doc.rect(M, y-1, 2, 8, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...C.ink);
    doc.text(text, M+6, y+5); y += 8;
  }
  function tcPara(text) {
    const wrapped = doc.splitTextToSize(text, CW-6);
    if (y + wrapped.length * TC.leading > 278) newPage();
    doc.setFont(TC.font,'normal'); doc.setFontSize(TC.size); doc.setTextColor(...TC.color);
    doc.text(wrapped, M+6, y); y += wrapped.length * TC.leading + 4;
  }

  tcHeading('1. Purpose and Nature of This Inspection');
  tcPara(`This report records the findings of a visual, non-invasive timber pest inspection carried out in accordance with ${standard}. The purpose is to identify observable evidence of timber pest activity, damage, and conditions conducive to pest attack within the accessible areas of the property at the time of inspection. This is not a structural inspection, a pest control treatment, a compliance audit, or a certificate of any kind, and it does not constitute a warranty or guarantee that the property is or will remain free of timber pests or associated damage.`);

  tcHeading('2. Scope of Inspection');
  tcPara('The inspection was confined to areas that were safely and reasonably accessible at the time of the inspection. Readily accessible areas are defined in AS 4349.3-2010 as those that can be inspected without moving furniture, lifting or removing floor coverings or wall linings, breaking apart building elements, exposing concealed spaces, or causing damage to the structure or its contents. The inspector did not move, displace, or remove any floor coverings, insulation, wall linings, ceiling materials, fixed cabinetry, furniture, stored items, or personal belongings. Subfloor and roof void areas were inspected only where safe and reasonable access was available and where minimum clearance dimensions prescribed in the relevant Standard were satisfied.');

  tcHeading('3. Areas Not Inspected — Obstructions and Restrictions');
  tcPara('Certain areas of the property were not inspected due to physical obstructions, access restrictions, safety limitations, or structural design, as recorded in the body of this report. It is acknowledged that timber pest activity or damage may exist within any area that could not be inspected. Where high-risk areas have been identified or further investigation recommended, a follow-up inspection should be carried out once access is available. The absence of recorded findings in any area is not a representation that those areas are free of timber pest activity or damage.');

  tcHeading('4. Limitations of a Visual Non-Invasive Inspection');
  tcPara('A visual, non-invasive inspection of the type described in AS 4349.3-2010 cannot detect activity or damage concealed within wall cavities, structural timber members, beneath floor slabs or coverings, inside hollow trees or stumps, behind fixed linings, or in any area that cannot be directly observed without causing damage. Subterranean termites are frequently active inside walls, flooring, and structural framing without any external indicators being visible. The findings of this report reflect observable conditions in accessible areas at the time of inspection only. No inspection of this nature can conclusively establish that a property is free of timber pest infestation, activity, or damage.');

  tcHeading('5. Damage Assessment — No Structural Opinion');
  tcPara('Where timber pest damage has been recorded in this report, the description is limited to the observable location, affected building elements, and visible characteristics of the damage. The inspector is not qualified to assess the structural significance of any damage identified, and no opinion regarding structural integrity, load-bearing capacity, or engineering risk is expressed or implied in this report. Where a structural concern has been flagged, the client is strongly advised to engage a licensed builder or structural engineer to carry out a structural assessment before undertaking any remedial work or making decisions in reliance on that finding.');

  tcHeading('6. Conditions May Change After Inspection');
  tcPara('The findings of this report reflect the observable condition of the property at the specific date and time of inspection. Timber pest colonies are dynamic and can expand, relocate, or establish new workings rapidly. Conditions at the property may change materially after the inspection date due to moisture fluctuations, building alterations, landscaping changes, or the natural movement of pest colonies. This report does not warrant or predict the future condition of the property, and the client is advised that regular professional re-inspections are the most effective ongoing protection measure available.');

  tcHeading('7. Insurance');
  tcPara('Standard home, contents, and building insurance policies in Australia do not generally cover loss or damage caused by termites, timber borers, or other timber pests. Timber pest damage is typically treated by Australian insurers as gradual deterioration rather than a sudden or accidental event and is excluded from most mainstream policies. The client is encouraged to obtain written confirmation from their insurer regarding the specific extent of their coverage before acting in reliance on this report.');

  tcHeading('8. Reliance on This Report — Client Use Only');
  tcPara('This report has been prepared exclusively for the use of the client named on the cover page of this document. It must not be provided to, or relied upon by, any third party without the prior written consent of the inspecting company. Where this report has been sought in connection with a proposed property purchase, a formal Prior-to-Purchase Timber Pest Inspection prepared in accordance with AS 4349.3-2010 and obtained prior to exchange of contracts is strongly advised. The inspecting company and inspector accept no responsibility or liability to any party other than the named client for any loss, damage, or expense arising from reliance on the contents of this report.');

  tcHeading('9. Recommended Re-inspection Frequency');
  tcPara("Annual timber pest inspections are the minimum recommended frequency under AS 3660.2-2017 in the absence of an installed termite management system. Where elevated risk factors are present — including proximity to bushland or trees, prior termite history at the property, high-moisture conditions in the subfloor or roof void, the presence of timber-to-soil contact, or susceptible construction materials — a six-monthly re-inspection interval is recommended. Where an existing termite management system is installed and verified, the re-inspection frequency specified by the system installer and manufacturer should be followed. Failure to maintain regular inspection intervals may affect the terms of any system warranty in place.");

  tcHeading('10. Applicable Standards and Legislation');
  tcPara(`This inspection and report have been prepared in accordance with ${standard} and the AEPMA (Australian Environmental Pest Managers Association) Code of Practice for Timber Pest Inspections where applicable. Where the property is newly constructed or has been subject to recent building work, the termite management provisions of the National Construction Code (NCC) and AS 3660.1-2014 (Termite Management — New Building Work) may also apply. State and Territory legislation may impose requirements additional to those set out in this Standard. This report is not a safety inspection, does not constitute advice regarding compliance with any building code or regulation, and is not a certificate of compliance under any legislation.`);

  gap(6);
  if (y + 12 > 278) newPage();
  doc.setFillColor(...C.accentLight);
  doc.setDrawColor(...C.accent);
  doc.setLineWidth(0.7);
  doc.roundedRect(M, y, CW, 12, 2, 2, 'FD');
  doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...C.accentDark);
  doc.text('This report must be read in its entirety, including these Terms and Conditions, before any reliance is placed upon its contents.', M + CW/2, y + 7.5, { align:'center', maxWidth: CW - 8 });
  y += 18;

  newPage();
  compactHeader('Inspection Agreement & Acknowledgement');
  resetRowShade();

  sectionTitle('INSPECTION AGREEMENT & ACKNOWLEDGEMENT', '10');
  gap(2);
  if (y > 210) newPage();
  disclaimer('This report relates to the condition of the property in respect of timber pest activity at the time of inspection, limited to those areas that were reasonably accessible. It is not a warranty, guarantee, or certificate of compliance with any law, insurance policy, or building standard, and does not guarantee the property is, or will remain, free of termites or other timber pests. Conditions affecting the property may change after the inspection date, and concealed or inaccessible areas may contain damage or activity that could not be identified.');
  gap(3);
  if (!standard.startsWith('AS 4349')) {
    disclaimer('This report is for the sole use of the client named above and is not intended for use by third parties. It is not suitable for use where the property is being bought or sold — a Prior-to-Purchase inspection complying with AS 4349.3 should be obtained for that purpose.');
    gap(3);
  }
  disclaimer('The client acknowledges the contents of this report and that the inspection has limitations. This report does not conclusively determine that the property is free of termites.');
  gap(8);

  // ── Inspector block ─────────────────────────────────────────────────────
  if (y + 50 > 278) newPage();
  doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
  doc.text('INSPECTOR DETAILS', M, y); y += 5;
  doc.setDrawColor(...C.rule); doc.setLineWidth(0.3); doc.line(M, y, M+CW, y); y += 5;

  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...C.ink);
  doc.text('Inspector Name:', M, y);
  doc.setFont('helvetica','bold');
  doc.text(inspector || 'Not specified', M+38, y); y += 8;

  if (reportData.inspectorLicence) {
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...C.ink);
    doc.text('Pest Licence No.:', M, y);
    doc.setFont('helvetica','bold');
    doc.text(reportData.inspectorLicence, M+38, y); y += 8;
  }

  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...C.ink);
  doc.text('Inspector Signature:', M, y);
  if (reportData.inspectorSignature) {
    try { doc.addImage(reportData.inspectorSignature, 'PNG', M+38, y-9, 40, 12); } catch(e) {}
  }
  doc.setDrawColor(...C.rule); doc.setLineWidth(0.4);
  doc.line(M+38, y+1, M+38+40, y+1); y += 14;

  doc.text('Date:', M, y);
  doc.setFont('helvetica','bold'); doc.text(today, M+38, y); y += 14;

  // ── Client acknowledgement block ─────────────────────────────────────────
  doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
  doc.text('CLIENT ACKNOWLEDGEMENT', M, y); y += 5;
  doc.setDrawColor(...C.rule); doc.setLineWidth(0.3); doc.line(M, y, M+CW, y); y += 5;

  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...C.ink);
  doc.text('Client Name:', M, y);
  doc.setDrawColor(...C.rule); doc.setLineWidth(0.4);
  doc.line(M+38, y+1, M+CW, y+1); y += 12;

  doc.text('Client Signature:', M, y);
  if (reportData.clientSignature) {
    try { doc.addImage(reportData.clientSignature, 'PNG', M+38, y-9, 40, 12); } catch(e) {}
  }
  doc.line(M+38, y+1, M+CW, y+1); y += 12;

  doc.text('Date:', M, y);
  doc.line(M+38, y+1, M+CW, y+1); y += 14;

  // Footer badge
  doc.setFillColor(...C.rowAlt); doc.roundedRect(M, y, CW, 12, 2, 2, 'F');
  doc.setFillColor(...C.accent); doc.rect(M, y, 3, 12, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...C.inkLight);
  doc.text(`Generated by KORVUS  ·  ${today}`, M+7, y+5);
  doc.setFont('helvetica','normal'); doc.setTextColor(...C.inkMuted);
  doc.text(`Report ID: ${reportId}  ·  ${standard} Compliant`, M+7, y+9);

  // ── PAGE FOOTERS ──────────────────────────────────────────────────────────
  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 2; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFillColor(...C.rowAlt); doc.rect(0, 284, W, 13, 'F');
    doc.setFillColor(...C.accent); doc.rect(0, 284, W, 0.5, 'F');
    doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(...C.inkMuted);
    doc.text(`KORVUS  ·  ${standard}`, M, 291);
    doc.text(address, W/2, 291, { align:'center' });
    doc.setFont('helvetica','bold'); doc.setTextColor(...C.inkLight);
    doc.text(`${p-1} / ${totalPages-1}`, W-M, 291, { align:'right' });
  }

  const fname = `KORVUS_${address.replace(/\s+/g,'_').substring(0,25)}_${today.replace(/\s+/g,'_')}.pdf`;
  let pdfBlob = null;

  try {
    pdfBlob = doc.output('blob');
  } catch(e) {
    showToast('Failed to generate PDF', 'error');
    return;
  }

  // Store blob for Share button and reveal it — do this before attempting delivery below,
  // so the Share button still works even if the auto-delivery path fails.
  window.__lastPdfBlob = pdfBlob;
  window.__lastPdfName = fname;
  const shareBtn = document.getElementById('shareBtn');
  if (shareBtn) shareBtn.style.display = 'flex';

  await deliverPdfBlob(pdfBlob, fname, {
    title: 'KORVUS Inspection Report',
    text: `Timber Pest Inspection Report — ${getFullAddress() || 'Property'}`,
    readyToast: 'Report ready — choose where to save or send it',
  });
}
