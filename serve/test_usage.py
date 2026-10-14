"""Tests for serve/usage.py - the Monitor's 30-day token chart: the input and the output tokens of each local day.

No native model or GPU is needed: the counts are plain arithmetic, the file is a small JSON, and the endpoint
answers from the Service's own DailyUsage.

    python -m unittest serve.test_usage
"""
from __future__ import annotations

import json
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from serve import usage as usage_log
from serve.frontend import ChatTemplate
from serve.server import ByteTokenizer, MockEngine, Service, serve

TEMPLATE = Path(__file__).parent / "chat_template.jinja"


def stamp(day: date) -> float:
    """A timestamp in the middle of a local calendar day, so the day key cannot wobble."""
    return time.mktime((day.year, day.month, day.day, 12, 0, 0, 0, 0, -1))


def days_of(view):
    return [r["date"] for r in view["days"]]


class Buckets(unittest.TestCase):
    def setUp(self):
        self.u = usage_log.DailyUsage()          # no path: nothing is written, as by default

    def test_two_requests_of_one_day_add_up(self):
        today = date.today()
        self.u.record(input_tokens=100, output_tokens=7, reused_tokens=40, at=stamp(today))
        self.u.record(input_tokens=50, output_tokens=3, at=stamp(today))
        row = self.u.view(30)["days"][-1]
        self.assertEqual(row["input_tokens"], 150)
        self.assertEqual(row["output_tokens"], 10)
        self.assertEqual(row["reused_tokens"], 40)
        self.assertEqual(row["requests"], 2)

    def test_a_request_that_counted_nothing_counts_as_nothing(self):
        self.u.record()
        row = self.u.view(30)["days"][-1]
        self.assertEqual((row["input_tokens"], row["output_tokens"]), (0, 0))
        self.assertEqual(row["requests"], 1)

    def test_a_count_that_is_not_a_number_is_not_kept(self):
        self.u.record(input_tokens=-5, output_tokens=True, reused_tokens="many")
        row = self.u.view(30)["days"][-1]
        self.assertEqual((row["input_tokens"], row["output_tokens"], row["reused_tokens"]), (0, 0, 0))

    def test_days_are_kept_apart(self):
        today = date.today()
        self.u.record(input_tokens=10, output_tokens=1, at=stamp(today - timedelta(days=1)))
        self.u.record(input_tokens=20, output_tokens=2, at=stamp(today))
        rows = {r["date"]: r for r in self.u.view(30)["days"]}
        self.assertEqual(rows[(today - timedelta(days=1)).isoformat()]["input_tokens"], 10)
        self.assertEqual(rows[today.isoformat()]["input_tokens"], 20)

    def test_an_old_day_is_dropped(self):
        self.u.record(input_tokens=99, at=stamp(date.today() - timedelta(days=usage_log.KEEP_DAYS + 5)))
        self.assertNotIn((date.today() - timedelta(days=usage_log.KEEP_DAYS + 5)).isoformat(), self.u._days)


class Window(unittest.TestCase):
    def setUp(self):
        self.u = usage_log.DailyUsage()

    def test_the_window_is_contiguous_oldest_first_and_ends_today(self):
        today = date.today()
        self.u.record(input_tokens=1, at=stamp(today - timedelta(days=3)))
        view = self.u.view(30)
        keys = days_of(view)
        self.assertEqual(len(keys), 30)
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(keys[-1], today.isoformat())
        self.assertEqual(keys[0], (today - timedelta(days=29)).isoformat())
        self.assertEqual(view["window"], {"days": 30, "from": keys[0], "to": keys[-1]})

    def test_a_day_without_usage_is_a_row_of_zeros(self):
        gap = (date.today() - timedelta(days=11)).isoformat()
        rows = {r["date"]: r for r in self.u.view(30)["days"]}
        self.assertEqual(rows[gap], {"date": gap, "input_tokens": 0, "output_tokens": 0,
                                     "requests": 0, "reused_tokens": 0})

    def test_a_day_with_only_input_and_a_day_with_only_output(self):
        today = date.today()
        self.u.record(input_tokens=70, at=stamp(today - timedelta(days=2)))
        self.u.record(output_tokens=9, at=stamp(today - timedelta(days=1)))
        rows = {r["date"]: r for r in self.u.view(30)["days"]}
        self.assertEqual((rows[(today - timedelta(days=2)).isoformat()]["output_tokens"]), 0)
        self.assertEqual(rows[(today - timedelta(days=1)).isoformat()]["input_tokens"], 0)
        self.assertEqual(self.u.view(30)["days_with_usage"], 2)

    def test_the_totals_cover_the_window_only(self):
        self.u.record(input_tokens=5, output_tokens=2, at=stamp(date.today() - timedelta(days=40)))
        self.u.record(input_tokens=8, output_tokens=3)
        view = self.u.view(30)
        self.assertEqual(view["totals"], {"input_tokens": 8, "output_tokens": 3, "requests": 1})

    def test_the_number_of_days_is_clamped(self):
        self.assertEqual(len(self.u.view(0)["days"]), 1)
        self.assertEqual(len(self.u.view(1000)["days"]), usage_log.MAX_DAYS)
        self.assertEqual(len(self.u.view("30")["days"]), 30)
        self.assertEqual(len(self.u.view("nonsense")["days"]), usage_log.DAYS)
        self.assertEqual(len(self.u.view(None)["days"]), usage_log.DAYS)

    def test_no_usage_at_all_still_answers_a_full_window(self):
        view = self.u.view(30)
        self.assertEqual(len(view["days"]), 30)
        self.assertEqual(view["days_with_usage"], 0)
        self.assertEqual(view["totals"], {"input_tokens": 0, "output_tokens": 0, "requests": 0})
        self.assertIsNone(view["error"])


class File(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "strata-test.usage.json"

    def test_no_file_is_written_when_persistence_is_off(self):
        u = usage_log.DailyUsage()
        u.record(input_tokens=10, output_tokens=2)
        u.flush(force=True)
        self.assertFalse(u.view(30)["persistent"])
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_the_counts_survive_a_restart(self):
        u = usage_log.DailyUsage(self.path)
        u.record(input_tokens=120, output_tokens=15, reused_tokens=30)
        u.flush(force=True)
        again = usage_log.DailyUsage(self.path)
        row = again.view(30)["days"][-1]
        self.assertEqual((row["input_tokens"], row["output_tokens"], row["reused_tokens"]), (120, 15, 30))
        self.assertTrue(again.view(30)["persistent"])
        self.assertIsNone(again.view(30)["error"])

    def test_enable_answers_the_file_and_reads_it(self):
        usage_log.DailyUsage(self.path).record(input_tokens=4, output_tokens=1)
        Path(self.path).write_text(json.dumps({"version": 1, "days": {
            date.today().isoformat(): {"input_tokens": 4, "output_tokens": 1, "requests": 1, "reused_tokens": 0}}}),
            encoding="utf-8")
        u = usage_log.DailyUsage()
        self.assertEqual(u.enable(None), None)
        self.assertEqual(Path(u.enable(self.path)).name, "strata-test.usage.json")
        self.assertEqual(u.view(30)["days"][-1]["input_tokens"], 4)

    def test_a_file_that_is_not_readable_starts_empty_and_says_so(self):
        Path(self.path).write_text("{not json", encoding="utf-8")
        u = usage_log.DailyUsage(self.path)
        view = u.view(30)
        self.assertIsNotNone(view["error"])
        self.assertEqual(view["days_with_usage"], 0)
        u.record(input_tokens=1)                       # the counts go on in memory all the same
        self.assertEqual(u.view(30)["days_with_usage"], 1)

    def test_a_file_without_a_days_block_starts_empty(self):
        Path(self.path).write_text(json.dumps({"version": 1}), encoding="utf-8")
        self.assertIsNotNone(usage_log.DailyUsage(self.path).view(30)["error"])

    def test_a_file_with_junk_in_it_keeps_what_is_usable(self):
        Path(self.path).write_text(json.dumps({"days": {
            date.today().isoformat(): {"input_tokens": 3, "output_tokens": "x", "requests": -2},
            "not-a-day": "no", 7: {"input_tokens": 1}}}), encoding="utf-8")
        row = usage_log.DailyUsage(self.path).view(30)["days"][-1]
        self.assertEqual((row["input_tokens"], row["output_tokens"], row["requests"]), (3, 0, 0))

    def test_the_write_is_debounced(self):
        u = usage_log.DailyUsage(self.path)
        u.record(input_tokens=1)
        u._written_at = time.time()                    # a write just happened
        u.flush()
        self.assertFalse(self.path.exists())
        u.flush(force=True)
        self.assertTrue(self.path.exists())

    def test_a_file_that_cannot_be_written_is_reported_and_the_counts_go_on(self):
        u = usage_log.DailyUsage(Path(self.tmp.name) / "no-such-dir" / "usage.json")
        u.record(input_tokens=6, output_tokens=2)
        u.flush(force=True)
        view = u.view(30)
        self.assertIsNotNone(view["error"])
        self.assertEqual(view["totals"]["input_tokens"], 6)

    def test_the_file_holds_counts_only(self):
        u = usage_log.DailyUsage(self.path)
        u.record(input_tokens=1, output_tokens=1)
        u.flush(force=True)
        self.assertEqual(set(json.loads(self.path.read_text(encoding="utf-8"))), {"version", "days"})


class Endpoint(unittest.TestCase):
    def setUp(self):
        self.tok = ByteTokenizer()
        self.svc = Service(MockEngine(self.tok, "Hello.", max_context=4096), self.tok, ChatTemplate(TEMPLATE))
        self.httpd = serve(self.svc, port=0)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def get(self, path, key=None):
        req = urllib.request.Request(self.base + path,
                                     headers={"Authorization": "Bearer " + key} if key else {})
        try:
            response = urllib.request.urlopen(req, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read().decode())

    def chat(self):
        req = urllib.request.Request(self.base + "/v1/chat/completions",
                                     headers={"Content-Type": "application/json"},
                                     data=json.dumps({"messages": [{"role": "user", "content": "Say hello."}]}).encode())
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()

    def test_the_chart_answers_and_counts_a_finished_request(self):
        self.chat()
        code, body = self.get("/api/usage?days=30")
        self.assertEqual(code, 200)
        self.assertEqual(len(body["days"]), 30)
        self.assertEqual(body["days"][-1]["requests"], 1)
        self.assertGreater(body["days"][-1]["input_tokens"], 0)
        self.assertGreater(body["days"][-1]["output_tokens"], 0)
        self.assertEqual(body["totals"]["requests"], 1)
        self.assertIsNone(body["error"])

    def test_the_chart_needs_the_api_key_the_server_was_started_with(self):
        self.svc.api_key = "sekret"
        code, body = self.get("/api/usage")
        self.assertEqual(code, 401)
        self.assertEqual(self.get("/api/usage", "sekret")[0], 200)

    def test_the_default_path_writes_nothing_and_says_the_run_is_all_it_covers(self):
        self.chat()
        code, body = self.get("/api/usage")
        self.assertEqual(code, 200)
        self.assertFalse(body["persistent"])


if __name__ == "__main__":
    unittest.main()
