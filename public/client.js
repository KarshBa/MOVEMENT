export async function getJSON(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw await mkErr(r);
  return r.json();
}

export async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body || {})
  });
  if (!r.ok) throw await mkErr(r);
  return r.json();
}

export async function postFile(url, file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(url, {
    method: 'POST',
    body: fd,
    credentials: 'include'
  });
  if (!r.ok) throw await mkErr(r);
  return r.json();
}

async function mkErr(r) {
  let data = null;
  try { data = await r.json(); } catch {}
  const msg = data?.error || `${r.status} ${r.statusText}`;
  const err = new Error(msg);
  err.status = r.status;
  err.data = data;
  return err;
}

export function pad13(s) {
  const digits = String(s ?? '').replace(/\D+/g, '');
  return digits.padStart(13, '0');
}

export function buildQueryString(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  return p.toString();
}

// (Optional) generic CSV download helper, not used for /api/export
export function downloadCsv(filename, rows) {
  const headers = Object.keys(rows[0] || {});
  const lines = [headers.join(',')];
  for (const r of rows) {
    const vals = headers.map(h => csvEscape(r[h]));
    lines.push(vals.join(','));
  }
  const blob = new Blob([lines.join('\n')], { type:'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}
