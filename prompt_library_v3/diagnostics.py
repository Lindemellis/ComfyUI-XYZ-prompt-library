"""PLv3 diagnostics — the error / warning codes of the design spec §6.

Design principle (spec §6): as few errors as possible, as many warnings as
possible.  A warning always carries a defined, predictable degradation; an error
means the compiler has nothing it could reasonably do.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# --- Errors (compilation aborts) -------------------------------------------
E01 = "E01"  # region group nested inside another region group
E02 = "E02"  # circular library-group reference
E03 = "E03"  # unparseable text (unbalanced brackets, broken .set{}, bad number)

# --- Warnings (compilation continues with a defined degradation) ------------
W01 = "W01"  # [@schedule] carries .set{schedule}          -> [@schedule] wins
W02 = "W02"  # child of [@schedule] uses .set{schedule}    -> [@schedule] wins
W03 = "W03"  # [@region] carries .set{region}              -> [@region] wins
W04 = "W04"  # child of [@region] uses .set{region}        -> [@region] wins
W05 = "W05"  # empty schedule intersection                 -> drop the item
W06 = "W06"  # duplicate item text within a library group  -> dedupe (P4)
W07 = "W07"  # unknown .set{} field                        -> ignore the field
W08 = "W08"  # bad .set{} value type / out of range        -> default or clamp
W09 = "W09"  # library path not found                      -> compile text as-is (P4)
W10 = "W10"  # mask mixes percentage and pixel values      -> pass through
W11 = "W11"  # merged same-mask regions disagree           -> first group wins
W12 = "W12"  # region: fill under region_mode=mask         -> synthesise the fill
W13 = "W13"  # region used in a Negative node              -> ignore the region
W14 = "W14"  # unescaped reserved char, intent recoverable -> treat as a literal

_MESSAGES = {
    E01: "region group nested inside another region group",
    E02: "circular library-group reference",
    E03: "cannot parse",
    W01: "[@schedule] group also declares .set{schedule}; the [@schedule] intervals win",
    W02: "child of [@schedule] declares .set{schedule}; the [@schedule] interval wins",
    W03: "[@region] group also declares .set{region}; the [@region] declarations win",
    W04: "child of [@region] declares .set{region}; the [@region] declaration wins",
    W05: "empty schedule intersection; content dropped",
    W06: "duplicate item text in library group; deduplicated",
    W07: "unknown .set{} field; ignored",
    W08: "bad .set{} value; using the default",
    W09: "library group path not found; text compiled as-is",
    W10: "mask mixes percentage and pixel values; passed through as written",
    W11: "regions sharing a mask disagree; the first group's values win",
    W12: "region: fill under region_mode=mask; fill synthesised by subtracting the other masks",
    W13: "region declared in a Negative node; region ignored, content merged into the main segment",
    W14: "unescaped reserved character; treated as a literal",
}


@dataclass
class Diag:
    """One diagnostic.  `pos` is a character offset into the source text."""

    code: str
    message: str = ""
    pos: int = 0

    def __post_init__(self) -> None:
        if not self.message:
            self.message = _MESSAGES.get(self.code, self.code)

    @property
    def is_error(self) -> bool:
        return self.code.startswith("E")

    def __str__(self) -> str:
        return f"[{self.code}] {self.message} (at {self.pos})"


class PLv3Error(Exception):
    """Raised for any E-code.  Aborts the ComfyUI execution (spec §6)."""

    def __init__(self, code: str, message: str = "", pos: int = 0) -> None:
        self.diag = Diag(code, message, pos)
        super().__init__(str(self.diag))


@dataclass
class Diagnostics:
    """Collector passed down through parse / validate / compile."""

    items: list[Diag] = field(default_factory=list)

    def warn(self, code: str, message: str = "", pos: int = 0) -> None:
        self.items.append(Diag(code, message, pos))

    def codes(self) -> list[str]:
        return [d.code for d in self.items]

    def has(self, code: str) -> bool:
        return any(d.code == code for d in self.items)

    def __iter__(self):
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)
