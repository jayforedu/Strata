"""Tests for the web app's language layer (serve/web/i18n.js): the dictionary, the two pages that use it, and
the scripts that build their strings through it.  Plain file checks - no GPU, no server, no downloads.

    python -m unittest serve.test_web_i18n
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

WEB = Path(__file__).parent / "web"

# Glyphs that exist only in Simplified Chinese.  A 繁體中文 UI must not contain one; 启, 与, 到, 系, 立 and
# friends (and 部) are shared with the Traditional standard, so they are not in this list.
SIMPLIFIED_ONLY = set("这们个来为时说话语读写图观开关门问间长对进运动体声东风飞马鸟齐从众变实经线结统继网机极标准确传递应认识发让过于后见议气号业产亿术边车书办处记设试话误请译负较载轮输连远选错钟钥闭闲阅队随离电页项预题显验")

ENTRY = re.compile(r'"([A-Za-z0-9_.]+)"\s*:\s*\{en:\s*"((?:[^"\\]|\\.)*)"\s*,\s*zh:\s*"((?:[^"\\]|\\.)*)"\s*\}')
ATTR = re.compile(r'data-i18n(?:-[a-z]+)?="([^"]+)"')
CALL = re.compile(r'(?:I18N\.t|\bT|\bTK)\(\s*"([^"]+)"')
PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
# A key built at run time: T("metric." + m.key).  The test checks the family exists instead of one key.
DYNAMIC = re.compile(r'(?:I18N\.t|\bT|\bTK)\(\s*"([A-Za-z0-9_.]+\.)"\s*\+')
# English assignments a page may keep: symbols, numbers, units, and formats with no word in them.
BARE = re.compile(r'(?:textContent|title|placeholder)\s*=\s*"([^"]*)"|aria-label",\s*"([^"]*)"|label:\s*"([^"]*)"')
BARE_OK = re.compile(r"^[\W_]*$")
# A badge table built once at load freezes its words in the page's first language, so it holds keys instead.
STATE_TABLE = re.compile(r"const (?:MCP_STATE|TOOL_STATE) = \{(.*?)\};", re.S)

# The model settings form shows one label per key of serve/runconfig.py's EDITABLE list, so the dictionary and
# that list have to name the same keys and the same enum values.
EDITABLE_KEY = re.compile(r'^\s*\("([a-z_.]+)",', re.M)
ENUM_CHOICES = re.compile(r'\("enum",\s*\[([^\]]+)\]\)')


def bare(text):
    """The string with placeholders, punctuation and spacing taken out, for comparing the two languages."""
    return re.sub(r"[^0-9A-Za-z㐀-䶿一-鿿]+", "", PLACEHOLDER.sub("", text)).lower()


def dictionary():
    """i18n.js's STRINGS as {key: (en, zh)}, read straight from the file."""
    src = (WEB / "i18n.js").read_text(encoding="utf-8")
    block = src[src.index("const STRINGS = {"):src.index("function detect(")]
    found = {}
    for key, en, zh in ENTRY.findall(block):
        found[key] = (en, zh)
    return found, src


class Dictionary(unittest.TestCase):
    def setUp(self):
        self.strings, self.src = dictionary()

    def test_the_dictionary_is_there_and_big_enough(self):
        self.assertGreater(len(self.strings), 200, "i18n.js has no STRINGS block to read")

    def test_every_entry_has_both_languages(self):
        # The regex above only matches a complete {en, zh} pair, so a short entry simply goes missing.
        src = self.src[self.src.index("const STRINGS = {"):self.src.index("function detect(")]
        declared = len(re.findall(r'^\s{4}"[A-Za-z0-9_.]+":\s*\{', src, re.M))
        self.assertEqual(declared, len(self.strings),
                         "an entry has no en/zh pair on both sides (see the counts against serve/test_web_i18n.py)")

    def test_every_chinese_side_is_chinese(self):
        for key, (en, zh) in self.strings.items():
            if zh == "" and en == "s":       # the plural marker: English adds an "s", Chinese adds nothing
                continue
            # A technical name (VRAM, Max tokens, tok/s) stays English in both languages, so a Chinese side
            # that is the same words is fine; only one that adds English nobody can translate is not.
            if re.search(r"[㐀-䶿一-鿿]", zh) or bare(en) == bare(zh):
                continue
            self.fail(f"{key}: zh is neither Chinese nor the English it copies: {zh!r}")

    def test_no_simplified_glyphs(self):
        for key, (_, zh) in self.strings.items():
            bad = sorted({c for c in zh if c in SIMPLIFIED_ONLY})
            self.assertEqual(bad, [], f"{key}: Simplified glyph(s) {''.join(bad)} in {zh!r}")

    def test_no_japanese_or_korean(self):
        for key, (_, zh) in self.strings.items():
            self.assertFalse(re.search(r"[぀-ゟ゠-ヿ가-힯]", zh), f"{key}: kana or hangul in {zh!r}")

    def test_placeholders_match(self):
        for key, (en, zh) in self.strings.items():
            self.assertEqual(sorted(PLACEHOLDER.findall(en)), sorted(PLACEHOLDER.findall(zh)),
                             f"{key}: en {en!r} and zh {zh!r} fill different placeholders")

    def test_no_duplicate_keys(self):
        src = self.src[self.src.index("const STRINGS = {"):self.src.index("function detect(")]
        keys = re.findall(r'^\s{4}"([A-Za-z0-9_.]+)":', src, re.M)
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        self.assertEqual(dupes, [], f"keys declared twice: {dupes}")

    def test_the_button_offers_the_other_language(self):
        # "中" while the page is English, "EN" while it is Chinese - the label is picked by the saved language.
        self.assertIn('lang === "zh" ? "EN"', self.src)
        self.assertIn("strata.lang", self.src)
        self.assertIn("zh-Hant", self.src)
        self.assertIn("navigator.language", self.src)
        self.assertIn("localStorage", self.src)
        # Ctrl+L (Cmd+L on a Mac) on both pages, taken over from the browser's address bar.
        self.assertIn("ctrlKey", self.src)
        self.assertIn("metaKey", self.src)
        self.assertIn("preventDefault", self.src)
        self.assertIn("strata:lang", self.src)


class Pages(unittest.TestCase):
    def setUp(self):
        self.strings, _ = dictionary()

    def test_every_attribute_on_a_page_has_a_string(self):
        for name in ("index.html", "monitor.html"):
            html = (WEB / name).read_text(encoding="utf-8")
            used = set(ATTR.findall(html))
            self.assertTrue(used, f"{name} has no data-i18n attributes")
            missing = sorted(used - set(self.strings))
            self.assertEqual(missing, [], f"{name} names keys the dictionary does not have: {missing}")

    def test_every_string_a_script_builds_has_a_key(self):
        for name in ("app.js", "monitor.js"):
            js = (WEB / name).read_text(encoding="utf-8")
            used = set(CALL.findall(js)) - set(DYNAMIC.findall(js))
            missing = sorted(used - set(self.strings))
            self.assertEqual(missing, [], f"{name} builds strings for keys the dictionary does not have: {missing}")

    def test_the_key_families_built_at_run_time_exist(self):
        for name in ("app.js", "monitor.js"):
            js = (WEB / name).read_text(encoding="utf-8")
            for prefix in set(DYNAMIC.findall(js)):
                members = [k for k in self.strings if k.startswith(prefix)]
                self.assertTrue(members, f"{name} uses T(\"{prefix}\" + ...), which has no key")

    def test_both_pages_carry_the_button_and_the_script(self):
        for name in ("index.html", "monitor.html"):
            html = (WEB / name).read_text(encoding="utf-8")
            self.assertIn('id="lang-btn"', html, f"{name} has no language button")
            self.assertIn("lang-btn__label", html, f"{name}'s button has no label to swap")
            self.assertIn("i-globe", html, f"{name}'s button has no globe icon")
            tags = re.findall(r'<script[^>]*src="([^"]+)"', html)
            where = [i for i, u in enumerate(tags) if "i18n.js" in u]
            app = [i for i, u in enumerate(tags) if "app.js" in u or "monitor.js" in u]
            self.assertEqual(len(where), 1, f"{name} loads i18n.js {len(where)} times: {tags}")
            self.assertTrue(app, f"{name} loads no app script")
            self.assertLess(where[0], min(app), f"{name} loads i18n.js after the app script: {tags}")

    def test_the_language_is_set_before_the_first_paint(self):
        for name in ("index.html", "monitor.html"):
            html = (WEB / name).read_text(encoding="utf-8")
            head = html[:html.index("<body")]
            self.assertIn("strata.lang", head, f"{name} reads the saved language only after <body>")
            self.assertIn("zh-Hant", head, f"{name} does not set <html lang> before the first paint")

    def test_the_pages_keep_the_english_words_as_the_default_text(self):
        # The English release's own words stay in the markup, so a page with no JavaScript is the old page.
        for name, want in (("index.html", "Chat"), ("monitor.html", "API Monitor")):
            html = (WEB / name).read_text(encoding="utf-8")
            self.assertIn(want, html, f"{name} dropped its English default text")


class Scripts(unittest.TestCase):
    def setUp(self):
        self.strings, _ = dictionary()

    def test_no_english_is_written_straight_into_the_page(self):
        # A string a script writes straight into the page is one the language switch cannot translate.
        for name in ("app.js", "monitor.js"):
            js = (WEB / name).read_text(encoding="utf-8")
            for line_no, line in enumerate(js.splitlines(), 1):
                for group in BARE.findall(line):
                    text = next((g for g in group if g), "")
                    if not text or BARE_OK.match(text) or re.search(r"[${}()<>]", text):
                        continue
                    self.fail(f"{name}:{line_no} writes English straight into the page: {text!r} - use T(\"key\")")

    def test_both_pages_repaint_on_a_language_switch(self):
        for name in ("app.js", "monitor.js"):
            js = (WEB / name).read_text(encoding="utf-8")
            self.assertIn("strata:lang", js, f"{name} does not listen for a language switch")

    def test_the_export_keeps_its_file_name_and_its_numbers(self):
        js = (WEB / "app.js").read_text(encoding="utf-8")
        self.assertIn("strata-chat-", js, "the Markdown export changed its file name")
        self.assertIn(".md", js, "the Markdown export changed its extension")

    def test_the_badge_tables_hold_keys_not_finished_words(self):
        js = (WEB / "app.js").read_text(encoding="utf-8")
        tables = STATE_TABLE.findall(js)
        self.assertEqual(len(tables), 2, "expected the MCP and the tool-call state tables")
        for body in tables:
            self.assertNotIn("T(", body, "a state table resolves its label at load, so a language switch cannot reach it")
            for key in re.findall(r'"([a-z0-9_.]+)"', body):
                self.assertIn(key, self.strings, f"a state table names {key!r}, which the dictionary does not have")


class Style(unittest.TestCase):
    def test_the_font_falls_back_to_a_chinese_face(self):
        # Outfit has no Chinese glyphs, so a Chinese page needs a face that does.
        css = (WEB / "tokens.css").read_text(encoding="utf-8")
        font = re.search(r"--st-font:\s*([^;]+);", css)
        self.assertIsNotNone(font, "tokens.css has no --st-font")
        self.assertIn("Microsoft JhengHei", font.group(1))
        self.assertIn("PingFang TC", font.group(1))
        self.assertLess(font.group(1).index("Microsoft JhengHei"), font.group(1).index("sans-serif"))

    def test_the_sprite_has_the_globe(self):
        sprite = (WEB / "sprite.svg").read_text(encoding="utf-8")
        self.assertIn('id="i-globe"', sprite, "sprite.svg has no i-globe for the language button")

    def test_the_language_button_has_room_for_its_word(self):
        # .st-btn--icon is a 36px square; this one carries "中" or "EN" next to the globe.
        css = (WEB / "app.css").read_text(encoding="utf-8")
        rule = re.search(r"#lang-btn\s*\{([^}]*)\}", css)
        self.assertIsNotNone(rule, "app.css has no #lang-btn rule")
        self.assertIn("width:auto", rule.group(1).replace(" ", ""), "the language button keeps the icon button's fixed width")

    def test_the_header_survives_a_narrow_phone(self):
        # brand + 3 tabs + pill + language + theme must all stay on screen at 360px:
        # the language button drops its word and the header gaps shrink.
        css = (WEB / "app.css").read_text(encoding="utf-8")
        self.assertIn(".st-header__spacer { display: none; }", css,
                      "the header keeps its empty spacer on narrow screens")
        self.assertIn("#lang-btn .lang-btn__label { display: none; }", css,
                      "the language button keeps its word on narrow screens")
        tight = re.search(r"@media \(max-width: 420px\) \{([^}]*)\}", css)
        self.assertIsNotNone(tight, "app.css has no 420px header tier")
        self.assertIn("gap:var(--st-s-1)", tight.group(1).replace(" ", ""),
                      "the header gaps do not shrink on a phone")
        # the monitor page has its own header and its own inline stylesheet.
        mon = (WEB / "monitor.html").read_text(encoding="utf-8")
        block = re.search(r"@media\(max-width:600px\)\{(.*)\}", mon)
        self.assertIsNotNone(block, "monitor.html has no 600px tier")
        self.assertIn("#lang-btn.lang-btn__label{display:none}", block.group(1).replace(" ", ""),
                      "the monitor language button keeps its word on a phone")
        self.assertIn("flex-wrap:wrap", block.group(1),
                      "the monitor header cannot wrap on a phone")


class ModelSettings(unittest.TestCase):
    """The About page's model settings: every key the server lists has a Chinese label."""

    def setUp(self):
        self.strings, _ = dictionary()
        src = (Path(__file__).parent / "runconfig.py").read_text(encoding="utf-8")
        self.keys = EDITABLE_KEY.findall(src)
        self.enums = [v.strip().strip('"') for m in ENUM_CHOICES.findall(src) for v in m.split(",")]

    def test_the_server_lists_the_keys_the_test_reads(self):
        self.assertGreaterEqual(len(self.keys), 15, "serve/runconfig.py's EDITABLE list was not read")
        self.assertTrue(self.enums, "serve/runconfig.py has no enum choices to check")

    def test_every_setting_key_has_a_label_in_both_languages(self):
        missing = [k for k in self.keys if f"cfg.field.{k}" not in self.strings]
        self.assertEqual(missing, [], "the model settings form has no label for: " + ", ".join(missing))

    def test_no_label_names_a_key_the_server_dropped(self):
        extra = sorted(k[len("cfg.field."):] for k in self.strings
                       if k.startswith("cfg.field.") and k[len("cfg.field."):] not in self.keys)
        self.assertEqual(extra, [], "the dictionary labels keys the server no longer lists: " + ", ".join(extra))

    def test_every_choice_offers_a_chinese_name(self):
        missing = [v for v in self.enums if f"cfg.enum.{v}" not in self.strings]
        self.assertEqual(missing, [], "the dropdowns have no Chinese name for: " + ", ".join(missing))

    def test_the_form_labels_itself_through_the_dictionary(self):
        js = (WEB / "app.js").read_text(encoding="utf-8")
        # the server's own words stay as the fallback, so a key a newer server adds still renders
        self.assertIn("TK(`cfg.field.${k.key}`, k.help)", js, "the settings labels bypass the dictionary")
        self.assertIn("TK(`cfg.enum.${x}`, x)", js, "the dropdown choices bypass the dictionary")
        # the key name under each label is the run config's own key, so it stays as the server sends it
        self.assertIn("<code>${esc(k.key)}</code>", js, "the settings form no longer shows the config key")
if __name__ == "__main__":
    unittest.main()
