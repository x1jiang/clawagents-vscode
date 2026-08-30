from __future__ import annotations

import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from write_gate import WorkspaceWriteGate


def test_reads_do_not_block_between_runs() -> None:
    gate = WorkspaceWriteGate()
    first = gate.lease({"write_file"})
    second = gate.lease({"write_file"})
    before_first = first.wrap_before(lambda _name, _args: True)
    before_second = second.wrap_before(lambda _name, _args: True)

    assert before_first("read_file", {}) is True
    assert before_second("read_file", {}) is True


def test_mutations_are_serial_across_runs_and_reentrant_within_one_run() -> None:
    gate = WorkspaceWriteGate()
    first = gate.lease({"write_file"})
    second = gate.lease({"write_file"})
    before_first = first.wrap_before(lambda _name, _args: True)
    after_first = first.wrap_after(None)
    before_second = second.wrap_before(lambda _name, _args: True)
    after_second = second.wrap_after(None)

    before_first("write_file", {})
    before_first("write_file", {})

    entered = threading.Event()

    def run_second() -> None:
        before_second("write_file", {})
        entered.set()
        after_second("write_file", {}, "ok")

    worker = threading.Thread(target=run_second)
    worker.start()
    assert not entered.wait(timeout=0.05)

    after_first("write_file", {}, "ok")
    assert not entered.wait(timeout=0.05)
    after_first("write_file", {}, "ok")
    assert entered.wait(timeout=1.0)
    worker.join(timeout=1.0)
    assert not worker.is_alive()


def test_close_releases_a_stranded_mutation() -> None:
    gate = WorkspaceWriteGate()
    first = gate.lease({"execute"})
    second = gate.lease({"execute"})
    first.wrap_before(lambda _name, _args: True)("execute", {})

    entered = threading.Event()

    def run_second() -> None:
        second.wrap_before(lambda _name, _args: True)("execute", {})
        entered.set()
        second.close()

    worker = threading.Thread(target=run_second)
    worker.start()
    assert not entered.wait(timeout=0.05)
    first.close()
    assert entered.wait(timeout=1.0)
    worker.join(timeout=1.0)


def test_chat_turn_wires_gate_around_before_and_after_hooks() -> None:
    source = (Path(__file__).resolve().parents[1] / "chats.py").read_text(
        encoding="utf-8"
    )
    assert "agent.before_tool = write_lease.wrap_before(bt)" in source
    assert "agent.after_tool = write_lease.wrap_after(agent.after_tool)" in source
    assert "write_lease.close()" in source
