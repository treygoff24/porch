"""Channel browser with per-member presence and descriptions."""

from __future__ import annotations

from pathlib import Path

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Vertical, VerticalScroll
from textual.message import Message
from textual.widgets import Label, Static

from porch3.sanitize import sanitize_display
from porch3.store import channel_description, channel_members, channel_preview


class ChannelBrowser(Vertical):
    """List of channels; ↑/↓ select, → open."""

    DEFAULT_CSS = """
    ChannelBrowser {
        height: 1fr;
        padding: 1;
    }
    ChannelBrowser .browser-title {
        text-style: bold;
        margin: 0 0 1 0;
        height: auto;
    }
    ChannelBrowser .channel-row {
        height: auto;
        padding: 0 1;
        margin: 0 0 1 0;
    }
    ChannelBrowser .channel-row.selected {
        background: $accent 30%;
        text-style: bold;
    }
    ChannelBrowser .chan-desc {
        color: $text-muted;
        height: auto;
        margin: 0 0 0 3;
    }
    ChannelBrowser .chan-preview {
        color: $text-muted;
        height: auto;
        margin: 0 0 0 3;
    }
    ChannelBrowser .chan-members {
        height: auto;
        margin: 0 0 0 3;
    }
    ChannelBrowser .dot-live {
        color: #22c55e;
    }
    ChannelBrowser .dot-dead {
        color: #64748b;
    }
    """

    class OpenRequested(Message):
        def __init__(self, channel: str) -> None:
            self.channel = channel
            super().__init__()

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.channels: list[str] = []
        self.selected = 0
        self.presence: dict[str, bool] = {}
        self._root: Path | None = None
        self._list: VerticalScroll | None = None
        self._member_liveness: dict[str, dict[str, bool]] = {}

    def compose(self) -> ComposeResult:
        yield Label(
            Text("Channels · ↑/↓ select · → open · Esc back"),
            classes="browser-title",
            markup=False,
        )
        self._list = VerticalScroll(id="channel-list")
        yield self._list

    def set_channels(
        self,
        channels: list[str],
        *,
        selected: str | None = None,
        presence: dict[str, bool] | None = None,
        root: Path | None = None,
    ) -> None:
        self.channels = list(channels)
        if root is not None:
            self._root = root
        if presence is not None:
            self.presence = presence
        if selected and selected in self.channels:
            self.selected = self.channels.index(selected)
        elif self.channels:
            self.selected = min(self.selected, len(self.channels) - 1)
        else:
            self.selected = 0
        self._rebuild()

    def set_presence(self, presence: dict[str, bool]) -> None:
        self.presence = presence
        self._rebuild()

    def member_liveness(self, channel: str) -> dict[str, bool]:
        """Per-member live/dead for a channel (no any() collapse)."""
        return dict(self._member_liveness.get(channel, {}))

    def move(self, delta: int) -> None:
        if not self.channels:
            return
        self.selected = max(
            0, min(len(self.channels) - 1, self.selected + delta)
        )
        self._rebuild()

    def open_selected(self) -> None:
        if not self.channels:
            return
        self.post_message(self.OpenRequested(self.channels[self.selected]))

    def _root_or_default(self) -> Path:
        # Tests and the app always call set_channels/set_root before rebuild;
        # a missing root yields an empty browser rather than a hardcoded home path.
        if self._root is None:
            return Path("/nonexistent-channels-root")
        return self._root

    def _rebuild(self) -> None:
        if self._list is None:
            return
        self._list.remove_children()
        root = self._root_or_default()
        self._member_liveness = {}
        rows = []
        for i, channel in enumerate(self.channels):
            members = channel_members(channel, root)
            per_member = {m: bool(self.presence.get(m)) for m in members}
            self._member_liveness[channel] = per_member
            # Channel-level dot: live if any member live (visual summary only;
            # member row below is the authoritative per-room view).
            any_live = any(per_member.values()) if per_member else False
            dot = "●" if any_live else "○"
            color = "#22c55e" if any_live else "#64748b"
            sent, sender, preview = channel_preview(channel, root=root)
            desc = channel_description(channel, root=root)
            classes = "channel-row selected" if i == self.selected else "channel-row"

            name = Text()
            name.append(f"{dot} ", style=color)
            name.append(
                f"#{sanitize_display(channel)}  {sent}  {sanitize_display(sender)}"
            )
            kids: list = [Static(name)]
            if desc:
                kids.append(Label(Text(desc), classes="chan-desc", markup=False))
            if members:
                mem = Text()
                for idx, member in enumerate(members):
                    if idx:
                        mem.append("  ")
                    live = per_member.get(member, False)
                    mdot = "●" if live else "○"
                    mcolor = "#22c55e" if live else "#64748b"
                    mem.append(f"{mdot} ", style=mcolor)
                    mem.append(
                        sanitize_display(member),
                        style=mcolor if live else "dim",
                    )
                kids.append(Static(mem, classes="chan-members"))
            kids.append(Label(Text(preview), classes="chan-preview", markup=False))
            rows.append(Vertical(*kids, classes=classes))
        if rows:
            self._list.mount(*rows)
