#!/usr/bin/env python3
"""Machine panel of the scissor lift example (standard library only).

It plays the machine around the four runtimes: the operator controls, the safety relay,
the hydraulics and the sensors. It sets simulated GPIO inputs, sends simulation frames
on the per-device simulation buses and shows what the runtimes report.

This is a demonstration. It is not a safety system.
"""
import argparse
import http.server
import json
import os
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TICK = 0.02
HEIGHT_MIN, HEIGHT_MAX = 1200, 9000  # millimetres
LIFT_SPEED = 150.0  # mm/s at a full command
DRIVE_SPEED = 1.0  # m/s at a full command
ACTIONS = {"reset", "swap"}
DEVICES = ("chassis", "platform", "valves", "sensor")

INPUT_DEFAULTS = {
    "ground_estop": False,
    "platform_estop": False,
    "enable": False,
    "drive_mode": False,
    "horn": False,
    "light": False,
    "coil_fault": False,
    "stick_x": 0,
    "stick_y": 0,
    "slope": 0.0,
    "load": 80,
}
INPUT_LIMITS = {"stick_x": (-1000, 1000), "stick_y": (-1000, 1000), "slope": (-8.0, 8.0), "load": (0, 700)}


def load_state(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


class CanBus:
    """A raw SocketCAN socket on one interface that reconnects when the interface goes away."""

    def __init__(self, name):
        self.name = name
        self.sock = None
        self.last = {}

    def _open(self):
        sock = socket.socket(socket.AF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
        sock.bind((self.name,))
        sock.setblocking(False)
        self.sock = sock

    def drain(self):
        if self.sock is None:
            try:
                self._open()
            except OSError:
                return
        try:
            while True:
                frame = self.sock.recv(16)
                cob_id, length = struct.unpack("=IB", frame[:5])
                self.last[cob_id & 0x1FFFFFFF] = (time.time(), frame[8 : 8 + length])
        except BlockingIOError:
            pass
        except OSError:
            self.close()

    def send(self, cob_id, data):
        if self.sock is None:
            try:
                self._open()
            except OSError:
                return
        try:
            self.sock.send(struct.pack("=IB3x8s", cob_id, len(data), bytes(data).ljust(8, b"\0")))
        except OSError:
            self.close()

    def get(self, cob_id, max_age=0.5):
        item = self.last.get(cob_id)
        if item is None or time.time() - item[0] > max_age:
            return None
        return item[1]

    def close(self):
        if self.sock is not None:
            self.sock.close()
        self.sock = None


class Gpio:
    """Lines of one gpio-sim chip, through the chip's sysfs directory."""

    def __init__(self, info):
        self.sysfs = info["sysfs"]
        self.names = info["lines"].split()

    def _path(self, name, leaf):
        return os.path.join(self.sysfs, "sim_gpio%d" % self.names.index(name), leaf)

    def drive(self, name, high):
        try:
            with open(self._path(name, "pull"), "w", encoding="ascii") as handle:
                handle.write("pull-up" if high else "pull-down")
        except OSError:
            pass

    def read(self, name):
        try:
            with open(self._path(name, "value"), encoding="ascii") as handle:
                return handle.read().strip() == "1"
        except OSError:
            return False


class Runtime:
    """Reads a runtime's CANopen status over its REST API."""

    def __init__(self, port, user, password):
        self.port, self.user, self.password = port, user, password
        self.token = None
        self.context = ssl.create_default_context()
        self.context.check_hostname = False
        self.context.verify_mode = ssl.CERT_NONE

    def _call(self, path, body=None):
        request = urllib.request.Request("https://127.0.0.1:%d%s" % (self.port, path))
        if body is not None:
            request.data = json.dumps(body).encode()
            request.add_header("Content-Type", "application/json")
        if self.token:
            request.add_header("Authorization", "Bearer " + self.token)
        with urllib.request.urlopen(request, timeout=2, context=self.context) as answer:
            return json.loads(answer.read())

    def status(self):
        try:
            if self.token is None:
                self.token = self._call("/api/login", {"username": self.user, "password": self.password})["access_token"]
            return summarize(self._call("/api/canopen/status"))
        except (OSError, ValueError, KeyError) as exc:
            self.token = None
            return {"reachable": False, "error": str(exc)}


def summarize(status):
    out = {"reachable": True, "active": bool(status.get("active")), "nodes": [], "slaves": [], "bus": None, "events": []}
    for net in status.get("networks", []):
        bus = net.get("bus", {})
        out["bus"] = {"state": bus.get("state"), "load": bus.get("load_percent")}
        for node in net.get("nodes", []):
            out["nodes"].append(
                {"name": node.get("name"), "state": node.get("state"), "nmt": node.get("nmt"), "enabled": node.get("enabled"), "warning": node.get("warning")}
            )
        out["events"] = [e.get("kind") for e in net.get("events", [])[:6]]  # newest first
    for slave in status.get("slaves", []):
        item = {"name": slave.get("name"), "state": slave.get("state"), "node_id": slave.get("node_id"), "master_seen": slave.get("master_seen")}
        if "lss" in slave:
            item["lss"] = slave["lss"].get("state")
            item["node_id_from"] = slave["lss"].get("node_id_from")
        out["slaves"].append(item)
    return out


class Machine:
    def __init__(self, state, run_script):
        self.state = state
        self.run_script = run_script
        self.lock = threading.Lock()
        self.inputs = dict(INPUT_DEFAULTS)
        self.latched = False
        self.height = 1200.0
        self.travel = 0.0
        self.lift_cmd = 0
        self.drive_cmd = 0
        self.lamps = {}
        self.valve_lines = {}
        self.runtimes = {}
        self.message = ""
        devices = state["devices"]
        self.gpio = {dev: Gpio(devices[dev]) for dev in ("platform", "valves") if "sysfs" in devices.get(dev, {})}
        self.buses = {dev: CanBus(devices[dev]["sim"]) for dev in ("platform", "valves", "sensor") if "sim" in devices.get(dev, {})}
        self.runtime_clients = {dev: Runtime(info["port"], state["user"], state["password"]) for dev, info in devices.items()}
        self.stop = False

    # -------------------------------------------------------------- safety relay and sensors
    @property
    def relay_closed(self):
        return self.latched and not self.inputs["ground_estop"] and not self.inputs["platform_estop"]

    def press_reset(self):
        with self.lock:
            if not self.inputs["ground_estop"] and not self.inputs["platform_estop"]:
                self.latched = True
                self.message = "Safety relay reset"
                return True
            self.message = "Release both emergency stops before the reset"
            return False

    def set_input(self, name, value):
        with self.lock:
            if name not in INPUT_DEFAULTS:
                return False
            if name in INPUT_LIMITS:
                low, high = INPUT_LIMITS[name]
                value = max(low, min(high, float(value) if name == "slope" else int(value)))
            else:
                value = bool(value)
            self.inputs[name] = value
            if name in ("ground_estop", "platform_estop") and value:
                self.latched = False
            return True

    # -------------------------------------------------------------- one simulation step
    def step(self):
        for bus in self.buses.values():
            bus.drain()
        inputs = self.inputs
        relay = self.relay_closed
        platform, valves = self.gpio.get("platform"), self.gpio.get("valves")
        if platform:
            platform.drive("PB_ESTOP_NC", not inputs["platform_estop"])
            platform.drive("PB_ENABLE", inputs["enable"])
            platform.drive("PB_DRIVE_MODE", inputs["drive_mode"])
            platform.drive("PB_HORN", inputs["horn"])
            platform.drive("PB_LIGHT", inputs["light"])
            self.lamps = {n: platform.read(n) for n in platform.names if n.startswith("PB_LAMP") or n == "PB_BUZZER"}
        if valves:
            valves.drive("VM_SUPPLY_OK", relay)
            valves.drive("VM_COIL_FAULT", inputs["coil_fault"])
            self.valve_lines = {n: valves.read(n) for n in valves.names if n not in ("VM_SUPPLY_OK", "VM_COIL_FAULT")}
        sensor = self.buses.get("sensor")
        if "platform" in self.buses:
            self.buses["platform"].send(0x202, struct.pack("<hh", inputs["stick_x"], inputs["stick_y"]))
        lines = self.valve_lines
        cmd = self.buses["valves"].get(0x182) if "valves" in self.buses else None
        if cmd:
            self.lift_cmd, self.drive_cmd = struct.unpack("<hh", cmd[:4])
        lift = (1 if lines.get("VM_LIFT_UP") else -1 if lines.get("VM_LIFT_DOWN") else 0) * abs(self.lift_cmd)
        drive = (1 if lines.get("VM_DRIVE_FWD") else -1 if lines.get("VM_DRIVE_REV") else 0) * abs(self.drive_cmd)
        if not relay:
            lift = drive = 0
        self.height = max(HEIGHT_MIN, min(HEIGHT_MAX, self.height + lift / 1000.0 * LIFT_SPEED * TICK))
        self.travel += drive / 1000.0 * DRIVE_SPEED * TICK
        self.lift_now, self.drive_now = lift, drive
        if sensor:
            raw_tilt = int(round(inputs["slope"] * 100))
            sensor.send(0x202, struct.pack("<hHH", raw_tilt, int(self.height), inputs["load"]))

    def loop(self):
        while not self.stop:
            started = time.time()
            with self.lock:
                self.step()
            time.sleep(max(0.0, TICK - (time.time() - started)))

    def poll_runtimes(self):
        while not self.stop:
            for dev, client in self.runtime_clients.items():
                self.runtimes[dev] = client.status()
            time.sleep(1.0)

    # -------------------------------------------------------------- views and actions
    def view(self):
        with self.lock:
            return {
                "inputs": dict(self.inputs),
                "relay": {"closed": self.relay_closed, "latched": self.latched},
                "height": round(self.height),
                "travel": round(self.travel, 1),
                "lift": getattr(self, "lift_now", 0),
                "drive": getattr(self, "drive_now", 0),
                "lamps": self.lamps,
                "valves": self.valve_lines,
                "runtimes": dict(self.runtimes),
                "message": self.message,
            }

    def act(self, name, device=None):
        if name == "reset":
            return self.press_reset()
        if name in ("stop", "start") and device in DEVICES:
            args = [name, device]
        elif name == "swap":
            args = ["swap"]
        else:
            return False
        if not self.run_script:
            self.message = "No run script given"
            return False
        done = subprocess.run([self.run_script, *args], capture_output=True, text=True, check=False)
        self.message = (done.stdout + done.stderr).strip().splitlines()[0] if (done.stdout + done.stderr).strip() else ""
        return done.returncode == 0


class Handler(http.server.BaseHTTPRequestHandler):
    machine = None

    def log_message(self, *_args):
        pass

    def _send(self, code, body, kind="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/state":
            self._send(200, self.machine.view())
        elif self.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as handle:
                self._send(200, handle.read(), "text/html; charset=utf-8")
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        except ValueError:
            self._send(400, {"error": "bad json"})
            return
        if self.path == "/api/input":
            ok = self.machine.set_input(str(body.get("name")), body.get("value"))
        elif self.path == "/api/action":
            ok = self.machine.act(str(body.get("name")), body.get("device"))
        else:
            self._send(404, {"error": "not found"})
            return
        self._send(200 if ok else 400, {"ok": ok})


def print_status(state):
    clients = {dev: Runtime(info["port"], state["user"], state["password"]) for dev, info in state["devices"].items()}
    for dev, client in clients.items():
        status = client.status()
        if not status["reachable"]:
            print("%-9s not reachable (%s)" % (dev, status["error"]))
            continue
        print("%-9s active=%s" % (dev, status["active"]))
        for node in status["nodes"]:
            print("            node %-10s %-12s nmt=%s" % (node["name"], node["state"], node["nmt"]))
        for slave in status["slaves"]:
            print("            slave %-9s %s" % (slave["name"], slave["state"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True)
    parser.add_argument("--run")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    state = load_state(args.state)
    if args.status:
        print_status(state)
        return 0
    machine = Machine(state, args.run)
    Handler.machine = machine
    threading.Thread(target=machine.loop, daemon=True).start()
    threading.Thread(target=machine.poll_runtimes, daemon=True).start()
    server = http.server.ThreadingHTTPServer((args.bind, args.port), Handler)
    print("Machine panel on http://%s:%d/ (this is a demonstration, not a safety system)" % (args.bind, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    machine.stop = True
    return 0


if __name__ == "__main__":
    sys.exit(main())
