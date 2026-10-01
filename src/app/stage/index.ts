/**
 * The stage lane's plug-in: importing this registers Porch's one stage strip (plan T7) with the
 * app's registry. `src/app/plugins.ts` imports it at integration.
 */
import { registerStage } from '../registry.ts';
import { createStage } from './stage.ts';

export const stage = createStage();
registerStage(stage);
