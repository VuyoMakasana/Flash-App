// flash-driver-app/app/auth/login.js
// FULL REPLACEMENT FILE — fixes duplicate handleGoogleSignIn, adds missing
// googleLoading state, correctly destructures loginWithGoogle from context.
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, Pressable,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useDriver } from '../../context/DriverContext';
import { GoogleSignin, GoogleSigninButton, statusCodes } from '@react-native-google-signin/google-signin';

let AppleAuth = null;
if (Platform.OS === 'ios') {
  try { AppleAuth = require('expo-apple-authentication'); } catch (_) {}
}

export default function DriverLoginScreen() {
  const router = useRouter();
  // loginWithGoogle was defined in DriverContext but never destructured here
  const { login, loginWithApple, loginWithGoogle } = useDriver();

  const [email, setEmail]               = useState('');
  const [password, setPassword]         = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading]           = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false); // was missing
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    if (!AppleAuth) return;
    AppleAuth.isAvailableAsync().then(setAppleAvailable).catch(() => {});
  }, []);

  // Configure Google Sign-In once on mount with real client IDs from .env
  useEffect(() => {
    GoogleSignin.configure({
      iosClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS,
      webClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID,
    });
  }, []);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Missing Fields', 'Please enter email and password.');
      return;
    }
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
      router.replace('/driver/dashboard');
    } catch (err) {
      const msg = err.message || 'Login failed';
      // Prefer the structured status the backend already returns
      // (driver.status: pending_documents/under_review/suspended/rejected)
      // over substring-matching the free-text message, which silently
      // breaks the moment the message copy changes and had no branch for
      // 'suspended' at all despite this exact Alert existing for it.
      const status = err.status;
      if (status === 'pending_documents' || status === 'documents_submitted' || msg.includes('documents')) {
        Alert.alert('Documents Required', 'Upload your verification documents to continue.',
          [{ text: 'Upload Now', onPress: () => router.push('/auth/onboarding') }, { text: 'Cancel', style: 'cancel' }]
        );
      } else if (status === 'under_review' || msg.includes('review') || msg.includes('pending')) {
        Alert.alert('Under Review', 'Your application is being reviewed. We will notify you when approved.');
      } else if (status === 'suspended' || msg.includes('suspended')) {
        Alert.alert('Account Suspended', 'Your account has been suspended. Contact support@flash.co.za');
      } else if (status === 'rejected') {
        Alert.alert('Application Not Approved', msg);
      } else {
        Alert.alert('Login Failed', msg);
      }
    } finally {
      setLoading(false);
    }
  };

  // Single, correct handleGoogleSignIn — the original file had two conflicting definitions
  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    try {
      await GoogleSignin.hasPlayServices();
      const userInfo = await GoogleSignin.signIn();
      // SDK v16 returns idToken inside data; older versions return it at root
      const idToken = userInfo.data?.idToken || userInfo.idToken;
      if (!idToken) throw new Error('No ID token returned from Google');
      const result = await loginWithGoogle(idToken);
      if (result?.nextStep === 'upload_documents') {
        router.replace('/auth/onboarding');
      } else {
        router.replace('/driver/dashboard');
      }
    } catch (err) {
      if (err.code === statusCodes.SIGN_IN_CANCELLED) return;
      if (err.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        Alert.alert('Not Available', 'Google Sign In is not available on this device.');
        return;
      }
      if (err.code === statusCodes.IN_PROGRESS) return;
      Alert.alert('Google Sign In Failed', err.message || 'Could not sign in with Google.');
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
      const result = await loginWithApple(
        credential.identityToken,
        credential.fullName,
        credential.email,
      );
      if (result?.nextStep === 'upload_documents') {
        router.replace('/auth/onboarding');
      } else {
        router.replace('/driver/dashboard');
      }
    } catch (err) {
      if (err.code === 'ERR_REQUEST_CANCELED') return;
      const msg = err.message || '';
      if (msg.includes('documents') || msg.includes('pending')) {
        Alert.alert('Almost There', 'Please upload your verification documents.', [
          { text: 'Upload Now', onPress: () => router.push('/auth/onboarding') },
          { text: 'Later', style: 'cancel' },
        ]);
      } else {
        Alert.alert('Apple Sign In Failed', msg || 'Could not sign in with Apple. Please try email and password.');
      }
    } finally {
      setAppleLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
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
          <GoogleSigninButton
            style={{ width: '100%', height: 52, marginBottom: 4 }}
            size={GoogleSigninButton.Size.Wide}
            color={GoogleSigninButton.Color.Dark}
            onPress={handleGoogleSignIn}
            disabled={googleLoading}
          />

          <View style={styles.dividerRow}>
            <View style={styles.divider} />
            <Text style={styles.dividerText}>or continue with email</Text>
            <View style={styles.divider} />
          </View>

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
                autoComplete="email"
                textContentType="emailAddress"
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
                textContentType="password"
                autoComplete="password"
              />
              <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn} hitSlop={8}>
                <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={18} color="#9ca3af" />
              </Pressable>
            </View>
          </View>

          <Pressable style={[styles.btn, loading && styles.btnDisabled]} onPress={handleLogin} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Sign In</Text>}
          </Pressable>

          <View style={styles.dividerRow}>
            <View style={styles.divider} />
            <Text style={styles.dividerText}>New driver?</Text>
            <View style={styles.divider} />
          </View>

          <Pressable style={styles.secondaryBtn} onPress={() => router.push('/auth/register')}>
            <Text style={styles.secondaryBtnText}>Apply to Drive</Text>
          </Pressable>
        </View>

        <View style={styles.notice}>
          <Ionicons name="shield-checkmark-outline" size={16} color="#9ca3af" />
          <Text style={styles.noticeText}>All drivers undergo background checks and document verification.</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:        { flexGrow: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center', padding: 24 },
  logoArea:         { alignItems: 'center', marginBottom: 32 },
  logoCircle:       { width: 72, height: 72, borderRadius: 24, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#1f2937', marginBottom: 12 },
  brand:            { color: '#fff', fontSize: 28, fontWeight: '900', letterSpacing: 4 },
  tagline:          { color: '#6b7280', marginTop: 4 },
  card:             { backgroundColor: '#fff', borderRadius: 24, padding: 24, width: '100%', gap: 16 },
  title:            { fontSize: 22, fontWeight: '800', color: '#111827' },
  subtitle:         { color: '#6b7280', marginTop: -8 },
  appleBtn:         { width: '100%', height: 52, borderRadius: 14, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  dividerRow:       { flexDirection: 'row', alignItems: 'center', gap: 12 },
  divider:          { flex: 1, height: 1, backgroundColor: '#e5e7eb' },
  dividerText:      { color: '#9ca3af', fontWeight: '600', fontSize: 12 },
  inputGroup:       { gap: 6 },
  label:            { fontWeight: '600', color: '#374151', fontSize: 14 },
  inputRow:         { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f9fafb', borderRadius: 14, borderWidth: 1, borderColor: '#e5e7eb', paddingHorizontal: 12 },
  icon:             { marginRight: 8 },
  input:            { flex: 1, paddingVertical: 14, fontSize: 16, color: '#111827' },
  eyeBtn:           { padding: 4 },
  btn:              { backgroundColor: '#0a0a0a', borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  btnDisabled:      { opacity: 0.6 },
  btnText:          { color: '#fff', fontSize: 16, fontWeight: '800' },
  secondaryBtn:     { borderWidth: 1.5, borderColor: '#0a0a0a', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  secondaryBtnText: { color: '#0a0a0a', fontWeight: '800', fontSize: 15 },
  notice:           { flexDirection: 'row', gap: 8, marginTop: 20, paddingHorizontal: 4, alignItems: 'flex-start' },
  noticeText:       { color: '#6b7280', fontSize: 12, flex: 1 },
});
