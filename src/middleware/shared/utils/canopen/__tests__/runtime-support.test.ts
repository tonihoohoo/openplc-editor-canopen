import { describeCanopenRuntimeMismatch } from '../runtime-support'

describe('describeCanopenRuntimeMismatch', () => {
  it('accepts a runtime that reads the project config version', () => {
    expect(
      describeCanopenRuntimeMismatch({
        configVersion: 1,
        runtimeConfigVersions: [1],
        runtimeVersion: 'v4.3.1-canopen.1',
      }),
    ).toBeNull()
  })

  it('accepts a runtime that reads several versions including the project one', () => {
    expect(
      describeCanopenRuntimeMismatch({ configVersion: 2, runtimeConfigVersions: [1, 2], runtimeVersion: null }),
    ).toBeNull()
  })

  it.each([null, undefined, []])('refuses a runtime without CANopen support (%p)', (versions) => {
    const reason = describeCanopenRuntimeMismatch({
      configVersion: 1,
      runtimeConfigVersions: versions,
      runtimeVersion: 'v4.3.1',
    })
    expect(reason).toContain('(v4.3.1) has no CANopen support')
    expect(reason).toContain('remove the CANopen device')
  })

  it('names both versions when the runtime reads another one', () => {
    const reason = describeCanopenRuntimeMismatch({
      configVersion: 1,
      runtimeConfigVersions: [2, 3],
      runtimeVersion: null,
    })
    expect(reason).toContain('The runtime on this device reads CANopen configuration version 2, 3')
    expect(reason).toContain('writes version 1')
  })
})
