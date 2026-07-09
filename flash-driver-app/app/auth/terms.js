// NEW FILE: driver-app Terms & Conditions acceptance gate.
// WHY: the driver app previously had no terms-acceptance mechanism of any
// kind — no column on drivers, no gate, no screen — unlike the user app,
// which has forced this since signup. A driver could register and start
// earning without ever being shown or accepting any Terms & Conditions.

import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Linking, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useDriver } from '../../context/DriverContext';

const TERMS_URL = 'https://flash-website.netlify.app/terms';

export default function DriverTermsScreen() {
  const router = useRouter();
  const { driver, acceptTerms, logout } = useDriver();
  const [loading, setLoading] = useState(false);

  const handleAccept = async () => {
    setLoading(true);
    try {
      await acceptTerms();
      router.replace(driver?.status === 'approved' ? '/driver/dashboard' : '/auth/onboarding');
    } catch (e) {
      Alert.alert('Error', e.message || 'Could not accept terms. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleDecline = () => {
    logout();
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.heading}>Terms & Conditions</Text>
        <Text style={styles.intro}>
          Please read our full Terms & Conditions before continuing. It covers payouts and
          commission, delivery conduct, account suspension, prohibited use, and how we may
          update these terms over time.
        </Text>

        <Pressable style={styles.linkBtn} onPress={() => Linking.openURL(TERMS_URL)}>
          <Ionicons name="document-text-outline" size={20} color="#0a0a0a" />
          <Text style={styles.linkBtnText}>Read the full Terms & Conditions</Text>
          <Ionicons name="open-outline" size={18} color="#6b7280" />
        </Pressable>

        <Text style={styles.footnote}>
          By tapping &ldquo;I Accept &amp; Continue&rdquo; below, you confirm you have read and agree to these
          Terms &amp; Conditions and our Privacy Policy.
        </Text>
      </View>

      <View style={styles.footer}>
        <Pressable style={[styles.btn, loading && { opacity: 0.6 }]} onPress={handleAccept} disabled={loading}>
          {loading
            ? <ActivityIndicator color="#0a0a0a" />
            : <>
                <Ionicons name="checkmark-circle" size={20} color="#0a0a0a" />
                <Text style={styles.btnText}>I Accept & Continue</Text>
              </>
          }
        </Pressable>
        <Pressable onPress={handleDecline}>
          <Text style={styles.decline}>Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', justifyContent: 'space-between' },
  content: { padding: 24, paddingTop: 72 },
  heading: { fontSize: 26, fontWeight: '900', color: '#fff', marginBottom: 12 },
  intro: { color: '#9ca3af', lineHeight: 22, marginBottom: 20 },
  linkBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#f59e0b', borderRadius: 14, padding: 16, marginBottom: 20 },
  linkBtnText: { flex: 1, fontWeight: '700', color: '#0a0a0a', fontSize: 15 },
  footnote: { color: '#6b7280', fontSize: 12, lineHeight: 18 },
  footer: { padding: 20, gap: 12, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
  btn: { backgroundColor: '#f59e0b', paddingVertical: 16, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  btnText: { color: '#0a0a0a', fontWeight: '800', fontSize: 16 },
  decline: { textAlign: 'center', color: '#6b7280', fontWeight: '600' },
});
