// upload-lib.js
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parse as csvParse } from 'csv-parse';
import * as XLSX from 'xlsx/xlsx.mjs';
import { parse as parseDateFns, format as formatDate, isValid } from 'date-fns';
import {
  db, insertManyTxns, upsertSubdepartments, insertUploadMeta
} from './db.js';

XLSX.set_fs(fs);

// ---- constants & header maps (copy from server.js)
const REQUIRED_HEADERS = [ "Date","Item-Code","Item-Brand","Item-POS description","Sub-department-Number","Sub-department-Description","Category-Number","Category-Description","Vendor-ID","Vendor-Name","Units-Sum","Amount-Sum","Weight/Volume-Sum","Bottom line-Profit","Bottom line-Margin","Bottom line-Rank","Bottom line-Ratio","Proportion-Rank","Proportion-Ratio" ];
const SYNONYMS = new Map([
  ['main code','Item-Code'],['pos description','Item-POS description'],['totalizer-number','Sub-department-Number'],['totalizer-description','Sub-department-Description'],['quantity','Units-Sum'],['amount','Amount-Sum'],['weight/volume','Weight/Volume-Sum'],['category-number','Category-Number'],['category-description','Category-Description'],['vendor-id','Vendor-ID'],['vendor-name','Vendor-Name'],['transaction-number',null],['operator validated',null],
]);
const MIN_HEADERS = ['Date','Item-Code','Item-POS description','Sub-department-Number','Sub-department-Description','Units-Sum','Amount-Sum','Weight/Volume-Sum'];
const NUMERIC_HEADERS = new Set(['Units-Sum','Amount-Sum','Weight/Volume-Sum','Bottom line-Profit','Bottom line-Margin','Bottom line-Rank','Bottom line-Ratio','Proportion-Rank','Proportion-Ratio','Category-Number','Sub-department-Number']);

function normalizeHeader(h) {
  if (!h && h !== 0) return '';
  let s = String(h).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1,-1).trim();
  s = s.replace(/^"+|"+$/g,'').trim();
  s = s.replace(/\u00A0/gu,' ');
  s = s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/gu,'-');
  s = s.replace(/[“”]/gu,'"').replace(/[’]/gu,"'");
  s = s.toLowerCase().replace(/\s+/gu,' ');
  s = s.replace(/[^\p{L}\p{N}\s\-\/.]/gu,'');
  return s;
}
const CANONICAL_FROM_NORM = (() => {
  const map = new Map();
  for (const req of REQUIRED_HEADERS) map.set(normalizeHeader(req), req);
  for (const [alt, canon] of SYNONYMS) { if (canon) map.set(normalizeHeader(alt), canon); }
  return map;
})();

function pad13(s) { const digits = String(s ?? '').replace(/\D+/g,''); return digits.padStart(13,'0'); }
function numberOrZero(v) {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).trim().replace(/\s+/g,'').replace(/,/g,'').replace(/%$/,'').replace(/^\((.*)\)$/,'-$1');
  const n = Number(s); return Number.isFinite(n) ? n : 0;
}
function coerceCentury(d) {
  const y = d.getFullYear(); if (y >= 100) return d;
  const pivot = (y >= 70) ? 1900 : 2000; const adj = new Date(d); adj.setFullYear(pivot + y); return adj;
}
function parseDateToISO(v) {
  if (!v) return null; const s = String(v).trim();
  const candidates = ['yyyy-MM-dd','MM/dd/yyyy','M/d/yyyy','M/d/yy','dd/MM/yyyy','d/M/yyyy','d/M/yy','yyyy/M/d','dd-MMM-yy','dd-MMM-yyyy'];
  for (const fmt of candidates) { const d = parseDateFns(s, fmt, new Date()); if (isValid(d)) return formatDate(coerceCentury(d),'yyyy-MM-dd'); }
  if (!isNaN(Number(s))) { const serial = Number(s); const excelEpoch = new Date(Date.UTC(1899,11,30)); const ms = excelEpoch.getTime() + serial*86400000; const d = new Date(ms); if (isValid(d)) return formatDate(d,'yyyy-MM-dd'); }
  return null;
}
function remapRowToCanonical(rec) {
  const out = {}; for (const [k,v] of Object.entries(rec)) { const norm = normalizeHeader(k); const canon = CANONICAL_FROM_NORM.get(norm); if (canon) out[canon] = v; }
  return out;
}
function fillDefaultsToRequired(rec) {
  const out = {}; for (const key of REQUIRED_HEADERS) { let v = rec[key]; if (v == null) v = ''; if (NUMERIC_HEADERS.has(key)) v = numberOrZero(v); out[key] = v; }
  return out;
}
function canonicalize(row) {
  const obj = {
    Date: row.date_iso, "Item-Code": row.item_code, "Item-Brand": (row.item_brand||'').trim(),
    "Item-POS description": (row.item_pos_desc||'').trim(),
    "Sub-department-Number": String(row.subdept_no ?? 0),
    "Sub-department-Description": (row.subdept_desc||'').trim(),
    "Category-Number": String(row.category_no ?? 0),
    "Category-Description": (row.category_desc||'').trim(),
    "Vendor-ID": (row.vendor_id||'').trim(), "Vendor-Name": (row.vendor_name||'').trim(),
    "Units-Sum": row.units_sum.toFixed(6), "Amount-Sum": row.amount_sum.toFixed(6),
    "Weight/Volume-Sum": row.weight_volume_sum.toFixed(6),
    "Bottom line-Profit": row.bl_profit.toFixed(6), "Bottom line-Margin": row.bl_margin.toFixed(6),
    "Bottom line-Rank": row.bl_rank.toFixed(6), "Bottom line-Ratio": row.bl_ratio.toFixed(6),
    "Proportion-Rank": row.prop_rank.toFixed(6), "Proportion-Ratio": row.prop_ratio.toFixed(6)
  };
  return JSON.stringify(obj);
}
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function validateHeadersFromRaw(rawObj) {
  const presentCanon = new Set(); for (const k of Object.keys(rawObj)) { const canon = CANONICAL_FROM_NORM.get(normalizeHeader(k)); if (canon) presentCanon.add(canon); }
  const missingAll = REQUIRED_HEADERS.filter(h => !presentCanon.has(h));
  const missingMin = MIN_HEADERS.filter(h => !presentCanon.has(h));
  return { ok: missingMin.length === 0, missing: missingAll };
}

async function parseCsv(filePath) {
  const rawRows = [];
  await new Promise((resolve,reject)=>{
    fs.createReadStream(filePath).pipe(csvParse({ columns:true, skip_empty_lines:true, bom:true, trim:true }))
      .on('data',(rec)=>rawRows.push(rec)).on('end',resolve).on('error',reject);
  });
  if (rawRows.length === 0) return { rows: [], missing: REQUIRED_HEADERS };
  const { ok, missing } = validateHeadersFromRaw(rawRows[0]); if (!ok) return { rows: [], missing };
  const rows = rawRows.map(remapRowToCanonical).map(fillDefaultsToRequired);
  return { rows, missing: [] };
}

async function parseXlsb(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates:false });
  const sheetName = wb.SheetNames[0]; const ws = wb.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(ws, { raw:false, defval:'', header:0 });
  if (rawRows.length === 0) return { rows: [], missing: REQUIRED_HEADERS };
  const { ok, missing } = validateHeadersFromRaw(rawRows[0]); if (!ok) return { rows: [], missing };
  const rows = rawRows.map(remapRowToCanonical).map(fillDefaultsToRequired);
  return { rows, missing: [] };
}

async function parseUploadedFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === '.csv') return parseCsv(filePath);
  if (ext === '.xlsb') return parseXlsb(filePath);
  throw new Error('Unsupported file type');
}

export async function processUploadJob(filePath, originalName) {
  const started = Date.now();
  const parsed = await parseUploadedFile(filePath, originalName);
  if (parsed.missing?.length) {
    const err = new Error('Header validation failed: ' + parsed.missing.join(', '));
    err.code = 'HEADERS'; throw err;
  }

  const countRows = () => db.prepare('SELECT COUNT(*) AS c FROM raw_transactions').get().c;
  let processed = 0; const beforeAll = countRows();
  const sampleDates = new Set(); const subPairs = new Set(); let batch = [];

  for (const r of parsed.rows) {
    const date_iso = parseDateToISO(r['Date']); if (!date_iso) continue;
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
      source_filename: originalName
    };
    row.content_hash = sha256(canonicalize(row));
    batch.push(row); processed++; sampleDates.add(date_iso);
    if (row.subdept_no && row.subdept_desc) subPairs.add(`${row.subdept_no}::${row.subdept_desc}`);
    if (batch.length >= 1000) { insertManyTxns(batch); batch.length = 0; }
  }
  if (batch.length) { insertManyTxns(batch); batch.length = 0; }

  if (subPairs.size) {
    const pairs = Array.from(subPairs).map(s => { const [no, desc] = s.split('::'); return [Number(no), desc]; });
    upsertSubdepartments(pairs);
  }

  const afterAll = countRows(); const insertedTotal = afterAll - beforeAll; const ignored = processed - insertedTotal;
  try { insertUploadMeta(originalName, parsed.rows.length, insertedTotal, ignored); } catch {}

  return {
    fileName: originalName,
    rowsParsed: parsed.rows.length,
    inserted: insertedTotal,
    ignored,
    sampleDates: Array.from(sampleDates).sort(),
    elapsedMs: Date.now() - started
  };
}
