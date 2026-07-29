// flash-driver-app/metro.config.js
//
// HISTORY: metro-config's own defaults hardcode resolver.useWatchman = true
// unconditionally — it never checks whether the watchman binary is
// actually installed. Watchman wasn't installed on this machine, so every
// local dev-server start (npm run tunnel / npm start) hit Watcher.js's
// MAX_WAIT_TIME (240s) waiting for a Watchman connection that was never
// coming, then either failed outright ("Failed to start watch mode") or,
// worse, let a bundle request through against a DependencyGraph whose
// async init had aborted partway (this._resolutionCache never set),
// crashing with "Cannot read properties of undefined (reading 'get')" in
// Metro's own DependencyGraph.js — a Metro-internals crash, not app code.
//
// This file previously forced useWatchman: false to skip the connection
// attempt entirely, falling through to metro-file-map's FallbackWatcher
// (NativeWatcher.isSupported() is hardcoded to macOS only, so Windows
// always fell through anyway). That was a real, verified improvement but
// NOT a complete fix — FallbackWatcher's own polling-based crawl still
// raced with transformer construction and hit the identical
// DependencyGraph crash intermittently (confirmed live: 8 of 10 tunnel
// attempts crashed this way even with the override in place).
//
// Watchman is now actually installed (`choco install watchman -y`, real
// Windows build, confirmed via `watchman --version`) — removing the
// override lets Metro use it as designed, which should eliminate the
// race entirely rather than just reduce its odds. If Watchman is ever
// uninstalled or unavailable on a machine running this project, Metro's
// own default behavior already degrades gracefully (though slower, per
// the FallbackWatcher path above) — no explicit fallback needed here.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

module.exports = config;
