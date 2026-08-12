"""Unit tests for porch3.wire — marker compilation and strip/round-trip."""

from __future__ import annotations

import re

from porch3.wire import DEFAULT_MARKER, DEFAULT_WIRE, compile_wire


def test_default_marker_is_only_definition():
    assert DEFAULT_MARKER == "🦊"
    assert DEFAULT_WIRE.marker == DEFAULT_MARKER


def test_prefixes():
    w = compile_wire("🦊")
    assert w.casual_prefix == "🦊 "
    assert w.signed_prefix == "🦊🔏 "
    assert w.prefix_casual("hello") == "🦊 hello"
    assert w.prefix_signed("hello", "20250111T120000Z") == (
        "🦊🔏 hello [signed:20250111T120000Z]"
    )


def test_strip_casual_and_signed():
    w = compile_wire("🦊")
    assert w.strip("🦊 hello") == "hello"
    body = w.prefix_signed("decide now", "TS1")
    assert w.strip(body) == "decide now"
    assert w.is_signed(body)
    assert not w.is_signed("🦊 hello")


def test_dr_action_regex_uses_marker():
    w = compile_wire("🦊")
    pat = w.dr_action_regex()
    m = pat.match("🦊🔏 ⚖️ DR dr-12 ratify")
    assert m is not None
    assert m.group(1) == "dr-12"
    assert not re.match(DEFAULT_WIRE.dr_action_regex(), "🐉🔏 ⚖️ DR dr-12 x")


def test_round_trip_non_default_marker():
    w = compile_wire("🐉")
    text = "wire round-trip"
    casual = w.prefix_casual(text)
    signed = w.prefix_signed(text, "20250111T000000Z")
    assert w.strip(casual) == text
    assert w.strip(signed) == text
    assert w.channel_text_for_verify(signed, "20250111T000000Z") == text
    assert w.channel_text_for_verify(signed + "\n", "20250111T000000Z") == text


def test_channel_text_refuses_prefix_and_appended_lines():
    w = compile_wire("🦊")
    tag = "TS1"
    good = w.prefix_signed("hello", tag)
    assert w.channel_text_for_verify("pre " + good, tag) is None
    assert w.channel_text_for_verify(good + "\nextra", tag) is None
    assert w.channel_text_for_verify("noise" + good, tag) is None
