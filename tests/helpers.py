"""Shared test helpers (importable; conftest is not a package module)."""

from __future__ import annotations

from pathlib import Path

from porch3.config import PorchConfig, build_config


def make_porch_config(
    tmp_path: Path,
    *,
    owner_room: str = "mara",
    marker: str | None = None,
    label: str | None = None,
) -> PorchConfig:
    room = tmp_path / f"{owner_room}-room"
    room.mkdir(parents=True, exist_ok=True)
    mail = tmp_path / "mail"
    mail.mkdir(parents=True, exist_ok=True)
    kwargs: dict = {
        "owner_room": owner_room,
        "owner_room_dir": room,
        "mail_root": mail,
        "env": {},
    }
    if marker is not None:
        kwargs["marker"] = marker
    if label is not None:
        kwargs["label"] = label
    return build_config(**kwargs)
