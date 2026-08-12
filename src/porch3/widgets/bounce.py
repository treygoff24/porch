"""Crossed-send bounce banner: show missed msgs, Enter=anyway, Esc=edit."""

from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Vertical, VerticalScroll
from textual.message import Message
from textual.widgets import Label

from porch3.constants import DEFAULT_OWNER_ACCENT
from porch3.theme import SenderTheme
from porch3.wire import DEFAULT_WIRE, WireFormat
from porch3.widgets.message_block import MessageBlock

BOUNCE_TITLE = (
    "⚠ unseen messages before yours lands — "
    "Enter send anyway · Esc keep editing"
)


class BounceBanner(Vertical):
    """Highlighted unseen-before-send block over the composer."""

    DEFAULT_CSS = """
    BounceBanner {
        height: auto;
        max-height: 40%;
        background: #3a1a00;
        border: solid #FF8C00;
        padding: 1;
        margin: 0 0 1 0;
        display: none;
    }
    BounceBanner.-visible {
        display: block;
    }
    BounceBanner .bounce-title {
        text-style: bold;
        color: #FFB347;
        height: auto;
        margin: 0 0 1 0;
    }
    BounceBanner .bounce-hint {
        color: $text-muted;
        height: auto;
        margin: 1 0 0 0;
    }
    """

    class Anyway(Message):
        """User chose Enter → send --anyway."""

    class Dismiss(Message):
        """User chose Esc → keep editing."""

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
        self.missed: list[dict] = []
        self._scroll: VerticalScroll | None = None

    def compose(self) -> ComposeResult:
        yield Label(Text(BOUNCE_TITLE), classes="bounce-title", markup=False)
        self._scroll = VerticalScroll(id="bounce-missed")
        yield self._scroll
        yield Label(
            Text("Draft kept in composer. Never silently --anyway."),
            classes="bounce-hint",
            markup=False,
        )

    def show_missed(self, missed: list[dict]) -> None:
        self.missed = list(missed)
        self.add_class("-visible")
        if self._scroll is not None:
            self._scroll.remove_children()
            blocks = [
                MessageBlock(
                    m,
                    color=self.theme.color(m.get("from", "?")),
                    owner_room=self.owner_room,
                    bounce=True,
                    wire=self.wire,
                    owner_accent=self.owner_accent,
                    rooms=self.rooms,
                )
                for m in self.missed
            ]
            if blocks:
                self._scroll.mount(*blocks)

    def hide(self) -> None:
        self.remove_class("-visible")
        self.missed = []
        if self._scroll is not None:
            self._scroll.remove_children()

    @property
    def active(self) -> bool:
        return self.has_class("-visible")
