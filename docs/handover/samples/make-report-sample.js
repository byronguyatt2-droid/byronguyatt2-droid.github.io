// Builds the house-test-2 report (as an ideal extraction would fill it, with a
// made-up address and names) and saves the report PDF.
//
// Usage, with the repo served on PORT (python3 -m http.server 8790):
//   NODE_PATH=/opt/node-tools/node_modules node docs/handover/samples/make-report-sample.js <dir> <out.pdf> [PORT=8790]
// <dir> holds npm jspdf's unpacked package/ folder (npm pack jspdf, then tar xzf),
// because the sandbox may not reach the CDN.
const { chromium } = require('playwright'); const fs = require('fs');
const SP = process.argv[2], OUT = process.argv[3], PORT = process.argv[4] || '8790';
const uid = 'u-owner';
const sess = { access_token:'a.b.c', refresh_token:'r', expires_at: Math.floor(Date.now()/1000)+3600, user:{ id: uid, email:'office@example.com', user_metadata:{ name:'Alex Example', business_name:'Example Pest Co' } } };
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ serviceWorkers:'block', viewport:{ width:390, height:844 }, acceptDownloads:true });
  await ctx.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf/, r => r.fulfill({ body: fs.readFileSync(SP+'/package/dist/jspdf.umd.min.js'), contentType:'application/javascript' }));
  await ctx.route(/fonts\.g/, r => r.fulfill({ status:200, body:'', contentType:'text/css' }));
  await ctx.route(/workers\.dev/, r => r.fulfill({ json:{ plan:'starter', status:'active', ai_calls_used_this_period:1, limit:150 } }));
  await ctx.route(/supabase\.co/, r => { const u = r.request().url(); if (u.includes('businesses?owner_id')) return r.fulfill({ json:[{ id:'b1', name:'Example Pest Co', owner_id: uid, settings:{} }] }); return r.fulfill({ json:[] }); });
  await ctx.addInitScript((s) => { localStorage.setItem('korva_session', JSON.stringify(s)); localStorage.setItem('korva_onboarded_v1','1'); }, sess);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://localhost:${PORT}/`); await p.waitForTimeout(3500);
  await p.evaluate(async () => {
    storeCompanyDetails({ name:'Example Pest Co', licence:'NSW 000000', abn:'00 000 000 000', phone:'0400 000 000', email:'office@example.com', address:'1 Example Street, Example NSW 2000' });
    openApp('inspect'); resetReportState();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('jobAddress', '7 Banksia Drive'); set('jobSuburb', 'Epping'); set('jobState', 'NSW'); set('jobPostcode', '2121'); set('jobClient', 'Sam Taylor'); set('jobInspector', 'Alex Example');
    updateJob();
    populateFields({ inspectionType:'Pre-Purchase — Timber Pest', structureType:'Single storey house', wallConstruction:'Double brick', floorType:'Suspended timber floor', roofType:'Tiled roof, timber framed',
      constructionEra:'1965-1985', occupancyStatus:'Occupied and furnished', weatherConditions:'Fine and dry', facadeDirection:'North',
      areaStatus:{ interior:'PARTIAL', exterior:'INSPECTED', subfloor:'PARTIAL', roofvoid:'PARTIAL', site:'INSPECTED', fences:'INSPECTED' },
      obstructions:'Back section of the subfloor (stored items block access); outer sides and corners of the roof void (low clearance); bedroom walls behind furniture',
      restrictedAccess:'Stored items in the subfloor; low clearance at the roof edges; furniture against bedroom walls',
      highRiskAreas:'Back section of the subfloor, not inspected because stored items block access',
      findings:[
        { termiteActivity:'ACTIVE', species:'Species not identified — further investigation required', activityLocation:'Gum tree in the backyard, about 15 m from the house', damageDescription:'Live termites in the tree; timbers around the base of the tree eaten out; possible nest in the tree', nestLocated:'YES', structuralConcern:null },
        { termiteActivity:'INACTIVE', species:null, activityLocation:'Subfloor, rear bearer and the joist above it, under the back room', damageDescription:'Termite workings on the rear bearer and joist; no damage visible', nestLocated:null, structuralConcern:null },
      ],
      borerActivity:'NONE', decayFound:'NO', waterLeaks:'NO', moistureReadings:'YES',
      moistureMeterReadings:[{ location:'Back room', reading:'28%' }, { location:'Bathroom', reading:'15%' }, { location:'Kitchen', reading:'14%' }],
      timberSoil:'YES', weepHoles:'CLEAR', durableNoticePresent:'NO', softLandscaping:'YES', treatmentRecommended:'YES',
      treatmentType:'Treat the active termites in the backyard tree; install a termite management system (chemical barrier or baiting system)',
      inspectionFrequency:'Next inspection in 3 months, then every 12 months', riskLevel:'HIGH' });
  });
  await p.waitForTimeout(4000);
  await p.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 90; const x = c.getContext('2d'); x.strokeStyle = '#0c121c'; x.lineWidth = 3; x.beginPath(); x.moveTo(10,60); x.bezierCurveTo(60,10,90,90,140,40); x.bezierCurveTo(170,20,200,70,280,30); x.stroke();
    const sig = c.toDataURL('image/png');
    reportData.inspectorLicence = 'NSW 000000'; reportData.inspectorSignature = sig;
    const v = agreementFormValues();
    reportData.agreement = { method:'onsite', signerName:'Sam Taylor', signature: sig, signedAt: Date.now() - 3600e3, inspectionDate: v.inspectionDate, fee: v.fee || '350', notes: v.notes, standard: v.standard, text: v.text };
    saveDraft(); renderReportWidgets && renderReportWidgets(); updateProgress();
  });
  const dl = p.waitForEvent('download', { timeout: 90000 }).catch(() => null);
  await p.evaluate(() => generateReport()); const d = await dl;
  if (d) { await d.saveAs(OUT); console.log('saved', OUT); } else console.log('no download');
  console.log('errors', errs.length ? errs : 'none');
  await b.close();
})();
