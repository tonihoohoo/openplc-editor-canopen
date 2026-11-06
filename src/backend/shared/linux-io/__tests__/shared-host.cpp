// Host test of the linux_io shared code: built by shared-host.test.ts with LIO_SYS_ROOT set to a
// temporary tree, then run. Prints one line per failure and "ok" at the end when all pass.
#include <cstdint>
#include <cstring>
#define ENABLE (*(vars->ENABLE))
#define ERROR (*(vars->ERROR))
#define VALUE (*(vars->VALUE))
#include "../../../../../resources/libraries/linux_io/src/shared.inc"
#include <cmath>
#include <string>
#include <cstdio>
#include <unistd.h>

static int failures = 0;
static void check(bool ok, const char *what) {
  if (!ok) {
    std::printf("FAIL: %s\n", what);
    ++failures;
  }
}
static bool near(double a, double b) { return std::fabs(a - b) < 1e-9; }
static std::string file(const char *rel) { return std::string(LIO_SYS_ROOT) + rel; }
static std::string content(const char *rel) {
  char buf[64] = "";
  int err = 0;
  lio::read_file(file(rel).c_str(), buf, sizeof(buf), err);
  return buf;
}

int main() {
  double v = 0;
  check(lio::first_number("t=-23.5x", v) && near(v, -23.5), "first number with sign and fraction");
  check(lio::first_number("48312\n", v) && near(v, 48312), "first number of a sysfs value");
  check(!lio::first_number("none", v), "no number");
  check(near(lio::iio_value(1000, 10, 2.0), 2020), "IIO value = (raw + offset) x scale");
  check(lio::stop_after(20 * lio::ms) == 100 * lio::ms, "stop after at least 100 ms");
  check(lio::stop_after(50 * lio::ms) == 250 * lio::ms, "stop after five call intervals");
  char type[32];
  lio::channel_type("in_voltage12", type, sizeof(type));
  check(std::strcmp(type, "in_voltage") == 0, "channel type without the number");

  lio::slot s{};
  std::string temp = file("/class/thermal/thermal_zone0/temp");
  lio::copy_cstr(s.key, sizeof(s.key), temp.c_str());
  lio::read_value(s, 0.001, 0);
  check(s.valid && s.raw == 48312 && near(s.value, 48.312) && s.error == 0, "value read with scale");
  lio::read_value(s, 1, 5);
  check(near(s.value, 48317), "value read with offset");

  lio::copy_cstr(s.key, sizeof(s.key), "/etc/hostname");
  lio::read_value(s, 1, 0);
  check(!s.valid && s.error == lio::e_input, "path outside the sysfs root refused");
  std::string escape = file("/escape");
  lio::copy_cstr(s.key, sizeof(s.key), escape.c_str());
  lio::read_value(s, 1, 0);
  check(!s.valid && s.error != 0, "symlink out of the sysfs root refused");
  std::string text = file("/class/text");
  lio::copy_cstr(s.key, sizeof(s.key), text.c_str());
  lio::read_value(s, 1, 0);
  check(!s.valid && s.error == lio::e_io, "file without a number");
  std::string missing = file("/class/missing");
  lio::copy_cstr(s.key, sizeof(s.key), missing.c_str());
  lio::read_value(s, 1, 0);
  check(!s.valid && s.error == lio::e_not_found, "missing file");

  lio::slot a{};
  lio::copy_cstr(a.key, sizeof(a.key), "adc-test\nin_voltage0");
  lio::read_iio(a);
  check(a.valid && a.raw == 1000 && near(a.value, 2020), "IIO channel with the device-wide scale and offset");
  lio::copy_cstr(a.key, sizeof(a.key), "adc-test\nin_voltage1");
  lio::read_iio(a);
  check(a.valid && a.raw == 5 && near(a.value, 7.5), "IIO channel scale and device-wide offset");
  lio::copy_cstr(a.key, sizeof(a.key), "nothing\nin_voltage0");
  lio::read_iio(a);
  check(!a.valid && a.error == lio::e_not_found, "unknown IIO device");

  lio::slot p{};
  lio::copy_cstr(p.key, sizeof(p.key), "0:0");
  p.freq = 1000;
  p.duty = 25;
  lio::pwm_apply(p, true);
  check(p.error == 0 && p.applied_on, "PWM applied");
  check(content("/class/pwm/pwmchip0/pwm0/period") == "1000000", "PWM period 1 ms");
  check(content("/class/pwm/pwmchip0/pwm0/duty_cycle") == "250000", "PWM duty 25 %");
  check(content("/class/pwm/pwmchip0/pwm0/enable") == "1", "PWM enabled");
  p.duty = 50;
  lio::pwm_apply(p, true);
  check(content("/class/pwm/pwmchip0/pwm0/duty_cycle") == "500000", "PWM duty change");
  lio::pwm_apply(p, false);
  check(content("/class/pwm/pwmchip0/pwm0/enable") == "0" && content("/class/pwm/pwmchip0/pwm0/duty_cycle") == "0",
        "PWM off on stop");
  lio::slot q{};
  lio::copy_cstr(q.key, sizeof(q.key), "pwmchip0:1");
  q.freq = 50;
  q.duty = 10;
  lio::pwm_apply(q, true);
  check(content("/class/pwm/pwmchip0/export") == "1", "PWM channel exported when missing");
  lio::slot r{};
  lio::copy_cstr(r.key, sizeof(r.key), "7:0");
  r.freq = 50;
  lio::pwm_apply(r, true);
  check(r.error == lio::e_not_found, "unknown PWM chip");

  // Helper thread: ENABLE FALSE turns off a channel, also one left running by LIO_STOP_HOLD.
  unsigned short id = 0;
  unsigned gen = 0;
  lio::slot *h = lio::enter(id, gen, lio::k_pwm, "0:0", 0);
  h->stop = lio::stop_hold;
  h->freq = 1000;
  h->duty = 25;
  lio::leave();
  usleep(150 * 1000);
  check(content("/class/pwm/pwmchip0/pwm0/enable") == "1", "helper runs the channel");
  usleep(2500 * 1000);
  check(content("/class/pwm/pwmchip0/pwm0/enable") == "1", "LIO_STOP_HOLD keeps it running after release");
  unsigned short off_id = 0;
  unsigned off_gen = 0;
  lio::pwm_off(off_id, off_gen, "0:0");
  check(off_id == lio::pwm_done, "ENABLE FALSE marks the block done");
  usleep(150 * 1000);
  check(content("/class/pwm/pwmchip0/pwm0/enable") == "0", "ENABLE FALSE turns off a held channel");
  id = 0;
  gen = 0;
  h = lio::enter(id, gen, lio::k_pwm, "0:0", 0);
  h->stop = lio::stop_hold;
  h->freq = 1000;
  h->duty = 25;
  lio::leave();
  usleep(150 * 1000);
  check(content("/class/pwm/pwmchip0/pwm0/enable") == "1", "channel runs again");
  lio::pwm_off(id, gen, "0:0");
  usleep(150 * 1000);
  check(content("/class/pwm/pwmchip0/pwm0/enable") == "0", "ENABLE FALSE turns off the block's own held channel");

  if (failures == 0) std::printf("ok\n");
  return failures == 0 ? 0 : 1;
}
