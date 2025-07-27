# sales-repo-service

A small production-ready Node.js/Express service for managing grocery sales uploads and running item movement aggregations with CSV export.

- **Auth**: All routes (including static HTML) protected by HTTP Basic Auth using `ADMIN_USER` / `ADMIN_PASS`.
- **Persistence**: Single-file SQLite using `better-sqlite3`, stored under `DATA_DIR` (defaults to `./data`).
- **Uploads**: Accepts `.csv` and `.xlsb`, parses with `csv-parse` and `xlsx`, validates exact headers, normalizes fields, and deduplicates rows using a SHA‑256 content hash computed from a canonicalized row.
- **Frontend**: Minimal vanilla JS using the provided `style.css`.
- **Security**: Helmet headers and rate limiting.

## Quick start

```bash
git clone <this-repo> sales-repo-service
cd sales-repo-service
cp .env.example .env
# edit .env and set ADMIN_USER / ADMIN_PASS
npm i
npm start
# open http://localhost:3000/admin.html (browser will prompt for Basic Auth)
