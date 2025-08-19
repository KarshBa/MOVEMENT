// department_sales.js
async function getJSON(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

const sel = document.getElementById('dept');
const btn = document.getElementById('btnGo');
const info = document.getElementById('info');
const wkEndEl = document.getElementById('wkEnd');

const weeklyCanvas  = document.getElementById('weeklyChart');
const compareCanvas = document.getElementById('compareChart');
const weeklyLabels  = document.getElementById('weeklyLabels');
const topTbody      = document.getElementById('top10Body');
let cache = { weekly: null, cmp: null, curName: null, prevName: null };
let rAFid = 0;
let isPrinting = false;

function fmtMoney(n){ return new Intl.NumberFormat(undefined,{minimumFractionDigits:0, maximumFractionDigits:0}).format(n); }

// very small line chart helper (auto y-bounds + end-of-line labels)
function drawLineChart(canvas, seriesArr, options = {}) {
  if (!canvas) return;                           // <-- guard: missing canvas
  const ctx = canvas.getContext('2d');
  if (!ctx) return;                              // <-- guard: no 2d context
  const dpr = (options.dpr != null) ? options.dpr : (isPrinting ? 1 : (window.devicePixelRatio || 1));
  const W = canvas.clientWidth  || canvas.width  || 600;
  const H = canvas.clientHeight || canvas.height || 300;
  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // crisp on screen; DPR=1 on print
  ctx.clearRect(0, 0, W, H);

  const fmtMoney = options.yFormatter || (n => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n));
  const usingTwoLineX = options.xLabelLines && Array.isArray(options.xLabelLines);
  const usingPills   = options.xPills && Array.isArray(options.xPills);
  const defaultBottom = (usingTwoLineX || usingPills) ? (isPrinting ? 56 : 44) : 26;
  const pad = options.pad || { l: 52, r: 36, t: 10, b: defaultBottom };
  const plotW = Math.max(10, W - pad.l - pad.r);
  const plotH = Math.max(10, H - pad.t - pad.b);
  const endGap = options.endGap ?? 12;

  const n = seriesArr[0]?.data?.length || 0;
  const allVals = seriesArr.flatMap(s => (s.data || []).filter(v => Number.isFinite(v)));
  let min = Math.min(...allVals, 0), max = Math.max(...allVals, 0);

  // handle all-zero or single-value cases
  if (!allVals.length) { min = 0; max = 1; }
  if (min === max) {
    const padAbs = Math.max(10, max * 0.1);
    min = Math.max(0, max - padAbs);
    max = max + padAbs;
  } else {
    // add ~10% padding
    const range = max - min;
    const padAmt = Math.max(10, range * 0.1);
    min = Math.max(0, min - padAmt);
    max = max + padAmt;
  }

  // Dynamically focus the vertical range around the top values.
// e.g. yFocusFraction = 0.6 shows roughly the top 60% of the scale.
if (options.yFocusFraction && options.yFocusFraction > 0 && options.yFocusFraction < 1 && Number.isFinite(max)) {
  const dataMin = Math.min(...allVals);
  const targetMin = Math.max(0, max - max * options.yFocusFraction); // e.g., 40% of top becomes baseline
  // Ensure we still include the actual data min if it's above the targetMin (with a tiny pad)
  if (targetMin > dataMin) {
    min = Math.max(0, dataMin - Math.max(10, (max - dataMin) * 0.05));
  } else {
    min = targetMin;
  }
}

  // snap to "nice" ticks
  const tickCount = 5;
  const rawStep = (max - min) / tickCount;
  const nice = niceStep(rawStep);
  min = Math.floor(min / nice) * nice;
  max = Math.ceil(max / nice) * nice;

  function xPos(i) {
  const span = Math.max(0, plotW - endGap);
  return pad.l + (n <= 1 ? span / 2 : (span * (i / (n - 1))));
}
  
  function yPos(v) {
    const t = (v - min) / (max - min || 1);
    return pad.t + (1 - t) * plotH;
  }

  // axes + grid
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, pad.t + plotH);
  ctx.lineTo(pad.l + plotW, pad.t + plotH);
  ctx.stroke();

  // y ticks
  ctx.fillStyle = '#5f6368';
  const labelFont = (isPrinting ? '11px' : '12px') + ' system-ui, -apple-system, Segoe UI, Arial';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (let v = min; v <= max + 1e-9; v += nice) {
    const y = yPos(v);
    // light grid line
    ctx.strokeStyle = '#f1f3f4';
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
    // tick label
    ctx.fillText(fmtMoney(v), 6, y);
  }

   // X labels: supports three modes — xPills (day + colored pills), two-line, or single-line
if (options.xPills && options.xPills.length === n) {
  ctx.fillStyle = '#5f6368';
  ctx.textAlign = 'center';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial';
  for (let i = 0; i < n; i++) {
    const x = xPos(i);
    const item = options.xPills[i]; // { day: 'Mon', pills: [{text, color}, ...] }

    // day label above pills
    ctx.fillText(item.day || '', x, H - 30);

    // pills (1–2) centered under the day
    const pills = Array.isArray(item.pills) ? item.pills : [];
    if (pills.length === 1) {
      drawPill(ctx, x, H - 6, pills[0].text, pills[0].color);
    } else if (pills.length === 2) {
      const gap = 8;
      ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial';
      const widthFor = (t) => Math.ceil(ctx.measureText(t).width) + 12; // padH*2
      const w0 = widthFor(pills[0].text);
      const w1 = widthFor(pills[1].text);
      const total = w0 + w1 + gap;
      const leftCenter  = x - total / 2 + w0 / 2;
      const rightCenter = x + total / 2 - w1 / 2;

      drawPill(ctx, leftCenter,  H - 6, pills[0].text, pills[0].color);
      drawPill(ctx, rightCenter, H - 6, pills[1].text, pills[1].color);
    }
  }
} else if (options.xLabelLines && options.xLabelLines.length === n) {
  ctx.fillStyle = '#5f6368';
ctx.textAlign = 'center';
ctx.textBaseline = 'alphabetic'; // ensure consistent placement at bottom edge
ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial';
for (let i = 0; i < n; i++) {
  const x = xPos(i);
  const [l1, l2] = options.xLabelLines[i];
  ctx.fillText(l1, x, H - 18);
  ctx.fillText(l2, x, H - 4);
  }
} else if (options.xLabels && options.xLabels.length === n) {
  ctx.fillStyle = '#5f6368';
  ctx.textAlign = 'center';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial';
  for (let i = 0; i < n; i++) {
    const x = xPos(i);
    ctx.fillText(options.xLabels[i], x, H - 4);
  }
}

// draw series (round caps/joins for visibility)
const palette = options.palette || ['#188038', '#f29c1f', '#1a73e8', '#d93025'];
seriesArr.forEach((s, idx) => {
  const color = s.color || palette[idx % palette.length];
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  ctx.beginPath();
  (s.data || []).forEach((v, i) => {
    const x = xPos(i), y = yPos(v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // points
  ctx.fillStyle = color;
  (s.data || []).forEach((v, i) => {
    const x = xPos(i), y = yPos(v);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // end-of-line label
  if (options.endLabels !== false) {
    for (let i = (s.data?.length || 0) - 1; i >= 0; i--) {
      const v = s.data[i];
      if (Number.isFinite(v)) {
        const x = xPos(i), y = yPos(v);
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial';
        const label = s.name || `Series ${idx + 1}`;
        ctx.fillText(` ${label}`, x + 8, y);
        break;
      }
    }
  }
});
  
  // optional HTML legend target
  if (options.legendEl) {
    options.legendEl.innerHTML = seriesArr.map((s, idx) => {
      const c = s.color || palette[idx % palette.length];
      return `<span style="display:inline-flex;align-items:center;margin-right:12px;">
        <span style="width:12px;height:12px;background:${c};display:inline-block;border-radius:2px;margin-right:6px;"></span>
        ${escapeHtml(s.name || `Series ${idx + 1}`)}
      </span>`;
    }).join('');
  }

  function niceStep(step) {
    const pow10 = Math.pow(10, Math.floor(Math.log10(step || 1)));
    const n = step / pow10;
    let m;
    if (n <= 1) m = 1;
    else if (n <= 2) m = 2;
    else if (n <= 5) m = 5;
    else m = 10;
    return m * pow10;
  }
}

function drawPill(ctx, xCenter, yBaseline, text, bg) {
  const padH = 6, padV = 3, radius = 6;
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial';
  const w = Math.ceil(ctx.measureText(text).width) + padH * 2;
  const h = 18;
  const x = Math.round(xCenter - w / 2);
  const y = Math.round(yBaseline - h);

  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();

  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
}

async function loadSubdepts() {
  const rows = await getJSON('/api/subdepartments');
  // Build options: All + list
  sel.innerHTML = `<option value="all">(All Departments)</option>` +
    rows.map(r => `<option value="${r.subdept_no}">${escapeHtml(r.label)}</option>`).join('');
}

function escapeHtml(s){
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]||c));
}

async function run() {
  info.textContent = '';
  const subdept = sel.value || 'all';
  // update printed sub-department header if present
  const selText = sel.options[sel.selectedIndex]?.textContent || 'All Departments';
  const printEl = document.getElementById('printSubdept');
  if (printEl) printEl.textContent = selText;

  // Meta for week ranges
  const meta = await getJSON('/api/dept-sales/meta');
  wkEndEl.textContent = meta.lastWeekEnd || '—';

    // Weekly 5
  const weekly = await getJSON(`/api/dept-sales/weekly?subdept=${encodeURIComponent(subdept)}`);
  cache.weekly = weekly;

  // compact Sun–Sat label + green pill amount
const weeklyXPills = (weekly.labels || []).map((s, i) => {
  const m = /^(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})$/.exec(String(s).trim());
  const rangeShort = m ? `${m[1].slice(5)}–${m[2].slice(5)}` : String(s);
  return {
    day: rangeShort,
    pills: [{ text: fmtMoney(weekly.points[i] || 0), color: '#188038' }]
  };
});

drawLineChart(
  weeklyCanvas,
  [{ name: 'Weekly Sales', data: weekly.points, color: '#188038' }],
  {
    xPills: weeklyXPills,
    yFocusFraction: 0.6,
    endGap: 16,
    pad: { l: 56, r: 40, t: 12, b: 64 }
  }
);

    // If you still want the long labels elsewhere:
  if (weeklyLabels) weeklyLabels.textContent = weekly.labels.join('   |   ');

    // Compare current vs previous — fetch first, then draw ONCE
  const cmp = await getJSON(`/api/dept-sales/compare?subdept=${encodeURIComponent(subdept)}`);

  // Parse "YYYY-MM-DD" as a local date (avoid UTC shift)
function parseYMDLocal(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd) || '');
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  return new Date(y, mo, d); // local midnight
}

// Build human week ranges from the server's Saturday (weekEnd) — label Sun–Sat
let curName = 'Current Week', prevName = 'Previous Week'; // safe defaults
if (cmp.weekEnd) {
  const weekEnd = parseYMDLocal(cmp.weekEnd); // Saturday local
  if (weekEnd && !Number.isNaN(weekEnd.getTime())) {
    const curStart = new Date(weekEnd); curStart.setDate(weekEnd.getDate() - 6); // Sunday
    const prevEnd  = new Date(weekEnd); prevEnd.setDate(weekEnd.getDate() - 7); // prior Saturday
    const prevStart= new Date(prevEnd); prevStart.setDate(prevEnd.getDate() - 6); // prior Sunday
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    curName  = `${fmt(curStart)}–${fmt(weekEnd)}`;
    prevName = `${fmt(prevStart)}–${fmt(prevEnd)}`;
  }
}
  
  cache.cmp = cmp;
  cache.curName = curName;
  cache.prevName = prevName;

  // day label + colored amount pills (green=current, orange=previous)
const xPills = cmp.labels.map((day, i) => ({
  day,
  pills: [
    { text: fmtMoney(cmp.current[i] ?? 0),  color: '#188038' }, // green
    { text: fmtMoney(cmp.previous[i] ?? 0), color: '#f29c1f' }  // orange
  ]
}));

const compareLegend = document.getElementById('compareLegend');
drawLineChart(
  compareCanvas,
  [
    { name: curName,  data: cmp.current,  color: '#188038' }, // green
    { name: prevName, data: cmp.previous, color: '#f29c1f' }  // orange
  ],
  { xPills, legendEl: compareLegend, endGap: 12, pad: { l: 52, r: 36, t: 10, b: 48 } }
);

  // Top 10 items (unchanged)
  const top = await getJSON(`/api/dept-sales/top-items?subdept=${encodeURIComponent(subdept)}`);
  topTbody.innerHTML = (top.items || []).map(it => `
    <tr>
      <td>${escapeHtml(it.code || '')}</td>
      <td>${escapeHtml(it.brand || '')}</td>
      <td>${escapeHtml(it.description || '')}</td>
      <td>${fmtMoney(it.amount)}</td>
    </tr>
  `).join('') || `<tr><td colspan="4" class="muted">No data.</td></tr>`;
}

btn.addEventListener('click', run);
// Print button (CSP-safe: no inline JS)
document.getElementById('btnPrint')?.addEventListener('click', () => {
  window.print();
});

// Ensure charts expand & reflow crisply for print, then reset
window.addEventListener('beforeprint', () => {
  isPrinting = true; // <<— IMPORTANT: force DPR=1 & extra bottom pad
  weeklyCanvas.style.height = '360px';
  compareCanvas.style.height = '360px';
  window.dispatchEvent(new Event('resize'));
});

window.addEventListener('afterprint', () => {
  isPrinting = false; // <<— restore screen DPR
  weeklyCanvas.style.height = '';
  compareCanvas.style.height = '';
  window.dispatchEvent(new Event('resize'));
});

(async function init(){
  try {
    await loadSubdepts();
    await run();
  } catch (e) {
    info.textContent = e.message || 'Failed to load data.';
  }

  // only redraw with cache on resize (no refetch) — debounced via rAF
window.addEventListener('resize', () => {
  if (rAFid) cancelAnimationFrame(rAFid);
  rAFid = requestAnimationFrame(() => {
    if (!cache.weekly || !cache.cmp) return;

    // weekly green pills
const weeklyXPills = (cache.weekly.labels || []).map((s, i) => {
  const m = /^(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})$/.exec(String(s).trim());
  const rangeShort = m ? `${m[1].slice(5)}–${m[2].slice(5)}` : String(s);
  return {
    day: rangeShort,
    pills: [{ text: fmtMoney(cache.weekly.points[i] || 0), color: '#188038' }]
  };
});
    
drawLineChart(
  weeklyCanvas,
  [{ name: 'Weekly Sales', data: cache.weekly.points, color: '#188038' }],
  {
    xPills: weeklyXPills,
    yFocusFraction: 0.6,
    endGap: 16,
    pad: { l: 56, r: 40, t: 12, b: 64 }
  }
);

    // compare pills (green/orange) — rebuild on redraw
const xPills = cache.cmp.labels.map((day, i) => ({
  day,
  pills: [
    { text: fmtMoney(cache.cmp.current[i] ?? 0),  color: '#188038' },
    { text: fmtMoney(cache.cmp.previous[i] ?? 0), color: '#f29c1f' }
  ]
}));

const compareLegend = document.getElementById('compareLegend');
drawLineChart(
  compareCanvas,
  [
    { name: cache.curName,  data: cache.cmp.current,  color: '#188038' },
    { name: cache.prevName, data: cache.cmp.previous, color: '#f29c1f' }
  ],
  { xPills, legendEl: compareLegend, endGap: 12, pad: { l: 52, r: 36, t: 10, b: 48 } }
);
  });
}, { passive:true });
})();
