import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, Pressable,
  Alert, ActivityIndicator, KeyboardAvoidingView,
  Platform, ScrollView
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useDriver } from '../../context/DriverContext';

export default function DriverLoginScreen() {
  const router = useRouter();
  const { login } = useDriver();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Missing Fields', 'Please enter email and password.');
      return;
    }

    setLoading(true);
    try {
      const data = await login(email.trim().toLowerCase(), password);

      // Backend returns status in error for non-approved — login() will throw
      // If we're here, driver is approved
      router.replace('/driver/dashboard');
    } catch (err) {
      const msg = err.message || 'Login failed';

      if (msg.includes('documents')) {
        Alert.alert(
          'Documents Required',
          'You need to upload your verification documents before logging in.',
          [
            { text: 'Upload Documents', onPress: () => router.push('/auth/onboarding') },
            { text: 'Cancel', style: 'cancel' },
          ]
        );
      } else if (msg.includes('review') || msg.includes('pending')) {
        Alert.alert(
          'Under Review',
          'Your application is being reviewed. You will be notified once approved.',
          [{ text: 'OK' }]
        );
      } else {
        Alert.alert('Login Failed', msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.logoArea}>
          <View style={styles.logoCircle}>
            <Ionicons name="bicycle" size={40} color="#fff" />
          </View>
          <Text style={styles.brand}>FLASH</Text>
          <Text style={styles.tagline}>Driver Portal</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.title}>Driver Sign In</Text>
          <Text style={styles.subtitle}>Access your deliveries and earnings</Text>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Email</Text>
            <View style={styles.inputRow}>
              <Ionicons name="mail-outline" size={18} color="#9ca3af" style={styles.icon} />
              <TextInput
                style={styles.input}
                placeholder="driver@email.com"
                placeholderTextColor="#9ca3af"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Password</Text>
            <View style={styles.inputRow}>
              <Ionicons name="lock-closed-outline" size={18} color="#9ca3af" style={styles.icon} />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="Your password"
                placeholderTextColor="#9ca3af"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
              />
              <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn}>
                <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={18} color="#9ca3af" />
              </Pressable>
            </View>
          </View>

          <Pressable
            style={[styles.btn, loading && styles.btnDisabled]}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.btnText}>Sign In</Text>
            }
          </Pressable>

          <View style={styles.dividerRow}>
            <View style={styles.divider} />
            <Text style={styles.dividerText}>New driver?</Text>
            <View style={styles.divider} />
          </View>

          <Pressable
            style={styles.secondaryBtn}
            onPress={() => router.push('/auth/register')}
          >
            <Text style={styles.secondaryBtnText}>Apply to Drive</Text>
          </Pressable>
        </View>

        {/* Notice */}
        <View style={styles.notice}>
          <Ionicons name="shield-checkmark-outline" size={16} color="#9ca3af" />
          <Text style={styles.noticeText}>
            All drivers undergo background checks and document verification.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center', padding: 24 },
  logoArea: { alignItems: 'center', marginBottom: 32 },
  logoCircle: { width: 72, height: 72, borderRadius: 24, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#1f2937', marginBottom: 12 },
  brand: { color: '#fff', fontSize: 28, fontWeight: '900', letterSpacing: 4 },
  tagline: { color: '#6b7280', marginTop: 4 },
  card: { backgroundColor: '#fff', borderRadius: 24, padding: 24, width: '100%', gap: 16 },
  title: { fontSize: 22, fontWeight: '800', color: '#111827' },
  subtitle: { color: '#6b7280', marginTop: -8 },
  inputGroup: { gap: 6 },
  label: { fontWeight: '600', color: '#374151', fontSize: 14 },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f9fafb', borderRadius: 14, borderWidth: 1, borderColor: '#e5e7eb', paddingHorizontal: 12 },
  icon: { marginRight: 8 },
  input: { flex: 1, paddingVertical: 14, fontSize: 16, color: '#111827' },
  eyeBtn: { padding: 4 },
  btn: { backgroundColor: '#0a0a0a', borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  divider: { flex: 1, height: 1, backgroundColor: '#e5e7eb' },
  dividerText: { color: '#9ca3af', fontWeight: '600' },
  secondaryBtn: { borderWidth: 1.5, borderColor: '#0a0a0a', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  secondaryBtnText: { color: '#0a0a0a', fontWeight: '800', fontSize: 15 },
  notice: { flexDirection: 'row', gap: 8, marginTop: 20, paddingHorizontal: 4, alignItems: 'flex-start' },
  noticeText: { color: '#6b7280', fontSize: 12, flex: 1 },
});
