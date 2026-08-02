import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable,
  Image, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useFlash } from '../context/FlashContext';
import api from '../services/api';

// Multi-tenant Stage 7 — the customer-facing storefront's individual store
// page. Store profile (banner/logo/name/description) comes from a real
// fetch (GET /api/stores/:storeId); the product grid filters the
// already-loaded `products` array from FlashContext client-side by
// storeId — the same approach HomeScreen.js's dormant filter pill already
// uses, kept consistent rather than a second, inconsistent server-fetch
// pattern for products. Only worth switching to a server-side
// storeId-filtered /api/inventory call if the catalogue ever grows large
// enough that loading "all products" into context stops being viable —
// not the case today.
export default function StoreScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { storeId } = route.params;
  const { products } = useFlash();
  const [store, setStore] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.stores.getById(storeId)
      .then(data => setStore(data.store))
      .catch(e => console.warn('Failed to load store:', e.message))
      .finally(() => setLoading(false));
  }, [storeId]);

  const storeProducts = products.filter(p => p.storeId === storeId);

  if (loading) return <View style={styles.loading}><ActivityIndicator size="large" color="#0a0a0a" /></View>;

  if (!store) {
    return (
      <View style={styles.loading}>
        <Text style={styles.emptyText}>Store not found</Text>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={storeProducts}
      keyExtractor={item => item.id}
      numColumns={2}
      columnWrapperStyle={{ gap: 12 }}
      contentContainerStyle={styles.grid}
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={
        <View style={styles.header}>
          {store.banner_url ? (
            <Image source={{ uri: store.banner_url }} style={styles.banner} />
          ) : (
            <View style={[styles.banner, styles.bannerPlaceholder]} />
          )}
          <View style={styles.headerContent}>
            {store.logo_url ? (
              <Image source={{ uri: store.logo_url }} style={styles.logo} />
            ) : (
              <View style={[styles.logo, styles.logoPlaceholder]}>
                <Ionicons name="storefront-outline" size={24} color="#9ca3af" />
              </View>
            )}
            <Text style={styles.name}>{store.name}</Text>
            {store.description ? <Text style={styles.desc}>{store.description}</Text> : null}
          </View>
        </View>
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Ionicons name="pricetags-outline" size={40} color="#d1d5db" />
          <Text style={styles.emptyText}>No products from this store yet</Text>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable style={styles.card} onPress={() => navigation.navigate('Product', { product: item })}>
          <Image source={{ uri: item.image }} style={styles.productImg} />
          <View style={styles.info}>
            <Text style={styles.productName} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.price}>R{item.price}</Text>
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { backgroundColor: '#fff', marginBottom: 12 },
  banner: { width: '100%', height: 120, backgroundColor: '#e5e7eb' },
  bannerPlaceholder: {},
  headerContent: { padding: 16, marginTop: -28 },
  logo: { width: 56, height: 56, borderRadius: 16, backgroundColor: '#e5e7eb', borderWidth: 3, borderColor: '#fff' },
  logoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 20, fontWeight: '900', color: '#0a0a0a', marginTop: 10 },
  desc: { color: '#6b7280', marginTop: 4, lineHeight: 20 },
  grid: { padding: 16, gap: 12, paddingBottom: 32 },
  card: { flex: 1, backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, elevation: 2 },
  productImg: { width: '100%', height: 180, backgroundColor: '#e5e7eb' },
  info: { padding: 12, gap: 2 },
  productName: { fontWeight: '700', fontSize: 14, color: '#111827' },
  price: { fontWeight: '800', color: '#0a0a0a', fontSize: 15, marginTop: 4 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { color: '#9ca3af', fontWeight: '600' },
});
