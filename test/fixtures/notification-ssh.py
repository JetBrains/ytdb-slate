"""Capture SSH client terminal bytes. No terminal emulator interprets this output."""
import errno
import json
import os
from pathlib import Path
import pwd
import re
import select
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import tty
import uuid

node, fixture, sshd, ssh, keygen, repo = sys.argv[1:]
assert os.getuid() != 0, "the SSH check must never run as root"
ESC, BEL, ST = b"\x1b", b"\x07", b"\x1b\\"
CASE_SECONDS = 15


def interrupted(_signal, _frame):
    raise SystemExit("SSH harness interrupted")


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)


def stop(child):
    # Each child owns its process group. TERM and KILL waits are both bounded.
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)


def stop_fixture(path):
    record = Path(str(path) + ".pid")
    if not record.exists():
        return
    pid = int(record.read_text())
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        # A reused PID must not authorize a signal to an unrelated process.
        command = Path(f"/proc/{pid}/cmdline")
        if command.exists() and str(path).encode() in command.read_bytes().split(b"\0"):
            signal.pidfd_send_signal(fd, signal.SIGKILL)
            assert select.select([fd], [], [], 2)[0], "remote fixture did not terminate"
    except (ProcessLookupError, FileNotFoundError):
        pass
    finally:
        os.close(fd)


def drain(fd, deadline):
    data = b""
    while True:
        remaining = deadline - time.monotonic()
        assert remaining > 0, "SSH did not exit within its case bound"
        assert select.select([fd], [], [], remaining)[0], "SSH client terminal did not close"
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return data
            raise
        if not chunk:
            return data
        data += chunk
        assert len(data) <= 65536, "unexpected SSH output growth"


def receive(fd, marker, deadline):
    data = b""
    while marker not in data:
        remaining = deadline - time.monotonic()
        assert remaining > 0, f"SSH byte wait exceeded {CASE_SECONDS}s: {data!r}"
        assert select.select([fd], [], [], remaining)[0], f"missing SSH marker: {data!r}"
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                raise AssertionError(f"client terminal closed before marker: {data!r}") from error
            raise
        assert chunk, f"SSH stream closed before marker: {data!r}"
        data += chunk
        assert len(data) <= 65536, "unexpected SSH output growth"
    return data


def truncate(value, budget):
    # The oracle does not import the production sanitizer or byte assembler.
    result = b""
    for character in value:
        encoded = character.encode("utf8")
        if len(result) + len(encoded) > budget:
            break
        result += encoded
    return result


def expected(config, captured):
    forbidden = set(range(32)) | set(range(127, 160)) | {
        0x61C, 0x200E, 0x200F, *range(0x2028, 0x202F), *range(0x2066, 0x206A)}
    def clean(value):
        return "".join(c for c in value if ord(c) not in forbidden)
    protocol = config["protocol"]
    title, body = ("Input needed", "") if config["generic"] else (clean(config["title"]), clean(config["body"]))
    if protocol != "osc99":
        title, body = title.replace(";", ""), body.replace(";", "")
    def assemble(header, payload, ending):
        return header + truncate(payload, 252 - len(header + ending)) + ending
    if protocol == "osc9":
        sequences = [assemble(ESC + b"]9;Slate: ", title + ": " + body, BEL)]
    elif protocol == "osc777":
        sequences = [assemble(ESC + b"]777;notify;" + truncate(title, 100) + b";", body, BEL)]
    else:
        match = re.search(rb"\x1b\]99;i=([a-zA-Z0-9_+.-]{1,36}):d=0;", captured)
        assert match, f"missing OSC 99 title metadata: {captured!r}"
        identifier = match[1]
        assert identifier != b"0", "reserved OSC 99 identifier"
        sequences = [assemble(ESC + b"]99;i=" + identifier + b":d=0;", title, ST),
                     assemble(ESC + b"]99;i=" + identifier + b":p=body:d=1;", body, ST)]
    for sequence in sequences:
        assert len(sequence) <= 252
        sequence.decode("utf8", errors="strict")
    if config["screen"]:
        # OSC 99 splits its inner ST between two complete screen envelopes.
        sequences = [ESC + b"P" + s[:-1] + ST + ESC + b"P\\" + ST if s.endswith(ST)
                     else ESC + b"P" + s + ST for s in sequences]
    return b"".join(sequences) + BEL


def run_case(root, base, config, environment):
    start = time.monotonic()
    deadline = start + CASE_SECONDS
    path = root / "case.json"
    path.write_text(json.dumps(config), encoding="utf8")
    Path(str(path) + ".pid").unlink(missing_ok=True)
    command = shlex.join(["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", f"HOME={root}", "LANG=C.UTF-8",
                          node, "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", fixture, str(path)])
    master, slave = os.openpty()
    child = None
    try:
        tty.setraw(slave)
        child = subprocess.Popen(base + (["-T"] if config["headless"] else ["-tt"]) + [command],
                                 stdin=slave, stdout=slave, stderr=subprocess.PIPE,
                                 env=environment, start_new_session=True)
        os.close(slave)
        slave = None
        if config["headless"]:
            # Read the client terminal through EOF. Any byte is a headless failure.
            data = drain(master, deadline)
            assert data == b"", f"headless SSH wrote client bytes: {data!r}"
        else:
            ready, done = (f"{label}-{config['nonce']}".encode() for label in ["READY", "DONE"])
            before = receive(master, ready, deadline)
            assert before == ready, f"output before delivery: {before!r}"
            assert config["nonce"].encode() not in before.removeprefix(ready), "notification text existed before send"
            os.write(master, b"s")
            captured = receive(master, done, deadline)
            assert captured.endswith(done), f"extra bytes after completion: {captured!r}"
            payload = captured[:-len(done)]
            assert payload == expected(config, payload), f"client bytes differ from sanitized complete requests: {payload!r}"
            os.write(master, b"q")
            assert drain(master, deadline) == b"", "extra client bytes after completion"
        child.wait(timeout=max(0.001, deadline - time.monotonic()))
        stderr = child.stderr.read()
        assert child.returncode == 0, f"SSH exited {child.returncode}: {stderr!r}"
        assert stderr == b"", f"SSH client diagnostics: {stderr!r}"
        return round((time.monotonic() - start) * 1000, 1)
    finally:
        try:
            stop_fixture(path)
        finally:
            try:
                if child is not None:
                    stop(child)
                    if sys.exc_info()[0] is not None:
                        print(f"SSH client diagnostics: {child.stderr.read()!r}", file=sys.stderr)
                    child.stderr.close()
            finally:
                os.close(master)
                if slave is not None:
                    os.close(slave)


def main():
    started = time.monotonic()
    # Resolve TMPDIR physically before creating keys or configuration.
    temporary = Path(tempfile.gettempdir()).resolve()
    checkout = Path(repo).resolve()
    assert temporary != checkout and checkout not in temporary.parents, "SSH scratch root is inside checkout"
    with tempfile.TemporaryDirectory(prefix="slate-ssh-", dir=temporary) as directory:
        root = Path(directory)
        environment = {"PATH": "/usr/bin:/bin", "HOME": str(root), "LANG": "C.UTF-8", "TERM": "xterm-256color"}
        for name in ["host", "user"]:
            subprocess.run([keygen, "-q", "-t", "ed25519", "-N", "", "-f", str(root / name)],
                           env=environment, check=True, timeout=5, stdin=subprocess.DEVNULL, capture_output=True)
        (root / "authorized_keys").write_text((root / "user.pub").read_text())
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        assert port > 1024
        user = pwd.getpwuid(os.getuid()).pw_name
        config = root / "sshd_config"
        # The private directory protects keys. StrictModes cannot accept /tmp ancestors.
        config.write_text(f"""ListenAddress 127.0.0.1
Port {port}
HostKey {root}/host
PidFile {root}/sshd.pid
AuthorizedKeysFile {root}/authorized_keys
AllowUsers {user}
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
AllowAgentForwarding no
X11Forwarding no
AllowTcpForwarding no
PermitTunnel no
PermitUserEnvironment no
PermitUserRC no
PrintMotd no
PrintLastLog no
LogLevel VERBOSE
""")
        # Pin the throwaway host key. No user SSH config or known-host store is read.
        (root / "known_hosts").write_text(f"[127.0.0.1]:{port} " + (root / "host.pub").read_text())
        daemon = subprocess.Popen([sshd, "-D", "-e", "-f", str(config)], env=environment,
                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                  start_new_session=True, bufsize=0)
        ready = threading.Event()
        logs = []
        def read_log():
            for line in daemon.stderr:
                logs.append(line)
                if len(logs) > 200:
                    del logs[0]
                if f"Server listening on 127.0.0.1 port {port}".encode() in line:
                    ready.set()
        reader = threading.Thread(target=read_log, daemon=True)
        reader.start()
        try:
            assert ready.wait(timeout=5), f"sshd did not listen: {b''.join(logs)!r}"
            base = [ssh, "-F", "/dev/null", "-p", str(port), "-i", str(root / "user"),
                    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
                    "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={root}/known_hosts",
                    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
                    "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=5", "-o", "LogLevel=ERROR",
                    f"{user}@127.0.0.1"]
            timings = {}
            controls = "".join(chr(c) for c in list(range(32)) + list(range(127, 160)) +
                               [0x61C, 0x200E, 0x200F, *range(0x2028, 0x202F), *range(0x2066, 0x206A)])
            for screen in [False, True]:
                for protocol in ["osc9", "osc777", "osc99"]:
                    for shape in ["hostile", "long", "generic"]:
                        nonce = uuid.uuid4().hex
                        case = {"protocol": protocol, "screen": screen, "headless": False,
                                "generic": shape == "generic", "nonce": nonce,
                                "title": f"T-{nonce};:=é" + controls + "\x1b\\ST-END",
                                "body": f"B-{nonce};:=😀" + controls + "\x1b\\ST-END"}
                        if shape == "long":
                            case["body"] += "é😀" * 400
                        name = f"{protocol}-{'screen-envelope' if screen else 'direct'}-{shape}"
                        timings[name] = run_case(root, base, case, environment)
            timings["headless"] = run_case(root, base, {**case, "headless": True}, environment)
            measured = {"cases_ms": timings}
        finally:
            stop(daemon)
            reader.join(timeout=2)
            if sys.exc_info()[0] is not None:
                print(f"SSH server diagnostics: {b''.join(logs)!r}", file=sys.stderr)
            daemon.stderr.close()
    measured["wall_ms"] = round((time.monotonic() - started) * 1000, 1)
    return measured


print(json.dumps(main()))
