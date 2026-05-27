"""Verify artist name reconstruction: for tags that exist at the target epoch,
their names are rolled back via artist_versions + aliases."""
from __future__ import annotations
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from pathlib import Path
from tagdb.updater import reconstruct_as_of

SRC = Path("dist/danbooru_2026-05-26.sqlite")
OUT_DIR = Path("dist/recon_test")
OUT_DIR.mkdir(parents=True, exist_ok=True)

import sqlite3, json

# Find artists whose tags exist early AND have renames
def find_good_artists():
    """Find artists with: tag created before 2015, artist_versions has 3+ names."""
    src = sqlite3.connect(str(SRC))
    src.row_factory = sqlite3.Row

    # Get all artist_ids with 3+ DISTINCT names
    rows = src.execute("""
        SELECT artist_id, GROUP_CONCAT(name, '|') as names, COUNT(DISTINCT name) as dc
        FROM artist_versions GROUP BY artist_id HAVING dc >= 3
    """).fetchall()

    good = []
    for r in rows:
        names = r["names"].split("|")
        # Check if ANY of these names is in tags with created_at before 2018
        for n in names:
            tag = src.execute(
                "SELECT name, created_at, post_count FROM tags WHERE name=? AND category=1", (n,)
            ).fetchone()
            if tag and tag["created_at"] < 1514764800:  # before 2018
                # Get full timeline
                timeline = src.execute("""
                    SELECT name, created_at FROM artist_versions
                    WHERE artist_id=? ORDER BY created_at
                """, (r["artist_id"],)).fetchall()
                good.append({
                    "aid": r["artist_id"],
                    "tag_name": tag["name"],
                    "tag_created": tag["created_at"],
                    "posts": tag["post_count"],
                    "timeline": [(t["name"], t["created_at"]) for t in timeline],
                })
                break
    src.close()
    return good[:10]

def search_recon(conn, q):
    return conn.execute(
        "SELECT name, category, post_count FROM tags WHERE name LIKE ?",
        (f"%{q}%",)
    ).fetchall()

def alias_for(conn, name, old_name):
    """Check if old_name is an alias pointing to name."""
    return conn.execute(
        "SELECT alias, canonical FROM aliases WHERE canonical=? AND alias=?",
        (name, old_name)
    ).fetchone()

def translations_for(conn, name):
    row = conn.execute(
        "SELECT text FROM translations WHERE tag=? AND lang='artist'", (name,)
    ).fetchone()
    return row[0].split(" ") if row and row[0] else []

print("=" * 76)
print("ARTIST TIME-MACHINE RECONSTRUCTION VERIFICATION")
print("=" * 76)

artists = find_good_artists()
print(f"Found {len(artists)} artists with tag created <2018 and 3+ renames:")
for a in artists:
    names = [n for n, _ in a["timeline"]]
    ts = [t for _, t in a["timeline"]]
    print(f"  [{a['aid']}] tag='{a['tag_name']}' ({a['posts']}p) created {ts[0]}")
    print(f"       timeline: {names}")

if not artists:
    print("No suitable artists found — using hardcoded set")
    artists = [
        {"aid": 5385, "tag_name": "murata_range", "tag_created": 1255693992, "posts": 986,
         "timeline": [("range_murata", 1255693992), ("murata_renji", 1281552309), ("murata_range", 1614153918)]},
        {"aid": 4311, "tag_name": "fuuki_(te_fuukin)", "tag_created": 1472649724, "posts": 192,
         "timeline": [("村枝賢一", 1255693962), ("fuuki_(nicoseiga)", 1387096903), ("fuuki_(te_fuukin)", 1472649812)]},
        {"aid": 4396, "tag_name": "azuuru", "tag_created": 1489075801, "posts": 537,
         "timeline": [("西又", 1255693965), ("azuuru_(azure0608)", 1400352222), ("azuuru", 1498805966)]},
    ]

print(f"\nTesting {len(artists)} artists at 4 time points...")

for date_label, epoch in [
    ("2012-01-01", 1325376000),
    ("2017-01-01", 1483228800),
    ("2022-01-01", 1640995200),
    ("2025-01-01", 1735689600),
]:
    out = OUT_DIR / f"recon_{date_label}.sqlite"
    if out.exists(): out.unlink()
    result = reconstruct_as_of(SRC, epoch, out)
    conn = sqlite3.connect(str(out))
    conn.row_factory = sqlite3.Row

    print(f"\n  [{date_label}] {result['tags']:,} tags")
    for a in artists:
        # Expected name at this epoch
        exp = None
        for n, t in a["timeline"]:
            if t <= epoch:
                exp = n
            else:
                break
        if exp is None: continue

        # Check if tag exists in recon DB
        tag = conn.execute("SELECT name FROM tags WHERE name=?", (exp,)).fetchone()
        if tag:
            actual = tag["name"]
            ok = "OK" if actual == exp else "MISMATCH"
            # Check aliases: old names should be aliases
            aliases_found = []
            for n, _ in a["timeline"]:
                if n != actual:
                    al = alias_for(conn, actual, n)
                    if al:
                        aliases_found.append(n)
            # Translations (artist other_names)
            trs = translations_for(conn, actual)
            tr_str = " ".join(trs[:3]) + ("..." if len(trs) > 3 else "") if trs else "—"

            print(f"    [{a['aid']}] {ok}: '{actual}' | aliases: {aliases_found or '—'} | tr: {tr_str}")
        else:
            # Check if any chain name exists
            found = None
            for n, _ in reversed(a["timeline"]):
                t = conn.execute("SELECT name FROM tags WHERE name=?", (n,)).fetchone()
                if t: found = t["name"]; break
            if found:
                print(f"    [{a['aid']}] FOUND '{found}' (exp '{exp}' — tag created after epoch)")
            else:
                print(f"    [{a['aid']}] MISSING (tag created after epoch, no old entry)")

    conn.close()

print(f"\n{'='*76}")
print("DONE")
