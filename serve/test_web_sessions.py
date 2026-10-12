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
CSS = (WEB / "app.css").read_text(encoding="utf-8")
SERVER = (Path(__file__).parent / "server.py").read_text(encoding="utf-8")


def body(name):
    """One function's text, from its `function name(` line to the first line that closes it."""
    at = JS.index(f"function {name}(")
    tail = JS[at:]
    end = re.search(r"\n\}\n", tail)
    return tail[:end.end()]


class Switches(unittest.TestCase):
    def test_the_three_switches_are_off_by_default(self):
        self.assertIn('const LABS_OFF = {sessions: false, msgTools: false, palette: false};', JS)
        self.assertIn('store.get("labs", {})', JS)

    def test_about_has_the_card_and_nothing_else_new(self):
        self.assertIn('id="labs-card"', HTML)
        for switch in ("labs-sessions", "labs-edit", "labs-palette"):
            self.assertIn(f'id="{switch}"', HTML)
            self.assertIn('role="switch"', HTML)
        self.assertEqual(len(re.findall(r'id="labs-(?:sessions|edit|palette)"', HTML)), 3)

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
        text = body("migrateSessions")
        self.assertNotIn("removeItem", text)
        self.assertIn('persist("sessions"', text)
        self.assertIn("if (!sessions.length)", text)
        self.assertIn("if (!messages.length) return;", text)

    def test_the_chat_key_is_still_written(self):
        self.assertIn('store.set("chat"', JS)
        self.assertNotIn('localStorage.removeItem("strata.chat")', JS)

    def test_the_migration_only_runs_with_the_switch_on(self):
        self.assertIn("if (labs.sessions) { migrateSessions(); mountSidebar(); } else unmountSidebar();", JS)

    def test_the_first_saved_message_opens_a_conversation(self):
        """The switch can go on over an empty chat; the first save must open the row, not drop the words."""
        text = body("saveSessions")
        self.assertIn("let s = currentSession();", text)
        self.assertIn("if (!messages.length) return;", text)
        self.assertIn("sessionId = s.id;", text)
        self.assertIn("renderSessions();", text)
        self.assertIn("s.messages = slim(messages);", text)

    def test_the_title_comes_from_the_first_question(self):
        text = body("autoTitle")
        self.assertIn("role === \"user\"", text)
        self.assertIn("slice(0, 48)", text)
        self.assertIn('T("session.untitled")', text)


class Limits(unittest.TestCase):
    def test_the_lists_have_their_limits(self):
        self.assertIn("const SESSION_LIMIT = 60, SNIPPET_LIMIT = 100;", JS)
        self.assertIn("sessions.slice(0, SESSION_LIMIT)", JS)
        self.assertIn("snippets.slice(0, SNIPPET_LIMIT)", JS)

    def test_the_oldest_conversation_is_the_one_dropped(self):
        self.assertIn("sessions.sort((a, b) => (b.updated - a.updated)", JS)


class OffPath(unittest.TestCase):
    def test_nothing_is_built_twice_and_nothing_is_built_when_off(self):
        self.assertIn("if (sidebar) return;", body("mountSidebar"))
        self.assertIn("if (!sidebar) return;", body("setSidebar"))
        self.assertIn("if (!sidebar) return;", body("renderSessions"))
        self.assertIn("if (!labs.sessions) return;", body("saveSessions"))
        self.assertIn("else unmountSidebar();", JS)

    def test_the_chat_goes_back_to_the_page_it_came_from(self):
        text = body("unmountSidebar")
        self.assertIn('view.classList.remove("chat-split");', text)
        self.assertIn("sidebar.remove();", text)
        # the chat nodes never move, so there is nothing to move back and nothing left behind
        for moved in ('$("chat-scroll")', '$("composer-wrap")', "chat-main"):
            self.assertNotIn(moved, text)

    def test_the_sidebar_is_a_column_beside_the_chat(self):
        """A grid column, not a wrapper around the chat: the chat keeps its own width and its own height."""
        self.assertIn(".chat-split { display: grid; grid-template-columns: 260px minmax(0, 1fr);"
                    " grid-template-rows: minmax(0, 1fr) auto; }", CSS)
        self.assertIn(".chat-split > .sessions { grid-column: 1; grid-row: 1 / 3; min-height: 0; }", CSS)
        self.assertIn(".chat-split > .chat-scroll { grid-column: 2; grid-row: 1; }", CSS)
        self.assertIn(".chat-split > .composer-wrap { grid-column: 2; grid-row: 2; }", CSS)
        self.assertIn('view.insertBefore(sidebar, $("chat-scroll"));', body("mountSidebar"))
        self.assertNotIn("chat-main", JS)

    def test_the_new_chat_button_keeps_the_old_path(self):
        text = body("newChat")
        at = text.index("if (!labs.sessions)")
        self.assertIn('store.set', JS)                       # saveChat() is the old writer
        self.assertIn('T("toast.undo")', text[:text.index("const cur")])
        self.assertIn("if (busy)", text)

    def test_the_export_button_is_the_same_button(self):
        self.assertIn('$("export-btn").onclick = () => exportChat();', JS)
        self.assertIn("strata-chat-", JS)
        self.assertIn(".md", JS)


class Sidebar(unittest.TestCase):
    def test_the_rows_are_buttons_with_a_current_one(self):
        self.assertIn('open.className = "session-row__open";', JS)
        self.assertIn('open.setAttribute("aria-current", "true");', JS)
        self.assertIn('row.dataset.id = s.id;', JS)

    def test_the_search_reads_titles_and_message_text(self):
        text = body("visibleSessions")
        self.assertIn("s.title", text)
        self.assertIn("s.messages", text)

    def test_the_relative_time_reuses_the_pages_own(self):
        self.assertIn("since(s.updated)", JS)
        self.assertIn('T("sessions.count"', JS)

    def test_a_deleted_row_can_be_undone(self):
        text = body("deleteSession")
        self.assertIn('T("toast.undo")', text)
        self.assertIn('row.classList.add("session-row--gone");', text)

    def test_a_rename_locks_the_title(self):
        text = body("renameSession")
        self.assertIn("s.titleLocked = true;", text)
        self.assertIn('e.key === "Enter"', text)
        self.assertIn('e.key === "Escape"', text)

    def test_the_sidebar_moves_the_chat_when_a_session_opens(self):
        text = body("openSession")
        self.assertIn('chat.classList.add("swap-out");', text)
        self.assertIn('chat.classList.add("swap-in");', text)
        self.assertIn("scrollDown(true)", JS)

    def test_a_full_browser_warns_once_and_keeps_working(self):
        text = body("persist")
        self.assertIn("if (!storageWarned)", text)
        self.assertIn("return false", text)


class Motion(unittest.TestCase):
    def test_the_add_on_animations_are_in_the_quiet_band(self):
        self.assertIn("animation: panel-in 240ms var(--st-ease)", CSS)
        self.assertIn("animation: row-in 160ms var(--st-ease) both", CSS)
        self.assertIn("#chat.swap-out { animation: fade-out 120ms var(--st-ease) forwards; }", CSS)
        self.assertIn("#chat.swap-in { animation: fade-in 180ms var(--st-ease); }", CSS)
        self.assertIn("transition: height 200ms var(--st-ease)", CSS)

    def test_the_rows_stagger_and_stop_staggering(self):
        self.assertIn("if (i < 8) row.style.animationDelay = `${i * 20}ms`;", JS)

    def test_the_sidebar_is_off_canvas_below_1000px(self):
        tier = re.search(r"@media \(max-width: 1000px\) \{(.*?)\n\}", CSS, re.S)
        self.assertIsNotNone(tier, "app.css has no 1000px tier")
        self.assertIn("transform: translateX(-100%)", tier.group(1))
        self.assertIn('.sessions[data-open="true"] { transform: none; }', tier.group(1))
        self.assertIn("#sessions-btn { display: inline-flex; }", tier.group(1))
        # one column, and the chat named back into it: column 2 here would add an empty gutter
        self.assertIn(".chat-split { grid-template-columns: minmax(0, 1fr); }", tier.group(1))
        self.assertIn(".chat-split > .chat-scroll, .chat-split > .composer-wrap { grid-column: 1; }", tier.group(1))

    def test_reduced_motion_turns_the_new_motion_off(self):
        block = re.search(r"@media \(prefers-reduced-motion: reduce\) \{(.*?)\n\}", CSS, re.S)
        self.assertIsNotNone(block, "app.css has no prefers-reduced-motion tier")
        for selector in (".sessions", ".session-row", "#chat.swap-out", ".session-row--gone"):
            self.assertIn(selector, block.group(1))
        self.assertIn("animation: none", block.group(1))
        self.assertIn("transition: none", block.group(1))


if __name__ == "__main__":
    unittest.main()
