// upload-worker.js
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'fs';
import * as XLSX from 'xlsx/xlsx.mjs';
XLSX.set_fs(fs);

// import the helpers you already have:
import { db, insertManyTxns, upsertSubdepartments, insertUploadMeta } from './db.js';
import { /* copy or import */ parseUploadedFile, processUploadJob } from './upload-lib.js';

// If you kept processUploadJob in server.js, move it (and its tiny helpers) to a new shared module
// so it can be imported here without pulling in the Express app.

(async () => {
  const { tmp_path, original_name } = workerData;
  try {
    const result = await processUploadJob(tmp_path, original_name);
    parentPort.postMessage({ ok: true, result });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e?.message || String(e) });
  }
})();
