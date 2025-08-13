// public/item_movement.js
const startInput = document.getElementById('start');
const endInput   = document.getElementById('end');

const selSingle  = document.getElementById('subdept'); // single subdept select
// NOTE: your HTML uses subStart/subEnd (not subdept_start/subdept_end)
const selStart   = document.getElementById('subStart');
const selEnd     = document.getElementById('subEnd');
const toggleAdvanced = document.getElementById('toggleAdvanced');
const advWrap    = document.getElementById('advWrap');

const btnRun     = document.getElementById('btnRun') || document.getElementById('btnSubmit');
const btnExport  = document.getElementById('btnExport');
const btnSearch  = document.getElementById('btnSearchUpcs');

const brandInput = document.getElementById('brand');
const brandList  = document.getElementById('brandList');

const upcTextarea = document.getElementById('upcs');
const tbody      = document.getElementById('tbody');
const table      = document.getElementById('resultTable') || document.getElementById('results');
const errorBox   = document.getElementById('errorBox') || document.getElementById('info');

// --- sorting state
let currentRows = [];
let sortKey = 'Amount-Sum';  // default sort when new data arrives
let sortDir = 'desc';        // 'asc' | 'desc'

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

function pad13(s) {
  const digits = String(s ?? '').replace(/\D+/g, '');
  return digits.padStart(13, '0');
}

function collectUpcs() {
  const raw = String(upcTextarea?.value || '');
  const parts = raw.split(/[^0-9]+/);     // split on any non-digit
  // pad & dedupe
  return Array.from(new Set(parts.map(pad13).filter(Boolean)));
}

function currentFilters() {
  const params = {
    start: startInput.value.trim(),
    end: endInput.value.trim()
  };
  if (selSingle && selSingle.value) params.subdept = Number(selSingle.value);

  // Only include range if Advanced is toggled on and both values present
  if (toggleAdvanced?.checked && selStart?.value && selEnd?.value) {
    params.subdept_start = Number(selStart.value);
    params.subdept_end = Number(selEnd.value);
  }

  const brand = brandInput?.value?.trim();
  if (brand) params.brand = brand;

  return params;
}

let brandDebounce = null;

function hideBrandList() {
  if (brandList) {
    brandList.style.display = 'none';
    brandList.innerHTML = '';
  }
}

toggleAdvanced?.addEventListener('change', () => {
  if (advWrap) advWrap.style.display = toggleAdvanced.checked ? '' : 'none';
});

brandInput?.addEventListener('input', () => {
  const q = brandInput.value.trim();
  if (brandDebounce) clearTimeout(brandDebounce);

  brandDebounce = setTimeout(async () => {
    if (!q) return hideBrandList();
    try {
      const r = await fetch(`/api/brands?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('brands fetch failed');
      const brands = await r.json(); // array of strings
      if (!brands.length) return hideBrandList();

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
  // optional: auto-run with the chosen brand
  runRange();
});

document.addEventListener('click', (e) => {
  if (brandList && !brandList.contains(e.target) && e.target !== brandInput) {
    hideBrandList();
  }
});

function renderRows(rows) {
  // store and draw (sorted)
  currentRows = Array.isArray(rows) ? rows.slice() : [];
  drawRows();
}

function drawRows() {
  const rows = sortRows(currentRows, sortKey, sortDir);
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="UPC">${escapeHtml(r["Item-Code"] ?? '')}</td>
      <td data-label="Brand">${escapeHtml(r["Item-Brand"] ?? '')}</td>
      <td data-label="POS Desc">${escapeHtml(r["Item-POS description"] ?? '')}</td>
      <td data-label="Subdept #">${escapeHtml(r["Sub-department-Number"] ?? '')}</td>
      <td data-label="Subdept">${escapeHtml(r["Sub-department-Description"] ?? '')}</td>
      <td data-label="Category #">${escapeHtml(r["Category-Number"] ?? '')}</td>
      <td data-label="Category">${escapeHtml(r["Category-Description"] ?? '')}</td>
      <td data-label="Vendor ID">${escapeHtml(r["Vendor-ID"] ?? '')}</td>
      <td data-label="Vendor">${escapeHtml(r["Vendor-Name"] ?? '')}</td>
      <td data-label="Units Sum">${fmt(r["Units-Sum"])}</td>
      <td data-label="Amount Sum">${fmt(r["Amount-Sum"])}</td>
    `;
    tbody.appendChild(tr);
  }
  table.style.display = rows.length ? '' : 'none';
  updateSortHeaders();
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
    const upcs = collectUpcs();
    const body = { ...params, upcs };
    const rows = await postJSON('/api/search-upcs', body);
    renderRows(rows);
  } catch (e) {
    showError(e.message || 'Search failed');
  }
}

function doExport() {
  const params = currentFilters();
  const upcs = collectUpcs();
  const p = new URLSearchParams(params);
  if (upcs.length) p.set('upcs', upcs.join(','));
  location.href = `/api/export?${p.toString()}`;
}

// wire events
btnRun?.addEventListener('click', runRange);
btnExport?.addEventListener('click', doExport);
btnSearch?.addEventListener('click', runSearchUpcs);

// initial load
loadSubdepartments();


// --- sorting helpers
const NUMERIC_COLS = new Set([
  'Units-Sum','Amount-Sum','Sub-department-Number','Category-Number'
  // Note: "Item-Code" is 13-digit, already left-padded; lexicographic works fine
]);

function sortRows(rows, key, dir) {
  if (!key) return rows;
  const mult = dir === 'asc' ? 1 : -1;
  const numeric = NUMERIC_COLS.has(key);
  return rows.slice().sort((a, b) => {
    let va = a?.[key], vb = b?.[key];
    if (numeric) {
      va = Number(va); if (!Number.isFinite(va)) va = 0;
      vb = Number(vb); if (!Number.isFinite(vb)) vb = 0;
      return mult * (va - vb);
    } else {
      va = String(va ?? '').toLocaleLowerCase();
      vb = String(vb ?? '').toLocaleLowerCase();
      return mult * va.localeCompare(vb, undefined, { numeric: true });
    }
  });
}

function initHeaderSorting() {
  const ths = document.querySelectorAll('#results thead th.sortable');
  ths.forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-key');
      if (!key) return;
      if (sortKey === key) {
        // toggle direction
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        // sensible default: numeric columns start desc, others asc
        sortDir = NUMERIC_COLS.has(key) ? 'desc' : 'asc';
      }
      drawRows();
    });
  });
  updateSortHeaders();
}

function updateSortHeaders() {
  const ths = document.querySelectorAll('#results thead th.sortable');
  ths.forEach(th => {
    const key = th.getAttribute('data-key');
    th.setAttribute('data-sort', key === sortKey ? sortDir : '');
  });
}

// wire up header sorting once
initHeaderSorting();

(function initDefaults(){
  // show/hide advanced wrapper on load
  if (advWrap) advWrap.style.display = toggleAdvanced?.checked ? '' : 'none';

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
