// flash-driver-app/metro.config.js
//
// FIX: metro-config's own defaults hardcode resolver.useWatchman = true
// unconditionally — it never checks whether the watchman binary is
// actually installed. On this machine it isn't, so every local dev-server
// start (npm run tunnel / npm start) hit Watcher.js's MAX_WAIT_TIME
// (240s) waiting for a Watchman connection that was never coming, then
// either failed outright ("Failed to start watch mode") or, worse, let a
// bundle request through against a DependencyGraph whose async init had
// aborted partway (this._resolutionCache never set), crashing with
// "Cannot read properties of undefined (reading 'get')" in Metro's own
// DependencyGraph.js — a Metro-internals crash, not app code. Found via
// live tunnel debugging, traced into Watcher.js/DependencyGraph.js source.
//
// Forcing useWatchman: false skips the Watchman-connection attempt
// entirely. This is a real, verified improvement (confirmed the override
// actually reaches the running dev server via a temporary load-order
// diagnostic, since removed) but NOT a complete fix: metro-file-map's
// NativeWatcher.isSupported() is hardcoded to macOS only
// (node_modules/@expo/metro/node_modules/metro-file-map/src/watchers/
// NativeWatcher.js) — on Windows this always falls through to
// FallbackWatcher, a slower polling-based watcher with no external
// binary dependency. That still needs real (if bounded) time to crawl
// this project's node_modules on first start — verify with a real
// bundle fetch before trusting the dev server is ready, don't assume a
// fixed delay is enough. The actual fast/robust fix is installing
// Watchman itself (has a real Windows build); not done here since it's
// a system-level install outside this project, not a project config
// change — ask before installing it.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.useWatchman = false;

module.exports = config;
