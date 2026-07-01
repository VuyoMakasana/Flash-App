/**
 * flash-driver-app/app/driver/notifications.js
 *
 * MEDIUM-6 FIX: New notifications screen for the driver app.
 *   Lists all push notifications received by the driver.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import driverApi from '../../services/api';

const ICON_MAP = {
  new_order:      { name: 'bag-outline',          color: '#f59e0b' },
  trust_request:  { name: 'person-add-outline',   color: '#10b981' },
  earnings:       { name: 'cash-outline',          color: '#10b981' },
  fleet_alert:    { name: 'trending-up-outline',  color: '#f59e0b' },
  system:         { name: 'information-circle-outline', color: '#3b82f6' },
};

function getIcon(type) {
  return ICON_MAP[type] || ICON_MAP.system;
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)  return 'Just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export default function DriverNotifications() {
  const router = useRouter();
  const [notifications, setNotifications] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);

  const loadNotifications = useCallback(async () => {
    try {
      setError(null);
      const data = await driverApi.notifications?.getAll?.() ?? { notifications: [] };
      setNotifications(data.notifications || []);
    } catch (e) {
      setError('Could not load notifications. Pull down to retry.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadNotifications(); }, [loadNotifications]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadNotifications();
    setRefreshing(false);
  }, [loadNotifications]);

  const renderItem = ({ item }) => {
    const { name: iconName, color: iconColor } = getIcon(item.type);
    return (
      <View style={[styles.item, !item.read_at && styles.itemUnread]}>
        <View style={[styles.iconWrap, { backgroundColor: iconColor + '20' }]}>
          <Ionicons name={iconName} size={20} color={iconColor} />
        </View>
        <View style={styles.itemBody}>
          <Text style={styles.itemTitle}>{item.title}</Text>
          <Text style={styles.itemMessage} numberOfLines={2}>{item.message}</Text>
          <Text style={styles.itemTime}>{timeAgo(item.created_at)}</Text>
        </View>
        {!item.read_at && <View style={styles.dot} />}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Notifications</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#f59e0b" />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={40} color="#6b7280" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={loadNotifications}>
            <Text style={styles.retryBtnText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f59e0b" />
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name="notifications-off-outline" size={48} color="#374151" />
              <Text style={styles.emptyTitle}>No notifications yet</Text>
              <Text style={styles.emptyBody}>New orders, alerts and updates will appear here.</Text>
            </View>
          }
          contentContainerStyle={notifications.length === 0 ? { flex: 1 } : { paddingBottom: 40 }}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0a0a0a' },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, paddingTop: 60 },
  backBtn:      { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title:        { color: '#fff', fontSize: 18, fontWeight: '700' },
  centered:     { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  errorText:    { color: '#9ca3af', fontSize: 14, textAlign: 'center' },
  retryBtn:     { backgroundColor: '#f59e0b', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  retryBtnText: { color: '#0a0a0a', fontWeight: '700' },
  item:         { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  itemUnread:   { backgroundColor: '#111' },
  iconWrap:     { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  itemBody:     { flex: 1, gap: 3 },
  itemTitle:    { color: '#fff', fontSize: 14, fontWeight: '600' },
  itemMessage:  { color: '#9ca3af', fontSize: 13 },
  itemTime:     { color: '#6b7280', fontSize: 11, marginTop: 2 },
  dot:          { width: 8, height: 8, borderRadius: 4, backgroundColor: '#f59e0b', marginTop: 6, flexShrink: 0 },
  separator:    { height: 1, backgroundColor: '#1a1a1a' },
  emptyWrap:    { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40 },
  emptyTitle:   { color: '#9ca3af', fontSize: 16, fontWeight: '600' },
  emptyBody:    { color: '#6b7280', fontSize: 13, textAlign: 'center' },
});
