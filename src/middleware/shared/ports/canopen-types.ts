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
  /** Bit rates (bit/s) the EDS marks as not supported (`BaudRate_x=0`). */
  unsupportedBitrates?: number[]
  objects: CanopenObject[]
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
  enabled: boolean
  /** The EDS marks the mapping read-only: the master does not rewrite it. */
  fixedMapping: boolean
  transmissionType: number
  /** TPDO only, in milliseconds; 0 for none. */
  eventTimerMs: number
  /** TPDO only, in units of 100 microseconds; 0 for none. */
  inhibitTime: number
  entries: CanopenEntry[]
}

export interface CanopenSdo {
  id: string
  index: number
  subIndex: number
  dataType: CanopenDataType
  /** Decimal or 0x hexadecimal for integers, decimal for reals, 0/1 or true/false for BOOLEAN. */
  value: string
}

export type CanopenSupervision = 'none' | 'heartbeat'
export type CanopenOnLoss = 'hold' | 'zero'

export interface CanopenNode {
  id: string
  name: string
  nodeId: number
  eds: CanopenEdsInfo
  checkVendorId: boolean
  checkProductCode: boolean
  checkRevision: boolean
  supervision: CanopenSupervision
  /** The master's heartbeat consumer time for this node. */
  heartbeatConsumerMs: number
  /** Written to the node's 0x1017 when it is configured. */
  heartbeatProducerMs: number
  onLoss: CanopenOnLoss
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

export interface CanopenNetworkSettings {
  interface: string
  /** Bit/s. */
  bitrate: number
  masterNodeId: number
  syncMode: CanopenSyncMode
  syncPeriodUs: number
  heartbeatProducerMs: number
  sdoTimeoutMs: number
  onPlcStop: CanopenOnPlcStop
}

export interface CanopenConfig {
  network: CanopenNetworkSettings
  nodes: CanopenNode[]
}
