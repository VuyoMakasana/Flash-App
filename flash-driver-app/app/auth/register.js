import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, Pressable,
  Alert, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useDriver } from '../../context/DriverContext';

const VEHICLE_TYPES = ['E-Bike', 'Scooter', 'Motorcycle', 'Hatchback', 'Sedan', 'SUV'];

// Both live legal pages (Terms & Privacy) claim a minimum age of 18 — this
// mirrors the backend's authoritative check (authRoutes.js's
// dateOfBirthValidator) so a driver gets instant feedback instead of a
// round trip, but the server enforces it regardless of what the client sends.
function calculateAge(day, month, year) {
  const dob = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

export default function DriverRegisterScreen() {
  const router = useRouter();
  const { register } = useDriver();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: '', email: '', phone: '', password: '',
    vehicle_type: '', vehicle_plate: '',
  });
  const [dobDay, setDobDay] = useState('');
  const [dobMonth, setDobMonth] = useState('');
  const [dobYear, setDobYear] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const update = (key, val) => setForm(prev => ({ ...prev, [key]: val }));

  const handleRegister = async () => {
    const { name, email, phone, password, vehicle_type } = form;
    if (!name || !email || !phone || !password || !vehicle_type) {
      Alert.alert('Missing Fields', 'Please fill in all required fields.');
      return;
    }
    if (password.length < 10) {
      Alert.alert('Weak Password', 'Password must be at least 10 characters.');
      return;
    }
    if (!dobDay || !dobMonth || !dobYear) {
      Alert.alert('Date of Birth Required', 'Please enter your date of birth.');
      return;
    }
    const age = calculateAge(dobDay, dobMonth, dobYear);
    if (age === null) {
      Alert.alert('Invalid Date', 'Please enter a valid date of birth.');
      return;
    }
    if (age < 18) {
      Alert.alert('Age Restriction', 'You must be at least 18 years old to drive for Flash.');
      return;
    }

    const date_of_birth = `${dobYear}-${String(dobMonth).padStart(2, '0')}-${String(dobDay).padStart(2, '0')}`;

    setLoading(true);
    try {
      await register({ ...form, date_of_birth });
      router.replace('/auth/onboarding');
    } catch (err) {
      Alert.alert('Registration Failed', err.message || 'Could not create account.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.back}>
            <Ionicons name="arrow-back" size={20} color="#fff" />
          </Pressable>
          <Text style={styles.headerTitle}>Apply to Drive</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.title}>Driver Application</Text>
          <Text style={styles.subtitle}>Complete this form to start your application</Text>

          {[
            { label: 'Full Name *', key: 'name', icon: 'person-outline', placeholder: 'Your full name', caps: 'words' },
            { label: 'Email *', key: 'email', icon: 'mail-outline', placeholder: 'driver@email.com', keyboard: 'email-address', caps: 'none' },
            { label: 'Phone Number *', key: 'phone', icon: 'call-outline', placeholder: '+27 ...' , keyboard: 'phone-pad' },
            { label: 'Vehicle Plate', key: 'vehicle_plate', icon: 'car-outline', placeholder: 'CA 123 456', caps: 'characters' },
          ].map(f => (
            <View style={styles.inputGroup} key={f.key}>
              <Text style={styles.label}>{f.label}</Text>
              <View style={styles.inputRow}>
                <Ionicons name={f.icon} size={16} color="#9ca3af" style={styles.icon} />
                <TextInput
                  style={styles.input}
                  placeholder={f.placeholder}
                  placeholderTextColor="#9ca3af"
                  value={form[f.key]}
                  onChangeText={v => update(f.key, v)}
                  keyboardType={f.keyboard || 'default'}
                  autoCapitalize={f.caps || 'none'}
                />
              </View>
            </View>
          ))}

          {/* Date of Birth */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Date of Birth *</Text>
            <View style={styles.dobRow}>
              <TextInput
                style={[styles.dobInput, { flex: 1 }]}
                placeholder="DD"
                placeholderTextColor="#9ca3af"
                value={dobDay}
                onChangeText={t => setDobDay(t.replace(/[^0-9]/g, '').slice(0, 2))}
                keyboardType="number-pad"
                maxLength={2}
              />
              <TextInput
                style={[styles.dobInput, { flex: 1 }]}
                placeholder="MM"
                placeholderTextColor="#9ca3af"
                value={dobMonth}
                onChangeText={t => setDobMonth(t.replace(/[^0-9]/g, '').slice(0, 2))}
                keyboardType="number-pad"
                maxLength={2}
              />
              <TextInput
                style={[styles.dobInput, { flex: 1.4 }]}
                placeholder="YYYY"
                placeholderTextColor="#9ca3af"
                value={dobYear}
                onChangeText={t => setDobYear(t.replace(/[^0-9]/g, '').slice(0, 4))}
                keyboardType="number-pad"
                maxLength={4}
              />
            </View>
            <Text style={styles.dobHint}>You must be 18 or older to drive for Flash.</Text>
          </View>

          {/* Vehicle Type */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Vehicle Type *</Text>
            <View style={styles.chipGrid}>
              {VEHICLE_TYPES.map(v => (
                <Pressable
                  key={v}
                  style={[styles.chip, form.vehicle_type === v && styles.chipActive]}
                  onPress={() => update('vehicle_type', v)}
                >
                  <Text style={[styles.chipText, form.vehicle_type === v && styles.chipTextActive]}>{v}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Password */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Password *</Text>
            <View style={styles.inputRow}>
              <Ionicons name="lock-closed-outline" size={16} color="#9ca3af" style={styles.icon} />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="Min. 10 characters"
                placeholderTextColor="#9ca3af"
                value={form.password}
                onChangeText={v => update('password', v)}
                secureTextEntry={!showPassword}
              />
              <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn}>
                <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={16} color="#9ca3af" />
              </Pressable>
            </View>
          </View>

          <Pressable style={[styles.btn, loading && styles.btnDisabled]} onPress={handleRegister} disabled={loading}>
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.btnText}>Submit Application</Text>
            }
          </Pressable>

          <Pressable onPress={() => router.back()} style={styles.backLink}>
            <Text style={styles.backLinkText}>Already have an account? Sign In</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: '#0a0a0a', padding: 20, paddingTop: 60 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 24 },
  back: { padding: 4 },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  card: { backgroundColor: '#fff', borderRadius: 24, padding: 24, gap: 16, marginBottom: 32 },
  title: { fontSize: 20, fontWeight: '800', color: '#111827' },
  subtitle: { color: '#6b7280', marginTop: -8 },
  inputGroup: { gap: 6 },
  label: { fontWeight: '600', color: '#374151', fontSize: 14 },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f9fafb', borderRadius: 14, borderWidth: 1, borderColor: '#e5e7eb', paddingHorizontal: 12 },
  icon: { marginRight: 8 },
  input: { flex: 1, paddingVertical: 13, fontSize: 15, color: '#111827' },
  eyeBtn: { padding: 4 },
  dobRow: { flexDirection: 'row', gap: 8 },
  dobInput: { backgroundColor: '#f9fafb', borderRadius: 14, borderWidth: 1, borderColor: '#e5e7eb', paddingHorizontal: 12, paddingVertical: 13, fontSize: 15, color: '#111827', textAlign: 'center' },
  dobHint: { color: '#9ca3af', fontSize: 12, marginTop: 2 },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#e5e7eb' },
  chipActive: { backgroundColor: '#0a0a0a', borderColor: '#0a0a0a' },
  chipText: { fontWeight: '600', color: '#374151' },
  chipTextActive: { color: '#fff' },
  btn: { backgroundColor: '#0a0a0a', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 4 },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  backLink: { alignItems: 'center' },
  backLinkText: { color: '#6b7280', fontSize: 14 },
});
