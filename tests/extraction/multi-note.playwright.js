// Drives the app in Chromium with canned Worker answers to check how
// several dictated notes land in one report:
//   1. a whole-house note (house-test-2 style)
//   2. a subfloor-only follow-up (case subfloor-followup) — the first note's
//      facts must survive, the subfloor must flip to Inspected and lose its
//      Stored Articles reason, and the moisture rows must add up
//   3. a note that fails (no signal) and waits, then a newer note dictated
//      while it waits: both must fill in oldest first, so the newer note's
//      value wins where they disagree
//   4. the report PDF downloads with no page errors
//
// Usage, with the repo served on PORT (python3 -m http.server 8791):
//   NODE_PATH=/opt/node-tools/node_modules node tests/extraction/multi-note.playwright.js <jspdf-dir> [PORT=8791]
// <jspdf-dir> holds npm jspdf's unpacked package/ folder (npm pack jspdf,
// then tar xzf), because the sandbox may not reach the CDN.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const SP = process.argv[2], PORT = process.argv[3] || '8791';
const uid = 'u-owner';
const sess = { access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid, email: 'office@example.com', user_metadata: { name: 'Alex Example', business_name: 'Example Pest Co' } } };

// Canned answers, chosen by a marker word in the note text.
const ANSWERS = {
  HOUSE: {
    inspectionType: 'Pre-Purchase — Timber Pest', structureType: 'Detached house', wallConstruction: 'Double brick', floorType: 'Timber suspended floor', roofType: 'Tiled roof, timber framed',
    constructionEra: '1965-1985', occupancyStatus: 'Occupied — residential', weatherConditions: 'Fine and dry', facadeDirection: 'North',
    areaStatus: { interior: 'PARTIAL', exterior: 'INSPECTED', subfloor: 'PARTIAL', roofvoid: 'PARTIAL', site: 'INSPECTED', fences: 'INSPECTED' },
    obstructions: 'Subfloor: back section behind stored items. Roof void: outer edges and corners. Interior: bedroom walls behind furniture',
    restrictedAccess: 'Subfloor: Stored Articles. Roof void: Low clearance to the outside edges of roof void. Interior: Furniture',
    hinderedAreas: 'Roof void: outer edges and corners not reached. Bedrooms: walls behind furniture', hinderedAreasDetail: 'Low clearance; furniture against walls',
    highRiskAreas: 'Back section of the subfloor behind the stored items',
    findings: [
      { termiteActivity: 'ACTIVE', species: 'Species not identified — further investigation required', activityLocation: 'Gum tree in the backyard, about 15 m from the house', damageDescription: 'Live termites in the tree; timbers around the base eaten out; possible nest in the tree', nestLocated: null, structuralConcern: 'NO' },
      { termiteActivity: 'INACTIVE', species: null, activityLocation: 'Subfloor, rear bearer and the joist above it, under the back room', damageDescription: 'Termite workings on the rear bearer and joist; no damage visible', nestLocated: null, structuralConcern: 'NO' },
    ],
    borerActivity: 'NONE', decayFound: 'NO', waterLeaks: 'NO', moistureReadings: 'YES',
    moistureMeterReadings: [{ location: 'Back room', reading: '28%' }, { location: 'Bathroom', reading: '15%' }, { location: 'Kitchen', reading: '14%' }],
    timberSoil: 'YES', weepHoles: 'CLEAR', durableNoticePresent: 'NO', softLandscaping: 'YES', treatmentRecommended: 'YES',
    treatmentType: 'Treat the active termites in the backyard tree; install a termite management system (chemical barrier or baiting system)',
    inspectionFrequency: '3 months, then every 12 months', riskLevel: 'HIGH',
  },
  SUBFLOOR: {
    areaStatus: { subfloor: 'INSPECTED' },
    moistureMeterReadings: [{ location: 'Rear bearer', reading: '18%' }],
    findings: [],
  },
  WAITING: { // dictated first, fails, waits
    weatherConditions: 'Overcast', riskLevel: 'MEDIUM', borerDetails: 'Old Anobium exit holes, rear bedroom floorboards', borerActivity: 'INACTIVE',
  },
  NEWER: {   // dictated while WAITING waits; its values must win
    weatherConditions: 'Light rain', riskLevel: 'HIGH', decayFound: 'YES', decayDetails: 'Soft fascia board, western side',
  },
};
const noteFor = key => `MARKER_${key} note text`;

(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await ctx.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf/, r => r.fulfill({ body: fs.readFileSync(path.join(SP, 'package/dist/jspdf.umd.min.js')), contentType: 'application/javascript' }));
  await ctx.route(/fonts\.g/, r => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
  let workerMode = 'answer'; // 'answer' | 'abort'
  const calls = [];
  await ctx.route(/workers\.dev/, r => {
    const req = r.request();
    if (req.method() !== 'POST') return r.fulfill({ json: { plan: 'starter', status: 'active', ai_calls_used_this_period: 1, limit: 150 } });
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch {}
    const text = (body.messages && body.messages[0] && body.messages[0].content) || '';
    const key = (text.match(/MARKER_(\w+)/) || [])[1];
    calls.push({ key, mode: workerMode });
    if (workerMode === 'abort') return r.abort('internetdisconnected');
    const answer = ANSWERS[key] || {};
    return r.fulfill({ json: { content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn' } });
  });
  await ctx.route(/supabase\.co/, r => { const u = r.request().url(); if (u.includes('businesses?owner_id')) return r.fulfill({ json: [{ id: 'b1', name: 'Example Pest Co', owner_id: uid, settings: {} }] }); return r.fulfill({ json: [] }); });
  await ctx.addInitScript((s) => { localStorage.setItem('korva_session', JSON.stringify(s)); localStorage.setItem('korva_onboarded_v1', '1'); }, sess);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://localhost:${PORT}/`); await p.waitForTimeout(3500);
  await p.evaluate(() => {
    storeCompanyDetails({ name: 'Example Pest Co', licence: 'NSW 000000', abn: '00 000 000 000', phone: '0400 000 000', email: 'office@example.com', address: '1 Example Street, Example NSW 2000' });
    openApp('inspect'); resetReportState();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('jobAddress', '7 Banksia Drive'); set('jobClient', 'Sam Taylor'); set('jobInspector', 'Alex Example'); updateJob();
  });
  const snap = () => p.evaluate(() => ({
    wall: reportData.wallConstruction, floor: reportData.floorType, weather: reportData.weatherConditions, risk: reportData.riskLevel,
    treatment: reportData.treatmentType, hindered: reportData.hinderedAreas, highRisk: reportData.highRiskAreas,
    areaStatus: reportData.areaStatus, areaReasons: reportData.areaReasons, obstructions: reportData.obstructions, restrictedAccess: reportData.restrictedAccess,
    findings: (reportData.findings || []).map(f => f.termiteActivity + ' @ ' + (f.activityLocation || '').slice(0, 30)),
    moistureRows: (reportData.moistureTable || []).map(r => r.location + ' ' + r.reading), moisture: reportData.moistureReadings, leaks: reportData.waterLeaks,
    borer: reportData.borerActivity, borerDetails: reportData.borerDetails, decay: reportData.decayFound, decayDetails: reportData.decayDetails,
    pending: (reportData.pendingNotes || []).map(n => n.text.slice(0, 20) + (n.problem ? ' [' + n.problem.slice(0, 30) + ']' : '')),
    resYes: document.getElementById('resYesBtn').classList.contains('active'), resDetailShown: document.getElementById('resDetailWrap').style.display !== 'none',
  }));
  const report = {};

  // 1. whole-house note
  await p.evaluate(async (t) => { currentTranscript = t; await processTranscript(); }, noteFor('HOUSE'));
  await p.waitForTimeout(600);
  report.afterHouse = await snap();

  // 2. subfloor-only follow-up
  await p.evaluate(async (t) => { currentTranscript = t; await processTranscript(); }, noteFor('SUBFLOOR'));
  await p.waitForTimeout(600);
  report.afterSubfloor = await snap();

  // 3. a note that fails and waits, then a newer note while it waits
  workerMode = 'abort';
  await p.evaluate(async (t) => { currentTranscript = t; await processTranscript(); }, noteFor('WAITING'));
  await p.waitForTimeout(300);
  report.afterWaitingQueued = await snap();
  workerMode = 'answer';
  await p.evaluate(async (t) => { currentTranscript = t; await processTranscript(); }, noteFor('NEWER'));
  await p.waitForTimeout(1200);
  report.afterNewer = await snap();
  report.workerCalls = calls;

  // 4. the PDF
  await p.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 90; const x = c.getContext('2d'); x.strokeStyle = '#0c121c'; x.lineWidth = 3; x.beginPath(); x.moveTo(10, 60); x.bezierCurveTo(60, 10, 90, 90, 140, 40); x.stroke();
    reportData.inspectorLicence = 'NSW 000000'; reportData.inspectorSignature = c.toDataURL('image/png'); saveDraft();
  });
  const dl = p.waitForEvent('download', { timeout: 90000 }).catch(() => null);
  await p.evaluate(() => generateReport()); const d = await dl;
  report.pdf = d ? { downloaded: true, name: d.suggestedFilename() } : { downloaded: false };
  report.pageErrors = errs;

  // Verdicts
  const a = report.afterHouse, s2 = report.afterSubfloor, n = report.afterNewer;
  report.verdicts = {
    firstNoteFactsSurvive: s2.wall === 'Double brick' && s2.floor === 'Timber suspended floor' && s2.risk === 'HIGH' && s2.findings.length === 2 && s2.hindered === a.hindered,
    subfloorNowInspectedAndReasonCleared: s2.areaStatus.subfloor === 'INSPECTED' && !(s2.areaReasons && s2.areaReasons.subfloor && s2.areaReasons.subfloor.length),
    moistureRowsAddUp: s2.moistureRows.length === 4,
    reasonsTickedFromFirstNote: JSON.stringify(a.areaReasons) === JSON.stringify({ interior: ['Furniture'], subfloor: ['Stored Articles'], roofvoid: ['Low clearance to the outside edges of roof void'] }),
    restrictionsToggleShowsYes: a.resYes && a.resDetailShown,
    waitingNoteQueued: report.afterWaitingQueued.pending.length === 1 && report.afterWaitingQueued.weather === 'Fine and dry',
    waitingNoteDidNotOverwriteNewer: n.weather === 'Light rain' && n.risk === 'HIGH' && n.pending.length === 0,
    bothNotesLanded: n.borer === 'INACTIVE' && n.decay === 'YES' && !!n.borerDetails && !!n.decayDetails,
    callOrderOldestFirst: calls.filter(c => c.mode === 'answer' && c.key).map(c => c.key).join(',') === 'HOUSE,SUBFLOOR,WAITING,NEWER',
    pdfDownloadedNoErrors: report.pdf.downloaded && errs.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  await b.close();
})().catch(e => { console.error('SCRIPT FAILED', e); process.exit(1); });
