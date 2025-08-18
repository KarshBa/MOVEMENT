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
let rAFid = 0; // for resize redraw debounce

function fmtMoney(n){ return new Intl.NumberFormat(undefined,{minimumFractionDigits:0, maximumFractionDigits:0}).format(n); }

// very small line chart helper (auto y-bounds + end-of-line labels)
function drawLineChart(canvas, seriesArr, options = {}) {
  if (!canvas) return;                           // <-- guard: missing canvas
  const ctx = canvas.getContext('2d');
  if (!ctx) return;                              // <-- guard: no 2d context
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth  || canvas.width  || 600;
  const H = canvas.clientHeight || canvas.height || 300;
  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // crisp on HiDPI
  ctx.clearRect(0, 0, W, H);

  const fmtMoney = options.yFormatter || (n => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n));
  const usingTwoLineX = options.xLabelLines && Array.isArray(options.xLabelLines);
  const pad = options.pad || { l: 52, r: 14, t: 10, b: usingTwoLineX ? 38 : 26 };
  const plotW = Math.max(10, W - pad.l - pad.r);
  const plotH = Math.max(10, H - pad.t - pad.b);

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

  // snap to "nice" ticks
  const tickCount = 5;
  const rawStep = (max - min) / tickCount;
  const nice = niceStep(rawStep);
  min = Math.floor(min / nice) * nice;
  max = Math.ceil(max / nice) * nice;

  function xPos(i) {
    return pad.l + (n <= 1 ? plotW / 2 : (plotW * (i / (n - 1))));
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
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial';
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

    // x labels (supports single-line or two-line)
  if (options.xLabelLines && options.xLabelLines.length === n) {
    ctx.fillStyle = '#5f6368';
    ctx.textAlign = 'center';
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial';
    for (let i = 0; i < n; i++) {
      const x = xPos(i);
      const [l1, l2] = options.xLabelLines[i];
      // first line a bit above bottom, second line at bottom
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

  // draw series
  const palette = options.palette || ['#1a73e8', '#d93025', '#188038', '#f29c1f'];
  seriesArr.forEach((s, idx) => {
    const color = s.color || palette[idx % palette.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
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
      // find last finite point
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

  // Meta for week ranges
  const meta = await getJSON('/api/dept-sales/meta');
  wkEndEl.textContent = meta.lastWeekEnd || '—';

    // Weekly 5
  const weekly = await getJSON(`/api/dept-sales/weekly?subdept=${encodeURIComponent(subdept)}`);
  cache.weekly = weekly;

  // line1: compact range (trim year from each side), line2: $ amount
  const shortRanges = (weekly.labels || []).map(s => {
    const [a, b] = s.split('–'); return `${a.slice(5)}–${b.slice(5)}`;
  });
  const weeklyLines = shortRanges.map((range, i) => [range, fmtMoney(weekly.points[i] || 0)]);

  drawLineChart(
    weeklyCanvas,
    [{ name: 'Weekly Sales', data: weekly.points }],
    { xLabelLines: weeklyLines }
  );

    // If you still want the long labels elsewhere:
  if (weeklyLabels) weeklyLabels.textContent = weekly.labels.join('   |   ');

    // Compare current vs previous — fetch first, then draw ONCE
  const cmp = await getJSON(`/api/dept-sales/compare?subdept=${encodeURIComponent(subdept)}`);

  // Build human week ranges from the server's Saturday (weekEnd)
let curName = 'Current Week', prevName = 'Previous Week'; // safe defaults
if (cmp.weekEnd) {
  const weekEnd = new Date(cmp.weekEnd); // Saturday
  if (!Number.isNaN(weekEnd.getTime())) {
    const curStart = new Date(weekEnd); curStart.setDate(weekEnd.getDate() - 6);
    const prevEnd  = new Date(weekEnd); prevEnd.setDate(weekEnd.getDate() - 7);
    const prevStart= new Date(prevEnd);  prevStart.setDate(prevEnd.getDate() - 6);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    curName  = `${fmt(curStart)}–${fmt(weekEnd)}`;
    prevName = `${fmt(prevStart)}–${fmt(prevEnd)}`;
  }
}
  cache.cmp = cmp;
  cache.curName = curName;
  cache.prevName = prevName;

  // Two-line X labels: day on top, money "current / previous" on bottom
  const xLabelLines = cmp.labels.map((day, i) => {
    const cur = cmp.current[i] ?? 0;
    const prv = cmp.previous[i] ?? 0;
    return [day, `${fmtMoney(cur)} / ${fmtMoney(prv)}`];
  });

  const compareLegend = document.getElementById('compareLegend'); // optional legend container
  drawLineChart(
    compareCanvas,
    [
      { name: curName,  data: cmp.current,  color: '#1a73e8' },
      { name: prevName, data: cmp.previous, color: '#d93025' }
    ],
    { xLabelLines, legendEl: compareLegend }
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

// Ensure charts reflow crisply when entering/exiting print
window.addEventListener('beforeprint', () => {
  window.dispatchEvent(new Event('resize'));
});
window.addEventListener('afterprint', () => {
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

    // weekly two-line labels
    const shortRanges = (cache.weekly.labels || []).map(s => {
      const [a,b] = s.split('–'); return `${a.slice(5)}–${b.slice(5)}`;
    });
    const weeklyLines = shortRanges.map((r, i) => [r, fmtMoney(cache.weekly.points[i] || 0)]);
    drawLineChart(
      weeklyCanvas,
      [{ name:'Weekly Sales', data: cache.weekly.points }],
      { xLabelLines: weeklyLines }
    );

    // compare two-line labels
    const xLabelLines = cache.cmp.labels.map((day, i) => {
      const cur = cache.cmp.current[i] ?? 0;
      const prv = cache.cmp.previous[i] ?? 0;
      return [day, `${fmtMoney(cur)} / ${fmtMoney(prv)}`];
    });

    const compareLegend = document.getElementById('compareLegend');
    drawLineChart(
      compareCanvas,
      [
        { name: cache.curName,  data: cache.cmp.current,  color: '#1a73e8' },
        { name: cache.prevName, data: cache.cmp.previous, color: '#d93025' }
      ],
      { xLabelLines, legendEl: compareLegend }
    );
  });
}, { passive:true });
})();
