"""Composer: TextArea with Enter-to-send, Shift/Alt+Enter newline."""

from __future__ import annotations

from textual import events
from textual.binding import Binding
from textual.message import Message
from textual.widgets import TextArea


class Composer(TextArea):
    """Multi-line draft box. Plain Enter submits; paste never auto-sends."""

    # Re-declare left so empty-input can open the channel browser (v2 parity).
    BINDINGS = [
        Binding("left", "left_or_channels", "Left", show=False),
        *[b for b in TextArea.BINDINGS if b.key != "left"],
    ]

    class Submitted(Message):
        """Posted when the user presses Enter (not Shift/Alt+Enter)."""

        def __init__(self, text: str) -> None:
            self.text = text
            super().__init__()

    class ChannelsRequested(Message):
        """Empty-input Left → open channel browser."""

    DEFAULT_CSS = """
    Composer {
        height: auto;
        max-height: 8;
        min-height: 3;
        border: tall $accent;
        padding: 0 1;
    }
    """

    def __init__(self, **kwargs) -> None:
        super().__init__(soft_wrap=True, show_line_numbers=False, **kwargs)
        self.language = None

    def action_left_or_channels(self) -> None:
        at_origin = self.cursor_location == (0, 0)
        if not self.text.strip() and at_origin:
            self.post_message(self.ChannelsRequested())
            return
        self.action_cursor_left()

    async def _on_key(self, event: events.Key) -> None:
        key = event.key
        # Shift+Enter / Alt+Enter insert a newline (never submit).
        if key in ("shift+enter", "alt+enter"):
            event.stop()
            event.prevent_default()
            if self.read_only:
                return
            start, end = self.selection
            self._replace_via_keyboard("\n", start, end)
            return
        # Plain Enter submits — only a real keypress reaches here; paste
        # arrives as events.Paste and never synthesizes Key("enter").
        if key == "enter":
            event.stop()
            event.prevent_default()
            self.post_message(self.Submitted(self.text))
            return
        await super()._on_key(event)

    def clear_draft(self) -> None:
        self.load_text("")

    def set_draft(self, text: str) -> None:
        self.load_text(text)
        lines = text.splitlines() or [""]
        row = len(lines) - 1
        col = len(lines[-1])
        self.move_cursor((row, col))

    def line_count(self) -> int:
        return max(1, self.document.line_count)
