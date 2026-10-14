#!/usr/bin/env python3
"""Fixture placeholder guard - NOT the real upstream attribution guard.

verify-plugin.mjs parses every expected value it checks (LICENSE digest,
exact metadata values, required metadata fields, attribution files, gate
files, and the SKILL.md gate marker) from THIS file inside the verified
tree (spec §6 ①② source logic: expectations come from the tree itself,
never hardcoded upstream values). This placeholder is deliberately not
executable guard logic; only the literals below matter.
"""

_LICENSE_DIGEST = "d277531d50833ed39cac5e65e614317fcd548a1c6151bde6ef8d226a2ddd70c9"

_EXACT_METADATA_VALUES = {
    "copyright": '"Copyright (c) 2025-2026 Hugo He"',
    "license": '"MIT"',
    "official_repository": '"https://github.com/hugohe3/ppt-master"',
}

_REQUIRED_METADATA_FIELDS = ("sponsors",)
_REQUIRED_ATTRIBUTION_FILES = ("LICENSE", "SPONSORS.md", "SPONSORS_CN.md")
_REQUIRED_GATE_FILES = (
    "scripts/console_encoding.py",
    "scripts/project_manager.py",
    "scripts/project_management/cli.py",
    "scripts/svg_quality_checker.py",
    "scripts/svg_quality/cli.py",
    "scripts/svg_to_pptx.py",
    "scripts/svg_to_pptx/pptx_package/cli.py",
    "scripts/register_template.py",
    "scripts/template_preview_pptx.py",
)
_SKILL_GATE_MARKER = 'python3 "${SKILL_DIR}/scripts/attribution_guard.py"'
