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
import math
import os
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TICK = 0.02  # seconds per simulation step
STREAM_PERIOD = 0.05  # seconds between state samples on the stream
DEVICES = ("chassis", "platform", "valves", "sensor")

# The machine, in metres, seconds and kilograms.
FLOOR_STOWED, FLOOR_MAX = 1.2, 9.0  # platform floor above the ground
ARM_LENGTH, STAGES = 2.4, 4  # scissor arm length and number of stages
ARM_SIN_STOWED = 0.02  # sine of the arm angle when stowed (the arms lie almost flat)
LIFT_SPEED = 0.24  # m/s at a full command and mid-range shape factor 1
DOWN_SPEED = 0.274  # m/s at a full command, before the load factor
RATED_LOAD = 450.0
VALVE_DEADBAND = 0.08  # fraction of full command below which no oil flows
VALVE_LAG = 0.1  # s, valve spool lag
PUMP_START = 0.3  # s from rest to full flow
DRIVE_SPEED = 1.0  # m/s at a full command
DRIVE_LAG = 0.5  # s
WHEELBASE = 1.9
STEER_RATE, STEER_MAX = 25.0, 35.0  # degrees per second, degrees
PATH_POINTS, PATH_STEP = 120, 0.25  # top view path: points kept and metres between them
ENABLE_KEEPALIVE = 1.0  # s without a page keep-alive before a held enable counts as released

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
DISPLAY_TEXT = {
    0: "Ready",
    1: "Emergency stop pressed",
    2: "Safety relay off: reset it",
    3: "Hold the enable switch",
    4: "Return the stick to neutral",
    5: "Tilt alarm: lower the platform",
    6: "Overload: reduce the load",
    7: "Descent stop: release the stick, then lower again",
    8: "Valve fault",
    9: "A node is missing",
    10: "Lifting",
    11: "Lowering",
    12: "Driving",
}


def load_state(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def clamp(value, low, high):
    return max(low, min(high, value))


def follow(value, target, tau, dt):
    """First-order lag of `value` towards `target` with time constant `tau`."""
    if tau <= 0:
        return target
    return value + (target - value) * min(1.0, dt / tau)


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
                self.last[cob_id & 0x1FFFFFFF] = (time.monotonic(), frame[8 : 8 + length])
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
        if item is None or time.monotonic() - item[0] > max_age:
            return None
        return item[1]

    def close(self):
        if self.sock is not None:
            self.sock.close()
        self.sock = None


class Gpio:
    """Lines of one gpio-sim chip, through the chip's sysfs directory. Writes only on change."""

    def __init__(self, info):
        self.sysfs = info["sysfs"]
        self.names = info["lines"].split()
        self.driven = {}

    def _path(self, name, leaf):
        return os.path.join(self.sysfs, "sim_gpio%d" % self.names.index(name), leaf)

    def drive(self, name, high):
        if name not in self.names or self.driven.get(name) == high:
            return
        try:
            with open(self._path(name, "pull"), "w", encoding="ascii") as handle:
                handle.write("pull-up" if high else "pull-down")
            self.driven[name] = high
        except OSError:
            self.driven.pop(name, None)

    def read(self, name):
        if name not in self.names:
            return False
        try:
            with open(self._path(name, "value"), encoding="ascii") as handle:
                return handle.read().strip() == "1"
        except OSError:
            return False


class Runtime:
    """Reads a runtime's PLC and CANopen status over its REST API, and starts or stops its PLC."""

    def __init__(self, port, user, password):
        self.port, self.user, self.password = port, user, password
        self.token = None
        self.context = ssl.create_default_context()
        self.context.check_hostname = False
        self.context.verify_mode = ssl.CERT_NONE

    def _call(self, path, body=None, timeout=2):
        request = urllib.request.Request("https://127.0.0.1:%d%s" % (self.port, path))
        if body is not None:
            request.data = json.dumps(body).encode()
            request.add_header("Content-Type", "application/json")
        if self.token:
            request.add_header("Authorization", "Bearer " + self.token)
        with urllib.request.urlopen(request, timeout=timeout, context=self.context) as answer:
            return json.loads(answer.read())

    def _login(self):
        if self.token is None:
            self.token = self._call("/api/login", {"username": self.user, "password": self.password})["access_token"]

    def status(self):
        try:
            self._login()
            out = summarize(self._call("/api/canopen/status"))
            answer = self._call("/api/status?include_stats=true")
            out["plc"] = plc_state(answer)
            out["scan"] = scan_stats(answer.get("timing_stats"))
            return out
        except urllib.error.HTTPError as exc:
            self.token = None
            if exc.code == 401:
                return {"reachable": False, "error": "no user yet: create the user in the editor first"}
            return {"reachable": False, "error": str(exc)}
        except (OSError, ValueError, KeyError) as exc:
            self.token = None
            return {"reachable": False, "error": str(exc)}

    def command(self, name):
        """Starts or stops the PLC: name is start-plc or stop-plc."""
        try:
            self._login()
            answer = self._call("/api/" + name, timeout=15)
            return True, str(answer.get("status", ""))
        except urllib.error.HTTPError as exc:
            self.token = None
            return False, str(exc)
        except (OSError, ValueError, KeyError) as exc:
            self.token = None
            return False, str(exc)


def plc_state(answer):
    """The PLC state from the runtime's status answer, such as RUNNING, STOPPED or EMPTY."""
    text = str(answer.get("status", "")).strip()
    return text.split(":", 1)[-1].upper() if text else "UNKNOWN"


def scan_stats(stats):
    """Scan time average and maximum in milliseconds and overruns, over all tasks, or None."""
    if not isinstance(stats, dict) or not isinstance(stats.get("tasks"), list):
        return None
    tasks = [t for t in stats["tasks"] if isinstance(t, dict) and t.get("scan_count")]
    if not tasks:
        return None
    return {
        "avg_ms": round(max(t.get("scan_time_avg") or 0 for t in tasks) / 1000.0, 2),
        "max_ms": round(max(t.get("scan_time_max") or 0 for t in tasks) / 1000.0, 2),
        "overruns": sum(t.get("overruns") or 0 for t in tasks),
    }


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


class Physics:
    """The lift's mechanics and hydraulics. Pure: no I/O, so it can be tried on its own."""

    def __init__(self):
        self.floor = FLOOR_STOWED
        self.lift_valve = 0.0  # spool position, -1 (down) to 1 (up)
        self.drive_valve = 0.0
        self.pump = 0.0  # 0 to 1
        self.lift_speed = 0.0  # m/s, platform floor
        self.lift_accel = 0.0
        self.speed = 0.0  # m/s, chassis
        self.drive_accel = 0.0
        self.wheel = 0.0  # degrees, front wheels, positive to the left
        self.heading = 0.0  # radians, 0 = to the right of the side view
        self.x = self.y = 0.0
        self.travel = 0.0
        self.odometer = 0.0  # signed distance along the machine, for the side view
        self.sway = 0.0  # degrees
        self.sway_rate = 0.0
        self.path = [(0.0, 0.0)]

    @property
    def lift_fraction(self):
        return (self.floor - FLOOR_STOWED) / (FLOOR_MAX - FLOOR_STOWED)

    @property
    def arm_sin(self):
        return ARM_SIN_STOWED + (self.floor - FLOOR_STOWED) / (STAGES * ARM_LENGTH)

    @staticmethod
    def flow(spool):
        """Oil flow through a proportional valve, 0 to 1, with its dead band."""
        opening = abs(spool)
        return 0.0 if opening <= VALVE_DEADBAND else (opening - VALVE_DEADBAND) / (1.0 - VALVE_DEADBAND)

    def step(self, dt, powered, lift_cmd, drive_cmd, steer, load):
        """lift_cmd and drive_cmd are -1 to 1 (signed by the direction valves), steer -1, 0 or 1."""
        self.lift_valve = follow(self.lift_valve, lift_cmd if powered else 0.0, VALVE_LAG, dt)
        self.drive_valve = follow(self.drive_valve, drive_cmd if powered else 0.0, VALVE_LAG, dt)
        pump_on = powered and (self.lift_valve > VALVE_DEADBAND or abs(self.drive_valve) > VALVE_DEADBAND or steer != 0)
        self.pump = clamp(self.pump + (dt / PUMP_START if pump_on else -dt / PUMP_START), 0.0, 1.0)

        # The platform rises slowly at the bottom and faster higher up; lowering is by gravity.
        shape = 0.55 + 0.6 * self.lift_fraction
        if self.lift_valve > 0:
            target = LIFT_SPEED * shape * self.flow(self.lift_valve) * self.pump * (1.0 - 0.05 * load / RATED_LOAD)
        elif self.lift_valve < 0:
            target = -DOWN_SPEED * shape * self.flow(self.lift_valve) * (0.92 + 0.1 * load / RATED_LOAD)
        else:
            target = 0.0
        speed = follow(self.lift_speed, target, 0.08, dt)
        floor = clamp(self.floor + speed * dt, FLOOR_STOWED, FLOOR_MAX)
        if floor in (FLOOR_STOWED, FLOOR_MAX):
            speed = 0.0
        self.lift_accel = (speed - self.lift_speed) / dt
        self.lift_speed, self.floor = speed, floor

        # Drive and on/off steering (bicycle model).
        target = DRIVE_SPEED * math.copysign(self.flow(self.drive_valve), self.drive_valve) * self.pump
        speed = follow(self.speed, target, DRIVE_LAG, dt)
        self.drive_accel = (speed - self.speed) / dt
        self.speed = speed
        if steer and self.pump > 0.5:
            self.wheel = clamp(self.wheel + steer * STEER_RATE * dt, -STEER_MAX, STEER_MAX)
        self.heading += self.speed * dt * math.tan(math.radians(self.wheel)) / WHEELBASE
        self.x += self.speed * dt * math.cos(self.heading)
        self.y += self.speed * dt * math.sin(self.heading)
        self.travel += abs(self.speed) * dt
        self.odometer += self.speed * dt
        last = self.path[-1]
        if math.hypot(self.x - last[0], self.y - last[1]) >= PATH_STEP:
            self.path.append((self.x, self.y))
            del self.path[:-PATH_POINTS]

        # The raised platform sways with the chassis' acceleration and settles in about a second.
        omega, zeta = 2 * math.pi * 0.8, 0.3
        push = -1.6 * self.drive_accel * self.lift_fraction
        self.sway_rate += (-omega * omega * (self.sway - push) - 2 * zeta * omega * self.sway_rate) * dt
        self.sway = clamp(self.sway + self.sway_rate * dt, -3.0, 3.0)

    def tilt(self, slope):
        return slope + self.sway

    def load_reading(self, load):
        """What the load cell reads: the load plus a short peak while the platform speeds up or slows down."""
        peak = clamp(self.lift_accel / 9.81 * 3.0, -0.08, 0.08)
        return max(0.0, load * (1.0 + peak))


class Machine:
    def __init__(self, state, run_script):
        self.state = state
        self.run_script = run_script
        self.lock = threading.Lock()
        self.inputs = dict(INPUT_DEFAULTS)
        self.stick_session = None
        self.stick_seq = -1
        self.enable_seen = 0.0
        self.latched = False
        self.physics = Physics()
        self.lift_cmd = 0
        self.drive_cmd = 0
        self.display = None
        self.lamps = {}
        self.valve_lines = {}
        self.runtimes = {}
        self.relay_message = ""
        self.action = {"running": None, "message": ""}
        devices = state["devices"]
        self.gpio = {dev: Gpio(devices[dev]) for dev in ("platform", "valves") if "sysfs" in devices.get(dev, {})}
        self.buses = {dev: CanBus(devices[dev]["sim"]) for dev in ("platform", "valves", "sensor") if "sim" in devices.get(dev, {})}
        self.runtime_clients = {dev: Runtime(info["port"], state["user"], state["password"]) for dev, info in devices.items()}
        self.action_lock = threading.Lock()
        self.stop = False

    # -------------------------------------------------------------- safety relay and inputs
    def _relay_closed(self, inputs):
        return self.latched and not inputs["ground_estop"] and not inputs["platform_estop"]

    def press_reset(self):
        with self.lock:
            if not self.inputs["ground_estop"] and not self.inputs["platform_estop"]:
                self.latched = True
                self.relay_message = "Safety relay reset"
                return True
            self.relay_message = "Release both emergency stops before the reset"
            return False

    def set_input(self, name, value):
        with self.lock:
            if name not in INPUT_DEFAULTS or name in ("stick_x", "stick_y"):
                return False
            if name in INPUT_LIMITS:
                low, high = INPUT_LIMITS[name]
                try:
                    value = clamp(float(value) if name == "slope" else int(float(value)), low, high)
                except (TypeError, ValueError):
                    return False
            else:
                value = bool(value)
            self.inputs[name] = value
            if name == "enable" and value:
                self.enable_seen = time.monotonic()
            if name in ("ground_estop", "platform_estop") and value:
                self.latched = False
                self.relay_message = ""
            return True

    def set_stick(self, x, y, seq, session, enable=None):
        """Both axes at once; a request older than the newest one seen from the same page is ignored."""
        with self.lock:
            try:
                x, y, seq = int(float(x)), int(float(y)), int(seq)
            except (TypeError, ValueError):
                return False
            if session == self.stick_session and seq <= self.stick_seq:
                return True
            self.stick_session, self.stick_seq = session, seq
            self.inputs["stick_x"] = clamp(x, -1000, 1000)
            self.inputs["stick_y"] = clamp(y, -1000, 1000)
            if enable is not None:
                self.inputs["enable"] = bool(enable)
            if self.inputs["enable"]:
                self.enable_seen = time.monotonic()
            return True

    # -------------------------------------------------------------- one simulation step
    def step(self, dt):
        for bus in self.buses.values():
            bus.drain()
        now = time.monotonic()
        with self.lock:
            if self.inputs["enable"] and now - self.enable_seen > ENABLE_KEEPALIVE:
                self.inputs["enable"] = False
                self.inputs["stick_x"] = self.inputs["stick_y"] = 0
            inputs = dict(self.inputs)
            relay = self._relay_closed(inputs)
        platform, valves = self.gpio.get("platform"), self.gpio.get("valves")
        lamps, lines = {}, {}
        if platform:
            platform.drive("PB_ESTOP_NC", not inputs["platform_estop"])
            platform.drive("PB_ENABLE", inputs["enable"])
            platform.drive("PB_DRIVE_MODE", inputs["drive_mode"])
            platform.drive("PB_HORN", inputs["horn"])
            platform.drive("PB_LIGHT", inputs["light"])
            lamps = {n: platform.read(n) for n in platform.names if n.startswith("PB_LAMP") or n == "PB_BUZZER"}
        if valves:
            valves.drive("VM_SUPPLY_OK", relay)
            valves.drive("VM_COIL_FAULT", inputs["coil_fault"])
            lines = {n: valves.read(n) for n in valves.names if n not in ("VM_SUPPLY_OK", "VM_COIL_FAULT")}
        if "platform" in self.buses:
            bus = self.buses["platform"]
            bus.send(0x202, struct.pack("<hh", inputs["stick_x"], inputs["stick_y"]))
            frame = bus.get(0x182)
            display = frame[0] if frame else None
        else:
            display = None
        frame = self.buses["valves"].get(0x182) if "valves" in self.buses else None
        lift_cmd, drive_cmd = struct.unpack("<hh", frame[:4]) if frame else (0, 0)
        lift = (1 if lines.get("VM_LIFT_UP") else -1 if lines.get("VM_LIFT_DOWN") else 0) * abs(lift_cmd) / 1000.0
        drive = (1 if lines.get("VM_DRIVE_FWD") else -1 if lines.get("VM_DRIVE_REV") else 0) * abs(drive_cmd) / 1000.0
        steer = (1 if lines.get("VM_STEER_LEFT") else 0) - (1 if lines.get("VM_STEER_RIGHT") else 0)
        physics = self.physics
        physics.step(dt, relay, lift, drive, steer, inputs["load"])
        if "sensor" in self.buses:
            raw_tilt = int(round(clamp(physics.tilt(inputs["slope"]), -327.0, 327.0) * 100))
            height_mm = int(round(physics.floor * 1000))
            self.buses["sensor"].send(0x202, struct.pack("<hHH", raw_tilt, height_mm, int(round(physics.load_reading(inputs["load"])))))
        with self.lock:
            self.lamps, self.valve_lines, self.display = lamps, lines, display
            self.lift_cmd, self.drive_cmd = lift_cmd, drive_cmd

    def loop(self):
        deadline = time.monotonic()
        while not self.stop:
            deadline += TICK
            self.step(TICK)
            delay = deadline - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            elif delay < -0.5:
                deadline = time.monotonic()  # far behind: start again rather than run many steps at once

    def poll_runtime(self, dev, client):
        while not self.stop:
            started = time.monotonic()
            status = client.status()
            with self.lock:
                self.runtimes[dev] = status
            time.sleep(max(0.2, 1.0 - (time.monotonic() - started)))

    # -------------------------------------------------------------- views and actions
    def view(self):
        p = self.physics
        with self.lock:
            inputs = dict(self.inputs)
            return {
                "t": time.monotonic(),
                "inputs": inputs,
                "relay": {"closed": self._relay_closed(inputs), "latched": self.latched},
                "floor": round(p.floor, 3),
                "lift_speed": round(p.lift_speed, 3),
                "tilt": round(p.tilt(inputs["slope"]), 2),
                "load_reading": round(p.load_reading(inputs["load"])),
                "speed": round(p.speed, 3),
                "travel": round(p.travel, 2),
                "odometer": round(p.odometer, 3),
                "x": round(p.x, 3),
                "y": round(p.y, 3),
                "heading": round(p.heading, 4),
                "wheel": round(p.wheel, 1),
                "pump": round(p.pump, 2),
                "lift": self.lift_cmd,
                "drive": self.drive_cmd,
                "display": self.display,
                "display_text": DISPLAY_TEXT.get(self.display, "No display (platform box not running)") if self.display is not None else "No display (platform box not running)",
                "lamps": dict(self.lamps),
                "valves": dict(self.valve_lines),
                "relay_message": self.relay_message,
                "action": dict(self.action),
            }

    def runtimes_view(self):
        with self.lock:
            return dict(self.runtimes)

    def path_view(self):
        return [[round(x, 2), round(y, 2)] for x, y in self.physics.path]

    def _run_action(self, label, args):
        try:
            done = subprocess.run([self.run_script, *args], capture_output=True, text=True, check=False, timeout=120)
            text = (done.stdout + done.stderr).strip()
            message = text.splitlines()[0] if text else ("done" if done.returncode == 0 else "failed")
        except (OSError, subprocess.TimeoutExpired) as exc:
            message = str(exc)
        finally:
            self.action_lock.release()
        with self.lock:
            self.action = {"running": None, "message": "%s: %s" % (label, message)}

    def _run_plc(self, label, dev, name):
        try:
            ok, message = self.runtime_clients[dev].command(name)
        finally:
            self.action_lock.release()
        with self.lock:
            self.action = {"running": None, "message": "%s: %s" % (label, message if message else ("done" if ok else "failed"))}

    def act(self, name, device=None):
        if name == "reset":
            return self.press_reset()
        if name in ("start-plc", "stop-plc") and device in self.runtime_clients:
            label = "%s PLC on %s" % ("Start" if name == "start-plc" else "Stop", device)
            target, args = self._run_plc, (label, device, name)
        elif name in ("stop", "start") and device in DEVICES:
            if not self.run_script:
                return False
            label = "%s %s" % (name.capitalize(), device)
            target, args = self._run_action, (label, [name, device])
        elif name == "swap":
            if not self.run_script:
                return False
            label = "Replace the platform box"
            target, args = self._run_action, (label, ["swap"])
        else:
            return False
        if not self.action_lock.acquire(blocking=False):
            return False
        with self.lock:
            self.action = {"running": label, "message": ""}
        threading.Thread(target=target, args=args, daemon=True).start()
        return True


class Handler(http.server.BaseHTTPRequestHandler):
    machine = None
    protocol_version = "HTTP/1.1"

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

    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        machine = self.machine
        next_slow = 0.0
        try:
            while not machine.stop:
                now = time.monotonic()
                parts = ["event: state\ndata: %s\n\n" % json.dumps(machine.view())]
                if now >= next_slow:
                    next_slow = now + 1.0
                    parts.append("event: runtimes\ndata: %s\n\n" % json.dumps(machine.runtimes_view()))
                    parts.append("event: path\ndata: %s\n\n" % json.dumps(machine.path_view()))
                self.wfile.write("".join(parts).encode())
                self.wfile.flush()
                time.sleep(STREAM_PERIOD)
        except OSError:
            pass

    def do_GET(self):
        if self.path == "/api/stream":
            self._stream()
        elif self.path == "/api/state":
            body = self.machine.view()
            body["runtimes"] = self.machine.runtimes_view()
            self._send(200, body)
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
        if not isinstance(body, dict):
            self._send(400, {"error": "bad json"})
            return
        if self.path == "/api/input":
            ok = self.machine.set_input(str(body.get("name")), body.get("value"))
        elif self.path == "/api/stick":
            ok = self.machine.set_stick(body.get("x", 0), body.get("y", 0), body.get("seq", 0), str(body.get("session")), body.get("enable"))
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
        scan = status.get("scan")
        timing = " scan avg %.2f ms max %.2f ms overruns %d" % (scan["avg_ms"], scan["max_ms"], scan["overruns"]) if scan else ""
        print("%-9s plc=%s canopen=%s%s" % (dev, status["plc"], "active" if status["active"] else "idle", timing))
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
    for dev, client in machine.runtime_clients.items():
        threading.Thread(target=machine.poll_runtime, args=(dev, client), daemon=True).start()
    server = http.server.ThreadingHTTPServer((args.bind, args.port), Handler)
    server.daemon_threads = True
    print("Machine panel on http://%s:%d/ (this is a demonstration, not a safety system)" % (args.bind, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    machine.stop = True
    return 0


if __name__ == "__main__":
    sys.exit(main())
