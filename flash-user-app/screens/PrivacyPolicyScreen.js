// This screen previously embedded a hardcoded, POPIA-referencing text
// snippet baked into the app binary — it could drift from the real policy
// and required a new app store release to ever update. It's no longer
// reachable via in-app navigation (ProfileScreen.js's "Privacy Policy" row
// now opens the live URL directly), but this screen is kept as a
// defensive fallback for any future/external deep link into the
// 'PrivacyPolicy' route: it opens the real, live Privacy Policy and
// returns immediately, rather than showing stale text.

import React, { useEffect } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Linking } from 'react-native';
import { useNavigation } from '@react-navigation/native';

const PRIVACY_URL = 'https://flash-website.netlify.app/privacy';

export default function PrivacyPolicyScreen() {
  const navigation = useNavigation();

  useEffect(() => {
    Linking.openURL(PRIVACY_URL).catch(() => {});
    const timer = setTimeout(() => {
      if (navigation.canGoBack()) navigation.goBack();
    }, 300);
    return () => clearTimeout(timer);
  }, [navigation]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#0a0a0a" />
      <Text style={styles.text}>Opening Privacy Policy…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f7f7f7', gap: 12 },
  text: { color: '#6b7280', fontSize: 14 },
});
