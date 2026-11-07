PROGRAM main
  VAR
    (* Inputs from the nodes, as the master maps them. *)
    platform_state AT %IB0 : USINT;
    joy_x AT %IW0 : INT;
    joy_y AT %IW1 : INT;
    buttons AT %IB1 : BYTE;
    valves_state AT %IB2 : USINT;
    lift_applied AT %IW2 : INT;
    drive_applied AT %IW3 : INT;
    valve_status AT %IB3 : BYTE;
    sensor_state AT %IB4 : USINT;
    tilt AT %IW4 : INT;
    height AT %IW5 : UINT;
    load AT %IW6 : UINT;
    worklight_state AT %IB5 : USINT;
    (* Outputs to the nodes. *)
    lamps AT %QB0 : BYTE;
    lift_sp AT %QW0 : INT;
    drive_sp AT %QW1 : INT;
    valve_enable AT %QB1 : BYTE;
    light_cmd AT %QB2 : BYTE;

    net : CANOPEN_NETWORK_STATE;
    light_node : CANOPEN_NODE_ENABLE;
    sensor_emcy : RECV_EMCY_DEV;
    valves_emcy : RECV_EMCY_DEV;
    stop_valves : NMT;
    start_valves : NMT;
    read_serial : SDO_READ_STRING;
    read_seconds : SDO_READ4;
    write_ramp : SDO_WRITE4;
    poll : TON;

    estop_healthy, enable_switch, drive_mode, work_light : BOOL;
    supply_ok, coil_fault, estop, neutral, need_neutral : BOOL;
    overload, valve_fault, tilt_alarm, base_ok, can_move, ready, lift_up_ok : BOOL;
    want_seconds, want_ramp, serial_done : BOOL;
    last_mode : BOOL;
    ramp_ms : UDINT;
    sensor_serial : STRING;
    operating_s : UDINT;
    stick : INT;
    raised : BOOL;
  END_VAR

(* What the platform box reports in its buttons byte, and what the valve module reports in its status. *)
estop_healthy := (buttons AND 16#01) <> 0;
enable_switch := (buttons AND 16#02) <> 0;
drive_mode := (buttons AND 16#04) <> 0;
work_light := (buttons AND 16#10) <> 0;
supply_ok := (valve_status AND 16#01) <> 0;
coil_fault := (valve_status AND 16#02) <> 0;

(* The safety relay cuts the valves by itself; the program only sees its status and keeps the
   machine still until the stick has been in neutral after a reset. *)
estop := NOT estop_healthy OR NOT supply_ok;
neutral := ABS(joy_x) < 50 AND ABS(joy_y) < 50;
IF estop THEN
  need_neutral := TRUE;
ELSIF neutral THEN
  need_neutral := FALSE;
END_IF;

(* The sensor's emergencies: overload on (3200h) and off (0000h). The valve module's coil fault is 5000h. *)
sensor_emcy(ENABLE := TRUE, DEVICE := sensor);
IF sensor_emcy.CONFIRM THEN
  IF sensor_emcy.EMCY.ERRORCODE = 16#3200 THEN
    overload := TRUE;
  ELSIF sensor_emcy.EMCY.ERRORCODE = 16#0000 THEN
    overload := FALSE;
  END_IF;
END_IF;
valves_emcy(ENABLE := TRUE, DEVICE := valves);
IF valves_emcy.CONFIRM THEN
  IF valves_emcy.EMCY.ERRORCODE = 16#5000 THEN
    valve_fault := TRUE;
  ELSIF valves_emcy.EMCY.ERRORCODE = 16#0000 THEN
    valve_fault := FALSE;
  END_IF;
END_IF;

(* The platform floor is 1200 mm high when stowed; more than 300 mm above that counts as raised.
   A tilt of more than 3.00 degrees with the platform raised stops the valve module over NMT. It is
   started again once the tilt is back within 2.50 degrees and the stick is in neutral. *)
raised := height > 1500;
IF raised AND ABS(tilt) > 300 THEN
  tilt_alarm := TRUE;
ELSIF ABS(tilt) < 250 THEN
  tilt_alarm := FALSE;
END_IF;
stop_valves(ENABLE := tilt_alarm AND valves_state = 5, DEVICE := valves, STATE := STOP_REMOTE_NODE);
start_valves(ENABLE := NOT tilt_alarm AND neutral AND valves_state = STOPPED, DEVICE := valves, STATE := START_REMOTE_NODE);

(* Moving needs the platform box and the valve module up, a healthy circuit, the enable switch and no fault. *)
net(ENABLE := TRUE);
base_ok := platform_state = 5 AND valves_state = 5;
can_move := base_ok AND NOT estop AND NOT need_neutral AND enable_switch AND NOT valve_fault AND NOT coil_fault;
lift_up_ok := sensor_state = 5 AND NOT overload AND NOT tilt_alarm;
lift_sp := 0;
drive_sp := 0;
valve_enable := 16#00;
IF can_move THEN
  valve_enable := 16#03;
  stick := joy_y;
  IF NOT drive_mode THEN
    IF stick < 0 OR lift_up_ok THEN
      lift_sp := stick;
    END_IF;
  ELSIF sensor_state = 5 AND NOT raised THEN
    drive_sp := stick;
  END_IF;
END_IF;

(* The lamps of the platform box. *)
ready := net.MANDATORY_UP AND base_ok AND sensor_state = 5 AND NOT estop AND NOT tilt_alarm AND NOT overload;
lamps := 16#00;
IF ready THEN lamps := lamps OR 16#01; END_IF;
IF estop THEN lamps := lamps OR 16#02; END_IF;
IF tilt_alarm THEN lamps := lamps OR 16#04; END_IF;
IF overload THEN lamps := lamps OR 16#08; END_IF;
IF tilt_alarm OR estop OR overload THEN lamps := lamps OR 16#10; END_IF;
IF valve_fault OR coil_fault OR NOT base_ok THEN lamps := lamps OR 16#20; END_IF;

(* The optional work light node is on while the work light button is pressed. *)
light_node(ENABLE := TRUE, DEVICE := worklight, ACTIVE := work_light);
light_cmd := 16#00;
IF work_light AND worklight_state = 5 THEN light_cmd := 16#01; END_IF;

(* The ramp time of the valve module depends on the mode: a gentle lift, a quicker drive. *)
IF drive_mode <> last_mode AND NOT want_ramp THEN
  want_ramp := TRUE;
END_IF;
IF drive_mode THEN
  ramp_ms := 600;
ELSE
  ramp_ms := 1200;
END_IF;
write_ramp(ENABLE := want_ramp AND valves_state = 5, DEVICE := valves, INDEX := 16#2000, SUBINDEX := 4,
           DATA := UDINT_TO_DWORD(ramp_ms), DATALENGTH := 2);
IF write_ramp.CONFIRM OR write_ramp.ERROR <> 0 THEN
  want_ramp := FALSE;
  last_mode := drive_mode;
END_IF;

(* Once the sensor is up, read its serial number; every ten seconds read its operating time. *)
read_serial(ENABLE := sensor_state = 5 AND NOT serial_done, DEVICE := sensor, INDEX := 16#2200, SUBINDEX := 1);
IF read_serial.CONFIRM THEN
  sensor_serial := read_serial.DATA;
  serial_done := TRUE;
END_IF;
poll(IN := NOT poll.Q, PT := T#10s);
IF poll.Q THEN
  want_seconds := TRUE;
END_IF;
read_seconds(ENABLE := want_seconds AND sensor_state = 5, DEVICE := sensor, INDEX := 16#2100, SUBINDEX := 4);
IF read_seconds.CONFIRM OR read_seconds.ERROR <> 0 THEN
  IF read_seconds.CONFIRM THEN
    operating_s := DWORD_TO_UDINT(read_seconds.DATA);
  END_IF;
  want_seconds := FALSE;
END_IF;

END_PROGRAM
