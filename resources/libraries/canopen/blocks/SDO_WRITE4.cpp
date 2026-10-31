(* Writes an object of 1 to 4 bytes of a node by SDO: the low DATALENGTH bytes of DATA, little-endian. DATALENGTH 0 takes the size from the node's EDS. A rising edge of ENABLE starts the write; then CONFIRM or ERROR with ERRORTEXT stays until ENABLE goes FALSE. NETWORK counts from 1; DEVICE is the node ID or its name; TIMEOUT T#0s uses the network SDO timeout.
Example: write(ENABLE := set, DEVICE := IO_Module, INDEX := 16#1017, SUBINDEX := 0, DATA := 1000); *)
FUNCTION_BLOCK SDO_WRITE4
VAR_INPUT
  NETWORK : USINT := 1;
  ENABLE : BOOL;
  DEVICE : USINT;
  INDEX : WORD;
  SUBINDEX : BYTE;
  DATA : DWORD;
  DATALENGTH : USINT;
  TIMEOUT : TIME;
END_VAR
VAR_OUTPUT
  CONFIRM : BOOL;
  BUSY : BOOL;
  ERROR : USINT;
  ERRORINFO : UDINT;
  ERRORTEXT : STRING;
END_VAR
VAR
  cop_prev : BOOL;
  cop_phase : USINT;
  cop_handle : ULINT;
  cop_net : USINT;
  cop_node : USINT;
  cop_index : WORD;
  cop_sub : BYTE;
  cop_timeout : UDINT;
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
// interface version 1 (core/src/drivers/plugins/native/canopen/plc_api.h in the runtime fork).
#ifndef CANOPEN_FB_SHARED_INCLUDED
#define CANOPEN_FB_SHARED_INCLUDED
#if defined(__linux__)
extern "C" void *dlopen(const char *file, int mode) noexcept(true);
extern "C" void *dlsym(void *handle, const char *name) noexcept(true);
extern "C" int dlclose(void *handle) noexcept(true);
#endif

namespace canopen_fb {

// A copy of the plugin's C interface, version 1; keep in step with plc_api.h.
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
  r_not_in_eds = 100  // the blocks' own: DATALENGTH 0 for an object the EDS does not list
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
};

// The loaded plugin's table, looked up on every call that needs it: the runtime loads the plugin
// again at each PLC start while this program stays loaded, so nothing is kept. Null with `why`
// set (r_not_run or r_version) when there is none.
inline const api_v1 *api(uint8_t &why) {
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
  if (t && t->size < sizeof(api_v1)) {
    why = r_version;
    return nullptr;
  }
  return t;
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
      else
        put(t, "no CANopen network runs");
      return 0;
    default:
      put(t, "internal error in the CANopen master");
      return 0;
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
  bool l_prev = cop_prev;
  uint8_t l_phase = cop_phase;
  canopen_fb::step l_step = canopen_fb::begin(ENABLE, l_prev, l_phase);
  cop_prev = l_prev;
  cop_phase = l_phase;
  if (l_step.cancel) canopen_fb::cancel(cop_handle);
  if (l_step.cancel || l_step.clear || l_step.start) {
    BUSY = false;
    CONFIRM = false;
    ERROR = 0;
    ERRORINFO = 0;
    ERRORTEXT = "";
    cop_handle = 0;
  }
  if (l_step.start) {
    canopen_fb::request l_req = {};
    l_req.network = NETWORK;
    l_req.node = DEVICE;
    l_req.kind = canopen_fb::k_write;
    l_req.index = INDEX;
    l_req.subindex = SUBINDEX;
    l_req.timeout_ms = canopen_fb::timeout_ms(TIMEOUT);
    canopen_fb::result l_res = {};
    canopen_fb::result l_bad = {};
    uint8_t l_payload[canopen_fb::max_data];
    (void)l_payload;
    uint32_t l_length = DATALENGTH;
    if (l_length == 0) {
      l_length = canopen_fb::eds_size(NETWORK, DEVICE, INDEX, SUBINDEX);
      if (l_length == 0) l_bad = canopen_fb::fail(canopen_fb::e_wrong_parameter, canopen_fb::r_not_in_eds, 0);
    } else if (l_length > 4) {
      l_bad = canopen_fb::fail(canopen_fb::e_wrong_parameter, canopen_fb::r_length, l_length);
    }
    canopen_fb::put_le(l_payload, DATA, 4);
    l_req.data = l_payload;
    l_req.length = l_length;
    cop_net = l_req.network;
    cop_node = l_req.node;
    cop_index = l_req.index;
    cop_sub = l_req.subindex;
    cop_timeout = l_req.timeout_ms;
    uint64_t l_handle = l_bad.error ? 0 : canopen_fb::start(l_req, l_res);
    if (l_handle) {
      cop_handle = l_handle;
      BUSY = true;
      cop_phase = canopen_fb::phase_busy;
    } else {
      cop_phase = canopen_fb::phase_ended;
      canopen_fb::show(ERROR, ERRORINFO, ERRORTEXT, canopen_fb::what_of(cop_net, cop_node, cop_index, cop_sub,
                       cop_timeout, 4), l_bad.error ? l_bad : l_res);
    }
  }
  if (cop_phase == canopen_fb::phase_busy) {
    canopen_fb::result l_res = {};
    uint8_t l_buf[canopen_fb::max_data + 1];
    int l_state = canopen_fb::poll(cop_handle, l_res, l_buf, canopen_fb::max_data);
    if (l_state != 0) {
      BUSY = false;
      cop_handle = 0;
      cop_phase = canopen_fb::phase_ended;
      if (l_state == 1 && l_res.length > 4u) {
        l_state = 2;
        l_res = canopen_fb::fail(canopen_fb::e_wrong_parameter, canopen_fb::r_too_large, l_res.length);
      }
      if (l_state == 1) {
        CONFIRM = true;
      } else {
        canopen_fb::show(ERROR, ERRORINFO, ERRORTEXT, canopen_fb::what_of(cop_net, cop_node, cop_index, cop_sub,
                         cop_timeout, 4), l_res);
      }
    }
  }
}
END_FUNCTION_BLOCK
