import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable,
  Image, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import api from '../services/api';

// Multi-tenant Stage 7 — the customer-facing storefront's real store
// directory. Structured for real pagination (page/hasMore/onEndReached,
// same pattern FeedScreen.js already uses for /api/feed) even though a
// plain list is functionally enough at Flash's one real store today.
export default function StoreDirectoryScreen() {
  const navigation = useNavigation();
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadStores = useCallback(async (pageNum = 1, append = false) => {
    try {
      const data = await api.stores.getAll(`?page=${pageNum}&limit=20`);
      setStores(prev => (append ? [...prev, ...data.stores] : data.stores));
      setHasMore(data.stores.length === 20);
      setPage(pageNum);
    } catch (e) {
      console.warn('Failed to load stores:', e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => { loadStores(); }, [loadStores]);

  const onRefresh = () => { setRefreshing(true); loadStores(1, false); };

  const loadMore = () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    loadStores(page + 1, true);
  };

  if (loading) return <View style={styles.loading}><ActivityIndicator size="large" color="#0a0a0a" /></View>;

  return (
    <View style={styles.container}>
      <FlatList
        data={stores}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="storefront-outline" size={40} color="#d1d5db" />
            <Text style={styles.emptyText}>No stores available yet</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => navigation.navigate('Store', { storeId: item.id })}>
            {item.logo_url ? (
              <Image source={{ uri: item.logo_url }} style={styles.logo} />
            ) : (
              <View style={[styles.logo, styles.logoPlaceholder]}>
                <Ionicons name="storefront-outline" size={24} color="#9ca3af" />
              </View>
            )}
            <View style={styles.info}>
              <Text style={styles.name}>{item.name}</Text>
              {item.description ? (
                <Text style={styles.desc} numberOfLines={2}>{item.description}</Text>
              ) : item.address ? (
                <Text style={styles.desc} numberOfLines={1}>{item.address}</Text>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color="#9ca3af" />
          </Pressable>
        )}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ padding: 16 }} color="#0a0a0a" /> : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: 16, gap: 12 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: 16, padding: 14, marginBottom: 12,
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, elevation: 2,
  },
  logo: { width: 52, height: 52, borderRadius: 14, backgroundColor: '#e5e7eb' },
  logoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  info: { flex: 1, gap: 2 },
  name: { fontWeight: '800', fontSize: 16, color: '#0a0a0a' },
  desc: { color: '#6b7280', fontSize: 13 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { color: '#9ca3af', fontWeight: '600' },
});
