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

// --- prepared statements

export const stmtInsertTxn = db.prepare(`
  INSERT OR IGNORE INTO raw_transactions (
    date_iso, item_code, item_brand, item_pos_desc,
    subdept_no, subdept_desc, category_no, category_desc,
    vendor_id, vendor_name, units_sum, amount_sum, weight_volume_sum,
    bl_profit, bl_margin, bl_rank, bl_ratio, prop_rank, prop_ratio,
    source_filename, content_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

export const insertManyTxns = db.transaction((rows) => {
  for (const r of rows) stmtInsertTxn.run(
    r.date_iso, r.item_code, r.item_brand, r.item_pos_desc,
    r.subdept_no, r.subdept_desc, r.category_no, r.category_desc,
    r.vendor_id, r.vendor_name, r.units_sum, r.amount_sum, r.weight_volume_sum,
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
