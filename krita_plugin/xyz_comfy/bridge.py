"""Marshal work from the HTTP server thread onto Krita's main thread.

**Every Krita API call must happen on the main thread.** Touching a Document or a
Node from the server thread crashes Krita, sometimes not immediately. So the HTTP
handler never calls into Krita directly: it hands a callable to `MainThread.call`,
which delivers it to the main thread through a queued Qt signal and blocks until
the result comes back.
"""

import threading

from PyQt5.QtCore import QObject, Qt, pyqtSignal


class _Call:
    __slots__ = ("fn", "result", "error", "done")

    def __init__(self, fn):
        self.fn = fn
        self.result = None
        self.error = None
        self.done = threading.Event()


class MainThread(QObject):
    """Must be constructed on the main thread — that is the thread it delivers to."""

    _invoke = pyqtSignal(object)

    def __init__(self):
        super().__init__()
        # QueuedConnection: the slot runs in the thread this QObject lives in
        # (the main thread), no matter who emits.
        self._invoke.connect(self._run, Qt.QueuedConnection)

    def _run(self, call: _Call):
        try:
            call.result = call.fn()
        except Exception as exc:  # noqa: BLE001 - carried across the thread boundary
            call.error = exc
        finally:
            call.done.set()

    def call(self, fn, timeout: float = 30.0):
        """Run `fn` on the main thread and return its result.

        Raises whatever `fn` raised, or TimeoutError if Krita's event loop never
        got round to us (busy, or blocked on a modal dialog).
        """
        call = _Call(fn)
        self._invoke.emit(call)
        if not call.done.wait(timeout):
            raise TimeoutError(
                f"Krita did not respond within {timeout}s — it may be busy or "
                "showing a dialog"
            )
        if call.error is not None:
            raise call.error
        return call.result
