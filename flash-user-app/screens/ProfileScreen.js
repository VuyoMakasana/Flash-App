import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, Alert, ActivityIndicator, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useFlash } from '../context/FlashContext';

export default function ProfileScreen() {
  const navigation = useNavigation();
  const { user, profile, updateProfile, logout } = useFlash();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name || user?.name || '');
  const [phone, setPhone] = useState(profile.phone || user?.phone || '');
  const [address, setAddress] = useState(profile.address || user?.address || '');
  const [email, setEmail] = useState(profile.email || user?.email || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateProfile({ name, phone, address, email: email.trim().toLowerCase() });
      setEditing(false);
      Alert.alert('Saved', 'Profile updated successfully.');
    } catch (e) {
      Alert.alert('Error', 'Could not save profile.');
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: logout },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Avatar */}
      <View style={styles.avatarSection}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(user?.name || 'U')[0].toUpperCase()}</Text>
        </View>
        <Text style={styles.userName}>{user?.name || 'User'}</Text>
        <Text style={styles.userEmail}>{user?.email}</Text>
      </View>

      {/* Profile form */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Personal Info</Text>
          <Pressable onPress={() => setEditing(!editing)}>
            <Ionicons name={editing ? 'close' : 'pencil'} size={18} color="#0a0a0a" />
          </Pressable>
        </View>

        {[
          { label: 'Full Name', value: name, setter: setName, icon: 'person-outline' },
          { label: 'Email', value: email, setter: setEmail, icon: 'mail-outline' },
          { label: 'Phone', value: phone, setter: setPhone, icon: 'call-outline' },
          { label: 'Delivery Address', value: address, setter: setAddress, icon: 'location-outline' },
        ].map(field => (
          <View key={field.label} style={styles.fieldRow}>
            <Ionicons name={field.icon} size={18} color="#9ca3af" />
            <View style={styles.fieldContent}>
              <Text style={styles.fieldLabel}>{field.label}</Text>
              {editing
                ? <TextInput style={styles.fieldInput} value={field.value} onChangeText={field.setter} />
                : <Text style={styles.fieldValue}>{field.value || '—'}</Text>
              }
            </View>
          </View>
        ))}

        {editing && (
          <Pressable style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save Changes</Text>}
          </Pressable>
        )}
      </View>

      {/* Flash features menu */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Flash Features</Text>
        {[
          { icon: 'body-outline',    label: 'Size Profile',    sublabel: 'AI size match', color: '#7c3aed', onPress: () => navigation.navigate('Sizing') },
          { icon: 'card-outline',    label: 'Saved Cards',     sublabel: 'Manage payment cards', color: '#2563eb', onPress: () => navigation.navigate('SavedCards') },
          { icon: 'people-outline',  label: 'Trusted Drivers', sublabel: 'Your preferred drivers', color: '#059669', onPress: () => navigation.navigate('TrustedDrivers') },
          { icon: 'gift-outline',    label: 'Store Credits',   sublabel: 'Your return credits', color: '#f59e0b', onPress: () => navigation.navigate('StoreCredits') },
          { icon: 'flash',           label: 'Flash Premium',   sublabel: '25% off delivery fees', color: '#f59e0b', onPress: () => navigation.navigate('Premium') },
        ].map(item => (
          <Pressable key={item.label} style={styles.featureRow} onPress={item.onPress}>
            <View style={[styles.featureIcon, { backgroundColor: item.color + '15' }]}>
              <Ionicons name={item.icon} size={20} color={item.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.featureLabel}>{item.label}</Text>
              <Text style={styles.featureSub}>{item.sublabel}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
          </Pressable>
        ))}
      </View>

      {/* Menu items */}
      <View style={styles.card}>
        {[
          { icon: 'receipt-outline',         label: 'Order History',   onPress: () => navigation.navigate('Orders') },
            // ADDED: Privacy Policy link — POPIA legally requires this to be accessible in-app
          // Opens the real, live Privacy Policy directly rather than the
          // stale hardcoded text PrivacyPolicyScreen.js used to show.
          { icon: 'shield-checkmark-outline', label: 'Privacy Policy',  onPress: () => Linking.openURL('https://flash-website.netlify.app/privacy') },
          // H8 FIX: "Settings" was previously unreachable from anywhere in the
          // app — it's the only screen with a "Delete Account" entry point.
          { icon: 'settings-outline',         label: 'Settings',        onPress: () => navigation.navigate('Settings') },
          // Previously a real no-op (onPress: () => {}) — tapping did nothing at all.
          { icon: 'help-circle-outline',      label: 'Help & Support',  onPress: () => Linking.openURL('mailto:makasanaivyson@gmail.com') },
        ].map(item => (
          <Pressable key={item.label} style={styles.menuRow} onPress={item.onPress}>
            <Ionicons name={item.icon} size={20} color="#374151" />
            <Text style={styles.menuLabel}>{item.label}</Text>
            <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
          </Pressable>
        ))}
      </View>

      {/* Logout */}
      <Pressable style={styles.logoutBtn} onPress={handleLogout}>
        <Ionicons name="log-out-outline" size={18} color="#ef4444" />
        <Text style={styles.logoutText}>Log Out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  avatarSection: { alignItems: 'center', paddingVertical: 20, gap: 8 },
  avatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 32, fontWeight: '800' },
  userName: { fontSize: 20, fontWeight: '800', color: '#0a0a0a' },
  userEmail: { color: '#9ca3af' },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 14, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontWeight: '800', fontSize: 16, color: '#111827', marginBottom: 2 },
  fieldRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  fieldContent: { flex: 1 },
  fieldLabel: { color: '#9ca3af', fontSize: 12, fontWeight: '600' },
  fieldValue: { color: '#111827', fontWeight: '600', marginTop: 2 },
  fieldInput: { color: '#111827', fontWeight: '600', borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingVertical: 4 },
  saveBtn: { backgroundColor: '#0a0a0a', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: '800' },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  featureIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  featureLabel: { color: '#111827', fontWeight: '600', fontSize: 14 },
  featureSub: { color: '#9ca3af', fontSize: 11, marginTop: 2 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  menuLabel: { flex: 1, fontWeight: '600', color: '#374151' },
  logoutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: '#ef4444', paddingVertical: 14, borderRadius: 14 },
  logoutText: { color: '#ef4444', fontWeight: '700', fontSize: 15 },
});
