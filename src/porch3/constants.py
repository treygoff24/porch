"""Shared product paths and timing constants for porch3.

Identity (owner room, keys, mail root, marker) lives in ``PorchConfig`` —
this module keeps only product-named paths and neutral theme defaults.
"""

from pathlib import Path

# Single source of truth for the default accent lives on PorchConfig
# (porch3.config); re-exported here so existing `from porch3.constants
# import DEFAULT_OWNER_ACCENT` call sites keep working without a second
# hardcoded literal to drift out of sync.
from porch3.config import DEFAULT_OWNER_ACCENT

VERIFY_CACHE_PATH = Path.home() / ".cache" / "porch" / "verify-cache.json"
THEME_PATH = Path.home() / ".config" / "porch" / "theme.json"
IMAGE_SPOOL_DIR = Path.home() / ".cache" / "porch" / "spool"
POLL_S = 1.5
CHANNEL_POLL_S = 5.0
PRESENCE_POLL_S = 5.0
SCROLL_STEP = 3
COMPOSER_MAX_LINES = 8
IMAGE_MAX_ROWS = 15
IMAGE_MAX_BYTES = 5 * 1024 * 1024
IMAGE_MAX_PIXELS = 40_000_000
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}

# Synthetic example roster — never this machine's real rooms / canary names.
DEFAULT_THEME = {
    "senders": {
        "mara": "#FFD700",
        "quill": "#FF4F00",
        "river": "#E34234",
        "oak": "#2DD4BF",
        "nest": "#e6c06a",
        "kite": "#7DD3FC",
    }
}

# Fallback palette for unknown senders (hex for Textual CSS).
# Source of truth for the mobile client is the theme HTTP payload; app.js
# keeps only a minimal boot copy of this list.
FALLBACK_PALETTE = [
    "#22c55e",  # green
    "#eab308",  # yellow
    "#3b82f6",  # blue
    "#d946ef",  # magenta
    "#06b6d4",  # cyan
    "#f8fafc",  # white
]