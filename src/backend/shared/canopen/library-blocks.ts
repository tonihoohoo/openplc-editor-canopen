/**
 * The C++ function blocks of the `canopen` library (CiA 405 names), as the editor stores a C++
 * block: a documentation comment, the ST header, then the C++ body with `setup()` and `loop()`.
 * Every body starts with the library's shared code (`resources/libraries/canopen/src/shared.inc`),
 * which its include guard keeps once per program.
 *
 * Pins and locals become `#define`s of their names in the grafted code, so the bodies name C++
 * locals in lower case with an `l_` prefix and the block locals start with `cop_`.
 */

export interface CanopenBlockSource {
  fileName: string
  source: string
}

const COMMON_OUTPUTS = `  CONFIRM : BOOL;
  BUSY : BOOL;
  ERROR : USINT;
  ERRORINFO : UDINT;
  ERRORTEXT : STRING;
`

const REQUEST_LOCALS = `  cop_prev : BOOL;
  cop_phase : USINT;
  cop_handle : ULINT;
  cop_net : USINT;
  cop_node : USINT;
  cop_index : WORD;
  cop_sub : BYTE;
  cop_timeout : UDINT;
`

interface RequestBlock {
  name: string
  doc: string
  /** VAR_INPUT lines after NETWORK and ENABLE. */
  inputs: string
  /** VAR_OUTPUT lines after the common outputs. */
  outputs: string
  inOuts: string
  kind: 'k_read' | 'k_write' | 'k_nmt'
  /** Bytes the block holds. */
  capacity: number
  /** Clears the block's data outputs. */
  clear: string
  /** Fills `l_req` (and `l_payload`), may set `l_bad` to a failure for bad inputs. */
  fill: string
  /** Reads `l_buf` (`l_res.length` bytes) into the outputs after success. */
  done: string
  /** Has the object pins DEVICE, INDEX, SUBINDEX and TIMEOUT. */
  sdo: boolean
}

function requestBlock(b: RequestBlock): string {
  const inputs = b.sdo
    ? `  NETWORK : USINT := 1;
  ENABLE : BOOL;
  DEVICE : USINT;
  INDEX : WORD;
  SUBINDEX : BYTE;
${b.inputs}  TIMEOUT : TIME;
`
    : `  NETWORK : USINT := 1;
  ENABLE : BOOL;
${b.inputs}`
  const inOuts = b.inOuts ? `VAR_IN_OUT\n${b.inOuts}END_VAR\n` : ''
  const object = b.sdo
    ? `    l_req.index = INDEX;
    l_req.subindex = SUBINDEX;
    l_req.timeout_ms = canopen_fb::timeout_ms(TIMEOUT);
`
    : ''
  return `(* ${b.doc} *)
FUNCTION_BLOCK ${b.name}
VAR_INPUT
${inputs}END_VAR
${inOuts}VAR_OUTPUT
${COMMON_OUTPUTS}${b.outputs}END_VAR
VAR
${REQUEST_LOCALS}END_VAR
@@SHARED@@
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
${indent(b.clear, 4)}  }
  if (l_step.start) {
    canopen_fb::request l_req = {};
    l_req.network = NETWORK;
    l_req.node = ${b.sdo || b.kind === 'k_nmt' ? 'DEVICE' : '0'};
    l_req.kind = canopen_fb::${b.kind};
${object}    canopen_fb::result l_res = {};
    canopen_fb::result l_bad = {};
    uint8_t l_payload[canopen_fb::max_data];
    (void)l_payload;
${indent(b.fill, 4)}    cop_net = l_req.network;
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
                       cop_timeout, ${b.capacity}), l_bad.error ? l_bad : l_res);
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
      if (l_state == 1 && l_res.length > ${b.capacity}u) {
        l_state = 2;
        l_res = canopen_fb::fail(canopen_fb::e_wrong_parameter, canopen_fb::r_too_large, l_res.length);
      }
      if (l_state == 1) {
        CONFIRM = true;
${indent(b.done, 8)}      } else {
        canopen_fb::show(ERROR, ERRORINFO, ERRORTEXT, canopen_fb::what_of(cop_net, cop_node, cop_index, cop_sub,
                         cop_timeout, ${b.capacity}), l_res);
      }
    }
  }
}
END_FUNCTION_BLOCK
`
}

function indent(code: string, spaces: number): string {
  if (!code.trim()) return ''
  const pad = ' '.repeat(spaces)
  return (
    code
      .trim()
      .split('\n')
      .map((line) => (line ? pad + line : line))
      .join('\n') + '\n'
  )
}

/** Blocks that answer in the same call while ENABLE is TRUE. */
interface StateBlock {
  name: string
  doc: string
  inputs: string
  outputs: string
  /** Sets `l_error` (a canopen_fb error) and the outputs; `l_node` names the node for the text. */
  read: string
}

function stateBlock(b: StateBlock): string {
  return `(* ${b.doc} *)
FUNCTION_BLOCK ${b.name}
VAR_INPUT
  NETWORK : USINT := 1;
  ENABLE : BOOL;
${b.inputs}END_VAR
VAR_OUTPUT
  CONFIRM : BOOL;
  ERROR : USINT;
  ERRORTEXT : STRING;
${b.outputs}END_VAR
VAR
  cop_last : USINT;
END_VAR
@@SHARED@@
void setup() {
}

void loop() {
  if (!ENABLE) {
    CONFIRM = false;
    ERROR = 0;
    if (cop_last != 0) ERRORTEXT = "";
    cop_last = 0;
    return;
  }
  uint8_t l_why = 0;
  const canopen_fb::api_v1 *l_api = canopen_fb::api(l_why);
  int l_error = canopen_fb::e_no_driver;
  uint8_t l_node = 0;
  if (l_api) {
${indent(b.read, 4)}  }
  CONFIRM = l_error == canopen_fb::e_no_error;
  ERROR = static_cast<uint8_t>(l_error);
  if (l_error != cop_last) {
    canopen_fb::result l_res = canopen_fb::fail(static_cast<uint8_t>(l_error), l_api ? 0 : l_why, 0);
    canopen_fb::text l_text;
    canopen_fb::clear(l_text);
    if (l_error != canopen_fb::e_no_error)
      canopen_fb::describe(l_text, canopen_fb::what_of(NETWORK, l_node, 0, 0, 0, 0), l_res);
    ERRORTEXT = l_text.buf;
    cop_last = static_cast<uint8_t>(l_error);
  }
}
END_FUNCTION_BLOCK
`
}

function emcyBlock(name: string, doc: string, byNode: boolean): string {
  return `(* ${doc} *)
FUNCTION_BLOCK ${name}
VAR_INPUT
  NETWORK : USINT := 1;
  ENABLE : BOOL;
${byNode ? '  DEVICE : USINT;\n' : ''}END_VAR
VAR_OUTPUT
  CONFIRM : BOOL;
  ERROR : USINT;
  ERRORTEXT : STRING;
${byNode ? '' : '  DEVICE : USINT;\n'}  EMCY : EMCY_ERROR;
END_VAR
VAR
  cop_started : BOOL;
  cop_cursor : ULINT;
  cop_net : USINT;
  cop_last : USINT;
END_VAR
@@SHARED@@
void setup() {
}

void loop() {
  CONFIRM = false;
  if (!ENABLE) {
    ERROR = 0;
    if (cop_last != 0) ERRORTEXT = "";
    cop_last = 0;
    return;
  }
  uint8_t l_why = 0;
  const canopen_fb::api_v1 *l_api = canopen_fb::api(l_why);
  int l_error = canopen_fb::e_no_driver;
  uint8_t l_net = NETWORK;
  uint8_t l_node = ${byNode ? 'DEVICE' : '0'};
  bool l_lost = false;
  uint32_t l_lost_count = 0;
  if (l_api) {
    uint64_t l_cursor = cop_cursor;
    l_error = canopen_fb::e_no_error;
    if (!cop_started || cop_net != l_net) {
      l_error = l_api->emcy_cursor(l_net, &l_cursor);
      if (l_error == canopen_fb::e_no_error) {
        cop_started = true;
        cop_net = l_net;
      }
    }
    if (l_error == canopen_fb::e_no_error) {
      canopen_fb::emcy l_msg = {};
      int l_got = l_api->emcy_next(l_net, l_node, &l_cursor, &l_msg);
      if (l_got < 0) {
        l_error = -l_got;
      } else if (l_got == 1) {
        CONFIRM = true;
${byNode ? '' : '        DEVICE = l_msg.node;\n'}        EMCY.ERRORCODE = l_msg.error_code;
        EMCY.ERRORREGISTER = l_msg.error_register;
        for (int l_i = 0; l_i < 5; ++l_i) EMCY.MANUFACTURERERROR[l_i] = l_msg.data[l_i];
        if (l_msg.lost) {
          l_lost = true;
          l_lost_count = l_msg.lost;
        }
      }
      cop_cursor = l_cursor;
    }
  }
  ERROR = static_cast<uint8_t>(l_error);
  if (l_lost) {
    canopen_fb::text l_text;
    canopen_fb::clear(l_text);
    canopen_fb::put_dec(l_text, l_lost_count);
    canopen_fb::put(l_text, " emergency messages were lost before this one");
    ERRORTEXT = l_text.buf;
    cop_last = 0xFF;
  } else if (l_error != cop_last && (l_error != canopen_fb::e_no_error || cop_last != 0xFF)) {
    canopen_fb::result l_res = canopen_fb::fail(static_cast<uint8_t>(l_error), l_api ? 0 : l_why, 0);
    canopen_fb::text l_text;
    canopen_fb::clear(l_text);
    if (l_error != canopen_fb::e_no_error)
      canopen_fb::describe(l_text, canopen_fb::what_of(l_net, l_node, 0, 0, 0, 0), l_res);
    ERRORTEXT = l_text.buf;
    cop_last = static_cast<uint8_t>(l_error);
  }
}
END_FUNCTION_BLOCK
`
}

const SDO_DOC_TAIL =
  'NETWORK counts from 1; DEVICE is the node ID or its name; TIMEOUT T#0s uses the network SDO timeout.'

/** The library's C++ blocks, without the shared code (`@@SHARED@@` marks where it goes). */
export function canopenBlockTemplates(): CanopenBlockSource[] {
  const blocks: Array<[string, string]> = [
    [
      'SDO_READ4',
      requestBlock({
        name: 'SDO_READ4',
        doc: `Reads an object of 1 to 4 bytes from a node by SDO. A rising edge of ENABLE starts the read; BUSY is TRUE until it ends, then CONFIRM (DATA holds the value, little-endian and zero-filled, DATALENGTH the byte count) or ERROR with ERRORTEXT stays until ENABLE goes FALSE. ${SDO_DOC_TAIL}
Example: read(ENABLE := start, DEVICE := IO_Module, INDEX := 16#1018, SUBINDEX := 1); IF read.CONFIRM THEN vendor := read.DATA; END_IF;`,
        inputs: '',
        outputs: '  DATA : DWORD;\n  DATALENGTH : USINT;\n',
        inOuts: '',
        kind: 'k_read',
        capacity: 4,
        clear: 'DATA = 0;\nDATALENGTH = 0;',
        fill: '',
        done: 'DATA = canopen_fb::get_le(l_buf, l_res.length);\nDATALENGTH = static_cast<uint8_t>(l_res.length);',
        sdo: true,
      }),
    ],
    [
      'SDO_WRITE4',
      requestBlock({
        name: 'SDO_WRITE4',
        doc: `Writes an object of 1 to 4 bytes of a node by SDO: the low DATALENGTH bytes of DATA, little-endian. DATALENGTH 0 takes the size from the node's EDS. A rising edge of ENABLE starts the write; then CONFIRM or ERROR with ERRORTEXT stays until ENABLE goes FALSE. ${SDO_DOC_TAIL}
Example: write(ENABLE := set, DEVICE := IO_Module, INDEX := 16#1017, SUBINDEX := 0, DATA := 1000);`,
        inputs: '  DATA : DWORD;\n  DATALENGTH : USINT;\n',
        outputs: '',
        inOuts: '',
        kind: 'k_write',
        capacity: 4,
        clear: '',
        fill: `uint32_t l_length = DATALENGTH;
if (l_length == 0) {
  l_length = canopen_fb::eds_size(NETWORK, DEVICE, INDEX, SUBINDEX);
  if (l_length == 0) l_bad = canopen_fb::fail(canopen_fb::e_wrong_parameter, canopen_fb::r_not_in_eds, 0);
} else if (l_length > 4) {
  l_bad = canopen_fb::fail(canopen_fb::e_wrong_parameter, canopen_fb::r_length, l_length);
}
canopen_fb::put_le(l_payload, DATA, 4);
l_req.data = l_payload;
l_req.length = l_length;`,
        done: '',
        sdo: true,
      }),
    ],
    [
      'SDO_READ_DATA',
      requestBlock({
        name: 'SDO_READ_DATA',
        doc: `Reads an object of up to 256 bytes from a node by SDO into the byte array DATA; DATALENGTH gives the bytes received. Handshake as SDO_READ4. ${SDO_DOC_TAIL}
Example: read(ENABLE := start, DEVICE := IO_Module, INDEX := 16#1008, SUBINDEX := 0, DATA := bytes);`,
        inputs: '',
        outputs: '  DATALENGTH : UINT;\n',
        inOuts: '  DATA : ARRAY[0..255] OF BYTE;\n',
        kind: 'k_read',
        capacity: 256,
        clear: 'DATALENGTH = 0;',
        fill: '',
        done: `for (uint32_t l_i = 0; l_i < l_res.length; ++l_i) DATA[l_i] = l_buf[l_i];
DATALENGTH = static_cast<uint16_t>(l_res.length);`,
        sdo: true,
      }),
    ],
    [
      'SDO_WRITE_DATA',
      requestBlock({
        name: 'SDO_WRITE_DATA',
        doc: `Writes the first DATALENGTH bytes (1 to 256) of the byte array DATA to an object of a node by SDO. Handshake as SDO_WRITE4. ${SDO_DOC_TAIL}
Example: write(ENABLE := set, DEVICE := IO_Module, INDEX := 16#2000, SUBINDEX := 0, DATALENGTH := 6, DATA := bytes);`,
        inputs: '  DATALENGTH : UINT;\n',
        outputs: '',
        inOuts: '  DATA : ARRAY[0..255] OF BYTE;\n',
        kind: 'k_write',
        capacity: 256,
        clear: '',
        fill: `uint32_t l_length = DATALENGTH;
if (l_length == 0 || l_length > canopen_fb::max_data) {
  l_bad = canopen_fb::fail(canopen_fb::e_wrong_parameter, canopen_fb::r_length, l_length);
  l_length = 0;
}
for (uint32_t l_i = 0; l_i < l_length; ++l_i) l_payload[l_i] = DATA[l_i];
l_req.data = l_payload;
l_req.length = l_length;`,
        done: '',
        sdo: true,
      }),
    ],
    [
      'SDO_READ_STRING',
      requestBlock({
        name: 'SDO_READ_STRING',
        doc: `Reads a text object (VISIBLE_STRING) of up to 254 characters from a node by SDO into DATA. Handshake as SDO_READ4. ${SDO_DOC_TAIL}
Example: read(ENABLE := start, DEVICE := IO_Module, INDEX := 16#1008, SUBINDEX := 0); IF read.CONFIRM THEN name := read.DATA; END_IF;`,
        inputs: '',
        outputs: '  DATA : STRING;\n',
        inOuts: '',
        kind: 'k_read',
        capacity: 254,
        clear: 'DATA = "";',
        fill: '',
        done: `l_buf[l_res.length] = 0;
DATA = reinterpret_cast<const char *>(l_buf);`,
        sdo: true,
      }),
    ],
    [
      'SDO_WRITE_STRING',
      requestBlock({
        name: 'SDO_WRITE_STRING',
        doc: `Writes the text DATA (1 to 254 characters) to a text object of a node by SDO. Handshake as SDO_WRITE4. ${SDO_DOC_TAIL}
Example: write(ENABLE := set, DEVICE := IO_Module, INDEX := 16#2010, SUBINDEX := 0, DATA := 'line 1');`,
        inputs: '  DATA : STRING;\n',
        outputs: '',
        inOuts: '',
        kind: 'k_write',
        capacity: 254,
        clear: '',
        fill: `const char *l_text = DATA.c_str();
uint32_t l_length = 0;
while (l_text[l_length] && l_length < 254) {
  l_payload[l_length] = static_cast<uint8_t>(l_text[l_length]);
  ++l_length;
}
if (l_length == 0) l_bad = canopen_fb::fail(canopen_fb::e_wrong_parameter, canopen_fb::r_length, 0);
l_req.data = l_payload;
l_req.length = l_length;`,
        done: '',
        sdo: true,
      }),
    ],
    [
      'NMT',
      requestBlock({
        name: 'NMT',
        doc: `Sends an NMT command to a node, or with DEVICE 0 to every node of the network: STATE is START_REMOTE_NODE, STOP_REMOTE_NODE, ENTER_PRE_OPERATIONAL, RESET_NODE or RESET_COMMUNICATION. A node stopped or set pre-operational this way is not a node loss; a start returns it to operational. A rising edge of ENABLE sends it; CONFIRM once sent. TIMEOUT is not used (NMT has no answer).
Example: nmt(ENABLE := restart, DEVICE := IO_Module, STATE := START_REMOTE_NODE);`,
        inputs: '  DEVICE : USINT;\n  STATE : USINT;\n  TIMEOUT : TIME;\n',
        outputs: '',
        inOuts: '',
        kind: 'k_nmt',
        capacity: 0,
        clear: '',
        fill: `switch (static_cast<uint8_t>(STATE)) {
  case 0: l_req.command = 1; break;
  case 1: l_req.command = 2; break;
  case 2: l_req.command = 0x80; break;
  case 3: l_req.command = 0x81; break;
  case 4: l_req.command = 0x82; break;
  default: l_bad = canopen_fb::fail(canopen_fb::e_wrong_parameter, canopen_fb::r_command, STATE); break;
}`,
        done: '',
        sdo: false,
      }),
    ],
    [
      'GET_STATE',
      stateBlock({
        name: 'GET_STATE',
        doc: `Gives a node's NMT state as the master sees it, in the same call while ENABLE is TRUE: INIT, PRE_OPERATIONAL, STOPPED, OPERATIONAL, UNKNOWN or NOT_AVAIL (not answering). NETWORK counts from 1; DEVICE is the node ID or its name.
Example: state(ENABLE := TRUE, DEVICE := IO_Module); IF state.STATE = STOPPED THEN ... END_IF;`,
        inputs: '  DEVICE : USINT;\n',
        outputs: '  STATE : USINT;\n',
        read: `uint8_t l_state = 0;
l_node = DEVICE;
l_error = l_api->node_state(NETWORK, l_node, &l_state);
if (l_error == canopen_fb::e_no_error) STATE = l_state;`,
      }),
    ],
    [
      'GET_LOCAL_NODE_ID',
      stateBlock({
        name: 'GET_LOCAL_NODE_ID',
        doc: `Gives the master's own node ID on the network, in the same call while ENABLE is TRUE. NETWORK counts from 1.
Example: local(ENABLE := TRUE); id := local.NODEID;`,
        inputs: '',
        outputs: '  NODEID : USINT;\n',
        read: `uint8_t l_id = 0;
l_error = l_api->local_node_id(NETWORK, &l_id);
if (l_error == canopen_fb::e_no_error) NODEID = l_id;`,
      }),
    ],
    [
      'GET_CANOPEN_KERNEL_STATE',
      stateBlock({
        name: 'GET_CANOPEN_KERNEL_STATE',
        doc: `Gives the network's bus state, in the same call while ENABLE is TRUE: CANOPEN_KERNEL_NO_ERROR, CANOPEN_KERNEL_ERROR_PASSIVE, CANOPEN_KERNEL_BUS_OFF or CANOPEN_KERNEL_NO_DRIVER (link down or missing). NETWORK counts from 1.
Example: kernel(ENABLE := TRUE); bus_ok := kernel.STATE = CANOPEN_KERNEL_NO_ERROR;`,
        inputs: '',
        outputs: '  STATE : USINT;\n',
        read: `uint8_t l_state = 0;
l_error = l_api->kernel_state(NETWORK, &l_state);
if (l_error == canopen_fb::e_no_error) STATE = l_state;`,
      }),
    ],
    [
      'RECV_EMCY',
      emcyBlock(
        'RECV_EMCY',
        `Returns the network's emergency messages one per call while ENABLE is TRUE, oldest first: CONFIRM is TRUE in a call that returns one, with the sender in DEVICE and the message in EMCY. Messages from before the instance's first call are skipped; each instance has its own position. NETWORK counts from 1.
Example: emcy(ENABLE := TRUE); IF emcy.CONFIRM THEN last_code := emcy.EMCY.ERRORCODE; END_IF;`,
        false,
      ),
    ],
    [
      'RECV_EMCY_DEV',
      emcyBlock(
        'RECV_EMCY_DEV',
        `Returns one node's emergency messages one per call while ENABLE is TRUE, oldest first: CONFIRM is TRUE in a call that returns one, with the message in EMCY. Messages from before the instance's first call are skipped; each instance has its own position. NETWORK counts from 1; DEVICE is the node ID or its name.
Example: emcy(ENABLE := TRUE, DEVICE := IO_Module); IF emcy.CONFIRM AND emcy.EMCY.ERRORCODE <> 0 THEN alarm := TRUE; END_IF;`,
        true,
      ),
    ],
  ]
  return blocks.map(([name, source]) => ({ fileName: `${name}.cpp`, source }))
}

/** The blocks with the shared code in place. */
export function generateCanopenBlocks(sharedCode: string): CanopenBlockSource[] {
  const shared = sharedCode.endsWith('\n') ? sharedCode : `${sharedCode}\n`
  return canopenBlockTemplates().map((block) => ({
    fileName: block.fileName,
    source: block.source.replace('@@SHARED@@\n', shared),
  }))
}
