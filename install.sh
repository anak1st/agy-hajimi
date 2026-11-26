#!/usr/bin/env bash
set -euo pipefail

# Context HUD 一键安装脚本（纯 Antigravity App / macOS Debug App 生成器）
# 用法：
#   ./install.sh                # 安装插件并生成 ~/Applications/Antigravity (Debug).app
#   ./install.sh --relaunch     # 安装并自动以 Debug 模式重启 Antigravity
#   ./install.sh --no-debug-app # 仅安装插件，不生成 Debug App

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DEST="${HOME}/.gemini/config/plugins/agy-hajimi"
HOST_APP="/Applications/Antigravity.app"
DEBUG_APP="${HOME}/Applications/Antigravity (Debug).app"

CREATE_DEBUG_APP=1
RELAUNCH_HOST=0

for arg in "$@"; do
  case "$arg" in
    --no-debug-app) CREATE_DEBUG_APP=0 ;;
    --relaunch) RELAUNCH_HOST=1 ;;
    -h|--help)
      echo "Usage: ./install.sh [--no-debug-app] [--relaunch]"
      exit 0
      ;;
    *)
      echo "[error] Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

echo "[info] Installing agy-hajimi plugin to: $PLUGIN_DEST"
rm -rf "$PLUGIN_DEST/src"
mkdir -p "$PLUGIN_DEST/assets" "$PLUGIN_DEST/src/server" "$PLUGIN_DEST/src/ui"

cp "$SCRIPT_DIR/plugin.json" "$PLUGIN_DEST/plugin.json"
cp "$SCRIPT_DIR/mcp_config.json" "$PLUGIN_DEST/mcp_config.json"
cp "$SCRIPT_DIR/README.md" "$PLUGIN_DEST/README.md"
cp "$SCRIPT_DIR/assets/logo.svg" "$PLUGIN_DEST/assets/logo.svg"
cp "$SCRIPT_DIR/src/server/"*.mjs "$PLUGIN_DEST/src/server/"
cp "$SCRIPT_DIR/src/ui/"* "$PLUGIN_DEST/src/ui/"

echo "[ok] Plugin files installed."

# 为 macOS 生成带有专属 Debug 徽标图标的包装启动器（不修改原版 .app 签名）
generate_debug_app() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "[warn] Debug .app launcher generation is only supported on macOS."
    return 0
  fi

  if [[ ! -d "$HOST_APP" ]]; then
    echo "[error] Antigravity.app not found at $HOST_APP" >&2
    exit 1
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN

  local icon_src="$HOST_APP/Contents/Resources/icon.icns"
  local icon_out="$tmp_dir/AppIcon.icns"

  if [[ -f "$icon_src" ]] && command -v swift >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
    echo "[info] Generating custom Debug badge icon from original Antigravity icon..."
    local iconset_dir="$tmp_dir/AppIcon.iconset"
    mkdir -p "$iconset_dir"

    swift - "$icon_src" "$iconset_dir" <<'SWIFT'
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else { exit(1) }
let srcPath = args[1]
let outDir = args[2]

guard let baseImage = NSImage(contentsOfFile: srcPath) else {
    fputs("Failed to load source icon\n", stderr)
    exit(1)
}

func renderIcon(sizePx: Int) -> NSBitmapImageRep? {
    let s = CGFloat(sizePx)
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: sizePx,
        pixelsHigh: sizePx,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else { return nil }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    // 1. 铺满纯白底色并按 1.22x 居中放大原版图标，消除旧版 .icns 的透明留白，防止 macOS Tahoe 自动缩框
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: s, height: s).fill()

    let bleedScale: CGFloat = 1.22
    let bleedSize = s * bleedScale
    let bleedOffset = -(bleedSize - s) / 2.0
    baseImage.draw(
        in: NSRect(x: bleedOffset, y: bleedOffset, width: bleedSize, height: bleedSize),
        from: .zero,
        operation: .sourceOver,
        fraction: 1.0
    )

    // 2. 在右下角绘制高辨识度的琥珀金 "DBG" 圆角角标（安全内边距适配系统圆角裁剪）
    let badgeW = s * 0.48
    let badgeH = s * 0.24
    let margin = s * 0.08
    let badgeRect = NSRect(
        x: s - badgeW - margin,
        y: margin,
        width: badgeW,
        height: badgeH
    )
    let radius = badgeH * 0.44
    let badgePath = NSBezierPath(roundedRect: badgeRect, xRadius: radius, yRadius: radius)

    // 阴影
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(calibratedWhite: 0, alpha: 0.42)
    shadow.shadowBlurRadius = max(1.0, s * 0.035)
    shadow.shadowOffset = NSSize(width: 0, height: -max(0.5, s * 0.015))

    NSGraphicsContext.current?.saveGraphicsState()
    shadow.set()
    NSColor(calibratedRed: 0.06, green: 0.09, blue: 0.16, alpha: 0.96).setFill()
    badgePath.fill()
    NSGraphicsContext.current?.restoreGraphicsState()

    // 内层琥珀金渐变填充
    let innerInset = max(1.0, s * 0.02)
    let innerRect = badgeRect.insetBy(dx: innerInset, dy: innerInset)
    let innerPath = NSBezierPath(
        roundedRect: innerRect,
        xRadius: max(1.0, radius - innerInset),
        yRadius: max(1.0, radius - innerInset)
    )
    if let grad = NSGradient(
        starting: NSColor(calibratedRed: 0.98, green: 0.72, blue: 0.14, alpha: 1.0),
        ending: NSColor(calibratedRed: 0.92, green: 0.44, blue: 0.04, alpha: 1.0)
    ) {
        grad.draw(in: innerPath, angle: -90)
    }

    // 3. 当尺寸 >= 32px 时绘制 crisp "DBG" 文字
    if sizePx >= 32 {
        let fontSize = badgeH * 0.54
        let font = NSFont.systemFont(ofSize: fontSize, weight: .heavy)
        let textColor = NSColor(calibratedRed: 0.06, green: 0.08, blue: 0.13, alpha: 1.0)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: textColor,
            .kern: s * 0.015,
        ]
        let str = NSAttributedString(string: "DBG", attributes: attrs)
        let strSize = str.size()
        let textOrigin = NSPoint(
            x: innerRect.midX - strSize.width / 2.0,
            y: innerRect.midY - strSize.height / 2.0 - (s * 0.004)
        )
        str.draw(at: textOrigin)
    }

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let sizes: [(Int, String)] = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png"),
]

for (px, filename) in sizes {
    guard let rep = renderIcon(sizePx: px),
          let png = rep.representation(using: .png, properties: [:]) else {
        fputs("Failed to render \(filename)\n", stderr)
        exit(1)
    }
    try png.write(to: URL(fileURLWithPath: outDir).appendingPathComponent(filename))
}
SWIFT

    iconutil -c icns "$iconset_dir" -o "$icon_out"
  elif [[ -f "$icon_src" ]]; then
    cp "$icon_src" "$icon_out"
  fi

  echo "[info] Creating launcher bundle: $DEBUG_APP"
  mkdir -p "${HOME}/Applications"
  rm -rf "$DEBUG_APP"
  mkdir -p "$DEBUG_APP/Contents/MacOS" "$DEBUG_APP/Contents/Resources"

  printf 'APPL????' > "$DEBUG_APP/Contents/PkgInfo"
  if [[ -f "$icon_out" ]]; then
    cp "$icon_out" "$DEBUG_APP/Contents/Resources/AppIcon.icns"
  fi

  cat > "$DEBUG_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Antigravity (Debug)</string>
  <key>CFBundleExecutable</key>
  <string>AntigravityDebug</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>local.agy-hajimi.debug-launcher</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Antigravity (Debug)</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

  cat > "$DEBUG_APP/Contents/MacOS/AntigravityDebug" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

HOST_APP="/Applications/Antigravity.app"
PORT_FILE="${HOME}/Library/Application Support/Antigravity/DevToolsActivePort"
DEBUG_ARGS=(--remote-debugging-port=0 --remote-debugging-address=127.0.0.1)

if [[ ! -d "$HOST_APP" ]]; then
  osascript -e 'display alert "Antigravity.app Not Found" message "Expected Antigravity at /Applications/Antigravity.app." as critical' >/dev/null 2>&1 || true
  exit 1
fi

is_debug_alive() {
  if [[ ! -f "$PORT_FILE" ]]; then
    return 1
  fi
  local port
  port="$(head -n1 "$PORT_FILE" | tr -d '[:space:]')"
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  curl -sf --max-time 1 "http://127.0.0.1:${port}/json/list" >/dev/null 2>&1
}

if pgrep -x "Antigravity" >/dev/null 2>&1; then
  if is_debug_alive; then
    exec open -a "$HOST_APP" "$@"
  fi

  # 若原版已无参运行，询问后退出重拉以开启调试端口
  if ! osascript -e 'display dialog "Antigravity is currently running without debug mode (--remote-debugging-port=0).\n\nQuit and relaunch with debug mode enabled?" buttons {"Cancel", "Relaunch"} default button "Relaunch" with title "Antigravity (Debug)"' >/dev/null 2>&1; then
    exit 0
  fi

  osascript -e 'tell application "Antigravity" to quit' >/dev/null 2>&1 || true
  i=0
  while [[ $i -lt 30 ]] && pgrep -x "Antigravity" >/dev/null 2>&1; do
    sleep 0.2
    i=$((i + 1))
  done
  if pgrep -x "Antigravity" >/dev/null 2>&1; then
    osascript -e 'display alert "Antigravity Did Not Exit" message "Please quit Antigravity manually (Cmd+Q) and launch Antigravity (Debug) again." as warning' >/dev/null 2>&1 || true
    exit 1
  fi
fi

rm -f "$PORT_FILE"
exec open -a "$HOST_APP" --args "${DEBUG_ARGS[@]}" "$@"
LAUNCHER

  chmod +x "$DEBUG_APP/Contents/MacOS/AntigravityDebug"
  # 刷新 LaunchServices / Finder 图标缓存
  touch "$DEBUG_APP"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEBUG_APP" >/dev/null 2>&1 || true
  echo "[ok] Created $DEBUG_APP"
}

if [[ "$CREATE_DEBUG_APP" -eq 1 ]]; then
  generate_debug_app
fi

if [[ "$RELAUNCH_HOST" -eq 1 ]] && [[ "$(uname -s)" == "Darwin" ]]; then
  echo "[info] Relaunching Antigravity in debug mode..."
  osascript -e 'tell application "Antigravity" to quit' >/dev/null 2>&1 || true
  i=0
  while [[ $i -lt 30 ]] && pgrep -x "Antigravity" >/dev/null 2>&1; do
    sleep 0.2
    i=$((i + 1))
  done
  rm -f "${HOME}/Library/Application Support/Antigravity/DevToolsActivePort"
  open -a "$HOST_APP" --args --remote-debugging-port=0 --remote-debugging-address=127.0.0.1
  echo "[ok] Antigravity relaunched with --remote-debugging-port=0."
fi

echo ""
echo "[done] Installation complete!"
echo "  1. Plugin directory : $PLUGIN_DEST"
if [[ "$CREATE_DEBUG_APP" -eq 1 ]] && [[ "$(uname -s)" == "Darwin" ]]; then
  echo "  2. Debug launcher   : $DEBUG_APP (drag it to your Dock)"
fi
echo "  3. Enable 'agy-hajimi' in Antigravity App -> Customizations -> Installed."
