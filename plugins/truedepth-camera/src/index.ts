import { registerPlugin } from '@capacitor/core';
import type { TrueDepthCameraPlugin } from './definitions';

const TrueDepthCamera = registerPlugin<TrueDepthCameraPlugin>(
  'TrueDepthCamera',
  {
    web: () => import('./web').then((m) => new m.TrueDepthCameraWeb()),
  }
);

export * from './definitions';
export { TrueDepthCamera };
