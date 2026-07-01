/**
 * flash-user-app/screens/SettingsScreen.js
 *
 * MEDIUM-5 FIX: New settings screen for the user app.
 *   - Notification preferences (order updates, promotions)
 *   - Dark mode (always on — informational)
 *   - Privacy policy
 *   - Account deletion
 */

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Switch, Alert, Linking, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useFlash } from '../context/FlashContext';
import api from '../services/api';

export default function SettingsScreen() {
  const navigation = useNavigation();
  const { logout } = useFlash();

  const [pushOrders,  setPushOrders]  = useState(true);
  const [pushPromos,  setPushPromos]  = useState(true);
  const [deleting,    setDeleting]    = useState(false);

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This will permanently delete your account, order history, and all personal data. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Forever',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await api.user.deleteAccount();
              await logout();
            } catch (e) {
              Alert.alert('Error', e.message || 'Could not delete account. Contact support@flash.co.za');
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  const Row = ({ icon, iconColor = '#f59e0b', label, children, onPress, destructive }) => (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={onPress ? 0.7 : 1}
    >
      <View style={[styles.iconWrap, { backgroundColor: destructive ? '#2d0a0a' : '#1f1f1f' }]}>
        <Ionicons name={icon} size={20} color={destructive ? '#ef4444' : iconColor} />
      </View>
      <Text style={[styles.rowLabel, destructive && { color: '#ef4444' }]}>{label}</Text>
      <View style={styles.rowRight}>{children}</View>
    </TouchableOpacity>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 36 }} />
      </View>

      {/* Notifications */}
      <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>
      <View style={styles.card}>
        <Row icon="bag-outline" label="Order status updates">
          <Switch
            value={pushOrders}
            onValueChange={setPushOrders}
            trackColor={{ false: '#374151', true: '#f59e0b' }}
            thumbColor="#fff"
          />
        </Row>
        <View style={styles.divider} />
        <Row icon="pricetag-outline" label="Flash deals & promotions">
          <Switch
            value={pushPromos}
            onValueChange={setPushPromos}
            trackColor={{ false: '#374151', true: '#f59e0b' }}
            thumbColor="#fff"
          />
        </Row>
      </View>

      {/* Appearance */}
      <Text style={styles.sectionLabel}>APPEARANCE</Text>
      <View style={styles.card}>
        <Row icon="moon-outline" label="Dark mode">
          <Text style={styles.pill}>Always On</Text>
        </Row>
      </View>

      {/* Account */}
      <Text style={styles.sectionLabel}>ACCOUNT</Text>
      <View style={styles.card}>
        <Row
          icon="location-outline"
          label="Saved Addresses"
          onPress={() => navigation.navigate('AddressScreen')}
        >
          <Ionicons name="chevron-forward" size={16} color="#6b7280" />
        </Row>
      </View>

      {/* Support */}
      <Text style={styles.sectionLabel}>SUPPORT</Text>
      <View style={styles.card}>
        <Row
          icon="document-text-outline"
          label="Privacy Policy"
          onPress={() => Linking.openURL('https://flash.co.za/privacy')}
        >
          <Ionicons name="chevron-forward" size={16} color="#6b7280" />
        </Row>
        <View style={styles.divider} />
        <Row
          icon="help-circle-outline"
          label="Help & Support"
          onPress={() => Linking.openURL('mailto:support@flash.co.za')}
        >
          <Ionicons name="chevron-forward" size={16} color="#6b7280" />
        </Row>
        <View style={styles.divider} />
        <Row
          icon="star-outline"
          label="Rate Flash on the App Store"
          onPress={() => Linking.openURL('https://apps.apple.com/app/flash')}
        >
          <Ionicons name="chevron-forward" size={16} color="#6b7280" />
        </Row>
      </View>

      {/* Danger zone */}
      <Text style={styles.sectionLabel}>DANGER ZONE</Text>
      <View style={styles.card}>
        <Row
          icon="trash-outline"
          label="Delete Account"
          destructive
          onPress={handleDeleteAccount}
        >
          {deleting
            ? <ActivityIndicator size="small" color="#ef4444" />
            : <Ionicons name="chevron-forward" size={16} color="#ef4444" />
          }
        </Row>
      </View>

      <Text style={styles.version}>Flash v1.0.0 · flash.co.za</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0a0a0a' },
  content:      { paddingBottom: 60 },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16 },
  backBtn:      { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title:        { color: '#fff', fontSize: 18, fontWeight: '700' },
  sectionLabel: { color: '#6b7280', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginHorizontal: 20, marginTop: 24, marginBottom: 8 },
  card:         { marginHorizontal: 16, backgroundColor: '#1a1a1a', borderRadius: 16, overflow: 'hidden' },
  row:          { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 14, minHeight: 56 },
  iconWrap:     { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowLabel:     { flex: 1, color: '#fff', fontSize: 15 },
  rowRight:     { flexDirection: 'row', alignItems: 'center' },
  divider:      { height: 1, backgroundColor: '#272727', marginLeft: 66 },
  pill:         { color: '#9ca3af', fontSize: 13, backgroundColor: '#272727', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  version:      { color: '#4b5563', fontSize: 12, textAlign: 'center', marginTop: 40 },
});
