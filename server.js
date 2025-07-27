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
  querySubdepartments, rangeAggregate, upcsAggregate, optimize
} from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 10);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
});

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

// Normalize header cell text: trim, drop wrapping quotes / smart quotes, collapse spaces, lowercase
function normalizeHeader(s) {
  return String(s ?? '')
    .trim()
    .replace(/^['"`“”]+|['"`“”]+$/g, '')   // strip surrounding quotes
    .replace(/\s+/g, ' ')                  // collapse interior whitespace
    .toLowerCase();
}

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
    'MM/dd/yyyy',
    'M/d/yyyy',
    'M/d/yy',
    'yyyy/M/d'
  ];

  for (const fmt of candidates) {
    const d = parseDateFns(s, fmt, new Date());
    if (isValid(d)) return formatDate(d, 'yyyy-MM-dd');
  }

  // Excel serials?
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
  const n = Number(String(v).replace(/,/g, '')); // in case of thousand separators
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

function validateHeaders(obj) {
  const seenNorm = new Set(Object.keys(obj).map(normalizeHeader));
  const missing = [];

  for (let i = 0; i < REQUIRED_HEADERS.length; i++) {
    const wantNorm = REQUIRED_HEADERS_NORM[i];
    if (!seenNorm.has(wantNorm)) missing.push(REQUIRED_HEADERS[i]);
  }

  return { ok: missing.length === 0, missing };
}

function normalizeRowsToRequired(rows) {
  return rows.map(r => {
    const out = {};
    // Build a lookup from normalized header -> original key
    const keyMap = {};
    for (const k of Object.keys(r)) keyMap[normalizeHeader(k)] = k;

    for (let i = 0; i < REQUIRED_HEADERS.length; i++) {
      const wanted = REQUIRED_HEADERS[i];
      const nk = REQUIRED_HEADERS_NORM[i];
      const srcKey = keyMap[nk];
      out[wanted] = srcKey ? r[srcKey] : '';
    }
    return out;
  });
}

async function parseCsv(filePath, originalName) {
  const rows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csvParse({
        columns: true,
        skip_empty_lines: true,
        bom: true,
        trim: true
      }))
      .on('data', (rec) => rows.push(rec))
      .on('end', resolve)
      .on('error', reject);
  });

  if (rows.length === 0) return { rows: [], missing: REQUIRED_HEADERS };

  const { ok, missing } = validateHeaders(rows[0]);
if (!ok) return { rows: [], missing };

return { rows: normalizeRowsToRequired(rows), missing: [] };

async function parseXlsb(filePath, originalName) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  const rows = XLSX.utils.sheet_to_json(ws, {
    raw: false,
    defval: '',
    header: 0
  });

  if (rows.length === 0) return { rows: [], missing: REQUIRED_HEADERS };

  const { ok, missing } = validateHeaders(rows[0]);
if (!ok) return { rows: [], missing };

return { rows: normalizeRowsToRequired(rows), missing: [] };

// ---- API routes

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const started = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Missing file' });

  let parsed;
  try {
    parsed = await parseUploadedFile(req.file.path, req.file.originalname);
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
    const rows = parsed.rows;
    const prepared = [];
    const sampleDates = new Set();

    for (const r of rows) {
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
      prepared.push(row);
      sampleDates.add(date_iso);
    }

    const before = db.prepare('SELECT COUNT(*) AS c FROM raw_transactions').get().c;
    insertManyTxns(prepared);
    const after = db.prepare('SELECT COUNT(*) AS c FROM raw_transactions').get().c;

    // sync subdepartments
    const subPairs = [];
    for (const r of prepared) {
      if (r.subdept_no && r.subdept_desc) subPairs.push([r.subdept_no, r.subdept_desc]);
    }
    if (subPairs.length) upsertSubdepartments(subPairs);

    const elapsedMs = Date.now() - started;

    return res.json({
      fileName: req.file.originalname,
      rowsParsed: parsed.rows.length,
      inserted: after - before,
      ignored: prepared.length - (after - before),
      sampleDates: Array.from(sampleDates).sort(),
      elapsedMs
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
