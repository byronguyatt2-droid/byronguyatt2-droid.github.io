// ── TREATMENT RECORD AND CERTIFICATE ────────────────────────────────────────
// After the treatment, the technician records what was done on the accepted
// quote: q.treatment = { date, technician, licence, methods: { key: qty },
// products: [{ name, active, rate, amount, where }], areas, notTreated,
// notice: 'new'|'updated'|'none', noticeWhere, nextInspection, notes,
// signature, at }. It's kept with the quote, so it syncs with the report,
// and gives the client a treatment certificate PDF with what AS 3660.2 and
// the durable notice (AS 3660.1) ask to be recorded.

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

// Months to the next inspection, from the report's recommendation
// ("three months after treatment, then every 12 months"), else 12.
function treatmentNextInspectionMonths(rd) {
  const words = { one: 1, two: 2, three: 3, four: 4, six: 6, twelve: 12 };
  const m = String(rd.inspectionFrequency || '').match(/(\d+|one|two|three|four|six|twelve)\s*months?/i);
  if (!m) return 12;
  return words[m[1].toLowerCase()] || parseInt(m[1], 10) || 12;
}

function addMonthsIso(iso, months) {
  const d = new Date(iso + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// A first record, filled in from the quote, booking and report.
function draftTreatment(q) {
  const rd = treatmentSourceReport();
  const company = getCompanyDetails();
  const me = typeof lastInspectorDetails === 'function' ? lastInspectorDetails() : { name: '', licence: '' };
  const b = q.booking || {};
  const date = b.date && b.date <= todayIsoDate() ? b.date : todayIsoDate();
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
    technician: b.assignedName || q.inspector || me.name || '',
    licence: b.assignedName ? '' : (rd.inspectorLicence || me.licence || company.licence || ''),
    methods,
    products: [{ name: name || '', active: name ? TREATMENT_PRODUCTS[name] : '', rate: '', amount: '', where: '' }],
    areas: places.join('; '),
    notTreated: '',
    notice: 'new',
    noticeWhere: 'Meter box',
    nextInspection: addMonthsIso(date, treatmentNextInspectionMonths(rd)),
    notes: '',
  };
}

// ── ON THE QUOTE ──
function renderTreatmentBlock(q) {
  const t = q.treatment;
  if (!t) {
    return `<button class="quote-btn${q.booking ? ' primary' : ''} quote-book-btn" onclick="openTreatmentRecord()">Record the treatment</button>`;
  }
  return `<div class="quote-booking">
      <div><strong>Treatment done</strong> on ${escapeHtml(formatAnswerDate(t.date))}${t.technician ? ` by ${escapeHtml(t.technician)}` : ''}</div>
      ${t.nextInspection ? `<div class="quote-answer-note">Next inspection due ${escapeHtml(formatAnswerDate(t.nextInspection))}</div>` : ''}
      <div class="quote-booking-actions">
        <button class="quote-btn primary" onclick="emailTreatmentCertificate()">Email certificate</button>
        <button class="quote-link-btn" onclick="downloadTreatmentCertificate()">Certificate PDF</button>
        <button class="quote-link-btn" onclick="openTreatmentRecord()">Edit</button>
      </div>
    </div>`;
}

// ── THE RECORD SHEET ──
let treatmentPad = null;

function openTreatmentRecord() {
  const q = quoteState;
  if (!q) return;
  const t = q.treatment || draftTreatment(q);
  document.getElementById('trDate').value = t.date || todayIsoDate();
  document.getElementById('trTech').value = t.technician || '';
  document.getElementById('trLicence').value = t.licence || '';
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
  updateTreatmentSaveBtn();
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
  document.getElementById('trNoticeWhereWrap').style.display = document.getElementById('trNotice').value === 'none' ? 'none' : '';
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
    methods,
    products: readTreatmentProducts().filter(p => p.name || p.active || p.amount),
    areas: v('trAreas'),
    notTreated: v('trNotTreated'),
    notice: v('trNotice'),
    noticeWhere: v('trNotice') === 'none' ? '' : v('trNoticeWhere'),
    nextInspection: v('trNext'),
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
  });
}

function buildTreatmentCertificatePDF(q) {
  const C = PDF_COLORS;
  const t = q.treatment;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 15, CW = W - M * 2, BOTTOM = 278;
  const company = getCompanyDetails();
  const number = treatmentCertNumber(q);
  let y = 0;

  const ensure = h => { if (y + h > BOTTOM) { doc.addPage(); y = drawPdfRunningHeader(doc, company, 'Treatment Certificate', q.address, number); } };
  // Lighter headings than the quote's numbered ones, so most certificates
  // fit one page.
  const section = title => {
    ensure(22);
    y += 3;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...C.accent);
    doc.text(title, M, y);
    doc.setFillColor(...C.rule); doc.rect(M, y + 2, CW, 0.3, 'F');
    y += 7.5;
  };
  const para = (text, opts = {}) => {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal'); doc.setFontSize(opts.size || 9);
    doc.setTextColor(...(opts.color || C.ink));
    const lines = doc.splitTextToSize(text, opts.w || CW);
    ensure(lines.length * 4.4);
    doc.text(lines, opts.x || M, y);
    y += lines.length * 4.4 + (opts.after == null ? 2 : opts.after);
  };
  const labelled = (label, value) => {
    if (!value) return;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(...C.inkMuted);
    ensure(10);
    doc.text(label.toUpperCase(), M, y);
    y += 4;
    para(value, { after: 1.5 });
  };

  y = drawPdfDocCover(doc, company, { compact: true, kicker: 'TERMITE MANAGEMENT', title: 'TREATMENT CERTIFICATE', date: formatLongDate(t.date), left: [
    ['CLIENT', q.client || 'Not specified'],
    ['PROPERTY ADDRESS', q.address || 'Not specified'],
    ['QUOTE NO.', q.number],
  ], right: [
    ['CERTIFICATE NO.', number],
    ['TREATMENT DATE', formatLongDate(t.date)],
    ['TECHNICIAN', t.technician],
    ['LICENCE NO.', t.licence],
  ] });

  // ── WHAT WAS DONE ──
  section('TREATMENT CARRIED OUT');
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

  // ── PRODUCTS ──
  const products = (t.products || []).filter(p => p.name || p.active);
  if (products.length) {
    section('PRODUCTS APPLIED');
    const cols = [
      { h: 'PRODUCT', w: 32, f: p => p.name },
      { h: 'ACTIVE CONSTITUENT', w: 34, f: p => p.active },
      { h: 'RATE', w: 32, f: p => p.rate },
      { h: 'AMOUNT', w: 26, f: p => p.amount },
      { h: 'WHERE', w: CW - 124, f: p => p.where },
    ];
    const head = () => {
      doc.setFillColor(...C.headerBg); doc.rect(M, y, CW, 8, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(235, 228, 218);
      let x = M + 3;
      cols.forEach(c => { doc.text(c.h, x, y + 5.3); x += c.w; });
      y += 8;
    };
    ensure(20); head();
    products.forEach((p, i) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      const cells = cols.map(c => doc.splitTextToSize(c.f(p) || '—', c.w - 3));
      const rowH = Math.max(...cells.map(l => l.length)) * 4 + 4;
      if (y + rowH > BOTTOM) { doc.addPage(); y = drawPdfRunningHeader(doc, company, 'Treatment Certificate', q.address, number); head(); }
      if (i % 2 === 1) { doc.setFillColor(...C.rowAlt); doc.rect(M, y, CW, rowH, 'F'); }
      doc.setDrawColor(...C.ruleLight); doc.setLineWidth(0.25); doc.line(M, y + rowH, M + CW, y + rowH);
      let x = M + 3;
      cells.forEach((lines, ci) => {
        doc.setFont('helvetica', ci === 0 ? 'bold' : 'normal'); doc.setTextColor(...C.ink);
        doc.text(lines, x, y + 5);
        x += cols[ci].w;
      });
      y += rowH;
    });
    y += 3;
  }

  // ── AREAS AND DURABLE NOTICE ──
  section('AREAS AND DURABLE NOTICE');
  // Treated and not treated side by side.
  const colW = (CW - 8) / 2;
  const areaCols = [['Areas treated', t.areas], ['Areas not treated', t.notTreated]].filter(([, v]) => v);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  const areaLines = areaCols.map(([, v]) => doc.splitTextToSize(v, areaCols.length > 1 ? colW : CW));
  if (areaCols.length) {
    const h = 4 + Math.max(...areaLines.map(l => l.length)) * 4.4;
    ensure(h);
    areaCols.forEach(([label], i) => {
      const x = M + i * (colW + 8);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(...C.inkMuted);
      doc.text(label.toUpperCase(), x, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...C.ink);
      doc.text(areaLines[i], x, y + 4);
    });
    y += h + 1.5;
  }
  labelled('Durable notice', TREATMENT_NOTICE[t.notice] + (t.notice !== 'none' && t.noticeWhere ? `: ${t.noticeWhere}. Keep it in place and legible so future inspectors know what was done.` : '.'));

  // ── NEXT STEPS ──
  section('KEEPING THE PROPERTY PROTECTED');
  const steps = [];
  if (t.nextInspection) steps.push(`Book your next timber pest inspection by ${formatLongDate(t.nextInspection)}. AS 3660.2 recommends one at least every 12 months.`);
  if ((t.methods || {}).barrier !== undefined) steps.push('Do not disturb the treated soil: no digging, new garden beds, paving or structures against the building without asking us first, as these can break the treated zone.');
  steps.push('Keep the slab edge and weep holes clear, keep garden beds and stored items away from the walls, and fix water leaks promptly.');
  steps.push('Contact us straight away if you see termites, mud leads or new damage.');
  steps.forEach((s, i) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
    const lines = doc.splitTextToSize(s, CW - 7);
    ensure(lines.length * 4.2 + 2);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.accent);
    doc.text(`${i + 1}.`, M, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.ink);
    doc.text(lines, M + 6, y);
    y += lines.length * 4.2 + 1.2;
  });
  if (t.notes) { y += 2; labelled('Technician notes', t.notes); }

  // ── SIGN-OFF ── (kept together)
  ensure(40);
  y += 3;
  doc.setFillColor(...C.accent); doc.rect(M, y, CW, 0.5, 'F');
  y += 5;
  para(`Treatment carried out by the technician below on ${formatLongDate(t.date)}, in line with the product label directions and AS 3660.2.`,
    { size: 8, color: C.inkLight, after: 4 });
  const half = (CW - 10) / 2;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...C.ink);
  doc.setDrawColor(...C.rule); doc.setLineWidth(0.4);
  doc.text('Technician:', M, y); doc.line(M + 19, y + 1, M + half, y + 1);
  doc.text('Licence:', M + half + 10, y); doc.line(M + half + 25, y + 1, M + CW, y + 1);
  doc.setFont('helvetica', 'bold');
  if (t.technician) doc.text(t.technician, M + 21, y - 0.5);
  if (t.licence) doc.text(t.licence, M + half + 27, y - 0.5);
  doc.setFont('helvetica', 'normal');
  y += 10;
  doc.text('Signature:', M, y); doc.line(M + 19, y + 1, M + half, y + 1);
  if (t.signature) { try { doc.addImage(t.signature, 'PNG', M + 21, y - 8.5, 28, 9.6); } catch (e) {} }
  doc.text('Date:', M + half + 10, y); doc.line(M + half + 20, y + 1, M + CW, y + 1);
  doc.setFont('helvetica', 'bold'); doc.text(formatLongDate(t.date), M + half + 22, y - 0.5);
  y += 6;
  para('This certificate records the treatment carried out. It does not repair existing damage, and no treatment can guarantee termites will never return. Regular inspections are the best protection.',
    { size: 7, color: C.inkMuted });

  drawPdfDocFooters(doc, `Certificate ${number}${company.name ? `  ·  ${company.name}` : ''}`);
  const safe = (q.address || 'Property').replace(/[^\w]+/g, '_').substring(0, 25);
  return { blob: doc.output('blob'), fname: `KORVUS_Treatment_Certificate_${number.replace(/[^\w-]+/g, '')}_${safe}.pdf` };
}
