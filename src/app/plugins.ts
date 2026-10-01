/**
 * Where the stage and overlay lane (T7) and the features lane (T8) plug into the app: each adds
 * one side-effect import of its module here, and the module registers its overlays, commands,
 * renderers, stage and key bindings (`./registry.ts`). The app imports this file once at start.
 *
 * Expected at integration:
 *   import './stage/index.ts';
 *   import './overlays/index.ts';
 *   import './features/index.ts';
 */
import './renderers.ts';
import './stage/index.ts';
import './overlays/index.ts';
import './features/index.ts';
