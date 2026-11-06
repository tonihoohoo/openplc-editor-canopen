/**
 * The C++ function blocks of the `linux_io` library, as the editor stores a C++ block: a
 * documentation comment, the ST header, then the C++ body with `setup()` and `loop()`. Every body
 * starts with the library's shared code (`resources/libraries/linux_io/src/shared.inc`), which its
 * include guard keeps once per program.
 *
 * Pins and locals become `#define`s of their names in the grafted code, so the bodies name C++
 * locals in lower case with an `l_` prefix and the block locals start with `lio_`.
 */

import type { CanopenBlockSource } from '../canopen/library-blocks'

const COMMON_OUTPUTS = `  VALID : BOOL;
  ERROR : USINT;
  ERRORTEXT : STRING;
`

const LOCALS = `VAR
  lio_slot : UINT;
  lio_gen : UDINT;
  lio_last : USINT;
END_VAR
`

const NOT_LINUX = `  VALID = false;
  ERROR = 1;
  ERRORTEXT = "not supported on this target";`

/** Writes the result outputs from `l_err`/`l_msg` and remembers the error in `lio_last`. */
const SHOW = `  ERROR = static_cast<uint8_t>(l_err);
  if (l_err != 0 || lio_last != 0) ERRORTEXT = l_msg.buf;
  lio_last = static_cast<uint8_t>(l_err);`

/** Takes a slot's result while its lock is held. */
const TAKE_RESULT = `    l_err = l_s->error;
    lio::clear(l_msg);
    lio::put(l_msg, l_s->message);`

const NO_SLOT = `  int l_err = lio::e_no_slot;
  lio::text l_msg;
  lio::clear(l_msg);
  lio::put(l_msg, "more than 64 linux_io blocks");`

function block(name: string, doc: string, inputs: string, outputs: string, linuxBody: string, off: string): string {
  return `(* ${doc} *)
FUNCTION_BLOCK ${name}
VAR_INPUT
  ENABLE : BOOL;
${inputs}END_VAR
VAR_OUTPUT
${COMMON_OUTPUTS}${outputs}END_VAR
${LOCALS}@@SHARED@@
void setup() {
}

void loop() {
#if defined(__linux__)
${linuxBody}
#else
${off}
${NOT_LINUX}
#endif
}
END_FUNCTION_BLOCK
`
}

/** Leaves the block with its outputs cleared when ENABLE is FALSE, releasing what it held. */
function disabled(kind: string, clear: string): string {
  return `  if (!ENABLE) {
    unsigned short l_id = lio_slot;
    unsigned l_gen = lio_gen;
    lio::disable(l_id, l_gen, lio::${kind});
    lio_slot = 0;
    lio_gen = 0;
${clear}    VALID = false;
    ERROR = 0;
    if (lio_last != 0) ERRORTEXT = "";
    lio_last = 0;
    return;
  }`
}

/** A wrong input: the block holds nothing and reports it. */
function wrongInput(kind: string, condition: string, message: string, clear: string): string {
  return `  if (${condition}) {
    unsigned short l_id = lio_slot;
    unsigned l_gen = lio_gen;
    lio::disable(l_id, l_gen, lio::${kind});
    lio_slot = 0;
    lio_gen = 0;
${clear}    VALID = false;
    int l_err = lio::e_input;
    lio::text l_msg;
    lio::clear(l_msg);
    lio::put(l_msg, "${message}");
  ${SHOW.trim()}
    return;
  }`
}

const GPIO_IN = block(
  'GPIO_IN',
  `Reads a GPIO input line of the Linux device. PIN is the kernel's line name (such as 'GPIO17') or '<chip>:<offset>' (such as 'gpiochip0:17'). BIAS is LIO_BIAS_NONE, LIO_BIAS_PULL_UP or LIO_BIAS_PULL_DOWN; ACTIVE_LOW inverts the level; DEBOUNCE filters bounces shorter than its time (T#0s: off). Q is the level on every call while ENABLE is TRUE and VALID is TRUE. A pin that is missing or in use gives ERROR and ERRORTEXT, and the block tries again every 0.5 s.
Example: button(ENABLE := TRUE, PIN := 'GPIO17', BIAS := LIO_BIAS_PULL_UP, ACTIVE_LOW := TRUE, DEBOUNCE := T#10ms); pressed := button.Q;`,
  `  PIN : STRING;
  BIAS : USINT;
  ACTIVE_LOW : BOOL;
  DEBOUNCE : TIME;
`,
  '  Q : BOOL;\n',
  `${disabled('k_in', '    Q = false;\n')}
${wrongInput('k_in', 'BIAS > 2', 'BIAS is LIO_BIAS_NONE, LIO_BIAS_PULL_UP or LIO_BIAS_PULL_DOWN', '    Q = false;\n')}
  long long l_debounce_ns = DEBOUNCE;
  unsigned long long l_debounce_us = l_debounce_ns <= 0 ? 0ULL : static_cast<unsigned long long>((l_debounce_ns + 999) / 1000);
  if (l_debounce_us > 0xFFFFFFFFULL) l_debounce_us = 0xFFFFFFFFULL;
  uint8_t l_bias = BIAS;
  unsigned long long l_cfg = (static_cast<unsigned long long>(l_bias) & 0x3u) | (ACTIVE_LOW ? 0x4u : 0u) | (l_debounce_us << 32);
  unsigned short l_id = lio_slot;
  unsigned l_gen = lio_gen;
  lio::slot *l_s = lio::enter(l_id, l_gen, lio::k_in, PIN.c_str(), l_cfg);
  lio_slot = l_id;
  lio_gen = l_gen;
  bool l_valid = false;
  bool l_q = false;
${NO_SLOT}
  if (l_s) {
    long long l_now = lio::now_ns();
    if (l_s->fd < 0 && l_now >= l_s->next_try) {
      lio::claim_line(*l_s, false);
      if (l_s->fd < 0) l_s->next_try = l_now + lio::retry_after;
    }
    if (l_s->fd >= 0) {
      if (lio::line_get(l_s->fd, l_q)) {
        l_valid = true;
        if (l_s->error != lio::e_no_error) lio::set_error(*l_s, lio::e_no_error, "", "");
      } else {
        lio::set_errno(*l_s, lio::e_io, l_s->key, "cannot read the line", errno);
      }
    }
${TAKE_RESULT}
    lio::leave();
  }
  Q = l_q;
  VALID = l_valid;
${SHOW}`,
  '  Q = false;',
)

const GPIO_OUT = block(
  'GPIO_OUT',
  `Drives a GPIO output line of the Linux device to VALUE. PIN as for GPIO_IN. DRIVE is LIO_DRIVE_PUSH_PULL, LIO_DRIVE_OPEN_DRAIN or LIO_DRIVE_OPEN_SOURCE; ACTIVE_LOW inverts the level. When the block is no longer called (PLC stop, PLC error, new upload) the line goes to ON_STOP within 100 ms or five call intervals: LIO_STOP_OFF (default), LIO_STOP_ON or LIO_STOP_HOLD. ENABLE FALSE puts it in that state too and frees the line.
Example: lamp(ENABLE := TRUE, PIN := 'GPIO27', VALUE := alarm, ON_STOP := LIO_STOP_OFF);`,
  `  PIN : STRING;
  VALUE : BOOL;
  DRIVE : USINT;
  ACTIVE_LOW : BOOL;
  ON_STOP : USINT;
`,
  '',
  `${disabled('k_out', '')}
${wrongInput('k_out', 'DRIVE > 2 || ON_STOP > 2', 'DRIVE or ON_STOP is out of range', '')}
  uint8_t l_drive = DRIVE;
  unsigned long long l_cfg = 0x20u | (ACTIVE_LOW ? 0x4u : 0u) | ((static_cast<unsigned long long>(l_drive) & 0x3u) << 3);
  bool l_value = VALUE;
  unsigned short l_id = lio_slot;
  unsigned l_gen = lio_gen;
  lio::slot *l_s = lio::enter(l_id, l_gen, lio::k_out, PIN.c_str(), l_cfg);
  lio_slot = l_id;
  lio_gen = l_gen;
  bool l_valid = false;
${NO_SLOT}
  if (l_s) {
    l_s->stop = ON_STOP;
    long long l_now = lio::now_ns();
    if (l_s->fd < 0 && l_now >= l_s->next_try) {
      lio::claim_line(*l_s, l_value);
      if (l_s->fd < 0) l_s->next_try = l_now + lio::retry_after;
    }
    if (l_s->fd >= 0) {
      int l_want = l_value ? 1 : 0;
      if (l_s->applied != l_want) {
        if (lio::line_set(l_s->fd, l_value)) {
          l_s->applied = l_want;
          if (l_s->error != lio::e_no_error) lio::set_error(*l_s, lio::e_no_error, "", "");
        } else {
          lio::set_errno(*l_s, lio::e_io, l_s->key, "cannot set the line", errno);
        }
      }
      l_valid = l_s->applied == l_want;
    }
${TAKE_RESULT}
    lio::leave();
  }
  VALID = l_valid;
${SHOW}`,
  '',
)

const PWM_OUT = block(
  'PWM_OUT',
  `Drives a hardware PWM channel of the Linux device (sysfs) at FREQUENCY (Hz) with DUTY (0 to 100 %). CHIP is the pwmchip number ('0'), its name ('pwmchip0') or its device name; CHANNEL counts from 0. The channel is set up outside the PLC scan and written only when a value changes; VALID is TRUE once it runs with the values asked for. When the block is no longer called (PLC stop, PLC error, new upload) the channel goes to ON_STOP: LIO_STOP_OFF (default, duty 0 and disabled) or LIO_STOP_HOLD. ENABLE FALSE turns the channel off, also one left running by LIO_STOP_HOLD before. A board may need its PWM driver switched on in its boot settings first.
Example: fan(ENABLE := TRUE, CHIP := '0', CHANNEL := 0, FREQUENCY := 1000.0, DUTY := speed);`,
  `  CHIP : STRING;
  CHANNEL : USINT;
  FREQUENCY : REAL;
  DUTY : REAL;
  ON_STOP : USINT;
`,
  '',
  `  if (!ENABLE) {
    char l_key[lio::key_size];
    snprintf(l_key, sizeof(l_key), "%s:%u", CHIP.c_str(), static_cast<unsigned>(CHANNEL));
    unsigned short l_id = lio_slot;
    unsigned l_gen = lio_gen;
    lio::pwm_off(l_id, l_gen, l_key);
    lio_slot = l_id;
    lio_gen = l_gen;
    VALID = false;
    ERROR = 0;
    if (lio_last != 0) ERRORTEXT = "";
    lio_last = 0;
    return;
  }
${wrongInput('k_pwm', 'ON_STOP != 0 && ON_STOP != 2', 'ON_STOP is LIO_STOP_OFF or LIO_STOP_HOLD', '')}
  double l_freq = FREQUENCY;
  double l_duty = DUTY;
  char l_key[lio::key_size];
  uint8_t l_channel = CHANNEL;
  snprintf(l_key, sizeof(l_key), "%s:%u", CHIP.c_str(), static_cast<unsigned>(l_channel));
  unsigned short l_id = lio_slot;
  unsigned l_gen = lio_gen;
  lio::slot *l_s = lio::enter(l_id, l_gen, lio::k_pwm, l_key, 0);
  lio_slot = l_id;
  lio_gen = l_gen;
  bool l_valid = false;
${NO_SLOT}
  if (l_s) {
    l_s->stop = ON_STOP;
    bool l_ok = l_freq > 0 && l_duty >= 0 && l_duty <= 100;
    if (l_ok) {
      l_s->freq = l_freq;
      l_s->duty = l_duty;
    }
${TAKE_RESULT}
    if (!l_ok && l_err == lio::e_no_error) {
      l_err = lio::e_input;
      lio::clear(l_msg);
      lio::put(l_msg, "FREQUENCY must be above 0 and DUTY from 0 to 100; the output is unchanged");
    }
    l_valid = l_ok && l_err == lio::e_no_error && l_s->applied_on && l_s->applied_freq == l_freq &&
              l_s->applied_duty == l_duty;
    lio::leave();
  }
  VALID = l_valid;
${SHOW}`,
  '',
)

/** Shared body of the two reads: `key` is built in `l_key`, `setup` sets the slot's read settings. */
function readBody(kind: string, setup: string): string {
  return `  long long l_period = PERIOD;
  if (l_period < 10 * lio::ms) l_period = 10 * lio::ms;
  unsigned short l_id = lio_slot;
  unsigned l_gen = lio_gen;
  lio::slot *l_s = lio::enter(l_id, l_gen, lio::${kind}, l_key, 0);
  lio_slot = l_id;
  lio_gen = l_gen;
  bool l_valid = false;
  double l_value = 0;
  long long l_raw = 0;
${NO_SLOT}
  if (l_s) {
    l_s->period = l_period;
${setup}    l_valid = l_s->valid;
    l_value = l_s->value;
    l_raw = l_s->raw;
${TAKE_RESULT}
    lio::leave();
  }
  VALID = l_valid;
  if (l_valid) {
    VALUE = static_cast<float>(l_value);
    RAW = l_raw;
  }
${SHOW}`
}

const READ_VALUE = block(
  'READ_VALUE',
  `Reads the first number in a file under /sys/ of the Linux device every PERIOD, outside the PLC scan: a temperature from a thermal zone or hwmon, a 1-wire sensor's temperature file, any value a kernel driver shows as a file. RAW is the number, VALUE is RAW x SCALE + OFFSET. VALID is FALSE until the first reading after a start, and on an error, when VALUE and RAW keep the last good reading.
Example: cpu(ENABLE := TRUE, PATH := '/sys/class/thermal/thermal_zone0/temp', SCALE := 0.001); temperature := cpu.VALUE;`,
  `  PATH : STRING;
  SCALE : REAL := 1.0;
  OFFSET : REAL;
  PERIOD : TIME := T#1s;
`,
  '  VALUE : REAL;\n  RAW : LINT;\n',
  `${disabled('k_value', '')}
  char l_key[lio::key_size];
  lio::copy_cstr(l_key, sizeof(l_key), PATH.c_str());
${readBody('k_value', '    double l_scale = SCALE;\n    double l_offset = OFFSET;\n    l_s->scale = l_scale;\n    l_s->offset = l_offset;\n')}`,
  '',
)

const IIO_READ = block(
  'IIO_READ',
  `Reads a channel of a Linux IIO device (ADCs and other sensors with a kernel driver) every PERIOD, outside the PLC scan. DEVICE is the device's name as the driver gives it, CHANNEL the channel's file prefix (such as 'in_voltage0'). RAW is the channel's raw value and VALUE = (RAW + offset) x scale with the driver's offset and scale, in the driver's unit (such as mV). VALID is FALSE until the first reading after a start, and on an error, when VALUE and RAW keep the last good reading.
Example: adc(ENABLE := TRUE, DEVICE := 'adc_name', CHANNEL := 'in_voltage0'); millivolts := adc.VALUE;`,
  `  DEVICE : STRING;
  CHANNEL : STRING;
  PERIOD : TIME := T#1s;
`,
  '  VALUE : REAL;\n  RAW : DINT;\n',
  `${disabled('k_iio', '')}
  char l_key[lio::key_size];
  snprintf(l_key, sizeof(l_key), "%s\\n%s", DEVICE.c_str(), CHANNEL.c_str());
${readBody('k_iio', '')}`,
  '',
)

/** The library's C++ blocks, without the shared code (`@@SHARED@@` marks where it goes). */
export function linuxIoBlockTemplates(): CanopenBlockSource[] {
  const blocks: Array<[string, string]> = [
    ['GPIO_IN', GPIO_IN],
    ['GPIO_OUT', GPIO_OUT],
    ['PWM_OUT', PWM_OUT],
    ['READ_VALUE', READ_VALUE],
    ['IIO_READ', IIO_READ],
  ]
  return blocks.map(([name, source]) => ({ fileName: `${name}.cpp`, source }))
}

/** The blocks with the shared code in place. */
export function generateLinuxIoBlocks(sharedCode: string): CanopenBlockSource[] {
  const shared = sharedCode.endsWith('\n') ? sharedCode : `${sharedCode}\n`
  return linuxIoBlockTemplates().map((b) => ({
    fileName: b.fileName,
    source: b.source.replace('@@SHARED@@\n', shared),
  }))
}
