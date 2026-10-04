// ── INVOICE ─────────────────────────────────────────────────────────────────
// Once the client accepts the quote, the job is invoiced from it:
// q.invoice = { number, date, due, items, gst, deposit, quoteHash,
// paid?: { date, method }, sentAt?, at }. The line items are copied when
// the invoice is made, so a later change to the quote doesn't change an
// invoice the client already has. quoteHash shows when the quote has
// changed since.
//
// It's a tax invoice under the ATO's rules when GST is charged and the
// business has an ABN: the words "Tax invoice", the seller's name and ABN,
// the date, what was supplied, the GST amount, and (from $1,000) the
// buyer's name or ABN. Without an ABN or GST it's a plain invoice.

const INVOICE_PAY_METHODS = {
  bank: 'bank transfer',
  card: 'card',
  cash: 'cash',
  cheque: 'cheque',
  other: 'other',
};

function invoiceSeqKey() {
  const owner = (authBusiness && authBusiness.id) || (authUser && authUser.id) || 'local';
  return `korva_invoice_seq_${owner}`;
}
// The business's next invoice number: INV-1001, INV-1002 and so on.
function nextInvoiceNumber() {
  return `INV-${parseInt(readJSON(invoiceSeqKey(), 1000), 10) + 1}`;
}
function takeInvoiceNumber(number) {
  const n = parseInt(String(number).replace(/^\D+/, ''), 10);
  const seq = parseInt(readJSON(invoiceSeqKey(), 1000), 10);
  if (isFinite(n) && n > seq) {
    try { localStorage.setItem(invoiceSeqKey(), JSON.stringify(n)); } catch (e) {}
    scheduleBusinessSync();
  }
}

function invoiceTotals(inv) {
  const t = quoteTotals({ items: inv.items, gst: inv.gst });
  const deposit = Math.min(Math.max(parseFloat(inv.deposit) || 0, 0), t.total);
  return Object.assign(t, { deposit, balance: t.total - deposit });
}

function isTaxInvoice(inv) {
  return inv.gst !== false && !!(getCompanyDetails().abn || '').trim();
}

// Days to pay, from the payment terms ("within 14 days", "7 days"), else 0:
// due on the invoice date, as in the default "due on completion" terms.
function invoiceTermDays(terms) {
  const m = String(terms || '').match(/(\d+)\s*days?/i);
  return m ? parseInt(m[1], 10) : 0;
}

function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

// 'paid' | 'overdue' | 'due'
function invoiceStatus(inv) {
  if (inv.paid) return 'paid';
  return inv.due && inv.due < todayIsoDate() ? 'overdue' : 'due';
}

function invoiceQuoteChanged(q) {
  return !!(q.invoice && !q.invoice.paid && q.invoice.quoteHash && q.invoice.quoteHash !== quoteContentHash(q));
}

// ── ON THE QUOTE ──
function renderInvoiceBlock(q) {
  const inv = q.invoice;
  const esc = escapeHtml;
  if (!inv) {
    return `<button class="quote-btn${q.treatment ? ' primary' : ''} quote-book-btn" onclick="openInvoiceSheet()">Create invoice</button>`;
  }
  const status = invoiceStatus(inv);
  const t = invoiceTotals(inv);
  const statusLine = status === 'paid'
    ? `<strong>Paid</strong> ${esc(formatAnswerDate(inv.paid.date))} by ${esc(INVOICE_PAY_METHODS[inv.paid.method] || inv.paid.method)}`
    : `<strong>${status === 'overdue' ? 'Overdue' : 'Due'}</strong> ${esc(formatAnswerDate(inv.due))}`;
  return `<div class="quote-booking invoice-block ${status}">
      <div>Invoice <strong class="invoice-no">${esc(inv.number)}</strong> · ${status === 'paid' ? esc(formatAUD(t.total)) : `${esc(formatAUD(t.balance))}${t.deposit ? ' balance' : ''}`}</div>
      <div class="invoice-status">${statusLine}</div>
      ${invoiceQuoteChanged(q) ? '<div class="quote-answer-warn">The quote changed after this invoice was made. Tap Edit to update it before sending.</div>' : ''}
      <div class="quote-booking-actions">
        <button class="quote-btn primary" onclick="emailInvoice()">Email invoice</button>
        <button class="quote-link-btn" onclick="downloadInvoice()">Invoice PDF</button>
        ${status === 'paid'
          ? '<button class="quote-link-btn" onclick="clearInvoicePaid()">Mark unpaid</button>'
          : '<button class="quote-link-btn" onclick="openInvoicePaid()">Mark paid</button>'}
        <button class="quote-link-btn" onclick="openInvoiceSheet()">Edit</button>
      </div>
    </div>`;
}

// ── MAKING THE INVOICE ──
function openInvoiceSheet() {
  const q = quoteState;
  if (!q) return;
  const inv = q.invoice;
  const date = inv ? inv.date : todayIsoDate();
  document.getElementById('invNumber').value = inv ? inv.number : nextInvoiceNumber();
  document.getElementById('invDate').value = date;
  document.getElementById('invDue').value = inv ? inv.due : addDaysIso(date, invoiceTermDays(q.paymentTerms));
  document.getElementById('invDeposit').value = inv && inv.deposit ? inv.deposit : '';
  document.getElementById('invPayment').value = getCompanyDetails().paymentDetails || '';
  const changed = invoiceQuoteChanged(q);
  document.getElementById('invUpdateWrap').style.display = changed ? '' : 'none';
  document.getElementById('invUpdate').checked = changed;
  renderInvoiceSheetSummary();
  document.getElementById('invoiceOverlay').classList.add('open');
}

function closeInvoiceSheet() {
  document.getElementById('invoiceOverlay').classList.remove('open');
}

// What's going on the invoice, and anything that stops it being a valid
// tax invoice.
function renderInvoiceSheetSummary() {
  const q = quoteState;
  const update = !q.invoice || document.getElementById('invUpdate').checked;
  const draft = { items: update ? q.items : q.invoice.items, gst: update ? q.gst : q.invoice.gst,
    deposit: document.getElementById('invDeposit').value };
  const t = invoiceTotals(draft);
  const company = getCompanyDetails();
  const gaps = [];
  if (draft.gst !== false && !(company.abn || '').trim()) gaps.push('Add your ABN in Company details. Without it this is a plain invoice, not a tax invoice, and the client can\'t claim the GST.');
  if (!(q.client || '').trim()) gaps.push('Add the client\'s name to the quote. A tax invoice of $1,000 or more must name the buyer.');
  if (!document.getElementById('invPayment').value.trim()) gaps.push('Add how to pay you (bank details or a payment link), so the client can pay straight from the invoice.');
  const lines = draft.items.filter(it => lineTotal(it)).length;
  document.getElementById('invSummary').innerHTML =
    `<div>${lines} line${lines === 1 ? '' : 's'} from quote ${escapeHtml(q.number || '')} · ` +
    `<strong>${escapeHtml(formatAUD(t.total))}</strong>${draft.gst !== false ? ' inc GST' : ''}` +
    `${t.deposit ? ` · ${escapeHtml(formatAUD(t.balance))} balance after deposit` : ''}</div>` +
    gaps.map(g => `<div class="quote-answer-warn">${escapeHtml(g)}</div>`).join('');
}

function saveInvoice() {
  const q = quoteState;
  if (!q) return;
  const v = id => document.getElementById(id).value.trim();
  const number = v('invNumber');
  if (!number) { showToast('Enter an invoice number', 'error'); return; }
  const update = !q.invoice || document.getElementById('invUpdate').checked;
  const prev = q.invoice || {};
  q.invoice = Object.assign({}, prev, {
    number,
    date: v('invDate') || todayIsoDate(),
    due: v('invDue') || v('invDate') || todayIsoDate(),
    deposit: v('invDeposit'),
    items: update ? JSON.parse(JSON.stringify(q.items)) : prev.items,
    gst: update ? q.gst : prev.gst,
    quoteHash: update ? quoteContentHash(q) : prev.quoteHash,
    at: Date.now(),
  });
  if (!prev.number) takeInvoiceNumber(number);
  // How to pay is the business's, so it's remembered for the next invoice.
  const company = getCompanyDetails();
  if (company.paymentDetails !== v('invPayment')) {
    company.paymentDetails = v('invPayment');
    storeCompanyDetails(company);
  }
  const field = document.getElementById('companyPayment');
  if (field) field.value = company.paymentDetails;
  saveInvoiceState(q);
  closeInvoiceSheet();
  showToast(`Invoice ${number} ready to send`, 'success');
}

function saveInvoiceState(q) {
  clearTimeout(quoteSaveTimer);
  persistQuote();
  storeQuoteOnReport(q, true);
  renderQuoteAnswer();
  if (typeof renderIssueState === 'function') renderIssueState();
  if (typeof renderSavedList === 'function') renderSavedList();
}

// ── PAYMENT ──
function openInvoicePaid() {
  document.getElementById('invPaidDate').value = todayIsoDate();
  document.getElementById('invPaidMethod').value = 'bank';
  document.getElementById('invoicePaidOverlay').classList.add('open');
}
function closeInvoicePaid() {
  document.getElementById('invoicePaidOverlay').classList.remove('open');
}
function saveInvoicePaid() {
  const q = quoteState;
  if (!q || !q.invoice) return;
  q.invoice.paid = {
    date: document.getElementById('invPaidDate').value || todayIsoDate(),
    method: document.getElementById('invPaidMethod').value,
  };
  saveInvoiceState(q);
  closeInvoicePaid();
  showToast(`Invoice ${q.invoice.number} marked as paid`, 'success');
}
function clearInvoicePaid() {
  const q = quoteState;
  if (!q || !q.invoice || !q.invoice.paid) return;
  if (!confirm('Mark this invoice as unpaid?')) return;
  delete q.invoice.paid;
  saveInvoiceState(q);
}

// ── SENDING ──
function downloadInvoice() {
  const q = quoteState;
  if (!q || !q.invoice) return;
  ensureJsPDFLoaded()
    .then(() => buildInvoicePDF(q))
    .then(({ blob, fname }) => deliverPdfBlob(blob, fname, {
      title: `Invoice ${q.invoice.number}`,
      text: `Invoice ${q.invoice.number} — ${q.address || 'Property'}`,
      readyToast: 'Invoice ready — choose where to save or send it',
    }))
    .catch(e => {
      console.error('Invoice PDF failed:', e);
      showToast((e && e.message) || 'Could not make the invoice. Check your connection and try again', 'error');
    });
}

// Built inside the tap, like the quote email, because the share sheet
// won't open after a wait.
function emailInvoice() {
  const q = quoteState;
  if (!q || !q.invoice) return;
  if (invoiceQuoteChanged(q) && !confirm('The quote changed after this invoice was made. Send the invoice as it is?')) return;
  if (!jsPDF) {
    ensureJsPDFLoaded()
      .then(() => showToast('Ready — tap Email invoice again', 'info'))
      .catch(e => showToast((e && e.message) || 'Could not load the PDF tools', 'error'));
    return;
  }
  const inv = q.invoice;
  sendPdfsToClient({
    files: [buildInvoicePDF(q)],
    to: (q.clientEmail || '').trim(),
    subject: `Invoice ${inv.number} — ${q.address || 'your property'}`,
    body: clientMessage({ client: q.client, address: q.address, docs: `invoice ${inv.number}`, signOff: q.inspector }),
  }).then(sent => {
    if (!sent) return;
    inv.sentAt = Date.now();
    saveInvoiceState(q);
  });
}

// ── PDF ──
function buildInvoicePDF(q) {
  const C = PDF_COLORS;
  const inv = q.invoice;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 15, CW = W - M * 2, BOTTOM = 276;
  const company = getCompanyDetails();
  const t = invoiceTotals(inv);
  const tax = isTaxInvoice(inv);
  const docName = tax ? 'Tax Invoice' : 'Invoice';
  const status = invoiceStatus(inv);
  let y = 0;
  const newPage = () => { doc.addPage(); y = drawPdfRunningHeader(doc, company, docName, q.address, inv.number); return y; };
  const ensure = h => { if (y + h > BOTTOM) newPage(); };
  const section = (title, num) => { ensure(20); y = drawPdfNumberedTitle(doc, y, title, num); };

  y = drawPdfDocCover(doc, company, { kicker: 'TIMBER PEST', title: tax ? 'TAX INVOICE' : 'INVOICE', date: formatLongDate(inv.date), left: [
    ['BILL TO', q.client || 'Not specified'],
    ['PROPERTY ADDRESS', q.address || 'Not specified'],
    ['CONTACT', [q.clientPhone, q.clientEmail].map(v => (v || '').trim()).filter(Boolean).join('  ·  ')],
  ], right: [
    ['INVOICE NO.', inv.number],
    ['INVOICE DATE', formatLongDate(inv.date)],
    ['DUE DATE', status === 'paid' ? 'Paid' : formatLongDate(inv.due)],
    ['QUOTE NO.', q.number],
  ] });

  // ── 1. WORK ──
  section('WORK COMPLETED', 1);
  if (q.treatment) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...C.inkLight);
    doc.text(`Treatment carried out on ${formatLongDate(q.treatment.date)}${q.treatment.technician ? ` by ${q.treatment.technician}` : ''}. Treatment certificate ${treatmentCertNumber(q)}.`, M, y);
    y += 5;
  }
  y = drawPdfLineItems(doc, y, inv.items, { bottom: BOTTOM, newPage });
  const rows = [];
  if (inv.gst !== false) rows.push(['Subtotal (ex GST)', t.subtotal], ['GST (10%)', t.gst]);
  if (t.deposit && status !== 'paid') rows.push([inv.gst !== false ? 'Total (inc GST)' : 'Total', t.total], ['Less deposit paid', -t.deposit]);
  const final = status === 'paid' ? ['PAID', t.total]
    : [t.deposit ? 'BALANCE DUE' : inv.gst !== false ? 'TOTAL DUE (inc GST)' : 'TOTAL DUE', t.balance];
  const boxH = pdfTotalsBoxHeight(rows);
  ensure(boxH + 6);
  y += 5;
  drawPdfTotalsBox(doc, y, rows, final);
  if (inv.gst !== false && !t.deposit) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...C.inkMuted);
    doc.text('The total includes GST.', M, y + 6.5);
  }
  if (status === 'paid') {
    // A plain stamp beside the totals.
    doc.setDrawColor(...C.safe); doc.setLineWidth(0.8);
    doc.roundedRect(M, y + 2, 62, 16, 2, 2, 'D');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...C.safe);
    doc.text('PAID', M + 5, y + 10);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
    doc.text(`${formatLongDate(inv.paid.date)} · ${INVOICE_PAY_METHODS[inv.paid.method] || inv.paid.method}`, M + 5, y + 15);
  }
  y += boxH + 6;

  // ── 2. HOW TO PAY ──
  if (status !== 'paid') {
    section('HOW TO PAY', 2);
    const payment = (company.paymentDetails || '').trim();
    const lines = [
      [`Amount due`, `${formatAUD(t.balance)} by ${formatLongDate(inv.due)}`],
      ['Reference', inv.number],
    ];
    lines.forEach(([label, value]) => {
      ensure(6);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(...C.inkMuted);
      doc.text(label.toUpperCase(), M, y);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...C.ink);
      doc.text(value, M + 30, y);
      y += 6;
    });
    if (payment) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(...C.inkMuted);
      doc.text('PAY TO', M, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...C.ink);
      const pl = doc.splitTextToSize(payment, CW - 30);
      ensure(pl.length * 4.6);
      doc.text(pl, M + 30, y);
      y += pl.length * 4.6 + 1;
    }
    const terms = (q.paymentTerms || '').trim();
    if (terms) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.inkLight);
      const tl = doc.splitTextToSize(terms, CW);
      ensure(tl.length * 4 + 3);
      y += 2;
      doc.text(tl, M, y);
      y += tl.length * 4;
    }
  }

  drawPdfDocFooters(doc, `${docName} ${inv.number}${company.name ? `  ·  ${company.name}` : ''}${company.abn ? `  ·  ABN ${company.abn}` : ''}`);
  const safe = (q.address || 'Property').replace(/[^\w]+/g, '_').substring(0, 25);
  return { blob: doc.output('blob'), fname: `KORVUS_Invoice_${inv.number.replace(/[^\w-]+/g, '')}_${safe}.pdf` };
}
