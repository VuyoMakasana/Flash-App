import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable,
  Alert, ActivityIndicator, RefreshControl, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';

export default function TrustedDriversScreen({ navigation }) {
  const [trusted, setTrusted]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.trustedDrivers.getAll();
      setTrusted(data.trustedDrivers || []);
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleRemove = (driverId, name) => {
    Alert.alert(
      'Remove Trusted Driver',
      `Remove ${name} from your trusted drivers?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: async () => {
            try {
              await api.trustedDrivers.remove(driverId);
              setTrusted(prev => prev.filter(d => d.driver_id !== driverId));
            } catch (e) { Alert.alert('Error', e.message); }
          },
        },
      ]
    );
  };

  const renderDriver = ({ item: d }) => (
    <View style={s.card}>
      {/* Avatar */}
      <View style={s.avatarWrap}>
        {d.profile_photo_url
          ? <Image source={{ uri: d.profile_photo_url }} style={s.avatar} />
          : <View style={s.avatarFallback}><Ionicons name="person" size={24} color="#9ca3af" /></View>
        }
        {/* Online dot */}
        <View style={[s.onlineDot, { backgroundColor: d.is_online ? '#10b981' : '#d1d5db' }]} />
      </View>

      <View style={{ flex: 1 }}>
        <Text style={s.name}>{d.name}</Text>
        <View style={s.metaRow}>
          <Ionicons name="star" size={12} color="#f59e0b" />
          <Text style={s.meta}>{parseFloat(d.rating).toFixed(1)}</Text>
          <Text style={s.metaSep}>·</Text>
          <Text style={s.meta}>{d.total_deliveries} trips</Text>
          <Text style={s.metaSep}>·</Text>
          <Text style={s.meta}>{d.vehicle_type}</Text>
        </View>

        {/* Status */}
        {d.is_busy ? (
          <View style={s.busyTag}>
            <Ionicons name="time-outline" size={12} color="#ef4444" />
            <Text style={s.busyTagText}>Currently on a delivery</Text>
          </View>
        ) : d.is_online ? (
          <View style={s.onlineTag}>
            <Ionicons name="checkmark-circle" size={12} color="#10b981" />
            <Text style={s.onlineTagText}>Available now</Text>
          </View>
        ) : (
          <Text style={s.offlineText}>Offline</Text>
        )}
      </View>

      <Pressable style={s.removeBtn} onPress={() => handleRemove(d.driver_id, d.name)}>
        <Ionicons name="close-circle-outline" size={22} color="#9ca3af" />
      </Pressable>
    </View>
  );

  if (loading) {
    return <View style={s.center}><ActivityIndicator size="large" color="#0a0a0a" /></View>;
  }

  return (
    <FlatList
      data={trusted}
      keyExtractor={d => d.driver_id}
      renderItem={renderDriver}
      contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListHeaderComponent={
        <View style={s.header}>
          <Text style={s.headerTitle}>My Trusted Drivers</Text>
          <Text style={s.headerSub}>
            These drivers have accepted your trust request. You can request them specifically at checkout.
          </Text>
        </View>
      }
      ListEmptyComponent={
        <View style={s.empty}>
          <Ionicons name="people-outline" size={48} color="#d1d5db" />
          <Text style={s.emptyTitle}>No trusted drivers yet</Text>
          <Text style={s.emptyText}>
            After a great delivery, tap the driver's profile to send a trust request.
          </Text>
        </View>
      }
    />
  );
}

const s = StyleSheet.create({
  list:   { padding: 16, gap: 12, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { marginBottom: 8 },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#111827', marginBottom: 6 },
  headerSub:   { fontSize: 13, color: '#6b7280', lineHeight: 19 },
  card:   { backgroundColor: '#fff', borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  avatarWrap: { position: 'relative' },
  avatar:     { width: 52, height: 52, borderRadius: 16, backgroundColor: '#e5e7eb' },
  avatarFallback: { width: 52, height: 52, borderRadius: 16, backgroundColor: '#f3f4f6', alignItems: 'center', justifyContent: 'center' },
  onlineDot:  { position: 'absolute', bottom: 2, right: 2, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: '#fff' },
  name:     { fontWeight: '800', color: '#111827', fontSize: 15 },
  metaRow:  { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  meta:     { color: '#6b7280', fontSize: 12 },
  metaSep:  { color: '#d1d5db', fontSize: 12 },
  busyTag:  { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  busyTagText: { color: '#ef4444', fontSize: 12, fontWeight: '600' },
  onlineTag:   { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  onlineTagText: { color: '#10b981', fontSize: 12, fontWeight: '600' },
  offlineText:   { color: '#9ca3af', fontSize: 12, marginTop: 6 },
  removeBtn:     { padding: 4 },
  empty:      { alignItems: 'center', gap: 12, paddingTop: 60, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#374151' },
  emptyText:  { fontSize: 13, color: '#9ca3af', textAlign: 'center', lineHeight: 19 },
});
