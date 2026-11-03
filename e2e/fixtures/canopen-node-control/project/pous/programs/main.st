PROGRAM main
  VAR
    inputs AT %IB1 : BYTE;
    outputs AT %QB0 : BYTE;
    io3_on : CANOPEN_NODE_ENABLE;
    net : CANOPEN_NETWORK_STATE;
    io2_status : CANOPEN_NODE_STATUS;
    start_io2 : NMT;
  END_VAR

(* io3 is off at PLC start and io2 waits for the program's start: turn io3 on, and once every
   mandatory node is up, start io2. *)
io3_on(ENABLE := TRUE, DEVICE := io3, ACTIVE := TRUE);
net(ENABLE := TRUE);
io2_status(ENABLE := TRUE, DEVICE := io2);
start_io2(ENABLE := io3_on.CONFIRM AND net.MANDATORY_UP AND io2_status.RUNSTATE = RUN_WAITING_START,
          DEVICE := io2, STATE := START_REMOTE_NODE);
outputs := inputs;

END_PROGRAM
