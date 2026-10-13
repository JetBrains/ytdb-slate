"""Read real attached tmux client streams through test-owned terminal devices."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import uuid

node, fixture, tmux, repo = sys.argv[1:]
ESC, BEL, ST = b"\x1b", b"\x07", b"\x1b\\"
NAMES = ["iTerm2", "WezTerm", "ghostty", "kitty", "foot", "Konsole", "vscode"]
AUTOMATIC = ["osc9", "osc777", "osc777", "osc99", "osc99", "osc777", "osc99"]
SUPPORT = [{"osc9"}, {"osc777", "osc9"}, {"osc777", "osc9"},
           {"osc777", "osc99", "osc9"}, {"osc777", "osc99", "osc9"},
           {"osc777", "osc99"}, {"osc99"}]


def interrupted(_signal, _frame):
    raise SystemExit("tmux harness interrupted")


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)


class Server:
    def __init__(self, root):
        self.root = root
        self.socket = str(root / "socket")
        self.clients = []
        self.process = None
        self.pane_groups = []
        self.environment = {"PATH": os.environ["PATH"], "HOME": str(root),
                            "LANG": "C.UTF-8", "TERM": "xterm-256color"}
        config = root / "tmux.conf"
        config.write_text("set -g status off\nset -g allow-passthrough on\n")
        self.command = [tmux, "-S", self.socket, "-f", str(config)]
        pane_program = root / "pane.py"
        pane_program.write_text("import os, pathlib, sys, tty\n"
                                "tty.setraw(0)\n"
                                "root = pathlib.Path(sys.argv[1])\n"
                                "(root / f'ready-{os.getpid()}').touch()\n"
                                "data = b''\n"
                                "while True:\n"
                                "    data += os.read(0, 1024)\n"
                                "    if b'\\x1b[0n' in data:\n"
                                "        (root / f'ack-{os.getpid()}').touch()\n"
                                "        data = b''\n")
        self.pane_command = "exec " + " ".join(shlex.quote(s) for s in [sys.executable, str(pane_program), str(root)])

    def start(self):
        # Foreground mode keeps the private server as a child that this test can reap.
        self.process = subprocess.Popen(self.command + ["-D"], env=self.environment,
                                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 2
        while not Path(self.socket).exists() and time.monotonic() < deadline:
            assert self.process.poll() is None, "private tmux server exited during startup"
            time.sleep(.01)
        assert Path(self.socket).exists(), "private tmux socket did not become ready"
        self.new_pane("new-session", "-d", "-s", "slate")
        self.pane, self.tty, pid = self.run("display-message", "-p", "-t", "slate:0.0",
                                          "#{pane_id}\t#{pane_tty}\t#{pid}").strip().split("\t")
        assert int(pid) == self.process.pid, "socket does not belong to the test-owned server"

    def new_pane(self, *args):
        pid = int(self.run(*args, "-P", "-F", "#{pane_pid}", self.pane_command).strip())
        assert os.getpgid(pid) == pid, "test pane must own its process group"
        self.pane_groups.append(pid)
        deadline = time.monotonic() + 2
        while not (self.root / f"ready-{pid}").exists() and time.monotonic() < deadline:
            time.sleep(.01)
        assert (self.root / f"ready-{pid}").exists(), "pane acknowledgment reader did not become ready"

    def run(self, *args):
        result = subprocess.run(self.command + list(args), env=self.environment,
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=2)
        assert result.returncode == 0, f"tmux {args}: {result.stderr!r}"
        return result.stdout.decode()

    def attach(self, name, term="xterm-256color"):
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            os.execvpe(tmux, self.command + ["attach-session", "-t", "slate"],
                       {**self.environment, "TERM": term})
        client = {"pid": pid, "fd": fd, "name": name, "term": term,
                  "seen": b"", "query": False, "data": b""}
        self.clients.append(client)

    def pump(self, seconds, deadline):
        end = min(time.monotonic() + seconds, deadline)
        while time.monotonic() < end:
            fds = [c["fd"] for c in self.clients]
            ready = select.select(fds, [], [], max(0, end - time.monotonic()))[0]
            for client in self.clients:
                if client["fd"] not in ready:
                    continue
                try:
                    chunk = os.read(client["fd"], 65536)
                except OSError as error:
                    raise AssertionError(f"tmux client closed: {client}") from error
                assert chunk, "tmux client stream closed"
                client["data"] += chunk
                assert len(client["data"]) < 131072, "unexpected tmux output growth"
                client["seen"] += chunk
                for request, reply in [(ESC + b"[c", ESC + b"[?1;2c"),
                                       (ESC + b"[>c", ESC + b"[>1;4000;0c"),
                                       (ESC + b"[>q", None), (ESC + b"[>0q", None)]:
                    if request not in client["seen"]:
                        continue
                    client["seen"] = client["seen"].replace(request, b"")
                    if reply is None:
                        client["query"] = True
                        if client["name"] is not None:
                            reply = ESC + b"P>|" + client["name"].encode() + ST
                    if reply is not None:
                        os.write(client["fd"], reply)

    def ready(self, deadline):
        while time.monotonic() < deadline:
            self.pump(.02, deadline)
            rows = self.run("list-clients", "-F", "#{client_pid}\t#{client_termname}\t#{client_termtype}")
            actual = {int(row.split("\t")[0]): row.split("\t")[1:] for row in rows.splitlines()}
            if len(actual) != len(self.clients) or not all(c["query"] for c in self.clients):
                continue
            if all(actual.get(c["pid"]) == [c["term"], c["name"] or ""] for c in self.clients):
                self.pump(.15, deadline)
                for client in self.clients:
                    client["data"] = b""
                return
        raise AssertionError(f"terminal version replies did not identify clients: {rows!r}")

    def transport_barrier(self, deadline):
        # A device-status reply to the pane proves that tmux parsed its earlier output.
        with open(self.tty, "wb", buffering=0) as pane:
            pane.write(ESC + b"[5n")
        acknowledgment = self.root / f"ack-{self.pane_groups[0]}"
        while not acknowledgment.exists() and time.monotonic() < deadline:
            self.pump(.02, deadline)
        assert acknowledgment.exists(), "pane processing barrier timed out"
        # The visible pane marker follows the acknowledgment without changing permission.
        visible_tty = self.run("display-message", "-p", "-t", "slate:", "#{pane_tty}").strip()
        marker = ESC + b"]9;barrier-" + uuid.uuid4().hex.encode() + BEL
        with open(visible_tty, "wb", buffering=0) as pane:
            pane.write(ESC + b"Ptmux;" + marker.replace(ESC, ESC + ESC) + ST)
        while time.monotonic() < deadline:
            self.pump(.02, deadline)
            if all(any(c["data"].endswith(marker + restore) for restore in restorations(c, final=True))
                   for c in self.clients):
                return marker
        raise AssertionError("client transport barrier timed out")

    def kill_server(self):
        return subprocess.run(self.command + ["kill-server"], env=self.environment,
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=2)

    def close(self):
        failure = None
        try:
            if self.process is not None:
                try:
                    result = self.kill_server()
                    assert result.returncode == 0, f"kill-server failed: {result.stderr!r}"
                    self.process.wait(timeout=.5)
                except Exception as error:
                    failure = error
                finally:
                    self.terminate_owned_processes()
        finally:
            for client in self.clients:
                try:
                    os.kill(client["pid"], signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(client["pid"], 0)
                os.close(client["fd"])
        if failure is not None:
            raise AssertionError(f"private tmux cleanup required fallback: {failure}")

    def terminate_owned_processes(self):
        # Retained pane groups contain only this test's acknowledgment readers.
        for group in self.pane_groups:
            try:
                os.killpg(group, signal.SIGTERM)
            except ProcessLookupError:
                pass
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=.3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=.5)
        assert self.process.poll() is not None, "private tmux server leaked"
        for group in self.pane_groups:
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 1
        while any(Path(f"/proc/{pid}").exists() for pid in self.pane_groups) and time.monotonic() < deadline:
            time.sleep(.01)
        assert not any(Path(f"/proc/{pid}").exists() for pid in self.pane_groups), "test pane process leaked"


def restorations(client, final=False):
    # Exact blocks measured on tmux 3.4 and 3.7c with these 80-by-24 clients.
    base = (ESC + b"(B" + ESC + b"[m" + ESC + b"[?12l" + ESC + b"[?25h" +
            ESC + b"[?1006l" + ESC + b"[?1000l" + ESC + b"[?1002l" +
            ESC + b"[?1003l" + ESC + b"[1;1H" + ESC + b"[1;24r")
    blocks = [base + ESC + b"[1;1H"]
    if not final:
        blocks.append(base)
    if (client["name"] or "").startswith("iTerm2"):
        blocks.append(ESC + b"[?69h" + base + ESC + b"[1;24r" + ESC + b"[s" + ESC + b"[1;1H")
    if final:
        cursor = ESC + b"[?25l" + ESC + b"[?12l" + ESC + b"[?25h"
        # Idle tmux can append one complete cursor block after the final restoration.
        return [block + suffix for block in blocks for suffix in [b"", cursor]]
    return blocks


def client_stream_matches(client, sequences, bell=False):
    # Consume each request and its exact trailing restoration block in order.
    cursor = ESC + b"[?25l" + ESC + b"[?12l" + ESC + b"[?25h"
    offsets = {0}
    for index, sequence in enumerate(sequences):
        if index == len(sequences) - 1:
            # The status-query barrier can restore the visible cursor before its marker.
            offsets |= {offset + len(cursor) for offset in offsets
                        if client["data"].startswith(cursor, offset)}
        blocks = [cursor] if bell and index == 0 else restorations(client, final=index == len(sequences) - 1)
        offsets = {offset + len(sequence) + len(block)
                   for offset in offsets for block in blocks
                   if client["data"].startswith(sequence + block, offset)}
    return len(client["data"]) in offsets


def oracle(protocols, nonce, writes):
    # Expected bytes do not use the production encoder or selector.
    sequences = []
    title, body = f"T-{nonce}".encode(), f"B-{nonce}".encode()
    for protocol in protocols:
        if protocol == "osc777":
            sequences.append(ESC + b"]777;notify;" + title + b";" + body + BEL)
        elif protocol == "osc9":
            sequences.append(ESC + b"]9;Slate: " + title + b": " + body + BEL)
        else:
            match = re.search(rb"\x1b\x1b\]99;i=([a-zA-Z0-9_+.-]{1,36}):d=0;", b"".join(writes))
            assert match, "missing OSC 99 identifier"
            identifier = match[1]
            assert identifier != b"0", "reserved OSC 99 identifier"
            sequences.extend([ESC + b"]99;i=" + identifier + b":d=0;" + title + ST,
                              ESC + b"]99;i=" + identifier + b":p=body:d=1;" + body + ST])
    envelopes = [ESC + b"Ptmux;" + s.replace(ESC, ESC + ESC) + ST for s in sequences]
    assert writes == envelopes, f"pane writes are not complete ESC-doubled DCS requests: {writes!r} != {envelopes!r}"
    return sequences


def run_case(root, label, names, protocols, permission="on", inactive=False, bell=False,
             failure=False, explicit=False, unexpected_csi=False, delivery_delay=False):
    start = time.monotonic()
    deadline = start + 10
    root = root / label
    root.mkdir()
    server = Server(root)
    try:
        server.start()
        server.run("set-option", "-g", "allow-passthrough", permission)
        for name in names:
            server.attach(name)
        server.ready(deadline)
        if inactive:
            server.new_pane("new-window", "-t", "slate")
            assert server.run("display-message", "-p", "-t", server.pane,
                              "#{window_active}").strip() == "0", "producing window must be inactive"
            server.pump(.15, deadline)
            for client in server.clients:
                client["data"] = b""
        assert server.run("show-options", "-wAv", "-t", server.pane, "allow-passthrough").strip() == permission, "effective pane passthrough permission differs"
        nonce = uuid.uuid4().hex
        config = {"tty": server.tty, "tmux": tmux, "socket": server.socket,
                  "pane": server.pane, "failure": failure, "bell": bell, "nonce": nonce,
                  "unexpectedCSI": unexpected_csi, "delayDelivery": delivery_delay}
        if explicit:
            config["protocols"] = protocols
        path = root / "case.json"
        path.write_text(json.dumps(config))
        result = subprocess.run([node, "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", fixture, str(path)],
                                env=server.environment, stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=max(.001, deadline - time.monotonic()))
        assert result.returncode == 0, f"{label}: fixture failed: {result.stderr!r}"
        assert result.stderr == b"", f"fixture diagnostics: {result.stderr!r}"
        assert nonce.encode() not in result.stdout, "notification text leaked into captured standard output"
        measured = json.loads(result.stdout)
        if delivery_delay:
            assert measured["delivery_delay_ms"] >= 800, "positive control did not delay delivery"
        assert measured["query_ms"] < 1500, "real query exceeded its one-second bound with scheduling allowance"
        assert measured["prepare_ms"] < 1500, "channel selection or fallback exceeded its bounded wait"
        identified = [n.split("(")[0].split(" ")[0] for n in names
                      if n is not None and n.split("(")[0].split(" ")[0] in NAMES]
        if not failure:
            assert sorted(measured["clients"]) == sorted(identified), "production query parsed the wrong identities"
            actual = dict(row.split("\t") for row in measured["rows"].splitlines())
            expected = {str(c["pid"]): "".join("1" if n == (c["name"] or "").split("(")[0].split(" ")[0]
                                              else "0" for n in NAMES) for c in server.clients}
            assert actual == expected, f"real tmux match bits differ: {actual!r} != {expected!r}"
        writes = [bytes.fromhex(s) for s in measured["writes"]]
        if bell:
            assert server.run("show-options", "-gv", "bell-action").strip() == "any"
            assert server.run("show-options", "-gv", "visual-bell").strip() == "off"
            assert writes == [BEL], "bell must be one unwrapped byte"
            sequences = [BEL]
        else:
            sequences = oracle(protocols, nonce, writes)
            if not explicit:
                for name in identified:
                    assert len(set(protocols) & SUPPORT[NAMES.index(name)]) <= 1, "two notifications reach one identified client"
            if inactive and permission == "on":
                sequences = []
        marker = server.transport_barrier(deadline)
        expected = sequences + [marker]
        for client in server.clients:
            matches = client_stream_matches(client, expected, bell)
            if unexpected_csi:
                injected = ESC + b"[8;1;1t"
                assert client["data"].count(injected) == 1, "negative control did not reach the real client stream"
                assert not matches, "client comparison accepted an unexpected CSI request"
                clean = {**client, "data": client["data"].replace(injected, b"")}
                assert client_stream_matches(clean, expected), "negative control had another stream mismatch"
            else:
                assert matches, f"{label}: client {client['name']} received {client['data']!r}, expected exact requests and restoration blocks: {expected!r}"
        elapsed = round((time.monotonic() - start) * 1000, 1)
        assert elapsed < 10000, f"{label} exceeded its case deadline"
        return elapsed
    finally:
        server.close()


def cleanup_case(root, mode):
    start = time.monotonic()
    label = f"cleanup-{mode}"
    directory = root / label
    directory.mkdir()
    server = Server(directory)
    try:
        server.start()
        server.attach("kitty")
        server.ready(start + 10)
        if mode == "stopped-server":
            os.kill(server.process.pid, signal.SIGSTOP)
        elif mode == "launch-error":
            server.command[0] = str(directory / "missing-tmux")
        else:
            server.kill_server = lambda: subprocess.CompletedProcess([], 1, b"", b"forced failure")
        try:
            server.close()
        except AssertionError as error:
            assert "cleanup required fallback" in str(error), str(error)
        else:
            raise AssertionError("unsuccessful kill-server was not reported")
        assert server.process.poll() is not None
        assert not Path(f"/proc/{server.process.pid}").exists(), "cleanup left a server process"
        assert all(not Path(f"/proc/{pid}").exists() for pid in server.pane_groups), "cleanup left a pane process"
        assert all(not Path(f"/proc/{c['pid']}").exists() for c in server.clients), "cleanup left an attached client"
    finally:
        if server.process is not None and server.process.poll() is None:
            server.close()
    elapsed = round((time.monotonic() - start) * 1000, 1)
    assert elapsed < 10000, f"{label} exceeded its case deadline"
    return label, elapsed


def main():
    start = time.monotonic()
    temporary = Path(tempfile.gettempdir()).resolve()
    checkout = Path(repo).resolve()
    assert temporary != checkout and checkout not in temporary.parents, "tmux scratch root is inside checkout"
    timings = {}
    with tempfile.TemporaryDirectory(prefix="slate-tmux-", dir=temporary) as directory:
        root = Path(directory)
        cases = [(f"single-{name}", [name + ("(1.2.3)" if i % 2 else " 1.2.3")], [AUTOMATIC[i]], {})
                 for i, name in enumerate(NAMES)]
        cases.extend([
            ("protocol-tie", ["Konsole", "kitty"], ["osc777"], {}),
            ("two-protocols", ["iTerm2", "Konsole"], ["osc777", "osc9"], {}),
            ("maximum-coverage", ["iTerm2", "kitty"], ["osc9"], {}),
            ("fewer-protocols", ["iTerm2", "Konsole", "kitty"], ["osc777"], {}),
            ("unidentified", ["Konsole", "kitty", None, "xterm(400)"], ["osc777"], {}),
            ("osc99-before-osc9", ["vscode", "iTerm2"], ["osc99", "osc9"], {}),
            ("fixed-explicit-order", [None], ["osc777", "osc99", "osc9"], {"explicit": True}),
            ("inactive-all", ["Konsole", "kitty"], ["osc777"], {"permission": "all", "inactive": True}),
            ("inactive-on-silent", ["Konsole", "kitty"], ["osc777"], {"inactive": True}),
            ("delayed-inactive-on-silent", ["Konsole", "kitty"], ["osc777"], {"inactive": True, "delivery_delay": True}),
            ("default-bell-both", ["iTerm2", "kitty"], [], {"bell": True, "inactive": True}),
            ("real-query-failure", ["kitty"], ["osc9"], {"failure": True}),
            ("unexpected-csi-rejected", ["kitty"], ["osc777"], {"explicit": True, "unexpected_csi": True}),
        ])
        for label, names, protocols, options in cases:
            timings[label] = run_case(root, label, names, protocols, **options)
        for mode in ["command-failure", "stopped-server", "launch-error"]:
            label, elapsed = cleanup_case(root, mode)
            timings[label] = elapsed
    return {"cases_ms": timings, "wall_ms": round((time.monotonic() - start) * 1000, 1)}


print(json.dumps(main()))
