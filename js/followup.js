// ── FOLLOW-UPS ──────────────────────────────────────────────────────────────
// The jobs that need the client chased, worked out from what's already saved:
//   inspection  the next inspection is due within FOLLOWUP_LEAD_DAYS (or is
//               overdue): the date on the treatment record, else the report's
//               re-inspection frequency from the day it was inspected. Only
//               for reports that went to the client, and only until a newer
//               job exists at the same address.
//   quote       sent FOLLOWUP_QUOTE_DAYS or more ago with no answer yet.
//   invoice     past its due date and not marked paid.
// What the inspector did about each one is kept on the saved report, so it
// syncs with it: entry.followUps[key] = { remindedAt, via, dismissedAt }.
// The key includes the due date (or the send), so the next cycle starts fresh.
const FOLLOWUP_LEAD_DAYS = 30;
const FOLLOWUP_QUOTE_DAYS = 7;
const FOLLOWUP_COMING_MONTHS = 6;

function followUpAddressKey(address) {
  return String(address || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// The day the report's inspection happened, as YYYY-MM-DD.
function reportInspectedOn(entry) {
  const rd = entry.reportData || {};
  if (rd.jobInspectionDate) return rd.jobInspectionDate;
  if (rd.agreement && rd.agreement.inspectionDate) return rd.agreement.inspectionDate;
  const at = (rd.issue && rd.issue.completedAt) || (rd.sent && rd.sent.at) || entry.savedAt;
  return at ? isoDate(new Date(at)) : '';
}

function daysBetweenIso(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

// Every follow-up across the saved reports, due ones first, plus inspections
// coming up after the lead time (for the "Coming up" list).
function collectFollowUps() {
  const reports = getSavedReports();
  const quotes = getSavedQuotes();
  const today = todayIsoDate();
  const leadEnd = addDaysIso(today, FOLLOWUP_LEAD_DAYS);
  const comingEnd = addMonthsIso(today, FOLLOWUP_COMING_MONTHS);
  // The latest inspection date per address, to tell when the next job exists.
  const latestAt = {};
  reports.forEach(r => {
    const k = followUpAddressKey(r.address);
    const d = reportInspectedOn(r);
    if (k && d && !(latestAt[k] >= d)) latestAt[k] = d;
  });

  const due = [], coming = [];
  reports.forEach(r => {
    const rd = r.reportData || {};
    const q = quotes[r.id] || r.quote || null;
    const state = r.followUps || {};
    const base = {
      reportId: r.id,
      address: r.address || 'No address',
      client: (q && q.client) || r.client || '',
      email: ((q && q.clientEmail) || rd.jobClientEmail || '').trim(),
      phone: ((q && q.clientPhone) || rd.jobClientPhone || '').trim(),
      inspector: r.inspector || '',
    };
    const add = (item, list) => {
      const s = state[item.key] || {};
      if (s.dismissedAt) return;
      (list || due).push(Object.assign({}, base, item, { remindedAt: s.remindedAt || null, via: s.via || '' }));
    };

    // Next inspection
    if (rd.sent || rd.issue) {
      const inspected = reportInspectedOn(r);
      const t = q && q.treatment;
      const dueOn = t && t.nextInspection ? t.nextInspection
        : inspected ? addMonthsIso(inspected, inspectionFrequencyMonths(rd)) : '';
      const k = followUpAddressKey(r.address);
      const superseded = latestAt[k] && latestAt[k] > ((t && t.date) || inspected);
      if (dueOn && !superseded) {
        const item = { kind: 'inspection', key: 'inspection:' + dueOn, date: dueOn,
          treated: !!(t && t.nextInspection), treatedOn: t ? t.date : '', warranty: !!(t && t.warranty),
          inspected, months: inspectionFrequencyMonths(rd) };
        if (dueOn <= leadEnd) add(item);
        else if (dueOn <= comingEnd) add(item, coming);
      }
    }

    // Quote with no answer
    if (q && q.sentAt && !q.answer && quoteHasItems(q)) {
      const sentOn = isoDate(new Date(q.sentAt));
      if (daysBetweenIso(sentOn, today) >= FOLLOWUP_QUOTE_DAYS) {
        add({ kind: 'quote', key: 'quote:' + q.sentAt, date: sentOn, number: q.number || '', total: quoteTotals(q).total, gst: q.gst !== false });
      }
    }

    // Unpaid invoice past its due date
    const inv = q && q.invoice;
    if (inv && invoiceStatus(inv) === 'overdue') {
      add({ kind: 'invoice', key: 'invoice:' + inv.number + ':' + inv.due, date: inv.due, number: inv.number,
        total: invoiceTotals(inv).balance });
    }
  });

  due.sort((a, b) => a.date.localeCompare(b.date));
  coming.sort((a, b) => a.date.localeCompare(b.date));
  return { due, coming };
}

function followUpTitle(f) {
  const today = todayIsoDate();
  const days = daysBetweenIso(today, f.date);
  if (f.kind === 'quote') {
    return { label: 'Quote waiting', text: `Quote ${f.number} sent ${formatAnswerDate(f.date)}, no answer after ${-days} days` };
  }
  if (f.kind === 'invoice') {
    return { label: 'Unpaid', text: `Invoice ${f.number} for ${formatAUD(f.total)} was due ${formatAnswerDate(f.date)}` };
  }
  const what = f.treated ? 'Post-treatment inspection' : 'Next inspection';
  const when = days < 0 ? `was due ${formatAnswerDate(f.date)}` : days === 0 ? 'is due today' : `due ${formatAnswerDate(f.date)}`;
  return { label: days < 0 ? 'Overdue' : 'Inspection due', text: `${what} ${when}` };
}

// ── ON THE DASHBOARD ──
function renderFollowUpsSection() {
  const { due, coming } = collectFollowUps();
  const esc = escapeHtml;
  const row = (f) => {
    const t = followUpTitle(f);
    const late = f.date < todayIsoDate() || f.kind !== 'inspection';
    const reminded = f.remindedAt
      ? `<div class="followup-reminded">Reminded ${formatAnswerDate(isoDate(new Date(f.remindedAt)))}${f.via ? ' by ' + f.via : ''}</div>` : '';
    const contact = f.email || f.phone
      ? `${f.email ? `<button class="followup-btn" onclick="sendFollowUp('${f.reportId}','${f.key}','email')">Email</button>` : ''}
         ${f.phone ? `<button class="followup-btn" onclick="sendFollowUp('${f.reportId}','${f.key}','text')">Text</button>` : ''}`
      : `<span class="followup-nocontact">No client email or phone on this job</span>`;
    return `
      <div class="followup-item">
        <div class="followup-main" onclick="closeDashboard(); loadReport('${f.reportId}')">
          <div class="followup-top">
            <span class="followup-addr">${esc(f.address)}</span>
            <span class="followup-tag${late ? ' late' : ''}">${t.label}</span>
          </div>
          <div class="followup-text">${esc(t.text)}${f.client ? ' · ' + esc(f.client) : ''}</div>
          ${reminded}
        </div>
        <div class="followup-actions">
          ${contact}
          ${f.kind === 'inspection' ? `<button class="followup-btn primary" onclick="bookFollowUpInspection('${f.reportId}')">Book</button>` : ''}
          <button class="followup-dismiss" onclick="dismissFollowUp('${f.reportId}','${f.key}')" aria-label="Dismiss" title="Dismiss">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>
          </button>
        </div>
      </div>`;
  };
  let html = `<div class="dashboard-section-label">Follow up${due.length ? ` · ${due.length}` : ''}</div>`;
  html += due.length ? `<div class="followup-list">${due.map(row).join('')}</div>`
    : '<div class="followup-empty">Nothing to chase. Inspections due in the next 30 days, quotes without an answer and overdue invoices show up here.</div>';
  if (coming.length) {
    html += `<div class="dashboard-section-label">Inspections coming up</div><div class="followup-coming">` +
      coming.slice(0, 5).map(f => `
        <div class="followup-coming-item" onclick="closeDashboard(); loadReport('${f.reportId}')">
          <span class="followup-coming-addr">${esc(f.address)}</span>
          <span class="followup-coming-date">${esc(formatAnswerDate(f.date))}</span>
        </div>`).join('') +
      (coming.length > 5 ? `<div class="followup-coming-more">and ${coming.length - 5} more in the next ${FOLLOWUP_COMING_MONTHS} months</div>` : '') +
      '</div>';
  }
  return `<div class="followup-section">${html}</div>`;
}

// The count on the dashboard button, so due follow-ups are seen without
// opening it.
function updateFollowUpBadge() {
  const badge = document.getElementById('dashboardBadge');
  if (!badge) return;
  let n = 0;
  try { n = collectFollowUps().due.length; } catch (e) { console.warn('Follow-ups failed:', e); }
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.hidden = n === 0;
}

// ── ACTIONS ──
function findFollowUp(reportId, key) {
  return collectFollowUps().due.find(f => f.reportId === reportId && f.key === key) || null;
}

function setFollowUpState(reportId, key, patch) {
  const reports = getSavedReports();
  const entry = reports.find(r => r.id === reportId);
  if (!entry) return;
  entry.followUps = entry.followUps || {};
  entry.followUps[key] = Object.assign({}, entry.followUps[key], patch);
  if (setSavedReports(reports)) supabaseSave(entry, true);
  updateFollowUpBadge();
  if (document.getElementById('dashboardOverlay').classList.contains('open') && dashboardActiveTab === 'overview') renderDashboard();
}

// The message to the client, in full for email and short for a text.
function followUpMessage(f, channel) {
  const company = getCompanyDetails();
  const firstName = (f.client || '').trim().split(/\s+/)[0];
  const hi = firstName ? `Hi ${firstName},` : 'Hi,';
  const from = company.name || f.inspector || 'us';
  const call = company.phone ? ` or call us on ${company.phone}` : '';
  const dueLong = formatLongDate(f.date);
  let subject, lines, short;

  if (f.kind === 'inspection') {
    subject = `Timber pest inspection due — ${f.address}`;
    if (f.treated) {
      lines = [`The termite treatment at ${f.address} on ${formatLongDate(f.treatedOn)} needs a follow-up inspection by ${dueLong}. It checks the treatment is working${f.warranty ? ' and keeps your warranty in place' : ''}.`];
      short = `the follow-up inspection after your termite treatment at ${f.address} is due by ${dueLong}.`;
    } else {
      const every = f.months === 12 ? 'every 12 months' : `every ${f.months} months`;
      lines = [`Your last timber pest inspection at ${f.address} was on ${formatLongDate(f.inspected)}, so the next one is due by ${dueLong}. We recommended an inspection ${every}, because termites can do serious damage before it shows.`];
      short = `your next timber pest inspection at ${f.address} is due by ${dueLong}.`;
    }
    lines.push('', `Reply to this ${channel === 'text' ? 'message' : 'email'}${call} to book a time that suits you.`);
    short = `${hi} it's ${from}. Just a reminder that ${short} Reply here${call} to book.`;
  } else if (f.kind === 'quote') {
    const price = formatAUD(f.total) + (f.gst ? ' inc GST' : '');
    subject = `Your quote ${f.number} — ${f.address}`;
    lines = [`Just following up on quote ${f.number} we sent on ${formatLongDate(f.date)} for ${f.address} (${price}).`,
      '', `If you have any questions, or you'd like to go ahead, reply to this email${call}.`];
    short = `${hi} it's ${from}. Just following up on quote ${f.number} for ${f.address} (${price}). Any questions, or keen to go ahead? Reply here${call}.`;
  } else {
    subject = `Invoice ${f.number} — payment reminder`;
    lines = [`Invoice ${f.number} for ${f.address} (${formatAUD(f.total)}) was due on ${dueLong}. If you've already paid, thank you, and please ignore this.`];
    if (company.paymentDetails) lines.push('', 'How to pay:', company.paymentDetails, `Reference: ${f.number}`);
    lines.push('', `If you have any questions, reply to this email${call}.`);
    short = `${hi} it's ${from}. A reminder that invoice ${f.number} for ${f.address} (${formatAUD(f.total)}) was due on ${dueLong}. If you've already paid, thank you. Questions? Reply here${call}.`;
  }
  const body = [hi, '', ...lines, '', 'Kind regards,', ...[f.inspector, company.name].filter(Boolean)].join('\n');
  return { subject, body, short };
}

function sendFollowUp(reportId, key, channel) {
  const f = findFollowUp(reportId, key);
  if (!f) return;
  const msg = followUpMessage(f, channel);
  if (channel === 'text') {
    // "?&body=" is read by both iPhone and Android messaging apps.
    window.location.href = `sms:${encodeURIComponent(f.phone.replace(/\s+/g, ''))}?&body=${encodeURIComponent(msg.short)}`;
  } else {
    window.location.href = `mailto:${encodeURIComponent(f.email)}?subject=${encodeURIComponent(msg.subject)}&body=${encodeURIComponent(msg.body)}`;
  }
  setFollowUpState(reportId, key, { remindedAt: Date.now(), via: channel === 'text' ? 'text' : 'email' });
}

function dismissFollowUp(reportId, key) {
  const f = findFollowUp(reportId, key);
  if (!f) return;
  const ask = f.kind === 'inspection' ? 'Stop reminding you about this inspection?'
    : f.kind === 'quote' ? 'Stop reminding you about this quote? Record the client\'s answer on the quote if you have it.'
    : 'Stop reminding you about this invoice? Mark it paid on the quote if it has been.';
  if (!confirm(ask)) return;
  setFollowUpState(reportId, key, { dismissedAt: Date.now() });
}

// Starts the next inspection as a new job with the same property and client.
// Once it's saved, the reminder for the old one goes away.
function bookFollowUpInspection(reportId) {
  const entry = getSavedReports().find(r => r.id === reportId);
  if (!entry) return;
  const rd = entry.reportData || {};
  const q = getSavedQuotes()[reportId] || entry.quote;
  const treated = !!(q && q.treatment && q.treatment.nextInspection);
  closeDashboard();
  if (currentReportId) saveCurrentReport(true);
  newReport();
  document.getElementById('jobAddress').value = entry.jobAddress || entry.address || '';
  document.getElementById('jobSuburb').value = entry.jobSuburb || '';
  document.getElementById('jobState').value = entry.jobState || '';
  document.getElementById('jobPostcode').value = entry.jobPostcode || '';
  document.getElementById('jobClient').value = entry.client || '';
  updateJob();
  reportData.jobClientPhone = rd.jobClientPhone || '';
  reportData.jobClientEmail = rd.jobClientEmail || '';
  reportData.jobInspectionType = treated ? 'Treatment Follow-Up' : 'Annual — Existing Building';
  loadJobInfo();
  saveCurrentReport(true);
  updateFollowUpBadge();
  if (!document.getElementById('sidebarPanel').classList.contains('open')) toggleDrawer();
  const date = document.getElementById('jobInspectionDate');
  if (date) date.scrollIntoView({ block: 'center' });
  showToast('Next inspection started. Set its date in Job Details', 'success');
}
