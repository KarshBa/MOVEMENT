import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const ROOT = process.cwd();
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'sales.db');
const SCHEMA_FILE = path.join(ROOT, 'schema.sql');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_FILE, { fileMustExist: false });

const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
db.exec(schemaSql);
try { db.exec(`ALTER TABLE raw_transactions ADD COLUMN txn_no TEXT`); } catch {}
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -20000'); // ~20MB
// Ensure meta table and unique index exist even if schema.sql didn’t add them
db.exec(`
  CREATE TABLE IF NOT EXISTS uploads_meta (
    id INTEGER PRIMARY KEY,
    file_name     TEXT NOT NULL,
    uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
    rows_parsed   INTEGER NOT NULL,
    inserted      INTEGER NOT NULL,
    ignored       INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS ux_raw_content_hash
    ON raw_transactions(content_hash);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS ix_raw_brand ON raw_transactions(item_brand COLLATE NOCASE);
`);

console.log('[DB]', 'DATA_DIR=', DATA_DIR, 'DB_FILE=', DB_FILE);

// --- prepared statements
const stmtInsertUploadMeta = db.prepare(`
  INSERT INTO uploads_meta (file_name, rows_parsed, inserted, ignored)
  VALUES (?, ?, ?, ?)
`);
export function insertUploadMeta(fileName, rowsParsed, inserted, ignored) {
  stmtInsertUploadMeta.run(fileName, rowsParsed, inserted, ignored);
}

export const stmtInsertTxn = db.prepare(`
  INSERT OR IGNORE INTO raw_transactions (
    date_iso, item_code, item_brand, item_pos_desc,
    subdept_no, subdept_desc, category_no, category_desc,
    vendor_id, vendor_name, txn_no, units_sum, amount_sum, weight_volume_sum,
    bl_profit, bl_margin, bl_rank, bl_ratio, prop_rank, prop_ratio,
    source_filename, content_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

export const insertManyTxns = db.transaction((rows) => {
  for (const r of rows) stmtInsertTxn.run(
    r.date_iso, r.item_code, r.item_brand, r.item_pos_desc,
    r.subdept_no, r.subdept_desc, r.category_no, r.category_desc,
    r.vendor_id, r.vendor_name, r.txn_no, r.units_sum, r.amount_sum, r.weight_volume_sum,
    r.bl_profit, r.bl_margin, r.bl_rank, r.bl_ratio, r.prop_rank, r.prop_ratio,
    r.source_filename, r.content_hash
  );
});

export const stmtUpsertSubdept = db.prepare(`
  INSERT INTO subdepartments (subdept_no, subdept_desc)
  VALUES (?, ?)
  ON CONFLICT(subdept_no) DO UPDATE SET subdept_desc=excluded.subdept_desc
`);

export const upsertSubdepartments = db.transaction((pairs) => {
  for (const [no, desc] of pairs) stmtUpsertSubdept.run(no, desc);
});

// --- query builders

export function querySubdepartments() {
  return db.prepare(`SELECT subdept_no, subdept_desc FROM subdepartments ORDER BY subdept_no ASC`).all();
}

function buildSelectAggBase() {
  return `
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
    WHERE date_iso BETWEEN @start AND @end
  `;
}

function buildWhereForSubdept(params, where) {
  if (params.subdept != null) {
    where.push(`subdept_no = @subdept`);
  } else if (params.subdept_start != null && params.subdept_end != null) {
    where.push(`subdept_no BETWEEN @subdept_start AND @subdept_end`);
  }
}

export function searchBrands(q) {
  // Return up to 20 brands matching q (case-insensitive), ordered by popularity
  const pat = `%${String(q || '').trim().replace(/[%_]/g, s => '\\' + s)}%`;
  return db.prepare(`
    SELECT item_brand AS brand, COUNT(*) AS cnt
    FROM raw_transactions
    WHERE item_brand <> '' AND item_brand LIKE @pat ESCAPE '\\'
    GROUP BY item_brand
    ORDER BY cnt DESC, brand COLLATE NOCASE ASC
    LIMIT 20
  `).all({ pat });
}

export function rangeAggregate(params) {
  const base = buildSelectAggBase();
  const where = [];
  buildWhereForSubdept(params, where);
  const sql = [
    base,
    where.length ? 'AND ' + where.join(' AND ') : '',
    `GROUP BY item_code`,
    `ORDER BY "Amount-Sum" DESC`
  ].join('\n');

  return db.prepare(sql).all(params);
}

export function upcsAggregate(params, upcList) {
  const base = buildSelectAggBase();
  const where = [];
  buildWhereForSubdept(params, where);

  // Dynamic placeholders for IN (...)
  const placeholders = upcList.map((_, i) => `@upc${i}`).join(',');
  const bindings = {};
  upcList.forEach((v, i) => { bindings[`upc${i}`] = v; });

  const sql = [
    base,
    `AND item_code IN (${placeholders})`,
    where.length ? 'AND ' + where.join(' AND ') : '',
    `GROUP BY item_code`,
    `ORDER BY "Amount-Sum" DESC`
  ].join('\n');

  return db.prepare(sql).all({ ...params, ...bindings });
}

export function optimize() {
  db.pragma('analysis_limit=400');
  db.exec('PRAGMA optimize; ANALYZE;');
  // Generally avoid VACUUM during heavy use; allow caller to decide.
  try { db.exec('VACUUM;'); } catch { /* ignore if busy */ }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS upload_jobs (
    id            TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    tmp_path      TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL CHECK(status IN ('queued','processing','done','error')),
    result_json   TEXT,
    error         TEXT,
    queued_at     TEXT NOT NULL DEFAULT (datetime('now')),
    started_at    TEXT,
    finished_at   TEXT
  )
`);

// ---- durable queue: upload_jobs
const stmtCreateJob = db.prepare(`
  INSERT INTO upload_jobs (id, original_name, tmp_path, size_bytes, status)
  VALUES (@id, @original_name, @tmp_path, @size_bytes, 'queued')
`);
const stmtStartJob = db.prepare(`
  UPDATE upload_jobs
  SET status='processing', started_at=datetime('now'), error=NULL
  WHERE id=@id AND status IN ('queued','processing')
`);
const stmtFinishJob = db.prepare(`
  UPDATE upload_jobs
  SET status='done', finished_at=datetime('now'), result_json=@result_json
  WHERE id=@id
`);
const stmtFailJob = db.prepare(`
  UPDATE upload_jobs
  SET status='error', finished_at=datetime('now'), error=@error
  WHERE id=@id
`);
const stmtGetJob = db.prepare(`SELECT * FROM upload_jobs WHERE id=?`);
const stmtNextJob = db.prepare(`
  SELECT * FROM upload_jobs
  WHERE status='queued'
  ORDER BY queued_at ASC
  LIMIT 1
`);

export function queueCreateJob(job) { stmtCreateJob.run(job); }
export function queueMarkStarted(id) { stmtStartJob.run({ id }); }
export function queueMarkDone(id, result) {
  stmtFinishJob.run({ id, result_json: JSON.stringify(result) });
}
export function queueMarkError(id, err) {
  const msg = (err?.stack || err?.message || String(err)).slice(0, 4000);
  stmtFailJob.run({ id, error: msg });
}
export function queueGetJob(id) { return stmtGetJob.get(id); }
export function queueNextJob() { return stmtNextJob.get(); }
