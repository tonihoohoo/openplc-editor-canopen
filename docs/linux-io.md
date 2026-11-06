# Linux I/O blocks

The `linux_io` library gives a PLC program the I/O of the Linux device the runtime runs on: GPIO
lines, hardware PWM channels and values that kernel drivers show as files (temperatures, ADCs and
other IIO sensors). It uses only the kernel's own interfaces (`/dev/gpiochipN`, `/sys/class/pwm`,
`/sys/bus/iio`), so a program needs no extra package on the device, and it works with the runtime
installed natively or in its Docker container (which runs privileged with `/dev` bound in).

A typical use is a Linux device as a CANopen slave: a block's output located at the address of a
slave object goes to the master with no copy in the program (see [CANopen slave](canopen.md#canopen-slave)).

- [Using it](#using-it)
- [Blocks](#blocks)
- [Pins](#pins)
- [When the PLC stops](#when-the-plc-stops)
- [Errors](#errors)
- [Device settings](#device-settings)
- [Examples](#examples)

## Using it

1. Open the library manager and enable **Linux I/O** for the project.
2. Declare instances of the blocks in a POU and call them every scan.
3. Build for OpenPLC Runtime v4 and upload to the Linux device.

On a target that is not Linux (a microcontroller board, the simulator, the Windows runtime) the
blocks build but touch nothing: `VALID` stays FALSE and `ERROR` is `LIO_NOT_SUPPORTED`.

## Blocks

Every block has `ENABLE : BOOL` and the outputs `VALID : BOOL`, `ERROR : USINT` and
`ERRORTEXT : STRING`. `ENABLE` FALSE releases the block's line or channel; an output goes to its
stop state first.

| Block | Inputs | Outputs | What it does |
| --- | --- | --- | --- |
| `GPIO_IN` | `PIN : STRING`, `BIAS : USINT`, `ACTIVE_LOW : BOOL`, `DEBOUNCE : TIME` | `Q : BOOL` | Reads a GPIO line on every call. `BIAS` is `LIO_BIAS_NONE`, `LIO_BIAS_PULL_UP` or `LIO_BIAS_PULL_DOWN`; `DEBOUNCE` (T#0s: off) filters bounces shorter than its time. |
| `GPIO_OUT` | `PIN : STRING`, `VALUE : BOOL`, `DRIVE : USINT`, `ACTIVE_LOW : BOOL`, `ON_STOP : USINT` | | Drives a GPIO line to `VALUE`. `DRIVE` is `LIO_DRIVE_PUSH_PULL`, `LIO_DRIVE_OPEN_DRAIN` or `LIO_DRIVE_OPEN_SOURCE`. |
| `PWM_OUT` | `CHIP : STRING`, `CHANNEL : USINT`, `FREQUENCY : REAL`, `DUTY : REAL`, `ON_STOP : USINT` | | Runs a hardware PWM channel at `FREQUENCY` (Hz) and `DUTY` (0 to 100 %). `CHIP` is the pwmchip number (`'0'`), its name (`'pwmchip0'`) or its device name. Written only when a value changes, outside the PLC scan. |
| `READ_VALUE` | `PATH : STRING`, `SCALE : REAL := 1.0`, `OFFSET : REAL`, `PERIOD : TIME := T#1s` | `VALUE : REAL`, `RAW : LINT` | Reads the first number in a file under `/sys/` every `PERIOD`, outside the PLC scan. `VALUE` = `RAW` x `SCALE` + `OFFSET`. |
| `IIO_READ` | `DEVICE : STRING`, `CHANNEL : STRING`, `PERIOD : TIME := T#1s` | `VALUE : REAL`, `RAW : DINT` | Reads an IIO channel every `PERIOD`, outside the PLC scan. `DEVICE` is the driver's device name, `CHANNEL` the file prefix such as `'in_voltage0'`. `VALUE` = (`RAW` + offset) x scale with the driver's offset and scale, in the driver's unit (for an ADC usually mV). |

`VALID` on `READ_VALUE` and `IIO_READ` is FALSE until the first reading after a start, and while a
read fails (`VALUE` and `RAW` then keep the last good reading). `PERIOD` is at least 10 ms.

## Pins

`PIN` is a line name or `'<chip>:<offset>'`:

- A line name, such as `'GPIO17'`, is looked up on every GPIO chip. Many single-board computers name
  their header lines this way, after the SoC's GPIO number, so a program keeps working when a kernel
  update numbers the chips differently. `gpioinfo` (from the libgpiod tools, on the device) lists
  the names.
- `'<chip>:<offset>'`, such as `'gpiochip0:17'`, names the chip by its device name or label and the
  line by its offset.

A line that is missing or in use gives `ERROR`; the block tries again every 0.5 s while `ENABLE`
stays TRUE, so it gets the line as soon as it is free. Only one block (or program) can hold a line.
A board package that drives the same pins without the kernel's GPIO interface is not detected:
do not use the same pin from both.

## When the PLC stops

The blocks run only while the program calls them. A helper thread of the library watches the calls:

- An output block that has not been called for 100 ms, or five times its call interval if that is
  longer (a PLC stop, a PLC error or a new upload), goes to its `ON_STOP` state: `LIO_STOP_OFF`
  (default; for PWM duty 0 and disabled), `LIO_STOP_ON` (`GPIO_OUT` only) or `LIO_STOP_HOLD`. When
  the program calls the block again, the output follows `VALUE` or `DUTY` again.
- An input block's outputs keep their last value; `READ_VALUE` and `IIO_READ` pause their reads.
- After 2 s without a call a block's line or channel is released, so a newly uploaded program can
  claim it. Whether a released line keeps its level or bias depends on the board's GPIO driver.

`LIO_STOP_OFF` matches what the runtime does with every `%Q` output on a PLC stop.

## Errors

| `ERROR` | Meaning |
| --- | --- |
| `LIO_NO_ERROR` (0) | Fine |
| `LIO_NOT_SUPPORTED` (1) | Not a Linux target |
| `LIO_WRONG_INPUT` (2) | An input is out of range, or `PATH` is not under `/sys/` |
| `LIO_NOT_FOUND` (3) | No such line, chip, file or IIO device |
| `LIO_BUSY` (4) | The line is in use; `ERRORTEXT` names the user when the kernel knows it |
| `LIO_REFUSED` (5) | The GPIO driver refused a setting (for example debounce or bias it cannot do) |
| `LIO_IO_ERROR` (6) | A read or write failed |
| `LIO_NO_SLOT` (7) | More than 64 `linux_io` blocks in the program |

## Device settings

GPIO lines need no setting. Lines of a bus that is switched on (I2C, SPI, a UART) belong to that bus
and are reported in use.

PWM channels and most IIO sensors need their kernel driver switched on in the device's boot
settings, usually a device tree overlay line in the boot configuration file, then a reboot. Check
the board's documentation for the overlay names; afterwards `/sys/class/pwm/` lists the PWM chips and
`/sys/bus/iio/devices/` the IIO devices (each with a `name` file). The runtime container sees them
without a restart of its own.

## Examples

A button on a CANopen slave's TPDO bit and a lamp from the master's RPDO bit (the slave's objects
use `%QX0.0` and `%IX0.0`):

```
VAR
  pressed AT %QX0.0 : BOOL;
  lamp_on AT %IX0.0 : BOOL;
  button : GPIO_IN;
  lamp : GPIO_OUT;
END_VAR
button(ENABLE := TRUE, PIN := 'GPIO17', BIAS := LIO_BIAS_PULL_UP, ACTIVE_LOW := TRUE, DEBOUNCE := T#10ms);
pressed := button.Q;
lamp(ENABLE := TRUE, PIN := 'GPIO27', VALUE := lamp_on);
```

The CPU temperature in a slave object of type INTEGER16, in 0.1 degrees:

```
VAR
  temperature AT %QW1 : INT;
  cpu : READ_VALUE;
END_VAR
cpu(ENABLE := TRUE, PATH := '/sys/class/thermal/thermal_zone0/temp', SCALE := 0.01);
IF cpu.VALID THEN temperature := REAL_TO_INT(cpu.VALUE); END_IF;
```

A fan at 25 kHz and an ADC channel:

```
fan(ENABLE := TRUE, CHIP := '0', CHANNEL := 0, FREQUENCY := 25000.0, DUTY := speed);
adc(ENABLE := TRUE, DEVICE := 'adc_name', CHANNEL := 'in_voltage0', PERIOD := T#100ms);
```
