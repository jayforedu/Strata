"""serve/pricing.py - the Monitor's cost card: the tokens Strata really counted, priced at a paid model.

No GPU, no native model, no network.  What is checked here is the arithmetic (the cache split, the three
prices, the money), the model identification (the variants, the quant suffixes, and the unknown model that
gets no price), the card's own settings file, and - last, as serve/test_monitor.py does it - the two real
HTTP endpoints the card reads and writes.

    python -m unittest serve.test_pricing
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
import urllib.error
import urllib.request
import uuid
from datetime import date
from pathlib import Path

from serve import pricing
from serve.frontend import ChatTemplate
from serve.server import ByteTokenizer, MockEngine, Service, serve

TEMPLATE = Path(__file__).parent / "chat_template.jinja"

# Where a test keeps the files it writes: the system temp folder, unless STRATA_TEST_TMP points it at a
# folder this machine already lets a test write in.  Every test gets a folder of its own, and removes it.
TMP_ROOT = Path(os.environ.get("STRATA_TEST_TMP") or tempfile.gettempdir())


class Scratch:
    """A folder of its own for one test: made in setUp, removed in tearDown."""

    def __init__(self):
        self.path = TMP_ROOT / f"strata-pricing-test-{uuid.uuid4().hex}"
        self.path.mkdir(parents=True, exist_ok=True)

    def cleanup(self) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


def cost(tokens, model_id="opus-5.5", share=pricing.DEFAULT_CACHE_ASSUMPTION):
    """The money for a set of counts at one paid model's prices."""
    return pricing.compute_cost(tokens, pricing.price_of(model_id), share)


class CostMath(unittest.TestCase):
    """Uncached input at the full price, cached input at the cache price, answer at the output price."""

    def test_a_million_uncached_input_tokens_cost_the_input_price(self):
        # requirement 1
        c = cost({"input_tokens": 1_000_000, "cached_input_tokens": 0, "output_tokens": 0})
        self.assertEqual(c["uncached_input_tokens"], 1_000_000)
        self.assertEqual(c["cached_input_tokens"], 0)
        self.assertAlmostEqual(c["input_cost"], 4.00, places=6)
        self.assertAlmostEqual(c["cached_input_cost"], 0.0, places=6)
        self.assertAlmostEqual(c["output_cost"], 0.0, places=6)
        self.assertAlmostEqual(c["total_cost"], pricing.price_of("opus-5.5")["input"], places=6)
        self.assertFalse(c["assumed_cache"])

    def test_a_million_cached_input_tokens_cost_the_cache_price(self):
        # requirement 2
        c = cost({"input_tokens": 1_000_000, "cached_input_tokens": 1_000_000, "output_tokens": 0})
        self.assertEqual(c["uncached_input_tokens"], 0)
        self.assertAlmostEqual(c["total_cost"], pricing.price_of("opus-5.5")["cached_input"], places=6)

    def test_the_three_kinds_of_token_are_priced_apart(self):
        # requirement 3: 1,000,000 in (700,000 of it cached) and 100,000 out
        c = cost({"input_tokens": 1_000_000, "cached_input_tokens": 700_000, "output_tokens": 100_000})
        self.assertEqual(c["uncached_input_tokens"], 300_000)
        self.assertAlmostEqual(c["input_cost"], 300_000 * 4.00 / 1e6, places=6)
        self.assertAlmostEqual(c["cached_input_cost"], 700_000 * 0.20 / 1e6, places=6)
        self.assertAlmostEqual(c["output_cost"], 100_000 * 20.00 / 1e6, places=6)
        self.assertAlmostEqual(c["total_cost"], 1.20 + 0.14 + 2.00, places=6)
        self.assertAlmostEqual(c["cache_hit_rate"], 0.7, places=6)

    def test_the_cached_part_is_never_counted_twice(self):
        # requirement 4: Strata's input count already holds the cached part, so the split must add back to it
        c = cost({"input_tokens": 500_000, "cached_input_tokens": 400_000, "output_tokens": 0})
        self.assertEqual(c["uncached_input_tokens"] + c["cached_input_tokens"], c["input_tokens"])
        self.assertAlmostEqual(c["total_cost"], 100_000 * 4.00 / 1e6 + 400_000 * 0.20 / 1e6, places=6)
        # the whole prompt at the full price would have been more: the cache is priced, not dropped
        self.assertLess(c["total_cost"], 500_000 * 4.00 / 1e6)

    def test_the_cache_is_never_free(self):
        c = cost({"input_tokens": 0, "cached_input_tokens": 1_000_000, "output_tokens": 0})
        self.assertEqual(c["input_tokens"], 0)
        self.assertEqual(c["cached_input_tokens"], 0)      # a cached part cannot be bigger than the prompt
        self.assertAlmostEqual(c["total_cost"], 0.0, places=6)
        c = cost({"input_tokens": 100, "cached_input_tokens": 100, "output_tokens": 0})
        self.assertGreater(c["cached_input_cost"], 0.0)

    def test_a_cached_count_bigger_than_the_prompt_is_clamped(self):
        c = cost({"input_tokens": 1_000, "cached_input_tokens": 99_000, "output_tokens": 0})
        self.assertEqual(c["cached_input_tokens"], 1_000)
        self.assertEqual(c["uncached_input_tokens"], 0)

    def test_no_counts_cost_nothing(self):
        for tokens in ({}, {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}):
            c = cost(tokens)
            self.assertAlmostEqual(c["total_cost"], 0.0, places=9)
            self.assertEqual(c["cache_hit_rate"], 0.0)

    def test_a_missing_cache_count_stays_an_assumption(self):
        # requirement 10, the calculation half of it: the answer says it is an assumption
        c = cost({"input_tokens": 1_000_000, "cached_input_tokens": None, "output_tokens": 0})
        self.assertTrue(c["assumed_cache"])
        self.assertEqual(c["cached_input_tokens"], 700_000)
        c = cost({"input_tokens": 1_000_000, "output_tokens": 0})
        self.assertTrue(c["assumed_cache"])

    def test_the_assumed_share_is_the_users_number(self):
        c = cost({"input_tokens": 1_000_000, "output_tokens": 0}, share=0.25)
        self.assertEqual(c["cached_input_tokens"], 250_000)
        self.assertAlmostEqual(c["cache_hit_rate"], 0.25, places=6)

    def test_the_answer_is_charged_once_even_when_it_thought_first(self):
        # requirement 9: Strata's output count already holds the thinking tokens, so there is no fourth term
        c = cost({"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 200_000})
        self.assertAlmostEqual(c["output_cost"], 200_000 * 20.00 / 1e6, places=6)
        self.assertAlmostEqual(c["total_cost"], c["output_cost"], places=6)
        self.assertEqual(set(c), {"input_tokens", "cached_input_tokens", "uncached_input_tokens", "output_tokens",
                                  "input_cost", "cached_input_cost", "output_cost", "total_cost",
                                  "cache_hit_rate", "assumed_cache"},
                         "a fourth charge appeared in the answer: the thinking tokens are already in the output")

    def test_the_money_shows_its_decimals_where_a_session_lives(self):
        self.assertEqual(pricing.money(0.0), "$0.00")
        self.assertEqual(pricing.money(0.0000123), "$0.000012")
        self.assertEqual(pricing.money(1.2345), "$1.23")
        self.assertEqual(pricing.money(1234.5), "$1,234.50")

    def test_every_price_lives_in_the_one_table(self):
        for mid, table in pricing.PAID_MODELS.items():
            for k in ("title", "input", "cached_input", "output", "source", "currency", "checked", "verified"):
                self.assertIn(k, table, f"{mid} has no {k}")
            self.assertEqual(table["currency"], "USD")
            self.assertGreaterEqual(table["cached_input"], 0)
            self.assertLess(table["cached_input"], table["input"], f"{mid}: cached input must cost less than reading")
            self.assertGreater(table["output"], table["input"], f"{mid}: the answer must cost more than the prompt")
            self.assertIsInstance(table["verified"], bool)
        for fam, mid in pricing.FAMILY_BASELINES.items():
            self.assertIn(fam, pricing.LOCAL_FAMILIES)
            self.assertIn(mid, pricing.PAID_MODELS)

class DaysPriced(unittest.TestCase):
    """A window is priced day by day: the days whose reuse Strata measured pay for their own reuse, and
    only a day with no reuse figure of its own falls back to the assumed hit rate."""

    def price(self, rows, model_id="opus-5.5", share=pricing.DEFAULT_CACHE_ASSUMPTION):
        return pricing.price_days(rows, pricing.price_of(model_id), share)

    def test_a_window_of_measured_days_never_borrows_the_assumption(self):
        rows = [{"input_tokens": 1_000_000, "output_tokens": 0, "cached_input_tokens": 250_000},
                {"input_tokens": 500_000, "output_tokens": 100_000, "cached_input_tokens": 400_000}]
        p = self.price(rows)
        self.assertEqual((p["days_measured"], p["days_assumed"]), (2, 0))
        self.assertFalse(p["assumed_cache"])
        self.assertEqual(p["input_tokens"], 1_500_000)
        self.assertEqual(p["cached_input_tokens"], 650_000)
        self.assertEqual(p["uncached_input_tokens"], 850_000)
        opus = pricing.price_of("opus-5.5")
        self.assertAlmostEqual(p["total_cost"], 850_000 * opus["input"] / 1e6
                               + 650_000 * opus["cached_input"] / 1e6
                               + 100_000 * opus["output"] / 1e6, places=6)

    def test_a_day_with_no_reuse_figure_of_its_own_uses_the_assumption_and_says_so(self):
        p = self.price([{"input_tokens": 1_000_000, "output_tokens": 0, "cached_input_tokens": None}])
        self.assertEqual((p["days_measured"], p["days_assumed"]), (0, 1))
        self.assertTrue(p["assumed_cache"])
        self.assertEqual(p["cached_input_tokens"], 700_000)

    def test_a_measured_day_is_not_priced_at_its_neighbours_assumed_share(self):
        rows = [{"input_tokens": 100_000, "output_tokens": 0, "cached_input_tokens": 10_000},
                {"input_tokens": 100_000, "output_tokens": 0, "cached_input_tokens": None}]
        p = self.price(rows)
        self.assertEqual((p["days_measured"], p["days_assumed"]), (1, 1))
        self.assertTrue(p["assumed_cache"])
        self.assertEqual(p["cached_input_tokens"], 80_000)   # 10,000 measured + 70,000 assumed
        opus = pricing.price_of("opus-5.5")
        one = self.price([rows[0]])
        self.assertAlmostEqual(one["total_cost"], 90_000 * opus["input"] / 1e6 + 10_000 * opus["cached_input"] / 1e6,
                               places=6)
        self.assertAlmostEqual(p["total_cost"], one["total_cost"] + 30_000 * opus["input"] / 1e6
                               + 70_000 * opus["cached_input"] / 1e6, places=6)

    def test_a_day_that_read_nothing_is_neither_measured_nor_assumed(self):
        p = self.price([{"input_tokens": 0, "output_tokens": 0, "cached_input_tokens": None},
                        {"input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0}])
        self.assertAlmostEqual(p["total_cost"], 0.0, places=9)
        self.assertEqual((p["days_measured"], p["days_assumed"]), (0, 0))
        self.assertFalse(p["assumed_cache"])
        self.assertEqual(p["cache_hit_rate"], 0.0)

    def test_no_days_cost_nothing(self):
        for rows in ([], None):
            p = self.price(rows)
            self.assertAlmostEqual(p["total_cost"], 0.0, places=9)
            self.assertEqual((p["days_measured"], p["days_assumed"]), (0, 0))

    def test_a_window_costs_what_its_days_cost_apart(self):
        rows = [{"input_tokens": 40_000, "output_tokens": 3_000, "cached_input_tokens": 12_000},
                {"input_tokens": 90_000, "output_tokens": 800, "cached_input_tokens": 60_000},
                {"input_tokens": 5_000, "output_tokens": 0, "cached_input_tokens": 0}]
        prices = pricing.price_of("sonnet-5.5")
        want = sum(pricing.compute_cost(r, prices, pricing.DEFAULT_CACHE_ASSUMPTION)["total_cost"]
                   for r in rows)
        self.assertAlmostEqual(self.price(rows, "sonnet-5.5")["total_cost"], want, places=9)


class ModelIdentification(unittest.TestCase):
    """Which local model is loaded: the run config's name, the model id, the model files - never a guess."""

    def test_the_run_configs_own_name_names_the_family(self):
        for stem, fam, baseline in (("strata-swift-iq3_xxs", "swift", "sonnet-5.5"),
                                    ("strata-coder-iq3_s", "coder", "gpt-5.3-codex"),
                                    ("strata-unsloth-q8_0", "unsloth", "opus-5.5"),
                                    ("strata-nvfp4-nvfp4", "nvfp4", "opus-5.5"),
                                    ("strata-qwen36-q4_k_m", "qwen36", "sonnet-5.5")):
            ident = pricing.identify(config_stem=stem)
            self.assertEqual(ident["family"], fam, stem)
            self.assertEqual(ident["baseline"], baseline, stem)
            self.assertTrue(ident["known"], stem)

    def test_the_model_id_names_the_family_when_the_config_does_not(self):
        for name, fam in (("swift-1.5-iq3_xxs", "swift"),
                          ("qwen3.8-flash-next-coder-iq3_s", "coder"),
                          ("qwen3.8-flash-next-unsloth-q8_0", "unsloth"),
                          ("qwen3.8-flash-next-nvfp4", "nvfp4"),
                          ("qwen3.6-35b-a3b-q4_k_m", "qwen36"),
                          ("qwen3.8-flash-next-q8_0", "qwen")):
            ident = pricing.identify(model_name=name)
            self.assertEqual(ident["family"], fam, name)

    def test_a_coder_is_not_read_as_the_model_it_was_built_from(self):
        # the longest name wins: coder's id starts with the original model's id
        ident = pricing.identify(config_stem="strata-coder-iq3_s", model_name="qwen3.8-flash-next-coder-iq3_s")
        self.assertEqual(ident["family"], "coder")
        self.assertEqual(ident["baseline"], "gpt-5.3-codex")

    def test_the_model_files_name_the_family_when_neither_the_config_nor_the_id_does(self):
        ident = pricing.identify(config_stem="strata-run", model_name="strata",
                                 paths=["--pack", "D:/Strata/Strata-data/packs/unsloth-iq3_s",
                                        "--native", "D:/models/Qwen3.8-Flash-Next-Unsloth-IQ3_S.gguf"])
        self.assertEqual(ident["family"], "unsloth")
        self.assertEqual(ident["quant"], "IQ3_S")
        self.assertIn("path", ident["evidence"])

    def test_a_quant_suffix_never_decides_the_family(self):
        # requirement 5: the quant is the size, read after the family
        for stem, name, fam, quant in (("strata-swift-ud-iq4_xs", "swift-1.5-ud-iq4_xs", "swift", "UD-IQ4_XS"),
                                       ("strata-swift-q8_0", "swift-1.5-q8_0", "swift", "Q8_0"),
                                       ("strata-swift-iq2_xs", "swift-1.5-iq2_xs", "swift", "IQ2_XS"),
                                       ("strata-coder-q4_k_m", "qwen3.8-flash-next-coder-q4_k_m", "coder", "Q4_K_M")):
            ident = pricing.identify(config_stem=stem, model_name=name)
            self.assertEqual(ident["family"], fam, stem)
            self.assertEqual(ident["quant"], quant, stem)

    def test_a_file_name_with_the_quant_after_the_name_is_read(self):
        ident = pricing.identify(config_stem="strata-swift-iq3_xxs", model_name="swift-1.5-iq3_xxs",
                                 paths=["--native",
                                         "D:/Strata/Strata-data/models/Swift-Qwen3.8-Flash-Next-GSQ-RCO"
                                         "-IQ3_XXS-00001-of-00002.gguf"])
        self.assertEqual(ident["family"], "swift")
        self.assertEqual(ident["quant"], "IQ3_XXS")

    def test_an_unknown_model_gets_no_family_and_no_price(self):
        # requirement 6: no guessing, and no price applied to a model the module cannot name
        ident = pricing.identify(config_stem="strata-my-own-merge", model_name="my-own-merge-v3", paths=[])
        self.assertFalse(ident["known"])
        self.assertIsNone(ident["family"])
        self.assertIsNone(ident["baseline"])
        self.assertIsNone(ident["family_title"])
        self.assertEqual(pricing.price_of(None), None)
        self.assertEqual(pricing.price_of("my-own-merge-v3"), None)
        c = pricing.compute_cost({"input_tokens": 1_000_000, "cached_input_tokens": 0, "output_tokens": 100_000},
                                 pricing.price_of(ident["baseline"]), 0.7)
        self.assertAlmostEqual(c["total_cost"], 0.0, places=9)

    def test_the_evidence_says_which_signal_decided(self):
        self.assertIn("config:swift-iq3_xxs",
                      pricing.identify(config_stem="strata-swift-iq3_xxs")["evidence"])
        self.assertIn("model:swift-1.5-iq3_xxs",
                      pricing.identify(model_name="swift-1.5-iq3_xxs")["evidence"])


class CostSettings(unittest.TestCase):
    """The card's own file: a price, a baseline, the USD/TWD rate, the assumed cache hit; the defaults need no file."""

    def setUp(self):
        self.tmp = Scratch()
        self.path = self.tmp.path / "strata-swift-iq3_xxs.cost.json"
        self.settings = pricing.Settings()
        self.settings.enable(str(self.path))

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_defaults_need_no_file_and_the_view_shows_them(self):
        self.assertFalse(self.path.exists())
        view = self.settings.view()
        self.assertEqual(view["usd_twd"], pricing.DEFAULT_USD_TWD)
        self.assertEqual(view["cache_assumption"], pricing.DEFAULT_CACHE_ASSUMPTION)
        self.assertEqual(view["prices"], {})
        self.assertFalse(view["changed"])
        self.assertEqual({m["id"] for m in view["models"]}, set(pricing.PAID_MODELS))
        for model in view["models"]:
            self.assertEqual(model["input"], pricing.PAID_MODELS[model["id"]]["input"])

    def test_a_change_survives_a_restart_and_the_file_is_the_users_only(self):
        self.settings.apply({"prices": {"opus-5.5": {"input": 5.0}}, "usd_twd": 30.5})
        self.assertTrue(self.path.exists())
        again = pricing.Settings()
        again.enable(str(self.path))
        self.assertEqual(again.view()["usd_twd"], 30.5)
        self.assertEqual(again.view()["prices"]["opus-5.5"]["input"], 5.0)
        self.assertTrue(again.view()["changed"])
        self.assertEqual(again.view()["defaults"]["usd_twd"], pricing.DEFAULT_USD_TWD)
        self.assertEqual(pricing.price_of("opus-5.5", again.view()["prices"])["input"], 5.0)
        self.assertTrue(pricing.price_of("opus-5.5", again.view()["prices"])["overridden"])

    def test_restoring_the_defaults_deletes_the_file(self):
        self.settings.apply({"prices": {"opus-5.5": {"output": 30.0}}, "cache_assumption": 0.5})
        self.assertTrue(self.path.exists())
        self.assertTrue(self.settings.clear())
        self.assertFalse(self.path.exists())
        view = self.settings.view()
        self.assertEqual(view["cache_assumption"], pricing.DEFAULT_CACHE_ASSUMPTION)
        self.assertEqual(view["prices"], {})
        self.assertFalse(view["changed"])
        self.assertEqual(pricing.price_of("opus-5.5")["output"], 20.00)

    def test_a_number_that_is_not_a_price_is_refused(self):
        for req in ({"prices": {"no-such-model": {"input": 1}}},
                    {"prices": {"opus-5.5": "not an object"}},
                    {"prices": {"opus-5.5": {"input": -1}}},
                    {"prices": {"opus-5.5": {"input": "4"}}},
                    {"prices": {"opus-5.5": {"input": True}}},
                    {"prices": {"opus-5.5": {"output": 100_000}}},
                    {"baselines": {"no-such-family": "opus-5.5"}},
                    {"baselines": {"swift": "no-such-model"}},
                    {"usd_twd": 0},
                    {"usd_twd": -3},
                    {"usd_twd": "32"},
                    {"cache_assumption": 70},
                    {"cache_assumption": -0.1},
                    "not an object"):
            with self.assertRaises(ValueError, msg=str(req)):
                self.settings.apply(req)
        self.assertFalse(self.path.exists(), "a refused change must not write a file")

    def test_a_baseline_the_user_picked_wins_over_the_pairing_table(self):
        self.assertEqual(self.settings.baseline_for("swift"), ("sonnet-5.5", False))
        self.settings.apply({"baselines": {"swift": "opus-5.5"}})
        self.assertEqual(self.settings.baseline_for("swift"), ("opus-5.5", True))
        self.settings.clear()
        self.assertEqual(self.settings.baseline_for("swift"), ("sonnet-5.5", False))

    def test_an_unreadable_file_starts_from_the_defaults_and_says_why(self):
        self.path.write_text("{ not json", encoding="utf-8")
        settings = pricing.Settings()
        settings.enable(str(self.path))
        self.assertEqual(settings.view()["usd_twd"], pricing.DEFAULT_USD_TWD)
        self.assertTrue(settings.view()["error"])

    def test_a_file_that_cannot_be_written_never_loses_the_change(self):
        # the card keeps working: a cost file that cannot be saved is not a reason for a request to fail
        self.settings.enable(str(self.tmp.path / "no-such-directory" / "cost.json"))
        self.settings.apply({"usd_twd": 29.0})
        self.assertEqual(self.settings.view()["usd_twd"], 29.0)


class CostCardOverHttp(unittest.TestCase):
    """The card's two endpoints, on a real server: the figures ride in the chart's own read, and the card's
    settings go through POST /api/usage/cost.  No native model, no GPU, no paid API."""

    def setUp(self):
        self.tmp = Scratch()
        tok = ByteTokenizer()
        self.svc = Service(MockEngine(tok, "Hello.", max_context=4096), tok, ChatTemplate(TEMPLATE),
                           model_name="swift-1.5-iq3_xxs")
        self.svc.config_stem = "strata-swift-iq3_xxs"
        self.svc.model_paths = ["--pack", "D:/Strata/Strata-data/packs/swift-iq3_xxs"]
        self.svc.cost.enable(str(self.tmp.path / "strata-swift-iq3_xxs.cost.json"))
        self.svc.usage.enable(str(self.tmp.path / "strata-swift-iq3_xxs.usage.json"))
        self.httpd = serve(self.svc, port=0)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=10) as response:
            return response.status, json.loads(response.read().decode())

    def post(self, body):
        req = urllib.request.Request(self.base + "/api/usage/cost",
                                     data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            response = urllib.request.urlopen(req, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read().decode())

    def card(self):
        """The cost card inside the chart's own read: GET /api/usage answers the chart and the card together."""
        return self.get("/api/usage?days=14")[1]["cost"]

    def test_the_cost_figures_ride_in_the_charts_own_read(self):
        status, payload = self.get("/api/usage?days=14")
        self.assertEqual(status, 200)
        card = payload["cost"]
        self.assertEqual(card["model"]["family"], "swift")
        self.assertEqual(card["model"]["baseline"], "sonnet-5.5")
        self.assertTrue(card["model"]["verified"], "the user confirmed this price table, and the card says so")
        self.assertEqual(set(card["scopes"]), {"session", "today", "history"})
        self.assertTrue(card["scopes"]["session"]["reliable"])
        self.assertTrue(card["scopes"]["history"]["reliable"], "the daily counts are kept on disk here")
        self.assertEqual({m["id"] for m in card["settings"]["models"]}, set(pricing.PAID_MODELS))
        self.assertIn("usd_twd", card["settings"])

    def test_the_card_prices_the_same_counts_the_chart_draws(self):
        self.svc.totals.update({"prompt_tokens": 1_000_000, "reused": 700_000, "output_tokens": 100_000})
        card = self.card()
        session = card["scopes"]["session"]
        self.assertEqual(session["tokens"]["input_tokens"], 1_000_000)
        self.assertEqual(session["tokens"]["cached_input_tokens"], 700_000)
        expected = pricing.compute_cost(session["tokens"], pricing.price_of("sonnet-5.5"),
                                        card["settings"]["cache_assumption"])
        self.assertAlmostEqual(session["cost"]["total_cost"], expected["total_cost"], places=6)
        self.assertAlmostEqual(session["cost"]["total_cost"], 300_000 * 2.00 / 1e6 + 700_000 * 0.10 / 1e6
                               + 100_000 * 10.00 / 1e6, places=6)
        self.assertFalse(session["cost"]["assumed_cache"], "the run's cache is measured, so it is not an assumption")

    def test_reading_the_card_twice_adds_nothing(self):
        # requirement 8: the card is a read, not a counter - two reads of the same counts answer the same
        self.svc.totals.update({"prompt_tokens": 500_000, "reused": 100_000, "output_tokens": 50_000})
        _, first = self.get("/api/usage?days=14")
        _, second = self.get("/api/usage?days=14")
        self.assertEqual(first["cost"]["scopes"]["session"]["cost"]["total_cost"],
                         second["cost"]["scopes"]["session"]["cost"]["total_cost"])
        self.assertEqual(first["cost"]["scopes"]["session"]["tokens"],
                         second["cost"]["scopes"]["session"]["tokens"])
        # a new run starts from nothing: the counts of the run that ended are not added to the next
        self.svc.totals.update({"prompt_tokens": 0, "reused": 0, "output_tokens": 0, "since": 0.0})
        _, third = self.get("/api/usage?days=14")
        self.assertAlmostEqual(third["cost"]["scopes"]["session"]["cost"]["total_cost"], 0.0, places=9)

    def test_the_window_is_priced_at_the_reuse_each_day_measured(self):
        self.svc.usage.record(input_tokens=1_000_000, output_tokens=100_000, reused_tokens=700_000)
        history = self.card()["scopes"]["history"]
        self.assertEqual(history["tokens"]["input_tokens"], 1_000_000)
        self.assertEqual(history["tokens"]["cached_input_tokens"], 700_000)
        self.assertEqual((history["cost"]["days_measured"], history["cost"]["days_assumed"]), (1, 0))
        self.assertFalse(history["cost"]["assumed_cache"], "this day measured its reuse, so it is not an estimate")
        sonnet = pricing.price_of("sonnet-5.5")
        self.assertAlmostEqual(history["cost"]["total_cost"],
                               300_000 * sonnet["input"] / 1e6 + 700_000 * sonnet["cached_input"] / 1e6
                               + 100_000 * sonnet["output"] / 1e6, places=6)

    def test_a_day_older_than_the_reuse_count_is_priced_at_the_assumption(self):
        # a count file written before reuse was tracked: the card prices it, and marks it as an assumption
        path = Path(self.tmp.path) / "strata-swift-iq3_xxs.usage.json"
        Path(path).write_text(json.dumps({"version": 1, "days": {
            date.today().isoformat(): {"input_tokens": 1_000_000, "output_tokens": 0, "requests": 1}}}),
            encoding="utf-8")
        self.svc.usage.enable(str(path))
        history = self.card()["scopes"]["history"]
        self.assertEqual((history["cost"]["days_measured"], history["cost"]["days_assumed"]), (0, 1))
        self.assertTrue(history["cost"]["assumed_cache"])
        self.assertEqual(history["tokens"]["cached_input_tokens"], 700_000)

    def test_a_scope_the_server_cannot_reach_says_so(self):
        self.svc.usage.enable(None)                     # the counts live in memory only: no day to price
        card = self.card()
        self.assertFalse(card["usage"]["persistent"])
        self.assertFalse(card["scopes"]["today"]["reliable"])
        self.assertFalse(card["scopes"]["history"]["reliable"])
        self.assertTrue(card["scopes"]["session"]["reliable"], "the run's own counts are always the run's own")

    def test_a_price_the_user_types_is_used_at_once(self):
        status, answer = self.post({"prices": {"sonnet-5.5": {"output": 12.5}}})
        self.assertEqual(status, 200)
        self.assertIn("sonnet-5.5.output", answer["changed"])
        self.svc.totals.update({"prompt_tokens": 0, "reused": 0, "output_tokens": 1_000_000})
        card = self.card()
        self.assertAlmostEqual(card["scopes"]["session"]["cost"]["output_cost"], 12.5, places=6)

    def test_the_cards_settings_are_its_own_file_never_the_run_config(self):
        self.post({"usd_twd": 31.25, "cache_assumption": 0.4, "baselines": {"swift": "opus-5.5"}})
        path = self.tmp.path / "strata-swift-iq3_xxs.cost.json"
        self.assertTrue(path.exists())
        saved = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(saved["usd_twd"], 31.25)
        self.assertEqual(saved["baselines"], {"swift": "opus-5.5"})
        card = self.card()
        self.assertEqual(card["model"]["baseline"], "opus-5.5")
        self.assertTrue(card["model"]["picked"])
        self.assertAlmostEqual(card["scopes"]["session"]["cost"]["total_cost"],
                               pricing.compute_cost(card["scopes"]["session"]["tokens"],
                                                    pricing.price_of("opus-5.5"), 0.4)["total_cost"], places=6)

    def test_reset_goes_back_to_the_prices_the_project_ships(self):
        self.post({"prices": {"opus-5.5": {"input": 9.0}}})
        status, answer = self.post({"reset": True})
        self.assertEqual(status, 200)
        self.assertTrue(answer["reset"])
        self.assertEqual(answer["settings"]["prices"], {})
        self.assertFalse((self.tmp.path / "strata-swift-iq3_xxs.cost.json").exists())

    def test_a_bad_price_is_refused_and_changes_nothing(self):
        status, answer = self.post({"prices": {"opus-5.5": {"input": -2}}})
        self.assertEqual(status, 400)
        self.assertIn("message", answer["error"])
        self.assertFalse((self.tmp.path / "strata-swift-iq3_xxs.cost.json").exists())
        card = self.card()
        self.assertEqual(card["settings"]["prices"], {})

    def test_the_card_never_asks_the_server_to_talk_to_a_paid_api(self):
        # the endpoints are local reads and writes: no key, no network, nothing sent anywhere
        status, answer = self.post({"prices": {"gpt-5.3-codex": {"input": 2.0}}})
        self.assertEqual(status, 200)
        self.assertNotIn("api_key", json.dumps(answer).lower())
        self.assertNotIn("sk-", json.dumps(answer))


if __name__ == "__main__":
    unittest.main()
