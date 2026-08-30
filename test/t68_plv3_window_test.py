"""Frontend contracts for the PLv3 editor window's pane controls."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WINDOW = (ROOT / "js" / "plv3" / "window.js").read_text(encoding="utf-8")
DETAIL = (ROOT / "js" / "plv3" / "detail.js").read_text(encoding="utf-8")


def test_node_list_sorting_keeps_toolbar_separate_from_rows():
    assert "NODE_SORT_KEY" in WINDOW
    assert "['id', 'Node ID']" in WINDOW
    assert "['name', 'Name A–Z']" in WINDOW
    assert "sortNodes(this.plv3Nodes(), this.nodeSort)" in WINDOW
    assert "this.listRows.replaceChildren()" in WINDOW


def test_activity_bar_controls_all_three_columns():
    assert "activityButton('nodes'" in WINDOW
    assert "activityButton('outline'" in WINDOW
    assert "activityButton('detail'" in WINDOW
    assert "aria-pressed" in WINDOW
    assert "this.detail.setColumnVisibility" in WINDOW
    assert "const before = this.optionalColumnsWidth()" in WINDOW
    assert "this.resizeWindowBy(after - before, windowWidth)" in WINDOW


def test_right_columns_collapse_independently_and_keep_their_widths():
    assert "RIGHT_WIDTHS_KEY" in WINDOW
    assert "this.panes.outline || this.panes.detail" in WINDOW
    assert "setColumnVisibility" in DETAIL
    assert "this.navSplitter.style.display = showOutline && showBody" in DETAIL
    assert "this.body.style.display = showBody" in DETAIL


def test_collapsing_columns_resizes_the_window_instead_of_the_editor():
    assert "function flexWidth(element)" in WINDOW
    assert "optionalColumnsWidth()" in WINDOW
    assert "Math.round(baseWidth + delta)" in WINDOW
    assert "this.win.save()" in WINDOW
