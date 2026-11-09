PROGRAM main
  VAR
    lift_sp AT %IW0 : INT;
    drive_sp AT %IW1 : INT;
    lift_enable AT %IX0.0 : BOOL;
    drive_enable AT %IX0.1 : BOOL;
    steer_left AT %IX0.2 : BOOL;
    steer_right AT %IX0.3 : BOOL;
    ramp_up_ms AT %IW2 : UINT;
    ramp_down_ms AT %IW3 : UINT;
    lift_applied AT %QW0 : INT;
    drive_applied AT %QW1 : INT;
    st_supply AT %QX0.0 : BOOL;
    st_coil AT %QX0.1 : BOOL;
    st_lift AT %QX0.2 : BOOL;
    st_drive AT %QX0.3 : BOOL;
    ramp_writes AT %QD0 : UDINT;
    lift_cmd AT %QW4 : INT;
    drive_cmd AT %QW5 : INT;
    supply_in, coil_in : GPIO_IN;
    lift_up, lift_down, drive_fwd, drive_rev, steer_l, steer_r : GPIO_OUT;
    status : CANOPEN_SLAVE_STATUS;
    written : CANOPEN_SLAVE_WRITTEN;
    coil_fault : CANOPEN_SLAVE_EMCY;
    live : BOOL;
    up_step, down_step : INT;
    lift_target : INT;
    drive_target : INT;
  END_VAR

(* Terminals: the safety relay's auxiliary contact and the coil fault input are digital lines. *)
supply_in(ENABLE := TRUE, PIN := 'VM_SUPPLY_OK', BIAS := LIO_BIAS_NONE);
coil_in(ENABLE := TRUE, PIN := 'VM_COIL_FAULT', BIAS := LIO_BIAS_NONE, DEBOUNCE := T#40ms);
st_supply := supply_in.Q;
st_coil := coil_in.Q;

(* A coil fault is an emergency of the program; the master reads it. *)
status(SLAVE := valves, ENABLE := TRUE);
coil_fault(SLAVE := valves, ENABLE := coil_in.Q, ERRORCODE := 16#5000, INFO := 1);
written(SLAVE := valves, ENABLE := TRUE, INDEX := 16#2000, SUBINDEX := 4);
ramp_writes := written.COUNT;

(* Outputs are live only while the slave is operational, the supply is on and nothing is faulty. *)
live := status.OPERATIONAL AND supply_in.Q AND NOT coil_in.Q;
IF live AND lift_enable THEN lift_target := lift_sp; ELSE lift_target := 0; END_IF;
IF live AND drive_enable THEN drive_target := drive_sp; ELSE drive_target := 0; END_IF;

(* Ramp times run from 0 to full scale (1000) and back; the steps are per 20 ms scan. Moving away
   from zero uses the ramp-up time, moving towards zero the ramp-down time. *)
up_step := UINT_TO_INT(20000 / MAX(ramp_up_ms, 50));
down_step := UINT_TO_INT(20000 / MAX(ramp_down_ms, 50));
IF up_step < 1 THEN up_step := 1; END_IF;
IF down_step < 1 THEN down_step := 1; END_IF;
IF NOT live THEN
  lift_applied := 0;
  drive_applied := 0;
ELSE
  IF lift_target > lift_applied THEN
    IF lift_applied >= 0 THEN lift_applied := MIN(lift_target, lift_applied + up_step); ELSE lift_applied := MIN(lift_target, lift_applied + down_step); END_IF;
  ELSIF lift_target < lift_applied THEN
    IF lift_applied <= 0 THEN lift_applied := MAX(lift_target, lift_applied - up_step); ELSE lift_applied := MAX(lift_target, lift_applied - down_step); END_IF;
  END_IF;
  IF drive_target > drive_applied THEN
    IF drive_applied >= 0 THEN drive_applied := MIN(drive_target, drive_applied + up_step); ELSE drive_applied := MIN(drive_target, drive_applied + down_step); END_IF;
  ELSIF drive_target < drive_applied THEN
    IF drive_applied <= 0 THEN drive_applied := MAX(drive_target, drive_applied - up_step); ELSE drive_applied := MAX(drive_target, drive_applied - down_step); END_IF;
  END_IF;
END_IF;
lift_cmd := lift_applied;
drive_cmd := drive_applied;
st_lift := lift_applied <> 0;
st_drive := drive_applied <> 0;

(* The valve directions are digital outputs; the proportional part is lift_cmd and drive_cmd.
   Steering is on and off, only while the drive is enabled. *)
lift_up(ENABLE := TRUE, PIN := 'VM_LIFT_UP', VALUE := lift_applied > 0);
lift_down(ENABLE := TRUE, PIN := 'VM_LIFT_DOWN', VALUE := lift_applied < 0);
drive_fwd(ENABLE := TRUE, PIN := 'VM_DRIVE_FWD', VALUE := drive_applied > 0);
drive_rev(ENABLE := TRUE, PIN := 'VM_DRIVE_REV', VALUE := drive_applied < 0);
steer_l(ENABLE := TRUE, PIN := 'VM_STEER_LEFT', VALUE := live AND drive_enable AND steer_left AND NOT steer_right);
steer_r(ENABLE := TRUE, PIN := 'VM_STEER_RIGHT', VALUE := live AND drive_enable AND steer_right AND NOT steer_left);

END_PROGRAM
