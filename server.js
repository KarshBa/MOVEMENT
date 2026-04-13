//server.js
import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import morgan from 'morgan';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { format as csvFormat } from '@fast-csv/format';
import { Worker } from 'node:worker_threads';
import { parse as csvParse } from 'csv-parse';
import * as XLSX from 'xlsx/xlsx.mjs';
XLSX.set_fs(fs);
import { parse as parseDateFns, format as formatDate, isValid } from 'date-fns';

import { basicAuth } from './auth.js';
import {
  db, insertManyTxns, upsertSubdepartments,
  querySubdepartments, rangeAggregate, upcsAggregate, optimize,
  insertUploadMeta,
  queueCreateJob, queueMarkStarted, queueMarkDone, queueMarkError, queueGetJob, queueNextJob,
  searchBrands,
  searchVendors,
  soldCodesInRange
} from './db.js';

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
  // don't process.exit here; let Render restart it if it truly dies
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] unhandledRejection:', err);
});

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_TMP_DIR = path.join(DATA_DIR, 'uploads');
ensureDir(UPLOAD_TMP_DIR);

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 10);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 1000);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,

  // v7: provide our own key generator and avoid proxy warnings
  keyGenerator: (req /*, res */) => {
    const xff = req.headers['x-forwarded-for'];
    let ip = '';
    if (typeof xff === 'string' && xff.length) {
      ip = xff.split(',')[0].trim();
    } else {
      ip = (req.ip || '');
    }
    // strip port if present
    ip = ip.replace(/:\d+$/, '');

    // collapse IPv6 to /64 to avoid per-connection keys
    if (ip.includes(':')) {
      const parts = ip.split(':');
      while (parts.length < 8) parts.push('0');
      return parts.slice(0, 4).join(':'); // first 64 bits
    }
    return ip;
  },
});

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(limiter);
app.use(express.json({ limit: '1mb' })); // small JSON payloads
app.use(morgan('tiny'));

// Protect everything behind Basic Auth
app.use(basicAuth);

// Static files (also protected)
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  maxAge: '7d',
  index: ['admin.html', 'item_movement.html', 'non_movement.html', 'department_sales.html', 'vendor_review.html']
}));

// ---- Multer upload (disk to tmp)

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_TMP_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + sanitize(file.originalname))
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(csv|xlsb)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .csv or .xlsb files are allowed'), ok);
  }
});

function osTmpDir() {
  return fs.existsSync('/tmp') ? '/tmp' : path.join(ROOT, 'tmp');
}
function sanitize(name) {
  return name.replace(/[^\w.\- ]+/g, '_');
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function remapRowToCanonical(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    const norm = normalizeHeader(k);
    const canon = CANONICAL_FROM_NORM.get(norm);
    if (canon) out[canon] = v;
  }
  return out;
}

function coerceCentury(d) {
  const y = d.getFullYear();
  if (y >= 100) return d;            // already 4-digit year
  const pivot = (y >= 70) ? 1900 : 2000; // 70–99 -> 19xx, 00–69 -> 20xx (tweak if you want)
  const adj = new Date(d);
  adj.setFullYear(pivot + y);
  return adj;
}

function fillDefaultsToRequired(rec) {
  const out = {};
  for (const key of REQUIRED_HEADERS) {
    let v = rec[key];
    if (v == null) v = '';
    if (NUMERIC_HEADERS.has(key)) v = numberOrZero(v);
    out[key] = v;
  }
  return out;
}

// ---- Constants and helpers

const REQUIRED_HEADERS = [
  "Date", "Item-Code", "Item-Brand", "Item-POS description",
  "Sub-department-Number", "Sub-department-Description",
  "Category-Number", "Category-Description",
  "Vendor-ID", "Vendor-Name", "Transaction-Number",
  "Units-Sum", "Amount-Sum", "Weight/Volume-Sum",
  "Bottom line-Profit", "Bottom line-Margin",
  "Bottom line-Rank", "Bottom line-Ratio",
  "Proportion-Rank", "Proportion-Ratio"
];

// Accept alternate header names from your .xlsb export
const SYNONYMS = new Map([
  ['main code',              'Item-Code'],
  ['pos description',        'Item-POS description'],
  ['totalizer-number',       'Sub-department-Number'],
  ['totalizer-description',  'Sub-department-Description'],
  ['quantity',               'Units-Sum'],
  ['amount',                 'Amount-Sum'],
  ['weight/volume',          'Weight/Volume-Sum'],
  ['category-number',        'Category-Number'],
  ['category-description',   'Category-Description'],
  ['vendor-id',              'Vendor-ID'],
  ['vendor-name',            'Vendor-Name'],
  ['transaction-number',     'Transaction-Number'],
  ['operator validated',     null],
]);

// The smallest set we truly need to ingest a row
const MIN_HEADERS = [
  'Date',
  'Item-Code',
  'Item-POS description',
  'Sub-department-Number',
  'Sub-department-Description',
  'Units-Sum',
  'Amount-Sum',
  'Weight/Volume-Sum'
];

const NUMERIC_HEADERS = new Set([
  'Units-Sum','Amount-Sum','Weight/Volume-Sum',
  'Bottom line-Profit','Bottom line-Margin',
  'Bottom line-Rank','Bottom line-Ratio',
  'Proportion-Rank','Proportion-Ratio',
  'Category-Number','Sub-department-Number'
]);

function normalizeHeader(h) {
  if (!h && h !== 0) return '';
  let s = String(h).trim();
  // strip one level of surrounding quotes (common in exports)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // collapse doubled quotes
  s = s.replace(/^"+|"+$/g, '').trim();
  // normalize weird whitespace & punctuation:
  // NBSP -> space
  s = s.replace(/\u00A0/gu, ' ');
  // all unicode dash/hyphen variants -> ASCII hyphen
  s = s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/gu, '-');
  // smart quotes -> ASCII
  s = s.replace(/[“”]/gu, '"').replace(/[’]/gu, "'");
  // lowercase & collapse whitespace
  s = s.toLowerCase().replace(/\s+/gu, ' ');
  // drop everything except letters/numbers/space/-/./
  s = s.replace(/[^\p{L}\p{N}\s\-\/.]/gu, '');
  return s;
}

// --- tolerant UPC helpers (borrowed/adapted from your other app) ---
function normalizeUPC(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  // 11-digit variable-weight (scanner already removed check digit)
  if (d.length === 11 && d[0] === '2') {
    return ('00' + d.slice(0, 7) + '0000').padStart(13, '0');
  }
  // UPC-A 12 digits → remove *one* check digit (11 significant)
  if (d.length === 12) d = d.slice(0, 11);
  // everything else → left-pad to 13
  return d.padStart(13, '0');
}

function decodeScale(upc) {
  // accept 11 **or** 12 digits and must start with '2'
  if (!/^\d{11,12}$/.test(upc) || upc[0] !== '2') return null;
  const payload = upc.length === 12 ? upc.slice(0, -1) : upc;
  const cat = p => ('00' + p).padEnd(13, '0');
  return {
    // price not used for movement search, but harmless to compute
    price: parseInt(payload.slice(7, 11), 10) / 100,
    catCodes: [cat(payload.slice(0, 7)), cat(payload.slice(0, 6))]
  };
}

// Expand one user-entered token into all plausible DB item_code candidates
function expandUpcCandidates(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return [];
  const out = new Set();

  // A) Your DB canonical form from uploads (digits → pad to 13)
  out.add(pad13(d));

  // B) Leading-zero EAN-13 for UPC-A 12 digits
  if (d.length === 12) out.add(('0' + d).slice(0, 13));

  // C) “drop check-digit then pad” form used by the other app
  if (d.length === 12) out.add(pad13(d.slice(0, 11)));

  // D) Raw 11-digit payload padded (covers already-stripped UPC-A + some scales)
  if (d.length === 11) out.add(pad13(d));

  // E) Variable-weight / scale labels → catalogue codes
  const s = decodeScale(d);
  if (s) s.catCodes.forEach(c => out.add(c));

  return Array.from(out);
}

// map from normalized header back to canonical required name
const CANONICAL_FROM_NORM = (() => {
  const map = new Map();
  for (const req of REQUIRED_HEADERS) {
    map.set(normalizeHeader(req), req);
  }
  for (const [alt, canon] of SYNONYMS) {
    if (!canon) continue; // synonym we intentionally ignore
    map.set(normalizeHeader(alt), canon);
  }
  return map;
})();

const REQUIRED_HEADERS_NORM = REQUIRED_HEADERS.map(normalizeHeader);

function parseDateToISO(v) {
  if (!v) return null;
  const s = String(v).trim();

  const candidates = [
    'yyyy-MM-dd',
    'MM/dd/yyyy','M/d/yyyy','M/d/yy',
    'dd/MM/yyyy','d/M/yyyy','d/M/yy',
    'yyyy/M/d',
    'dd-MMM-yy','dd-MMM-yyyy' // e.g., 05-Jul-24
  ];

  for (const fmt of candidates) {
    const d = parseDateFns(s, fmt, new Date());
    if (isValid(d)) {
      return formatDate(coerceCentury(d), 'yyyy-MM-dd'); // <-- change here
    }
  }

  // Excel serials
  if (!isNaN(Number(s))) {
    const serial = Number(s);
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const ms = excelEpoch.getTime() + serial * 86400000;
    const d = new Date(ms);
    if (isValid(d)) return formatDate(d, 'yyyy-MM-dd');
  }

  return null;
}
function numberOrZero(v) {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).trim()
    .replace(/\s+/g, '')
    .replace(/,/g, '')
    .replace(/%$/, '')          // strip trailing percent
    .replace(/^\((.*)\)$/, '-$1'); // (123.45) -> -123.45
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function canonicalize(row) {
  // Build canonical representation with fixed numeric formatting
  const obj = {
    Date: row.date_iso,
    "Item-Code": row.item_code,
    "Item-Brand": (row.item_brand || '').trim(),
    "Item-POS description": (row.item_pos_desc || '').trim(),
    "Sub-department-Number": String(row.subdept_no ?? 0),
    "Sub-department-Description": (row.subdept_desc || '').trim(),
    "Category-Number": String(row.category_no ?? 0),
    "Category-Description": (row.category_desc || '').trim(),
    "Vendor-ID": (row.vendor_id || '').trim(),
    "Vendor-Name": (row.vendor_name || '').trim(),
    "Transaction-Number": (row.txn_no || '').trim(),
    "Units-Sum": row.units_sum.toFixed(6),
    "Amount-Sum": row.amount_sum.toFixed(6),
    "Weight/Volume-Sum": row.weight_volume_sum.toFixed(6),
    "Bottom line-Profit": row.bl_profit.toFixed(6),
    "Bottom line-Margin": row.bl_margin.toFixed(6),
    "Bottom line-Rank": row.bl_rank.toFixed(6),
    "Bottom line-Ratio": row.bl_ratio.toFixed(6),
    "Proportion-Rank": row.prop_rank.toFixed(6),
    "Proportion-Ratio": row.prop_ratio.toFixed(6)
  };
  return JSON.stringify(obj);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---- Upload parser

async function parseUploadedFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === '.csv') {
    return parseCsv(filePath, originalName);
  } else if (ext === '.xlsb') {
    return parseXlsb(filePath, originalName);
  } else {
    throw new Error('Unsupported file type');
  }
}

function validateHeadersFromRaw(rawObj) {
  const presentCanon = new Set();
  for (const k of Object.keys(rawObj)) {
    const canon = CANONICAL_FROM_NORM.get(normalizeHeader(k));
    if (canon) presentCanon.add(canon);
  }
  const missingAll = REQUIRED_HEADERS.filter(h => !presentCanon.has(h));
  const missingMin = MIN_HEADERS.filter(h => !presentCanon.has(h));
  // We proceed if the minimum set is satisfied.
  return { ok: missingMin.length === 0, missing: missingAll };
}

function debugHeaders(prefix, rawObj) {
  if (!process.env.DEBUG_HEADERS) return;
  const rows = Object.keys(rawObj).map(k => {
    const norm = normalizeHeader(k);
    const canon = CANONICAL_FROM_NORM.get(norm) || '(NO MATCH)';
    return { raw: k, norm, canon };
  });
  console.log(prefix, rows);
}

async function parseCsv(filePath, originalName) {
  const rawRows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csvParse({
        columns: true,
        skip_empty_lines: true,
        bom: true,
        trim: true
      }))
      .on('data', (rec) => rawRows.push(rec))
      .on('end', resolve)
      .on('error', reject);
  });

  if (rawRows.length === 0) return { rows: [], missing: REQUIRED_HEADERS };
  debugHeaders('CSV headers:', rawRows[0]);
  const { ok, missing } = validateHeadersFromRaw(rawRows[0]);
  if (!ok) return { rows: [], missing };

  const rows = rawRows.map(remapRowToCanonical).map(fillDefaultsToRequired);
  return { rows, missing: [] };
}

async function parseXlsb(filePath, originalName) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  const rawRows = XLSX.utils.sheet_to_json(ws, {
    raw: false,
    defval: '',
    header: 0
  });

  if (rawRows.length === 0) return { rows: [], missing: REQUIRED_HEADERS };
  debugHeaders('XLSB headers:', rawRows[0]);
  const { ok, missing } = validateHeadersFromRaw(rawRows[0]);
  if (!ok) return { rows: [], missing };

  const rows = rawRows.map(remapRowToCanonical).map(fillDefaultsToRequired);
  return { rows, missing: [] };
}

async function processUploadJob(filePath, originalName) {
  const started = Date.now();

  // 1) parse
  const parsed = await parseUploadedFile(filePath, originalName);
  if (parsed.missing?.length) {
    const err = new Error('Header validation failed: ' + parsed.missing.join(', '));
    err.code = 'HEADERS';
    throw err;
  }

  // 2) insert
  const countRows = () => db.prepare('SELECT COUNT(*) AS c FROM raw_transactions').get().c;

  let processed = 0;
  const beforeAll = countRows();
  const sampleDates = new Set();
  const subPairs = new Set();
  let batch = [];

  for (const r of parsed.rows) {
    const date_iso = parseDateToISO(r['Date']);
    if (!date_iso) continue;

    const row = {
      date_iso,
      item_code: pad13(r['Item-Code']),
      item_brand: (r['Item-Brand'] || '').trim(),
      item_pos_desc: (r['Item-POS description'] || '').trim(),
      subdept_no: Number.parseInt(r['Sub-department-Number']) || 0,
      subdept_desc: (r['Sub-department-Description'] || '').trim(),
      category_no: Number.parseInt(r['Category-Number']) || 0,
      category_desc: (r['Category-Description'] || '').trim(),
      vendor_id: (r['Vendor-ID'] || '').trim(),
      vendor_name: (r['Vendor-Name'] || '').trim(),
      txn_no: String(r['Transaction-Number'] || '').trim(),
      units_sum: numberOrZero(r['Units-Sum']),
      amount_sum: numberOrZero(r['Amount-Sum']),
      weight_volume_sum: numberOrZero(r['Weight/Volume-Sum']),
      bl_profit: numberOrZero(r['Bottom line-Profit']),
      bl_margin: numberOrZero(r['Bottom line-Margin']),
      bl_rank: numberOrZero(r['Bottom line-Rank']),
      bl_ratio: numberOrZero(r['Bottom line-Ratio']),
      prop_rank: numberOrZero(r['Proportion-Rank']),
      prop_ratio: numberOrZero(r['Proportion-Ratio']),
      source_filename: originalName
    };
    row.content_hash = sha256(canonicalize(row));

    batch.push(row);
    processed++;
    sampleDates.add(date_iso);
    if (row.subdept_no && row.subdept_desc) {
      subPairs.add(`${row.subdept_no}::${row.subdept_desc}`);
    }
    if (batch.length >= BATCH_SIZE) {
      insertManyTxns(batch);
      batch.length = 0;
    }
  }
  if (batch.length) {
    insertManyTxns(batch);
    batch.length = 0;
  }

  if (subPairs.size) {
    const pairs = Array.from(subPairs).map(s => {
      const [no, desc] = s.split('::');
      return [Number(no), desc];
    });
    upsertSubdepartments(pairs);
  }

  const afterAll = countRows();
  const insertedTotal = afterAll - beforeAll;
  const ignored = processed - insertedTotal;

  try {
    insertUploadMeta(originalName, parsed.rows.length, insertedTotal, ignored);
  } catch (e) {
    console.warn('insertUploadMeta failed:', e.message);
  }

  return {
    fileName: originalName,
    rowsParsed: parsed.rows.length,
    inserted: insertedTotal,
    ignored,
    sampleDates: Array.from(sampleDates).sort(),
    elapsedMs: Date.now() - started
  };
}

let workerRunning = false;

function runJobInWorker(job) {
  return new Promise((resolve) => {
    const w = new Worker(new URL('./upload-worker.js', import.meta.url), {
      workerData: { id: job.id, tmp_path: job.tmp_path, original_name: job.original_name }
    });
    w.once('message', (msg) => {
      if (msg && msg.ok) queueMarkDone(job.id, msg.result);
      else queueMarkError(job.id, msg?.error || 'worker failed');
      resolve();
    });
    w.once('error', (err) => {
      queueMarkError(job.id, err?.message || String(err));
      resolve();
    });
    w.once('exit', (code) => {
      // Non-zero exit without 'error' still gets resolved; queueMarkError already called above if needed.
    });
  });
}

async function runWorkerOnce() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (true) {
      const job = queueNextJob();
      if (!job) break;
      queueMarkStarted(job.id);
      await runJobInWorker(job);
      try { fs.unlinkSync(job.tmp_path); } catch {}
    }
  } finally {
    workerRunning = false;
  }
}
// kick on boot and occasionally after enqueue
setImmediate(runWorkerOnce);

// --- helpers (add this back)
function pad13(s) {
  const digits = String(s ?? '').replace(/\D+/g, '');
  return digits.padStart(13, '0');
}

// ---- API routes
// List subdepartments for the UI dropdown
app.get('/api/subdepartments', (req, res) => {
  const rows = querySubdepartments().map(r => ({
    subdept_no: r.subdept_no,
    label: `${r.subdept_no} - ${r.subdept_desc}`
  }));
  res.json(rows);
});

// Brand autocomplete
app.get('/api/brands', (req, res) => {
  const q = String(req.query.q || '').slice(0, 100); // simple guard
  const rows = searchBrands(q); // from db.js
  res.json(rows.map(r => r.brand));
});

// Vendor autocomplete
app.get('/api/vendors', (req, res) => {
  const q = String(req.query.q || '').slice(0, 100); // simple guard
  const rows = searchVendors(q); // from db.js
  // return array of strings (vendor names)
  res.json(rows.map(r => r.vendor));
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Missing file' });

  // Persist a job row in SQLite
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  // Multer already wrote to UPLOAD_TMP_DIR; keep that absolute path
  const job = {
    id,
    original_name: req.file.originalname,
    tmp_path: req.file.path,              // absolute file path
    size_bytes: req.file.size || 0
  };
  queueCreateJob(job);

  // Return 202 + id for polling
  res.status(202).json({ id, status: 'queued' });

  // Nudge the worker
  setImmediate(runWorkerOnce);
});

app.get('/api/upload-status/:id', (req, res) => {
  const row = queueGetJob(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  // Shape for the frontend:
  // { status, result? } for done; { status, error? } for error/processing/queued
  let body = { status: row.status, startedAt: row.started_at, finishedAt: row.finished_at };
  if (row.status === 'done' && row.result_json) {
    body.result = JSON.parse(row.result_json);
  } else if (row.status === 'error' && row.error) {
    body.error = row.error;
  }
  res.json(body);
});

function validateDateRange(q) {
  const start = String(q.start || '').trim();
  const end = String(q.end || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { error: 'start and end are required in YYYY-MM-DD' };
  }
  return { start, end };
}

// ===== Department Sales helpers =====
function toDate(dstr){ const [y,m,d] = dstr.split('-').map(Number); return new Date(y, m-1, d); }
function fmtDate(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; }
function addDays(d, n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }

// Find the last fully-complete week that exists in the DB (Sun–Sat).
// If max date is a Saturday, we use that; otherwise step back to the previous Saturday.
function getLastCompleteWeekEnd() {
  const row = db.prepare("SELECT MAX(date_iso) AS maxDate FROM raw_transactions").get();
  if (!row || !row.maxDate) return null;
  const maxD = toDate(row.maxDate);
  const dow = maxD.getDay(); // 0=Sun ... 6=Sat
  const lastSat = dow === 6 ? maxD : addDays(maxD, -(dow + 1)); // go back to Saturday
  return fmtDate(lastSat);
}

function weekBoundsFromEnd(satStr) {
  const end = toDate(satStr);
  const start = addDays(end, -6);
  return { start: fmtDate(start), end: fmtDate(end) };
}

function sumAmountBetween({ start, end, subdept }) {
  const sqlAll = `
    SELECT SUM(amount_sum) AS total
    FROM raw_transactions
    WHERE date_iso BETWEEN ? AND ?`;
  const sqlDept = `
    SELECT SUM(amount_sum) AS total
    FROM raw_transactions
    WHERE date_iso BETWEEN ? AND ? AND subdept_no = ?`;

  const row = subdept && subdept !== 'all'
    ? db.prepare(sqlDept).get(start, end, Number(subdept))
    : db.prepare(sqlAll).get(start, end);

  return Number(row?.total || 0);
}

function sumAmountByItemBetween({ start, end, subdept, codes }) {
  if (!codes || !codes.length) return new Map();

  const placeholders = codes.map(() => '?').join(',');
  const base = `
    SELECT item_code AS code,
           SUM(amount_sum) AS amount
    FROM raw_transactions
    WHERE date_iso BETWEEN ? AND ?`;
  const deptFilter = (subdept && subdept !== 'all') ? ` AND subdept_no = ?` : '';
  const sql = base + deptFilter + ` AND item_code IN (${placeholders})
    GROUP BY item_code`;

  const params = [start, end];
  if (subdept && subdept !== 'all') {
    params.push(Number(subdept));
  }
  params.push(...codes);

  const rows = db.prepare(sql).all(...params);
  const map = new Map();
  for (const r of rows) {
    map.set(r.code, Number(r.amount || 0));
  }
  return map;
}

function dailySeriesBetween({ start, end, subdept }) {
  const sqlAll = `
    SELECT date_iso AS d, SUM(amount_sum) AS amt
    FROM raw_transactions
    WHERE date_iso BETWEEN ? AND ?
    GROUP BY date_iso`;
  const sqlDept = `
    SELECT date_iso AS d, SUM(amount_sum) AS amt
    FROM raw_transactions
    WHERE date_iso BETWEEN ? AND ? AND subdept_no = ?
    GROUP BY date_iso`;

  const rows = subdept && subdept !== 'all'
    ? db.prepare(sqlDept).all(start, end, Number(subdept))
    : db.prepare(sqlAll).all(start, end);

  const map = new Map(rows.map(r => [r.d, Number(r.amt || 0)]));
  const out = [];
  let cur = toDate(start);
  const endD = toDate(end);
  while (cur <= endD) {
    const k = fmtDate(cur);
    out.push({ date: k, amount: map.get(k) || 0 });
    cur = addDays(cur, 1);
  }
  return out;
}

// Base URL for the shrink service (inventory_app)
// e.g. SHRINK_BASE=http://inventory-shrink.onrender.com
const SHRINK_BASE = process.env.SHRINK_BASE || '';

async function fetchShrinkSummary({ subdept, start, end }) {
  if (!SHRINK_BASE) {
    return { total: 0, items: [] };
  }

  const url = new URL('/api/shrink-summary', SHRINK_BASE);
  url.searchParams.set('from', start);
  url.searchParams.set('to', end);
  if (subdept && subdept !== 'all') {
    url.searchParams.set('subdept', String(subdept));
  }

  const resp = await fetch(url.toString(), { timeout: 15_000 });
  if (!resp.ok) {
    throw new Error(`shrink-summary ${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

// ===== Master Item List (Item List Handler) integration =====
const ITEM_LIST_BASE = process.env.ITEM_LIST_BASE || 'https://item-list-handler.onrender.com';

// node-fetch v2 supports { timeout }. We'll keep conservative timeouts.
const ITEM_LIST_TIMEOUT_MS = Number(process.env.ITEM_LIST_TIMEOUT_MS || 15_000);

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function canon13FromMaster(raw) {
  // Master list canonUPC already yields 13-digit strings;
  // but we must tolerate 12/13/raw and canonicalize to 13 digits like Movement.
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  // If 12 digits: treat as UPC-A and add leading 0, dropping check digit behavior is master-side;
  // for comparisons in Movement, we just need stable 13-digit form.
  // Use your Movement-style pad13 to be consistent.
  return pad13(d.length === 12 ? ('0' + d) : d);
}

function detectMasterCols(sampleRow) {
  const keys = Object.keys(sampleRow || {});
  const pick = (aliases) => {
    const set = new Set(aliases.map(normKey));
    return keys.find(k => set.has(normKey(k)));
  };

  // Try to match the aliases you already use in Item List Handler
  const code = pick(['code','upc','itemcode','maincode','mainitemcode']) || keys[0];
  const brand = pick(['brand','mainitembrand','itembrand','main item-brand','main item brand']);
  const desc = pick([
    'description','desc','mainitemdescription','main item-description','main item description',
    'posdescription','item-posdescription','item-pos description','item-posdescription'
  ]);
  const subNo = pick(['subdepartmentnumber','subdeptnumber','subdepartmentno','subdeptno','totalizer-number','totalizernumber']);
  const subDesc = pick(['subdepartmentdescription','subdepartmentdesc','subdeptdescription','totalizer-description','totalizerdescription']);
  const catNo = pick(['categorynumber','category-no','category-number','catnumber','catno']);
  const catDesc = pick(['categorydescription','category-desc','category-description','catdescription','catdesc']);
  const vendorId = pick(['vendorid','vendor-id','vendor_id']);
  const vendorName = pick(['vendorname','vendor-name','vendor','vendor_name']);

  // NEW: "POS information-Not for sale" (may appear with literal quotes in raw header)
  // normKey('"POS information-Not for sale"') => 'posinformationnotforsale'
  const notForSale = pick(['posinformationnotforsale']);

  return { code, brand, desc, subNo, subDesc, catNo, catDesc, vendorId, vendorName, notForSale };
}

async function fetchJsonWithTimeout(url) {
  const resp = await fetch(url, { timeout: ITEM_LIST_TIMEOUT_MS });
  if (!resp.ok) {
    const t = await resp.text().catch(()=>'');
    throw new Error(`Item List request failed: ${resp.status} ${resp.statusText}${t ? ' - ' + t : ''}`);
  }
  return resp.json();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Fetch ALL master items (paginated) with a narrow column set once detected.
async function fetchAllMasterItems() {
  // 1) probe 1 row to detect columns
  const probeUrl = new URL('/api/items', ITEM_LIST_BASE);
  probeUrl.searchParams.set('page', '1');
  probeUrl.searchParams.set('pageSize', '1');

  const probe = await fetchJsonWithTimeout(probeUrl.toString());
  const probeRow = probe?.rows?.[0];
  if (!probeRow) {
    return { cols: null, rows: [] };
  }

  const cols = detectMasterCols(probeRow);

  // 2) fetch pages with only columns we care about (if present)
  const wanted = Object.values(cols).filter(Boolean);
  const uniqueWanted = Array.from(new Set(wanted));

  const pageSize = Number(process.env.ITEM_LIST_PAGE_SIZE || 2000);
  const firstUrl = new URL('/api/items', ITEM_LIST_BASE);
  firstUrl.searchParams.set('page', '1');
  firstUrl.searchParams.set('pageSize', String(pageSize));
  if (uniqueWanted.length) firstUrl.searchParams.set('columns', uniqueWanted.join(','));

  const first = await fetchJsonWithTimeout(firstUrl.toString());
  const total = Number(first?.total || 0);
  const rows = Array.isArray(first?.rows) ? first.rows.slice() : [];

  const pages = total > 0 ? Math.ceil(total / pageSize) : 1;
  if (pages > 1) {
    // Sequential fetch to be gentle to Render + avoid spikes
    for (let p = 2; p <= pages; p++) {
      const u = new URL('/api/items', ITEM_LIST_BASE);
      u.searchParams.set('page', String(p));
      u.searchParams.set('pageSize', String(pageSize));
      if (uniqueWanted.length) u.searchParams.set('columns', uniqueWanted.join(','));
      const j = await fetchJsonWithTimeout(u.toString());
      if (Array.isArray(j?.rows) && j.rows.length) rows.push(...j.rows);
    }
  }

  return { cols, rows };
}

// Fetch metadata for a UPC universe via /api/bulk-upc (exact matches only)
async function fetchMasterByUpcs(upcList13) {
  const codes = Array.from(new Set(upcList13.filter(Boolean)));
  if (!codes.length) return { cols: null, rows: [] };

  // probe 1 item (via /api/items) to detect cols — bulk-upc returns raw rows, but we need mapping
  const { cols } = await fetchAllMasterItems().catch(() => ({ cols: null }));
  // If that failed, we can still return rows but with minimal mapping
  const useCols = cols || {
    code: null, brand: null, desc: null,
    subNo: null, subDesc: null,
    catNo: null, catDesc: null,
    vendorId: null, vendorName: null,
    notForSale: null
  };

  const CHUNK = Number(process.env.ITEM_LIST_BULK_CHUNK || 300);
  const parts = chunk(codes, CHUNK);

  const rows = [];
  for (const part of parts) {
    const u = new URL('/api/bulk-upc', ITEM_LIST_BASE);
    u.searchParams.set('codes', part.join(','));
    const j = await fetchJsonWithTimeout(u.toString());
    const hits = Array.isArray(j?.results) ? j.results : [];
    if (hits.length) rows.push(...hits);
  }

  return { cols: useCols, rows };
}

// Apply optional brand/vendor filters to master rows when those columns exist.
// Keep it strict-ish: case-insensitive equality after trim.
function filterMasterRows(rows, cols, { brand, vendor, subdept, subdept_start, subdept_end }) {
  let out = rows;

  // NEW: exclude items flagged Not for sale (expect 0/1/blank)
  if (cols?.notForSale) {
    const k = cols.notForSale;
    out = out.filter(r => {
      const v = r?.[k];
      if (v === 1) return false;
      if (v === 0) return true;
      const s = String(v ?? '').trim();
      if (!s) return true;     // blank => keep
      return s !== '1';        // only '1' is excluded
    });
  }

  if (brand && cols?.brand) {
    const b = String(brand).trim().toLowerCase();
    out = out.filter(r => String(r[cols.brand] || '').trim().toLowerCase() === b);
  }
  if (vendor) {
    // Vendor field might be missing in master list; only filter if present.
    const v = String(vendor).trim().toLowerCase();
    const vcol = cols?.vendorName || cols?.vendorId;
    if (vcol) {
      out = out.filter(r => String(r[vcol] || '').trim().toLowerCase() === v);
    }
  }

  // Optional: filter by subdept number if present (but DB subdept filter is the truth for "sales").
  // This just reduces payload for UX consistency.
  const sdCol = cols?.subNo;
  if (sdCol) {
    if (subdept != null && subdept !== '') {
      const sd = Number(subdept);
      if (Number.isFinite(sd)) out = out.filter(r => Number.parseInt(String(r[sdCol] || '0'), 10) === sd);
    } else if (subdept_start != null && subdept_end != null && subdept_start !== '' && subdept_end !== '') {
      const a = Number(subdept_start), b = Number(subdept_end);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        out = out.filter(r => {
          const n = Number.parseInt(String(r[sdCol] || '0'), 10);
          return Number.isFinite(n) && n >= lo && n <= hi;
        });
      }
    }
  }

  return out;
}

function masterRowToMovementShape(r, cols) {
  const codeRaw = cols?.code ? r[cols.code] : '';
  const code13 = canon13FromMaster(codeRaw);

  const brand = cols?.brand ? String(r[cols.brand] ?? '').trim() : '';
  const desc  = cols?.desc  ? String(r[cols.desc] ?? '').trim()  : '';

  const subNo = cols?.subNo ? String(r[cols.subNo] ?? '').trim() : '';
  const subDesc = cols?.subDesc ? String(r[cols.subDesc] ?? '').trim() : '';

  const catNo = cols?.catNo ? String(r[cols.catNo] ?? '').trim() : '';
  const catDesc = cols?.catDesc ? String(r[cols.catDesc] ?? '').trim() : '';

  const vendorId = cols?.vendorId ? String(r[cols.vendorId] ?? '').trim() : '';
  const vendorName = cols?.vendorName ? String(r[cols.vendorName] ?? '').trim() : '';

  return {
    "Item-Code": code13,
    "Item-Brand": brand,
    "Item-POS description": desc,
    "Sub-department-Number": subNo,
    "Sub-department-Description": subDesc,
    "Category-Number": catNo,
    "Category-Description": catDesc,
    "POS information-Not for sale": cols?.notForSale ? (r[cols.notForSale] ?? '') : '',
    "Vendor-ID": vendorId,
    "Vendor-Name": vendorName,
    "Units-Sum": 0,
    "Amount-Sum": 0
  };
}

// ===== Department Sales routes =====

// Meta: last complete week-end (Saturday) and the 5 week ranges we’ll use.
app.get('/api/dept-sales/meta', (_req, res) => {
  const lastWeekEnd = getLastCompleteWeekEnd();
  if (!lastWeekEnd) return res.json({ lastWeekEnd: null, weeks: [] });

  const weeks = [];
  for (let i = 0; i < 5; i++) {
    const sat = fmtDate(addDays(toDate(lastWeekEnd), -7 * i));
    const w = weekBoundsFromEnd(sat);
    weeks.push({ labelEnd: sat, ...w }); // {start,end,labelEnd}
  }
  res.json({ lastWeekEnd, weeks: weeks.reverse() }); // oldest→newest for chart left→right
});

// Weekly totals for last 5 complete weeks (storewide or single subdept),
// PLUS same 5 weeks from the prior year for comparison.
//
// Query: ?subdept=all  OR  ?subdept=###   (omit/empty == all)
app.get('/api/dept-sales/weekly', (req, res) => {
  const subdept = (req.query.subdept || 'all').toString();
  const lastWeekEnd = getLastCompleteWeekEnd();
  if (!lastWeekEnd) {
    return res.json({
      labels: [],
      points: [],
      pointsThis: [],
      pointsLast: [],
      year: null,
      prevYear: null,
      lastWeekEnd: null
    });
  }

  // Last complete Saturday in the data (this year)
  const lastEndThis = toDate(lastWeekEnd);

  // "Same" Saturday 52 weeks earlier (364 days back) for prior year
  const lastEndPrev = addDays(lastEndThis, -364);

  const thisYear = lastEndThis.getFullYear();
  const prevYear = lastEndPrev.getFullYear();

  const labels = [];
  const pointsThis = [];
  const pointsLast = [];

  // Build from oldest → newest (left → right on chart)
  for (let i = 4; i >= 0; i--) {
    // ----- This year week -----
    const satThis = fmtDate(addDays(lastEndThis, -7 * i));   // Saturday
    const { start, end } = weekBoundsFromEnd(satThis);       // Sun–Sat
    labels.push(`${start}–${end}`);
    pointsThis.push(sumAmountBetween({ start, end, subdept }));

    // ----- Last year comparable week (52 weeks earlier) -----
    const satPrev = fmtDate(addDays(lastEndPrev, -7 * i));
    const prevRange = weekBoundsFromEnd(satPrev);
    pointsLast.push(
      sumAmountBetween({
        start: prevRange.start,
        end:   prevRange.end,
        subdept
      })
    );
  }

  // Keep "points" as an alias for this year's data so older UIs don't break.
  res.json({
    labels,
    points: pointsThis,   // backward-compatible
    pointsThis,
    pointsLast,
    year: thisYear,
    prevYear,
    lastWeekEnd
  });
});

// Day-by-day compare: current complete week vs previous week (each Sun–Sat).
// Uses last complete week by default; optional ?end=YYYY-MM-DD to pick a Saturday explicitly.
app.get('/api/dept-sales/compare', (req, res) => {
  const subdept = (req.query.subdept || 'all').toString();
  const explicitEnd = String(req.query.end || '').trim();
  const weekEnd = explicitEnd || getLastCompleteWeekEnd();
  if (!weekEnd) return res.json({ labels: [], current: [], previous: [], weekEnd: null });

  const curW = weekBoundsFromEnd(weekEnd);
  const prevW = weekBoundsFromEnd(fmtDate(addDays(toDate(weekEnd), -7)));

  const cur = dailySeriesBetween({ start: curW.start, end: curW.end, subdept });
  const prev = dailySeriesBetween({ start: prevW.start, end: prevW.end, subdept });

  const labels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const current = cur.map(x => x.amount);
  const previous = prev.map(x => x.amount);

  res.json({ labels, current, previous, weekEnd });
});

// Top 10 items by $ for the last complete week.
// Query: ?subdept=all  OR  ?subdept=###
app.get('/api/dept-sales/top-items', (req, res) => {
  const subdept = (req.query.subdept || 'all').toString();
  const weekEnd = getLastCompleteWeekEnd();
  if (!weekEnd) return res.json({ items: [], range: null });

  const { start, end } = weekBoundsFromEnd(weekEnd);

  const base = `
    SELECT item_code AS code,
           MAX(item_brand) AS brand,
           MAX(item_pos_desc) AS description,
           SUM(amount_sum) AS amount
    FROM raw_transactions
    WHERE date_iso BETWEEN ? AND ?`;
  const group = ` GROUP BY item_code ORDER BY amount DESC LIMIT 10`;

  const rows = (subdept && subdept !== 'all')
    ? db.prepare(base + ` AND subdept_no = ?` + group).all(start, end, Number(subdept))
    : db.prepare(base + group).all(start, end);

  res.json({ items: rows.map(r => ({ ...r, amount: Number(r.amount || 0) })), range: { start, end } });
});

// Top 10 items by units for the last complete week.
// Query: ?subdept=all  OR  ?subdept=###
app.get('/api/dept-sales/top-items-units', (req, res) => {
  const subdept = (req.query.subdept || 'all').toString();
  const weekEnd = getLastCompleteWeekEnd();
  if (!weekEnd) return res.json({ items: [], range: null });

  const { start, end } = weekBoundsFromEnd(weekEnd);

  const base = `
    SELECT item_code AS code,
           MAX(item_brand) AS brand,
           MAX(item_pos_desc) AS description,
           SUM(units_sum) AS units
    FROM raw_transactions
    WHERE date_iso BETWEEN ? AND ?`;
  const group = ` GROUP BY item_code ORDER BY units DESC LIMIT 10`;

  const rows = (subdept && subdept !== 'all')
    ? db.prepare(base + ` AND subdept_no = ?` + group).all(start, end, Number(subdept))
    : db.prepare(base + group).all(start, end);

  res.json({
    items: rows.map(r => ({ ...r, units: Number(r.units || 0) })),
    range: { start, end }
  });
});

// Shrink vs Sales: last week + last 30 days for selected subdept
// GET /api/dept-sales/shrink-metrics?subdept=all|###
//
// Returns:
// {
//   lastWeek: {
//     start, end, sales, shrink, percent, topItems: [...]
//   },
//   last30:   { ... }
// }
app.get('/api/dept-sales/shrink-metrics', async (req, res) => {
  const subdept = (req.query.subdept || 'all').toString();
  const lastWeekEnd = getLastCompleteWeekEnd();
  if (!lastWeekEnd) {
    return res.json({ lastWeek: null, last30: null });
  }

  // Last complete week (Sun–Sat)
  const weekRange = weekBoundsFromEnd(lastWeekEnd); // { start, end }
  const weekStart = weekRange.start;
  const weekEnd   = weekRange.end;

  // Last 30 days ending on that same Saturday
  const end30   = toDate(weekEnd);
  const start30 = fmtDate(addDays(end30, -29)); // include end day → 30 days total

    try {
    const [shrinkWeek, shrink30] = await Promise.all([
      fetchShrinkSummary({ subdept, start: weekStart, end: weekEnd }),
      fetchShrinkSummary({ subdept, start: start30,   end: weekEnd })
    ]);

    const salesWeek = sumAmountBetween({ start: weekStart, end: weekEnd, subdept });
    const sales30   = sumAmountBetween({ start: start30,   end: weekEnd, subdept });

    const pctWeek = salesWeek > 0 ? (shrinkWeek.total / salesWeek) * 100 : 0;
    const pct30   = sales30   > 0 ? (shrink30.total   / sales30)   * 100 : 0;

    // --- NEW: per-item sales + pct of sales ---

    const weekCodes = (shrinkWeek.items || []).map(it => it.code).filter(Boolean);
    const days30Codes = (shrink30.items || []).map(it => it.code).filter(Boolean);

    const weekSalesByItem = sumAmountByItemBetween({
      start: weekStart,
      end:   weekEnd,
      subdept,
      codes: weekCodes
    });

    const days30SalesByItem = sumAmountByItemBetween({
      start: start30,
      end:   weekEnd,
      subdept,
      codes: days30Codes
    });

    const topItemsWeek = (shrinkWeek.items || []).map(it => {
      const sales = weekSalesByItem.get(it.code) || 0;
      const pctOfSales = sales > 0 ? (it.amount / sales) * 100 : null;
      return {
        ...it,
        sales,
        pctOfSales
      };
    });

    const topItems30 = (shrink30.items || []).map(it => {
      const sales = days30SalesByItem.get(it.code) || 0;
      const pctOfSales = sales > 0 ? (it.amount / sales) * 100 : null;
      return {
        ...it,
        sales,
        pctOfSales
      };
    });

    res.json({
      lastWeek: {
        start: weekStart,
        end: weekEnd,
        sales: salesWeek,
        shrink: shrinkWeek.total,
        percent: pctWeek,
        topItems: topItemsWeek
      },
      last30: {
        start: start30,
        end: weekEnd,
        sales: sales30,
        shrink: shrink30.total,
        percent: pct30,
        topItems: topItems30
      }
    });
  } catch (err) {
    console.error('[dept-sales] shrink-metrics failed:', err);
    res.status(500).json({ error: 'shrink-metrics-failed', message: err.message });
  }
});

app.get('/api/range', (req, res) => {
  const vr = validateDateRange(req.query);
  if (vr.error) return res.status(400).json({ error: vr.error });

  const params = {
    start: vr.start,
    end: vr.end
  };

  if (req.query.subdept) params.subdept = Number.parseInt(req.query.subdept);
  if (req.query.subdept_start) params.subdept_start = Number.parseInt(req.query.subdept_start);
  if (req.query.subdept_end) params.subdept_end = Number.parseInt(req.query.subdept_end);
  if (req.query.brand) params.brand = String(req.query.brand).trim();
  if (req.query.vendor) params.vendor = String(req.query.vendor).trim();

  const rows = rangeAggregate(params);
  res.json(rows);
});

// ===== Vendor Review routes =====

// GET /api/vendor-review/vendors?subdept=###&start=YYYY-MM-DD&end=YYYY-MM-DD
app.get('/api/vendor-review/vendors', (req, res) => {
  const vr = validateDateRange(req.query);
  if (vr.error) return res.status(400).json({ error: vr.error });

  const subdept = Number.parseInt(String(req.query.subdept || ''), 10);
  if (!Number.isFinite(subdept)) return res.status(400).json({ error: 'subdept is required (number)' });

  const rows = db.prepare(`
    SELECT
      vendor_name AS vendor,
      SUM(amount_sum) AS amount
    FROM raw_transactions
    WHERE date_iso BETWEEN ? AND ?
      AND subdept_no = ?
      AND vendor_name <> ''
    GROUP BY vendor_name
    ORDER BY amount DESC, vendor COLLATE NOCASE ASC
  `).all(vr.start, vr.end, subdept);

  const vendors = rows.map(r => ({
    vendor: r.vendor,
    amount: Number(r.amount || 0)
  }));

  const totalSales = vendors.reduce((a, v) => a + (v.amount || 0), 0);

  res.json({ vendors, totalSales, range: { start: vr.start, end: vr.end }, subdept });
});


// GET /api/vendor-review/items?subdept=###&vendor=NAME&start=YYYY-MM-DD&end=YYYY-MM-DD
app.get('/api/vendor-review/items', async (req, res) => {
  const vr = validateDateRange(req.query);
  if (vr.error) return res.status(400).json({ error: vr.error });

  const subdept = Number.parseInt(String(req.query.subdept || ''), 10);
  const vendor = String(req.query.vendor || '').trim();
  if (!Number.isFinite(subdept)) return res.status(400).json({ error: 'subdept is required (number)' });
  if (!vendor) return res.status(400).json({ error: 'vendor is required' });

  // Aggregate rows like item_movement, but filtered to subdept + vendor
  const rows = db.prepare(`
    SELECT
      item_code                             AS "Item-Code",
      MAX(item_brand)                       AS "Item-Brand",
      MAX(item_pos_desc)                    AS "Item-POS description",
      MAX(subdept_no)                       AS "Sub-department-Number",
      MAX(subdept_desc)                     AS "Sub-department-Description",
      MAX(category_no)                      AS "Category-Number",
      MAX(category_desc)                    AS "Category-Description",
      MAX(vendor_id)                        AS "Vendor-ID",
      MAX(vendor_name)                      AS "Vendor-Name",
      ROUND(SUM(units_sum), 6)              AS "Units-Sum",
      ROUND(SUM(amount_sum), 2)             AS "Amount-Sum"
    FROM raw_transactions
    WHERE date_iso BETWEEN ? AND ?
      AND subdept_no = ?
      AND vendor_name = ? COLLATE NOCASE
    GROUP BY item_code
    ORDER BY "Amount-Sum" DESC
  `).all(vr.start, vr.end, subdept, vendor);

  // Merge shrink $ per item (from inventory shrink service, if configured)
  let shrinkMap = new Map(); // code -> shrink$
  try {
    const shrink = await fetchShrinkSummary({ subdept: String(subdept), start: vr.start, end: vr.end });
    const items = Array.isArray(shrink?.items) ? shrink.items : [];
    for (const it of items) {
      if (it?.code) shrinkMap.set(String(it.code), Number(it.amount || 0));
    }
  } catch (e) {
    // If shrink service fails, we still return sales rows (shrink defaults to 0)
    console.warn('[vendor-review] shrink fetch failed:', e.message);
  }

  const out = rows.map(r => {
    const code = String(r["Item-Code"] || '');
    const shrink = shrinkMap.get(code) || 0;
    return { ...r, "Shrink ($)": Number(shrink || 0) };
  });

  res.json({ rows: out, range: { start: vr.start, end: vr.end }, subdept, vendor });
});

app.post('/api/search-upcs', (req, res) => {
  const body = req.body || {};
  const vr = validateDateRange(body);
  if (vr.error) return res.status(400).json({ error: vr.error });

  // Build a tolerant candidate set for each token the user supplied
  const rawTokens = Array.isArray(body.upcs)
    ? body.upcs
    : String(body.upcs || '').split(/[\s,;\n]+/);

  const cand = new Set();
  for (const t of rawTokens) {
    for (const c of expandUpcCandidates(t)) cand.add(c);
  }
  const upcList = Array.from(cand);
  if (!upcList.length) return res.json([]);

  const params = {
    start: vr.start,
    end: vr.end
  };
  if (body.subdept) params.subdept = Number.parseInt(body.subdept);
  if (body.subdept_start && body.subdept_end) {
    params.subdept_start = Number.parseInt(body.subdept_start);
    params.subdept_end = Number.parseInt(body.subdept_end);
  }
  if (body.brand) params.brand = String(body.brand).trim();
  if (body.vendor) params.vendor = String(body.vendor).trim();

  const rows = upcsAggregate(params, upcList);
  res.json(rows);
});

app.post('/api/refresh', (req, res) => {
  optimize();
  res.json({ status: 'ok' });
});

app.get('/api/export', (req, res) => {
  // Same filtering logic as /api/range
  const vr = validateDateRange(req.query);
  if (vr.error) return res.status(400).json({ error: vr.error });

  const params = {
    start: vr.start,
    end: vr.end
  };
  if (req.query.subdept) params.subdept = Number.parseInt(req.query.subdept);
  if (req.query.subdept_start) params.subdept_start = Number.parseInt(req.query.subdept_start);
  if (req.query.subdept_end) params.subdept_end = Number.parseInt(req.query.subdept_end);
  if (req.query.brand) params.brand = String(req.query.brand).trim();
  if (req.query.vendor) params.vendor = String(req.query.vendor).trim();

  let rows;
if (req.query.upcs && String(req.query.upcs).trim()) {
  // Accept commas, spaces, or newlines — expand each token like /api/search-upcs
  const rawTokens = String(req.query.upcs).split(/[\s,;\n]+/);
  const cand = new Set();
  for (const t of rawTokens) {
    for (const c of expandUpcCandidates(t)) cand.add(c);
  }
  const upcList = Array.from(cand);
  rows = upcList.length ? upcsAggregate(params, upcList) : [];
} else {
  rows = rangeAggregate(params);
}

  const filename = `item_movement_${vr.start.replace(/-/g,'')}_${vr.end.replace(/-/g,'')}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const csvStream = csvFormat({ headers: true });
  csvStream.pipe(res);
  for (const row of rows) csvStream.write(row);
  csvStream.end();
});

// ===== Non-Movement (Master List items with NO sales in Movement DB) =====

function buildMovementParamsFromQuery(q, { allowUpcList = false } = {}) {
  const vr = validateDateRange(q);
  if (vr.error) return { error: vr.error };

  const params = { start: vr.start, end: vr.end };

  if (q.subdept) params.subdept = Number.parseInt(q.subdept);
  if (q.subdept_start) params.subdept_start = Number.parseInt(q.subdept_start);
  if (q.subdept_end) params.subdept_end = Number.parseInt(q.subdept_end);
  if (q.brand) params.brand = String(q.brand).trim();
  if (q.vendor) params.vendor = String(q.vendor).trim();

  let upcs = [];
  if (allowUpcList && q.upcs && String(q.upcs).trim()) {
    const rawTokens = Array.isArray(q.upcs) ? q.upcs : String(q.upcs).split(/[\s,;\n]+/);
    const cand = new Set();
    for (const t of rawTokens) {
      for (const c of expandUpcCandidates(t)) cand.add(c);
    }
    upcs = Array.from(cand);
  }

  return { params, upcs };
}

async function computeNonMovement({ start, end, subdept, subdept_start, subdept_end, brand, vendor, upcUniverse = null }) {
  // 1) Candidate universe from Master List
  let masterCols = null;
  let masterRows = [];

  if (Array.isArray(upcUniverse) && upcUniverse.length) {
    // UPC list mode: fetch only those from master, via bulk-upc
    const fetched = await fetchMasterByUpcs(upcUniverse);
    masterCols = fetched.cols;
    masterRows = fetched.rows;
  } else {
    const fetched = await fetchAllMasterItems();
    masterCols = fetched.cols;
    masterRows = fetched.rows;
  }

  if (!masterRows || !masterRows.length) {
    // Distinguish "no CSV uploaded" vs "empty result"
    // Item List Handler returns { total:0, rows:[] } if missing CSV.
    // We'll message it clearly.
    return { rows: [], warning: 'Master List is empty or not available (no CSV uploaded to Item List Handler).' };
  }

  // Optional filter candidates by master fields when available (brand/vendor/subdept)
  masterRows = filterMasterRows(masterRows, masterCols, { brand, vendor, subdept, subdept_start, subdept_end });

  // 2) Sold set from Movement DB
  // IMPORTANT: For non-movement, "sold" must mean sold at all in the period,
  // NOT "sold where txn vendor/brand matches" (those fields can be inconsistent).
  // We *do* restrict the query to the candidate UPCs for speed + correctness.

  const movementParams = { start, end };
  if (subdept != null) movementParams.subdept = subdept;
  if (subdept_start != null) movementParams.subdept_start = subdept_start;
  if (subdept_end != null) movementParams.subdept_end = subdept_end;

  // Build candidate universe AFTER master filters (brand/vendor/etc.)
  const candidateCodes = [];
  for (const r of masterRows) {
    const codeRaw = masterCols?.code ? r[masterCols.code] : '';
    const code13 = canon13FromMaster(codeRaw);
    if (code13) candidateCodes.push(code13);
  }

  // If caller provided an explicit UPC universe, intersect it with candidates
  let soldUniverse = candidateCodes;
  if (Array.isArray(upcUniverse) && upcUniverse.length) {
    const u = new Set(upcUniverse);
    soldUniverse = candidateCodes.filter(c => u.has(c));
  }

  const sold = soldCodesInRange(movementParams, soldUniverse);
  const soldSet = new Set((sold || []).map(String));

  // 3) Subtract: master items whose canonical 13-digit code is NOT in sold set
  const out = [];
  for (const r of masterRows) {
    const codeRaw = masterCols?.code ? r[masterCols.code] : '';
    const code13 = canon13FromMaster(codeRaw);
    if (!code13) continue;

    // If UPC universe mode, enforce universe again in case master fetch included extras (shouldn't)
    if (Array.isArray(upcUniverse) && upcUniverse.length) {
      if (!upcUniverse.includes(code13)) continue;
    }

    if (!soldSet.has(code13)) {
      out.push(masterRowToMovementShape(r, masterCols));
    }
  }

  return { rows: out, warning: null };
}

// GET /api/non-movement?start&end&subdept&subdept_start&subdept_end&brand&vendor
app.get('/api/non-movement', async (req, res) => {
  try {
    const vr = validateDateRange(req.query);
    if (vr.error) return res.status(400).json({ error: vr.error });

    const q = req.query || {};
    const params = {
      start: vr.start,
      end: vr.end,
      subdept: q.subdept ? Number.parseInt(q.subdept) : undefined,
      subdept_start: q.subdept_start ? Number.parseInt(q.subdept_start) : undefined,
      subdept_end: q.subdept_end ? Number.parseInt(q.subdept_end) : undefined,
      brand: q.brand ? String(q.brand).trim() : undefined,
      vendor: q.vendor ? String(q.vendor).trim() : undefined
    };

    const { rows, warning } = await computeNonMovement({ ...params, upcUniverse: null });

    // If master list missing, we return 502-ish semantics; you asked for a clear error.
    if (warning && !rows.length) {
      return res.status(502).json({ error: warning });
    }

    res.json(rows);
  } catch (e) {
    console.error('[non-movement] failed:', e);
    res.status(500).json({ error: 'non-movement-failed', message: e.message });
  }
});

// POST /api/non-movement/search-upcs  body: {start,end,filters...,upcs:[...]}
app.post('/api/non-movement/search-upcs', async (req, res) => {
  try {
    const body = req.body || {};
    const vr = validateDateRange(body);
    if (vr.error) return res.status(400).json({ error: vr.error });

    const rawTokens = Array.isArray(body.upcs)
      ? body.upcs
      : String(body.upcs || '').split(/[\s,;\n]+/);

    const cand = new Set();
    for (const t of rawTokens) {
      for (const c of expandUpcCandidates(t)) cand.add(c);
    }
    const upcUniverse = Array.from(cand);
    if (!upcUniverse.length) return res.json([]);

    const params = {
      start: vr.start,
      end: vr.end,
      subdept: body.subdept ? Number.parseInt(body.subdept) : undefined,
      subdept_start: (body.subdept_start != null && body.subdept_start !== '') ? Number.parseInt(body.subdept_start) : undefined,
      subdept_end: (body.subdept_end != null && body.subdept_end !== '') ? Number.parseInt(body.subdept_end) : undefined,
      brand: body.brand ? String(body.brand).trim() : undefined,
      vendor: body.vendor ? String(body.vendor).trim() : undefined
    };

    const { rows, warning } = await computeNonMovement({ ...params, upcUniverse });

    // In UPC-list mode, if master list missing, return clear error
    if (warning && !rows.length) {
      return res.status(502).json({ error: warning });
    }

    res.json(rows);
  } catch (e) {
    console.error('[non-movement] search-upcs failed:', e);
    res.status(500).json({ error: 'non-movement-failed', message: e.message });
  }
});

// GET /api/non-movement/export?... (+ optional upcs=...)
app.get('/api/non-movement/export', async (req, res) => {
  try {
    const { params, upcs, error } = buildMovementParamsFromQuery(req.query, { allowUpcList: true });
    if (error) return res.status(400).json({ error });

    const { rows, warning } = await computeNonMovement({
      ...params,
      upcUniverse: upcs?.length ? upcs : null
    });

    if (warning && !rows.length) {
      return res.status(502).json({ error: warning });
    }

    const filename = `non_movement_${params.start.replace(/-/g,'')}_${params.end.replace(/-/g,'')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const csvStream = csvFormat({ headers: true });
    csvStream.pipe(res);
    for (const row of rows) csvStream.write(row);
    csvStream.end();
  } catch (e) {
    console.error('[non-movement] export failed:', e);
    res.status(500).json({ error: 'non-movement-export-failed', message: e.message });
  }
});

// debug remove later
app.get('/api/debug/stats', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS c FROM raw_transactions').get().c;
  const recent = db.prepare(`
    SELECT date_iso, subdept_no, COUNT(*) c
    FROM raw_transactions
    GROUP BY date_iso, subdept_no
    ORDER BY date_iso DESC, subdept_no
    LIMIT 20
  `).all();
  res.json({ count, recent });
});

// debug remove later
app.get('/api/_debug_counts', (req, res) => {
  const raw = db.prepare('SELECT COUNT(*) c FROM raw_transactions').get().c;
  const subs = db.prepare('SELECT COUNT(*) c FROM subdepartments').get().c;
  res.json({ raw, subdepartments: subs });
});

// debug remove later
app.get('/api/debug/storage', (req, res) => {
  try {
    const dblist = db.prepare("PRAGMA database_list").all();
    const rowCount = db.prepare("SELECT COUNT(*) AS c FROM raw_transactions").get().c;
    const range = db.prepare("SELECT MIN(date_iso) AS minDate, MAX(date_iso) AS maxDate FROM raw_transactions").get();
    res.json({
      env_DATA_DIR: process.env.DATA_DIR || null,
      cwd: process.cwd(),
      dbFileConstant: /* same value used in db.js */ undefined, // see note below
      database_list: dblist, // shows the absolute path SQLite is using
      rowCount,
      minDate: range.minDate || null,
      maxDate: range.maxDate || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/summary', (req, res) => {
  const rowCount = db.prepare('SELECT COUNT(*) AS c FROM raw_transactions').get().c;
  const range = db.prepare('SELECT MIN(date_iso) AS minDate, MAX(date_iso) AS maxDate FROM raw_transactions').get();
  const last = db.prepare(`
    SELECT file_name, uploaded_at, rows_parsed, inserted, ignored
    FROM uploads_meta
    ORDER BY uploaded_at DESC
    LIMIT 1
  `).get();

  res.json({
    rowCount,
    minDate: range.minDate || null,
    maxDate: range.maxDate || null,
    lastUpload: last || null
  });
});

// List recent uploads (history)
app.get('/api/admin/uploads', (req, res) => {
  const rows = db.prepare(`
    SELECT file_name, uploaded_at, rows_parsed, inserted, ignored
    FROM uploads_meta
    ORDER BY uploaded_at DESC
    LIMIT 50
  `).all();
  res.json(rows);
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.message && /only \.csv or \.xlsb/i.test(err.message)) {
    return res.status(400).json({ error: err.message });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large. Max ${MAX_UPLOAD_MB} MB.` });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
