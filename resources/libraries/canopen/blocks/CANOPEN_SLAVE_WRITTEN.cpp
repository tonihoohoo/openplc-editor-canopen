(* Tells how often the master has written an object of this runtime's CANopen slave, by SDO or RPDO, also with the same value: COUNT since the slave started, and NEW TRUE in the call after COUNT changed (in the first call when it was written before). An object mapped to an RPDO counts every frame. INDEX and SUBINDEX name an object from the master. SLAVE is the slave's name or its place in the project's slaves, from 1.
Example: cmd(SLAVE := Line_IO, ENABLE := TRUE, INDEX := 16#2000, SUBINDEX := 1); IF cmd.NEW THEN ... END_IF; *)
FUNCTION_BLOCK CANOPEN_SLAVE_WRITTEN
VAR_INPUT
  SLAVE : USINT := 1;
  ENABLE : BOOL;
  INDEX : WORD;
  SUBINDEX : BYTE;
END_VAR
VAR_OUTPUT
  CONFIRM : BOOL;
  ERROR : USINT;
  ERRORTEXT : STRING;
  COUNT : UDINT;
  NEW : BOOL;
END_VAR
VAR
  cop_seen : UDINT;
  cop_last : USINT;
  cop_reason : USINT;
END_VAR
// SPDX-License-Identifier: Apache-2.0
//
// Shared code of the canopen function blocks. The generator copies it into every block's source,
// because the editor grafts each library C++ block into one c_blocks_code.cpp and has no other
// place for shared code; the include guard keeps one copy per program.
//
// The editor binds every pin and local of a block to a #define of its name, so nothing here uses
// a pin or local name (those are upper case or start with cop_; this code is lower case), nor the
// keyword that closes a variable section, and no system header is included after those defines:
// dlopen, dlsym and dlclose are declared here as glibc declares them.
//
// Derived from canworks ec7fd59, library/src/common.inc (Apache-2.0), adapted to the plugin's
// interface version 3 (core/src/drivers/plugins/native/canopen/plc_api.h in the runtime fork).
#ifndef CANOPEN_FB_SHARED_INCLUDED
#define CANOPEN_FB_SHARED_INCLUDED
#if defined(__linux__)
extern "C" void *dlopen(const char *file, int mode) noexcept(true);
extern "C" void *dlsym(void *handle, const char *name) noexcept(true);
extern "C" int dlclose(void *handle) noexcept(true);
#endif

namespace canopen_fb {

// A copy of the plugin's C interface, version 3; keep in step with plc_api.h. Version 1 is asked
// for, since a newer plugin answers it with its newest table; `size` tells which it is.
const uint32_t api_version = 1;
const uint32_t max_data = 256;
enum {
  e_no_error = 0, e_other_error = 1, e_timeout = 2, e_bus_off = 3, e_error_passive = 4,
  e_internal = 5, e_wrong_parameter = 6, e_node_id_unknown = 7, e_net_id_unknown = 8,
  e_request_error = 9, e_no_driver = 10
};
enum {
  r_none = 0, r_booting = 1, r_full = 2, r_not_run = 3, r_restart = 4, r_link = 5,
  r_too_large = 6, r_length = 7, r_command = 8, r_version = 9,
  r_not_in_eds = 100,  // the blocks' own: DATALENGTH 0 for an object the EDS does not list
  r_needs_v2 = 101,    // the blocks' own: the plugin's table lacks the functions the block needs
  r_reset = 102,       // the blocks' own: a slave NMT block asked for a reset
  r_own_code = 103,    // the blocks' own: an emergency code the slave sends itself
  r_slots = 104,       // the blocks' own: all program emergency slots are taken
  r_object = 105       // the blocks' own: the slave has no such object from the master
};
enum { k_read = 0, k_write = 1, k_nmt = 2 };
struct request {
  uint8_t network;
  uint8_t node;
  uint8_t kind;
  uint8_t command;
  uint16_t index;
  uint8_t subindex;
  uint8_t reserved;
  uint32_t timeout_ms;
  uint32_t length;
  const uint8_t *data;
};
struct result {
  uint8_t error;
  uint8_t reason;
  uint16_t reserved;
  uint32_t abort_code;
  uint32_t length;
};
struct emcy {
  uint8_t node;
  uint8_t error_register;
  uint16_t error_code;
  uint8_t data[5];
  uint8_t reserved[3];
  uint32_t lost;
};
struct api_v1 {
  uint32_t size;
  uint32_t version;
  uint64_t (*start)(const request *req, result *res);
  int (*poll)(uint64_t handle, result *res, uint8_t *data, uint32_t cap);
  void (*cancel)(uint64_t handle);
  int (*node_state)(uint8_t network, uint8_t node, uint8_t *state);
  int (*kernel_state)(uint8_t network, uint8_t *state);
  int (*local_node_id)(uint8_t network, uint8_t *node_id);
  int (*emcy_cursor)(uint8_t network, uint64_t *cursor);
  int (*emcy_next)(uint8_t network, uint8_t node, uint64_t *cursor, emcy *out);
  uint32_t flags;  // present when size covers it
};
// flags: the plugin is never unmapped, so its table stays valid for the life of the process.
const uint32_t flag_permanent = 0x1;
// node_info::flags
const uint8_t node_enabled = 0x01;
const uint8_t node_optional = 0x02;
const uint8_t node_program_start = 0x04;
const uint32_t status_text = 80;
struct node_info {
  uint8_t run_state;
  uint8_t flags;
  uint8_t reserved[2];
  char problem[status_text];
};
struct network_info {
  uint8_t mandatory_up;
  uint8_t optional_up;
  uint8_t configured;
  uint8_t operational;
  uint8_t waiting;
  uint8_t disabled;
  uint8_t faulty;
  uint8_t nodes;
};
struct api_v2 {
  api_v1 v1;
  int (*node_status)(uint8_t network, uint8_t node, node_info *out);
  int (*network_status)(uint8_t network, network_info *out);
  int (*node_enable)(uint8_t network, uint8_t node, uint8_t on);
};
// slave_info::flags
const uint8_t slave_on_bus = 0x01;
const uint8_t slave_master_watched = 0x02;
const uint8_t slave_master_seen = 0x04;
const uint32_t slave_emcy_slots = 31;
struct slave_info {
  uint8_t state;
  uint8_t node_id;
  uint8_t flags;
  uint8_t bus_state;
  uint8_t error_register;
  uint8_t emcy_active;
  uint8_t reserved[2];
};
struct api_v3 {
  api_v2 v2;
  int (*slave_status)(uint8_t slave, slave_info *out);
  int (*slave_nmt)(uint8_t slave, uint8_t command);
  int (*slave_nmt_done)(uint8_t slave, uint8_t command, uint8_t *done);
  int (*slave_emcy_claim)(uint8_t slave, uint32_t *handle);
  int (*slave_emcy)(uint8_t slave, uint32_t handle, uint8_t active, uint16_t code, uint32_t info);
  int (*slave_written)(uint8_t slave, uint16_t index, uint8_t subindex, uint32_t *count);
};
// After a lookup that found no plugin, this many lookups are skipped before the next one.
const uint32_t miss_skip = 1024;

// The loaded plugin's table, or null with `why` set (r_not_run or r_version). The runtime loads
// the plugin again at each PLC start while this program stays loaded, so a table is kept only
// when its flags say it stays valid; otherwise it is looked up on each call. While no plugin is
// found, only one lookup in miss_skip runs; the others answer r_not_run at once.
inline const api_v1 *lookup_api(uint8_t &why) {
  const void *table = nullptr;
  why = r_not_run;
#if defined(__linux__)
  void *lib = dlopen("libcanopen_plugin.so", 0x2 | 0x4);  // RTLD_NOW | RTLD_NOLOAD
  if (!lib) return nullptr;
  typedef const void *(*entry_t)(uint32_t);
  entry_t entry = reinterpret_cast<entry_t>(dlsym(lib, "canopen_plc_api"));
  if (entry) {
    table = entry(api_version);
    if (!table) why = r_version;
  }
  dlclose(lib);
#endif
  const api_v1 *t = static_cast<const api_v1 *>(table);
  if (t && t->size < __builtin_offsetof(api_v1, flags)) {
    why = r_version;
    return nullptr;
  }
  return t;
}

inline bool api_is_permanent(const api_v1 *t) {
  return t->size >= sizeof(api_v1) && (t->flags & flag_permanent) != 0;
}

inline const api_v1 *api(uint8_t &why) {
  static const api_v1 *kept = nullptr;
  static uint32_t skip = 0;
  const api_v1 *t = __atomic_load_n(&kept, __ATOMIC_ACQUIRE);
  if (t) {
    why = r_not_run;
    return t;
  }
  uint32_t left = __atomic_load_n(&skip, __ATOMIC_RELAXED);
  if (left > 0) {
    __atomic_store_n(&skip, left - 1, __ATOMIC_RELAXED);
    why = r_not_run;
    return nullptr;
  }
  t = lookup_api(why);
  if (!t) {
    if (why == r_not_run) __atomic_store_n(&skip, miss_skip, __ATOMIC_RELAXED);
    return nullptr;
  }
  if (api_is_permanent(t)) __atomic_store_n(&kept, t, __ATOMIC_RELEASE);
  return t;
}

// The table with the version 2 functions, or null with `why` set (r_needs_v2 for an older plugin).
inline const api_v2 *api2(uint8_t &why) {
  const api_v1 *t = api(why);
  if (!t) return nullptr;
  if (t->version < 2 || t->size < sizeof(api_v2)) {
    why = r_needs_v2;
    return nullptr;
  }
  return static_cast<const api_v2 *>(static_cast<const void *>(t));
}

// The table with the version 3 functions, or null with `why` set (r_needs_v2 for an older plugin).
inline const api_v3 *api3(uint8_t &why) {
  const api_v1 *t = api(why);
  if (!t) return nullptr;
  if (t->version < 3 || t->size < sizeof(api_v3)) {
    why = r_needs_v2;
    return nullptr;
  }
  return static_cast<const api_v3 *>(static_cast<const void *>(t));
}

// ---- Error text, written into a fixed buffer (no allocation, no libc). ----
struct text {
  char buf[200];
  unsigned len;
};
inline void clear(text &t) {
  t.len = 0;
  t.buf[0] = 0;
}
inline void put(text &t, const char *s) {
  while (*s && t.len + 1 < sizeof t.buf) t.buf[t.len++] = *s++;
  t.buf[t.len] = 0;
}
inline void put_dec(text &t, uint32_t v) {
  char d[12];
  int n = 0;
  do {
    d[n++] = static_cast<char>('0' + v % 10);
    v /= 10;
  } while (v && n < 12);
  while (n > 0 && t.len + 1 < sizeof t.buf) t.buf[t.len++] = d[--n];
  t.buf[t.len] = 0;
}
inline void put_hex(text &t, uint32_t v, int digits) {
  put(t, "16#");
  for (int i = digits - 1; i >= 0 && t.len + 1 < sizeof t.buf; --i)
    t.buf[t.len++] = "0123456789ABCDEF"[(v >> (4 * i)) & 0xF];
  t.buf[t.len] = 0;
}

// CiA 301 SDO abort codes.
inline const char *abort_text(uint32_t code) {
  switch (code) {
    case 0x05030000u: return "toggle bit not alternated";
    case 0x05040000u: return "SDO protocol timed out";
    case 0x05040001u: return "command specifier not valid or unknown";
    case 0x05040002u: return "invalid block size";
    case 0x05040003u: return "invalid sequence number";
    case 0x05040004u: return "CRC error";
    case 0x05040005u: return "out of memory";
    case 0x06010000u: return "unsupported access to an object";
    case 0x06010001u: return "attempt to read a write only object";
    case 0x06010002u: return "attempt to write a read only object";
    case 0x06020000u: return "object does not exist";
    case 0x06040041u: return "object cannot be mapped to the PDO";
    case 0x06040042u: return "the mapped objects would exceed the PDO length";
    case 0x06040043u: return "general parameter incompatibility";
    case 0x06040047u: return "general internal incompatibility in the device";
    case 0x06060000u: return "access failed due to a hardware error";
    case 0x06070010u: return "data type or length does not match";
    case 0x06070012u: return "data type does not match, length too high";
    case 0x06070013u: return "data type does not match, length too low";
    case 0x06090011u: return "sub-index does not exist";
    case 0x06090030u: return "invalid value for parameter";
    case 0x06090031u: return "value of parameter written too high";
    case 0x06090032u: return "value of parameter written too low";
    case 0x06090036u: return "maximum value is less than minimum value";
    case 0x060A0023u: return "resource not available: SDO connection";
    case 0x08000000u: return "general error";
    case 0x08000020u: return "data cannot be transferred or stored to the application";
    case 0x08000021u: return "data cannot be transferred or stored because of local control";
    case 0x08000022u: return "data cannot be transferred or stored in the present device state";
    case 0x08000023u: return "no object dictionary is present";
    case 0x08000024u: return "no data available";
    default: return "unknown abort code";
  }
}

// What a request was about, for its error text.
struct what {
  uint8_t network;
  uint8_t node;
  uint8_t kind;
  uint16_t index;
  uint8_t subindex;
  uint32_t timeout_ms;
  uint32_t capacity;  // bytes the block holds
};

inline what what_of(uint8_t network, uint8_t node, uint16_t index, uint8_t subindex,
                    uint32_t timeout_ms, uint32_t capacity) {
  what w{};
  w.network = network;
  w.node = node;
  w.index = index;
  w.subindex = subindex;
  w.timeout_ms = timeout_ms;
  w.capacity = capacity;
  return w;
}

inline void put_node(text &t, const what &w) {
  if (w.node == 0) {
    put(t, "the nodes of network ");
    put_dec(t, w.network);
  } else {
    put(t, "node ");
    put_dec(t, w.node);
  }
}

inline void put_object(text &t, const what &w) {
  put_hex(t, w.index, 4);
  put(t, " sub ");
  put_dec(t, w.subindex);
}

// The error text of a failed request, and its ERRORINFO.
inline uint32_t describe(text &t, const what &w, const result &r) {
  clear(t);
  switch (r.error) {
    case e_other_error:
      put_node(t, w);
      put(t, " aborted ");
      put_object(t, w);
      put(t, ": ");
      put(t, abort_text(r.abort_code));
      put(t, " (");
      put_hex(t, r.abort_code, 8);
      put(t, ")");
      return r.abort_code;
    case e_timeout:
      put_node(t, w);
      put(t, " did not answer");
      if (w.timeout_ms) {
        put(t, " within ");
        put_dec(t, w.timeout_ms);
        put(t, " ms");
      }
      return r.abort_code ? r.abort_code : 0x05040000u;
    case e_bus_off:
      put(t, "network ");
      put_dec(t, w.network);
      put(t, r.reason == r_link ? " link is down" : " bus is off");
      return 0;
    case e_error_passive:
      put(t, "network ");
      put_dec(t, w.network);
      put(t, " is error passive");
      return 0;
    case e_wrong_parameter:
      if (r.reason == r_too_large) {
        put(t, "object has ");
        put_dec(t, r.length);
        put(t, " bytes, the block holds ");
        put_dec(t, w.capacity);
        return r.length;
      }
      if (r.reason == r_length) {
        put(t, "DATALENGTH ");
        put_dec(t, r.length);
        put(t, " is not 1 to ");
        put_dec(t, w.capacity);
        return 0;
      }
      if (r.reason == r_not_in_eds) {
        put_node(t, w);
        put(t, " has no object ");
        put_object(t, w);
        put(t, " of 1 to 4 bytes in its EDS; set DATALENGTH");
        return 0;
      }
      if (r.reason == r_command) {
        put(t, "STATE ");
        put_dec(t, r.length);
        put(t, " is not an NMT state change");
        return 0;
      }
      put(t, "wrong parameter");
      return 0;
    case e_node_id_unknown:
      put(t, "network ");
      put_dec(t, w.network);
      put(t, " has no node ");
      put_dec(t, w.node);
      return 0;
    case e_net_id_unknown:
      put(t, "no CANopen network ");
      put_dec(t, w.network);
      return 0;
    case e_request_error:
      if (r.reason == r_booting) {
        put_node(t, w);
        put(t, " is booting");
      } else if (r.reason == r_full) {
        put(t, "network ");
        put_dec(t, w.network);
        put(t, " has 16 block requests waiting");
      } else {
        put(t, "the request cannot run now");
      }
      return 0;
    case e_no_driver:
      if (r.reason == r_restart)
        put(t, "request cancelled by the PLC stop");
      else if (r.reason == r_version)
        put(t, "the CANopen plugin does not offer the blocks' interface version 1");
      else if (r.reason == r_needs_v2)
        put(t, "the runtime's CANopen plugin is too old for this block; update the runtime");
      else
        put(t, "no CANopen network runs");
      return 0;
    default:
      put(t, "internal error in the CANopen master");
      return 0;
  }
}

// The error text of a slave block, for `slave` and the object (index, subindex) or ERRORCODE.
inline void describe_slave(text &t, uint8_t slave, uint8_t error, uint8_t reason, uint16_t index,
                           uint8_t subindex) {
  clear(t);
  switch (error) {
    case e_no_error:
      return;
    case e_net_id_unknown:
      put(t, "no CANopen slave ");
      put_dec(t, slave);
      return;
    case e_no_driver:
      if (reason == r_needs_v2)
        put(t, "the runtime's CANopen plugin is too old for this block; update the runtime");
      else if (reason == r_version)
        put(t, "the CANopen plugin does not offer the blocks' interface version 1");
      else
        put(t, "no CANopen slave runs");
      return;
    case e_wrong_parameter:
      if (reason == r_reset) {
        put(t, "the program cannot reset the slave; STATE must be START_REMOTE_NODE, ");
        put(t, "STOP_REMOTE_NODE or ENTER_PRE_OPERATIONAL");
      } else if (reason == r_own_code) {
        put(t, "ERRORCODE ");
        put_hex(t, index, 4);
        put(t, " is sent by the slave itself; use another code");
      } else if (reason == r_object) {
        put(t, "slave ");
        put_dec(t, slave);
        put(t, " has no object ");
        put_hex(t, index, 4);
        put(t, " sub ");
        put_dec(t, subindex);
        put(t, " written by the master");
      } else {
        put(t, "wrong parameter");
      }
      return;
    case e_request_error:
      if (reason == r_slots) {
        put(t, "slave ");
        put_dec(t, slave);
        put(t, " already holds 31 program emergencies");
      } else {
        put(t, "the request cannot run now");
      }
      return;
    default:
      put(t, "internal error in the CANopen slave");
      return;
  }
}

// Shows a failed request on the block's ERROR, ERRORINFO and ERRORTEXT pins.
template <class error_pin, class info_pin, class text_pin>
inline void show(error_pin &error, info_pin &info, text_pin &errortext, const what &w,
                 const result &r) {
  text t;
  uint32_t i = describe(t, w, r);
  error = r.error ? r.error : static_cast<uint8_t>(e_internal);
  info = i;
  errortext = t.buf;
}

// The size of an object of 1 to 4 bytes in the node's EDS, from the table the editor's build
// generates (sorted network, node, index, sub-index, size); 0 when it is not listed.
inline uint32_t eds_size(uint8_t network, uint8_t node, uint16_t index, uint8_t subindex) {
  const uint64_t key = (static_cast<uint64_t>(network) << 32) | (static_cast<uint64_t>(node) << 24) |
                       (static_cast<uint64_t>(index) << 8) | subindex;
  long lo = 0;
  long hi = static_cast<long>(static_cast<uint32_t>(strucpp::CANOPEN_OBJECT_SIZE_COUNT)) - 1;
  while (lo <= hi) {
    long mid = (lo + hi) / 2;
    uint64_t entry = static_cast<uint64_t>(strucpp::CANOPEN_OBJECT_SIZES[mid]);
    uint64_t k = entry >> 8;
    if (k == key) return static_cast<uint32_t>(entry & 0xFF);
    if (k < key)
      lo = mid + 1;
    else
      hi = mid - 1;
  }
  return 0;
}

// TIME (nanoseconds) to milliseconds; 0 or less: the network's SDO timeout.
inline uint32_t timeout_ms(long long ns) {
  if (ns <= 0) return 0;
  long long ms = (ns + 999999) / 1000000;
  return ms > 3600000 ? 3600000u : static_cast<uint32_t>(ms);
}

// One instance's handshake (CiA 405): the block keeps `prev`, `phase` and `handle` in its locals.
enum { phase_idle = 0, phase_busy = 1, phase_ended = 2 };
struct step {
  bool start;   // rising edge of ENABLE: clear the outputs and start a request
  bool cancel;  // falling edge while busy: drop the request and clear the outputs
  bool clear;   // the result was shown and ENABLE is FALSE: clear the outputs
};
inline step begin(bool enable, bool &prev, uint8_t &phase) {
  step s{false, false, false};
  bool rising = enable && !prev;
  prev = enable;
  if (!enable && phase == phase_busy) {
    s.cancel = true;
    phase = phase_idle;
  } else if (!enable && phase == phase_ended) {
    s.clear = true;
    phase = phase_idle;
  }
  if (rising && phase != phase_busy) s.start = true;
  return s;
}

// Starts `req`. Returns the handle, or 0 with `res` saying why it cannot run.
inline uint64_t start(const request &req, result &res) {
  res = result{};
  uint8_t why = 0;
  const api_v1 *t = api(why);
  if (!t) {
    res.error = e_no_driver;
    res.reason = why;
    return 0;
  }
  uint64_t handle = t->start(&req, &res);
  if (!handle && res.error == e_no_error) res.error = e_internal;
  return handle;
}

// 0 while the request runs; 1 done, 2 failed (`res` set).
inline int poll(uint64_t handle, result &res, uint8_t *data, uint32_t cap) {
  res = result{};
  uint8_t why = 0;
  const api_v1 *t = api(why);
  if (!t) {
    res.error = e_no_driver;
    res.reason = why == r_version ? r_version : r_restart;
    return 2;
  }
  return t->poll(handle, &res, data, cap);
}

inline void cancel(uint64_t handle) {
  uint8_t why = 0;
  const api_v1 *t = api(why);
  if (t) t->cancel(handle);
}

inline void put_le(uint8_t *out, uint32_t v, unsigned n) {
  for (unsigned b = 0; b < n; ++b) out[b] = static_cast<uint8_t>(v >> (8 * b));
}

inline uint32_t get_le(const uint8_t *in, unsigned n) {
  uint32_t v = 0;
  for (unsigned b = 0; b < n && b < 4; ++b) v |= static_cast<uint32_t>(in[b]) << (8 * b);
  return v;
}

// A failure before any request ran (bad input): `res` for describe().
inline result fail(uint8_t error, uint8_t reason, uint32_t length) {
  result r{};
  r.error = error;
  r.reason = reason;
  r.length = length;
  return r;
}

}  // namespace canopen_fb
#endif
void setup() {
}

void loop() {
  NEW = false;
  if (!ENABLE) {
    CONFIRM = false;
    ERROR = 0;
    if (cop_last != 0) ERRORTEXT = "";
    cop_last = 0;
    cop_reason = 0;
    return;
  }
  uint8_t l_why = 0;
  const canopen_fb::api_v3 *l_api = canopen_fb::api3(l_why);
  int l_error = canopen_fb::e_no_driver;
  uint8_t l_reason = l_api ? 0 : l_why;
  uint16_t l_index = INDEX;
  uint8_t l_sub = SUBINDEX;
  if (l_api) {
    uint32_t l_count = 0;
    l_error = l_api->slave_written(SLAVE, l_index, l_sub, &l_count);
    if (l_error == canopen_fb::e_wrong_parameter) l_reason = canopen_fb::r_object;
    if (l_error == canopen_fb::e_no_error) {
      COUNT = l_count;
      NEW = l_count != cop_seen;
      cop_seen = l_count;
    }
  }
  CONFIRM = l_error == canopen_fb::e_no_error;
  ERROR = static_cast<uint8_t>(l_error);
  if (l_error != cop_last || l_reason != cop_reason) {
    canopen_fb::text l_text;
    canopen_fb::describe_slave(l_text, SLAVE, static_cast<uint8_t>(l_error), l_reason, l_index, l_sub);
    ERRORTEXT = l_text.buf;
    cop_last = static_cast<uint8_t>(l_error);
    cop_reason = l_reason;
  }
}
END_FUNCTION_BLOCK
