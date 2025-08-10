import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import morgan from 'morgan';
import crypto from 'crypto';
import { parse as csvParse } from 'csv-parse';
import { format as csvFormat } from '@fast-csv/format';
import * as XLSX from 'xlsx/xlsx.mjs';
// wire node fs for readFile / writeFile in the ESM build
XLSX.set_fs(fs);
import { parse as parseDateFns, format as formatDate, isValid } from 'date-fns';

import { basicAuth } from './auth.js';
import {
  db, insertManyTxns, upsertSubdepartments,
  querySubdepartments, rangeAggregate, upcsAggregate, optimize,
  insertUploadMeta
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
  index: ['admin.html', 'item_movement.html']
}));

// ---- Multer upload (disk to tmp)

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
  const dir = osTmpDir();
  ensureDir(dir);
  cb(null, dir);
},
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
  "Vendor-ID", "Vendor-Name",
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
  ['transaction-number',     null],
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

function pad13(s) {
  const digits = String(s ?? '').replace(/\D+/g, '');
  return digits.padStart(13, '0');
}

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

// ---- API routes

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const started = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Missing file' });

  let parsed;
  try {
    console.time('parseUploadedFile');                  // <-- add
    parsed = await parseUploadedFile(req.file.path, req.file.originalname);
    console.timeEnd('parseUploadedFile');               // <-- add
  } catch (err) {
    console.error('UPLOAD FAILED while parsing:', err);
    const payload = { error: 'Upload failed during parse', message: err.message };
    if (process.env.NODE_ENV !== 'production' && err.stack) {
      payload.stack = err.stack.split('\n').slice(0, 10);
    }
    return res.status(500).json(payload);
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
  }

  if (parsed.missing?.length) {
    return res.status(400).json({
      error: 'Header validation failed',
      missingHeaders: parsed.missing
    });
  }

  try {
  const countRows = () => db.prepare('SELECT COUNT(*) AS c FROM raw_transactions').get().c;

  let processed = 0;
  const beforeAll = countRows();
  const sampleDates = new Set();
  const subPairs = new Set();
  let batch = [];

  console.log('[upload] rows to process:', parsed.rows.length); // <-- add

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
      units_sum: numberOrZero(r['Units-Sum']),
      amount_sum: numberOrZero(r['Amount-Sum']),
      weight_volume_sum: numberOrZero(r['Weight/Volume-Sum']),
      bl_profit: numberOrZero(r['Bottom line-Profit']),
      bl_margin: numberOrZero(r['Bottom line-Margin']),
      bl_rank: numberOrZero(r['Bottom line-Rank']),
      bl_ratio: numberOrZero(r['Bottom line-Ratio']),
      prop_rank: numberOrZero(r['Proportion-Rank']),
      prop_ratio: numberOrZero(r['Proportion-Ratio']),
      source_filename: req.file.originalname
    };

    row.content_hash = sha256(canonicalize(row));

    batch.push(row);
    processed++;
    sampleDates.add(date_iso);
    if (row.subdept_no && row.subdept_desc) {
      subPairs.add(`${row.subdept_no}::${row.subdept_desc}`);
    }

    if (batch.length >= BATCH_SIZE) {
      console.log('[upload] inserting batch of', batch.length);
        insertManyTxns(batch);   // transaction inside helper
      batch.length = 0;              // clear without realloc
    }
  }

  if (batch.length) {
      console.log('[upload] inserting final batch of', batch.length); // <-- log last batch
      insertManyTxns(batch);
      batch.length = 0;
    }

  // upsert subdepartments (de-duped)
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

  // Record upload stats in uploads_meta table
  try {
    insertUploadMeta(req.file.originalname, parsed.rows.length, insertedTotal, ignored);
  } catch (e) {
    console.warn('insertUploadMeta failed:', e.message);
  }

  return res.json({
    fileName: req.file.originalname,
    rowsParsed: parsed.rows.length,
    inserted: insertedTotal,
    ignored,
    sampleDates: Array.from(sampleDates).sort(),
    elapsedMs: Date.now() - started
  });
    
} catch (err) {
  console.error('UPLOAD FAILED during DB insert:', err);
  const payload = { error: 'Upload failed during insert', message: err.message };
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    payload.stack = err.stack.split('\n').slice(0, 10);
  }
  return res.status(500).json(payload);
}
});

app.get('/api/subdepartments', (req, res) => {
  const rows = querySubdepartments().map(r => ({
    subdept_no: r.subdept_no,
    label: `${r.subdept_no} - ${r.subdept_desc}`
  }));
  res.json(rows);
});

function validateDateRange(q) {
  const start = String(q.start || '').trim();
  const end = String(q.end || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { error: 'start and end are required in YYYY-MM-DD' };
  }
  return { start, end };
}

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

  const rows = rangeAggregate(params);
  res.json(rows);
});

app.post('/api/search-upcs', (req, res) => {
  const body = req.body || {};
  const vr = validateDateRange(body);
  if (vr.error) return res.status(400).json({ error: vr.error });

  const upcsRaw = Array.isArray(body.upcs) ? body.upcs : [];
  const upcList = upcsRaw.map(pad13).filter(Boolean);
  if (upcList.length === 0) return res.json([]);

  const params = {
    start: vr.start,
    end: vr.end
  };
  if (body.subdept) params.subdept = Number.parseInt(body.subdept);
  if (body.subdept_start && body.subdept_end) {
    params.subdept_start = Number.parseInt(body.subdept_start);
    params.subdept_end = Number.parseInt(body.subdept_end);
  }

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

  const rows = (req.query.upcs && String(req.query.upcs).trim())
    ? upcsAggregate(params, String(req.query.upcs).split(',').map(s => s.trim()).map(pad13))
    : rangeAggregate(params);

  const filename = `item_movement_${vr.start.replace(/-/g,'')}_${vr.end.replace(/-/g,'')}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const csvStream = csvFormat({ headers: true });
  csvStream.pipe(res);
  for (const row of rows) csvStream.write(row);
  csvStream.end();
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
