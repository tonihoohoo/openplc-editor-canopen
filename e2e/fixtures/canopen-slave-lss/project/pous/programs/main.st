PROGRAM main
  VAR
    setpoint AT %IW0 : INT;
    limit AT %IW1 : UINT;
    echo AT %QW0 : INT;
    limit_echo AT %QW1 : UINT;
  END_VAR

(* The master's setpoint and the limit parameter go back to the master in TPDO 1. *)
echo := setpoint;
limit_echo := limit;

END_PROGRAM
