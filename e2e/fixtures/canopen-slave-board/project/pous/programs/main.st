PROGRAM main
  VAR
    setpoint AT %IW0 : INT;
    limit AT %IW1 : UINT;
    echo AT %QW0 : INT;
    limit_echo AT %QW1 : UINT;
    copy AT %QW2 : INT;
    valve_1 AT %IX0.0 : BOOL;
    valve_2 AT %IX0.1 : BOOL;
    valve_3 AT %IX0.2 : BOOL;
    valve_4 AT %IX0.3 : BOOL;
    valve_5 AT %IX0.4 : BOOL;
    valve_6 AT %IX0.5 : BOOL;
    valve_7 AT %IX0.6 : BOOL;
    valve_8 AT %IX0.7 : BOOL;
    lamp_1 AT %QX0.0 : BOOL;
    lamp_2 AT %QX0.1 : BOOL;
    lamp_3 AT %QX0.2 : BOOL;
    lamp_4 AT %QX0.3 : BOOL;
    lamp_5 AT %QX0.4 : BOOL;
    lamp_6 AT %QX0.5 : BOOL;
    lamp_7 AT %QX0.6 : BOOL;
    lamp_8 AT %QX0.7 : BOOL;
  END_VAR

(* The master's setpoint, the limit parameter and the eight valve bits go back to the master in TPDO 1. *)
(* The setpoint also goes back in TPDO 5, whose COB-ID the master sets. *)
echo := setpoint;
copy := setpoint;
limit_echo := limit;
lamp_1 := valve_1;
lamp_2 := valve_2;
lamp_3 := valve_3;
lamp_4 := valve_4;
lamp_5 := valve_5;
lamp_6 := valve_6;
lamp_7 := valve_7;
lamp_8 := valve_8;

END_PROGRAM
