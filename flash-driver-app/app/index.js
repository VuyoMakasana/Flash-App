import { Redirect } from 'expo-router';
import { useDriver } from '../context/DriverContext';

// Cold-start flicker fix: this screen previously always redirected to
// /auth/login regardless of auth state. _layout.js's RootLayoutNav gates the
// entire Stack (including this screen) behind a loading spinner until
// hydration finishes, so by the time this renders, isAuthenticated/driver are
// already stable — computing the correct destination here directly avoids
// the race where this unconditional redirect fires before RootLayoutNav's
// own correcting effect, which previously flashed the login screen for an
// instant even for an already-approved, logged-in driver.
export default function Index() {
  const { isAuthenticated, driver } = useDriver();

  if (isAuthenticated && driver?.status === 'approved') {
    return <Redirect href="/driver/dashboard" />;
  }
  if (isAuthenticated) {
    return <Redirect href="/auth/onboarding" />;
  }
  return <Redirect href="/auth/login" />;
}
