/**
 * Shared setup for the CANopen UI tests: the generic I/O module EDS, a project with one empty
 * CANopen network, and opening that network's device editor.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from '@playwright/test'

import { PROJECT_NAME } from './ethercat-project'

export const EDS = join(
  __dirname,
  '..',
  '..',
  'src',
  'middleware',
  'shared',
  'utils',
  'canopen',
  '__tests__',
  'fixtures',
  'generic-io-module.eds',
)

export const EDS_TEXT = readFileSync(EDS, 'utf8')

/** One empty network, `canopen_1`, and a program that copies an input byte to an output byte. */
export const EMPTY_STATION = {
  bus: join('canopen-empty', 'canopen_1.json'),
  program:
    'PROGRAM main\n  VAR\n    inputs AT %IB1 : BYTE;\n    outputs AT %QB0 : BYTE;\n  END_VAR\n\noutputs := inputs;\n\nEND_PROGRAM\n',
}

/** Writes @p text as an EDS file at @p path and returns the path. */
export function writeEds(path: string, text: string): string {
  writeFileSync(path, text)
  return path
}

/** Adds objects to the EDS's optional object list, with their sections. */
export function withOptionalObjects(text: string, indices: number[], sections: string): string {
  return text.replace(/\[OptionalObjects\]\r?\nSupportedObjects=(\d+)\r?\n/, (_, n: string) => {
    const count = Number(n)
    const extra = indices.map((index, i) => `${count + i + 1}=0x${index.toString(16).toUpperCase()}\n`).join('')
    return `${sections.trim()}\n\n[OptionalObjects]\nSupportedObjects=${count + indices.length}\n${extra}`
  })
}

/** Sets the window size; below a desktop size the app shows its mobile notice. */
export async function windowSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await expect(async () => {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(size[0], size[1])),
      [width, height],
    )
  }).toPass({ timeout: 30000 })
}

/** Opens the project, runs @p connect if given (to log in to a runtime), and opens `canopen_1`. */
export async function openNetwork(page: Page, connect?: () => Promise<void>): Promise<void> {
  await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
  if (connect) await connect()
  await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
  await expect(page.getByLabel('CANopen editor container')).toBeVisible({ timeout: 30000 })
}

/** Adds a node from @p eds and waits for its page. */
export async function addNode(page: Page, eds: string, title: string): Promise<void> {
  await page.getByTestId('canopen-eds-input').setInputFiles(eds)
  await page.getByTestId('canopen-file-dialog-confirm').click()
  await expect(page.getByText(title)).toBeVisible({ timeout: 15000 })
}

/** Types @p value into the field labelled @p label and commits it with Enter. */
export async function setField(page: Page, label: string, value: string): Promise<void> {
  const field = page.getByLabel(label, { exact: true })
  await field.fill(value)
  await field.press('Enter')
}
