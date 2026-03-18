import React, { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFlash } from '../context/FlashContext';

export default function SignUpScreen({ navigation }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const { register } = useFlash();

  const handleSignUp = async () => {
    if (!name.trim() || !email.trim() || !password.trim()) {
      Alert.alert('Missing Fields', 'Name, email, and password are required.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Weak Password', 'Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    try {
      await register(name.trim(), email.trim().toLowerCase(), password, phone.trim() || null);
      navigation.navigate('Terms');
    } catch (err) {
      Alert.alert('Sign Up Failed', err.message || 'Could not create account.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.logoArea}>
          <View style={styles.logoCircle}>
            <Ionicons name="flash" size={40} color="#fff" />
          </View>
          <Text style={styles.brand}>FLASH</Text>
          <Text style={styles.tagline}>We do it fast.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.title}>Create account</Text>
          <Text style={styles.subtitle}>Join Flash for fast clothing delivery</Text>

          {[
            { label: 'Full Name', value: name, setter: setName, icon: 'person-outline', placeholder: 'Your name', autoCapitalize: 'words' },
            { label: 'Email', value: email, setter: setEmail, icon: 'mail-outline', placeholder: 'you@email.com', keyboardType: 'email-address', autoCapitalize: 'none' },
            { label: 'Phone (optional)', value: phone, setter: setPhone, icon: 'call-outline', placeholder: '+27 ...', keyboardType: 'phone-pad' },
          ].map(field => (
            <View style={styles.inputGroup} key={field.label}>
              <Text style={styles.label}>{field.label}</Text>
              <View style={styles.inputRow}>
                <Ionicons name={field.icon} size={18} color="#9ca3af" style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder={field.placeholder}
                  placeholderTextColor="#9ca3af"
                  value={field.value}
                  onChangeText={field.setter}
                  keyboardType={field.keyboardType || 'default'}
                  autoCapitalize={field.autoCapitalize || 'none'}
                />
              </View>
            </View>
          ))}

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Password</Text>
            <View style={styles.inputRow}>
              <Ionicons name="lock-closed-outline" size={18} color="#9ca3af" style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="Min. 6 characters"
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
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleSignUp}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonText}>Create Account</Text>
            }
          </Pressable>

          <Pressable onPress={() => navigation.navigate('Login')} style={styles.link}>
            <Text style={styles.linkText}>
              Already have an account? <Text style={styles.linkBold}>Sign In</Text>
            </Text>
          </Pressable>
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
  tagline: { color: '#6b7280', marginTop: 4, fontSize: 14 },
  card: { backgroundColor: '#fff', borderRadius: 24, padding: 24, width: '100%', gap: 16 },
  title: { fontSize: 24, fontWeight: '800', color: '#111827' },
  subtitle: { color: '#6b7280', marginTop: -8 },
  inputGroup: { gap: 6 },
  label: { fontWeight: '600', color: '#374151', fontSize: 14 },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f9fafb', borderRadius: 14, borderWidth: 1, borderColor: '#e5e7eb', paddingHorizontal: 12 },
  inputIcon: { marginRight: 8 },
  input: { flex: 1, paddingVertical: 14, fontSize: 16, color: '#111827' },
  eyeBtn: { padding: 4 },
  button: { backgroundColor: '#0a0a0a', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 4 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  link: { alignItems: 'center' },
  linkText: { color: '#6b7280', fontSize: 14 },
  linkBold: { color: '#0a0a0a', fontWeight: '700' },
});
