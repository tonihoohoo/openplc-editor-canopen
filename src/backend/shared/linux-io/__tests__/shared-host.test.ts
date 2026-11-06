import { execFileSync, spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

/** Builds `shared-host.cpp` against a temporary sysfs tree and runs it (skipped without a C++ compiler). */
const compiler = ['g++', 'clang++'].find((c) => spawnSync(c, ['--version']).status === 0)
const linux = process.platform === 'linux'

const describeHost = compiler && linux ? describe : describe.skip

describeHost('the linux_io shared code on the host', () => {
  let root = ''
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'linux-io-')))
    const put = (rel: string, text: string): void => {
      const path = join(root, 'sys', rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    put('class/thermal/thermal_zone0/temp', '48312\n')
    put('class/text', 'no digits here\n')
    put('bus/iio/devices/iio:device0/name', 'adc-test\n')
    put('bus/iio/devices/iio:device0/in_voltage0_raw', '1000\n')
    put('bus/iio/devices/iio:device0/in_voltage_scale', '2.0\n')
    put('bus/iio/devices/iio:device0/in_voltage1_raw', '5\n')
    put('bus/iio/devices/iio:device0/in_voltage1_scale', '0.5\n')
    put('bus/iio/devices/iio:device0/in_voltage_offset', '10\n')
    put('class/pwm/pwmchip0/export', '')
    put('class/pwm/pwmchip0/pwm0/period', '0')
    put('class/pwm/pwmchip0/pwm0/duty_cycle', '0')
    put('class/pwm/pwmchip0/pwm0/enable', '0')
    symlinkSync('/etc', join(root, 'sys', 'escape'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('reads values, IIO channels and drives PWM through sysfs', () => {
    const exe = join(root, 'shared-host')
    execFileSync(compiler ?? 'g++', [
      '-std=c++17',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-pthread',
      `-DLIO_SYS_ROOT="${join(root, 'sys')}"`,
      `-DLIO_DEV_ROOT="${join(root, 'dev')}"`,
      join(__dirname, 'shared-host.cpp'),
      '-o',
      exe,
    ])
    const run = spawnSync(exe, { encoding: 'utf8' })
    expect(run.stdout.trim()).toBe('ok')
    expect(run.status).toBe(0)
  })
})
