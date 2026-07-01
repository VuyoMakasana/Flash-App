/**
 * flash-user-app/screens/NotificationsScreen.js
 *
 * MEDIUM-5 FIX: New notifications screen for the user app.
 *   - Lists all push notifications received by the user
 *   - Unread indicator dot
 *   - Pull to refresh
 *   - Mark all as read
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import api from '../services/api';

const TYPE_MAP = {
  order_update:   { icon: 'bag-outline',          color: '#f59e0b' },
  payment:        { icon: 'card-outline',          color: '#10b981' },
  driver_assigned:{ icon: 'car-outline',           color: '#3b82f6' },
  delivered:      { icon: 'checkmark-circle-outline', color: '#10b981' },
  trust_response: { icon: 'people-outline',        color: '#8b5cf6' },
  system:         { icon: 'information-circle-outline', color: '#6b7280' },
};

function getType(type) {
  return TYPE_MAP[type] || TYPE_MAP.system;
}

function timeAgo(dateStr) {
  const diff  = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)  return 'Just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export default function NotificationsScreen() {
  const navigation = useNavigation();
  const [notifications, setNotifications] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await api.notifications.getAll();
      setNotifications(data.notifications || []);
    } catch (e) {
      setError('Could not load notifications. Pull down to retry.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const markAllRead = useCallback(async () => {
    try {
      await api.notifications.markAllRead();
      setNotifications(prev => prev.map(n => ({ ...n, read_at: new Date().toISOString() })));
    } catch (e) {}
  }, []);

  const unreadCount = notifications.filter(n => !n.read_at).length;

  const renderItem = ({ item }) => {
    const { icon, color } = getType(item.type);
    return (
      <View style={[styles.item, !item.read_at && styles.itemUnread]}>
        <View style={[styles.iconWrap, { backgroundColor: color + '22' }]}>
          <Ionicons name={icon} size={20} color={color} />
        </View>
        <View style={styles.itemBody}>
          <Text style={styles.itemTitle}>{item.title}</Text>
          <Text style={styles.itemMessage} numberOfLines={3}>{item.message}</Text>
          <Text style={styles.itemTime}>{timeAgo(item.created_at)}</Text>
        </View>
        {!item.read_at && <View style={styles.dot} />}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>
          Notifications{unreadCount > 0 ? ` (${unreadCount})` : ''}
        </Text>
        {unreadCount > 0 ? (
          <TouchableOpacity onPress={markAllRead}>
            <Text style={styles.markAll}>Mark all read</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ width: 72 }} />
        )}
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#f59e0b" />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={40} color="#6b7280" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={load}>
            <Text style={styles.retryText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f59e0b" />}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name="notifications-off-outline" size={48} color="#374151" />
              <Text style={styles.emptyTitle}>No notifications yet</Text>
              <Text style={styles.emptyBody}>Order updates and delivery alerts will appear here.</Text>
            </View>
          }
          contentContainerStyle={notifications.length === 0 ? { flex: 1 } : { paddingBottom: 40 }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0a0a0a' },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16 },
  backBtn:      { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title:        { color: '#fff', fontSize: 18, fontWeight: '700' },
  markAll:      { color: '#f59e0b', fontSize: 13, fontWeight: '600' },
  centered:     { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  errorText:    { color: '#9ca3af', fontSize: 14, textAlign: 'center' },
  retryBtn:     { backgroundColor: '#f59e0b', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  retryText:    { color: '#0a0a0a', fontWeight: '700' },
  item:         { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  itemUnread:   { backgroundColor: '#0f0f0f' },
  iconWrap:     { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  itemBody:     { flex: 1, gap: 3 },
  itemTitle:    { color: '#fff', fontSize: 14, fontWeight: '600' },
  itemMessage:  { color: '#9ca3af', fontSize: 13, lineHeight: 18 },
  itemTime:     { color: '#6b7280', fontSize: 11, marginTop: 2 },
  dot:          { width: 8, height: 8, borderRadius: 4, backgroundColor: '#f59e0b', marginTop: 6, flexShrink: 0 },
  sep:          { height: 1, backgroundColor: '#1a1a1a' },
  emptyWrap:    { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40 },
  emptyTitle:   { color: '#9ca3af', fontSize: 16, fontWeight: '600' },
  emptyBody:    { color: '#6b7280', fontSize: 13, textAlign: 'center' },
});
