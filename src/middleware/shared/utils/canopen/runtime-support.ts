/**
 * Upload check for CANopen projects: the target runtime must report CANopen support for the
 * project's `canopen.json` format version at `GET /api/capabilities`. A runtime without it would
 * accept the upload and silently ignore the CANopen configuration.
 */

export interface CanopenRuntimeSupportArgs {
  /** Format version of the `canopen.json` the project uploads. */
  configVersion: number
  /** Versions the runtime accepts, or null when it reports no CANopen support. */
  runtimeConfigVersions: readonly number[] | null | undefined
  /** The runtime's reported version, for the message. */
  runtimeVersion: string | null
}

/** Why the upload is refused, or null when the runtime accepts the project's CANopen config. */
export function describeCanopenRuntimeMismatch(args: CanopenRuntimeSupportArgs): string | null {
  const runtime = args.runtimeVersion
    ? `The runtime on this device (${args.runtimeVersion})`
    : 'The runtime on this device'
  const accepted = args.runtimeConfigVersions ?? []
  if (accepted.length === 0) {
    return (
      `${runtime} has no CANopen support, so it would ignore this project's CANopen configuration. ` +
      'Install a runtime with the CANopen plugin, or remove the CANopen device from the project.'
    )
  }
  if (!accepted.includes(args.configVersion)) {
    return (
      `${runtime} reads CANopen configuration version ${accepted.join(', ')}, but this project ` +
      `writes version ${args.configVersion}. Update the runtime or the editor so that they match.`
    )
  }
  return null
}
