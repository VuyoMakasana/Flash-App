// flash-user-app/screens/ForgotPasswordScreen.js
// NEW FILE — add to flash-user-app/screens/
// Also add to App.js AuthStack (see instructions in the master fix doc)
import React, { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';

export default function ForgotPasswordScreen({ navigation }) {
  const [email, setEmail]   = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent]     = useState(false);

  const handleSubmit = async () => {
    if (!email.trim()) {
      Alert.alert('Email Required', 'Please enter your email address.');
      return;
    }
    setLoading(true);
    try {
      await api.auth.forgotPassword(email.trim().toLowerCase());
      setSent(true);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not send reset email. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <View style={styles.container}>
        <View style={styles.successCard}>
          <View style={styles.iconCircle}>
            <Ionicons name="mail-open-outline" size={36} color="#fff" />
          </View>
          <Text style={styles.successTitle}>Check your inbox</Text>
          <Text style={styles.successText}>
            We sent a password reset link to{'\n'}
            <Text style={styles.emailBold}>{email}</Text>
            {'\n\n'}The link expires in 1 hour. Check your spam folder if you don't see it.
          </Text>
          <Pressable style={styles.button} onPress={() => navigation.navigate('ResetPassword')}>
            <Text style={styles.buttonText}>I have the link →</Text>
          </Pressable>
          <Pressable style={styles.link} onPress={() => navigation.navigate('Login')}>
            <Text style={styles.linkText}>Back to Sign In</Text>
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
            <Ionicons name="lock-open-outline" size={36} color="#fff" />
          </View>
          <Text style={styles.title}>Reset password</Text>
          <Text style={styles.subtitle}>
            Enter your email and we'll send you a link to reset your password.
          </Text>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Email address</Text>
            <View style={styles.inputRow}>
              <Ionicons name="mail-outline" size={18} color="#9ca3af" style={styles.icon} />
              <TextInput
                style={styles.input}
                placeholder="you@email.com"
                placeholderTextColor="#9ca3af"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="send"
                onSubmitEditing={handleSubmit}
              />
            </View>
          </View>

          <Pressable style={[styles.button, loading && styles.buttonDisabled]} onPress={handleSubmit} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Send Reset Link</Text>}
          </Pressable>

          <Pressable style={styles.link} onPress={() => navigation.goBack()}>
            <Text style={styles.linkText}>← Back to Sign In</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:      { flexGrow: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card:           { backgroundColor: '#fff', borderRadius: 24, padding: 28, width: '100%', gap: 16, alignItems: 'center' },
  successCard:    { backgroundColor: '#fff', borderRadius: 24, padding: 28, width: '100%', gap: 16, alignItems: 'center' },
  iconCircle:     { width: 72, height: 72, borderRadius: 24, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  title:          { fontSize: 22, fontWeight: '800', color: '#111827' },
  subtitle:       { color: '#6b7280', textAlign: 'center', lineHeight: 20 },
  successTitle:   { fontSize: 22, fontWeight: '800', color: '#111827' },
  successText:    { color: '#6b7280', textAlign: 'center', lineHeight: 22 },
  emailBold:      { color: '#111827', fontWeight: '700' },
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
