import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFlash } from '../context/FlashContext';

export default function TermsAndConditionsScreen({ navigation }) {
  const { acceptTermsAndAuthenticate } = useFlash();
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
        <Text style={styles.updated}>Last updated: January 2025</Text>

        {[
          ['1. Acceptance', 'By using Flash, you agree to these terms. If you do not agree, please do not use the app.'],
          ['2. Service', 'Flash connects users with independent drivers for same-day clothing delivery. We are a platform, not a logistics company.'],
          // FIXED: Updated refund policy to match actual code logic — old text said "non-refundable once en route" but code applies tiered refund rules based on delivery stage
          ['3. Payments', 'All payments are processed securely via Paystack. Flash does not store card details. Refunds are processed based on delivery stage: full refund before driver assignment; store amount refunded (delivery fee retained) if driver is assigned; no refund once driver has picked up your order. A 25% cancellation fee applies when cancelling after driver assignment. Refunds take 5–10 business days to appear in your account.'],
          ['4. Returns', 'Return requests must be submitted within 24 hours of delivery. Items must be unused and in original packaging.'],
          ['5. Driver Conduct', 'Drivers are independent contractors. Flash verifies their documents but is not liable for driver conduct beyond platform policies.'],
          ['6. Privacy', 'We collect location data during active orders only. We do not sell personal data to third parties.'],
          ['7. Prohibited Use', 'You may not use Flash for any unlawful purpose, to harass drivers or users, or to circumvent payment systems.'],
          ['8. Changes', 'Flash reserves the right to update these terms at any time. Continued use constitutes acceptance.'],
        ].map(([title, body]) => (
          <View key={title} style={styles.section}>
            <Text style={styles.sectionTitle}>{title}</Text>
            <Text style={styles.sectionBody}>{body}</Text>
          </View>
        ))}
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
        <Pressable onPress={() => navigation.goBack()}>
          <Text style={styles.decline}>Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, paddingBottom: 40 },
  heading: { fontSize: 26, fontWeight: '900', color: '#0a0a0a', marginBottom: 4 },
  updated: { color: '#9ca3af', marginBottom: 24, fontSize: 13 },
  section: { marginBottom: 20 },
  sectionTitle: { fontWeight: '800', fontSize: 16, color: '#111827', marginBottom: 6 },
  sectionBody: { color: '#4b5563', lineHeight: 22 },
  footer: { padding: 20, gap: 12, borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  btn: { backgroundColor: '#0a0a0a', paddingVertical: 16, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  decline: { textAlign: 'center', color: '#9ca3af', fontWeight: '600' },
});
