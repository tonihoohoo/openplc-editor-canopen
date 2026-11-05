/**
 * CANopen device model: one network (a CAN interface the runtime's canopen plugin masters) and its
 * nodes, each built from an EDS file (CiA 306) imported into the project. The parsed EDS is kept
 * on the node, so a project opens on any machine without the original file.
 */

/** CiA 301 basic data types a PDO entry or a startup SDO can use. */
export type CanopenDataType =
  | 'BOOLEAN'
  | 'INTEGER8'
  | 'INTEGER16'
  | 'INTEGER32'
  | 'INTEGER64'
  | 'UNSIGNED8'
  | 'UNSIGNED16'
  | 'UNSIGNED32'
  | 'UNSIGNED64'
  | 'REAL32'
  | 'REAL64'

/** Types a startup SDO can write beyond the basic ones; never mapped into a PDO. */
export type CanopenByteType = 'VISIBLE_STRING' | 'OCTET_STRING' | 'DOMAIN'

/** The type of a startup SDO's object. */
export type CanopenSdoDataType = CanopenDataType | CanopenByteType

export type CanopenAccess = 'ro' | 'wo' | 'rw' | 'rwr' | 'rww' | 'const'

/** One sub-object of the node's object dictionary, as its EDS describes it. */
export interface CanopenObject {
  index: number
  subIndex: number
  name: string
  /** A `CanopenDataType` name, or the EDS's own DataType code (e.g. "0x0009") for other types. */
  dataType: string
  access: CanopenAccess
  pdoMapping: boolean
  defaultValue?: string
  /** Name of the array or record this sub-index belongs to. */
  parentName?: string
  /** EDS LowLimit and HighLimit, as written in the EDS. */
  lowLimit?: string
  highLimit?: string
  /** CiA 306 ObjFlags: bit 0 refuse write on download, bit 1 refuse read on scan. */
  objFlags?: number
  /** What an XDD/XDC (CiA 311) says about the object beyond its name; absent for EDS. */
  info?: CanopenObjectInfo
}

/** A raw value and what it means, or a bit and its name. */
export interface CanopenValueMeaning {
  value: string
  label: string
  /** Bit fields only: the field's width in bits when more than one; `value` is its lowest bit. */
  width?: number
}

/** CiA 311 parameter details of an object. Engineering value = (raw + offset) x multiplier. */
export interface CanopenObjectInfo {
  label?: string
  /** Label of the array or record a sub-object belongs to. */
  parentLabel?: string
  description?: string
  unit?: string
  multiplier?: number
  offset?: number
  min?: string
  max?: string
  values?: CanopenValueMeaning[]
  bits?: CanopenValueMeaning[]
  group?: string
}

/** File and product details an XDD/XDC gives beyond the EDS identity. */
export interface CanopenDeviceDetails {
  orderNumber?: string
  productText?: string
  fileVersion?: string
  fileCreationDate?: string
  fileModificationDate?: string
  languages?: string[]
  characteristics?: CanopenValueMeaning[]
}

/** What the editor keeps of a node's EDS. */
export interface CanopenEdsInfo {
  fileName: string
  vendorName: string
  productName: string
  deviceType: number
  vendorId: number
  productCode: number
  revision: number
  /** Number of receive and transmit PDOs the device supports. */
  rxPdoCount: number
  txPdoCount: number
  /** Dummy objects (0x0001-0x0007) the device lets a PDO map ([DummyUsage]); absent for none. */
  dummyUsage?: number[]
  /** Bit rates (bit/s) the EDS marks as not supported (`BaudRate_x=0`). */
  unsupportedBitrates?: number[]
  /** The device answers LSS (CiA 305): `LSS_Supported=1`, or `layerSettingServiceSlave` in an XDD. */
  lssSupported?: boolean
  objects: CanopenObject[]
  /** The stored file the description was read from (see `CanopenConfig.files`). */
  source?: CanopenDeviceSource
  details?: CanopenDeviceDetails
}

/** The device file a description comes from: its format, name and the SHA-256 of its text. */
export interface CanopenDeviceSource {
  format: 'eds' | 'dcf' | 'xdd' | 'xdc'
  fileName: string
  sha256: string
}

/** A device file kept in the project, so a DCF can be written from its exact text. */
export interface CanopenStoredFile {
  fileName: string
  text: string
}

/** A PDO entry bound to an IEC location; also the node's state channel (`channelId` "state"). */
export interface CanopenEntry {
  /** Stable id of the entry within its node; the address registry keys on it. */
  channelId: string
  index: number
  subIndex: number
  name: string
  dataType: CanopenDataType
  iecLocation: string
  alias?: string
}

export interface CanopenPdo {
  /** PDO number on the node, from 1. */
  number: number
  /** 11-bit COB-ID. */
  cobId: number
  /** The COB-ID moves with the node ID (node ID plus a base). */
  followsNodeId: boolean
  /** The master exchanges the PDO with the PLC image; off for a PDO between two nodes. */
  exchanged: boolean
  /** The EDS marks the mapping read-only: the master does not rewrite it. */
  fixedMapping: boolean
  transmissionType: number
  /** TPDO only, in milliseconds; 0 for none. */
  eventTimerMs: number
  /** TPDO only, in units of 100 microseconds; 0 for none. */
  inhibitTime: number
  /** TPDO only: the master reports the PDO late after this many milliseconds without it; 0 for none. */
  receiveTimeoutMs: number
  /** RPDO only: the node's deadline (its 0x1400 + n sub 5) in milliseconds; 0 for none. */
  deadlineMs: number
  /** In mapping order; a gap is a dummy entry (index 0x0001-0x0007) without an address. */
  entries: CanopenEntry[]
}

/** What the boot does when the node refuses a startup SDO. */
export type CanopenSdoOnAbort = 'stop' | 'continue' | 'jump'

export interface CanopenSdo {
  id: string
  index: number
  subIndex: number
  dataType: CanopenSdoDataType
  /**
   * Decimal or 0x hexadecimal for integers, decimal or a 0x bit pattern for reals, 0/1 or
   * true/false for BOOLEAN, text for VISIBLE_STRING, hexadecimal bytes for OCTET_STRING and DOMAIN.
   */
  value: string
  /** Default 'stop'. */
  onAbort?: CanopenSdoOnAbort
  /** With onAbort 'jump': the id of a later startup SDO of the node. */
  jumpTo?: string
}

export type CanopenSupervision = 'none' | 'heartbeat' | 'guarding'
export type CanopenOnLoss = 'hold' | 'zero'
/** What a node does when it misses the master's heartbeat (its 0x1029:1, CiA 301). */
export type CanopenOnCommError = 'pre_operational' | 'no_change' | 'stopped'

/** The node watches the master's heartbeat (its 0x1016), so it reacts when the master stops. */
export interface CanopenWatchMaster {
  enabled: boolean
  consumerMs: number
  onError: CanopenOnCommError
}

/** A heartbeat of another node of the network that this node watches (an entry of its 0x1016). */
export interface CanopenHeartbeatConsumer {
  id: string
  producerNodeId: number
  consumerMs: number
}

/**
 * How the device gets its node ID. With `enabled`, the master finds it by its LSS address (vendor ID
 * and product code from the device file, `serialNumber`, `revision`; 0 for any) and gives it the node
 * ID at every start. The other fields are kept while `enabled` is off.
 */
export interface CanopenLss {
  enabled: boolean
  /** 0x1018:04 of the device; null until entered. */
  serialNumber: number | null
  /** 0x1018:03 to look for; 0 for any revision. */
  revision: number
  /** LSS store configuration after giving the ID, so the device keeps it at power-off. */
  store: boolean
}

/** The node's emergency messages: the COB-ID the master listens on (and the node's 0x1014). */
export interface CanopenEmcy {
  enabled: boolean
  cobId: number
}

export interface CanopenNode {
  id: string
  name: string
  nodeId: number
  eds: CanopenEdsInfo
  /** Absent is not an error. */
  optional: boolean
  /** false: no identity check, restore or configuration SDOs; the master only starts the node. */
  configure: boolean
  /** Who sends the NMT start after the boot: the master, or the PLC program (the node waits pre-operational). */
  start: 'master' | 'program'
  /** On at PLC start; the program can turn the node on and off while the PLC runs. */
  enabled: boolean
  /** 0x1011 sub-index restored before the configuration (1 all, 2 communication, 3 application, 4+ manufacturer); 0 for none. */
  restoreDefaults: number
  checkVendorId: boolean
  checkProductCode: boolean
  checkRevision: boolean
  /** Node ID given by the master over LSS; absent for a node ID set on the device. */
  lss?: CanopenLss
  supervision: CanopenSupervision
  /** The master's heartbeat consumer time for this node. */
  heartbeatConsumerMs: number
  /** Written to the node's 0x1017 when it is configured. */
  heartbeatProducerMs: number
  /** Node guarding: written to the node's 0x100C and 0x100D, and guarded by the master. */
  guardTimeMs: number
  lifeTimeFactor: number
  heartbeatConsumers: CanopenHeartbeatConsumer[]
  emcy: CanopenEmcy
  /** The node consumes the network's TIME object (its 0x1012). */
  receiveTime: boolean
  onLoss: CanopenOnLoss
  watchMaster: CanopenWatchMaster
  /** %IB channel reading the node's NMT state, 0 while it is not up. */
  state: CanopenEntry
  /** The node's transmit PDOs: inputs of the PLC. */
  tpdos: CanopenPdo[]
  /** The node's receive PDOs: outputs of the PLC. */
  rpdos: CanopenPdo[]
  sdos: CanopenSdo[]
}

export type CanopenSyncMode = 'none' | 'period' | 'plc_cycle'
export type CanopenOnPlcStop = 'pre_operational' | 'stopped' | 'none'
export type CanopenOnNodeError = 'restart' | 'stop'
/** `auto`: heartbeat when the EDS has a writable 0x1017, else node guarding when it has 0x100C and 0x100D, else none. */
export type CanopenDefaultSupervision = 'auto' | CanopenSupervision

/** The TIME object the master produces. */
export interface CanopenTimeProducer {
  enabled: boolean
  cobId: number
  periodMs: number
}

/** Settings given to nodes when they are added. */
export interface CanopenNewNodeDefaults {
  /** The master's heartbeat timeout as a percentage of the node's producer time. */
  heartbeatTimeoutPercent: number
  supervision: CanopenDefaultSupervision
  emcy: boolean
}

export interface CanopenNetworkSettings {
  /** Off: the network is left out of conf/canopen.json; nodes, mappings and addresses are kept. */
  enabled: boolean
  interface: string
  /** Bit/s. */
  bitrate: number
  masterNodeId: number
  syncMode: CanopenSyncMode
  syncPeriodUs: number
  heartbeatProducerMs: number
  sdoTimeoutMs: number
  onPlcStop: CanopenOnPlcStop
  /** SCHED_FIFO priority of the network's bus thread on the runtime. */
  priority: number
  /** A mandatory node not booted this long after the start is reported as not answering. */
  bootTimeoutMs: number
  onNodeError: CanopenOnNodeError
  /** Synchronous window length in microseconds, written to the nodes' 0x1007; 0 for none. */
  syncWindowUs: number
  time: CanopenTimeProducer
  newNodeDefaults: CanopenNewNodeDefaults
}

/** A section of the HTML documentation export. */
export type CanopenHtmlSection =
  | 'network'
  | 'nodes'
  | 'canIds'
  | 'ioList'
  | 'pdoPictures'
  | 'sdos'
  | 'bootWrites'
  | 'objects'
  | 'plcVariables'

/** The HTML export's choices; a section without a stored choice is in, except the object dictionaries. */
export interface CanopenHtmlExportOptions {
  sections?: Partial<Record<CanopenHtmlSection, boolean>>
}

/** What a DBC export holds: frame types, and the objects whose SDO values it decodes. */
export interface CanopenDbcExportOptions {
  pdo: boolean
  nmt: boolean
  sync: boolean
  time: boolean
  heartbeat: boolean
  emcy: boolean
  sdo: boolean
  /** `all`: every object of the device files; `configured`: startup SDO and mapped objects only. */
  sdoValues: 'all' | 'configured'
}

/** Export choices kept in the project; not part of `conf/canopen.json`. */
export interface CanopenExportOptions {
  dbc?: CanopenDbcExportOptions
  html?: CanopenHtmlExportOptions
}

export interface CanopenConfig {
  network: CanopenNetworkSettings
  nodes: CanopenNode[]
  /** The nodes' device files by SHA-256 of their text, each once. */
  files?: Record<string, CanopenStoredFile>
  export?: CanopenExportOptions
}

// ---- CANopen slave (a server: the runtime as a node on another master's bus) ----

/** Who writes the object: the master (the slave's PLC reads it from %I) or the slave's PLC (%Q). */
export type CanopenSlaveDirection = 'from_master' | 'to_master'

/** How the master reaches the object: mapped into a PDO, by SDO only, or a fixed value. */
export type CanopenSlaveExchange = 'pdo' | 'sdo' | 'constant'

/** Types of a slave object: the numeric basic types, and a text that is always a constant. */
export type CanopenSlaveDataType = Exclude<CanopenDataType, 'BOOLEAN'> | 'VISIBLE_STRING'

/** One application object of the slave, in 0x2000-0x5FFF. */
export interface CanopenSlaveObject {
  /** Stable identity of the row; the address registry keys the row's channel with it. */
  id: string
  index: number
  subIndex: number
  name: string
  dataType: CanopenSlaveDataType
  direction: CanopenSlaveDirection
  exchange: CanopenSlaveExchange
  /** %I (from the master) or %Q (to the master) of the object's size; empty for a constant. */
  iecLocation: string
  alias?: string
  /** Value at PLC start, decimal (or 0x hex) for numbers, the text for a VISIBLE_STRING constant. */
  defaultValue: string
  /** Range a master's write must keep; numeric objects from the master only. */
  min?: string
  max?: string
  /** An UNSIGNED8 packed as 8 BOOLs: one entry per bit, bit 0 first; `iecLocation` is then empty. */
  bits?: CanopenSlaveBit[]
  /** Details only the XDD holds (CiA 311 parameter); none of them reach the runtime. */
  description?: string
  /** Numeric objects only. Engineering value = (raw + offset) x multiplier. */
  unit?: string
  multiplier?: number
  offset?: number
  /** Integer objects only: raw values and what they mean. */
  values?: CanopenValueMeaning[]
  group?: string
}

/** One bit of a packed slave object: its own %IX (from the master) or %QX (to the master) address. */
export interface CanopenSlaveBit {
  name: string
  iecLocation: string
  alias?: string
}

/** Sending settings of one TPDO; its mapping and COB-ID follow from the objects and the node ID. */
export interface CanopenSlaveTpdoSettings {
  /** 254/255 on change, 1-240 every N SYNC. */
  transmissionType: number
  /** Inhibit time in 100 µs. */
  inhibitTime: number
  eventTimerMs: number
}

export type CanopenSlaveOnMasterLost = 'pre_operational' | 'no_change' | 'stopped'

export type CanopenSlaveOnPlcStop = 'hold' | 'zero'

/** CiA 305 LSS slave settings. */
export interface CanopenSlaveLss {
  enabled: boolean
  /** Starts with no node ID and stays silent apart from LSS until a master gives it one. */
  waitForMaster: boolean
  /** 0x1018 sub 4, the last part of the LSS address; null for one made once on the runtime device. */
  serial: number | null
  /** A master may configure and store a new bit rate, used from the slave's next start. */
  bitrateChange: boolean
}

/** The slave's own NMT state on a PLC stop (0x1029 sub 2). */
export type CanopenSlaveOnPlcStopState = 'none' | 'pre_operational' | 'stopped'

export interface CanopenSlaveConfig {
  /** Off: left out of conf/canopen.json; objects and addresses are kept. */
  enabled: boolean
  interface: string
  bitrate: number
  nodeId: number
  priority: number
  /** 0x1008, 0x100A and 0x1018 sub 1-3; the vendor name only goes in the device file. */
  vendorName: string
  deviceName: string
  softwareVersion: string
  vendorId: number
  productCode: number
  revision: number
  heartbeatMs: number
  /** Heartbeat consumer for the master's heartbeat (0x1016); `timeMs` 0 for none. */
  masterWatch: { nodeId: number; timeMs: number }
  onMasterLost: CanopenSlaveOnMasterLost
  onPlcStop: CanopenSlaveOnPlcStop
  onPlcStopState: CanopenSlaveOnPlcStopState
  /** Goes operational by itself after its boot-up, without the master's NMT start. */
  startAlone: boolean
  /** Absent in projects made before LSS: LSS off. */
  lss?: CanopenSlaveLss
  objects: CanopenSlaveObject[]
  /** TPDO 1-4 sending settings, by PDO number - 1. */
  tpdos: CanopenSlaveTpdoSettings[]
  /** Device file details; the XDD holds them all, the EDS the order number and 0x1009. */
  productText?: string
  /** The device name when empty. */
  orderNumber?: string
  /** 0x1009, printable ASCII; empty for none. */
  hardwareVersion?: string
  /** Name (`value`) and value (`label`) pairs, written as XDD characteristics. */
  characteristics?: CanopenValueMeaning[]
  /** The revision and data layout of the last device file exported; suggests the next revision. */
  lastExport?: { revision: number; layout: string }
}
