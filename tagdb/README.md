# Tag Database

Danbooru tag autocomplete. For user documentation, see the [main README](../README.md#tag-database-autocomplete).

## Architecture

```
tagdb/                     ← Package code (committed to git)
├── official_manifest.json ← Prebuilt dataset manifest

tagdb_data/                ← Runtime data (gitignored)
├── tagdb.sqlite           ← Working DB (mutable)
├── settings.json          ← Danbooru credentials
└── snapshots/
    ├── official/          ← Read-only copies from GitHub Release
    └── local/             ← Backups and reconstruction snapshots
```

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/xyz/tagdb/search?q=&limit=` | Tag autocomplete |
| GET | `/xyz/tagdb/related?q=&limit=&max_age_days=` | Related tags |
| GET | `/xyz/tagdb/artist_posts?name=&limit=` | Artist posts |
| GET | `/xyz/tagdb/tag_preview?name=&limit=` | Tag preview images |
| GET | `/xyz/tagdb/preview_image?url=` | Proxy CDN images |
| GET | `/xyz/tagdb/snapshots` | List snapshots |
| GET / POST | `/xyz/tagdb/snapshots/active` | Get/set active snapshot |
| POST | `/xyz/tagdb/snapshots/export` | Export working DB |
| DELETE | `/xyz/tagdb/snapshots` | Delete a snapshot file |
| GET / POST | `/xyz/tagdb/settings` | Danbooru credentials |
| GET | `/xyz/tagdb/official/check` | Check for updates |
| POST | `/xyz/tagdb/official/download` | Download prebuilt dataset |
| POST | `/xyz/tagdb/maintain` | Start maintenance (full / incremental) |
| GET | `/xyz/tagdb/maintain/status` | Maintenance progress |
| POST | `/xyz/tagdb/maintain/cancel` | Cancel maintenance |
| POST | `/xyz/tagdb/reconstruct` | Time-machine reconstruction |

## Building Datasets

Author-only CLI:

```bash
python -m tagdb.build_dataset --full --min-post-count 50 --with-versions --with-artists --zip \
    --login myuser --api-key abc123
```

Outputs `.sqlite` + `.zip` to `dist/` and prints a manifest entry.

## Maintainer Reference

- `db.py` — SQLite schema + FTS5 index
- `scraper.py` — Danbooru API client (curl_cffi for Cloudflare)
- `updater.py` — Full/incremental update + reconstruction logic
- `distribution.py` — Prebuilt dataset download/verify/seed
- `repo.py` — Search and data access
- `routes.py` — HTTP API

See the project root `CLAUDE.md` for detailed architecture notes.

[中文版 (Chinese)](README_zh.md)
