PROGRAM main
  VAR
    out0 AT %IX0.0 : BOOL;
    out1 AT %IX0.1 : BOOL;
    in_bit AT %QX0.0 : BOOL;
    in_valid AT %QX0.1 : BOOL;
    out_valid AT %QX0.2 : BOOL;
    read_valid AT %QX0.3 : BOOL;
    in_error AT %QB1 : USINT;
    out_error AT %QB2 : USINT;
    read_error AT %QB3 : USINT;
    mtu AT %QD1 : UDINT;
    line_in : GPIO_IN;
    line_out : GPIO_OUT;
    line_on : GPIO_OUT;
    loopback : READ_VALUE;
  END_VAR

(* The simulated input line goes to the master in TPDO 1, bit 0. *)
line_in(ENABLE := TRUE, PIN := 'lio-in', BIAS := LIO_BIAS_NONE);
in_bit := line_in.Q;
in_valid := line_in.VALID;
in_error := line_in.ERROR;

(* RPDO 1 bit 0 drives lio-out (off on a PLC stop), bit 1 drives lio-on (on on a PLC stop). *)
line_out(ENABLE := TRUE, PIN := 'lio-out', VALUE := out0);
line_on(ENABLE := TRUE, PIN := 'lio-on', VALUE := out1, ON_STOP := LIO_STOP_ON);
out_valid := line_out.VALID AND line_on.VALID;
out_error := line_out.ERROR;

(* A sysfs value every CI kernel has: the loopback interface's MTU. *)
loopback(ENABLE := TRUE, PATH := '/sys/class/net/lo/mtu', PERIOD := T#100ms);
mtu := LINT_TO_UDINT(loopback.RAW);
read_valid := loopback.VALID;
read_error := loopback.ERROR;

END_PROGRAM
