const https = require('https');

async function verifyGoogleToken(idToken) {
  return new Promise((resolve, reject) => {
    const path =
      `/oauth2/v3/tokeninfo?id_token=${encodeURIComponent(idToken)}`;

    const req = https.get(
      {
        hostname: 'oauth2.googleapis.com',
        path,
        port: 443,
      },
      (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const payload = JSON.parse(data);

            if (
              payload.error_description ||
              !payload.sub
            ) {
              return reject(
                new Error(
                  payload.error_description ||
                  'Invalid Google token'
                )
              );
            }

            const validAudiences = [
              process.env.GOOGLE_CLIENT_ID_USER_ANDROID,
              process.env.GOOGLE_CLIENT_ID_USER_IOS,
              process.env.GOOGLE_CLIENT_ID_DRIVER_ANDROID,
              process.env.GOOGLE_CLIENT_ID_DRIVER_IOS,
            ].filter(Boolean);

            if (
              validAudiences.length &&
              !validAudiences.includes(payload.aud)
            ) {
              return reject(
                new Error(
                  `Google token audience mismatch: ${payload.aud}`
                )
              );
            }

            if (
              parseInt(payload.exp) <
              Math.floor(Date.now() / 1000)
            ) {
              return reject(
                new Error('Google token expired')
              );
            }

            resolve({
              sub: payload.sub,
              email: payload.email,
              name: payload.name,
              picture: payload.picture,
              emailVerified:
                payload.email_verified === 'true',
            });
          } catch (e) {
            reject(
              new Error(
                'Failed to parse Google token response'
              )
            );
          }
        });
      }
    );

    req.on('error', reject);

    req.setTimeout(8000, () => {
      req.destroy();

      reject(
        new Error(
          'Google token verification timeout'
        )
      );
    });
  });
}

module.exports = {
  verifyGoogleToken,
};