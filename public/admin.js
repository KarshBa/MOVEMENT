// public/admin.js
import { postFile, postJSON } from './client.js';

const fileInput   = document.getElementById('file');
const btnUpload   = document.getElementById('btnUpload');
const btnRefresh  = document.getElementById('btnRefresh');
const errorBox    = document.getElementById('errorBox');
const tbody       = document.getElementById('tbody');
const table       = document.getElementById('resultTable');
const uploadHint  = document.getElementById('uploadHint');

const MAX_MB = Number(new URLSearchParams(location.search).get('max') || 10);
uploadHint.textContent = `Max size: ${MAX_MB} MB (configurable)`;

function isAllowedUploadFile(file) {
  if (!file) return false;
  const name = String(file.name || '').trim().toLowerCase();
  return name.endsWith('.csv') || name.endsWith('.xlsb');
}

fileInput.addEventListener('change', () => {
  errorBox.style.display = 'none';
  const file = fileInput.files?.[0];
  const ok = isAllowedUploadFile(file);
  btnUpload.disabled = !ok;
  if (file && !ok) {
    errorBox.innerHTML = `<strong>Error:</strong> Only .csv or .xlsb files are accepted.`;
    errorBox.style.display = '';
  }
});

btnUpload.addEventListener('click', async () => {
  const file = fileInput.files?.[0];
  if (!isAllowedUploadFile(file)) return;

  btnUpload.disabled = true;
  try {
    const res = await postFile('/api/upload', file);
    renderResult(res);
    table.style.display = '';
    fileInput.value = '';
  } catch (err) {
    showError(err);
  } finally {
    // require choosing a new file
    btnUpload.disabled = true;
  }
});

btnRefresh.addEventListener('click', async () => {
  btnRefresh.disabled = true;
  try {
    await postJSON('/api/refresh', {});
    alert('Refresh completed.');
  } catch (err) {
    showError(err);
  } finally {
    btnRefresh.disabled = false;
  }
});

async function refreshSummary() {
  try {
    const r = await fetch('/api/admin/summary', { credentials: 'same-origin' });
    const s = await r.json();
    const el = document.getElementById('summary');
    el.innerHTML = `
      <div><strong>Total rows:</strong> ${s.rowCount}</div>
      <div><strong>Date range on disk:</strong> ${s.minDate ?? '—'} → ${s.maxDate ?? '—'}</div>
      <div><strong>Last upload:</strong> ${
        s.lastUpload
          ? `${s.lastUpload.file_name} @ ${s.lastUpload.uploaded_at}
             (parsed: ${s.lastUpload.rows_parsed}, inserted: ${s.lastUpload.inserted}, ignored: ${s.lastUpload.ignored})`
          : '—'
      }</div>
    `;
  } catch (e) {
    console.error('summary fetch failed', e);
  }
}
document.addEventListener('DOMContentLoaded', refreshSummary);

function renderResult(res) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td data-label="file">${escapeHtml(res.fileName)}</td>
    <td data-label="rows parsed">${res.rowsParsed}</td>
    <td data-label="inserted">${res.inserted}</td>
    <td data-label="duplicates">${res.ignored}</td>
    <td data-label="sample dates">${(res.sampleDates || []).join(', ')}</td>
    <td data-label="elapsed">${res.elapsedMs}</td>
  `;
  tbody.prepend(tr);
}

function showError(err) {
  const msg = err?.message || 'Upload failed';
  let detail = '';
  if (err?.data?.missingHeaders) {
    detail = `<div><strong>Missing headers:</strong> ${err.data.missingHeaders.join(', ')}</div>`;
  }
  errorBox.innerHTML = `<div><strong>Error:</strong> ${escapeHtml(msg)}</div>${detail}`;
  errorBox.style.display = '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
