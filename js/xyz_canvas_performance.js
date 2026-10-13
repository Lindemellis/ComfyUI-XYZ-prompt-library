import { app } from '../../scripts/app.js';
import { installCanvasColorCache } from './prompt_shared/canvas_performance.js';

app.registerExtension({
  name: 'XYZNodes.CanvasColorCache',
  setup() { installCanvasColorCache(app.canvas); },
});
