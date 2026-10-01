/**
 * Imported by `src/main.ts` before anything loads `@opentui/core` (ported from
 * `~/Code/loom/src/cockpit/ffi-warning.ts`): silences Node's `ExperimentalWarning: FFI is an
 * experimental feature` line, which importing OpenTUI's native library would print onto the
 * terminal Porch is about to take. ES modules evaluate their imports in order, which is what makes a
 * side-effect import the right tool.
 */
import { silenceFfiWarning } from './terminal.ts';

silenceFfiWarning();
