import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.hikarimoon.skintrace',
  appName: 'Skin Trace',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
