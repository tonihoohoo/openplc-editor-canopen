/**
 * Builds the `linux_io` function block library archive (`resources/libraries/linux_io.stlib`) from
 * its sources in `resources/libraries/linux_io/`. Pure: the caller reads and writes the files
 * (`scripts/build-linux-io-lib.ts`, and the unit test that checks the committed archive is current).
 */

import { buildBlockLibrary, type CanopenLibraryBuild, type CanopenLibraryInputs } from '../canopen/build-library'
import { generateLinuxIoBlocks } from './library-blocks'

export function buildLinuxIoLibrary(inputs: CanopenLibraryInputs): CanopenLibraryBuild {
  return buildBlockLibrary(inputs, generateLinuxIoBlocks(inputs.sharedCode))
}
