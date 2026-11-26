require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'SkinTraceTrueDepthCamera'
  s.version = package['version']
  s.summary = package['description']
  s.license = 'UNLICENSED'
  s.homepage = 'https://local.skintrace.app'
  s.author = 'Skin Trace'
  s.source = { :path => '.' }
  s.source_files = 'ios/Sources/TrueDepthCameraPlugin/**/*.{swift,h,m}'
  s.ios.deployment_target = '18.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
