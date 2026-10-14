---
name: ppt-master
description: >
  Upstream fixture skill for the sync detect layer: version and description are
  deliberately newer than vendor-tree so classifyChanges has controlled diffs.
metadata:
  version: "6.8.0"
  copyright: "Copyright (c) 2025-2026 Hugo He"
  license: "MIT"
  official_repository: "https://github.com/hugohe3/ppt-master"
  sponsors:
    - "SPONSORS.md"
    - "SPONSORS_CN.md"
---

# Fixture PPT Master

Upstream copy of the fixture skill. The body intentionally differs from
vendor-tree's copy so the 🟢 regular-content path has a file to observe.

1. Read this file.
2. Run `python3 "${SKILL_DIR}/scripts/attribution_guard.py"`.
3. Read [workflows/routing.md](workflows/routing.md).
4. Copy `.env.example` to `.env` before running the scripts.

See [SPONSORS.md](SPONSORS.md) for attribution.
