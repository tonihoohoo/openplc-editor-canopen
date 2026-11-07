PROGRAM main
  VAR
    filter_ms AT %IW0 : UINT;
    load_limit AT %IW1 : UINT;
    raw_tilt AT %IW8 : INT;
    raw_height AT %IW9 : UINT;
    raw_load AT %IW10 : UINT;
    tilt AT %QW0 : INT;
    height AT %QW1 : UINT;
    load AT %QW2 : UINT;
    seconds AT %QD0 : UDINT;
    overload : CANOPEN_SLAVE_EMCY;
    tick : TON;
    smooth : DINT;
    smooth_load : DINT;
    alpha : DINT;
  END_VAR

(* The terminal slave brings the raw values; the filter time sets how fast they follow. *)
alpha := 2000 / (UINT_TO_DINT(filter_ms) + 20);
smooth := smooth + (INT_TO_DINT(raw_tilt) - smooth) * alpha / 100;
smooth_load := smooth_load + (UINT_TO_DINT(raw_load) - smooth_load) * alpha / 100;
tilt := DINT_TO_INT(smooth);
load := DINT_TO_UINT(smooth_load);
height := raw_height;

(* Operating time in seconds, for the master to read by SDO. *)
tick(IN := NOT tick.Q, PT := T#1s);
IF tick.Q THEN seconds := seconds + 1; END_IF;

(* Load over the limit is an emergency of the program; the master reads it. *)
overload(SLAVE := sensor, ENABLE := load > load_limit, ERRORCODE := 16#3200, INFO := UINT_TO_UDINT(load));

END_PROGRAM
