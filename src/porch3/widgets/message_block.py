"""Styled message block with sender color, mentions, threads, images."""

from __future__ import annotations

from pathlib import Path

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import Label, Static

from porch3.constants import DEFAULT_OWNER_ACCENT, IMAGE_MAX_ROWS
from porch3.images import (
    ImageValidationError,
    display_body,
    find_candidate_paths,
    is_spool_path,
    prepare_thumbnail,
)
from porch3.mentions import body_mentions_owner, highlight_mentions
from porch3.sanitize import sanitize_display
from porch3.store import (
    clean_message_body,
    fmt_time,
    reply_preview_line,
    sender_label,
)
from porch3.verify import verified_owner, verify_badge
from porch3.wire import DEFAULT_WIRE, WireFormat


def _try_image_widget(prepared, name: str):
    """Mount-side widget for an ALREADY-BOUNDED prepared thumbnail.

    Never hand this a path: textual-image's PixelData copies/converts its
    input synchronously on the UI thread, so the input must be the bounded
    thumbnail from prepare_thumbnail, decoded off-thread.
    """
    try:
        from textual_image.widget import Image

        return Image(prepared, classes="inline-image")
    except Exception:
        return Label(
            Text(f"[image: {sanitize_display(name)}]"),
            classes="inline-image-fallback",
            markup=False,
        )


class MessageBlock(Vertical):
    """One chat message as a visually distinct speaker block."""

    DEFAULT_CSS = """
    MessageBlock {
        height: auto;
        margin: 0 0 1 0;
        padding: 0 1;
        border-left: wide $primary;
    }
    MessageBlock.owner-mention {
        background: $primary 20%;
    }
    MessageBlock.bounce-missed {
        background: #3a1a00 40%;
        border-left: wide #FF8C00;
    }
    MessageBlock .msg-header {
        height: auto;
        text-style: bold;
    }
    MessageBlock .msg-time {
        color: $text-muted;
        text-style: none;
    }
    MessageBlock .msg-reply {
        color: $text-muted;
        text-style: italic;
        height: auto;
    }
    MessageBlock .msg-body {
        height: auto;
        margin: 0 0 0 1;
    }
    MessageBlock .inline-image {
        height: 15;
        width: auto;
        max-width: 100%;
        margin: 1 0;
    }
    MessageBlock .inline-image-fallback {
        color: $text-muted;
        height: auto;
    }
    MessageBlock .img-deferred {
        color: $text-muted;
        height: auto;
        margin: 0 0 0 1;
    }
    MessageBlock .day-sep {
        color: $text-muted;
        height: auto;
        margin: 1 0;
    }
    """

    def __init__(
        self,
        msg: dict,
        *,
        color: str,
        owner_room: str,
        by_id: dict[str, dict] | None = None,
        show_day: str | None = None,
        bounce: bool = False,
        dr_index: dict[str, tuple[str, str]] | None = None,
        own_ids: set[str] | None = None,
        wire: WireFormat | None = None,
        owner_accent: str = DEFAULT_OWNER_ACCENT,
        rooms: frozenset[str] | None = None,
        **kwargs,
    ) -> None:
        classes = kwargs.pop("classes", "")
        extra = []
        if bounce:
            extra.append("bounce-missed")
        if body_mentions_owner(msg, owner_room, rooms):
            extra.append("owner-mention")
        if classes:
            extra.append(classes)
        super().__init__(classes=" ".join(extra) if extra else None, **kwargs)
        self.msg = msg
        self.owner_accent = owner_accent
        self.rooms = rooms
        # Owner sender uses the configured accent, not the theme palette.
        self.color = (
            owner_accent if msg.get("from") == owner_room else color
        )
        self.owner_room = owner_room
        self.wire = wire if wire is not None else DEFAULT_WIRE
        self.by_id = by_id or {}
        # Shared by reference with MessageList._dr_index; header re-renders
        # (refresh_verify_badge) pick up state changes without reconstruction.
        self.dr_index = dr_index if dr_index is not None else {}
        self.show_day = show_day
        self.bounce = bounce
        self._revealed_foreign: set[str] = set()
        self._spool_pending: list[Path] = []
        # Spool privileges (compact [image N] display, auto-rendered
        # thumbnail) belong to OUR sends only: a foreign body naming a local
        # spool file must not wear the owner's own pasted image. The `from`
        # field is a spoofable heuristic (cs-c0d); trust only unspoofable
        # proof — a message THIS porch session emitted, or a signature the
        # verify cache positively confirmed as the owner's.
        self._own = msg["id"] in (own_ids or set()) or verified_owner(
            msg, wire=self.wire
        )
        self.styles.border_left = ("wide", self.color)

    def compose(self) -> ComposeResult:
        if self.show_day:
            yield Label(
                Text(f"── {sanitize_display(self.show_day)} ──"),
                classes="day-sep",
                markup=False,
            )
        if self.bounce:
            yield Label(
                Text("unseen before yours lands"),
                classes="msg-reply",
                markup=False,
            )

        yield Static(self._header_text(), classes="msg-header", id="msg-header")

        reply = reply_preview_line(self.msg, self.by_id)
        if reply:
            yield Label(Text(reply), classes="msg-reply", markup=False)

        body = clean_message_body(self.msg, wire=self.wire)
        # Spool paths display as [image N]; candidate extraction below still
        # sees the real paths in `body`.
        yield Static(
            highlight_mentions(
                display_body(body, own=self._own),
                owner_room=self.owner_room,
                owner_accent=self.owner_accent,
                rooms=self.rooms,
            ),
            classes="msg-body",
        )

        # Trust boundary: candidates are extracted lexically (no file access).
        # NOTHING decodes on the UI thread — spool paths auto-prepare in a
        # worker (bounded thumbnail), foreign paths get a deferred label with
        # ZERO file access until ctrl+r schedules the same worker path.
        self._spool_pending = []
        for path in find_candidate_paths(body):
            if self._own and is_spool_path(path):
                self._spool_pending.append(path)
                yield Label(
                    Text(f"📷 {sanitize_display(path.name)} · loading…"),
                    classes="img-loading",
                    markup=False,
                )
            else:
                tip = Text(
                    f"📷 {sanitize_display(path.name)} · ctrl+r to render"
                )
                yield Label(tip, classes="img-deferred", markup=False)

    def on_mount(self) -> None:
        for path in self._spool_pending:
            self.app.run_worker(
                lambda p=path: self._prepare_and_mount(p, auto=True),
                thread=True,
                exclusive=False,
            )
        self._spool_pending = []

    def _header_text(self) -> Text:
        header = Text()
        header.append(f"{fmt_time(self.msg['sent'])}  ", style="dim")
        header.append(sender_label(self.msg), style=f"bold {self.color}")
        badge = verify_badge(self.msg, wire=self.wire)
        if badge:
            header.append(badge, style="dim" if "…" in badge else None)
        entry = self.dr_index.get(self.msg["id"])
        if entry:
            from porch3.drstore import badge_for

            header.append(badge_for(entry[1]), style="bold yellow")
        return header

    def refresh_verify_badge(self) -> None:
        """Re-read VERIFY_CACHE and update the already-mounted header."""
        try:
            header = self.query_one("#msg-header", Static)
        except Exception:
            return
        header.update(self._header_text())

    def reveal_foreign_images(self) -> int:
        """Schedule validation+render of deferred foreign images.

        Explicit ctrl+r is the ONLY path that opens a foreign file, and the
        validation/decode runs in a thread worker — never on the UI thread.
        Returns the number of candidates scheduled.
        """
        body = clean_message_body(self.msg, wire=self.wire)
        scheduled = 0
        for path in find_candidate_paths(body):
            if self._own and is_spool_path(path):
                # Own spool paths already auto-rendered at mount; foreign
                # bodies' spool references are deferred like any other
                # foreign path and revealed here.
                continue
            key = str(path)
            if key in self._revealed_foreign:
                continue
            self._revealed_foreign.add(key)
            self.app.run_worker(
                lambda p=path: self._prepare_and_mount(p, auto=False),
                thread=True,
                exclusive=False,
            )
            scheduled += 1
        for deferred in list(self.query(".img-deferred")):
            deferred.remove()
        return scheduled

    def _prepare_and_mount(self, path: Path, *, auto: bool) -> None:
        """Thread worker: validate + fully decode + downsample off the UI
        thread. Only the bounded thumbnail ever crosses to the UI thread."""
        try:
            prepared = prepare_thumbnail(path)
        except ImageValidationError as exc:
            self.app.call_from_thread(self._mount_reveal_failure, path, str(exc))
            return
        except Exception as exc:  # decoder surprises must not strand the label
            self.app.call_from_thread(
                self._mount_reveal_failure, path, f"decode failed: {exc}"
            )
            return
        self.app.call_from_thread(self._mount_prepared, prepared, path.name)

    def _mount_prepared(self, prepared, name: str) -> None:
        for loading in list(self.query(".img-loading")):
            loading.remove()
        img = _try_image_widget(prepared, name)
        if hasattr(img, "styles"):
            img.styles.max_height = IMAGE_MAX_ROWS
        self.mount(img)

    def _mount_reveal_failure(self, path: Path, reason: str) -> None:
        for loading in list(self.query(".img-loading")):
            loading.remove()
        self.mount(
            Label(
                Text(f"📷 {sanitize_display(path.name)} · {sanitize_display(reason)}"),
                classes="img-deferred",
                markup=False,
            )
        )
