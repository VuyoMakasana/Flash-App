import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useFlash } from '../context/FlashContext';

const STATUS_COLOR = {
  created: '#f59e0b',
  payment_pending: '#f59e0b',
  paid: '#3b82f6',
  driver_assigned: '#8b5cf6',
  // FIX 4: Uses active transit state from backend
  in_transit: '#8b5cf6',
  picked_up: '#0ea5e9',
  delivered: '#10b981',
  completed: '#10b981',
  cancelled: '#ef4444',
};

export default function OrdersScreen() {
  const navigation = useNavigation();
  const { orders, fetchOrders } = useFlash();
  // FlashContext's `loading` flag only covers initial app hydration (reading
  // stored tokens on launch) — by the time this screen mounts, that's
  // already false, so using it here let the empty state flash briefly
  // before fetchOrders()'s response actually arrived. This tracks the
  // fetch itself instead.
  const [ordersLoading, setOrdersLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setOrdersLoading(true);
      await fetchOrders();
      setOrdersLoading(false);
    })();
  }, []);

  if (ordersLoading) {
    return <View style={styles.center}><ActivityIndicator size="large" color="#0a0a0a" /></View>;
  }

  if (!orders.length) {
    return (
      <View style={styles.empty}>
        <Ionicons name="receipt-outline" size={56} color="#d1d5db" />
        <Text style={styles.emptyTitle}>No orders yet</Text>
        <Text style={styles.emptySub}>Your order history will appear here.</Text>
        <Pressable style={styles.shopBtn} onPress={() => navigation.navigate('Shop')}>
          <Text style={styles.shopText}>Start Shopping</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <FlatList
      data={orders}
      keyExtractor={o => String(o.id)}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => {
        const color = STATUS_COLOR[item.status] || '#6b7280';
        return (
          <Pressable style={styles.card} onPress={() => navigation.navigate('OrderStatus', { order: item })}>
            <View style={styles.row}>
              <View>
                <Text style={styles.orderNum}>Order #{item.order_number || item.id?.slice(0, 8)}</Text>
                <Text style={styles.date}>{item.created_at ? new Date(item.created_at).toLocaleDateString() : 'Recent'}</Text>
              </View>
              <View style={[styles.statusBadge, { backgroundColor: color + '20' }]}>
                <Text style={[styles.statusText, { color }]}>{item.status?.replace(/_/g, ' ').toUpperCase()}</Text>
              </View>
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={styles.items}>{item.items?.length || 0} item(s)</Text>
              <Text style={styles.total}>R{item.total}</Text>
            </View>
            {['driver_assigned', 'driver_arrived_store', 'in_transit', 'picked_up'].includes(item.status) && (
              <Pressable style={styles.trackBtn} onPress={() => navigation.navigate('Tracking', { orderId: item.id })}>
                <Ionicons name="location" size={14} color="#fff" />
                <Text style={styles.trackText}>Track Live</Text>
              </Pressable>
            )}
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12, paddingBottom: 32 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  orderNum: { fontWeight: '800', color: '#111827', fontSize: 15 },
  date: { color: '#9ca3af', fontSize: 12, marginTop: 2 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  statusText: { fontSize: 11, fontWeight: '700' },
  divider: { height: 1, backgroundColor: '#f3f4f6' },
  items: { color: '#6b7280', fontWeight: '600' },
  total: { fontWeight: '900', fontSize: 17, color: '#0a0a0a' },
  trackBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#0a0a0a', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, alignSelf: 'flex-start' },
  trackText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: '#0a0a0a' },
  emptySub: { color: '#9ca3af' },
  shopBtn: { backgroundColor: '#0a0a0a', paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14 },
  shopText: { color: '#fff', fontWeight: '800' },
});
