PROGRAM main
  VAR
    inputs AT %IB1 : BYTE;
    outputs AT %QB0 : BYTE;
    last_inputs : BYTE;
    w4 : SDO_WRITE4;
    wd : SDO_WRITE_DATA;
    r4 : SDO_READ4;
    rs : SDO_READ_STRING;
    rd : SDO_READ_DATA;
    nmt_cmd : NMT;
    st : GET_STATE;
    lid : GET_LOCAL_NODE_ID;
    ks : GET_CANOPEN_KERNEL_STATE;
    emd : RECV_EMCY_DEV;
    buf : ARRAY[0..255] OF BYTE;
    step : INT := 99;
    pause : BOOL;
    bits : DWORD;
    run : DWORD;
    waited : INT;
    stopped_seen : BOOL;
    r4_node : USINT;
    r4_index : WORD;
    r4_sub : BYTE;
    r4_timeout : TIME;
    nmt_state : USINT;
    final : DWORD;
  END_VAR

(* The simulated node sets its inputs to 16#40 + n to ask for run n of the checks. Each check
   that passes sets a bit; the last step writes 16#C0DE0000 + n * 16#1000 + bits to its 0x2100.
   Bits: 1 SDO_READ4, 2 REAL helper, 4 SDO_READ_STRING, 8 SDO_READ_DATA, 16 abort, 32 NMT and
   GET_STATE, 64 GET_LOCAL_NODE_ID and GET_CANOPEN_KERNEL_STATE, 128 RECV_EMCY_DEV,
   256 absent node. *)
outputs := inputs;
IF inputs <> last_inputs AND inputs >= 16#40 THEN
  run := BYTE_TO_DWORD(inputs) - 16#40;
  step := 0;
  bits := 0;
  pause := TRUE;
END_IF;
last_inputs := inputs;

st(ENABLE := TRUE, DEVICE := io2);
lid(ENABLE := TRUE, NETWORK := canopen_1);
ks(ENABLE := TRUE);
emd(ENABLE := step < 99, DEVICE := io2);
IF emd.CONFIRM AND emd.EMCY.ERRORCODE = 16#5000 THEN
  bits := bits OR 16#80;
END_IF;
IF lid.CONFIRM AND lid.NODEID = 127 AND ks.CONFIRM AND ks.STATE = CANOPEN_KERNEL_NO_ERROR THEN
  bits := bits OR 16#40;
END_IF;

w4(ENABLE := step = 0 AND NOT pause, DEVICE := io2, INDEX := 16#2100, SUBINDEX := 0,
   DATA := 16#0BAD0000 + run * 16#1000);
r4(ENABLE := (step = 1 OR step = 2 OR step = 5 OR step = 10) AND NOT pause, DEVICE := r4_node,
   INDEX := r4_index, SUBINDEX := r4_sub, TIMEOUT := r4_timeout);
rs(ENABLE := step = 3 AND NOT pause, DEVICE := io2, INDEX := 16#1008, SUBINDEX := 0);
rd(ENABLE := step = 4 AND NOT pause, DEVICE := io2, INDEX := 16#1008, SUBINDEX := 0, DATA := buf);
nmt_cmd(ENABLE := (step = 6 OR step = 8) AND NOT pause, DEVICE := io2, STATE := nmt_state);
wd(ENABLE := step = 12 AND NOT pause, DEVICE := io2, INDEX := 16#2100, SUBINDEX := 0,
   DATALENGTH := 4, DATA := buf);

IF pause THEN
  pause := FALSE;
  (* Inputs of the step that follows. *)
  r4_node := io2;
  r4_sub := 0;
  r4_timeout := T#0s;
  CASE step OF
    1: r4_index := 16#1018; r4_sub := 1;
    2: r4_index := 16#2102;
    5: r4_index := 16#6000; r4_sub := 9;
    6: nmt_state := STOP_REMOTE_NODE;
    8: nmt_state := START_REMOTE_NODE;
    10: r4_node := io9; r4_index := 16#1000; r4_timeout := T#200ms;
    12:
      final := 16#C0DE0000 + run * 16#1000 + bits;
      buf[0] := DWORD_TO_BYTE(final);
      buf[1] := DWORD_TO_BYTE(SHR(final, 8));
      buf[2] := DWORD_TO_BYTE(SHR(final, 16));
      buf[3] := DWORD_TO_BYTE(SHR(final, 24));
  END_CASE;
ELSE
  CASE step OF
    0: (* Start mark; retried until the node takes it. *)
      IF w4.CONFIRM THEN
        step := 1; pause := TRUE;
      ELSIF w4.ERROR <> CANOPEN_KERNEL_NO_ERROR THEN
        pause := TRUE;
      END_IF;
    1:
      IF r4.CONFIRM OR r4.ERROR <> CANOPEN_KERNEL_NO_ERROR THEN
        IF r4.CONFIRM AND r4.DATA = 1 AND r4.DATALENGTH = 4 THEN bits := bits OR 16#1; END_IF;
        step := 2; pause := TRUE;
      END_IF;
    2:
      IF r4.CONFIRM OR r4.ERROR <> CANOPEN_KERNEL_NO_ERROR THEN
        IF r4.CONFIRM AND CANOPEN_DWORD_TO_REAL(r4.DATA) = 1.5 AND CANOPEN_REAL_TO_DWORD(1.5) = 16#3FC00000 THEN
          bits := bits OR 16#2;
        END_IF;
        step := 3; pause := TRUE;
      END_IF;
    3:
      IF rs.CONFIRM OR rs.ERROR <> CANOPEN_KERNEL_NO_ERROR THEN
        IF rs.CONFIRM AND rs.DATA = 'Generic I/O module' THEN bits := bits OR 16#4; END_IF;
        step := 4; pause := TRUE;
      END_IF;
    4:
      IF rd.CONFIRM OR rd.ERROR <> CANOPEN_KERNEL_NO_ERROR THEN
        IF rd.CONFIRM AND rd.DATALENGTH = 18 AND buf[0] = 71 THEN bits := bits OR 16#8; END_IF;
        step := 5; pause := TRUE;
      END_IF;
    5:
      IF r4.CONFIRM OR r4.ERROR <> CANOPEN_KERNEL_NO_ERROR THEN
        IF r4.ERROR = CANOPEN_KERNEL_OTHER_ERROR AND r4.ERRORINFO <> 0 THEN bits := bits OR 16#10; END_IF;
        step := 6; pause := TRUE;
      END_IF;
    6:
      IF nmt_cmd.CONFIRM OR nmt_cmd.ERROR <> CANOPEN_KERNEL_NO_ERROR THEN
        stopped_seen := FALSE; waited := 0;
        step := 7; pause := TRUE;
      END_IF;
    7:
      waited := waited + 1;
      IF st.STATE = STOPPED THEN stopped_seen := TRUE; END_IF;
      IF stopped_seen OR waited > 100 THEN step := 8; pause := TRUE; END_IF;
    8:
      IF nmt_cmd.CONFIRM OR nmt_cmd.ERROR <> CANOPEN_KERNEL_NO_ERROR THEN
        waited := 0;
        step := 9; pause := TRUE;
      END_IF;
    9:
      waited := waited + 1;
      IF st.STATE = OPERATIONAL THEN
        IF stopped_seen THEN bits := bits OR 16#20; END_IF;
        step := 10; pause := TRUE;
      ELSIF waited > 250 THEN
        step := 10; pause := TRUE;
      END_IF;
    10:
      IF r4.CONFIRM OR r4.ERROR <> CANOPEN_KERNEL_NO_ERROR THEN
        IF r4.ERROR = CANOPEN_KERNEL_TIMEOUT OR r4.ERROR = CANOPEN_KERNEL_REQUEST_ERROR THEN
          bits := bits OR 16#100;
        END_IF;
        waited := 0;
        step := 11; pause := TRUE;
      END_IF;
    11: (* Waits for an emergency, which the node sends every half second. *)
      waited := waited + 1;
      IF (bits AND 16#80) <> 0 OR waited > 250 THEN step := 12; pause := TRUE; END_IF;
    12: (* The result; retried until the node takes it. *)
      IF wd.CONFIRM THEN
        step := 99; pause := TRUE;
      ELSIF wd.ERROR <> CANOPEN_KERNEL_NO_ERROR THEN
        pause := TRUE;
      END_IF;
  END_CASE;
END_IF;

END_PROGRAM
