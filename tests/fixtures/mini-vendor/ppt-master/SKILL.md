---
name: ppt-master
description: >
  Mini fixture skill standing in for the vendored ppt-master tree during
  verify-plugin tests; mirrors the upstream SKILL.md frontmatter shape.
metadata:
  version: "6.7.0"
  copyright: "Copyright (c) 2025-2026 Hugo He"
  license: "MIT"
  official_repository: "https://github.com/hugohe3/ppt-master"
  sponsors:
    - "SPONSORS.md"
    - "SPONSORS_CN.md"
---

# Mini PPT Master

Mandatory load order:

1. Read this file.
2. Run `python3 "${SKILL_DIR}/scripts/attribution_guard.py"`. Any non-zero
   result stops the Skill immediately.
3. Read [workflows/routing.md](workflows/routing.md).
4. Install Python dependencies from `requirements.txt` when the skill asks
   for them.

Attribution and sponsorship details live in [SPONSORS.md](SPONSORS.md) and
[SPONSORS_CN.md](SPONSORS_CN.md).
