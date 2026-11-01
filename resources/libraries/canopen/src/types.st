(* Types and constants of the canopen function block library (CiA 405 names).

   STruC++ does not carry the values of a library's enumerations into a program, so the CiA 405
   enumerations are USINT types with one constant per value: a program writes
   IF sdo.ERROR = CANOPEN_KERNEL_TIMEOUT THEN ... and NMT(STATE := START_REMOTE_NODE, ...). *)
TYPE
  CANOPEN_KERNEL_ERROR : USINT;
  DEVICE_STATE : USINT;
  TRANSITION_STATE : USINT;
  EMCY_ERROR : STRUCT
    ERRORCODE : WORD;
    ERRORREGISTER : BYTE;
    MANUFACTURERERROR : ARRAY[0..4] OF BYTE;
  END_STRUCT;
END_TYPE

VAR_GLOBAL CONSTANT
  CANOPEN_KERNEL_NO_ERROR : USINT := 0;
  CANOPEN_KERNEL_OTHER_ERROR : USINT := 1;
  CANOPEN_KERNEL_TIMEOUT : USINT := 2;
  CANOPEN_KERNEL_BUS_OFF : USINT := 3;
  CANOPEN_KERNEL_ERROR_PASSIVE : USINT := 4;
  CANOPEN_KERNEL_INTERNAL : USINT := 5;
  CANOPEN_KERNEL_WRONG_PARAMETER : USINT := 6;
  CANOPEN_KERNEL_NODE_ID_UNKNOWN : USINT := 7;
  CANOPEN_KERNEL_NET_ID_UNKNOWN : USINT := 8;
  CANOPEN_KERNEL_REQUEST_ERROR : USINT := 9;
  CANOPEN_KERNEL_NO_DRIVER : USINT := 10;

  INIT : USINT := 0;
  RESET_COMM : USINT := 1;
  RESET_APP : USINT := 2;
  PRE_OPERATIONAL : USINT := 3;
  STOPPED : USINT := 4;
  OPERATIONAL : USINT := 5;
  UNKNOWN : USINT := 6;
  NOT_AVAIL : USINT := 7;

  START_REMOTE_NODE : USINT := 0;
  STOP_REMOTE_NODE : USINT := 1;
  ENTER_PRE_OPERATIONAL : USINT := 2;
  RESET_NODE : USINT := 3;
  RESET_COMMUNICATION : USINT := 4;
END_VAR

FUNCTION CANOPEN_DWORD_TO_REAL : REAL
(* The REAL whose IEEE 754 bits are IN, every bit kept. Example:
   speed := CANOPEN_DWORD_TO_REAL(read.DATA); *)
VAR_INPUT
  IN : DWORD;
END_VAR
{external
  uint32_t canopen_bits = IN;
  float canopen_value;
  __builtin_memcpy(&canopen_value, &canopen_bits, sizeof canopen_value);
  CANOPEN_DWORD_TO_REAL_result = canopen_value;
}
END_FUNCTION

FUNCTION CANOPEN_REAL_TO_DWORD : DWORD
(* The IEEE 754 bits of IN as a DWORD, every bit kept. Example:
   write(DATA := CANOPEN_REAL_TO_DWORD(1.5), DATALENGTH := 4, ...); *)
VAR_INPUT
  IN : REAL;
END_VAR
{external
  float canopen_value = IN;
  uint32_t canopen_bits;
  __builtin_memcpy(&canopen_bits, &canopen_value, sizeof canopen_bits);
  CANOPEN_REAL_TO_DWORD_result = canopen_bits;
}
END_FUNCTION
