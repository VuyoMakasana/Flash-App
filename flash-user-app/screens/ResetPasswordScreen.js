// flash-user-app/screens/ResetPasswordScreen.js
// NEW FILE — add to flash-user-app/screens/
import React, { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';

export default function ResetPasswordScreen({ navigation, route }) {
  // Token comes from deep link query param or manual paste
  const [token, setToken]           = useState(route?.params?.token || '');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm]       = useState('');
  const [showPw, setShowPw]         = useState(false);
  const [loading, setLoading]       = useState(false);
  const [done, setDone]             = useState(false);

  const handleReset = async () => {
    if (!token.trim()) {
      Alert.alert('Missing Token', 'Paste the reset token from your email.');
      return;
    }
    if (newPassword.length < 10) {
      Alert.alert('Weak Password', 'Password must be at least 10 characters.');
      return;
    }
    if (newPassword !== confirm) {
      Alert.alert('Mismatch', 'Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await api.auth.resetPassword(token.trim(), newPassword);
      setDone(true);
    } catch (err) {
      Alert.alert('Reset Failed', err.message || 'Invalid or expired link. Request a new one.');
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <View style={styles.container}>
        <View style={styles.card}>
          <View style={styles.iconCircle}>
            <Ionicons name="checkmark-circle-outline" size={40} color="#fff" />
          </View>
          <Text style={styles.title}>Password updated!</Text>
          <Text style={styles.subtitle}>Your password has been changed. You can now sign in with your new password.</Text>
          <Pressable style={styles.button} onPress={() => navigation.navigate('Login')}>
            <Text style={styles.buttonText}>Sign In</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <View style={styles.iconCircle}>
            <Ionicons name="lock-closed-outline" size={36} color="#fff" />
          </View>
          <Text style={styles.title}>Set new password</Text>
          <Text style={styles.subtitle}>Paste the reset token from your email, then enter your new password.</Text>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Reset token (from email)</Text>
            <View style={styles.inputRow}>
              <Ionicons name="key-outline" size={18} color="#9ca3af" style={styles.icon} />
              <TextInput
                style={styles.input}
                placeholder="Paste token here"
                placeholderTextColor="#9ca3af"
                value={token}
                onChangeText={setToken}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>New password</Text>
            <View style={styles.inputRow}>
              <Ionicons name="lock-closed-outline" size={18} color="#9ca3af" style={styles.icon} />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="At least 10 characters"
                placeholderTextColor="#9ca3af"
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry={!showPw}
                textContentType="newPassword"
              />
              <Pressable onPress={() => setShowPw(!showPw)} hitSlop={8}>
                <Ionicons name={showPw ? 'eye-off-outline' : 'eye-outline'} size={18} color="#9ca3af" />
              </Pressable>
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Confirm password</Text>
            <View style={styles.inputRow}>
              <Ionicons name="lock-closed-outline" size={18} color="#9ca3af" style={styles.icon} />
              <TextInput
                style={styles.input}
                placeholder="Repeat new password"
                placeholderTextColor="#9ca3af"
                value={confirm}
                onChangeText={setConfirm}
                secureTextEntry={!showPw}
                textContentType="newPassword"
              />
            </View>
          </View>

          <Pressable style={[styles.button, loading && styles.buttonDisabled]} onPress={handleReset} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Update Password</Text>}
          </Pressable>

          <Pressable style={styles.link} onPress={() => navigation.navigate('ForgotPassword')}>
            <Text style={styles.linkText}>Request a new link</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:      { flexGrow: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card:           { backgroundColor: '#fff', borderRadius: 24, padding: 28, width: '100%', gap: 16, alignItems: 'center' },
  iconCircle:     { width: 72, height: 72, borderRadius: 24, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  title:          { fontSize: 22, fontWeight: '800', color: '#111827' },
  subtitle:       { color: '#6b7280', textAlign: 'center', lineHeight: 20 },
  inputGroup:     { width: '100%', gap: 6 },
  label:          { fontWeight: '600', color: '#374151', fontSize: 14 },
  inputRow:       { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f9fafb', borderRadius: 14, borderWidth: 1, borderColor: '#e5e7eb', paddingHorizontal: 12 },
  icon:           { marginRight: 8 },
  input:          { flex: 1, paddingVertical: 14, fontSize: 16, color: '#111827' },
  button:         { backgroundColor: '#0a0a0a', borderRadius: 14, paddingVertical: 16, alignItems: 'center', width: '100%' },
  buttonDisabled: { opacity: 0.6 },
  buttonText:     { color: '#fff', fontSize: 16, fontWeight: '800' },
  link:           { alignItems: 'center', padding: 4 },
  linkText:       { color: '#6b7280', fontSize: 14 },
});
