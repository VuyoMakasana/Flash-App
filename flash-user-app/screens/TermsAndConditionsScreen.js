import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFlash } from '../context/FlashContext';

const TERMS_URL = 'https://flash-website.netlify.app/terms';

export default function TermsAndConditionsScreen() {
  const { acceptTermsAndAuthenticate, logout } = useFlash();
  const [loading, setLoading] = useState(false);

  const handleAccept = async () => {
    setLoading(true);
    try {
      await acceptTermsAndAuthenticate();
    } catch (e) {
      console.warn(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>Terms & Conditions</Text>
        <Text style={styles.intro}>
          Please read our full Terms & Conditions before continuing. It covers payments and
          refunds, returns, driver conduct, prohibited use, and how we may update these terms
          over time.
        </Text>

        <Pressable
          style={styles.linkBtn}
          onPress={() => Linking.openURL(TERMS_URL)}
        >
          <Ionicons name="document-text-outline" size={20} color="#0a0a0a" />
          <Text style={styles.linkBtnText}>Read the full Terms & Conditions</Text>
          <Ionicons name="open-outline" size={18} color="#6b7280" />
        </Pressable>

        <Text style={styles.footnote}>
          By tapping "I Accept & Continue" below, you confirm you have read and agree to these
          Terms & Conditions and our Privacy Policy.
        </Text>
      </ScrollView>

      <View style={styles.footer}>
        <Pressable style={[styles.btn, loading && { opacity: 0.6 }]} onPress={handleAccept} disabled={loading}>
          {loading
            ? <ActivityIndicator color="#fff" />
            : <>
                <Ionicons name="checkmark-circle" size={20} color="#fff" />
                <Text style={styles.btnText}>I Accept & Continue</Text>
              </>
          }
        </Pressable>
        {/* H9 FIX: this screen is now the only route rendered while a user is
            authenticated but hasn't accepted terms (see App.js) — there is
            no previous screen to go back to, and using the app without
            accepting isn't possible, so declining logs the user out rather
            than silently no-op'ing on goBack(). */}
        <Pressable onPress={() => logout()}>
          <Text style={styles.decline}>Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, paddingBottom: 40 },
  heading: { fontSize: 26, fontWeight: '900', color: '#0a0a0a', marginBottom: 12 },
  intro: { color: '#4b5563', lineHeight: 22, marginBottom: 20 },
  linkBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#f3f4f6', borderRadius: 14, padding: 16, marginBottom: 20 },
  linkBtnText: { flex: 1, fontWeight: '700', color: '#0a0a0a', fontSize: 15 },
  footnote: { color: '#9ca3af', fontSize: 12, lineHeight: 18 },
  footer: { padding: 20, gap: 12, borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  btn: { backgroundColor: '#0a0a0a', paddingVertical: 16, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  decline: { textAlign: 'center', color: '#9ca3af', fontWeight: '600' },
});
