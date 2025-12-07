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
const topUnitsTbody = document.getElementById('top10UnitsBody');
const shrinkWeekCanvas    = document.getElementById('shrinkWeekChart');
const shrink30Canvas      = document.getElementById('shrink30Chart');
const shrinkWeekPctEl     = document.getElementById('shrinkWeekPct');
const shrink30PctEl       = document.getElementById('shrink30Pct');
const topShrinkWeekTbody  = document.getElementById('topShrinkWeekBody');
const topShrink30Tbody    = document.getElementById('topShrink30Body');
let cache = { weekly: null, cmp: null, curName: null, prevName: null };
let rAFid = 0;
let isPrinting = false;

function fmtMoney(n){ return new Intl.NumberFormat(undefined,{minimumFractionDigits:0, maximumFractionDigits:0}).format(n); }

function fmtMoney2(n){
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(n);
}

// very small line chart helper (auto y-bounds + end-of-line labels)
function drawLineChart(canvas, seriesArr, options = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = (options.dpr != null) ? options.dpr : (isPrinting ? 1 : (window.devicePixelRatio || 1));
  const W = canvas.clientWidth  || canvas.width  || 600;
  const H = canvas.clientHeight || canvas.height || 300;
  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  if (options.yFocusFraction && options.yFocusFraction > 0 && options.yFocusFraction < 1 && Number.isFinite(max)) {
    const dataMin = allVals.length ? Math.min(...allVals) : 0;
    const targetMin = Math.max(0, max * (1 - options.yFocusFraction));
    if (targetMin > dataMin) {
      min = Math.max(0, dataMin - Math.max(10, (max - dataMin) * 0.05));
    } else {
      min = targetMin;
    }
  }

  // snap to "nice" ticks
  const tickCount = 5;
  const span = Math.max(1, max - min);
  const rawStep = span / tickCount;
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
  ctx.font = labelFont;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (let v = min; v <= max + 1e-9; v += nice) {
    const y = yPos(v);
    ctx.strokeStyle = '#f1f3f4';
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
    ctx.fillText(fmtMoney(v), 6, y);
  }

  // X labels
  if (options.xPills && options.xPills.length) {
    const m = Math.min(n, options.xPills.length);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = labelFont;

    for (let i = 0; i < m; i++) {
      const x = xPos(i);
      const item = options.xPills[i];
      if (!item) continue;

      ctx.fillStyle = '#5f6368';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = labelFont;

      ctx.fillText(item.day || '', x, H - 30);

      const pills = Array.isArray(item.pills) ? item.pills : [];
      if (pills.length === 1) {
        drawPill(ctx, x, H - 6, pills[0].text, pills[0].color);
      } else if (pills.length === 2) {
        const gap = 8;
        const widthFor = (t) => Math.ceil(ctx.measureText(t).width) + 12;
        const w0 = widthFor(pills[0].text);
        const w1 = widthFor(pills[1].text);
        const total = w0 + w1 + gap;
        drawPill(ctx, x - total/2 + w0/2, H - 6, pills[0].text, pills[0].color);
        drawPill(ctx, x + total/2 - w1/2, H - 6, pills[1].text, pills[1].color);
      }
    }
  } else if (options.xLabelLines && options.xLabelLines.length === n) {
    ctx.fillStyle = '#5f6368';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = labelFont;
    for (let i = 0; i < n; i++) {
      const x = xPos(i);
      const [l1, l2] = options.xLabelLines[i];
      ctx.fillText(l1, x, H - 18);
      ctx.fillText(l2, x, H - 4);
    }
  } else if (options.xLabels && options.xLabels.length === n) {
    ctx.fillStyle = '#5f6368';
    ctx.textAlign = 'center';
    ctx.font = labelFont;
    for (let i = 0; i < n; i++) {
      const x = xPos(i);
      ctx.fillText(options.xLabels[i], x, H - 4);
    }
  }

  // draw series
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

    ctx.fillStyle = color;
    (s.data || []).forEach((v, i) => {
      const x = xPos(i), y = yPos(v);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    if (options.endLabels !== false) {
      for (let i = (s.data?.length || 0) - 1; i >= 0; i--) {
        const v = s.data[i];
        if (Number.isFinite(v)) {
          const x = xPos(i), y = yPos(v);
          ctx.fillStyle = color;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.font = labelFont;
          const label = s.name || `Series ${idx + 1}`;
          ctx.fillText(` ${label}`, x + 8, y);
          break;
        }
      }
    }
  });

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
} // ← end of drawLineChart

// 💿 Top-level donut helper (now *outside* drawLineChart)
function drawDonutChart(canvas, percent, opts = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = isPrinting ? 1 : (window.devicePixelRatio || 1);
  const W = canvas.clientWidth  || canvas.width  || 220;
  const H = canvas.clientHeight || canvas.height || 180;
  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H / 2;
  const outer = Math.min(W, H) / 2 - 8;
  const inner = outer * 0.6;

  const pctRaw = Number(percent) || 0;
  const pct = Math.max(0, Math.min(100, pctRaw));
  const angle = (pct / 100) * Math.PI * 2;

  const baseColor = opts.baseColor || '#e0e0e0';
  const fillColor = opts.fillColor || '#d93025';

  // base ring
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.arc(cx, cy, inner, Math.PI * 2, 0, true);
  ctx.closePath();
  ctx.fillStyle = baseColor;
  ctx.fill();

  // shrink wedge
  if (pct > 0) {
    const start = -Math.PI / 2;
    const end   = start + angle;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, start, end);
    ctx.arc(cx, cy, inner, end, start, true);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
  }

  // center label
  ctx.fillStyle = '#202124';
  ctx.font = (isPrinting ? '12px' : '14px') + ' system-ui, -apple-system, Segoe UI, Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(pct.toFixed(1) + '%', cx, cy);
}

function drawPill(ctx, xCenter, yBaseline, text, bg) {
  ctx.save();
  const padH = 6, padV = 3, radius = 6;
  ctx.font = (isPrinting ? '11px' : '12px') + ' system-ui, -apple-system, Segoe UI, Arial';
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
  ctx.restore();
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

  // Normalize API fields:
  // - thisYearData: this year's last 5 weeks
  // - lastYearData: last year's comparable 5 weeks (if present)
  const thisYearData = weekly.pointsThis ?? weekly.points ?? [];
  const lastYearData = weekly.pointsLast ?? weekly.prevPoints ?? null;

  const thisYearLabel = weekly.year ?? new Date().getFullYear();
  const lastYearLabel = weekly.prevYear ?? (thisYearLabel - 1);

    // compact Sun–Sat label + pills:
  // green = this year, red = last year (if available)
  const weeklyXPills = (weekly.labels || []).map((s, i) => {
    const m = /^(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})$/.exec(String(s).trim());
    const rangeShort = m ? `${m[1].slice(5)}–${m[2].slice(5)}` : String(s);

    const pills = [
      { text: fmtMoney(thisYearData[i] || 0), color: '#188038' } // this year (green)
    ];
    if (Array.isArray(lastYearData)) {
      pills.push({ text: fmtMoney(lastYearData[i] || 0), color: '#d93025' }); // last year (red)
    }

    return { day: rangeShort, pills };
  });

  // Build series array: always this year (green), add last year (red) if available
  const weeklySeries = [
    { name: String(thisYearLabel), data: thisYearData, color: '#188038' } // green
  ];
  if (Array.isArray(lastYearData)) {
    weeklySeries.push({
      name: String(lastYearLabel),
      data: lastYearData,
      color: '#d93025' // red
    });
  }

  drawLineChart(
    weeklyCanvas,
    weeklySeries,
    {
      xPills: weeklyXPills,
      yFocusFraction: 0.6,
      endGap: 16,
      pad: { l: 56, r: 40, t: 12, b: 72 }
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
      <td>${fmtMoney2(it.amount)}</td>
    </tr>
  `).join('') || `<tr><td colspan="4" class="muted">No data.</td></tr>`;

  // Top 10 items by units (U)
  const topUnits = await getJSON(`/api/dept-sales/top-items-units?subdept=${encodeURIComponent(subdept)}`);
  topUnitsTbody.innerHTML = (topUnits.items || []).map(it => `
    <tr>
      <td>${escapeHtml(it.code || '')}</td>
      <td>${escapeHtml(it.brand || '')}</td>
      <td>${escapeHtml(it.description || '')}</td>
      <td>${fmtMoney(it.units)}</td>
    </tr>
  `).join('') || `<tr><td colspan="4" class="muted">No data.</td></tr>`;
  // ─── Shrink vs Sales: last week + last 30 days ──────────────────────
  const shrink = await getJSON(`/api/dept-sales/shrink-metrics?subdept=${encodeURIComponent(subdept)}`);
  console.log('shrink metrics JSON:', shrink);
  cache.shrink = shrink;

  if (shrink && shrink.lastWeek) {
    const pct = shrink.lastWeek.percent || 0;
    drawDonutChart(shrinkWeekCanvas, pct, {
      baseColor: '#e0e0e0',
      fillColor: '#d93025' // red for last week
    });
    if (shrinkWeekPctEl) {
      shrinkWeekPctEl.textContent = pct.toFixed(1) + '%';
    }
    topShrinkWeekTbody.innerHTML = (shrink.lastWeek.topItems || []).map(it => `
      <tr>
        <td>${escapeHtml(it.code || '')}</td>
        <td>${escapeHtml(it.brand || '')}</td>
        <td>${escapeHtml(it.description || '')}</td>
        <td>${fmtMoney2(it.amount)}</td>
      </tr>
    `).join('') || `<tr><td colspan="4" class="muted">No data.</td></tr>`;
  } else {
    if (shrinkWeekPctEl) shrinkWeekPctEl.textContent = '—';
    topShrinkWeekTbody.innerHTML = `<tr><td colspan="4" class="muted">No data.</td></tr>`;
  }

  if (shrink && shrink.last30) {
    const pct30 = shrink.last30.percent || 0;
    drawDonutChart(shrink30Canvas, pct30, {
      baseColor: '#e0e0e0',
      fillColor: '#f29c1f' // orange for 30-day window
    });
    if (shrink30PctEl) {
      shrink30PctEl.textContent = pct30.toFixed(1) + '%';
    }
    topShrink30Tbody.innerHTML = (shrink.last30.topItems || []).map(it => `
      <tr>
        <td>${escapeHtml(it.code || '')}</td>
        <td>${escapeHtml(it.brand || '')}</td>
        <td>${escapeHtml(it.description || '')}</td>
        <td>${fmtMoney2(it.amount)}</td>
      </tr>
    `).join('') || `<tr><td colspan="4" class="muted">No data.</td></tr>`;
  } else {
    if (shrink30PctEl) shrink30PctEl.textContent = '—';
    topShrink30Tbody.innerHTML = `<tr><td colspan="4" class="muted">No data.</td></tr>`;
  }
}

btn.addEventListener('click', run);
// Print button (CSP-safe: no inline JS)
document.getElementById('btnPrint')?.addEventListener('click', () => {
  window.print();
});

function setChartWrapHeightsForPrint() {
  // lock ~3:2 ratio so text isn’t squished
  const ratio = 2 / 3; // H = W * ratio (≈0.666)
  [weeklyCanvas, compareCanvas].forEach(c => {
    const wrap = c?.closest('.chart-wrap');
    if (!wrap) return;
    const w = wrap.clientWidth || c.clientWidth || 600;
    wrap.style.height = Math.round(w * ratio) + 'px';
  });
}

function clearChartWrapHeights() {
  [weeklyCanvas, compareCanvas].forEach(c => {
    const wrap = c?.closest('.chart-wrap');
    if (wrap) wrap.style.height = '';
  });
}

window.addEventListener('beforeprint', () => {
  isPrinting = true;            // draw with DPR=1 for crisp print text
  setChartWrapHeightsForPrint(); // size wrappers (not canvas) -> no canvas CSS scaling
  window.dispatchEvent(new Event('resize')); // redraw at new size
});

window.addEventListener('afterprint', () => {
  isPrinting = false;
  clearChartWrapHeights();
  window.dispatchEvent(new Event('resize')); // redraw back to screen size
});

const mqPrint = window.matchMedia && window.matchMedia('print');
if (mqPrint && mqPrint.addEventListener) {
  mqPrint.addEventListener('change', (e) => {
    isPrinting = !!e.matches;
    if (isPrinting) setChartWrapHeightsForPrint(); else clearChartWrapHeights();
    window.dispatchEvent(new Event('resize'));
  });
}

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

        // weekly green pills + two-line redraw (this year + last year)
    const weekly = cache.weekly;

    const thisYearData = weekly.pointsThis ?? weekly.points ?? [];
    const lastYearData = weekly.pointsLast ?? weekly.prevPoints ?? null;
    const thisYearLabel = weekly.year ?? new Date().getFullYear();
    const lastYearLabel = weekly.prevYear ?? (thisYearLabel - 1);

        const weeklyXPills = (weekly.labels || []).map((s, i) => {
      const m = /^(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})$/.exec(String(s).trim());
      const rangeShort = m ? `${m[1].slice(5)}–${m[2].slice(5)}` : String(s);

      const pills = [
        { text: fmtMoney(thisYearData[i] || 0), color: '#188038' } // this year (green)
      ];
      if (Array.isArray(lastYearData)) {
        pills.push({ text: fmtMoney(lastYearData[i] || 0), color: '#d93025' }); // last year (red)
      }

      return { day: rangeShort, pills };
    });

    const weeklySeries = [
      { name: String(thisYearLabel), data: thisYearData, color: '#188038' } // green
    ];
    if (Array.isArray(lastYearData)) {
      weeklySeries.push({
        name: String(lastYearLabel),
        data: lastYearData,
        color: '#d93025' // red
      });
    }

    drawLineChart(
      weeklyCanvas,
      weeklySeries,
      {
        xPills: weeklyXPills,
        yFocusFraction: 0.6,
        endGap: 16,
        pad: { l: 56, r: 40, t: 12, b: 72 }
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
  // Shrink donuts: re-draw at new size (no refetch)
    if (cache.shrink && cache.shrink.lastWeek) {
      drawDonutChart(shrinkWeekCanvas, cache.shrink.lastWeek.percent || 0, {
        baseColor: '#e0e0e0',
        fillColor: '#d93025'
      });
    }
    if (cache.shrink && cache.shrink.last30) {
      drawDonutChart(shrink30Canvas, cache.shrink.last30.percent || 0, {
        baseColor: '#e0e0e0',
        fillColor: '#f29c1f'
      });
    }
  });
}, { passive:true });
})();
