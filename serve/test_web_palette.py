"""Tests for the command list and the saved prompts (About > Chat extras > Command list and saved prompts):
the Ctrl+K takeover, the keyboard contract of the box, and the rule that inserting a prompt sends nothing.
Plain file checks - no GPU, no server, no downloads.

    python -m unittest serve.test_web_palette
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

WEB = Path(__file__).parent / "web"
HTML = (WEB / "index.html").read_text(encoding="utf-8")
JS = (WEB / "app.js").read_text(encoding="utf-8")
CSS = (WEB / "app.css").read_text(encoding="utf-8")
SERVER = (Path(__file__).parent / "server.py").read_text(encoding="utf-8")


def body(name):
    """One function's text, from its `function name(` line to the first line that closes it."""
    at = JS.index(f"function {name}(")
    tail = JS[at:]
    end = re.search(r"\n\}\n", tail)
    return tail[:end.end()]


class Takeover(unittest.TestCase):
    def test_ctrl_k_and_cmd_k_open_it_and_the_browser_does_not(self):
        at = JS.index('if (!(e.ctrlKey || e.metaKey) || (e.key !== "k" && e.key !== "K")) return;')
        block = JS[at - 200:at + 300]
        self.assertIn("ctrlKey", block)
        self.assertIn("metaKey", block)
        self.assertIn("e.preventDefault();", block)
        self.assertIn("if (!labs.palette) return;", block)
        self.assertIn("if (palette) closePalette(); else openPalette();", block)

    def test_the_box_only_opens_with_the_switch_on(self):
        self.assertIn("if (labs.palette) mountComposerBtns(); else unmountComposerBtns();", JS)
        self.assertIn("if (!labs.palette) closePalette();", JS)

    def test_the_page_ships_no_palette_markup(self):
        for marker in ("palette__list", "palette-row", 'id="palette"', 'id="palette-q"', "snip-list", "snip-drawer"):
            self.assertNotIn(marker, HTML)

    def test_the_server_never_sees_a_prompt(self):
        self.assertNotIn("snippets", SERVER)
        self.assertNotIn("strata.snippets", JS.replace('persist("snippets"', ""))


class Keyboard(unittest.TestCase):
    def test_the_box_is_a_dialog_over_a_listbox(self):
        text = body("openPalette")
        self.assertIn('palette.setAttribute("role", "dialog");', text)
        self.assertIn('palette.setAttribute("aria-modal", "true");', text)
        self.assertIn('paletteList.setAttribute("role", "listbox");', text)
        self.assertIn('paletteInput.setAttribute("role", "combobox");', text)
        self.assertIn('row.setAttribute("role", "option");', body("renderPalette"))
        self.assertIn("aria-activedescendant", body("selectPalette"))

    def test_the_box_keeps_its_own_focus(self):
        text = body("openPalette")
        self.assertIn('if (e.key === "Tab") { e.preventDefault(); paletteInput.focus(); return; }', text)
        self.assertIn('e.key === "ArrowDown"', text)
        self.assertIn('e.key === "ArrowUp"', text)
        self.assertIn('e.key === "Enter"', text)
        self.assertIn('e.key === "Escape"', text)

    def test_the_box_remembers_where_the_user_came_from(self):
        self.assertIn("paletteReturn = document.activeElement;", body("openPalette"))
        self.assertIn("if (paletteReturn && paletteReturn.isConnected) paletteReturn.focus();", body("closePalette"))

    def test_typing_is_debounced(self):
        self.assertIn("setTimeout(() => renderPalette(paletteInput.value), 60);", body("openPalette"))

    def test_the_rows_stagger_and_stop_staggering(self):
        self.assertIn("if (k < 10) row.style.animationDelay = `${k * 14}ms`;", body("renderPalette"))

    def test_the_scrim_closes_it(self):
        self.assertIn("paletteScrim.onclick = () => closePalette();", body("openPalette"))


class Commands(unittest.TestCase):
    def test_the_groups_come_in_their_order(self):
        self.assertIn('const PALETTE_GROUPS = [["actions", "palette.groupActions"], ["chats", "palette.groupChats"],', JS)
        self.assertIn('["prompts", "palette.groupPrompts"], ["settings", "palette.groupSettings"]];', JS)

    def test_the_chats_group_only_exists_with_the_sidebar_on(self):
        text = body("paletteItems")
        at = text.index('group: "chats"')
        self.assertIn("if (labs.sessions) {", text[:at])
        self.assertIn("sessions.slice(0, 8)", text)

    def test_a_command_closes_the_box_before_it_opens_anything(self):
        text = body("runPalette")
        self.assertLess(text.index("closePalette();"), text.index("x.run()"))

    def test_the_search_is_a_subsequence_match(self):
        text = body("fuzzy")
        self.assertIn("t.indexOf(ch, at + 1)", text)
        self.assertIn("return -1", text)

    def test_the_two_sampling_switches_report_which_way_they_went(self):
        text = body("paletteItems")
        self.assertIn('T("toast.mcpOn")', text)
        self.assertIn('T("toast.mcpOff")', text)
        self.assertIn('T("toast.showOn")', text)
        self.assertIn('T("toast.showOff")', text)


class Prompts(unittest.TestCase):
    def test_insert_lands_at_the_caret_and_sends_nothing(self):
        text = body("insertSnippet")
        self.assertIn("el.selectionStart", text)
        self.assertIn("el.setSelectionRange(end, end);", text)
        self.assertIn("autosize();", text)
        self.assertNotIn("send()", text)

    def test_the_list_is_capped_and_a_deletion_can_be_undone(self):
        self.assertIn("snippets.length >= SNIPPET_LIMIT", body("saveSnippet"))
        self.assertIn("snippets.slice(0, SNIPPET_LIMIT)", body("saveSnippet"))
        self.assertIn('T("toast.undo")', body("deleteSnippet"))

    def test_the_editor_is_built_once(self):
        self.assertIn("if (snipDrawer) return;", body("mountSnippets"))
        self.assertIn("if (!snipDrawer) return;", body("paintSnippets"))
        self.assertIn("if (!snipList) return;", body("renderSnippets"))

    def test_the_drawer_closes_on_escape_and_on_the_scrim(self):
        self.assertIn('if (e.key === "Escape" && snipDrawer && snipDrawer.dataset.open === "true") closeSnippets();', JS)
        self.assertIn("snipScrim.onclick = () => closeSnippets();", body("mountSnippets"))

    def test_the_composer_buttons_are_built_and_removed_with_the_switch(self):
        self.assertIn("if (paletteBtn) return;", body("mountComposerBtns"))
        self.assertIn("snipBtn = paletteBtn = null;", body("unmountComposerBtns"))

    def test_the_prompts_are_saved_in_the_browser_only(self):
        self.assertIn('persist("snippets", snippets);', body("saveSnippet"))
        self.assertNotIn("fetch", body("saveSnippet"))


class Motion(unittest.TestCase):
    def test_the_box_scales_in_over_180ms_and_the_scrim_fades_over_160ms(self):
        self.assertIn("animation: palette-in 180ms var(--st-ease);", CSS)
        self.assertIn("@keyframes palette-in { from { opacity: 0; transform: translateX(-50%) scale(.98); } }", CSS)
        self.assertIn("animation: scrim-in 160ms var(--st-ease);", CSS)
        self.assertIn("transition: background 120ms var(--st-ease)", CSS)

    def test_reduced_motion_covers_the_new_motion(self):
        block = re.search(r"@media \(prefers-reduced-motion: reduce\) \{(.*?)\n\}", CSS, re.S)
        self.assertIsNotNone(block, "app.css has no prefers-reduced-motion tier")
        for selector in (".palette", ".palette-row", ".snip-item", ".palette-scrim"):
            self.assertIn(selector, block.group(1))


if __name__ == "__main__":
    unittest.main()
