"""serve/usage.py - the Monitor tab's token usage by day: the input and output tokens of the last 30 days.

Every finished request is counted into one bucket per local calendar day - the prompt tokens the model read
(input) and the tokens it wrote (output).  The buckets live in memory; with "usage_log": true in the run config
(or --usage-log) they are also kept in a small JSON file next to it (strata-<model>.usage.json), so the
Monitor's 30-day bar chart survives a restart.  Off by default: nothing is written to disk, and the chart then
covers the current run only.

Only counts are kept - no prompt, no answer, no API key, no per-request time.

    python -m unittest serve.test_usage
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import date, timedelta
from pathlib import Path

DAYS = 30                      # the Monitor's window
KEEP_DAYS = 45                 # a little more than the window: a day leaves the file only once it left the chart
MAX_DAYS = 90                  # what one read may ask for, so a request cannot make the server build a year of bars
WRITE_EVERY_S = 30.0           # a finished request marks the file dirty; it is written at most this often
VERSION = 1


def day_key(at: float | None = None) -> str:
    """The local calendar day a request belongs to - the PC's own clock, the same one the Monitor's times use."""
    return time.strftime("%Y-%m-%d", time.localtime(time.time() if at is None else at))


def _count(v, default=0):
    """A token count to keep: a whole number, never negative.  A bool is not a token count (True is not 1 token).

    `default` is what a count that is not there answers: 0 where counts add up, None where "not measured"
    has to stay apart from "measured zero" - the cost card prices a day it never measured at the assumed
    hit rate, and a day it measured at nothing at that number."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    return max(0, int(v))


class DailyUsage:
    """The last KEEP_DAYS local days of token counts, in memory and - opt-in - in a JSON file.

    record() runs on the thread that finished a request, view() on the thread answering the Monitor's read.
    Neither raises: a usage chart is never a reason for a request to fail, so a file that cannot be read or
    written is reported (read_error / write_error) and the counts go on in memory.
    """

    def __init__(self, path=None):
        self._lock = threading.Lock()
        self._days: dict[str, dict] = {}
        self._path = Path(path) if path else None
        self._dirty = False
        self._written_at = 0.0
        self.since = time.time()
        self.read_error = None
        self.write_error = None
        if self._path:
            self.load()

    # ------------------------------------------------------------------ the file
    def enable(self, path) -> Path | None:
        """Turn persistence on (the config's "usage_log" / --usage-log) and answer the file it keeps, or None.

        The run config is read after the Service is built, so the file is read here rather than at __init__.
        Called once, at startup."""
        self._path = Path(path) if path else None
        if self._path:
            self.load()
            with self._lock:
                self._dirty = True
            self.flush(force=True)
        return self._path

    def load(self) -> None:
        """The saved buckets, when the file is there and readable.  Anything else starts from empty."""
        if not self._path:
            return
        try:
            saved = json.loads(self._path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as e:
            self.read_error = str(e)
            print(f"[strata] {self._path.name} is not readable ({e}): the 30-day chart starts empty", flush=True)
            return
        days = saved.get("days") if isinstance(saved, dict) else None
        if not isinstance(days, dict):
            self.read_error = "no \"days\" block"
            print(f"[strata] {self._path.name} has no \"days\" block: the 30-day chart starts empty", flush=True)
            return
        kept = {}
        for key, v in days.items():
            if not isinstance(key, str) or not isinstance(v, dict):
                continue
            kept[key] = {"input_tokens": _count(v.get("input_tokens")),
                         "output_tokens": _count(v.get("output_tokens")),
                         "requests": _count(v.get("requests")),
                         "reused_tokens": _count(v.get("reused_tokens"), None)}
        with self._lock:
            self._days = kept

    def flush(self, force: bool = False) -> None:
        """The buckets written whole (a temporary file moved over the old one, as runconfig.save does), at most
        every WRITE_EVERY_S.  A failed write leaves the counts dirty, so the next chance takes them."""
        with self._lock:
            if not self._path or not self._dirty:
                return
            if not force and time.time() - self._written_at < WRITE_EVERY_S:
                return
            body = json.dumps({"version": VERSION, "days": self._days}, indent=1)
            self._dirty = False
            self._written_at = time.time()
        try:
            tmp = self._path.with_name(self._path.name + ".tmp")
            tmp.write_text(body, encoding="utf-8")
            os.replace(tmp, self._path)
            self.write_error = None
        except OSError as e:
            with self._lock:
                self._dirty = True
            self.write_error = str(e)

    # ------------------------------------------------------------------ the counts
    def record(self, input_tokens=0, output_tokens=0, reused_tokens=0, at=None) -> None:
        """One finished request added to its day.  A request that counted nothing counts as nothing.

        The caller holds the server's status_lock here, so nothing is written to disk in this call: the
        request's own thread calls flush() after it releases the lock."""
        key = day_key(at)
        with self._lock:
            day = self._days.setdefault(key, {"input_tokens": 0, "output_tokens": 0,
                                              "requests": 0, "reused_tokens": 0})
            day["input_tokens"] += _count(input_tokens)
            day["output_tokens"] += _count(output_tokens)
            day["reused_tokens"] += _count(reused_tokens)
            day["requests"] += 1
            self._dirty = True               # the file lags the memory by at most WRITE_EVERY_S
        self.prune()

    def prune(self) -> None:
        """Days older than KEEP_DAYS are dropped, so the file stays small however long the server runs."""
        oldest = (date.today() - timedelta(days=KEEP_DAYS - 1)).isoformat()
        with self._lock:
            stale = [k for k in self._days if k < oldest]
            for k in stale:
                del self._days[k]
            if stale:
                self._dirty = True

    def view(self, days: int = DAYS) -> dict:
        """GET /api/usage: the last `days` local days, oldest first.

        Every day of the window is named, requests or not, so the chart's dates stay continuous and a day
        without usage is a bar of zeros rather than a missing slot.  The counts are the sum of the requests
        that finished on that day; `reused_tokens` is the part of the input the conversation cache already
        held, which the Monitor's request table shows beside Prompt.  A day that did work with no reuse
        figure of its own - a count file written before reuse was tracked - answers `null` for it, which
        is "not measured", not "measured zero"."""
        try:
            n = int(days)
        except (TypeError, ValueError):
            n = DAYS
        n = min(max(1, n), MAX_DAYS)
        today = date.today()
        window = [(today - timedelta(days=k)).isoformat() for k in range(n - 1, -1, -1)]
        with self._lock:
            kept = {k: dict(v) for k, v in self._days.items()}
            since, read_error, write_error = self.since, self.read_error, self.write_error
        rows = []
        for k in window:
            d = kept.get(k)
            if d is None:               # a day with no requests: nothing was read, so nothing was reused
                rows.append({"date": k, "input_tokens": 0, "output_tokens": 0,
                             "requests": 0, "reused_tokens": 0})
                continue
            rows.append({"date": k,
                         "input_tokens": int(d.get("input_tokens") or 0),
                         "output_tokens": int(d.get("output_tokens") or 0),
                         "requests": int(d.get("requests") or 0),
                         "reused_tokens": _count(d.get("reused_tokens"), None)})
        self.flush()                    # a page load is a good moment to take the newest counts to disk
        return {"days": rows,
                "window": {"days": n, "from": window[0], "to": window[-1]},
                "totals": {"input_tokens": sum(r["input_tokens"] for r in rows),
                           "output_tokens": sum(r["output_tokens"] for r in rows),
                           "requests": sum(r["requests"] for r in rows),
                           "reused_tokens": sum(r["reused_tokens"] or 0 for r in rows)},
                "days_with_usage": sum(1 for r in rows if r["requests"]),
                "persistent": bool(self._path),
                "since": since,
                "time": time.time(),
                "error": write_error or read_error}
