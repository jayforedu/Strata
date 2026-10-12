"""Tests for the edit-and-regenerate add-on (About > Chat extras > Edit and regenerate): the shared stream
entry point, the truncation a re-sent question does to the history, and the six-second Undo behind it.
Plain file checks - no GPU, no server, no downloads.

    python -m unittest serve.test_web_msgtools
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

WEB = Path(__file__).parent / "web"
JS = (WEB / "app.js").read_text(encoding="utf-8")
CSS = (WEB / "app.css").read_text(encoding="utf-8")


def body(name):
    """One function's text, from its `function name(` line to the first line that closes it."""
    at = JS.index(f"function {name}(")
    tail = JS[at:]
    end = re.search(r"\n\}\n", tail)
    return tail[:end.end()]


class SharedStream(unittest.TestCase):
    def test_the_stream_has_one_home(self):
        self.assertIn("async function runAssistant() {", JS)
        self.assertIn("await runAssistant();", body("send"))

    def test_send_still_pushes_the_question_first(self):
        text = body("send")
        self.assertIn('messages.push({role: "user"', text)
        self.assertLess(text.index('messages.push({role: "user"'), text.index("await runAssistant()"))

    def test_the_stream_builds_its_history_from_the_messages_it_has(self):
        self.assertIn("apiMessages()", body("runAssistant"))

    def test_the_new_answer_cross_fades(self):
        self.assertIn('el.classList.add("msg-in");', body("runAssistant"))
        self.assertIn(".st-msg.msg-in { animation: msg-in 140ms var(--st-ease); }", CSS)


class Edit(unittest.TestCase):
    def test_saving_a_question_drops_the_answers_after_it(self):
        text = body("startEdit")
        self.assertIn("messages[i].text = text;", text)
        self.assertIn("messages.length = i + 1;", text)
        self.assertIn("saveChat();", text)
        self.assertIn("renderChat();", text)
        self.assertIn("runAssistant();", text)

    def test_the_edit_snapshots_the_history_and_offers_undo(self):
        text = body("startEdit")
        self.assertIn("const snapshot = messages.map((x) => ({...x}));", text)
        self.assertIn('T("toast.undo")', text)
        self.assertIn("messages = snapshot;", text)

    def test_the_box_is_a_textarea_that_opens_and_closes(self):
        text = body("startEdit")
        self.assertIn('ta.className = "st-input msg-edit__input";', text)
        self.assertIn('box.className = "msg-edit";', text)
        self.assertIn('e.key === "Escape"', text)
        self.assertIn('e.key === "Enter"', text)
        self.assertIn("e.isComposing", text)          # an IME commit is not a send

    def test_a_question_whose_picture_is_gone_says_so(self):
        text = body("startEdit")
        self.assertIn("im.url", text)
        self.assertIn('T("msg.imageLost")', text)

    def test_the_box_replaces_the_bubble_and_refits_itself(self):
        text = body("startEdit")
        self.assertIn('el.querySelector(".st-bubble").hidden = true;', text)
        self.assertIn("ta.style.height = `${Math.min(ta.scrollHeight", text)


class Regenerate(unittest.TestCase):
    def test_regenerating_drops_the_answer_and_writes_a_new_one(self):
        text = body("regenerate")
        self.assertIn("messages.length = i;", text)
        self.assertIn("saveChat();", text)
        self.assertIn("runAssistant();", text)

    def test_the_old_answer_comes_back_on_undo(self):
        text = body("regenerate")
        self.assertIn("const snapshot = messages.map((x) => ({...x}));", text)
        self.assertIn('T("toast.undo")', text)
        self.assertIn("messages = snapshot;", text)


class Busy(unittest.TestCase):
    def test_both_buttons_are_gone_while_an_answer_is_writing(self):
        self.assertIn('document.querySelectorAll("[data-msg-edit], [data-msg-regen]")) b.hidden = on;', JS)

    def test_both_entry_points_refuse_a_writing_answer(self):
        self.assertIn("if (busy)", body("startEdit"))
        self.assertIn("if (busy)", body("regenerate"))

    def test_the_buttons_only_exist_with_the_switch_on(self):
        self.assertIn("if (labs.msgTools) {", body("msgEl"))
        self.assertIn("labs.msgTools ? `<button", body("msgEl"))

    def test_a_partial_answer_offers_no_regenerate(self):
        text = body("updateAssistant")
        self.assertIn("if (regen) regen.hidden = streaming || !m.text;", text)


class Motion(unittest.TestCase):
    def test_the_edit_box_opens_over_180ms(self):
        self.assertIn(".msg-edit { overflow: hidden; transition: height 180ms var(--st-ease), opacity 180ms var(--st-ease); }", CSS)
        self.assertIn('box.style.height = "0px";', body("startEdit"))
        self.assertIn("requestAnimationFrame(", body("startEdit"))

    def test_reduced_motion_covers_the_new_motion(self):
        block = re.search(r"@media \(prefers-reduced-motion: reduce\) \{(.*?)\n\}", CSS, re.S)
        self.assertIsNotNone(block, "app.css has no prefers-reduced-motion tier")
        self.assertIn(".msg-edit", block.group(1))
        self.assertIn(".st-msg.msg-in", block.group(1))


if __name__ == "__main__":
    unittest.main()
