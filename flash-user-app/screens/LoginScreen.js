import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFlash } from '../context/FlashContext';

// expo-apple-authentication: only available on iOS 13+
let AppleAuth = null;
if (Platform.OS === 'ios') {
  try { AppleAuth = require('expo-apple-authentication'); } catch (_) {}
}

export default function LoginScreen({ navigation }) {
  const [email, setEmail]                   = useState('');
  const [password, setPassword]             = useState('');
  const [loading, setLoading]               = useState(false);
  const [appleLoading, setAppleLoading]     = useState(false);
  const [showPassword, setShowPassword]     = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const { login, loginWithApple } = useFlash();

  useEffect(() => {
    if (!AppleAuth) return;
    AppleAuth.isAvailableAsync().then(setAppleAvailable).catch(() => {});
  }, []);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Missing Fields', 'Please enter your email and password.');
      return;
    }
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
      // Navigation handled by App.js isAuthenticated check
    } catch (err) {
      Alert.alert('Login Failed', err.message || 'Invalid email or password.');
    } finally {
      setLoading(false);
    }
  };

  const handleAppleSignIn = async () => {
    if (!AppleAuth) return;
    setAppleLoading(true);
    try {
      const credential = await AppleAuth.signInAsync({
        requestedScopes: [
          AppleAuth.AppleAuthenticationScope.FULL_NAME,
          AppleAuth.AppleAuthenticationScope.EMAIL,
        ],
      });
      // identityToken is the JWT from Apple we send to our backend for verification
      await loginWithApple(credential.identityToken, credential.fullName, credential.email);
    } catch (err) {
      if (err.code === 'ERR_REQUEST_CANCELED') return; // User dismissed the sheet
      Alert.alert('Apple Sign In Failed', err.message || 'Could not sign in with Apple. Please try email and password.');
    } finally {
      setAppleLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">

        <View style={styles.logoArea}>
          <View style={styles.logoCircle}>
            <Ionicons name="flash" size={40} color="#fff" />
          </View>
          <Text style={styles.brand}>FLASH</Text>
          <Text style={styles.tagline}>We do it fast.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>Sign in to your account</Text>

          {/* Sign in with Apple — only shown on iPhones running iOS 13+ */}
          {appleAvailable && AppleAuth && (
            <>
              {appleLoading ? (
                <View style={styles.appleBtn}>
                  <ActivityIndicator color="#fff" />
                </View>
              ) : (
                <AppleAuth.AppleAuthenticationButton
                  buttonType={AppleAuth.AppleAuthenticationButtonType.SIGN_IN}
                  buttonStyle={AppleAuth.AppleAuthenticationButtonStyle.BLACK}
                  cornerRadius={14}
                  style={styles.appleBtn}
                  onPress={handleAppleSignIn}
                />
              )}
              <View style={styles.dividerRow}>
                <View style={styles.divider} />
                <Text style={styles.dividerText}>or continue with email</Text>
                <View style={styles.divider} />
              </View>
            </>
          )}

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Email</Text>
            <View style={styles.inputRow}>
              <Ionicons name="mail-outline" size={18} color="#9ca3af" style={styles.inputIcon} />
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
              />
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Password</Text>
            <View style={styles.inputRow}>
              <Ionicons name="lock-closed-outline" size={18} color="#9ca3af" style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="Your password"
                placeholderTextColor="#9ca3af"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                textContentType="password"
                autoComplete="password"
              />
              <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn} hitSlop={8}>
                <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={18} color="#9ca3af" />
              </Pressable>
            </View>
          </View>

          <Pressable style={[styles.button, loading && styles.buttonDisabled]} onPress={handleLogin} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
          </Pressable>

          <Pressable onPress={() => navigation.navigate('SignUp')} style={styles.link}>
            <Text style={styles.linkText}>Don't have an account? <Text style={styles.linkBold}>Sign Up</Text></Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:      { flexGrow: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center', padding: 24 },
  logoArea:       { alignItems: 'center', marginBottom: 32 },
  logoCircle:     { width: 72, height: 72, borderRadius: 24, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#1f2937', marginBottom: 12 },
  brand:          { color: '#fff', fontSize: 28, fontWeight: '900', letterSpacing: 4 },
  tagline:        { color: '#6b7280', marginTop: 4, fontSize: 14 },
  card:           { backgroundColor: '#fff', borderRadius: 24, padding: 24, width: '100%', gap: 16 },
  title:          { fontSize: 24, fontWeight: '800', color: '#111827' },
  subtitle:       { color: '#6b7280', marginTop: -8 },
  appleBtn:       { width: '100%', height: 52, borderRadius: 14, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  dividerRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  divider:        { flex: 1, height: 1, backgroundColor: '#e5e7eb' },
  dividerText:    { color: '#9ca3af', fontSize: 12 },
  inputGroup:     { gap: 6 },
  label:          { fontWeight: '600', color: '#374151', fontSize: 14 },
  inputRow:       { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f9fafb', borderRadius: 14, borderWidth: 1, borderColor: '#e5e7eb', paddingHorizontal: 12 },
  inputIcon:      { marginRight: 8 },
  input:          { flex: 1, paddingVertical: 14, fontSize: 16, color: '#111827' },
  eyeBtn:         { padding: 4 },
  button:         { backgroundColor: '#0a0a0a', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 4 },
  buttonDisabled: { opacity: 0.6 },
  buttonText:     { color: '#fff', fontSize: 16, fontWeight: '800' },
  link:           { alignItems: 'center' },
  linkText:       { color: '#6b7280', fontSize: 14 },
  linkBold:       { color: '#0a0a0a', fontWeight: '700' },
});
