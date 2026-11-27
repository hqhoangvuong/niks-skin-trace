import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  IOS_DEPLOYMENT_TARGET,
  patchPbxproj,
  patchPodfile,
  syncIosDeploymentTarget,
} from './sync-ios-deployment-target.mjs';

const DEFAULT_CAP_PODFILE = `require_relative '../../node_modules/@capacitor/ios/scripts/pods_helpers'

platform :ios, '14.0'
use_frameworks!

def capacitor_pods
  pod 'Capacitor', :path => '../../node_modules/@capacitor/ios'
  pod 'CapacitorCordova', :path => '../../node_modules/@capacitor/ios'
end

target 'App' do
  capacitor_pods
end

post_install do |installer|
  assertDeploymentTarget(installer)
end
`;

const DEFAULT_PBXPROJ = `
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 14.0;
\t\t\t\tOTHER_SETTING = YES;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 15.2;
`;

describe('sync-ios-deployment-target', () => {
  it('patches all IPHONEOS_DEPLOYMENT_TARGET entries in project.pbxproj idempotently', () => {
    const once = patchPbxproj(DEFAULT_PBXPROJ, '18.0');
    assert.equal(once.match(/IPHONEOS_DEPLOYMENT_TARGET = 18\.0;/g)?.length, 2);
    assert.ok(!once.includes('14.0'));
    assert.ok(!once.includes('15.2'));
    assert.equal(patchPbxproj(once, '18.0'), once);
  });

  it('patches default Capacitor Podfile platform and post_install idempotently', () => {
    const once = patchPodfile(DEFAULT_CAP_PODFILE, '18.0');
    assert.ok(once.includes("platform :ios, '18.0'"));
    assert.ok(!once.includes("platform :ios, '14.0'"));
    assert.ok(once.includes("config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '18.0'"));
    assert.ok(once.includes('installer.pods_project.build_configurations.each'));
    assert.ok(once.includes('installer.pods_project.targets.each'));
    assert.ok(once.includes('assertDeploymentTarget(installer)'));
    // Second run must be an exact no-op.
    assert.equal(patchPodfile(once, '18.0'), once);
  });

  it('preserves custom post_install lines and custom block variable names', () => {
    const customPodfile = `platform :ios, '14.0'
target 'App' do
end
post_install do |pi|
  pi.pods_project.targets.each do |t|
    t.build_configurations.each do |c|
      c.build_settings['ENABLE_BITCODE'] = 'NO'
    end
  end
end
`;
    const patched = patchPodfile(customPodfile, '18.0');
    assert.ok(patched.includes("platform :ios, '18.0'"));
    assert.ok(patched.includes('pi.pods_project.build_configurations.each'));
    assert.ok(patched.includes("c.build_settings['ENABLE_BITCODE'] = 'NO'"));
    assert.equal(patchPodfile(patched, '18.0'), patched);
  });

  it('updates an existing marker block when target version changes', () => {
    const v17 = patchPodfile(DEFAULT_CAP_PODFILE, '17.0');
    const v18 = patchPodfile(v17, '18.0');
    assert.ok(!v18.includes('17.0'));
    assert.equal(v18.match(/skin-trace-ios-target:begin/g)?.length, 1);
    assert.ok(v18.includes("config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '18.0'"));
  });

  it('appends post_install when Podfile has none', () => {
    const minimal = `target 'App' do\nend\n`;
    const patched = patchPodfile(minimal, '18.0');
    assert.ok(patched.startsWith("platform :ios, '18.0'\n"));
    assert.ok(patched.includes('post_install do |installer|'));
    assert.equal(patchPodfile(patched, '18.0'), patched);
  });

  it('patches ios/ files on disk and is a no-op when already synced or ios/ missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skin-trace-ios-sync-'));
    try {
      // Missing ios/ directory should succeed cleanly without writing anything.
      const missingRes = syncIosDeploymentTarget(dir, IOS_DEPLOYMENT_TARGET);
      assert.deepEqual(missingRes, { pbxprojUpdated: false, podfileUpdated: false });

      mkdirSync(join(dir, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
      const pbxPath = join(dir, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
      const podfilePath = join(dir, 'ios', 'App', 'Podfile');
      writeFileSync(pbxPath, DEFAULT_PBXPROJ, 'utf8');
      writeFileSync(podfilePath, DEFAULT_CAP_PODFILE, 'utf8');

      const first = syncIosDeploymentTarget(dir, IOS_DEPLOYMENT_TARGET);
      assert.deepEqual(first, { pbxprojUpdated: true, podfileUpdated: true });
      assert.ok(readFileSync(pbxPath, 'utf8').includes('IPHONEOS_DEPLOYMENT_TARGET = 18.0;'));
      assert.ok(readFileSync(podfilePath, 'utf8').includes("platform :ios, '18.0'"));

      const second = syncIosDeploymentTarget(dir, IOS_DEPLOYMENT_TARGET);
      assert.deepEqual(second, { pbxprojUpdated: false, podfileUpdated: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
