"""The coalescer tick thread must survive a failing flush.

Regression: a single exception out of ``index_one`` (unreadable file, a
transient "database is locked" from a second writer, …) escaped
``_tick_loop`` and killed the thread for good — watchdog kept delivering
events, ``add()`` kept buffering them, and nothing ever flushed again, so
new images were only picked up by the 30 s heartbeat ``delta_scan``.
"""

import threading
import time

import pytest

from gallery.watcher import Coalescer


class _Root(dict):
    pass


ROOT = _Root({"id": 1, "path": "E:/fake/root", "kind": "output"})


class _NullDelta:
    def request(self):
        pass


def _mk() -> Coalescer:
    return Coalescer(
        root=ROOT, db_path="unused.sqlite", write_queue=object(), delta=_NullDelta(),
    )


def _wait_until(pred, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


def test_failing_flush_does_not_kill_the_tick_thread(monkeypatch):
    # Patches the real ``indexer.index_one`` (not the private helper) so this
    # test exercises the same path the watcher takes in production — and so it
    # genuinely fails against the pre-fix loop.
    import gallery.indexer as _indexer
    import gallery.service as _service

    c = _mk()
    seen: list[str] = []

    def boom(path, *, root, db_path, write_queue):
        seen.append(str(path))
        if str(path).endswith("bad.png"):
            raise OSError("cannot read")
        return None

    monkeypatch.setattr(_indexer, "index_one", boom)
    monkeypatch.setattr(_service, "broadcast_image_upserted", lambda *_a: None)
    c.start()
    try:
        c.add("k1", "E:/fake/root/bad.png", "u")
        assert _wait_until(lambda: "E:/fake/root/bad.png" in seen)
        # The thread must still be alive and still flushing afterwards.
        c.add("k2", "E:/fake/root/good.png", "u")
        assert _wait_until(lambda: "E:/fake/root/good.png" in seen)
        assert c._tick.is_alive()
    finally:
        c.request_stop()
        c.join_tick()


def test_tick_loop_crash_is_restarted():
    c = _mk()
    calls = {"n": 0}
    real = c._tick_loop
    started = threading.Event()

    def flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("loop blew up")
        started.set()
        real()

    c._tick_loop = flaky  # type: ignore[assignment]
    c._CRASH_RESTART_SLEEP_S = 0.05  # type: ignore[attr-defined]
    c.start()
    try:
        assert started.wait(3.0), "supervisor did not restart the loop"
        assert calls["n"] >= 2
        assert c._tick.is_alive()
    finally:
        c.request_stop()
        c.join_tick()


def test_stop_ends_the_supervisor_rather_than_restarting():
    c = _mk()
    c.start()
    c.request_stop()
    c.join_tick(timeout=3.0)
    assert not c._tick.is_alive()


@pytest.mark.parametrize("act", ["u", "d"])
def test_flush_still_advances_progress_after_a_failure(act):
    # A failed item must not stall a watcher job at done < planned.
    c = _mk()
    c._watcher_job_id = "job-1"
    c._watcher_cum_planned = 1

    def boom(pend):
        raise OSError("nope")

    c._flush_one = boom  # type: ignore[assignment]
    c.start()
    try:
        c.add("k", "E:/fake/root/x.png", act)
        assert _wait_until(lambda: c._watcher_cum_done >= 1)
    finally:
        c.request_stop()
        c.join_tick()
