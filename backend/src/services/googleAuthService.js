const https = require('https');

async function verifyGoogleToken(idToken, expectedAudiences) {
  return new Promise((resolve, reject) => {
    const path = `/oauth2/v3/tokeninfo?id_token=${encodeURIComponent(idToken)}`;

    const req = https.get({ hostname: 'oauth2.googleapis.com', path, port: 443 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const payload = JSON.parse(data);

          if (payload.error_description || !payload.sub) {
            return reject(new Error(payload.error_description || 'Invalid Google token'));
          }

          // FIXED: if no client IDs are configured, REJECT the token.
          // Previously: empty array → validAudiences.length = 0 → check skipped entirely.
          // Any attacker with any Google token from any app could sign in.
          //
          // H-3 FIX: the caller (googleSignInUser / googleSignInDriver) now
          // passes only its own app's client IDs instead of this function
          // building the full cross-app list internally - otherwise a
          // token minted for the user app's audience was equally valid on
          // the driver app's sign-in endpoint and vice versa.
          const validAudiences = (expectedAudiences || []).filter(Boolean);

          if (!validAudiences.length) {
            return reject(new Error('Google Sign In is not configured on this server'));
          }

          if (!validAudiences.includes(payload.aud)) {
            return reject(new Error(`Google token audience mismatch: ${payload.aud}`));
          }

          if (parseInt(payload.exp) < Math.floor(Date.now() / 1000)) {
            return reject(new Error('Google token expired'));
          }

          resolve({
            sub: payload.sub,
            email: payload.email,
            name: payload.name,
            picture: payload.picture,
            emailVerified: payload.email_verified === 'true',
          });
        } catch (e) {
          reject(new Error('Failed to parse Google token response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Google token verification timeout')); });
  });
}

module.exports = { verifyGoogleToken };