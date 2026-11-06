// SPDX-License-Identifier: Apache-2.0
//
// Shared code of the linux_io function blocks. The generator copies it into every block's source,
// because the editor grafts each library C++ block into one c_blocks_code.cpp and has no other
// place for shared code; the include guard keeps one copy per program.
//
// The editor binds every pin and local of a block to a #define of its name before this code, so
// the system headers are included with those names pushed and undefined, and this code names
// nothing in upper case.
//
// Linux only: GPIO through the character device (uAPI v2), PWM and values through sysfs. A helper
// thread (normal scheduling) does the slow reads and the PWM writes, puts outputs in their stop
// state when their block is no longer called, and releases what a block has not used for 2 s.
#ifndef LINUX_IO_SHARED_INCLUDED
#define LINUX_IO_SHARED_INCLUDED

#pragma push_macro("ENABLE")
#pragma push_macro("PIN")
#pragma push_macro("BIAS")
#pragma push_macro("ACTIVE_LOW")
#pragma push_macro("DEBOUNCE")
#pragma push_macro("Q")
#pragma push_macro("VALUE")
#pragma push_macro("DRIVE")
#pragma push_macro("ON_STOP")
#pragma push_macro("CHIP")
#pragma push_macro("CHANNEL")
#pragma push_macro("FREQUENCY")
#pragma push_macro("DUTY")
#pragma push_macro("PATH")
#pragma push_macro("SCALE")
#pragma push_macro("OFFSET")
#pragma push_macro("PERIOD")
#pragma push_macro("RAW")
#pragma push_macro("DEVICE")
#pragma push_macro("VALID")
#pragma push_macro("ERROR")
#pragma push_macro("ERRORTEXT")
#pragma push_macro("lio_slot")
#pragma push_macro("lio_gen")
#undef ENABLE
#undef PIN
#undef BIAS
#undef ACTIVE_LOW
#undef DEBOUNCE
#undef Q
#undef VALUE
#undef DRIVE
#undef ON_STOP
#undef CHIP
#undef CHANNEL
#undef FREQUENCY
#undef DUTY
#undef PATH
#undef SCALE
#undef OFFSET
#undef PERIOD
#undef RAW
#undef DEVICE
#undef VALID
#undef ERROR
#undef ERRORTEXT
#undef lio_slot
#undef lio_gen

#if defined(__linux__)
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/gpio.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>
#endif

#ifndef LIO_SYS_ROOT
#define LIO_SYS_ROOT "/sys"
#endif
#ifndef LIO_DEV_ROOT
#define LIO_DEV_ROOT "/dev"
#endif

namespace lio {

enum {
  e_no_error = 0, e_not_supported = 1, e_input = 2, e_not_found = 3, e_busy = 4, e_refused = 5,
  e_io = 6, e_no_slot = 7
};
enum { k_none = 0, k_in = 1, k_out = 2, k_pwm = 3, k_value = 4, k_iio = 5 };
enum { stop_off = 0, stop_on = 1, stop_hold = 2 };
enum { bias_none = 0, bias_pull_up = 1, bias_pull_down = 2 };
enum { drive_push_pull = 0, drive_open_drain = 1, drive_open_source = 2 };

const int max_slots = 64;
const int key_size = 520;
const int text_size = 128;
const long long ms = 1000000LL;
const long long release_after = 2000 * ms;
const long long retry_after = 500 * ms;
const long long min_stop_after = 100 * ms;

// Text for ERRORTEXT, bounded.
struct text {
  char buf[text_size];
};
inline void clear(text &t) { t.buf[0] = '\0'; }
inline void put(text &t, const char *s) {
  size_t n = 0;
  while (t.buf[n] != '\0' && n + 1 < sizeof(t.buf)) ++n;
  while (*s != '\0' && n + 1 < sizeof(t.buf)) t.buf[n++] = *s++;
  t.buf[n] = '\0';
}
inline void put_num(text &t, long long v) {
  char tmp[24];
  int n = 0;
  bool neg = v < 0;
  unsigned long long u = neg ? 0ULL - static_cast<unsigned long long>(v) : static_cast<unsigned long long>(v);
  do {
    tmp[n++] = static_cast<char>('0' + u % 10);
    u /= 10;
  } while (u != 0 && n < 22);
  char out[24];
  int k = 0;
  if (neg) out[k++] = '-';
  while (n > 0) out[k++] = tmp[--n];
  out[k] = '\0';
  put(t, out);
}
inline void copy_cstr(char *dst, size_t size, const char *src) {
  size_t n = 0;
  for (; src[n] != '\0' && n + 1 < size; ++n) dst[n] = src[n];
  dst[n] = '\0';
}
inline bool same(const char *a, const char *b) {
  for (; *a != '\0' && *a == *b; ++a, ++b) {
  }
  return *a == *b;
}
inline bool starts_with(const char *s, const char *prefix) {
  for (; *prefix != '\0'; ++s, ++prefix)
    if (*s != *prefix) return false;
  return true;
}

// The first number in a text: optional sign, digits, optional fraction. False if there is none.
inline bool first_number(const char *s, double &value) {
  for (; *s != '\0'; ++s) {
    bool sign = (*s == '-' || *s == '+') && s[1] >= '0' && s[1] <= '9';
    if (!sign && !(*s >= '0' && *s <= '9')) continue;
    bool neg = *s == '-';
    if (sign) ++s;
    double v = 0;
    for (; *s >= '0' && *s <= '9'; ++s) v = v * 10 + (*s - '0');
    if (*s == '.' && s[1] >= '0' && s[1] <= '9') {
      double f = 0.1;
      for (++s; *s >= '0' && *s <= '9'; ++s, f /= 10) v += (*s - '0') * f;
    }
    value = neg ? -v : v;
    return true;
  }
  return false;
}

// value = (raw + offset) x scale, the IIO rule.
inline double iio_value(double raw, double offset, double scale) { return (raw + offset) * scale; }

// An output is put in its stop state after max(100 ms, 5 x its call interval) without a call.
inline long long stop_after(long long interval_ns) {
  long long five = interval_ns * 5;
  return five > min_stop_after ? five : min_stop_after;
}

// "in_voltage0" -> "in_voltage": the prefix of the device-wide scale and offset files.
inline void channel_type(const char *channel, char *out, size_t size) {
  copy_cstr(out, size, channel);
  size_t n = 0;
  while (out[n] != '\0') ++n;
  while (n > 0 && out[n - 1] >= '0' && out[n - 1] <= '9') out[--n] = '\0';
}

#if defined(__linux__)

struct slot {
  bool used;
  int kind;
  unsigned gen;  // matches the owning block's lio_gen
  char key[key_size];   // pin, path, or IIO device and channel
  unsigned long long cfg;  // packed settings; a change makes the block claim again
  long long last_call;
  long long interval;
  bool stopped;
  int stop;
  // GPIO
  int fd;
  long long next_try;
  int applied;  // last value set on an output, -1 unknown
  // PWM
  double freq;
  double duty;
  double applied_freq;
  double applied_duty;
  bool applied_on;
  bool exported;
  char pwm_dir[256];
  // reads
  long long period;
  double scale;
  double offset;
  long long next_read;
  double value;
  long long raw;
  bool valid;
  // result for the block
  int error;
  char message[text_size];
};

struct state {
  slot slots[max_slots];
  pthread_mutex_t lock;
  pthread_t thread;
  bool thread_started;
  bool running;
  volatile bool quit;
  unsigned next_gen;
};

inline state &shared() {
  static state s = [] {
    state init{};
    pthread_mutex_init(&init.lock, nullptr);
    for (int i = 0; i < max_slots; ++i) init.slots[i].fd = -1;
    return init;
  }();
  return s;
}

inline long long now_ns() {
  timespec ts{};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<long long>(ts.tv_sec) * 1000000000LL + ts.tv_nsec;
}

inline void set_error(slot &s, int error, const text &t) {
  s.error = error;
  copy_cstr(s.message, sizeof(s.message), error == e_no_error ? "" : t.buf);
}
inline void set_error(slot &s, int error, const char *subject, const char *what) {
  text t;
  clear(t);
  put(t, subject);
  put(t, ": ");
  put(t, what);
  set_error(s, error, t);
}
inline void set_errno(slot &s, int error, const char *subject, const char *what, int err) {
  text t;
  clear(t);
  put(t, subject);
  put(t, ": ");
  put(t, what);
  put(t, " (");
  put(t, strerror(err));
  put(t, ")");
  set_error(s, error, t);
}

// ---- files ----

inline bool read_file(const char *path, char *buf, size_t size, int &err) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    err = errno;
    return false;
  }
  ssize_t n = read(fd, buf, size - 1);
  err = errno;
  close(fd);
  if (n < 0) return false;
  buf[n] = '\0';
  return true;
}
inline bool write_file(const char *path, const char *value, int &err) {
  int fd = open(path, O_WRONLY | O_TRUNC | O_CLOEXEC);
  if (fd < 0) {
    err = errno;
    return false;
  }
  size_t len = 0;
  while (value[len] != '\0') ++len;
  ssize_t n = write(fd, value, len);
  err = errno;
  close(fd);
  return n == static_cast<ssize_t>(len);
}
inline void trim(char *s) {
  size_t n = 0;
  while (s[n] != '\0') ++n;
  while (n > 0 && (s[n - 1] == '\n' || s[n - 1] == ' ' || s[n - 1] == '\r' || s[n - 1] == '\t')) s[--n] = '\0';
}
inline bool join(char *out, size_t size, const char *a, const char *b, const char *c = "") {
  int n = snprintf(out, size, "%s%s%s", a, b, c);
  return n > 0 && static_cast<size_t>(n) < size;
}

// ---- GPIO ----

inline bool all_digits(const char *s) {
  if (*s == '\0') return false;
  for (; *s != '\0'; ++s)
    if (*s < '0' || *s > '9') return false;
  return true;
}

// Opens the chip named `chip` (device name such as gpiochip0, or its label); -1 if none.
inline int open_chip(const char *chip) {
  char path[PATH_MAX];
  if (starts_with(chip, "gpiochip") && join(path, sizeof(path), LIO_DEV_ROOT "/", chip)) {
    int fd = open(path, O_RDWR | O_CLOEXEC);
    if (fd >= 0) return fd;
  }
  DIR *dir = opendir(LIO_DEV_ROOT);
  if (!dir) return -1;
  int found = -1;
  while (dirent *e = readdir(dir)) {
    if (!starts_with(e->d_name, "gpiochip") || !join(path, sizeof(path), LIO_DEV_ROOT "/", e->d_name)) continue;
    int fd = open(path, O_RDWR | O_CLOEXEC);
    if (fd < 0) continue;
    gpiochip_info info{};
    if (ioctl(fd, GPIO_GET_CHIPINFO_IOCTL, &info) == 0 && same(info.label, chip)) {
      found = fd;
      break;
    }
    close(fd);
  }
  closedir(dir);
  return found;
}

// Finds a line by name on any chip; returns the open chip and sets `offset`, or -1.
inline int find_line(const char *name, unsigned &offset, char *consumer, size_t consumer_size) {
  DIR *dir = opendir(LIO_DEV_ROOT);
  if (!dir) return -1;
  int found = -1;
  char path[PATH_MAX];
  while (found < 0) {
    dirent *e = readdir(dir);
    if (!e) break;
    if (!starts_with(e->d_name, "gpiochip") || !join(path, sizeof(path), LIO_DEV_ROOT "/", e->d_name)) continue;
    int fd = open(path, O_RDWR | O_CLOEXEC);
    if (fd < 0) continue;
    gpiochip_info info{};
    if (ioctl(fd, GPIO_GET_CHIPINFO_IOCTL, &info) == 0) {
      for (unsigned i = 0; i < info.lines; ++i) {
        gpio_v2_line_info li{};
        li.offset = i;
        if (ioctl(fd, GPIO_V2_GET_LINEINFO_IOCTL, &li) == 0 && same(li.name, name)) {
          offset = i;
          copy_cstr(consumer, consumer_size, li.consumer);
          found = fd;
          break;
        }
      }
    }
    if (found < 0) close(fd);
  }
  closedir(dir);
  return found;
}

// Claims the line of slot `s` (pin in key) as input or output with the settings in cfg.
// cfg: bits 0-1 bias, 2 active low, 3-4 drive, 5 output, 32-63 debounce in microseconds.
inline void claim_line(slot &s, bool first_value) {
  const char *pin = s.key;
  unsigned offset = 0;
  char consumer[32] = "";
  int chip = -1;
  const char *colon = nullptr;
  for (const char *p = pin; *p != '\0'; ++p)
    if (*p == ':') colon = p;
  if (colon) {
    char name[key_size];
    size_t n = static_cast<size_t>(colon - pin);
    if (n >= sizeof(name) || !all_digits(colon + 1)) {
      set_error(s, e_input, pin, "PIN is a line name or <chip>:<offset>");
      return;
    }
    for (size_t i = 0; i < n; ++i) name[i] = pin[i];
    name[n] = '\0';
    offset = static_cast<unsigned>(strtoul(colon + 1, nullptr, 10));
    chip = open_chip(name);
    if (chip >= 0) {
      gpio_v2_line_info li{};
      li.offset = offset;
      if (ioctl(chip, GPIO_V2_GET_LINEINFO_IOCTL, &li) != 0) {
        close(chip);
        set_error(s, e_not_found, pin, "the chip has no such line");
        return;
      }
      copy_cstr(consumer, sizeof(consumer), li.consumer);
    }
  } else if (*pin != '\0') {
    chip = find_line(pin, offset, consumer, sizeof(consumer));
  }
  if (chip < 0) {
    set_error(s, e_not_found, *pin != '\0' ? pin : "PIN", "no such GPIO line");
    return;
  }
  gpio_v2_line_request req{};
  req.offsets[0] = offset;
  req.num_lines = 1;
  copy_cstr(req.consumer, sizeof(req.consumer), "openplc");
  unsigned long long cfg = s.cfg;
  unsigned long long flags = (cfg & 0x20u) ? GPIO_V2_LINE_FLAG_OUTPUT : GPIO_V2_LINE_FLAG_INPUT;
  if (cfg & 0x4u) flags |= GPIO_V2_LINE_FLAG_ACTIVE_LOW;
  if (cfg & 0x20u) {
    unsigned drive = static_cast<unsigned>((cfg >> 3) & 0x3u);
    if (drive == drive_open_drain) flags |= GPIO_V2_LINE_FLAG_OPEN_DRAIN;
    if (drive == drive_open_source) flags |= GPIO_V2_LINE_FLAG_OPEN_SOURCE;
    req.config.attrs[0].attr.id = GPIO_V2_LINE_ATTR_ID_OUTPUT_VALUES;
    req.config.attrs[0].attr.values = first_value ? 1u : 0u;
    req.config.attrs[0].mask = 1u;
    req.config.num_attrs = 1;
  } else {
    unsigned bias = static_cast<unsigned>(cfg & 0x3u);
    if (bias == bias_pull_up) flags |= GPIO_V2_LINE_FLAG_BIAS_PULL_UP;
    else if (bias == bias_pull_down) flags |= GPIO_V2_LINE_FLAG_BIAS_PULL_DOWN;
    else flags |= GPIO_V2_LINE_FLAG_BIAS_DISABLED;
    unsigned debounce_us = static_cast<unsigned>(cfg >> 32);
    if (debounce_us != 0) {
      req.config.attrs[0].attr.id = GPIO_V2_LINE_ATTR_ID_DEBOUNCE;
      req.config.attrs[0].attr.debounce_period_us = debounce_us;
      req.config.attrs[0].mask = 1u;
      req.config.num_attrs = 1;
    }
  }
  req.config.flags = flags;
  int rc = ioctl(chip, GPIO_V2_GET_LINE_IOCTL, &req);
  int err = errno;
  close(chip);
  if (rc != 0) {
    if (err == EBUSY) {
      text t;
      clear(t);
      put(t, pin);
      put(t, ": in use");
      if (consumer[0] != '\0') {
        put(t, " by ");
        put(t, consumer);
      }
      set_error(s, e_busy, t);
    } else {
      set_errno(s, e_refused, pin, "the chip refused the line settings", err);
    }
    return;
  }
  s.fd = req.fd;
  s.applied = (cfg & 0x20u) ? (first_value ? 1 : 0) : -1;
  set_error(s, e_no_error, "", "");
}

inline bool line_get(int fd, bool &value) {
  gpio_v2_line_values v{};
  v.mask = 1u;
  if (ioctl(fd, GPIO_V2_LINE_GET_VALUES_IOCTL, &v) != 0) return false;
  value = (v.bits & 1u) != 0;
  return true;
}
inline bool line_set(int fd, bool value) {
  gpio_v2_line_values v{};
  v.mask = 1u;
  v.bits = value ? 1u : 0u;
  return ioctl(fd, GPIO_V2_LINE_SET_VALUES_IOCTL, &v) == 0;
}

// ---- PWM (helper thread) ----

// The sysfs directory of pwmchip `chip`: a number, pwmchipN, or the chip's device name.
inline bool pwm_chip_dir(const char *chip, char *out, size_t size) {
  const char *base = LIO_SYS_ROOT "/class/pwm/";
  if (all_digits(chip)) return join(out, size, base, "pwmchip", chip) && access(out, F_OK) == 0;
  if (starts_with(chip, "pwmchip")) return join(out, size, base, chip) && access(out, F_OK) == 0;
  DIR *dir = opendir(LIO_SYS_ROOT "/class/pwm");
  if (!dir) return false;
  bool found = false;
  char link[PATH_MAX];
  char target[PATH_MAX];
  while (!found) {
    dirent *e = readdir(dir);
    if (!e) break;
    if (!starts_with(e->d_name, "pwmchip") || !join(link, sizeof(link), base, e->d_name, "/device")) continue;
    ssize_t n = readlink(link, target, sizeof(target) - 1);
    if (n <= 0) continue;
    target[n] = '\0';
    const char *name = target;
    for (const char *p = target; *p != '\0'; ++p)
      if (*p == '/') name = p + 1;
    if (same(name, chip)) found = join(out, size, base, e->d_name);
  }
  closedir(dir);
  return found;
}

inline bool pwm_write(slot &s, const char *file, long long v, const char *subject) {
  char path[PATH_MAX];
  char num[24];
  snprintf(num, sizeof(num), "%lld", v);
  int err = 0;
  if (!join(path, sizeof(path), s.pwm_dir, "/", file) || !write_file(path, num, err)) {
    text t;
    clear(t);
    put(t, "cannot write ");
    put(t, file);
    set_errno(s, e_io, subject, t.buf, err);
    return false;
  }
  return true;
}

// Applies duty/frequency, or turns the channel off (on = false). Called without the lock held,
// on a copy of the slot.
inline void pwm_apply(slot &s, bool on) {
  const char *subject = "PWM";
  if (!s.exported) {
    char chip_dir[PATH_MAX];
    const char *colon = nullptr;
    for (const char *p = s.key; *p != '\0'; ++p)
      if (*p == ':') colon = p;
    char chip[key_size];
    size_t n = colon ? static_cast<size_t>(colon - s.key) : 0;
    for (size_t i = 0; i < n && i + 1 < sizeof(chip); ++i) chip[i] = s.key[i];
    chip[n < sizeof(chip) ? n : sizeof(chip) - 1] = '\0';
    const char *channel = colon ? colon + 1 : "0";
    if (!pwm_chip_dir(chip, chip_dir, sizeof(chip_dir))) {
      set_error(s, e_not_found, chip[0] != '\0' ? chip : "CHIP", "no such PWM chip");
      return;
    }
    if (!join(s.pwm_dir, sizeof(s.pwm_dir), chip_dir, "/pwm", channel)) return;
    if (access(s.pwm_dir, F_OK) != 0) {
      char path[PATH_MAX];
      int err = 0;
      if (!join(path, sizeof(path), chip_dir, "/export") || (!write_file(path, channel, err) && err != EBUSY)) {
        set_errno(s, err == EINVAL || err == ENODEV ? e_not_found : e_io, chip, "cannot export the channel", err);
        return;
      }
    }
    s.exported = true;
    s.applied_on = false;
    s.applied_freq = -1;
    s.applied_duty = -1;
  }
  if (!on) {
    if (s.applied_on) {
      pwm_write(s, "duty_cycle", 0, subject);
      pwm_write(s, "enable", 0, subject);
    }
    s.applied_on = false;
    return;
  }
  if (s.applied_on && s.applied_freq == s.freq && s.applied_duty == s.duty) return;
  long long period = static_cast<long long>(1e9 / s.freq + 0.5);
  long long duty = static_cast<long long>(static_cast<double>(period) * s.duty / 100.0 + 0.5);
  if (period <= 0) {
    set_error(s, e_input, subject, "FREQUENCY is too high");
    return;
  }
  // duty_cycle must stay at or below period while both change.
  if (!pwm_write(s, "duty_cycle", 0, subject) || !pwm_write(s, "period", period, subject) ||
      !pwm_write(s, "duty_cycle", duty, subject) || (!s.applied_on && !pwm_write(s, "enable", 1, subject)))
    return;
  s.applied_on = true;
  s.applied_freq = s.freq;
  s.applied_duty = s.duty;
  set_error(s, e_no_error, "", "");
}

inline void pwm_unexport(slot &s) {
  if (!s.exported) return;
  char chip_dir[PATH_MAX];
  copy_cstr(chip_dir, sizeof(chip_dir), s.pwm_dir);
  size_t n = 0;
  while (chip_dir[n] != '\0') ++n;
  while (n > 0 && chip_dir[n - 1] != '/') --n;
  const char *channel = s.pwm_dir + n + 3;  // after "pwm"
  if (n > 0) chip_dir[n - 1] = '\0';
  char path[PATH_MAX];
  int err = 0;
  if (join(path, sizeof(path), chip_dir, "/unexport")) write_file(path, channel, err);
  s.exported = false;
}

// ---- reads (helper thread) ----

inline void read_value(slot &s, double scale, double offset) {
  char real[PATH_MAX];
  const char *root = LIO_SYS_ROOT "/";
  if (!starts_with(s.key, root) || !realpath(s.key, real) || !starts_with(real, root)) {
    bool outside = !starts_with(s.key, root);
    if (outside) set_error(s, e_input, s.key[0] != '\0' ? s.key : "PATH", "PATH must be a file under " LIO_SYS_ROOT "/");
    else set_errno(s, e_not_found, s.key, "cannot open", errno);
    s.valid = false;
    return;
  }
  char buf[256];
  int err = 0;
  double v = 0;
  if (!read_file(real, buf, sizeof(buf), err)) {
    set_errno(s, e_io, s.key, "cannot read", err);
    s.valid = false;
    return;
  }
  if (!first_number(buf, v)) {
    set_error(s, e_io, s.key, "the file holds no number");
    s.valid = false;
    return;
  }
  s.raw = static_cast<long long>(v);
  s.value = v * scale + offset;
  s.valid = true;
  set_error(s, e_no_error, "", "");
}

inline bool read_number(const char *dir, const char *file, double &v) {
  char path[PATH_MAX];
  char buf[128];
  int err = 0;
  return join(path, sizeof(path), dir, "/", file) && read_file(path, buf, sizeof(buf), err) && first_number(buf, v);
}

// key = "<device>\n<channel>"
inline void read_iio(slot &s) {
  char device[key_size];
  copy_cstr(device, sizeof(device), s.key);
  char *channel = device;
  while (*channel != '\0' && *channel != '\n') ++channel;
  if (*channel == '\n') *channel++ = '\0';
  s.valid = false;
  if (device[0] == '\0' || channel[0] == '\0') {
    set_error(s, e_input, "IIO", "DEVICE and CHANNEL are required");
    return;
  }
  const char *base = LIO_SYS_ROOT "/bus/iio/devices";
  DIR *dir = opendir(base);
  char found[PATH_MAX] = "";
  if (dir) {
    char path[PATH_MAX];
    char name[128];
    int err = 0;
    while (dirent *e = readdir(dir)) {
      if (e->d_name[0] == '.' || !join(path, sizeof(path), base, "/", e->d_name)) continue;
      char name_path[PATH_MAX];
      if (!join(name_path, sizeof(name_path), path, "/name") || !read_file(name_path, name, sizeof(name), err)) continue;
      trim(name);
      if (same(name, device)) {
        copy_cstr(found, sizeof(found), path);
        break;
      }
    }
    closedir(dir);
  }
  if (found[0] == '\0') {
    set_error(s, e_not_found, device, "no such IIO device");
    return;
  }
  char file[key_size + 16];
  double raw = 0;
  snprintf(file, sizeof(file), "%s_raw", channel);
  if (!read_number(found, file, raw)) {
    set_error(s, e_not_found, device, "the channel has no readable _raw file");
    return;
  }
  char type[key_size];
  channel_type(channel, type, sizeof(type));
  double scale = 1;
  double offset = 0;
  snprintf(file, sizeof(file), "%s_scale", channel);
  if (!read_number(found, file, scale)) {
    snprintf(file, sizeof(file), "%s_scale", type);
    if (!read_number(found, file, scale)) scale = 1;
  }
  snprintf(file, sizeof(file), "%s_offset", channel);
  if (!read_number(found, file, offset)) {
    snprintf(file, sizeof(file), "%s_offset", type);
    if (!read_number(found, file, offset)) offset = 0;
  }
  s.raw = static_cast<long long>(raw);
  s.value = iio_value(raw, offset, scale);
  s.valid = true;
  set_error(s, e_no_error, "", "");
}

// ---- helper thread ----

// Puts an output in its stop state. Lock held; GPIO writes are a single ioctl.
inline void stop_gpio(slot &s) {
  if (s.fd >= 0 && s.stop != stop_hold) {
    bool v = s.stop == stop_on;
    if (line_set(s.fd, v)) s.applied = v ? 1 : 0;
  }
}

// Frees a slot; for PWM the caller has already turned it off or kept it (hold).
inline void free_slot(slot &s) {
  if (s.fd >= 0) close(s.fd);
  slot fresh{};
  fresh.fd = -1;
  s = fresh;
}

// True if another used PWM slot drives the same channel (a block enabled again meanwhile).
inline bool pwm_shared(state &st, int self, const char *key) {
  pthread_mutex_lock(&st.lock);
  bool found = false;
  for (int i = 0; i < max_slots && !found; ++i)
    found = i != self && st.slots[i].used && st.slots[i].kind == k_pwm && same(st.slots[i].key, key);
  pthread_mutex_unlock(&st.lock);
  return found;
}

inline void *helper(void *) {
  state &st = shared();
  for (;;) {
    timespec tick = {0, 10 * ms};
    nanosleep(&tick, nullptr);
    if (st.quit) break;
    long long now = now_ns();
    bool any = false;
    for (int i = 0; i < max_slots; ++i) {
      pthread_mutex_lock(&st.lock);
      slot &live = st.slots[i];
      if (!live.used) {
        pthread_mutex_unlock(&st.lock);
        continue;
      }
      any = true;
      long long idle = now - live.last_call;
      bool timed_out = idle > stop_after(live.interval);
      int kind = live.kind;
      if (kind == k_out) {
        if (timed_out && !live.stopped) {
          stop_gpio(live);
          live.stopped = true;
        }
        if (idle > release_after) free_slot(live);
        pthread_mutex_unlock(&st.lock);
        continue;
      }
      if (kind == k_in) {
        if (idle > release_after) free_slot(live);
        pthread_mutex_unlock(&st.lock);
        continue;
      }
      if (timed_out && !live.stopped) live.stopped = true;
      slot work = live;  // slow work on a copy, outside the lock
      pthread_mutex_unlock(&st.lock);

      bool release = idle > release_after;
      bool changed = false;
      if (kind == k_pwm) {
        bool on = !work.stopped && !release;
        if (on || work.stop != stop_hold) {
          pwm_apply(work, on);
          changed = true;
        }
        if (release && work.stop != stop_hold && !pwm_shared(st, i, work.key)) pwm_unexport(work);
      } else if ((kind == k_value || kind == k_iio) && !work.stopped && now >= work.next_read) {
        if (kind == k_value) read_value(work, work.scale, work.offset);
        else read_iio(work);
        work.next_read = now + work.period;
        changed = true;
      }

      pthread_mutex_lock(&st.lock);
      slot &back = st.slots[i];
      if (back.used && back.kind == kind && same(back.key, work.key)) {
        if (release) {
          free_slot(back);
        } else if (changed) {
          back.exported = work.exported;
          copy_cstr(back.pwm_dir, sizeof(back.pwm_dir), work.pwm_dir);
          back.applied_on = work.applied_on;
          back.applied_freq = work.applied_freq;
          back.applied_duty = work.applied_duty;
          back.value = work.value;
          back.raw = work.raw;
          back.valid = work.valid;
          back.next_read = work.next_read;
          back.error = work.error;
          copy_cstr(back.message, sizeof(back.message), work.message);
        }
      }
      pthread_mutex_unlock(&st.lock);
    }
    if (!any) {
      pthread_mutex_lock(&st.lock);
      bool still_none = true;
      for (int i = 0; i < max_slots; ++i) still_none = still_none && !st.slots[i].used;
      if (still_none) st.running = false;
      pthread_mutex_unlock(&st.lock);
      if (still_none) break;
    }
  }
  return nullptr;
}

// Lock held. Starts the helper thread with normal scheduling, not the scan thread's.
inline void ensure_helper(state &st) {
  if (st.running) return;
  if (st.thread_started) pthread_join(st.thread, nullptr);
  st.thread_started = false;
  pthread_attr_t attr;
  if (pthread_attr_init(&attr) != 0) return;
  sched_param param{};
  param.sched_priority = 0;
  pthread_attr_setinheritsched(&attr, PTHREAD_EXPLICIT_SCHED);
  pthread_attr_setschedpolicy(&attr, SCHED_OTHER);
  pthread_attr_setschedparam(&attr, &param);
  st.quit = false;
  if (pthread_create(&st.thread, &attr, helper, nullptr) == 0) {
    st.thread_started = true;
    st.running = true;
  }
  pthread_attr_destroy(&attr);
}

// Stops the helper and frees every slot when the program library is unloaded.
struct unload_guard {
  ~unload_guard() {
    state &st = shared();
    st.quit = true;
    if (st.thread_started) pthread_join(st.thread, nullptr);
    st.thread_started = false;
    st.running = false;
    for (int i = 0; i < max_slots; ++i) {
      slot &s = st.slots[i];
      if (!s.used) continue;
      if (s.kind == k_out && !s.stopped) stop_gpio(s);
      if (s.kind == k_pwm && s.stop != stop_hold) {
        pwm_apply(s, false);
        pwm_unexport(s);
      }
      free_slot(s);
    }
  }
};
inline unload_guard &guard() {
  static unload_guard g;
  return g;
}

// One call of a block: finds or makes its slot (index + 1 in `id`), records the call and returns
// the slot with the lock held, or nullptr (no slot free; the lock is not held then).
inline slot *enter(unsigned short &id, unsigned &gen, int kind, const char *key, unsigned long long cfg) {
  state &st = shared();
  (void)guard();
  long long now = now_ns();
  pthread_mutex_lock(&st.lock);
  slot *s = nullptr;
  if (id >= 1 && id <= max_slots && st.slots[id - 1].used && st.slots[id - 1].kind == kind &&
      st.slots[id - 1].gen == gen)
    s = &st.slots[id - 1];
  if (!s) {
    for (int i = 0; i < max_slots && !s; ++i) {
      if (!st.slots[i].used) {
        s = &st.slots[i];
        slot fresh{};
        fresh.fd = -1;
        fresh.used = true;
        fresh.kind = kind;
        fresh.applied = -1;
        fresh.last_call = now;
        fresh.gen = ++st.next_gen == 0 ? ++st.next_gen : st.next_gen;
        *s = fresh;
        id = static_cast<unsigned short>(i + 1);
        gen = fresh.gen;
      }
    }
  }
  if (!s) {
    pthread_mutex_unlock(&st.lock);
    id = 0;
    gen = 0;
    return nullptr;
  }
  if (!same(s->key, key) || s->cfg != cfg) {
    // A new pin or new settings: claim again.
    if (s->fd >= 0) close(s->fd);
    s->fd = -1;
    s->next_try = 0;
    s->applied = -1;
    s->exported = false;
    s->valid = false;
    s->next_read = 0;
    s->error = e_no_error;
    s->message[0] = '\0';
    copy_cstr(s->key, sizeof(s->key), key);
    s->cfg = cfg;
  }
  long long d = now - s->last_call;
  if (d > 0 && d < 10000 * ms) s->interval = s->interval > 0 ? (s->interval * 7 + d) / 8 : d;
  s->last_call = now;
  s->stopped = false;
  ensure_helper(st);
  return s;
}
inline void leave() { pthread_mutex_unlock(&shared().lock); }

// ENABLE went FALSE: outputs to their stop state, then the slot is freed (PWM by the helper).
inline void disable(unsigned short &id, unsigned &gen, int kind) {
  if (id == 0) return;
  state &st = shared();
  pthread_mutex_lock(&st.lock);
  if (id <= max_slots && st.slots[id - 1].used && st.slots[id - 1].kind == kind && st.slots[id - 1].gen == gen) {
    slot &s = st.slots[id - 1];
    if (kind == k_pwm) {
      s.last_call = 0;  // the helper turns it off (or keeps it, hold) and frees it
      s.stopped = true;
      s.interval = 0;
      s.gen = 0;  // no block owns it any more
    } else {
      if (kind == k_out) stop_gpio(s);
      free_slot(s);
    }
  }
  pthread_mutex_unlock(&st.lock);
  id = 0;
  gen = 0;
}

#endif  // __linux__

}  // namespace lio

#pragma pop_macro("ENABLE")
#pragma pop_macro("PIN")
#pragma pop_macro("BIAS")
#pragma pop_macro("ACTIVE_LOW")
#pragma pop_macro("DEBOUNCE")
#pragma pop_macro("Q")
#pragma pop_macro("VALUE")
#pragma pop_macro("DRIVE")
#pragma pop_macro("ON_STOP")
#pragma pop_macro("CHIP")
#pragma pop_macro("CHANNEL")
#pragma pop_macro("FREQUENCY")
#pragma pop_macro("DUTY")
#pragma pop_macro("PATH")
#pragma pop_macro("SCALE")
#pragma pop_macro("OFFSET")
#pragma pop_macro("PERIOD")
#pragma pop_macro("RAW")
#pragma pop_macro("DEVICE")
#pragma pop_macro("VALID")
#pragma pop_macro("ERROR")
#pragma pop_macro("ERRORTEXT")
#pragma pop_macro("lio_slot")
#pragma pop_macro("lio_gen")
#endif  // LINUX_IO_SHARED_INCLUDED
