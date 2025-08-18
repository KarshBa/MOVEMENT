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

function fmtMoney(n){ return new Intl.NumberFormat(undefined,{minimumFractionDigits:0, maximumFractionDigits:0}).format(n); }

// very small line chart helper
function drawLineChart(canvas, seriesArr, options={}) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth  || canvas.width;
  const H = canvas.clientHeight || canvas.height;
  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0,0,W,H);

  const pad = { l: 44, r: 12, t: 10, b: 26 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;

  const allY = seriesArr.flatMap(s => s.data);
  const yMax = Math.max(1, Math.ceil(Math.max(...allY, 0) / 100) * 100);
  const yMin = 0;

  // axes
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, pad.t + plotH);
  ctx.lineTo(pad.l + plotW, pad.t + plotH);
  ctx.stroke();

  // y ticks (4)
  ctx.fillStyle = '#5f6368';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial';
  for (let i=0;i<=4;i++){
    const v = yMin + (yMax - yMin)*i/4;
    const y = pad.t + plotH - (v - yMin) * plotH / (yMax - yMin);
    ctx.strokeStyle = '#f1f3f4';
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l+plotW, y); ctx.stroke();
    ctx.fillText(fmtMoney(v), 4, y+4);
  }

  const n = seriesArr[0]?.data.length || 0;

  function xPos(i){ return pad.l + (n<=1 ? plotW/2 : (plotW*(i/(n-1)))); }
  function yPos(v){ return pad.t + plotH - (v - yMin) * plotH / (yMax - yMin); }

  // draw series
  const palette = options.palette || ['#1a73e8', '#d93025'];
  seriesArr.forEach((s, idx) => {
    const color = s.color || palette[idx % palette.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.data.forEach((v, i) => {
      const x = xPos(i), y = yPos(v);
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();

    // points
    ctx.fillStyle = color;
    s.data.forEach((v,i)=>{
      const x=xPos(i), y=yPos(v);
      ctx.beginPath(); ctx.arc(x,y,2.5,0,Math.PI*2); ctx.fill();
    });
  });

  // x labels if given
  if (options.xLabels && options.xLabels.length === n) {
    ctx.fillStyle = '#5f6368';
    ctx.textAlign = 'center';
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial';
    options.xLabels.forEach((lab, i) => {
      const x = xPos(i);
      ctx.fillText(lab, x, H - 4);
    });
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
  const shortLabels = (weekly.labels || []).map(s => s.slice(5)); // "MM-DD–YYYY-MM-DD" -> trim year start for compactness
  drawLineChart(weeklyCanvas, [{ name:'Sales', data: weekly.points }], { xLabels: shortLabels });

  weeklyLabels.textContent = weekly.labels.join('   |   ');

  // Compare current vs previous
  const cmp = await getJSON(`/api/dept-sales/compare?subdept=${encodeURIComponent(subdept)}`);
  drawLineChart(
    compareCanvas,
    [
      { name:'Current',  data: cmp.current,  color:'#1a73e8' },
      { name:'Previous', data: cmp.previous, color:'#d93025' }
    ],
    { xLabels: cmp.labels }
  );

  // Top 10 items
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

(async function init(){
  try {
    await loadSubdepts();
    // auto-run default (All Departments)
    await run();
  } catch (e) {
    info.textContent = e.message || 'Failed to load data.';
  }

  // redraw charts on resize for crisp DPR scaling
  window.addEventListener('resize', () => {
    // quick re-draw using last data by simply re-running
    run().catch(()=>{});
  }, { passive:true });
})();
