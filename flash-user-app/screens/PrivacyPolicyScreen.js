// NEW FILE: Privacy Policy screen
// WHY: South Africa's POPIA (Protection of Personal Information Act) requires apps
// that collect personal data to disclose what they collect, why, and how it's used.
// Flash collects names, phone numbers, addresses, location data, and payment info.
// Operating without this disclosure is a legal violation.

import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

const SECTIONS = [
  {
    title: '1. Who We Are',
    body: 'Flash is a same-day clothing delivery platform operated in South Africa. We connect customers with independent delivery drivers. By using Flash, you agree to this Privacy Policy.',
  },
  {
    title: '2. What We Collect',
    body: 'We collect: your name, email address, and phone number when you register; your delivery address when you place an order; your location during active deliveries only; payment information processed securely by Paystack (we never store your card details); order history and app usage data.',
  },
  {
    title: '3. Why We Collect It',
    body: 'We use your information to: process and deliver your orders; send you order status notifications; resolve disputes and handle returns; improve the Flash platform; comply with South African law.',
  },
  {
    title: '4. Who We Share It With',
    body: 'We share your first name and delivery address with your assigned driver so they can complete your delivery. We share payment data with Paystack for processing. We do not sell your personal data to any third party.',
  },
  {
    title: '5. Location Data',
    body: 'We collect driver location data during active deliveries to show you real-time tracking. We do not track your location as a customer. Driver location data older than 30 days is automatically deleted.',
  },
  {
    title: '6. Your Rights Under POPIA',
    body: 'You have the right to: access your personal data; correct inaccurate data; request deletion of your data; object to how your data is used. To exercise these rights, contact us at privacy@flashdelivery.co.za.',
  },
  {
    title: '7. Data Retention',
    body: 'We keep your account data for as long as your account is active. Order records are kept for 7 years for accounting and legal purposes. You may request account deletion at any time.',
  },
  {
    title: '8. Security',
    body: 'Your payment data is encrypted and processed by Paystack, a PCI-DSS compliant payment provider. Your password is stored as a cryptographic hash and cannot be read by anyone. All data is transmitted over encrypted HTTPS connections.',
  },
  {
    title: '9. Contact',
    body: 'For privacy concerns or data requests, contact: privacy@flashdelivery.co.za. For general support: support@flashdelivery.co.za.',
  },
];

export default function PrivacyPolicyScreen() {
  const navigation = useNavigation();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.back}>
          <Ionicons name="arrow-back" size={22} color="#111827" />
        </Pressable>
        <Text style={styles.title}>Privacy Policy</Text>
        <View style={{ width: 36 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.updated}>Last updated: {new Date().getFullYear()} — POPIA Compliant</Text>
        {SECTIONS.map(({ title, body }) => (
          <View key={title} style={styles.section}>
            <Text style={styles.sectionTitle}>{title}</Text>
            <Text style={styles.sectionBody}>{body}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, backgroundColor: '#fff', borderBottomWidth: 0.5, borderBottomColor: '#e5e7eb' },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#f3f4f6', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '700', color: '#111827' },
  content: { padding: 20, paddingBottom: 40 },
  updated: { color: '#9ca3af', fontSize: 12, marginBottom: 20 },
  section: { marginBottom: 20 },
  sectionTitle: { fontWeight: '700', fontSize: 15, color: '#111827', marginBottom: 6 },
  sectionBody: { color: '#6b7280', lineHeight: 22, fontSize: 14 },
});
