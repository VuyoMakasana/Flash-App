// NEW SCREEN: Store Credits
// WHY: Users receive store credits when returns are picked up by a driver.
// Previously there was no screen to view the credit balance — users who missed
// the socket notification had no way to find out they had credits.

import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import api from '../services/api';

export default function StoreCreditsScreen() {
  const navigation = useNavigation();
  const [credits, setCredits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await api.returns.getCredits();
        const list = data.credits || [];
        setCredits(list);
        const available = list
          .filter(c => !c.expires_at || new Date(c.expires_at) > new Date())
          .reduce((sum, c) => sum + parseFloat(c.balance || 0), 0);
        setTotal(available);
      } catch (e) {
        // silently fail — show empty state
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0a0a0a" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Available Store Credit</Text>
        <Text style={styles.balanceAmount}>R{total.toFixed(2)}</Text>
        <Text style={styles.balanceNote}>Valid for 90 days from issue date</Text>
      </View>

      {credits.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="gift-outline" size={48} color="#d1d5db" />
          <Text style={styles.emptyTitle}>No store credits yet</Text>
          <Text style={styles.emptyText}>Credits are issued when your returns are collected.</Text>
        </View>
      ) : (
        <FlatList
          data={credits}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const expired = item.expires_at && new Date(item.expires_at) < new Date();
            return (
              <View style={[styles.creditCard, expired && styles.creditCardExpired]}>
                <View style={styles.creditRow}>
                  <Text style={styles.creditAmount}>R{parseFloat(item.balance || 0).toFixed(2)}</Text>
                  <View style={[styles.badge, expired ? styles.badgeExpired : styles.badgeActive]}>
                    <Text style={styles.badgeText}>{expired ? 'Expired' : 'Active'}</Text>
                  </View>
                </View>
                <Text style={styles.creditReason}>{item.reason || 'Return credit'}</Text>
                {item.expires_at && (
                  <Text style={styles.creditExpiry}>
                    {expired ? 'Expired' : 'Expires'} {new Date(item.expires_at).toLocaleDateString('en-ZA')}
                  </Text>
                )}
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  balanceCard: { backgroundColor: '#0a0a0a', padding: 28, alignItems: 'center' },
  balanceLabel: { color: '#9ca3af', fontWeight: '600', fontSize: 13 },
  balanceAmount: { color: '#fff', fontSize: 40, fontWeight: '900', marginTop: 6 },
  balanceNote: { color: '#6b7280', fontSize: 12, marginTop: 8 },
  list: { padding: 16, gap: 12 },
  creditCard: { backgroundColor: '#fff', borderRadius: 14, padding: 16, gap: 6, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  creditCardExpired: { opacity: 0.5 },
  creditRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  creditAmount: { fontSize: 22, fontWeight: '800', color: '#0a0a0a' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  badgeActive: { backgroundColor: '#dcfce7' },
  badgeExpired: { backgroundColor: '#f3f4f6' },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#374151' },
  creditReason: { color: '#6b7280', fontSize: 13 },
  creditExpiry: { color: '#9ca3af', fontSize: 12 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: '#0a0a0a' },
  emptyText: { color: '#9ca3af', textAlign: 'center' },
});
