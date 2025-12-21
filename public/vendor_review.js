// public/vendor_review.js
async function getJSON(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(await r.text().catch(() => `${r.status} ${r.statusText}`));
  return r.json();
}

const subSel = document.getElementById('subdept');
const startInput = document.getElementById('start');
const endInput = document.getElementById('end');
const vendorSel = document.getElementById('vendorSel');
const btnRun = document.getElementById('btnRun');

const info = document.getElementById('info');
const dbEndsEl = document.getElementById('dbEnds');

const leftSub = document.getElementById('leftSub');
const rightSub = document.getElementById('rightSub');

const donutVendors = document.getElementById('donutVendors');
const donutItems = document.getElementById('donutItems');

const table = document.getElementById('results');
const tbody = document.getElementById('tbody');

const NF_MNY0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const NF_MNY2 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF_INT  = new Intl.NumberFormat();

// --- hover tooltip (fixed-position div) ---
const hoverTip = (() => {
  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.zIndex = '9999';
  el.style.pointerEvents = 'none';
  el.style.display = 'none';
  el.style.background = 'rgba(255,255,255,.98)';
  el.style.border = '1px solid rgba(0,0,0,.15)';
  el.style.borderRadius = '8px';
  el.style.padding = '6px 8px';
  el.style.boxShadow = '0 6px 18px rgba(0,0,0,.18)';
  el.style.font = '12px system-ui, -apple-system, Segoe UI, Arial';
  el.style.color = '#202124';
  document.body.appendChild(el);

  function show(text, clientX, clientY) {
    el.textContent = text;
    el.style.display = 'block';
    // offset so it doesn't sit under the cursor
    el.style.left = (clientX + 12) + 'px';
    el.style.top  = (clientY + 14) + 'px';
  }
  function hide() { el.style.display = 'none'; }
  return { show, hide };
})();

let vendorSlices = []; // for click-hit testing
let itemSlices = [];
let currentRows = [];
let sortKey = 'Amount-Sum';
let sortDir = 'desc';
let headersWired = false;

const NUMERIC_COLS = new Set([
  'Units-Sum','Amount-Sum','Shrink ($)','Sub-department-Number','Category-Number'
]);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c] || c));
}

function fmtMoney0(n){ return NF_MNY0.format(Number(n || 0)); }
function fmtMoney2(n){ return NF_MNY2.format(Number(n || 0)); }

function parseNum(v){
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/,/g,'').trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function setInfo(msg) {
  info.textContent = msg || '';
}

async function loadDbEnds() {
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
  const rows = await getJSON('/api/subdepartments');
  subSel.innerHTML =
    `<option value="">(Select Sub-Department)</option>` +
    rows.map(r => `<option value="${r.subdept_no}">${escapeHtml(r.label)}</option>`).join('');
}

function setDefaultDatesIfEmpty(maxDateMaybe) {
  if (startInput.value && endInput.value) return;
  const end = maxDateMaybe ? ymdToLocalDate(maxDateMaybe) : new Date();
  const start = new Date(end); start.setDate(end.getDate() - 30);

  endInput.value = toYMD(end);
  startInput.value = toYMD(start);
}

function ymdToLocalDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return new Date();
  return new Date(+m[1], +m[2]-1, +m[3]);
}
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}

function currentFilters() {
  const subdept = String(subSel.value || '').trim();
  const start = String(startInput.value || '').trim();
  const end = String(endInput.value || '').trim();
  const vendor = String(vendorSel.value || '').trim();
  return { subdept, start, end, vendor };
}

// ---------- donut drawing (multi-slice) ----------
function makePalette(n) {
  const out = [];
  for (let i=0; i<n; i++) {
    const h = (i * 360 / Math.max(1,n));
    out.push(`hsl(${h} 70% 55%)`);
  }
  return out;
}

function drawMultiDonut(canvas, slices, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.clientWidth || 600;
  const H = canvas.clientHeight || 320;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0,0,W,H);

  const cx = W/2, cy = H/2;
  // Bigger donut: use more of the canvas + slightly thicker ring
  const outer = Math.min(W, H) / 2 - 4;
  const inner = outer * 0.52;

  const total = slices.reduce((a,s)=>a + (s.value||0), 0) || 1;
  const colors = makePalette(slices.length);

  // ring base
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI*2);
  ctx.arc(cx, cy, inner, Math.PI*2, 0, true);
  ctx.closePath();
  ctx.fillStyle = '#f1f3f4';
  ctx.fill();

  // segments
  let ang = -Math.PI/2;
  const outSlices = [];
  for (let i=0;i<slices.length;i++){
    const s = slices[i];
    const frac = (s.value||0) / total;
    const a0 = ang;
    const a1 = ang + frac * Math.PI*2;
    ang = a1;

    ctx.beginPath();
    ctx.arc(cx, cy, outer, a0, a1);
    ctx.arc(cx, cy, inner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();

    outSlices.push({ ...s, a0, a1, color: colors[i], cx, cy, inner, outer });
  }

  // labels
  ctx.font = '11px system-ui, -apple-system, Segoe UI, Arial';
  ctx.fillStyle = '#202124';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const s of outSlices) {
    const mid = (s.a0 + s.a1)/2;
    const r = (s.inner + s.outer)/2;
    const x = cx + Math.cos(mid)*r;
    const y = cy + Math.sin(mid)*r;

    const name = String(s.label || '');
    const val = `$${fmtMoney0(s.value||0)}`;
    const short = name.length > 18 ? name.slice(0, 18) + '…' : name;

    // small white halo so text stays readable
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.strokeText(short, x, y - 7);
    ctx.strokeText(val, x, y + 7);
    ctx.restore();

    ctx.fillText(short, x, y - 7);
    ctx.fillText(val, x, y + 7);
  }

  // center text
  const labelPx = Math.max(9, Math.round(outer * 0.065));
  ctx.font = `${labelPx}px system-ui, -apple-system, Segoe UI, Arial`;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  const centerText = opts.centerText || '';
  if (centerText) ctx.fillText(centerText, cx, cy);

  return outSlices; // used for click selection
}

function donutHitTest(x, y, slices) {
  if (!slices || !slices.length) return null;

  for (const s of slices) {
    const dx = x - s.cx;
    const dy = y - s.cy;
    const r = Math.hypot(dx, dy);
    if (r < s.inner || r > s.outer) continue;

    // angle in radians, normalize into [0, 2π)
    let ang = Math.atan2(dy, dx);
    if (ang < 0) ang += Math.PI * 2;

    // Our drawing typically starts at -π/2, so shift angles by +π/2
    let a = ang + Math.PI / 2;
    if (a >= Math.PI * 2) a -= Math.PI * 2;

    // Normalize slice bounds into [0, 2π) too
    let a0 = s.a0 + Math.PI / 2;
    let a1 = s.a1 + Math.PI / 2;

    // handle wrap
    while (a0 < 0) { a0 += Math.PI * 2; a1 += Math.PI * 2; }
    while (a > a1) a -= Math.PI * 2;

    if (a >= a0 && a <= a1) return s;
  }
  return null;
}

// ---------- table + sorting ----------
function sortRows(rows, key, dir) {
  const mult = dir === 'asc' ? 1 : -1;
  const numeric = NUMERIC_COLS.has(key);
  return rows.slice().sort((a,b) => {
    let va = a?.[key], vb = b?.[key];
    if (numeric) {
      va = parseNum(va); vb = parseNum(vb);
      return mult * (va - vb);
    }
    va = String(va ?? '').toLocaleLowerCase();
    vb = String(vb ?? '').toLocaleLowerCase();
    return mult * va.localeCompare(vb, undefined, { numeric:true });
  });
}

function updateSortHeaders() {
  document.querySelectorAll('thead th.sortable').forEach(th => {
    const k = th.getAttribute('data-key');
    th.setAttribute('data-sort', k === sortKey ? sortDir : '');
  });
}

function initHeaderSorting() {
  if (headersWired) return;
  headersWired = true;

  const thead = table.querySelector('thead');
  thead.addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const key = th.getAttribute('data-key');
    if (!key) return;

    if (sortKey === key) sortDir = (sortDir === 'asc') ? 'desc' : 'asc';
    else {
      sortKey = key;
      sortDir = NUMERIC_COLS.has(key) ? 'desc' : 'asc';
    }
    renderTable(currentRows);
  });

  thead.querySelectorAll('th.sortable').forEach(th => th.tabIndex = 0);
  updateSortHeaders();
}

function renderTable(rows) {
  currentRows = Array.isArray(rows) ? rows.slice() : [];
  const sorted = sortRows(currentRows, sortKey, sortDir);

  let html = '';
  for (const r of sorted) {
    const amt = parseNum(r["Amount-Sum"]);
    const shrink = parseNum(r["Shrink ($)"]);
    const shrinkClass = (shrink > amt && (shrink > 0 || amt > 0)) ? 'shrink-bad' : '';

    html += `<tr>
      <td>${escapeHtml(r["Item-Code"])}</td>
      <td>${escapeHtml(r["Item-Brand"])}</td>
      <td>${escapeHtml(r["Item-POS description"])}</td>
      <td>${escapeHtml(r["Sub-department-Number"])}</td>
      <td>${escapeHtml(r["Sub-department-Description"])}</td>
      <td>${escapeHtml(r["Category-Number"])}</td>
      <td>${escapeHtml(r["Category-Description"])}</td>
      <td>${escapeHtml(r["Vendor-ID"])}</td>
      <td>${escapeHtml(r["Vendor-Name"])}</td>
      <td class="right">${NF_INT.format(parseNum(r["Units-Sum"]))}</td>
      <td class="right">${fmtMoney2(amt)}</td>
      <td class="right ${shrinkClass}">${fmtMoney2(shrink)}</td>
    </tr>`;
  }

  tbody.innerHTML = html || `<tr><td colspan="12" class="muted">No items for this vendor in range.</td></tr>`;
  table.style.display = currentRows.length ? '' : 'none';
  updateSortHeaders();
}

// ---------- page flow ----------
async function loadVendorsAndRender() {
  const { subdept, start, end } = currentFilters();
  if (!subdept || !start || !end) {
    setInfo('Select sub-department and date range.');
    return;
  }

  setInfo('Loading vendor breakdown…');

  const data = await getJSON(`/api/vendor-review/vendors?subdept=${encodeURIComponent(subdept)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  const vendors = Array.isArray(data?.vendors) ? data.vendors : [];

  const subLabel = subSel.options[subSel.selectedIndex]?.textContent || '';
  leftSub.textContent = `${subLabel} • ${start} → ${end} • Total $${fmtMoney0(data.totalSales || 0)}`;

  // populate vendor select
  vendorSel.innerHTML = vendors.length
    ? vendors.map(v => `<option value="${escapeHtml(v.vendor)}">${escapeHtml(v.vendor)} — $${fmtMoney0(v.amount)}</option>`).join('')
    : `<option value="">(No vendors)</option>`;

  // left donut
  const slices = vendors.slice(0, 30).map(v => ({ label: v.vendor, value: Number(v.amount || 0) })); // cap for readability
  vendorSlices = drawMultiDonut(donutVendors, slices, { centerText: 'Vendors' });

  // auto-pick top vendor (or keep current if still present)
  const current = String(vendorSel.value || '').trim();
  const stillThere = vendors.some(v => v.vendor === current);
  if (!stillThere && vendors.length) vendorSel.value = vendors[0].vendor;

  await loadItemsForVendor();
  setInfo('');
}

async function loadItemsForVendor() {
  const { subdept, start, end, vendor } = currentFilters();
  if (!subdept || !start || !end || !vendor) {
    rightSub.textContent = '—';
    drawMultiDonut(donutItems, [], { centerText: 'Items' });
    renderTable([]);
    return;
  }

  setInfo('Loading items + shrink…');

  const data = await getJSON(`/api/vendor-review/items?subdept=${encodeURIComponent(subdept)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&vendor=${encodeURIComponent(vendor)}`);
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const total = rows.reduce((a,r)=>a + parseNum(r["Amount-Sum"]), 0);

  const subLabel = subSel.options[subSel.selectedIndex]?.textContent || '';
  rightSub.textContent = `${vendor} • ${subLabel} • ${start} → ${end} • Vendor $${fmtMoney0(total)}`;

  // right donut: item mix by $ (cap to 30 slices for readability)
  const itemSlicesIn = rows
    .slice()
    .sort((a,b)=>parseNum(b["Amount-Sum"]) - parseNum(a["Amount-Sum"]))
    .slice(0, 30)
    .map(r => ({
      label: (r["Item-POS description"] || r["Item-Brand"] || r["Item-Code"] || '').toString(),
      value: parseNum(r["Amount-Sum"])
    }));

  itemSlices = drawMultiDonut(donutItems, itemSlicesIn, { centerText: 'Items' });

  // table
  renderTable(rows);
  setInfo('');
}

function wireDonutHover(canvas, getSlices) {
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const slices = getSlices();
    const hit = donutHitTest(x, y, slices);
    if (!hit) return hoverTip.hide();

    const dollars = `$${fmtMoney0(hit.value || 0)}`;
    hoverTip.show(`${hit.label} — ${dollars}`, e.clientX, e.clientY);
  });

  canvas.addEventListener('mouseleave', () => hoverTip.hide());
  canvas.addEventListener('mousedown', () => hoverTip.hide());
}

function wireDonutClicks() {
  donutVendors.addEventListener('click', (e) => {
    const rect = donutVendors.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = donutHitTest(x, y, vendorSlices);
    if (!hit) return;
    vendorSel.value = hit.label;
    loadItemsForVendor().catch(err => setInfo(err.message));
  });
}

async function init() {
  await loadSubdepartments();
  await loadDbEnds();

  // set defaults once we know db max date (if present in the DOM)
  const maxDate = dbEndsEl?.textContent && /^\d{4}-\d{2}-\d{2}$/.test(dbEndsEl.textContent)
    ? dbEndsEl.textContent
    : '';
  setDefaultDatesIfEmpty(maxDate);

  initHeaderSorting();
  wireDonutClicks();
  wireDonutHover(donutVendors, () => vendorSlices);
  wireDonutHover(donutItems,   () => itemSlices);

  btnRun.addEventListener('click', () => loadVendorsAndRender().catch(err => setInfo(err.message)));
  vendorSel.addEventListener('change', () => loadItemsForVendor().catch(err => setInfo(err.message)));

  // optional: auto-run when subdept changes
  subSel.addEventListener('change', () => loadVendorsAndRender().catch(err => setInfo(err.message)));

  setInfo('Ready.');
}
init().catch(err => setInfo(err.message));
