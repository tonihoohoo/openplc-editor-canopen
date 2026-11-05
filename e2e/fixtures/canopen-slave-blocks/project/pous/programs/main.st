PROGRAM main
  VAR
    command AT %IB0 : USINT;
    alarm AT %ID0 : UDINT;
    slave_state AT %QB0 : USINT;
    alarm_writes AT %QD0 : UDINT;
    error_register AT %QB1 : BYTE;
    alarm_error AT %QB2 : USINT;
    nmt_error AT %QB3 : USINT;
    status : CANOPEN_SLAVE_STATUS;
    nmt : CANOPEN_SLAVE_NMT;
    emcy : CANOPEN_SLAVE_EMCY;
    written : CANOPEN_SLAVE_WRITTEN;
    target : USINT;
    code : WORD;
    alarm_news : UDINT;
  END_VAR

(* The slave's state, error register and the master's writes of Alarm go back to the master. *)
status(SLAVE := io, ENABLE := TRUE);
slave_state := status.STATE;
error_register := status.ERRORREGISTER;
written(SLAVE := io, ENABLE := TRUE, INDEX := 16#2000, SUBINDEX := 2);
alarm_writes := written.COUNT;
IF written.NEW THEN
  alarm_news := alarm_news + 1;
END_IF;

(* Alarm not 0: emergency 4210h with INFO = Alarm; 6200 asks for a code the slave refuses. *)
IF alarm = 6200 THEN
  code := 16#6200;
ELSE
  code := 16#4210;
END_IF;
emcy(SLAVE := io, ENABLE := alarm <> 0, ERRORCODE := code, INFO := alarm);
alarm_error := emcy.ERROR;

(* Command 1 pre-operational, 2 operational, 3 a reset node the block refuses. *)
CASE command OF
  1: target := ENTER_PRE_OPERATIONAL;
  3: target := RESET_NODE;
ELSE
  target := START_REMOTE_NODE;
END_CASE;
nmt(SLAVE := io, ENABLE := command <> 0, STATE := target);
nmt_error := nmt.ERROR;

END_PROGRAM
