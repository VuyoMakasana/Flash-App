// NEW FILE: post-OAuth-signup date-of-birth gate.
// WHY: Google/Apple Sign In create an account with no date_of_birth at all
// (only password registration collects it, via SignUpScreen's identical
// day/month/year fields). Rendered instead of the authenticated tabs
// whenever a logged-in user has no date_of_birth on file yet — mirrors
// App.js's existing TermsGateStack pattern exactly.

import React, { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFlash } from '../context/FlashContext';

// Mirrors SignUpScreen.js's calculateAge — same client-side pre-check for
// instant feedback, same server-side authority (dateOfBirthValidator) either
// way regardless of what this returns.
function calculateAge(day, month, year) {
  const dob = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

export default function DateOfBirthGateScreen() {
  const { submitDateOfBirth, logout } = useFlash();
  const [dobDay, setDobDay]     = useState('');
  const [dobMonth, setDobMonth] = useState('');
  const [dobYear, setDobYear]   = useState('');
  const [loading, setLoading]   = useState(false);

  const handleContinue = async () => {
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
      Alert.alert('Age Restriction', 'You must be at least 18 years old to use Flash.');
      return;
    }

    const dateOfBirth = `${dobYear}-${String(dobMonth).padStart(2, '0')}-${String(dobDay).padStart(2, '0')}`;

    setLoading(true);
    try {
      await submitDateOfBirth(dateOfBirth);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save date of birth. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.heading}>Confirm your date of birth</Text>
          <Text style={styles.intro}>
            You signed up with a social account, which does not share your date of birth with us.
            Flash requires all users to be 18 or older — please confirm yours to continue.
          </Text>

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
          <Text style={styles.dobHint}>You must be 18 or older to use Flash.</Text>
        </View>

        <View style={styles.footer}>
          <Pressable style={[styles.btn, loading && { opacity: 0.6 }]} onPress={handleContinue} disabled={loading}>
            {loading
              ? <ActivityIndicator color="#fff" />
              : <>
                  <Ionicons name="checkmark-circle" size={20} color="#fff" />
                  <Text style={styles.btnText}>Continue</Text>
                </>
            }
          </Pressable>
          <Pressable onPress={() => logout()}>
            <Text style={styles.decline}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', justifyContent: 'space-between' },
  content: { padding: 24, paddingTop: 72 },
  heading: { fontSize: 26, fontWeight: '900', color: '#0a0a0a', marginBottom: 12 },
  intro: { color: '#4b5563', lineHeight: 22, marginBottom: 24 },
  dobRow: { flexDirection: 'row', gap: 8 },
  dobInput: { backgroundColor: '#f9fafb', borderRadius: 14, borderWidth: 1, borderColor: '#e5e7eb', paddingHorizontal: 12, paddingVertical: 14, fontSize: 16, color: '#111827', textAlign: 'center' },
  dobHint: { color: '#9ca3af', fontSize: 12, marginTop: 8 },
  footer: { padding: 20, gap: 12, borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  btn: { backgroundColor: '#0a0a0a', paddingVertical: 16, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  decline: { textAlign: 'center', color: '#9ca3af', fontWeight: '600' },
});
