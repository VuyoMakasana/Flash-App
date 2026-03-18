import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import driverApi from '../../services/api';

export default function DriverEarningsScreen() {
  const router = useRouter();
  const [data, setData] = useState({ orders: [], totalEarnings: '0.00' });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadEarnings();
  }, []);

  const loadEarnings = async () => {
    try {
      const result = await driverApi.earnings.get();
      setData(result);
    } catch (e) {
      console.warn('Earnings load failed', e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#fff" size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} style={styles.back}>
          <Ionicons name="arrow-back" size={20} color="#fff" />
        </Pressable>
        <Text style={styles.title}>Earnings</Text>
        <View style={{ width: 28 }} />
      </View>

      {/* Summary cards */}
      <View style={styles.summaryRow}>
        <View style={styles.summaryCard}>
          <Ionicons name="cash-outline" size={20} color="#4ade80" />
          <Text style={styles.summaryValue}>R{parseFloat(data.totalEarnings).toFixed(2)}</Text>
          <Text style={styles.summaryLabel}>Total Earned</Text>
        </View>
        <View style={styles.summaryCard}>
          <Ionicons name="checkmark-circle-outline" size={20} color="#60a5fa" />
          <Text style={styles.summaryValue}>{data.orders.length}</Text>
          <Text style={styles.summaryLabel}>Deliveries</Text>
        </View>
        <View style={styles.summaryCard}>
          <Ionicons name="trending-up-outline" size={20} color="#f59e0b" />
          <Text style={styles.summaryValue}>
            R{data.orders.length > 0 ? (parseFloat(data.totalEarnings) / data.orders.length).toFixed(0) : '0'}
          </Text>
          <Text style={styles.summaryLabel}>Avg. Payout</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Delivery History</Text>

      {data.orders.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="cash-outline" size={40} color="#374151" />
          <Text style={styles.emptyTitle}>No deliveries yet</Text>
          <Text style={styles.emptyText}>Complete orders to see earnings here</Text>
        </View>
      ) : (
        <FlatList
          data={data.orders}
          keyExtractor={item => item.order_number}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 10, paddingBottom: 32 }}
          renderItem={({ item }) => (
            <View style={styles.orderItem}>
              <View>
                <Text style={styles.orderNum}>#{item.order_number}</Text>
                <Text style={styles.orderMeta}>
                  {item.item_count} items
                  {item.created_at ? ` • ${new Date(item.created_at).toLocaleDateString('en-ZA')}` : ''}
                </Text>
              </View>
              <View style={styles.payoutBadge}>
                <Text style={styles.payoutAmount}>R{parseFloat(item.driver_payout).toFixed(2)}</Text>
                <View style={styles.paidPill}>
                  <Text style={styles.paidText}>Paid</Text>
                </View>
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  loadingContainer: { flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 56, paddingBottom: 16 },
  back: { padding: 4 },
  title: { color: '#fff', fontSize: 18, fontWeight: '800' },
  summaryRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, marginBottom: 20 },
  summaryCard: { flex: 1, backgroundColor: '#1e293b', borderRadius: 16, padding: 14, alignItems: 'center', gap: 4 },
  summaryValue: { color: '#fff', fontSize: 20, fontWeight: '900', marginTop: 4 },
  summaryLabel: { color: '#64748b', fontSize: 11, fontWeight: '600' },
  sectionTitle: { color: '#94a3b8', fontWeight: '700', fontSize: 13, paddingHorizontal: 16, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  orderItem: { backgroundColor: '#1e293b', borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: '#334155' },
  orderNum: { color: '#f1f5f9', fontWeight: '800' },
  orderMeta: { color: '#64748b', marginTop: 2, fontSize: 13 },
  payoutBadge: { alignItems: 'flex-end', gap: 4 },
  payoutAmount: { color: '#4ade80', fontWeight: '900', fontSize: 18 },
  paidPill: { backgroundColor: '#052e16', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  paidText: { color: '#4ade80', fontSize: 11, fontWeight: '700' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32 },
  emptyTitle: { color: '#f1f5f9', fontSize: 18, fontWeight: '800' },
  emptyText: { color: '#64748b', textAlign: 'center' },
});
