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
  /** 0x1011 sub-index restored before the configuration (1 all, 2 communication, 3 application, 4+ manufacturer); 0 for none. */
  restoreDefaults: number
  checkVendorId: boolean
  checkProductCode: boolean
  checkRevision: boolean
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

export interface CanopenConfig {
  network: CanopenNetworkSettings
  nodes: CanopenNode[]
  /** The nodes' device files by SHA-256 of their text, each once. */
  files?: Record<string, CanopenStoredFile>
}
