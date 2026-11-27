// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SkinTraceTruedepthCamera",
    platforms: [.iOS(.v18)],
    products: [
        .library(
            name: "SkinTraceTruedepthCamera",
            targets: ["TrueDepthCameraPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "7.0.0")
    ],
    targets: [
        .target(
            name: "TrueDepthCameraPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/TrueDepthCameraPlugin"
        )
    ]
)
