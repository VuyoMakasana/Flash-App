// scripts/start-tunnel.js
//
// Replacement for `npx expo start --tunnel`. That flag depends on
// @expo/ngrok, which bundles an ancient ngrok agent (v2.3.41) — ngrok's
// servers now reject it outright (ERR_NGROK_121: minimum supported agent
// version is 3.20.0 for this account). @ngrok/ngrok is ngrok's own
// current, actively-maintained SDK and doesn't hit that wall.
//
// This opens a real ngrok tunnel to port 8081 FIRST, then starts Metro
// with EXPO_PACKAGER_PROXY_URL set to that tunnel's URL, using the
// already-saved authtoken from ~/.ngrok2/ngrok.yml (the one
// `ngrok authtoken ...` wrote).
//
// Order matters here. Metro/Expo CLI decides what host:port to embed in
// the manifest (bundleUrl, etc.) at startup — without EXPO_PACKAGER_PROXY_URL
// set *before* Metro starts, it falls back to its own locally-bound
// port (8081) and embeds that, which is exactly the bug this fixes: the
// first request (the manifest) succeeded because Expo Go used the URL
// you actually typed, but every *follow-up* bundle/asset request got
// built from the manifest's embedded host:port instead — which was
// "<ngrok-host>:8081", a port ngrok's HTTPS endpoint never listens on.
// EXPO_PACKAGER_PROXY_URL (read directly from Expo's own UrlCreator.js —
// not guessed) makes Metro embed the real tunnel URL from the start.
//
// Prints the public URL to enter manually in Expo Go — this script
// doesn't drive Expo Go's own QR-code generation, so there's no QR code
// here, just the URL.
//
// Usage: node scripts/start-tunnel.js
// Stop with Ctrl+C — this closes the tunnel and kills Metro together.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ngrok = require('@ngrok/ngrok');

// First run on a new machine: sign up free at https://dashboard.ngrok.com/signup,
// copy your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken,
// then set it as an environment variable before running this script:
//   NGROK_AUTHTOKEN=your_token_here node scripts/start-tunnel.js
// To avoid retyping it every time, add it to your shell profile
// (~/.bashrc, ~/.zshrc) or, on Windows PowerShell, your $PROFILE —
// that's a one-time step and every future run picks it up automatically.
function readAuthtoken() {
  if (process.env.NGROK_AUTHTOKEN) return process.env.NGROK_AUTHTOKEN;

  // Fallback for this specific machine, where an authtoken was already
  // saved to disk via the legacy ngrok CLI's own `authtoken` command
  // during initial setup. New machines won't have this file — use the
  // environment variable above instead.
  const configPath = path.join(os.homedir(), '.ngrok2', 'ngrok.yml');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const match = content.match(/authtoken:\s*(\S+)/);
    if (match) return match[1];
  } catch (_) {
    // No saved config yet — fall through to the error below.
  }

  throw new Error(
    'No ngrok authtoken found. Set NGROK_AUTHTOKEN in your environment — see the ' +
    'comment above this function for how to get one and where to set it.'
  );
}

async function main() {
  const authtoken = readAuthtoken();

  console.log('Opening ngrok tunnel to port 8081...');
  const listener = await ngrok.forward({ addr: 8081, authtoken });
  const url = listener.url();

  console.log('Starting Metro on port 8081, proxied through', url, '...');
  const metro = spawn('npx', ['expo', 'start', '--port', '8081'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      EXPO_PACKAGER_PROXY_URL: url,
    },
  });

  metro.on('exit', (code) => {
    console.log(`Metro exited (code ${code}) — closing tunnel.`);
    listener.close().finally(() => process.exit(code || 0));
  });

  console.log('');
  console.log('='.repeat(60));
  console.log('TUNNEL READY');
  console.log('URL:', url);
  console.log('In Expo Go: tap "Enter URL manually" and paste this URL.');
  console.log('='.repeat(60));
  console.log('');

  process.on('SIGINT', async () => {
    console.log('\nClosing tunnel and Metro...');
    await listener.close();
    metro.kill();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start tunnel:', err.message);
  process.exit(1);
});
