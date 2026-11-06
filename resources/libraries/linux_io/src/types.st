(* Constants of the linux_io function block library.

   STruC++ does not carry the values of a library's enumerations into a program, so each setting
   is a USINT with one constant per value: GPIO_IN(BIAS := LIO_BIAS_PULL_UP, ...) and
   IF gpio.ERROR = LIO_BUSY THEN ... *)
TYPE
  LIO_ERROR : USINT;
  LIO_BIAS : USINT;
  LIO_DRIVE : USINT;
  LIO_STOP : USINT;
END_TYPE

VAR_GLOBAL CONSTANT
  LIO_NO_ERROR : USINT := 0;
  LIO_NOT_SUPPORTED : USINT := 1;
  LIO_WRONG_INPUT : USINT := 2;
  LIO_NOT_FOUND : USINT := 3;
  LIO_BUSY : USINT := 4;
  LIO_REFUSED : USINT := 5;
  LIO_IO_ERROR : USINT := 6;
  LIO_NO_SLOT : USINT := 7;

  LIO_BIAS_NONE : USINT := 0;
  LIO_BIAS_PULL_UP : USINT := 1;
  LIO_BIAS_PULL_DOWN : USINT := 2;

  LIO_DRIVE_PUSH_PULL : USINT := 0;
  LIO_DRIVE_OPEN_DRAIN : USINT := 1;
  LIO_DRIVE_OPEN_SOURCE : USINT := 2;

  LIO_STOP_OFF : USINT := 0;
  LIO_STOP_ON : USINT := 1;
  LIO_STOP_HOLD : USINT := 2;
END_VAR
