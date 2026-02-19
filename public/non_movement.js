// public/non_movement.js
import { getJSON, postJSON, pad13 } from './client.js';

const startInput = document.getElementById('start');
const endInput   = document.getElementById('end');

const selSingle  = document.getElementById('subdept');
const selStart   = document.getElementById('subStart');
const selEnd     = document.getElementById('subEnd');
const toggleAdvanced = document.getElementById('toggleAdvanced');
const advWrap    = document.getElementById('advWrap');

const btnRun     = document.getElementById('btnRun') || document.getElementById('btnSubmit');
const btnExport  = document.getElementById('btnExport');

const brandInput = document.getElementById('brand');
const brandList  = document.getElementById('brandList');

const vendorInput = document.getElementById('vendor');
const vendorList  = document.getElementById('vendorList');

const upcTextarea = document.getElementById('upcs');

const tbody      = document.getElementById('tbody');
const table      = document.getElementById('resultTable') || document.getElementById('results');
const infoBox    = document.getElementById('errorBox') || document.getElementById('info');

const countEl    = document.getElementById('countItems');
const dbEndsEl   = document.getElementById('dbEnds');

const NF_INT  = new Intl.NumberFormat();
const NF_MNY  = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// --- sorting state
let currentRows = [];
let sortKey = 'Item-Brand';
let sortDir = 'asc';
let headersWired = false;

function showInfo(msg) {
  infoBox.textContent = msg || '';
  infoBox.style.display = msg ? '' : 'none';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => (
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c] || c)
  ));
}

// NOTE: server will expand candidates; we just tokenize
function collectUpcs() {
  const raw = String(upcTextarea?.value || '');
  const parts = raw.split(/[^0-9]+/).map(s => s.trim()).filter(Boolean);
  return Array.from(new Set(parts));
}

function updateCount(rows = currentRows) {
  const n = Array.isArray(rows) ? rows.length : 0;
  if (countEl) countEl.textContent = NF_INT.format(n);
}

function currentFilters() {
  const params = {
    start: startInput.value.trim(),
    end: endInput.value.trim()
  };

  if (selSingle && selSingle.value) params.subdept = Number(selSingle.value);

  if (toggleAdvanced?.checked && selStart?.value && selEnd?.value) {
    params.subdept_start = Number(selStart.value);
    params.subdept_end = Number(selEnd.value);
  }

  const brand = brandInput?.value?.trim();
  if (brand) params.brand = brand;

  const vendor = vendorInput?.value?.trim();
  if (vendor) params.vendor = vendor;

  return params;
}

async function loadDbEnds() {
  if (!dbEndsEl) return;
  try {
    const summary = await getJSON('/api/admin/summary');
    const maxDate = summary?.maxDate || '';
    dbEndsEl.textContent = maxDate || '—';
    if (maxDate) {
      startInput?.setAttribute('max', maxDate);
      endInput?.setAttribute('max', maxDate);
    }
  } catch {
    dbEndsEl.textContent = '—';
  }
}

async function loadSubdepartments() {
  try {
    const rows = await getJSON('/api/subdepartments');
    const options = rows
      .map(r => `<option value="${r.subdept_no}">${escapeHtml(r.label)}</option>`)
      .join('');

    if (selSingle) selSingle.innerHTML = `<option value="">(All)</option>` + options;

    // For advanced range, we want numeric inputs, not selects.
    // Keep your existing behavior: allow any number; the UI just provides the inputs.
  } catch (e) {
    showInfo(`Failed to load subdepartments: ${e.message}`);
  }
}

toggleAdvanced?.addEventListener('change', () => {
  if (advWrap) advWrap.style.display = toggleAdvanced.checked ? '' : 'none';
});

// --- brand autocomplete
let brandDebounce = null;
function hideBrandList() {
  if (!brandList) return;
  brandList.style.display = 'none';
  brandList.innerHTML = '';
}
brandInput?.addEventListener('input', () => {
  const q = brandInput.value.trim();
  if (brandDebounce) clearTimeout(brandDebounce);

  brandDebounce = setTimeout(async () => {
    if (!q) return hideBrandList();
    try {
      const brands = await getJSON(`/api/brands?q=${encodeURIComponent(q)}`);
      if (!brands?.length) return hideBrandList();
      brandList.innerHTML = brands.map(b => `<li data-v="${escapeHtml(b)}">${escapeHtml(b)}</li>`).join('');
      brandList.style.display = '';
    } catch {
      hideBrandList();
    }
  }, 200);
});
brandList?.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-v]');
  if (!li) return;
  brandInput.value = li.getAttribute('data-v') || '';
  hideBrandList();
  runQuery();
});
document.addEventListener('click', (e) => {
  if (brandList && !brandList.contains(e.target) && e.target !== brandInput) hideBrandList();
});

// --- vendor autocomplete
let vendorDebounce = null;
function hideVendorList() {
  if (!vendorList) return;
  vendorList.style.display = 'none';
  vendorList.innerHTML = '';
}
vendorInput?.addEventListener('input', () => {
  const q = vendorInput.value.trim();
  if (vendorDebounce) clearTimeout(vendorDebounce);

  vendorDebounce = setTimeout(async () => {
    if (!q) return hideVendorList();
    try {
      const vendors = await getJSON(`/api/vendors?q=${encodeURIComponent(q)}`);
      if (!vendors?.length) return hideVendorList();
      vendorList.innerHTML = vendors.map(v => `<li data-v="${escapeHtml(v)}">${escapeHtml(v)}</li>`).join('');
      vendorList.style.display = '';
    } catch {
      hideVendorList();
    }
  }, 200);
});
vendorList?.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-v]');
  if (!li) return;
  vendorInput.value = li.getAttribute('data-v') || '';
  hideVendorList();
  runQuery();
});
document.addEventListener('click', (e) => {
  if (vendorList && !vendorList.contains(e.target) && e.target !== vendorInput) hideVendorList();
});

// --- sorting helpers
const NUMERIC_COLS = new Set([
  'Units-Sum','Amount-Sum','Sub-department-Number','Category-Number'
]);

function sortRows(rows, key, dir) {
  if (!key) return rows;
  const mult = dir === 'asc' ? 1 : -1;
  const numeric = NUMERIC_COLS.has(key);

  return rows.slice().sort((a, b) => {
    let va = a?.[key], vb = b?.[key];
    if (numeric) {
      va = Number(String(va ?? '').replace(/,/g, '')); if (!Number.isFinite(va)) va = 0;
      vb = Number(String(vb ?? '').replace(/,/g, '')); if (!Number.isFinite(vb)) vb = 0;
      return mult * (va - vb);
    } else {
      va = String(va ?? '').toLocaleLowerCase();
      vb = String(vb ?? '').toLocaleLowerCase();
      return mult * va.localeCompare(vb, undefined, { numeric: true });
    }
  });
}

function updateSortHeaders() {
  const ths = table ? table.querySelectorAll('thead th.sortable') : [];
  ths.forEach(th => {
    const key = th.getAttribute('data-key');
    th.setAttribute('data-sort', key === sortKey ? sortDir : '');
  });
}

let sortingInProgress = false;
function initHeaderSorting() {
  if (!table) return;
  const thead = table.querySelector('thead');
  if (!thead) return;

  headersWired = true;

  thead.addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th || !thead.contains(th)) return;
    if (sortingInProgress) return;

    const key = th.getAttribute('data-key');
    if (!key) return;

    if (sortKey === key) {
      sortDir = (sortDir === 'asc') ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = NUMERIC_COLS.has(key) ? 'desc' : 'asc';
    }

    sortingInProgress = true;
    thead.style.pointerEvents = 'none';
    requestAnimationFrame(() => {
      drawRows();
      sortingInProgress = false;
      thead.style.pointerEvents = '';
    });
  });

  thead.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const th = e.target.closest('th.sortable');
    if (th) th.click();
  });

  thead.querySelectorAll('th.sortable').forEach(th => th.tabIndex = 0);
  updateSortHeaders();
}

function fmtMoney(n) {
  const num = Number(n);
  return Number.isFinite(num) ? NF_MNY.format(num) : '';
}
function fmtInt(n) {
  const num = Number(n);
  return Number.isFinite(num) ? NF_INT.format(num) : '';
}

function renderRows(rows) {
  currentRows = Array.isArray(rows) ? rows.slice() : [];
  updateCount(currentRows);
  drawRows();
  if (!headersWired) initHeaderSorting();
}

function drawRows() {
  const rows = sortRows(currentRows, sortKey, sortDir);
  tbody.style.display = 'none';

  let html = '';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    html +=
      `<tr>
        <td data-label="UPC">${escapeHtml(r["Item-Code"] ?? '')}</td>
        <td data-label="Brand">${escapeHtml(r["Item-Brand"] ?? '')}</td>
        <td data-label="POS Desc">${escapeHtml(r["Item-POS description"] ?? '')}</td>
        <td data-label="Subdept #">${escapeHtml(r["Sub-department-Number"] ?? '')}</td>
        <td data-label="Subdept">${escapeHtml(r["Sub-department-Description"] ?? '')}</td>
        <td data-label="Category #">${escapeHtml(r["Category-Number"] ?? '')}</td>
        <td data-label="Category">${escapeHtml(r["Category-Description"] ?? '')}</td>
        <td data-label="Vendor ID">${escapeHtml(r["Vendor-ID"] ?? '')}</td>
        <td data-label="Vendor">${escapeHtml(r["Vendor-Name"] ?? '')}</td>
        <td class="right" data-label="Units Sum">${fmtInt(r["Units-Sum"] ?? 0)}</td>
        <td class="right" data-label="Amount Sum">${fmtMoney(r["Amount-Sum"] ?? 0)}</td>
      </tr>`;
  }

  tbody.innerHTML = html;
  tbody.style.display = '';
  table.style.display = rows.length ? '' : 'none';
  updateSortHeaders();
}

// --- query execution
async function runQuery() {
  showInfo('');
  const upcs = collectUpcs();
  try {
    if (upcs.length) {
      const body = { ...currentFilters(), upcs };
      const rows = await postJSON('/api/non-movement/search-upcs', body);
      renderRows(rows);
      showInfo(rows.length ? `Found ${rows.length} non-movement items.` : 'No non-movement items found.');
    } else {
      const qs = new URLSearchParams(currentFilters()).toString();
      const rows = await getJSON(`/api/non-movement?${qs}`);
      renderRows(rows);
      showInfo(rows.length ? `Found ${rows.length} non-movement items.` : 'No non-movement items found.');
    }
  } catch (e) {
    showInfo(e?.message || 'Query failed');
  }
}

function doExport() {
  const params = currentFilters();
  const upcs = collectUpcs();
  const p = new URLSearchParams(params);
  if (upcs.length) p.set('upcs', upcs.join(','));
  location.href = `/api/non-movement/export?${p.toString()}`;
}

// --- Dynamic label for Run button based on UPCs entered ---
if (btnRun && upcTextarea) {
  const setRunLabel = () => (btnRun.textContent = collectUpcs().length ? 'Search UPCs' : 'Submit');
  setRunLabel();
  upcTextarea.addEventListener('input', setRunLabel);
}

// wire events
btnRun?.addEventListener('click', runQuery);
btnExport?.addEventListener('click', doExport);

// initial load
document.addEventListener('DOMContentLoaded', () => {
  brandList?.classList.add('suggest-list');
  vendorList?.classList.add('suggest-list');
  if (advWrap) advWrap.style.display = toggleAdvanced?.checked ? '' : 'none';
  if (!headersWired) initHeaderSorting();
});

loadSubdepartments();
loadDbEnds();

(function initDefaults(){
  // set default dates if empty (last 30 days)
  if (!startInput.value || !endInput.value) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth()+1).padStart(2,'0');
    const dd = String(today.getDate()).padStart(2,'0');
    endInput.value = `${yyyy}-${mm}-${dd}`;
    const d2 = new Date(today); d2.setDate(today.getDate()-30);
    const yyyy2 = d2.getFullYear();
    const mm2 = String(d2.getMonth()+1).padStart(2,'0');
    const dd2 = String(d2.getDate()).padStart(2,'0');
    startInput.value = `${yyyy2}-${mm2}-${dd2}`;
  }
})();
