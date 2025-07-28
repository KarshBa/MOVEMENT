// public/item_movement.js
const startInput = document.getElementById('start');
const endInput   = document.getElementById('end');

const selSingle  = document.getElementById('subdept');        // single subdept select (if present)
const selStart   = document.getElementById('subdept_start');  // range start (if present)
const selEnd     = document.getElementById('subdept_end');    // range end (if present)

const btnRun     = document.getElementById('btnRun');
const btnExport  = document.getElementById('btnExport');
const btnSearch  = document.getElementById('btnSearchUpcs');

const upcTextarea = document.getElementById('upcs');          // optional, for UPC search
const tbody      = document.getElementById('tbody');
const table      = document.getElementById('resultTable');
const errorBox   = document.getElementById('errorBox');

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.style.display = msg ? '' : 'none';
}

async function getJSON(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(await r.text().catch(()=>'Request failed'));
  return r.json();
}
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text().catch(()=>'Request failed');
    throw new Error(t);
  }
  return r.json();
}

function currentFilters() {
  const params = {
    start: startInput.value.trim(),
    end: endInput.value.trim()
  };
  if (selSingle && selSingle.value) params.subdept = Number(selSingle.value);
  if (selStart && selEnd && selStart.value && selEnd.value) {
    params.subdept_start = Number(selStart.value);
    params.subdept_end = Number(selEnd.value);
  }
  return params;
}

function renderRows(rows) {
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Date">${r.date_iso ?? ''}</td>
      <td data-label="Subdept">${r.subdept_no ?? ''}</td>
      <td data-label="UPC">${r.item_code ?? ''}</td>
      <td data-label="POS Desc">${escapeHtml(r.item_pos_desc ?? '')}</td>
      <td data-label="Units">${fmt(r.units_sum)}</td>
      <td data-label="Amount">${fmt(r.amount_sum)}</td>
      <td data-label="Weight/Vol">${fmt(r.weight_volume_sum)}</td>
      <td data-label="Profit">${fmt(r.bl_profit)}</td>
      <td data-label="Margin">${fmt(r.bl_margin)}</td>
    `;
    tbody.appendChild(tr);
  }
  table.style.display = rows.length ? '' : 'none';
}

function fmt(n) {
  if (n == null) return '';
  const num = Number(n);
  return Number.isFinite(num) ? num.toLocaleString() : String(n);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c] || c));
}

async function loadSubdepartments() {
  try {
    const rows = await getJSON('/api/subdepartments');
    const options = rows
      .map(r => `<option value="${r.subdept_no}">${escapeHtml(r.label)}</option>`)
      .join('');

    if (selSingle) {
      selSingle.innerHTML = `<option value="">(All)</option>` + options;
    }
    if (selStart) {
      selStart.innerHTML = `<option value="">(Any)</option>` + options;
    }
    if (selEnd) {
      selEnd.innerHTML = `<option value="">(Any)</option>` + options;
    }
  } catch (e) {
    showError(`Failed to load subdepartments: ${e.message}`);
  }
}

async function runRange() {
  showError('');
  try {
    const params = currentFilters();
    const qs = new URLSearchParams(params).toString();
    const rows = await getJSON(`/api/range?${qs}`);
    renderRows(rows);
  } catch (e) {
    showError(e.message || 'Query failed');
  }
}

async function runSearchUpcs() {
  showError('');
  try {
    const params = currentFilters();
    const upcs = (upcTextarea?.value || '')
      .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    const body = { ...params, upcs };
    const rows = await postJSON('/api/search-upcs', body);
    renderRows(rows);
  } catch (e) {
    showError(e.message || 'Search failed');
  }
}

function doExport() {
  const params = currentFilters();
  const qs = new URLSearchParams(params).toString();
  location.href = `/api/export?${qs}`;
}

// wire events
btnRun?.addEventListener('click', runRange);
btnExport?.addEventListener('click', doExport);
btnSearch?.addEventListener('click', runSearchUpcs);

// initial load
loadSubdepartments();
