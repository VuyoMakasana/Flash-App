// flash-user-app/screens/LoginScreen.js
// FULL REPLACEMENT FILE — fixes duplicate handleGoogleSignIn function,
// adds Forgot Password navigation, adds email-not-verified handling.
import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFlash } from '../context/FlashContext';
import api from '../services/api';
// CRITICAL FIX: @react-native-google-signin/google-signin requires native
// code compiled into the binary. Any environment without that native
// module present (Expo Go being the most common one) throws
// "TurboModuleRegistry.getEnforcing(...): 'RNGoogleSignin' could not be
// found" the moment anything touches it — found via real on-device
// testing, where this crashed the screen on every mount. Apple Sign-In
// below already used this exact defensive pattern; Google Sign-In never
// did, despite an identical native-module dependency.
let GoogleSignin = null, GoogleSigninButton = null, statusCodes = null;
try {
  ({ GoogleSignin, GoogleSigninButton, statusCodes } = require('@react-native-google-signin/google-signin'));
} catch (_) {}

// expo-apple-authentication: only available on iOS 13+
let AppleAuth = null;
if (Platform.OS === 'ios') {
  try { AppleAuth = require('expo-apple-authentication'); } catch (_) {}
}

export default function LoginScreen({ navigation }) {
  const [email, setEmail]               = useState('');
  const [password, setPassword]         = useState('');
  const [loading, setLoading]           = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const { login, loginWithApple, loginWithGoogle } = useFlash();

  useEffect(() => {
    if (!AppleAuth) return;
    AppleAuth.isAvailableAsync().then(setAppleAvailable).catch(() => {});
  }, []);

  // Configure Google Sign-In with real client IDs from .env
  useEffect(() => {
    if (!GoogleSignin) return;
    GoogleSignin.configure({
      // iosClientId  : the iOS OAuth client ID from Google Cloud Console
      // webClientId  : the Android OAuth client ID (also called "web" by the SDK)
      iosClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS,
      webClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID,
    });
  }, []);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Missing Fields', 'Please enter your email and password.');
      return;
    }
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
    } catch (err) {
      const msg = err.message || 'Login failed';
      if (msg.includes('EMAIL_NOT_VERIFIED') || msg.includes('verify your email')) {
        // No "ResendVerification" screen exists in this app — resend the
        // email directly from here instead of navigating to a route that
        // was never registered anywhere, which silently did nothing.
        Alert.alert(
          'Email Not Verified',
          'Please check your inbox and verify your email address before logging in.',
          [
            {
              text: 'Resend Email',
              onPress: async () => {
                try {
                  await api.auth.resendVerification(email.trim().toLowerCase());
                  Alert.alert('Email Sent', 'Check your inbox for a new verification link.');
                } catch (resendErr) {
                  Alert.alert('Error', resendErr.message || 'Could not resend verification email.');
                }
              },
            },
            { text: 'OK', style: 'cancel' },
          ]
        );
      } else {
        Alert.alert('Login Failed', msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (!GoogleSignin) return;
    setGoogleLoading(true);
    try {
      await GoogleSignin.hasPlayServices();
      const userInfo = await GoogleSignin.signIn();
      // SDK v16 returns idToken inside data; older versions return it at root
      const idToken = userInfo.data?.idToken || userInfo.idToken;
      if (!idToken) throw new Error('No ID token returned from Google');
      await loginWithGoogle(idToken);
    } catch (err) {
      if (err.code === statusCodes.SIGN_IN_CANCELLED) return; // user tapped back
      if (err.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        Alert.alert('Not Available', 'Google Sign In is not available on this device.');
        return;
      }
      if (err.code === statusCodes.IN_PROGRESS) return; // already signing in
      Alert.alert('Google Sign In Failed', err.message || 'Could not sign in with Google. Please try again.');
    } finally {
      setGoogleLoading(false);
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
      await loginWithApple(credential.identityToken, credential.fullName, credential.email);
    } catch (err) {
      if (err.code === 'ERR_REQUEST_CANCELED') return;
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

          {/* Apple Sign In — iPhone only */}
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
                <Text style={styles.dividerText}>or</Text>
                <View style={styles.divider} />
              </View>
            </>
          )}

          {/* Google Sign In */}
          {GoogleSigninButton && (
            <GoogleSigninButton
              style={{ width: '100%', height: 52, marginBottom: 4 }}
              size={GoogleSigninButton.Size.Wide}
              color={GoogleSigninButton.Color.Dark}
              onPress={handleGoogleSignIn}
              disabled={googleLoading}
            />
          )}

          <View style={styles.dividerRow}>
            <View style={styles.divider} />
            <Text style={styles.dividerText}>or continue with email</Text>
            <View style={styles.divider} />
          </View>

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
            <View style={styles.labelRow}>
              <Text style={styles.label}>Password</Text>
              <Pressable onPress={() => navigation.navigate('ForgotPassword')} hitSlop={8}>
                <Text style={styles.forgotLink}>Forgot password?</Text>
              </Pressable>
            </View>
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
  labelRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label:          { fontWeight: '600', color: '#374151', fontSize: 14 },
  forgotLink:     { color: '#0a0a0a', fontSize: 13, fontWeight: '600' },
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
