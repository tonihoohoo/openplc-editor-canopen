import type { CanopenSlaveLiveStatus } from '@root/frontend/hooks/use-canopen-status'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenSlaveStatus } from '@root/middleware/shared/ports/canopen-status'
import type { CanopenSlaveConfig } from '@root/middleware/shared/ports/canopen-types'
import {
  ageText,
  emcyText,
  errorRegisterBits,
  expectedSlavePdos,
  hex,
  mappingText,
  noticeHidesLiveData,
  type NoticeTone,
  objectRef,
  onMasterLostText,
  pdoName,
  type SlaveChange,
  slaveChanges,
  slaveDefaultText,
  slaveEventText,
  slaveEventTone,
  slaveNmtByText,
  slaveNotice,
  slaveNoticeText,
  slaveStateLabel,
  slaveValueText,
  transmissionText,
  type ValueDisplay,
} from '@root/middleware/shared/utils/canopen'
import { type ReactNode, useMemo, useState } from 'react'

import { StatusDot } from '../../device/canopen/status-view'
import { cardClassName, headingClassName, hintClassName, inputClassName } from '../../device/canopen/styles'

const NOTICE_CLASSES: Record<NoticeTone, string> = {
  info: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
  warning: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  error: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300',
}

const EVENT_CLASSES: Record<NoticeTone, string> = {
  info: 'text-neutral-850 dark:text-neutral-200',
  warning: 'text-amber-700 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
}

const localTime = (ms: number): string => new Date(ms).toLocaleTimeString()

const Changed = ({ change }: { change: SlaveChange | undefined }) =>
  change ? <span className='ml-1 text-[10px] text-amber-700 dark:text-amber-400'>project {change.project}</span> : null

const mark = (change: SlaveChange | undefined): string =>
  change ? 'rounded bg-amber-100 px-1 dark:bg-amber-900/40' : ''

const Fact = ({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) => (
  <div className='min-w-0'>
    <p className='text-[11px] text-neutral-500 dark:text-neutral-400'>{label}</p>
    <div className='mt-0.5 text-sm font-semibold text-neutral-1000 dark:text-neutral-100'>{value}</div>
    <div className='mt-0.5 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400'>{children}</div>
  </div>
)

const stateDot = (slave: CanopenSlaveStatus) => {
  if (slave.state === 'operational') return 'green' as const
  if (slave.state === 'pre_operational' || slave.state === 'boot_up') return 'amber' as const
  if (slave.state === 'stopped' || slave.state === 'offline') return 'red' as const
  return 'grey' as const
}

const StateStrip = ({
  slave,
  now,
  changes,
}: {
  slave: CanopenSlaveStatus
  now: number
  changes: Map<string, SlaveChange>
}) => {
  const age = (t: number | undefined) => (now > 0 && t !== undefined && t > 0 ? ageText(now - t) : null)
  const since = slave.since !== undefined && slave.since > 0 ? ` at ${localTime(slave.since)}` : ''
  const watch = slave.master_watch_ms ?? 0
  const masterAge = age(slave.master_last_seen)
  const active = slave.emcy_active ?? []
  const register = slave.error_register ?? 0
  const bits = errorRegisterBits(register)
  const heartbeat = changes.get('heartbeat')
  const plcSince = slave.events?.find((e) => e.kind === 'plc')?.time
  const watchChange = changes.get('master_watch')
  const lostChange = changes.get('on_master_lost')
  return (
    <div className={cardClassName} data-testid='canopen-slave-online-state'>
      <h4 className={headingClassName}>State</h4>
      <div className='grid grid-cols-2 gap-4 lg:grid-cols-4'>
        <Fact
          label='NMT state'
          value={
            <span className='flex items-center gap-2'>
              <StatusDot dot={stateDot(slave)} title={slaveStateLabel(slave.state)} />
              {slaveStateLabel(slave.state)}
            </span>
          }
        >
          {slaveNmtByText(slave)}
          <span data-testid='canopen-slave-online-since'>{since}</span>
          <br />
          <span className={mark(heartbeat)}>Heartbeat sent every {slave.heartbeat_ms ?? 0} ms</span>
          <Changed change={heartbeat} />
        </Fact>
        <Fact
          label='Master heartbeat'
          value={
            watch === 0 || slave.master_node_id === undefined
              ? 'Not watched'
              : slave.master_seen
                ? `Seen${masterAge ? ` ${masterAge} ago` : ''}`
                : `Lost${masterAge ? ` ${masterAge} ago` : ''}`
          }
        >
          {slave.master_node_id !== undefined ? `Node ${slave.master_node_id}, ` : ''}
          <span className={mark(watchChange)}>allowed {watch} ms</span>
          <Changed change={watchChange} />
          <br />
          <span className={mark(lostChange)}>When lost: {onMasterLostText(slave.on_master_lost ?? 'other')}</span>
          <Changed change={lostChange} />
        </Fact>
        <Fact label='PLC' value={slave.plc_running ? 'Running' : 'Stopped'}>
          {slave.plc_running ? 'Values to the master follow the program' : 'The slave stays on the bus'}
          {plcSince !== undefined ? (
            <>
              <br />
              Since <span data-testid='canopen-slave-online-since'>{localTime(plcSince)}</span>
            </>
          ) : null}
        </Fact>
        <Fact label='Emergencies' value={active.length === 0 ? 'None active' : `${active.length} active`}>
          {active.map((c) => `${hex(c, 4)} ${emcyText(c).toLowerCase()}`).join(' · ')}
          {active.length > 0 ? <br /> : null}
          Error register {hex(register, 2)}
          {bits.length > 0 ? ` (${bits.join(', ')})` : ''}
          <br />
          {(slave.error_history ?? []).length} in the error history (0x1003)
        </Fact>
      </div>
    </div>
  )
}

const PdosInUse = ({
  slave,
  config,
  now,
  changes,
}: {
  slave: CanopenSlaveStatus
  config: CanopenSlaveConfig
  now: number
  changes: SlaveChange[]
}) => {
  const expected = expectedSlavePdos(config)
  const pdos = (slave.pdos ?? []).filter(
    (p) => p.valid || expected.some((e) => e.dir === p.dir && e.pdo === p.pdo && e.valid),
  )
  return (
    <div className={cardClassName} data-testid='canopen-slave-online-pdos'>
      <h4 className={headingClassName}>PDOs in use</h4>
      {pdos.length === 0 ? (
        <p className={hintClassName}>No PDO is in use.</p>
      ) : (
        <table className='w-full table-fixed text-left text-xs'>
          <colgroup>
            <col style={{ width: '10%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '35%' }} />
            <col style={{ width: '25%' }} />
          </colgroup>
          <thead className='text-neutral-500 dark:text-neutral-400'>
            <tr>
              <th className='py-1 pr-2 font-medium'>PDO</th>
              <th className='py-1 pr-2 font-medium'>COB-ID</th>
              <th className='py-1 pr-2 font-medium'>Sent as</th>
              <th className='py-1 pr-2 font-medium'>Mapped objects</th>
              <th className='py-1 font-medium'>Traffic</th>
            </tr>
          </thead>
          <tbody className='text-neutral-850 dark:text-neutral-200'>
            {pdos.map((p) => {
              const name = pdoName(p.dir, p.pdo)
              const own = changes.filter((c) => c.key === `${p.dir}${p.pdo}`)
              const changed = (what: string) => own.find((c) => c.label === `${name} ${what}`)
              const sentChange =
                changed('transmission') ?? changed('inhibit time') ?? changed('event timer') ?? changed('timeout')
              const mapChange = changed('mapping')
              const cobChange = changed('COB-ID')
              const usage = own.find((c) => c.label === name)
              const last = now > 0 && p.last !== undefined && p.last > 0 ? `, last ${ageText(now - p.last)} ago` : ''
              const verb = p.dir === 'rx' ? 'received' : 'sent'
              return (
                <tr
                  key={`${p.dir}${p.pdo}`}
                  data-testid={`canopen-slave-online-pdo-${p.dir}${p.pdo}`}
                  className='border-t border-neutral-100 align-top dark:border-neutral-800'
                >
                  <td className='py-1.5 pr-2 font-medium'>
                    {name}
                    {usage ? <Changed change={usage} /> : null}
                  </td>
                  <td className='py-1.5 pr-2 font-mono'>
                    <span className={mark(cobChange)}>{p.valid ? hex(p.cob_id, 3) : 'off'}</span>
                  </td>
                  <td className='py-1.5 pr-2'>
                    <span className={mark(sentChange)}>
                      {transmissionText(p.dir, p.transmission, p.inhibit_100us ?? 0, p.event_ms)}
                    </span>
                    {sentChange ? <span className={cn(hintClassName, 'block')}>changed by the master</span> : null}
                  </td>
                  <td className='py-1.5 pr-2'>
                    <span className={mark(mapChange)}>{mappingText(p.mapping, config)}</span>
                    {mapChange ? (
                      <span className={cn(hintClassName, 'block')}>
                        remapped by the master; project {mapChange.project}
                      </span>
                    ) : null}
                  </td>
                  <td className='py-1.5'>
                    {p.frames.toLocaleString('en-US').replace(/,/g, ' ')} {verb}
                    {last}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

const DIRECTION: Record<string, string> = { from_master: 'from master', to_master: 'to master' }
const EXCHANGE: Record<string, string> = { pdo: 'PDO', sdo: 'SDO only', constant: 'Constant' }

const Values = ({
  slave,
  config,
  changes,
}: {
  slave: CanopenSlaveStatus
  config: CanopenSlaveConfig
  changes: Map<string, SlaveChange>
}) => {
  const [display, setDisplay] = useState<ValueDisplay>('decimal')
  return (
    <div className={cardClassName} data-testid='canopen-slave-online-values'>
      <div className='mb-3 flex items-center gap-3'>
        <h4 className={cn(headingClassName, 'mb-0')}>Values</h4>
        <span className={hintClassName}>Read from the runtime once a second</span>
        <select
          aria-label='Number display'
          className={cn(inputClassName, 'ml-auto w-[90px]')}
          value={display}
          onChange={(e) => setDisplay(e.target.value === 'hex' ? 'hex' : 'decimal')}
        >
          <option value='decimal'>Decimal</option>
          <option value='hex'>Hex</option>
        </select>
      </div>
      {config.objects.length === 0 ? (
        <p className={hintClassName}>The slave has no objects. Add them on the Data tab.</p>
      ) : (
        <table className='w-full table-fixed text-left text-xs'>
          <colgroup>
            <col style={{ width: '11%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '17%' }} />
          </colgroup>
          <thead className='text-neutral-500 dark:text-neutral-400'>
            <tr>
              <th className='py-1 pr-2 font-medium'>Object</th>
              <th className='py-1 pr-2 font-medium'>Name</th>
              <th className='py-1 pr-2 font-medium'>Direction</th>
              <th className='py-1 pr-2 font-medium'>Exchange</th>
              <th className='py-1 pr-2 font-medium'>Address</th>
              <th className='py-1 pr-2 font-medium'>Value</th>
              <th className='py-1 font-medium'>Project default</th>
            </tr>
          </thead>
          <tbody className='text-neutral-850 dark:text-neutral-200'>
            {config.objects.map((o) => {
              const ref = objectRef(o.index, o.subIndex)
              const change = changes.get(ref)
              return (
                <tr
                  key={o.id}
                  data-testid={`canopen-slave-online-value-${ref}`}
                  className='h-[30px] border-t border-neutral-100 dark:border-neutral-800'
                >
                  <td className='py-1 pr-2 font-mono'>{ref}</td>
                  <td className='truncate py-1 pr-2' title={o.name}>
                    {o.name}
                  </td>
                  <td className='py-1 pr-2'>{DIRECTION[o.direction]}</td>
                  <td className='py-1 pr-2'>{EXCHANGE[o.exchange]}</td>
                  <td className='truncate py-1 pr-2 font-mono'>
                    {o.exchange === 'constant' ? '-' : o.iecLocation}
                    {o.alias ? <span className='ml-1 font-sans text-neutral-500'>{o.alias}</span> : null}
                  </td>
                  <td className='truncate py-1 pr-2 font-mono' data-testid='canopen-slave-online-value'>
                    <span className={mark(change)}>{slaveValueText(o, slave, display)}</span>
                    {change ? (
                      <span className={cn(hintClassName, 'block font-sans')}>written by the master</span>
                    ) : null}
                  </td>
                  <td className='truncate py-1 font-mono text-neutral-500'>{slaveDefaultText(o, display)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

const Events = ({ slave, config }: { slave: CanopenSlaveStatus; config: CanopenSlaveConfig }) => {
  const events = slave.events ?? []
  return (
    <div className={cardClassName} data-testid='canopen-slave-online-events'>
      <h4 className={headingClassName}>Events</h4>
      {events.length === 0 ? (
        <p className={hintClassName}>No events yet.</p>
      ) : (
        <ul className='flex flex-col gap-1 text-xs'>
          {events.map((e, i) => (
            <li key={`${e.time}-${i}`} className='flex gap-3'>
              <span className='w-[80px] shrink-0 font-mono text-neutral-500' data-testid='canopen-slave-online-time'>
                {localTime(e.time)}
              </span>
              <span className={EVENT_CLASSES[slaveEventTone(e)]}>{slaveEventText(e, slave, config)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The slave's Online tab: the running slave as the runtime reports it, read once a second. It sends
 * nothing to the slave. Settings the master changed since the slave's start are marked.
 */
export const OnlineTab = ({
  config,
  live,
  lssSlot,
}: {
  config: CanopenSlaveConfig
  live: CanopenSlaveLiveStatus | null
  /** Cards shown under the state strip, such as the slave's LSS state. */
  lssSlot?: ReactNode
}) => {
  const slave = live?.slave ?? null
  const changeList = useMemo(() => (slave ? slaveChanges(config, slave) : []), [config, slave])
  const changes = useMemo(() => new Map(changeList.map((c) => [c.key, c])), [changeList])
  const notice = slaveNotice({
    config,
    connected: live !== null,
    answered: live?.answered ?? false,
    slave,
    changes: changeList.length,
  })
  const text = notice ? slaveNoticeText(notice, config) : null
  const now = live?.now ?? 0
  return (
    <div className={cn('flex flex-col gap-4', live?.stale && 'opacity-50')} data-testid='canopen-slave-online'>
      {live?.stale ? (
        <p role='status' className='text-xs text-amber-700 dark:text-amber-400'>
          Status unavailable: {live.error}. Showing the last status.
        </p>
      ) : null}
      {text ? (
        <div
          role='status'
          data-testid='canopen-slave-online-notice'
          data-notice={notice?.kind}
          className={cn('rounded-md border px-3 py-2 text-xs', NOTICE_CLASSES[text.tone])}
        >
          {text.text}
        </div>
      ) : null}
      {slave && !noticeHidesLiveData(notice) ? (
        <>
          <StateStrip slave={slave} now={now} changes={changes} />
          {lssSlot}
          <PdosInUse slave={slave} config={config} now={now} changes={changeList} />
          <Values slave={slave} config={config} changes={changes} />
          <Events slave={slave} config={config} />
        </>
      ) : null}
    </div>
  )
}
