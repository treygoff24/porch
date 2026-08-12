"""Scrollable message list with viewport-hold on scroll-up."""

from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import Label

from porch3.config import DEFAULT_OWNER_ACCENT
from porch3.store import fmt_day, index_by_id
from porch3.sanitize import sanitize_display
from porch3.theme import SenderTheme
from porch3.wire import DEFAULT_WIRE, WireFormat
from porch3.widgets.message_block import MessageBlock


class MessageList(VerticalScroll):
    """Renders messages; anchored to the bottom unless the user scrolls up."""

    DEFAULT_CSS = """
    MessageList {
        height: 1fr;
        scrollbar-gutter: stable;
    }
    MessageList .channel-header {
        height: auto;
        margin: 0 0 1 0;
        color: $text-muted;
        text-style: italic;
    }
    MessageList .empty-hint {
        color: $text-muted;
        margin: 2 1;
    }
    """

    def __init__(
        self,
        theme: SenderTheme | None = None,
        *,
        owner_room: str = "owner",
        owner_accent: str = DEFAULT_OWNER_ACCENT,
        wire: WireFormat | None = None,
        rooms: frozenset[str] | None = None,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self.theme = theme or SenderTheme()
        self.owner_room = owner_room
        self.owner_accent = owner_accent
        self.wire = wire if wire is not None else DEFAULT_WIRE
        self.rooms = rooms
        self._msgs: list[dict] = []
        self._channel = ""
        self._description = ""
        self._blocks_by_id: dict[str, MessageBlock] = {}
        # anchor message id -> (dr id, state); blocks hold this dict by
        # reference, so set_dr_index mutates in place and refreshes headers.
        self._dr_index: dict[str, tuple[str, str]] = {}
        # Message ids THIS porch session emitted — the unspoofable "own"
        # signal for spool-render privileges (cs-c0d). Populated by the app
        # on each successful send; passed to blocks by reference.
        self._own_ids: set[str] = set()

    def on_mount(self) -> None:
        # Textual's anchor owns bottom-follow: pinned while content mounts,
        # released by a user scroll-up, re-armed by Widget._check_anchor when
        # the user returns to the bottom. Replaces a homegrown _hold_viewport
        # heuristic that could latch mid-layout while a tall message mounted
        # and park the viewport between messages until restart.
        self.anchor()

    def set_channel_header(self, channel: str, description: str = "") -> None:
        self._channel = channel
        self._description = description or ""

    def set_messages(self, msgs: list[dict]) -> None:
        self._msgs = list(msgs)
        # Clear synchronously, not inside the deferred _rebuild: a ctrl+r in
        # the pump gap between now and the rebuild must not be able to
        # reveal a foreign image from the channel the user just left.
        self._blocks_by_id.clear()
        # Rebuild on the message pump so remove/mount ordering can be awaited.
        self.call_next(self._rebuild)

    def append_messages(self, fresh: list[dict]) -> None:
        if not fresh:
            return
        by_id = index_by_id(self._msgs)
        last_day = fmt_day(self._msgs[-1]["sent"]) if self._msgs else None
        self._msgs.extend(fresh)
        blocks: list[MessageBlock] = []
        for m in fresh:
            by_id[m["id"]] = m
            day = fmt_day(m["sent"])
            show_day = day if day != last_day else None
            last_day = day
            block = MessageBlock(
                m,
                color=self.theme.color(m["from"]),
                owner_room=self.owner_room,
                by_id=by_id,
                show_day=show_day,
                dr_index=self._dr_index,
                own_ids=self._own_ids,
                wire=self.wire,
                owner_accent=self.owner_accent,
                rooms=self.rooms,
            )
            self._blocks_by_id[m["id"]] = block
            blocks.append(block)
        # ONE awaited mount on the message pump: per-block un-awaited mounts
        # let two blocks' composed children interleave on screen (seen live
        # header A / header B / body A, body B never rendered).
        self.call_next(self._mount_appended, blocks)
        # No explicit scroll: the anchor keeps the viewport pinned to the
        # bottom unless the user has scrolled up (anchor released).

    async def _mount_appended(self, blocks: list[MessageBlock]) -> None:
        # A rebuild queued behind us re-renders these same messages; mount a
        # block only while it is still the registered one for its id.
        live = [b for b in blocks if self._blocks_by_id.get(b.msg["id"]) is b]
        if live:
            await self.mount(*live)

    def set_dr_index(self, index: dict[str, tuple[str, str]]) -> None:
        stale = set(self._dr_index) | set(index)
        self._dr_index.clear()
        self._dr_index.update(index)
        for mid in stale:
            block = self._blocks_by_id.get(mid)
            if block is not None:
                block.refresh_verify_badge()

    def mark_own(self, mid: str) -> None:
        """Record a message id this porch session emitted (spool-render own)."""
        self._own_ids.add(mid)

    def update_verify_badge(self, mid: str) -> None:
        block = self._blocks_by_id.get(mid)
        if block is not None:
            block.refresh_verify_badge()

    def reveal_images_for(self, mid: str | None = None) -> int:
        if mid and mid in self._blocks_by_id:
            return self._blocks_by_id[mid].reveal_foreign_images()
        # Per-message consent: one chord reveals only the NEWEST message with
        # deferred images, never the whole channel (each press peels one).
        for block in reversed(self._blocks_by_id.values()):
            if list(block.query(".img-deferred")):
                return block.reveal_foreign_images()
        return 0

    async def _rebuild(self) -> None:
        # Await removal BEFORE mounting: un-awaited remove_children + mount
        # leaves ordering undefined and can interleave old and new blocks.
        await self.remove_children()
        self._blocks_by_id.clear()
        parts: list = []
        if self._channel:
            title = Text(f"#{sanitize_display(self._channel)}")
            if self._description:
                title.append(f" — {sanitize_display(self._description)}")
            parts.append(Label(title, classes="channel-header", markup=False))
        if self._msgs:
            by_id = index_by_id(self._msgs)
            last_day = None
            for m in self._msgs:
                day = fmt_day(m["sent"])
                show_day = day if day != last_day else None
                last_day = day
                block = MessageBlock(
                    m,
                    color=self.theme.color(m["from"]),
                    owner_room=self.owner_room,
                    by_id=by_id,
                    show_day=show_day,
                    dr_index=self._dr_index,
                    own_ids=self._own_ids,
                    wire=self.wire,
                    owner_accent=self.owner_accent,
                    rooms=self.rooms,
                )
                self._blocks_by_id[m["id"]] = block
                parts.append(block)
        else:
            parts.append(
                Label(
                    Text("No messages yet."),
                    classes="empty-hint",
                    markup=False,
                )
            )
        await self.mount(*parts)
        # anchor() scrolls to the end immediately and re-arms follow — every
        # rebuild, including the empty-channel path, lands at the bottom.
        self.anchor()
