/**
 * flash-user-app/screens/SplashScreen.js
 *
 * MEDIUM-4 FIX: Premium animated splash screen.
 *   - Black background (#0a0a0a)
 *   - "FLASH" wordmark fades in and scales up
 *   - Amber underline bar slides in
 *   - Tagline fades in below
 *   - Pulses once, then fades out — calls onFinish prop
 *   - Uses only React Native's built-in Animated API (no third-party deps)
 */

import React, { useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, Animated, StatusBar, Dimensions,
} from 'react-native';

const { width } = Dimensions.get('window');

export default function SplashScreen({ navigation, onFinish }) {
  // Animation values
  const logoOpacity    = useRef(new Animated.Value(0)).current;
  const logoScale      = useRef(new Animated.Value(0.8)).current;
  const barWidth       = useRef(new Animated.Value(0)).current;
  const taglineOpacity = useRef(new Animated.Value(0)).current;
  const containerOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.sequence([
      // 1. Logo fades in + scales up
      Animated.parallel([
        Animated.timing(logoOpacity, {
          toValue: 1, duration: 500, useNativeDriver: true,
        }),
        Animated.spring(logoScale, {
          toValue: 1, tension: 120, friction: 8, useNativeDriver: true,
        }),
      ]),

      // 2. Amber underline bar slides in from left
      Animated.timing(barWidth, {
        toValue: 1, duration: 400, useNativeDriver: false,
      }),

      // 3. Tagline fades in
      Animated.timing(taglineOpacity, {
        toValue: 1, duration: 350, useNativeDriver: true,
      }),

      // 4. Hold
      Animated.delay(600),

      // 5. Pulse — scale up slightly
      Animated.spring(logoScale, {
        toValue: 1.05, tension: 180, friction: 6, useNativeDriver: true,
      }),

      // 6. Pulse — scale back
      Animated.spring(logoScale, {
        toValue: 1, tension: 180, friction: 6, useNativeDriver: true,
      }),

      // 7. Hold
      Animated.delay(300),

      // 8. Entire screen fades to black before navigating away
      Animated.timing(containerOpacity, {
        toValue: 0, duration: 400, useNativeDriver: true,
      }),
    ]).start(() => {
      // D7 FIX: App.js registers this screen with no `onFinish` prop — React
      // Navigation only ever injects `navigation`/`route`, so the callback
      // was always undefined and the animation finished into a dead end with
      // no way to reach Login. Navigate directly instead; `onFinish` is kept
      // as an optional override for any future caller that does pass it.
      if (onFinish) {
        onFinish();
      } else if (navigation) {
        navigation.replace('Login');
      }
    });
  }, []);

  const animatedBarWidth = barWidth.interpolate({
    inputRange:  [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <Animated.View style={[styles.container, { opacity: containerOpacity }]}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />

      <View style={styles.logoWrap}>
        {/* Wordmark */}
        <Animated.Text
          style={[
            styles.wordmark,
            { opacity: logoOpacity, transform: [{ scale: logoScale }] },
          ]}
        >
          FLASH
        </Animated.Text>

        {/* Amber underline bar */}
        <Animated.View style={[styles.bar, { width: animatedBarWidth }]} />

        {/* Tagline */}
        <Animated.Text style={[styles.tagline, { opacity: taglineOpacity }]}>
          Fashion. Fast.
        </Animated.Text>
      </View>

      {/* Subtle bottom attribution */}
      <Animated.Text style={[styles.poweredBy, { opacity: taglineOpacity }]}>
        flash.co.za
      </Animated.Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoWrap: {
    alignItems: 'center',
    gap: 12,
  },
  wordmark: {
    fontSize: 64,
    fontWeight: '900',
    color: '#ffffff',
    letterSpacing: 10,
    includeFontPadding: false,
  },
  bar: {
    height: 4,
    backgroundColor: '#f59e0b',
    borderRadius: 2,
    alignSelf: 'stretch',
  },
  tagline: {
    fontSize: 16,
    color: '#9ca3af',
    letterSpacing: 4,
    fontWeight: '400',
    marginTop: 4,
  },
  poweredBy: {
    position: 'absolute',
    bottom: 48,
    color: '#374151',
    fontSize: 12,
    letterSpacing: 2,
  },
});
