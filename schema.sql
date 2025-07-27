PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS raw_transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date_iso          TEXT NOT NULL,
  item_code         TEXT NOT NULL,
  item_brand        TEXT,
  item_pos_desc     TEXT,
  subdept_no        INTEGER,
  subdept_desc      TEXT,
  category_no       INTEGER,
  category_desc     TEXT,
  vendor_id         TEXT,
  vendor_name       TEXT,
  units_sum         REAL,
  amount_sum        REAL,
  weight_volume_sum REAL,
  bl_profit         REAL,
  bl_margin         REAL,
  bl_rank           REAL,
  bl_ratio          REAL,
  prop_rank         REAL,
  prop_ratio        REAL,
  source_filename   TEXT,
  content_hash      TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_txn_date        ON raw_transactions(date_iso);
CREATE INDEX IF NOT EXISTS idx_txn_item        ON raw_transactions(item_code);
CREATE INDEX IF NOT EXISTS idx_txn_subdept     ON raw_transactions(subdept_no);
CREATE INDEX IF NOT EXISTS idx_txn_date_item   ON raw_transactions(date_iso, item_code);
CREATE INDEX IF NOT EXISTS idx_txn_date_sub    ON raw_transactions(date_iso, subdept_no);

CREATE TABLE IF NOT EXISTS subdepartments (
  subdept_no    INTEGER PRIMARY KEY,
  subdept_desc  TEXT NOT NULL
);
