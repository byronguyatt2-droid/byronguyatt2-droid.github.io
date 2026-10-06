// ── TREATMENT RECORD AND CERTIFICATE ────────────────────────────────────────
// After the treatment, the technician records what was done on the accepted
// quote: q.treatment = { date, start, finish, technician, licence,
// supervisor, supervisorLicence, pest, weather, equipment, methods:
// { key: qty }, products: [{ name, active, batch, labelPhoto (JPEG data URL
// of the drum label), rate, amount, life, where }],
// areas, notTreated, sketch (JPEG data URL of the site plan), notice:
// 'new'|'updated'|'none', noticeWhere, cautions, nextInspection, warranty,
// notes, signature, at }. It's kept with the quote, so it syncs with the
// report, and gives the client a treatment certificate PDF.
//
// The certificate carries what AS 3660.2 asks for (including a site plan),
// the wording of the durable notice (AS 3660.1, NCC 3.1.4.4: system, date,
// chemical life per label, future inspections), and the state treatment
// records: NSW Pesticides Regulation cl 36,
// QLD pest control advice, VIC licence record keeping and WA treatment
// records (pest, start and finish time, product, active constituent, batch,
// rate, quantity, where, equipment, weather, re-entry precautions,
// technician and licence, the supervisor when a trainee did the work (NSW,
// VIC), signature).

// What was done. qty labels the number asked for, if any. quoteKeys are
// the quote lines that mean the method was quoted.
const TREATMENT_METHODS = {
  barrier: { label: 'Chemical soil treatment (termite barrier)', qty: 'linear metres', quoteKeys: ['barrier_lm', 'barrier_job'] },
  direct:  { label: 'Direct treatment of active termite workings', quoteKeys: ['direct'] },
  bait:    { label: 'Termite baiting system installed', qty: 'stations', quoteKeys: ['bait_install'] },
  topup:   { label: 'Top-up of existing termite management system', quoteKeys: ['system_topup'] },
  general: { label: 'Termite management treatment', quoteKeys: ['treatment'] },
  borer:   { label: 'Borer treatment of affected timbers', quoteKeys: ['borer'] },
};

// Common Australian termiticides and baits with their active constituent,
// for the product picker. The technician still enters the label rate.
const TREATMENT_PRODUCTS = {
  'Termidor': 'fipronil',
  'Termidor Foam': 'fipronil',
  'Premise': 'imidacloprid',
  'Premise Foam': 'imidacloprid',
  'Altriset': 'chlorantraniliprole',
  'Biflex': 'bifenthrin',
  'Exterra': 'chlorfluazuron',
  'Sentricon': 'noviflumuron',
  'Trelona': 'novaluron',
  'Kordon': 'physical barrier with deltamethrin',
};

const TREATMENT_NOTICE = {
  new: 'New durable notice placed',
  updated: 'Existing durable notice updated',
  none: 'No durable notice placed',
};

function treatmentCertNumber(q) {
  return 'TC-' + String(q.number || '').replace(/^Q-?/i, '');
}

function formatClockTime(t) {
  const [h, m] = String(t).split(':').map(Number);
  if (!isFinite(h)) return t;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function formatLongDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// The quote's report, for pre-filling a first record.
function treatmentSourceReport() {
  const src = typeof currentQuoteSource === 'function' ? currentQuoteSource() : null;
  if (!src) return {};
  return (src.key === (currentReportId || 'draft') ? reportData : src.reportData) || {};
}

// Months between inspections, from the report's recommendation
// ("three months after treatment, then every 12 months"), else 12.
function inspectionFrequencyMonths(rd) {
  const words = { one: 1, two: 2, three: 3, four: 4, six: 6, twelve: 12 };
  const m = String(rd.inspectionFrequency || '').match(/(\d+|one|two|three|four|six|twelve)\s*months?/i);
  if (!m) return 12;
  return words[m[1].toLowerCase()] || parseInt(m[1], 10) || 12;
}

function addMonthsIso(iso, months) {
  const d = new Date(iso + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  return isoDate(d);
}

// A first record, filled in from the quote and report. The date starts as
// today; the technician is whoever is signed in, else the report's inspector.
function draftTreatment(q) {
  const rd = treatmentSourceReport();
  const company = getCompanyDetails();
  const me = typeof lastInspectorDetails === 'function' ? lastInspectorDetails() : { name: '', licence: '' };
  const signedIn = (typeof authUser !== 'undefined' && authUser && authUser.user_metadata && authUser.user_metadata.name) || '';
  const date = todayIsoDate();
  const methods = {};
  Object.entries(TREATMENT_METHODS).forEach(([key, m]) => {
    const line = q.items.find(it => m.quoteKeys.includes(it.key));
    if (!line) return;
    methods[key] = m.qty && (line.unit === 'lm' || line.unit === 'station') ? String(parseFloat(line.qty) || '') : '';
  });
  // The product the report recommended, when it names a known one.
  const text = `${rd.treatmentType || ''} ${q.items.map(it => it.detail || '').join(' ')}`;
  const name = Object.keys(TREATMENT_PRODUCTS).sort((a, c) => c.length - a.length)
    .find(p => new RegExp(`\\b${p}\\b`, 'i').test(text));
  const places = (rd.findings || []).filter(f => f && f.termiteActivity === 'ACTIVE' && f.activityLocation)
    .map(f => f.activityLocation);
  if (methods.barrier !== undefined) places.push('Perimeter of the building');
  return {
    date,
    technician: signedIn || q.inspector || me.name || '',
    licence: rd.inspectorLicence || me.licence || company.licence || '',
    supervisor: '',
    supervisorLicence: '',
    start: '',
    finish: '',
    pest: treatmentPestFromReport(rd, methods),
    weather: '',
    equipment: '',
    methods,
    products: [{ name: name || '', active: name ? TREATMENT_PRODUCTS[name] : '', batch: '', rate: '', amount: '', life: '', where: '' }],
    areas: places.join('; '),
    notTreated: '',
    notice: 'new',
    noticeWhere: 'Meter box',
    cautions: TREATMENT_DEFAULT_CAUTIONS,
    nextInspection: addMonthsIso(date, inspectionFrequencyMonths(rd)),
    warranty: '',
    notes: '',
  };
}

const TREATMENT_DEFAULT_CAUTIONS = 'Keep people and pets away from treated areas until the treatment has dried. ' +
  'Do not disturb treated soil, and do not wash treated surfaces.';

// "Subterranean termites (Coptotermes acinaciformis)", plus borers when
// they were treated too.
function treatmentPestFromReport(rd, methods) {
  const species = [...new Set((rd.findings || []).filter(f => f && f.termiteActivity === 'ACTIVE' && f.species)
    .map(f => f.species.trim()).filter(s => !/not identified|further investigation/i.test(s)))];
  const pests = [];
  if (Object.keys(methods).some(k => k !== 'borer') || !('borer' in methods)) {
    pests.push('Subterranean termites' + (species.length ? ` (${species.join(', ')})` : ''));
  }
  if (methods.borer !== undefined) pests.push('Borers');
  return pests.join('; ');
}

// ── ON THE QUOTE ──
function renderTreatmentBlock(q) {
  const t = q.treatment;
  if (!t) {
    return `<button class="quote-btn primary quote-step-btn" onclick="openTreatmentRecord()">Record the treatment</button>`;
  }
  return `<div class="quote-step">
      <div><strong>Treatment done</strong> on ${escapeHtml(formatAnswerDate(t.date))}${t.technician ? ` by ${escapeHtml(t.technician)}` : ''}</div>
      ${t.nextInspection ? `<div class="quote-answer-note">Next inspection due ${escapeHtml(formatAnswerDate(t.nextInspection))}</div>` : ''}
      ${treatmentSourceReport().propertyState === 'QLD' ? '<div class="quote-answer-note">In Queensland, email alone isn\'t enough: also hand the client a printed copy, or leave one in their letterbox.</div>' : ''}
      <div class="quote-step-actions">
        <button class="quote-btn primary" onclick="emailTreatmentCertificate()">Email certificate</button>
        <button class="quote-link-btn" onclick="downloadTreatmentCertificate()">Certificate PDF</button>
        <button class="quote-link-btn" onclick="openTreatmentRecord()">Edit</button>
      </div>
    </div>`;
}

// ── THE RECORD SHEET ──
let treatmentPad = null;
let treatmentSketch = null;

function openTreatmentRecord() {
  const q = quoteState;
  if (!q) return;
  const t = q.treatment || draftTreatment(q);
  document.getElementById('trDate').value = t.date || todayIsoDate();
  document.getElementById('trTech').value = t.technician || '';
  document.getElementById('trLicence').value = t.licence || '';
  document.getElementById('trSupervisor').value = t.supervisor || '';
  document.getElementById('trSupervisorLicence').value = t.supervisorLicence || '';
  document.getElementById('trStart').value = t.start || '';
  document.getElementById('trFinish').value = t.finish || '';
  document.getElementById('trPest').value = t.pest || '';
  document.getElementById('trWeather').value = t.weather || '';
  document.getElementById('trEquipment').value = t.equipment || '';
  document.getElementById('trCautions').value = t.cautions != null ? t.cautions : TREATMENT_DEFAULT_CAUTIONS;
  document.getElementById('trWarranty').value = t.warranty || '';
  document.getElementById('trMethods').innerHTML = Object.entries(TREATMENT_METHODS).map(([key, m]) => {
    const on = key in (t.methods || {});
    return `<label class="treat-method">
        <input type="checkbox" data-key="${key}" ${on ? 'checked' : ''} onchange="onTreatmentMethodToggle(this)">
        <span>${escapeHtml(m.label)}</span>
        ${m.qty ? `<input class="quote-input treat-method-qty" type="number" min="0" step="any" inputmode="decimal" data-qty="${key}"
          value="${escapeHtml((t.methods || {})[key] || '')}" placeholder="${m.qty}" aria-label="${m.qty}" ${on ? '' : 'hidden'}>` : ''}
      </label>`;
  }).join('');
  renderTreatmentProducts(t.products && t.products.length ? t.products : [{}]);
  document.getElementById('trAreas').value = t.areas || '';
  document.getElementById('trNotTreated').value = t.notTreated || '';
  document.getElementById('trNotice').value = t.notice || 'new';
  document.getElementById('trNoticeWhere').value = t.noticeWhere || '';
  onTreatmentNoticeChange();
  document.getElementById('trNext').value = t.nextInspection || '';
  document.getElementById('trNotes').value = t.notes || '';
  document.getElementById('treatmentOverlay').classList.add('open');
  if (!treatmentPad) {
    treatmentPad = createSignaturePad(document.getElementById('trSigCanvas'), document.getElementById('trSigPlaceholder'), updateTreatmentSaveBtn);
  }
  treatmentPad.show(t.signature || '');
  if (!treatmentSketch) {
    treatmentSketch = createSignaturePad(document.getElementById('trSketchCanvas'), document.getElementById('trSketchPlaceholder'));
  }
  treatmentSketch.ctx.strokeStyle = SIGNATURE_INK;
  treatmentSketch.show(t.sketch || '');
  updateTreatmentSaveBtn();
}

// A photo of the site (or of a plan drawn on paper) fills the sketch pad,
// and the technician marks it up in red.
function loadTreatmentSketchPhoto(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || !treatmentSketch) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const { canvas, ctx } = treatmentSketch;
      const scale = Math.max(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
      const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
      treatmentSketch.clear();
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      ctx.strokeStyle = '#d02b20';
      treatmentSketch.empty = false;
      document.getElementById('trSketchPlaceholder').style.display = 'none';
    };
    img.onerror = () => showToast('Could not open that photo', 'error');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// The plan on white as a JPEG, which stays small enough to sync with the quote.
function treatmentSketchImage() {
  if (!treatmentSketch || treatmentSketch.empty) return '';
  const src = treatmentSketch.canvas;
  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);
  return out.toDataURL('image/jpeg', 0.8);
}

function closeTreatmentRecord() {
  document.getElementById('treatmentOverlay').classList.remove('open');
}

function onTreatmentMethodToggle(box) {
  const qty = document.querySelector(`#trMethods [data-qty="${box.dataset.key}"]`);
  if (qty) qty.hidden = !box.checked;
  updateTreatmentSaveBtn();
}

function onTreatmentNoticeChange() {
  const none = document.getElementById('trNotice').value === 'none';
  document.getElementById('trNoticeWhereWrap').style.display = none ? 'none' : '';
  document.getElementById('trNoticeHint').hidden = none;
}

function renderTreatmentProducts(products) {
  const esc = escapeHtml;
  document.getElementById('trProducts').innerHTML = products.map((p, i) => `
    <div class="treat-product" data-i="${i}">
      <div class="job-row">
        <div class="job-field">
          <div class="job-field-label">Product</div>
          <input class="job-input" data-f="name" list="trProductList" value="${esc(p.name || '')}" placeholder="e.g. Termidor" oninput="onTreatmentProductName(this)">
        </div>
        <div class="job-field">
          <div class="job-field-label">Active constituent</div>
          <input class="job-input" data-f="active" value="${esc(p.active || '')}" placeholder="e.g. fipronil">
        </div>
      </div>
      <div class="job-row">
        <div class="job-field">
          <div class="job-field-label">Mix or application rate</div>
          <input class="job-input" data-f="rate" value="${esc(p.rate || '')}" placeholder="As on the label">
        </div>
        <div class="job-field">
          <div class="job-field-label">Amount used</div>
          <input class="job-input" data-f="amount" value="${esc(p.amount || '')}" placeholder="e.g. 640 L of mix">
        </div>
      </div>
      <div class="job-field">
        <div class="job-field-label">Batch No.</div>
        <div class="treat-batch">
          <input class="job-input" data-f="batch" value="${esc(p.batch || '')}" placeholder="Printed on the drum or container">
          <label class="quote-link-btn treat-label-btn">${p.labelPhoto ? 'Retake label photo' : 'Photo of the label'}
            <input type="file" accept="image/*" capture="environment" hidden onchange="loadTreatmentLabelPhoto(this, ${i})">
          </label>
        </div>
        <input type="hidden" data-f="labelPhoto" value="${esc(p.labelPhoto || '')}">
        ${p.labelPhoto ? `<img class="treat-label-thumb" src="${esc(p.labelPhoto)}" alt="Drum label photo">` : ''}
      </div>
      <div class="job-field">
        <div class="job-field-label">Life (per label)</div>
        <input class="job-input" data-f="life" value="${esc(p.life || '')}" placeholder="e.g. Up to 8 years">
      </div>
      <div class="job-field">
        <div class="job-field-label">Where it was applied</div>
        <input class="job-input" data-f="where" value="${esc(p.where || '')}" placeholder="e.g. Trenched and rodded around the perimeter">
      </div>
      ${products.length > 1 ? `<button class="quote-link-btn" onclick="removeTreatmentProduct(${i})">Remove product</button>` : ''}
    </div>`).join('');
}

function readTreatmentProducts() {
  return [...document.querySelectorAll('#trProducts .treat-product')].map(row => {
    const p = {};
    row.querySelectorAll('[data-f]').forEach(inp => { p[inp.dataset.f] = inp.value.trim(); });
    return p;
  });
}

// A photo of the drum label keeps the batch number on record without typing
// it out. It's compressed by the shared photo helper and kept with the product.
async function loadTreatmentLabelPhoto(input, i) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const { blob } = await compressPhotoFile(file);
    const url = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result); fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
    const products = readTreatmentProducts();
    if (!products[i]) return;
    products[i].labelPhoto = url;
    renderTreatmentProducts(products);
    const batch = document.querySelector(`#trProducts .treat-product[data-i="${i}"] [data-f="batch"]`);
    if (batch && !batch.value) { batch.placeholder = 'Type the batch number from the photo'; batch.focus(); }
  } catch (e) {
    showToast('Could not open that photo', 'error');
  }
}

function addTreatmentProduct() {
  renderTreatmentProducts([...readTreatmentProducts(), {}]);
}

function removeTreatmentProduct(i) {
  const products = readTreatmentProducts();
  products.splice(i, 1);
  renderTreatmentProducts(products.length ? products : [{}]);
}

function onTreatmentProductName(inp) {
  const name = Object.keys(TREATMENT_PRODUCTS).find(p => p.toLowerCase() === inp.value.trim().toLowerCase());
  const active = inp.closest('.treat-product').querySelector('[data-f="active"]');
  if (name && !active.value.trim()) active.value = TREATMENT_PRODUCTS[name];
}

function updateTreatmentSaveBtn() {
  const anyMethod = !!document.querySelector('#trMethods input[type=checkbox]:checked');
  document.getElementById('trSaveBtn').disabled = !anyMethod || !treatmentPad || treatmentPad.empty;
}

function saveTreatmentRecord() {
  const q = quoteState;
  if (!q) return;
  const methods = {};
  document.querySelectorAll('#trMethods input[type=checkbox]:checked').forEach(box => {
    const qty = document.querySelector(`#trMethods [data-qty="${box.dataset.key}"]`);
    methods[box.dataset.key] = qty ? qty.value.trim() : '';
  });
  if (!Object.keys(methods).length) { showToast('Tick what was done', 'error'); return; }
  if (!treatmentPad || treatmentPad.empty) { showToast('Sign the record first', 'error'); return; }
  const v = id => document.getElementById(id).value.trim();
  q.treatment = {
    date: v('trDate') || todayIsoDate(),
    technician: v('trTech'),
    licence: v('trLicence'),
    supervisor: v('trSupervisor'),
    supervisorLicence: v('trSupervisor') ? v('trSupervisorLicence') : '',
    start: v('trStart'),
    finish: v('trFinish'),
    pest: v('trPest'),
    weather: v('trWeather'),
    equipment: v('trEquipment'),
    methods,
    products: readTreatmentProducts().filter(p => p.name || p.active || p.amount),
    areas: v('trAreas'),
    notTreated: v('trNotTreated'),
    sketch: treatmentSketchImage(),
    notice: v('trNotice'),
    noticeWhere: v('trNotice') === 'none' ? '' : v('trNoticeWhere'),
    cautions: v('trCautions'),
    nextInspection: v('trNext'),
    warranty: v('trWarranty'),
    notes: v('trNotes'),
    signature: treatmentPad.canvas.toDataURL('image/png'),
    at: Date.now(),
  };
  clearTimeout(quoteSaveTimer);
  persistQuote();
  storeQuoteOnReport(q, true);
  closeTreatmentRecord();
  renderQuoteAnswer();
  if (typeof renderIssueState === 'function') renderIssueState();
  if (typeof renderSavedList === 'function') renderSavedList();
  showToast('Treatment recorded. The certificate is ready to send', 'success');
}

// ── CERTIFICATE PDF ──
function downloadTreatmentCertificate() {
  const q = quoteState;
  if (!q || !q.treatment) return;
  ensureJsPDFLoaded()
    .then(() => buildTreatmentCertificatePDF(q))
    .then(({ blob, fname }) => deliverPdfBlob(blob, fname, {
      title: 'Treatment certificate',
      text: `Treatment certificate — ${q.address || 'Property'}`,
      readyToast: 'Certificate ready — choose where to save or send it',
    }))
    .catch(e => {
      console.error('Certificate PDF failed:', e);
      showToast((e && e.message) || 'Could not make the certificate. Check your connection and try again', 'error');
    });
}

// Built inside the tap, like the quote email, because the share sheet
// won't open after a wait.
function emailTreatmentCertificate() {
  const q = quoteState;
  if (!q || !q.treatment) return;
  if (!jsPDF) {
    ensureJsPDFLoaded()
      .then(() => showToast('Ready — tap Email certificate again', 'info'))
      .catch(e => showToast((e && e.message) || 'Could not load the PDF tools', 'error'));
    return;
  }
  sendPdfsToClient({
    files: [buildTreatmentCertificatePDF(q)],
    to: (q.clientEmail || '').trim(),
    subject: `Termite treatment certificate — ${q.address || 'your property'}`,
    body: clientMessage({ client: q.client, address: q.address, docs: 'termite treatment certificate', signOff: q.treatment.technician }),
  }).then(sent => { if (sent) markCertificateSent(q); });
}

function buildTreatmentCertificatePDF(q) {
  const C = PDF_COLORS;
  const t = q.treatment;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 15, CW = W - M * 2, BOTTOM = 281;
  const company = getCompanyDetails();
  const number = treatmentCertNumber(q);
  let y = 0;

  // A new page keeps the text style it broke in, as the header changes it.
  const ensure = h => {
    if (y + h <= BOTTOM) return;
    const font = doc.getFont(), size = doc.getFontSize(), color = doc.getTextColor();
    doc.addPage();
    y = drawPdfRunningHeader(doc, company, 'Treatment Certificate', q.address, number);
    doc.setFont(font.fontName, font.fontStyle); doc.setFontSize(size); doc.setTextColor(color);
  };
  // Lighter headings than the quote's numbered ones, so most certificates
  // fit one page.
  const section = title => {
    ensure(22);
    y += 1;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...C.ink);
    pdfTracked(doc, title, M, y, { cs: 0.6 });
    doc.setFillColor(...C.rule); doc.rect(M, y + 2, CW, 0.3, 'F');
    y += 6.5;
  };
  const para = (text, opts = {}) => {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal'); doc.setFontSize(opts.size || 9);
    doc.setTextColor(...(opts.color || C.ink));
    const lines = doc.splitTextToSize(text, opts.w || CW);
    const lh = opts.lh || 4.4;
    ensure(lines.length * lh);
    doc.text(lines, opts.x || M, y);
    y += lines.length * lh + (opts.after == null ? 2 : opts.after);
  };
  // A row of small labelled cells side by side, e.g. pest, equipment, weather.
  const cellRow = pairs => {
    const cells = pairs.filter(([, v]) => v);
    if (!cells.length) return;
    const w = (CW - (cells.length - 1) * 6) / cells.length;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
    const lines = cells.map(([, v]) => doc.splitTextToSize(v, w));
    const h = 4 + Math.max(...lines.map(l => l.length)) * 4;
    ensure(h);
    cells.forEach(([label], k) => {
      const x = M + k * (w + 6);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(...C.inkMuted);
      doc.text(label.toUpperCase(), x, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...C.ink);
      doc.text(lines[k], x, y + 4);
    });
    y += h + 1;
  };

  y = drawPdfDocCover(doc, company, { compact: true, kicker: 'Termite management', title: 'Treatment Certificate', date: formatLongDate(t.date), left: [
    ['CLIENT', q.client || 'Not specified'],
    ['PROPERTY ADDRESS', q.address || 'Not specified'],
    ['CONTACT', [q.clientPhone, q.clientEmail].map(v => (v || '').trim()).filter(Boolean).join('  ·  ')],
  ], right: [
    ['CERTIFICATE NO.', number],
    ['TREATMENT DATE', formatLongDate(t.date) + (t.start ? `, ${formatClockTime(t.start)}${t.finish ? ` to ${formatClockTime(t.finish)}` : ''}` : '')],
    ['TECHNICIAN', t.technician],
    ['LICENCE NO.', t.licence],
    ['SUPERVISOR', t.supervisor],
    ['SUPERVISOR LICENCE', t.supervisor && t.supervisorLicence],
  ] });

  // ── WHAT WAS DONE ──
  section('TREATMENT CARRIED OUT');
  // Pest, equipment and weather in a row of small labelled cells.
  // A species qualifier ("not identified, further investigation required")
  // belongs on the inspection report, not on a certificate for work done.
  const pest = (t.pest || '').replace(/\s*\([^)]*(not identified|further investigation)[^)]*\)/gi, '').trim();
  cellRow([['Pest treated', pest], ['Equipment', t.equipment], ['Weather', t.weather]]);
  Object.entries(t.methods || {}).forEach(([key, qty]) => {
    const m = TREATMENT_METHODS[key];
    if (!m) return;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    const text = m.label + (m.qty && qty ? ` (${qty} ${m.qty})` : '');
    const lines = doc.splitTextToSize(text, CW - 6);
    ensure(lines.length * 4.4 + 2);
    doc.setFillColor(...C.accent); doc.circle(M + 1.6, y - 1.1, 0.8, 'F');
    doc.setTextColor(...C.ink); doc.text(lines, M + 5, y);
    y += lines.length * 4.4 + 1;
  });

  // Where, in the same row style.
  if (t.areas || t.notTreated) { y += 1.5; cellRow([['Areas treated', t.areas], ['Areas not treated', t.notTreated]]); }

  // ── PRODUCTS ──
  const products = (t.products || []).filter(p => p.name || p.active);
  if (products.length) {
    section('PRODUCTS APPLIED');
    // The product cell carries the active constituent on its second line.
    // Only the columns something was entered in, so there's no row of dashes.
    const optional = [
      { h: 'RATE', w: 30, f: p => p.rate },
      { h: 'AMOUNT', w: 24, f: p => p.amount },
      { h: 'BATCH NO.', w: 24, f: p => p.batch },
      { h: 'LIFE (LABEL)', w: 24, f: p => p.life },
      { h: 'WHERE', w: 46, f: p => p.where },
    ].filter(c => products.some(p => String(c.f(p) || '').trim()));
    const cols = [{ h: 'PRODUCT', w: 40, f: p => p.name || p.active }, ...optional];
    // Spread the spare width over the columns in proportion.
    const base = cols.reduce((a, c) => a + c.w, 0);
    cols.forEach(c => { c.w = c.w * CW / base; });
    const head = () => {
      drawPdfTableHeadRule(doc, M, y, CW);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.3); doc.setTextColor(...C.inkLight);
      let x = M + 3;
      cols.forEach(c => { pdfTracked(doc, c.h, x, y + 5.3, { cs: 0.3 }); x += c.w; });
      y += 8;
    };
    ensure(20); y -= 2.5; head();
    products.forEach((p, i) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      const cells = cols.map(c => doc.splitTextToSize(c.f(p) || '', c.w - 3));
      doc.setFontSize(7.5);
      const active = p.name && p.active ? doc.splitTextToSize(p.active, cols[0].w - 3) : [];
      const rowH = Math.max(cells[0].length * 4 + active.length * 3.4, ...cells.slice(1).map(l => l.length * 4)) + 4;
      if (y + rowH > BOTTOM) { doc.addPage(); y = drawPdfRunningHeader(doc, company, 'Treatment Certificate', q.address, number); head(); }
      if (i % 2 === 1) { doc.setFillColor(...C.rowAlt); doc.rect(M, y, CW, rowH, 'F'); }
      doc.setDrawColor(...C.ruleLight); doc.setLineWidth(0.25); doc.line(M, y + rowH, M + CW, y + rowH);
      let x = M + 3;
      cells.forEach((lines, ci) => {
        doc.setFont('helvetica', ci === 0 ? 'bold' : 'normal'); doc.setFontSize(8.5); doc.setTextColor(...C.ink);
        doc.text(lines, x, y + 5);
        if (ci === 0 && active.length) {
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...C.inkLight);
          doc.text(active, x, y + 5 + lines.length * 4);
        }
        x += cols[ci].w;
      });
      y += rowH;
    });
    y += 2;
  }

  // ── DURABLE NOTICE AND SITE PLAN ── The wording on the notice itself
  // (AS 3660.1, NCC 3.1.4.4) in a grid, with the site plan beside it.
  section(t.sketch ? 'DURABLE NOTICE AND SITE PLAN' : 'DURABLE NOTICE');
  const planW = t.sketch ? 64 : 0, planH = planW * 0.75;
  const boxW = t.sketch ? CW - planW - 5 : CW, ncols = t.sketch ? 2 : 3;
  const cellW = (boxW - 8 - (ncols - 1) * 5) / ncols;
  const methodNames = Object.keys(t.methods || {}).map(k => TREATMENT_METHODS[k] && TREATMENT_METHODS[k].label).filter(Boolean);
  // Chemical life only when a chemical was applied, not on a baiting-only
  // job, and only for the chemicals (not the baits).
  const BAITS = /exterra|sentricon|trelona|chlorfluazuron|noviflumuron|novaluron|bistrifluron|hexaflumuron/i;
  const chemicalApplied = Object.keys(t.methods || {}).some(k => k !== 'bait');
  const productLife = !chemicalApplied ? [] : products.filter(p => !BAITS.test(`${p.name || ''} ${p.active || ''}`)).map(p => `${p.name || p.active}${p.name && p.active ? ` (${p.active})` : ''}: ${p.life || 'see label'}`);
  const installer = [company.name, [t.technician, t.licence ? `licence ${t.licence}` : ''].filter(Boolean).join(', ')].filter(Boolean).join('. ');
  const noticeCells = t.notice === 'none' ? [['Notice', 'No durable notice was placed at this treatment.']] : [
    ['System', methodNames.join('; ')],
    ['Date installed', formatLongDate(t.date)],
    ['Chemical life (label)', productLife.join('; ')],
    ['Future inspections', t.nextInspection ? `First by ${formatLongDate(t.nextInspection)}, then at least every 12 months` : 'At least every 12 months'],
    ['Installed by', installer],
    ['Notice', `${TREATMENT_NOTICE[t.notice]}${t.noticeWhere ? `: ${t.noticeWhere}` : ''}`],
  ].filter(([, v]) => v);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  const noticeLines = noticeCells.map(([, v]) => doc.splitTextToSize(v, cellW));
  const rowHs = [];
  for (let i = 0; i < noticeLines.length; i += ncols) {
    rowHs.push(4 + Math.max(...noticeLines.slice(i, i + ncols).map(l => l.length)) * 3.6 + 1.5);
  }
  const boxH = Math.max(4 + rowHs.reduce((a, h) => a + h, 0), planH);
  ensure(boxH + 2);
  const top = y - 3.5;
  doc.setFillColor(...C.rowAlt); doc.rect(M, top, boxW, boxH, 'F');
  doc.setFillColor(...C.accent); doc.rect(M, top, 0.8, boxH, 'F');
  let ny = top + 6;
  noticeCells.forEach(([label], i) => {
    const x = M + 4 + (i % ncols) * (cellW + 5);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(...C.inkMuted);
    doc.text(label.toUpperCase(), x, ny);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.ink);
    doc.text(noticeLines[i], x, ny + 3.8);
    if (i % ncols === ncols - 1 || i === noticeCells.length - 1) ny += rowHs[Math.floor(i / ncols)];
  });
  if (t.sketch) {
    const px = M + CW - planW;
    try { doc.addImage(t.sketch, 'JPEG', px, top, planW, planH); } catch (e) {}
    doc.setDrawColor(...C.rule); doc.setLineWidth(0.3); doc.rect(px, top, planW, planH);
  }
  y = top + boxH + 2.5;

  // ── NEXT STEPS ──
  const steps = [];
  if (t.cautions) steps.push(`Safety and re-entry: ${t.cautions}`);
  if (t.nextInspection) steps.push(`Book your next timber pest inspection by ${formatLongDate(t.nextInspection)}. AS 3660.2 recommends one at least every 12 months.`);
  // Three short points, so the signature stays on page 1.
  steps.push(((t.methods || {}).barrier !== undefined ? 'Do not dig or build against the treated soil without asking us. ' : '') +
    'Keep weep holes clear and leaks fixed, and call us if you see termites or mud leads.');
  // The list stays together, so it never starts at the foot of a page.
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  const stepLines = steps.map(st => doc.splitTextToSize(st, CW - 7));
  ensure(12 + stepLines.reduce((a, l) => a + l.length * 3.9 + 0.8, 0));
  section('KEEPING THE PROPERTY PROTECTED');
  stepLines.forEach((lines, i) => {
    ensure(lines.length * 3.9 + 2);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...C.accent);
    doc.text(`${i + 1}.`, M, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.ink);
    doc.text(lines, M + 6, y);
    y += lines.length * 3.9 + 0.8;
  });
  if (t.warranty || t.notes) { y += 1.5; cellRow([['Warranty and service terms', t.warranty], ['Technician notes', t.notes]]); }

  // ── SIGN-OFF ── (kept together): who, licence and date on the left,
  // the signature on the right.
  ensure(t.supervisor ? 34 : 30);
  y += 3;
  doc.setFillColor(...C.ink); doc.rect(M, y, CW, 0.5, 'F');
  y += 19;
  const colW = (CW - 16) / 3;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...C.ink);
  doc.text(doc.splitTextToSize(t.technician || '', colW - 2)[0] || '', M + 1, y - 2);
  drawPdfSignature(doc, { x: M, y, w: colW, caption: t.licence ? `Technician · Licence ${t.licence}` : 'Technician' });
  drawPdfSignature(doc, { x: M + colW + 8, y, w: colW, caption: 'Signature', image: t.signature });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...C.ink);
  doc.text(formatLongDate(t.date), M + (colW + 8) * 2 + 1, y - 2);
  drawPdfSignature(doc, { x: M + (colW + 8) * 2, y, w: colW, caption: 'Date' });
  y += 9;
  if (t.supervisor) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...C.inkLight);
    doc.text(`Supervised by ${t.supervisor}${t.supervisorLicence ? `, licence ${t.supervisorLicence}` : ''}`, M, y);
    y += 5;
  }
  para('The treatment above was carried out by this technician in line with the product label directions and AS 3660.2. It does not repair existing damage, and no treatment can guarantee termites will never return. Regular inspections are the best protection.',
    { size: 7, lh: 3.2, color: C.inkMuted });

  drawPdfDocFooters(doc, `Certificate ${number}${company.name ? `  ·  ${company.name}` : ''}`);
  const safe = (q.address || 'Property').replace(/[^\w]+/g, '_').substring(0, 25);
  return { blob: doc.output('blob'), fname: `SAYON_Treatment_Certificate_${number.replace(/[^\w-]+/g, '')}_${safe}.pdf` };
}
