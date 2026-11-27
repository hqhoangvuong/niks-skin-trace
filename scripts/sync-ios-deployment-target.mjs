import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IOS_DEPLOYMENT_TARGET = '18.0';

const MARKER_START = '# skin-trace-ios-target:begin';
const MARKER_END = '# skin-trace-ios-target:end';

export function buildPostInstallSnippet(installerVar = 'installer', target = IOS_DEPLOYMENT_TARGET) {
  return [
    `  ${MARKER_START}`,
    `  ${installerVar}.pods_project.build_configurations.each do |config|`,
    `    config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${target}'`,
    `  end`,
    `  ${installerVar}.pods_project.targets.each do |target|`,
    `    target.build_configurations.each do |config|`,
    `      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${target}'`,
    `    end`,
    `  end`,
    `  ${MARKER_END}`,
  ].join('\n');
}

export function patchPbxproj(content, target = IOS_DEPLOYMENT_TARGET) {
  return content.replace(
    /IPHONEOS_DEPLOYMENT_TARGET\s*=\s*[^;]+;/g,
    `IPHONEOS_DEPLOYMENT_TARGET = ${target};`
  );
}

export function patchPodfile(content, target = IOS_DEPLOYMENT_TARGET) {
  let updated = content;

  // 1. Pin top-level platform :ios to target version.
  const platformLineRe = /^[ \t]*platform\s+:ios\b.*$/m;
  if (platformLineRe.test(updated)) {
    updated = updated.replace(platformLineRe, `platform :ios, '${target}'`);
  } else {
    updated = `platform :ios, '${target}'\n${updated}`;
  }

  // 2. Enforce deployment target on Pods project and every Pod target in post_install
  // so `pod install` (run by `npx cap sync ios`) never resets Pods back to iOS 14.0.
  const postInstallMatch = updated.match(/^[ \t]*post_install\s+do\s+\|(\w+)\|[ \t]*$/m);
  const installerVar = postInstallMatch ? postInstallMatch[1] : 'installer';
  const snippet = buildPostInstallSnippet(installerVar, target);

  const markerRe = new RegExp(
    `^[ \\t]*${escapeRegExp(MARKER_START)}[\\s\\S]*?^[ \\t]*${escapeRegExp(MARKER_END)}[ \\t]*$`,
    'm'
  );

  if (markerRe.test(updated)) {
    updated = updated.replace(markerRe, snippet);
  } else if (postInstallMatch) {
    const assertLineRe = new RegExp(
      `(^[ \\t]*assertDeploymentTarget\\(${escapeRegExp(installerVar)}\\)[ \\t]*$)`,
      'm'
    );
    if (assertLineRe.test(updated)) {
      updated = updated.replace(assertLineRe, `$1\n${snippet}`);
    } else {
      updated = updated.replace(
        new RegExp(`(^[ \\t]*post_install\\s+do\\s+\\|${escapeRegExp(installerVar)}\\|[ \\t]*$)`, 'm'),
        `$1\n${snippet}`
      );
    }
  } else {
    const trimmed = updated.endsWith('\n') ? updated : `${updated}\n`;
    updated = `${trimmed}\npost_install do |installer|\n${snippet}\nend\n`;
  }

  return updated;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function syncIosDeploymentTarget(rootDir, target = IOS_DEPLOYMENT_TARGET) {
  const results = {
    pbxprojUpdated: false,
    podfileUpdated: false,
  };

  const pbxprojPath = join(rootDir, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (existsSync(pbxprojPath)) {
    const current = readFileSync(pbxprojPath, 'utf8');
    const next = patchPbxproj(current, target);
    if (next !== current) {
      writeFileSync(pbxprojPath, next, 'utf8');
      results.pbxprojUpdated = true;
    }
  }

  const podfilePath = join(rootDir, 'ios', 'App', 'Podfile');
  if (existsSync(podfilePath)) {
    const current = readFileSync(podfilePath, 'utf8');
    const next = patchPodfile(current, target);
    if (next !== current) {
      writeFileSync(podfilePath, next, 'utf8');
      results.podfileUpdated = true;
    }
  }

  return results;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const platform = process.env.CAPACITOR_PLATFORM_NAME;
  if (platform && platform !== 'ios') {
    process.exit(0);
  }
  const rootDir = process.env.CAPACITOR_ROOT_DIR || process.cwd();
  const res = syncIosDeploymentTarget(rootDir, IOS_DEPLOYMENT_TARGET);
  if (res.pbxprojUpdated || res.podfileUpdated) {
    console.log(
      `[skin-trace] Enforced iOS ${IOS_DEPLOYMENT_TARGET} deployment target` +
        ` (pbxproj: ${res.pbxprojUpdated ? 'updated' : 'ok'}, Podfile: ${res.podfileUpdated ? 'updated' : 'ok'})`
    );
  }
}
