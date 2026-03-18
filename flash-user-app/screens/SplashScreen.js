import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function SplashScreen({ navigation }) {
  const opacity = new Animated.Value(0);
  const scale = new Animated.Value(0.8);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, tension: 80, friction: 8, useNativeDriver: true }),
    ]).start();

    const timer = setTimeout(() => {
      navigation.replace('Login');
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.logoWrap, { opacity, transform: [{ scale }] }]}>
        <View style={styles.circle}>
          <Ionicons name="flash" size={56} color="#fff" />
        </View>
        <Text style={styles.brand}>FLASH</Text>
        <Text style={styles.tag}>Same-day clothing delivery</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' },
  logoWrap: { alignItems: 'center', gap: 16 },
  circle: { width: 100, height: 100, borderRadius: 28, backgroundColor: '#1f2937', alignItems: 'center', justifyContent: 'center' },
  brand: { fontSize: 40, fontWeight: '900', color: '#fff', letterSpacing: 6 },
  tag: { color: '#9ca3af', fontSize: 15, fontWeight: '500' },
});
