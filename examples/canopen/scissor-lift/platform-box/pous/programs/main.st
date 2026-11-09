PROGRAM main
  VAR
    stick_x AT %IW0 : INT;
    stick_y AT %IW1 : INT;
    lamp_ready AT %IX0.0 : BOOL;
    lamp_estop AT %IX0.1 : BOOL;
    lamp_tilt AT %IX0.2 : BOOL;
    lamp_overload AT %IX0.3 : BOOL;
    buzzer_cmd AT %IX0.4 : BOOL;
    lamp_fault AT %IX0.5 : BOOL;
    display_code AT %IB0 : USINT;
    display_out AT %QB0 : USINT;
    joy_x AT %QW0 : INT;
    joy_y AT %QW1 : INT;
    estop_healthy AT %QX0.0 : BOOL;
    enable_switch AT %QX0.1 : BOOL;
    drive_mode AT %QX0.2 : BOOL;
    horn AT %QX0.3 : BOOL;
    work_light AT %QX0.4 : BOOL;
    in_estop, in_enable, in_drive, in_horn, in_light : GPIO_IN;
    out_ready, out_estop, out_tilt, out_overload, out_buzzer, out_fault : GPIO_OUT;
  END_VAR

(* Terminals: the buttons on the rail are digital lines, the joystick axes come from the terminal slave. *)
in_estop(ENABLE := TRUE, PIN := 'PB_ESTOP_NC', BIAS := LIO_BIAS_NONE);
in_enable(ENABLE := TRUE, PIN := 'PB_ENABLE', BIAS := LIO_BIAS_NONE, DEBOUNCE := T#40ms);
in_drive(ENABLE := TRUE, PIN := 'PB_DRIVE_MODE', BIAS := LIO_BIAS_NONE, DEBOUNCE := T#40ms);
in_horn(ENABLE := TRUE, PIN := 'PB_HORN', BIAS := LIO_BIAS_NONE, DEBOUNCE := T#40ms);
in_light(ENABLE := TRUE, PIN := 'PB_LIGHT', BIAS := LIO_BIAS_NONE, DEBOUNCE := T#40ms);

(* Everything the rail reads goes to the master in TPDO 1. *)
joy_x := stick_x;
joy_y := stick_y;
estop_healthy := in_estop.Q;
enable_switch := in_enable.Q;
drive_mode := in_drive.Q;
horn := in_horn.Q;
work_light := in_light.Q;

(* The lamps and the buzzer follow the master's RPDO 1. *)
out_ready(ENABLE := TRUE, PIN := 'PB_LAMP_READY', VALUE := lamp_ready);
out_estop(ENABLE := TRUE, PIN := 'PB_LAMP_ESTOP', VALUE := lamp_estop);
out_tilt(ENABLE := TRUE, PIN := 'PB_LAMP_TILT', VALUE := lamp_tilt);
out_overload(ENABLE := TRUE, PIN := 'PB_LAMP_LOAD', VALUE := lamp_overload);
out_buzzer(ENABLE := TRUE, PIN := 'PB_BUZZER', VALUE := buzzer_cmd);
out_fault(ENABLE := TRUE, PIN := 'PB_LAMP_FAULT', VALUE := lamp_fault);

(* The display shows the master's code; the terminal slave carries it to the display. *)
display_out := display_code;

END_PROGRAM
