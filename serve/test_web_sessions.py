"""Tests for the saved-conversations add-on (About > Chat extras > Saved conversations): the sidebar, the
one migration that adopts the chat already in this browser, and the rule that a switch which is off must not
build a single node.  Plain file checks - no GPU, no server, no downloads.

    python -m unittest serve.test_web_sessions
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

WEB = Path(__file__).parent / "web"
HTML = (WEB / "index.html").read_text(encoding="utf-8")
JS = (WEB / "app.js").read_text(encoding="utf-8")
LABS_JS = (WEB / "labs.js").read_text(encoding="utf-8")
CSS = (WEB / "app.css").read_text(encoding="utf-8")
LABS_CSS = (WEB / "labs.css").read_text(encoding="utf-8")
SERVER = (Path(__file__).parent / "server.py").read_text(encoding="utf-8")


def body(name, src=None):
    """One function's text, from its `function name(` line to the first line that closes it.  The add-ons'
    functions live in labs.js, so pass LABS_JS for them."""
    src = JS if src is None else src
    at = src.index(f"function {name}(")
    tail = src[at:]
    end = re.search(r"\n\}\n", tail)
    return tail[:end.end()]


class Switches(unittest.TestCase):
    def test_the_three_switches_are_off_by_default(self):
        self.assertIn('const LABS_OFF = {sessions: false, msgTools: false, palette: false};', LABS_JS)
        self.assertIn('store.get("labs", {})', JS)

    def test_core_only_asks_for_the_add_ons_when_one_is_on(self):
        """The split: core reaches the add-ons through the Labs hooks, and asks for labs.js only when a switch is on."""
        # web/ is not decoration: a classic script resolves import() against the page's own address, the page lives
        # at /, and serve/server.py only serves these files under /web/.  A bare "labs.js" 404s and the add-ons
        # never arrive, with the catch() leaving no trace beyond the switches doing nothing.
        self.assertIn('import("web/labs.js")', JS)
        self.assertNotIn('import("labs.js")', JS)
        self.assertIn('if (!this.on.sessions && !this.on.msgTools && !this.on.palette) return;', JS)
        # the page itself never names the add-on files: a page with the switches off loads exactly what it always did
        self.assertNotIn("labs.js", HTML)
        self.assertNotIn("labs.css", HTML)
        # labs.js brings its own stylesheet in the same step as its code
        self.assertIn('labsCss.href = "web/labs.css";', LABS_JS)
        self.assertIn('document.head.appendChild(labsCss);', LABS_JS)

    def test_every_hook_core_calls_is_exported(self):
        """The hooks are the whole bridge between the two files: a name core reaches for that labs.js does not export
        is a TypeError the moment a switch is on, and the plain path (switches off) never shows it."""
        reached = set(re.findall(r"this\.mod\.(\w+)\(", JS))
        self.assertTrue(reached, "core reaches the add-ons through this.mod")
        exported = set(re.findall(r"export (?:function|const) (\w+)", LABS_JS))
        self.assertEqual(set(), reached - exported)

    def test_the_add_ons_own_their_own_file(self):
        """The add-on code lives in labs.js, not in app.js: an upstream update to app.js then cannot take it away."""
        for name in ("mountSidebar", "renderSessions", "migrateSessions", "startEdit", "regenerate",
                     "openPalette", "openSnippets", "newChat"):
            self.assertIn(f"function {name}(", LABS_JS)
            self.assertNotIn(f"function {name}(", JS)
        for marker in ("sessions__list", "palette-scrim", "snip-"):
            self.assertNotIn(marker, CSS)
            self.assertIn(marker, LABS_CSS)

    def test_about_has_the_card_and_nothing_else_new(self):
        self.assertIn('id="labs-card"', HTML)
        for switch in ("labs-sessions", "labs-edit", "labs-palette"):
            self.assertIn(f'id="{switch}"', HTML)
            self.assertIn('role="switch"', HTML)
        self.assertEqual(len(re.findall(r'id="labs-(?:sessions|edit|palette)"', HTML)), 3)

    def test_the_switches_are_wired_by_core(self):
        """The trap in the split: labs.js is only asked for once a switch is on, so core must own the clicks.
        With them in labs.js, a page that shipped with all three off had switches that answered nothing."""
        self.assertIn("for (const [k, id] of LABS_KEYS)", JS)
        self.assertIn("el.onclick = () => {", JS)
        for switch in ("labs-sessions", "labs-edit", "labs-palette"):
            self.assertIn(f'"{switch}"', JS)
        # the file answers to core, not to the click: core writes storage, labs.js reads it back
        self.assertNotIn("$(id).onclick", LABS_JS)
        self.assertNotIn("LABS_LABEL", LABS_JS)
        self.assertIn("export function sync()", LABS_JS)
        self.assertIn("this.mod.sync()", JS)
        self.assertIn("paintLabsSwitches();", body("apply", LABS_JS))

    def test_a_load_that_fails_says_so(self):
        """A rejected import() used to leave the switches dead with no trace beyond the click doing nothing."""
        at = JS.index('import("web/labs.js")')
        block = JS[at:at + 700]
        self.assertIn(".catch(", block)
        self.assertIn("toast(", block)
        self.assertIn('T("labs.loadFail")', block)

    def test_the_page_ships_no_sidebar_markup(self):
        """The sidebar is built at run time, so a page with the switch off has no trace of it in its HTML."""
        for marker in ("sessions__list", "sessions__head", "session-row", 'id="sessions"', 'id="sessions-q"'):
            self.assertNotIn(marker, HTML)

    def test_the_server_never_sees_a_conversation(self):
        """Conversations are localStorage only; serve/server.py must not learn the words at all."""
        for marker in ("strata.sessions", "strata.sessionId", "strata.snippets"):
            self.assertNotIn(marker, SERVER)


class Migration(unittest.TestCase):
    def test_the_migration_keeps_the_old_chat_key(self):
        """strata.chat stays where it was, so switching the add-on back off returns to the single chat."""
        text = body("migrateSessions", LABS_JS)
        self.assertNotIn("removeItem", text)
        self.assertIn('persist("sessions"', text)
        self.assertIn("if (!sessions.length)", text)
        self.assertIn("if (!messages.length) return;", text)

    def test_the_chat_key_is_still_written(self):
        self.assertIn('store.set("chat"', JS)
        self.assertNotIn('localStorage.removeItem("strata.chat")', JS)

    def test_the_migration_only_runs_with_the_switch_on(self):
        self.assertIn("if (labs.sessions) { migrateSessions(); mountSidebar(); } else unmountSidebar();", LABS_JS)

    def test_the_first_saved_message_opens_a_conversation(self):
        """The switch can go on over an empty chat; the first save must open the row, not drop the words."""
        text = body("saveSessions", LABS_JS)
        self.assertIn("let s = currentSession();", text)
        self.assertIn("if (!messages.length) return;", text)
        self.assertIn("sessionId = s.id;", text)
        self.assertIn("renderSessions();", text)
        self.assertIn("s.messages = slim(messages);", text)

    def test_the_title_comes_from_the_first_question(self):
        text = body("autoTitle", LABS_JS)
        self.assertIn("role === \"user\"", text)
        self.assertIn("slice(0, 48)", text)
        self.assertIn('T("session.untitled")', text)


class Limits(unittest.TestCase):
    def test_the_lists_have_their_limits(self):
        self.assertIn("const SESSION_LIMIT = 60, SNIPPET_LIMIT = 100;", LABS_JS)
        self.assertIn("sessions.slice(0, SESSION_LIMIT)", LABS_JS)
        self.assertIn("snippets.slice(0, SNIPPET_LIMIT)", LABS_JS)

    def test_the_oldest_conversation_is_the_one_dropped(self):
        self.assertIn("sessions.sort((a, b) => (b.updated - a.updated)", LABS_JS)


class OffPath(unittest.TestCase):
    def test_nothing_is_built_twice_and_nothing_is_built_when_off(self):
        self.assertIn("if (sidebar) return;", body("mountSidebar", LABS_JS))
        self.assertIn("if (!sidebar) return;", body("setSidebar", LABS_JS))
        self.assertIn("if (!sidebar) return;", body("renderSessions", LABS_JS))
        self.assertIn("if (!labs.sessions) return;", body("saveSessions", LABS_JS))
        self.assertIn("else unmountSidebar();", LABS_JS)

    def test_the_chat_goes_back_to_the_page_it_came_from(self):
        text = body("unmountSidebar", LABS_JS)
        self.assertIn('view.classList.remove("chat-split");', text)
        self.assertIn("sidebar.remove();", text)
        # the chat nodes never move, so there is nothing to move back and nothing left behind
        for moved in ('$("chat-scroll")', '$("composer-wrap")', "chat-main"):
            self.assertNotIn(moved, text)

    def test_the_sidebar_is_a_column_beside_the_chat(self):
        """A grid column, not a wrapper around the chat: the chat keeps its own width and its own height."""
        self.assertIn(".chat-split { display: grid; grid-template-columns: 260px minmax(0, 1fr);"
                    " grid-template-rows: minmax(0, 1fr) auto; }", LABS_CSS)
        self.assertIn(".chat-split > .sessions { grid-column: 1; grid-row: 1 / 3; min-height: 0; }", LABS_CSS)
        self.assertIn(".chat-split > .chat-scroll { grid-column: 2; grid-row: 1; }", LABS_CSS)
        self.assertIn(".chat-split > .composer-wrap { grid-column: 2; grid-row: 2; }", LABS_CSS)
        self.assertIn('view.insertBefore(sidebar, $("chat-scroll"));', body("mountSidebar", LABS_JS))
        self.assertNotIn("chat-main", JS)
        self.assertNotIn("chat-main", LABS_JS)

    def test_the_new_chat_button_keeps_the_old_path(self):
        """The New button lives in core; labs.js hands it the core path when its own sidebar is off."""
        self.assertIn('$("new-btn").onclick = () => Labs.newChat(newChatDefault);', JS)
        self.assertIn("newChat(defaultPath) { if (this.mod) this.mod.newChat(); else defaultPath(); },", JS)
        self.assertIn("if (!labs.sessions) { newChatDefault(); return; }", body("newChat", LABS_JS))
        old = body("newChatDefault")
        self.assertIn("if (busy)", old)
        self.assertIn("if (!messages.length) return;", old)
        self.assertIn("saveChat()", old)                     # the old writer: store.set("chat", ...)
        self.assertIn('T("toast.undo")', old)

    def test_the_export_button_is_the_same_button(self):
        self.assertIn('$("export-btn").onclick = () => exportChat();', JS)
        self.assertIn("strata-chat-", JS)
        self.assertIn(".md", JS)


class Sidebar(unittest.TestCase):
    def test_the_rows_are_buttons_with_a_current_one(self):
        self.assertIn('open.className = "session-row__open";', LABS_JS)
        self.assertIn('open.setAttribute("aria-current", "true");', LABS_JS)
        self.assertIn('row.dataset.id = s.id;', LABS_JS)

    def test_the_search_reads_titles_and_message_text(self):
        text = body("visibleSessions", LABS_JS)
        self.assertIn("s.title", text)
        self.assertIn("s.messages", text)

    def test_the_relative_time_reuses_the_pages_own(self):
        self.assertIn("since(s.updated)", LABS_JS)
        self.assertIn('T("sessions.count"', LABS_JS)

    def test_a_deleted_row_can_be_undone(self):
        text = body("deleteSession", LABS_JS)
        self.assertIn('T("toast.undo")', text)
        self.assertIn('row.classList.add("session-row--gone");', text)

    def test_a_rename_locks_the_title(self):
        text = body("renameSession", LABS_JS)
        self.assertIn("s.titleLocked = true;", text)
        self.assertIn('e.key === "Enter"', text)
        self.assertIn('e.key === "Escape"', text)

    def test_the_sidebar_moves_the_chat_when_a_session_opens(self):
        text = body("openSession", LABS_JS)
        self.assertIn('chat.classList.add("swap-out");', text)
        self.assertIn('chat.classList.add("swap-in");', text)
        self.assertIn("scrollDown(true)", JS)   # core's renderChat lands at the bottom of the opened conversation

    def test_a_full_browser_warns_once_and_keeps_working(self):
        text = body("persist", LABS_JS)
        self.assertIn("if (!storageWarned)", text)
        self.assertIn("return false", text)


class Motion(unittest.TestCase):
    def test_the_add_on_animations_are_in_the_quiet_band(self):
        self.assertIn("animation: panel-in 240ms var(--st-ease)", LABS_CSS)
        self.assertIn("animation: row-in 160ms var(--st-ease) both", LABS_CSS)
        self.assertIn("#chat.swap-out { animation: fade-out 120ms var(--st-ease) forwards; }", LABS_CSS)
        self.assertIn("#chat.swap-in { animation: fade-in 180ms var(--st-ease); }", LABS_CSS)
        self.assertIn("transition: height 200ms var(--st-ease)", LABS_CSS)

    def test_the_keyframes_came_across_with_the_rules(self):
        """Moving the add-ons' styles to labs.css moves their @keyframes too: a rule whose keyframe stayed in
        app.css animates nothing, and nothing about the page looks wrong."""
        used = set(re.findall(r"animation:\s*([A-Za-z0-9_-]+)", LABS_CSS)) - {"none"}
        self.assertTrue(used, "labs.css animates something")
        defined = set(re.findall(r"@keyframes\s+([A-Za-z0-9_-]+)", LABS_CSS))
        self.assertEqual(set(), used - defined)
        self.assertEqual(set(), used & set(re.findall(r"@keyframes\s+([A-Za-z0-9_-]+)", CSS)))

    def test_the_rows_stagger_and_stop_staggering(self):
        self.assertIn("if (i < 8) row.style.animationDelay = `${i * 20}ms`;", LABS_JS)

    def test_the_sidebar_is_off_canvas_below_1000px(self):
        tier = re.search(r"@media \(max-width: 1000px\) \{(.*?)\n\}", LABS_CSS, re.S)
        self.assertIsNotNone(tier, "labs.css has no 1000px tier")
        self.assertIn("transform: translateX(-100%)", tier.group(1))
        self.assertIn('.sessions[data-open="true"] { transform: none; }', tier.group(1))
        self.assertIn("#sessions-btn { display: inline-flex; }", tier.group(1))
        # one column, and the chat named back into it: column 2 here would add an empty gutter
        self.assertIn(".chat-split { grid-template-columns: minmax(0, 1fr); }", tier.group(1))
        self.assertIn(".chat-split > .chat-scroll, .chat-split > .composer-wrap { grid-column: 1; }", tier.group(1))

    def test_reduced_motion_turns_the_new_motion_off(self):
        block = re.search(r"@media \(prefers-reduced-motion: reduce\) \{(.*?)\n\}", LABS_CSS, re.S)
        self.assertIsNotNone(block, "labs.css has no prefers-reduced-motion tier")
        for selector in (".sessions", ".session-row", "#chat.swap-out", ".session-row--gone"):
            self.assertIn(selector, block.group(1))
        self.assertIn("animation: none", block.group(1))
        self.assertIn("transition: none", block.group(1))


if __name__ == "__main__":
    unittest.main()
