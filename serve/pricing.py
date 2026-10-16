"""serve/pricing.py - the Monitor's "Estimated API Cost Equivalent": what the same tokens would have cost
through a paid API, as a way to read what running the model on this PC is worth.

Nothing here talks to a cloud service, and nothing here is a bill.  Strata counts the tokens the local model
actually read and wrote (serve/usage.py for the days, Service.totals for the current run); this module turns
those counts into money at the prices of a paid model chosen as a comparison baseline.  The local model is
never charged, never contacted, and never changed by any of it.

Three things live here, in one place on purpose:

  * PAID_MODELS - every price in the project.  The UI shows what this module answers, so a price never has to
    be typed into a template or repeated in a second calculation.
  * identify() - which local model is loaded, from the run config's own name, the model id the server answers
    with, and the model files the engine was given.  It never guesses: no positive match is "unknown", and
    unknown gets no price.
  * Settings - what the user changed (a price, the comparison baseline, the USD/TWD rate, the assumed cache
    hit rate), kept in strata-<model>.cost.json next to the run config.  The run config itself is never
    written: the cost card adds a file of its own, and "restore the defaults" deletes it.

    python -m unittest serve.test_pricing
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

PER_MILLION = 1_000_000          # every price below is USD per 1,000,000 tokens, the unit the API price lists use
CURRENCY = "USD"
PRICING_VERSION = "2026-10-16-b"  # the price table in use, shown in the card next to the last checked date
DEFAULT_CACHE_ASSUMPTION = 0.70   # hit rate used when a count has no measured cache figure (labelled as an assumption)
DEFAULT_USD_TWD = 32.0            # a starting rate the user sets; nothing here reads a live exchange rate

# The paid models a local run is compared with.  `verified` is true for all three: the user confirmed
# these figures on 2026-10-16, and the card shows that state beside the price table's version.
# A model added later starts `verified: False` until it is confirmed the same way.
# `long_context` and `tiers` are the shape of the fields to fill in once a price list with a long-context
# surcharge or a service tier is confirmed - the calculation ignores them until it does.
# `long_context` and `tiers` are the shape of the fields to fill in once a price list with a long-context
# surcharge or a service tier is confirmed - the calculation ignores them until it does.
PAID_MODELS = {
    "opus-5.5": {
        "title": "Claude Opus 5.5",
        "input": 4.00, "cached_input": 0.20, "output": 20.00,
        "source": "https://platform.claude.com/docs/en/about-claude/pricing",
        "currency": CURRENCY, "effective": "2026-10-16", "checked": "2026-10-16", "verified": True,
        "notes": "Confirmed by the user on 2026-10-16 against the vendor price page.",
        "long_context": None, "tiers": None,
    },
    "sonnet-5.5": {
        "title": "Claude Sonnet 5.5",
        "input": 2.00, "cached_input": 0.10, "output": 10.00,
        "source": "https://platform.claude.com/docs/en/about-claude/pricing",
        "currency": CURRENCY, "effective": "2026-10-16", "checked": "2026-10-16", "verified": True,
        "notes": "Confirmed by the user on 2026-10-16 against the vendor price page.",
        "long_context": None, "tiers": None,
    },
    "gpt-5.3-codex": {
        "title": "GPT-5.3-Codex",
        "input": 1.75, "cached_input": 0.175, "output": 14.00,
        "source": "https://developers.openai.com/api/docs/pricing",
        "currency": CURRENCY, "effective": "2026-10-16", "checked": "2026-10-16", "verified": True,
        "notes": "Confirmed by the user on 2026-10-16 against the vendor price page.",
        "long_context": None, "tiers": None,
    },
}

# The local families, mirrored from setup.py's FAMILIES and OWN_PATH_FAMILIES (its `tag`, `name` and `title`).
# Kept here as a copy on purpose: serve/ must not import setup.py, which downloads, installs and asks questions.
# When setup.py adds a family, this table and FAMILY_BASELINES take one more line each.
LOCAL_FAMILIES = {
    "qwen": {"tag": "", "name": "qwen3.8-flash-next", "title": "Qwen3.8-Flash-Next"},
    "swift": {"tag": "swift-", "name": "swift-1.5", "title": "Swift 1.5"},
    "coder": {"tag": "coder-", "name": "qwen3.8-flash-next-coder", "title": "Qwen3.8-Flash-Next Coder"},
    "unsloth": {"tag": "unsloth-", "name": "qwen3.8-flash-next-unsloth", "title": "Qwen3.8-Flash-Next (Unsloth)"},
    "nvfp4": {"tag": "nvfp4-", "name": "qwen3.8-flash-next-nvfp4", "title": "Qwen3.8-Flash-Next (NVFP4)"},
    "qwen36": {"tag": "qwen36-", "name": "qwen3.6-35b-a3b", "title": "Qwen3.6-35B-A3B"},
}

# Which paid model each family is compared with by default.  A comparison for money, not a claim that the two
# models are equally able.
FAMILY_BASELINES = {
    "qwen": "opus-5.5",
    "swift": "sonnet-5.5",
    "coder": "gpt-5.3-codex",
    "unsloth": "opus-5.5",
    "nvfp4": "opus-5.5",
    "qwen36": "sonnet-5.5",
}

# The quant suffixes, longest first: a file name carries the quant after the model's name
# (Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf), and the suffix must never be what decides
# the family - it only names the size.
QUANTS = ["UD-Q4_K_XL", "UD-Q5_K_XL", "UD-Q6_K_XL", "UD-IQ4_XS", "UD-Q4_K_S", "UD-Q3_K_XL",
          "IQ3_XXS", "IQ3_XS", "IQ3_S", "IQ3_M", "IQ2_XXS", "IQ2_XS", "IQ2_S", "IQ2_M", "IQ1_M", "IQ1_S",
          "Q2_K", "Q3_K_S", "Q3_K_M", "Q3_K_L", "Q4_K_S", "Q4_K_M", "Q5_K_S", "Q5_K_M", "Q6_K", "Q8_0",
          "NVFP4", "BF16", "F16"]

# Words in a model path that name a family on their own (a pack directory, a GGUF name, a Hugging Face repo).
PATH_SIGNS = {"swift": "swift", "coder": "coder", "unsloth": "unsloth", "nvfp4": "nvfp4",
              "qwen36": "qwen3.6-35b-a3b", "qwen36b": "qwen36"}


def quant_of(text) -> str | None:
    """The quantization a file name or model id names (IQ3_XXS, UD-IQ4_XS, Q8_0, ...), or None.

    Only the size: it is read after the family, so a suffix can never turn a Swift file into a Qwen one."""
    t = str(text or "").upper()
    for q in QUANTS:
        if q.upper() in t:
            return q
    return None


def _family_by_tag(tag: str):
    """The family a run config's own name names: strata-swift-iq3_xxs.json is Swift, strata-coder-iq3_s.json is Coder.

    The longest tag wins, and the empty tag of the original model is kept for last: qwen36- is checked before
    the bare qwen, and a config named for a quant alone (strata-iq3_s.json) is the original model."""
    best = None
    for fam, d in LOCAL_FAMILIES.items():
        t = d["tag"]
        if t and tag.startswith(t):
            if best is None or len(t) > len(LOCAL_FAMILIES[best]["tag"]):
                best = fam
    return best


def _family_by_name(name: str):
    """The family a model id names: swift-1.5-iq3_xxs starts with swift-1.5, and
    qwen3.8-flash-next-coder starts with qwen3.8-flash-next, so the longest name is matched first."""
    n = str(name or "").strip().lower()
    if not n:
        return None
    for fam, d in sorted(LOCAL_FAMILIES.items(), key=lambda kv: -len(kv[1]["name"])):
        if n.startswith(d["name"].lower()):
            return fam
    return None


def _family_by_path(paths) -> tuple[str | None, str | None]:
    """The family a model file or pack directory names, and the quant it names.

    The engine is given --native/--ple-gguf and --pack paths; their names carry the family (Swift-...,
    ...-Coder-..., unsloth, nvfp4, Qwen3.6-35B-A3B).  Returns (family, quant)."""
    quant = None
    family = None
    for p in paths or ():
        s = str(p)
        if not s:
            continue
        if quant is None:
            quant = quant_of(s)
        low = s.lower()
        for key, sign in PATH_SIGNS.items():
            if sign in low:
                family = "qwen36" if key == "qwen36b" else key
                return family, quant
    return family, quant


def identify(config_stem=None, model_name=None, paths=()) -> dict:
    """Which local model is loaded, and the paid model it is compared with.

    Three real signals, in order of strength: the run config's own name (the tag setup.py wrote), the model id
    the server answers with (Service.model), and the model files the engine was given.  The first one that
    matches decides the family; the others only add evidence.

    No match is "unknown": family None, no baseline, no price.  Guessing a price for a model this module
    cannot name would put a made-up number in front of the user, which is the one thing a cost card must not do."""
    stem = str(config_stem or "")
    if stem.startswith("strata-"):
        stem = stem[len("strata-"):]
    evidence = []
    family = _family_by_tag(stem)
    if family:
        evidence.append(f"config:{stem}")
    if not family:
        family = _family_by_name(model_name)
        if family:
            evidence.append(f"model:{model_name}")
    if not family:
        family, path_quant = _family_by_path(paths)
        if family:
            evidence.append("path")
    quant = quant_of(stem) or quant_of(model_name)
    if not quant:
        quant = _family_by_path(paths)[1]
    known = family is not None
    return {"family": family,
            "family_title": LOCAL_FAMILIES[family]["title"] if known else None,
            "variant": LOCAL_FAMILIES[family]["name"] if known else None,
            "quant": quant,
            "known": known,
            "baseline": FAMILY_BASELINES.get(family) if known else None,
            "evidence": evidence}


def price_of(model_id, overrides=None) -> dict | None:
    """The price table of one paid model, with the user's overrides applied.  None for an unknown model id.

    The only reader of PAID_MODELS: the card, the API and the calculation all come through here, so a price
    lives in exactly one place."""
    base = PAID_MODELS.get(model_id)
    if not base:
        return None
    out = dict(base)
    got = (overrides or {}).get(model_id) or {}
    for k in ("input", "cached_input", "output"):
        v = got.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
            out[k] = float(v)
    out["overridden"] = any(k in out and out[k] != base[k] for k in ("input", "cached_input", "output"))
    return out


def compute_cost(tokens, prices, cache_assumption=DEFAULT_CACHE_ASSUMPTION) -> dict:
    """The money for a set of token counts, at one paid model's prices.

    tokens takes `input_tokens` (the whole prompt, cache included - Strata's counts are that way),
    `cached_input_tokens` (the part the conversation cache already held) and `output_tokens` (the answer,
    thinking included).  A count that is None is not measured, which is what makes the cache an assumption.

    The cache is priced, never dropped and never free: the prompt is split into what the API would have had to
    read (the full price) and what it would have found in its own cache (the cache price), and the two are
    added.  The cached part is never counted twice, and the answer is never counted twice for its thinking."""
    prices = prices or {}
    inp_total = _num(tokens.get("input_tokens"))
    out_total = _num(tokens.get("output_tokens"))
    cached = tokens.get("cached_input_tokens")
    assumed = cached is None
    if assumed:
        cached = round(inp_total * max(0.0, min(1.0, float(cache_assumption))))
    cached = min(_num(cached), inp_total)
    uncached = max(0, inp_total - cached)
    in_price = float(prices.get("input") or 0.0)
    cache_price = float(prices.get("cached_input") or 0.0)
    out_price = float(prices.get("output") or 0.0)
    input_cost = uncached * in_price / PER_MILLION
    cached_cost = cached * cache_price / PER_MILLION
    output_cost = out_total * out_price / PER_MILLION
    return {
        "input_tokens": inp_total,
        "cached_input_tokens": cached,
        "uncached_input_tokens": uncached,
        "output_tokens": out_total,
        "input_cost": input_cost,
        "cached_input_cost": cached_cost,
        "output_cost": output_cost,
        "total_cost": input_cost + cached_cost + output_cost,
        "cache_hit_rate": (cached / inp_total) if inp_total else 0.0,
        "assumed_cache": assumed,
    }


def price_days(rows, prices, cache_assumption=DEFAULT_CACHE_ASSUMPTION) -> dict:
    """The money for a window of days: each day priced on its own, then added.

    A window is not one number.  The days whose reuse Strata measured (serve/usage.py keeps a
    `reused_tokens` count per day) are priced at their own measured reuse; only the days with no reuse
    figure of their own - a count file written before reuse was tracked - fall back to the assumed hit
    rate.  One share over a whole window cannot say that: it would price a measured day at a number it
    never measured, and an unmeasured day at its neighbour's reuse.

    `rows` are day rows: `input_tokens`, `output_tokens` and `cached_input_tokens`, the last None when
    that day's reuse was never measured.  The answer is compute_cost's shape, so the card reads a
    window and a single day the same way, plus how many of its days came from a measurement and how
    many from the assumption (a day that read nothing is neither: it costs nothing)."""
    total = {"input_tokens": 0, "cached_input_tokens": 0, "uncached_input_tokens": 0,
             "output_tokens": 0, "input_cost": 0.0, "cached_input_cost": 0.0,
             "output_cost": 0.0, "total_cost": 0.0, "cache_hit_rate": 0.0,
             "assumed_cache": False, "days_measured": 0, "days_assumed": 0}
    for row in rows or ():
        if not isinstance(row, dict):
            continue
        one = compute_cost({"input_tokens": row.get("input_tokens"),
                            "output_tokens": row.get("output_tokens"),
                            "cached_input_tokens": row.get("cached_input_tokens")},
                           prices, cache_assumption)
        for key in ("input_tokens", "cached_input_tokens", "uncached_input_tokens", "output_tokens",
                    "input_cost", "cached_input_cost", "output_cost", "total_cost"):
            total[key] += one[key]
        if one["input_tokens"]:
            if one["assumed_cache"]:
                total["assumed_cache"] = True
                total["days_assumed"] += 1
            else:
                total["days_measured"] += 1
    inp = total["input_tokens"]
    total["cache_hit_rate"] = (total["cached_input_tokens"] / inp) if inp else 0.0
    return total


def _num(v) -> int:
    """A token count: a whole number, never negative, never a bool (True is not one token)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return 0
    return max(0, int(v))


def money(value, currency=CURRENCY) -> str:
    """A money figure for the card: $0.000012 under a cent (where a session's cost lives), $1,234.56 above it."""
    v = float(value or 0.0)
    sign = "-" if v < 0 else ""
    v = abs(v)
    if v == 0:
        return f"{sign}$0.00"   # an empty run reads as $0.00, not as $0.0
    body = f"{v:,.2f}" if v >= 1 else f"{v:.6f}".rstrip("0")
    if body.endswith("."):
        body += "0"
    return f"{sign}${body}"


class Settings:
    """What the user changed about the cost card, and the file those changes live in.

    Prices, the comparison baseline, the USD/TWD rate and the assumed cache hit rate.  Defaults are the module's
    own values, so "restore the defaults" needs no file to read: it deletes the file and answers from here.

    The file is written whole through a temporary name, as serve/runconfig.py and serve/usage.py do, so a
    crash mid-write cannot leave a half-written cost file.  A file that cannot be read starts from the
    defaults and says why; a cost card that cannot be saved is never a reason for a request to fail."""

    def __init__(self):
        self._lock = threading.RLock()   # reentrant: load() holds the lock while it calls apply()
        self.path = None
        self.prices = {}          # {model_id: {input, cached_input, output}} - only the keys the user changed
        self.baselines = {}       # {family: model_id} - a baseline the user picked over the module's pairing
        self.usd_twd = DEFAULT_USD_TWD
        self.cache_assumption = DEFAULT_CACHE_ASSUMPTION
        self.error = None

    # ------------------------------------------------------------------ the file
    def enable(self, path) -> None:
        """Keep the user's changes in `path` and read what is already there.  Called once, at startup."""
        self.path = Path(path) if path else None
        if self.path:
            self.load()

    def load(self) -> None:
        if not self.path:
            return
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as e:
            self.error = str(e)
            print(f"[strata] {self.path.name} is not readable ({e}): the cost card uses its default prices",
                  flush=True)
            return
        if not isinstance(saved, dict):
            return
        with self._lock:
            self.apply(saved, save=False)

    def save(self) -> None:
        if not self.path:
            return
        with self._lock:
            body = json.dumps({"version": 1,
                               "prices": self.prices,
                               "baselines": self.baselines,
                               "usd_twd": self.usd_twd,
                               "cache_assumption": self.cache_assumption}, indent=1)
        try:
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text(body, encoding="utf-8")
            os.replace(tmp, self.path)
            self.error = None
        except OSError as e:
            self.error = str(e)

    def clear(self) -> bool:
        """Back to the module's defaults: the file is deleted, so the next start has nothing to read."""
        with self._lock:
            self.prices = {}
            self.baselines = {}
            self.usd_twd = DEFAULT_USD_TWD
            self.cache_assumption = DEFAULT_CACHE_ASSUMPTION
        gone = False
        if self.path and self.path.exists():
            try:
                self.path.unlink()
                gone = True
                self.error = None
            except OSError as e:
                self.error = str(e)
        return gone

    # ------------------------------------------------------------------ the changes
    def apply(self, req, save: bool = True) -> list:
        """Take the card's changes in, checking every number.  Returns the names of what changed.

        A price is a number of USD per million tokens, the cache hit rate a share, the rate a positive number
        of TWD for one USD, a baseline a model this module knows.  Anything else raises ValueError, which the
        server answers as a 400 - a typo in a price must not become a cost shown as a fact."""
        if not isinstance(req, dict):
            raise ValueError("the cost settings must be an object")
        changed = []
        with self._lock:
            p = req.get("prices")
            if p is not None:
                if not isinstance(p, dict):
                    raise ValueError("\"prices\" must be an object of model ids")
                for model_id, table in p.items():
                    if model_id not in PAID_MODELS:
                        raise ValueError(f"\"{model_id}\" is not a paid model of this project")
                    if not isinstance(table, dict):
                        raise ValueError(f"the price of {model_id} must be an object")
                    for k in ("input", "cached_input", "output"):
                        if k not in table:
                            continue
                        v = table[k]
                        if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0 or v > 10_000:
                            raise ValueError(f"the {k} price of {model_id} must be a number of USD "
                                             f"per million tokens between 0 and 10000")
                        got = self.prices.setdefault(model_id, {})
                        if got.get(k) != round(float(v), 6):
                            got[k] = round(float(v), 6)
                            changed.append(f"{model_id}.{k}")
            b = req.get("baselines")
            if b is not None:
                if not isinstance(b, dict):
                    raise ValueError("\"baselines\" must be an object of model families")
                for fam, model_id in b.items():
                    if fam not in LOCAL_FAMILIES:
                        raise ValueError(f"\"{fam}\" is not a model family of this project")
                    if model_id not in PAID_MODELS:
                        raise ValueError(f"\"{model_id}\" is not a paid model of this project")
                    if self.baselines.get(fam) != model_id:
                        self.baselines[fam] = model_id
                        changed.append(f"baseline.{fam}")
            if req.get("usd_twd") is not None:
                v = req["usd_twd"]
                if isinstance(v, bool) or not isinstance(v, (int, float)) or v <= 0 or v > 1_000:
                    raise ValueError("\"usd_twd\" must be a positive number of TWD for one USD")
                if self.usd_twd != round(float(v), 4):
                    self.usd_twd = round(float(v), 4)
                    changed.append("usd_twd")
            if req.get("cache_assumption") is not None:
                v = req["cache_assumption"]
                if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0 or v > 1:
                    raise ValueError("\"cache_assumption\" must be a share between 0 and 1")
                if self.cache_assumption != round(float(v), 4):
                    self.cache_assumption = round(float(v), 4)
                    changed.append("cache_assumption")
        if changed and save:
            self.save()
        return changed

    # ------------------------------------------------------------------ the answers
    def baseline_for(self, family) -> tuple[str | None, bool]:
        """The paid model to compare a family with, and whether the user picked it (True) or the module paired it."""
        with self._lock:
            picked = self.baselines.get(family)
        if picked and picked in PAID_MODELS:
            return picked, True
        return FAMILY_BASELINES.get(family), False

    def view(self) -> dict:
        """Everything the card needs to draw and to recalculate on its own: the prices, the pairings, the settings."""
        with self._lock:
            prices = dict(self.prices)
            baselines = dict(self.baselines)
            rate, assumption = self.usd_twd, self.cache_assumption
        return {
            "version": PRICING_VERSION,
            "currency": CURRENCY,
            "prices": prices,   # only what the user changed, per model: the card marks those prices as edited
            "per_million": PER_MILLION,
            "models": [{**price_of(mid, prices), "id": mid} for mid in PAID_MODELS],
            "pairings": {fam: {"family_title": d["title"], "baseline": baselines.get(fam) or FAMILY_BASELINES.get(fam),
                               "picked": fam in baselines}
                         for fam, d in LOCAL_FAMILIES.items()},
            "usd_twd": rate,
            "cache_assumption": assumption,
            "defaults": {"usd_twd": DEFAULT_USD_TWD, "cache_assumption": DEFAULT_CACHE_ASSUMPTION,
                         "prices": {mid: {k: PAID_MODELS[mid][k] for k in ("input", "cached_input", "output")}
                                    for mid in PAID_MODELS},
                         "pairings": dict(FAMILY_BASELINES)},
            "changed": bool(prices or baselines or rate != DEFAULT_USD_TWD
                            or assumption != DEFAULT_CACHE_ASSUMPTION),
            "error": self.error,
        }
