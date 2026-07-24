import React, { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable,
  Image, TextInput, ScrollView, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useFlash } from '../context/FlashContext';

const CATEGORIES = ['All', 'Men', 'Women', 'Sports', 'Casual'];

export default function HomeScreen() {
  const navigation = useNavigation();
  const { products, cart, user } = useFlash();
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');
  // ADDED: Store filter for multi-shop support — shows products from all shops by default
  // WHY: Backend supports store_id per product. Without this UI filter, two shops'
  // products appear in one undifferentiated list with no way to browse by shop.
  const [activeStore, setActiveStore] = useState('all');

  const cartCount = cart.reduce((sum, i) => sum + i.quantity, 0);

  // Build unique store list from products — 'all' is always first
  const stores = ['all', ...Array.from(new Set(products.map(p => p.storeId).filter(Boolean)))];

  const filtered = products.filter(p => {
    const matchCat = activeCategory === 'All' || p.category === activeCategory;
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase());
    // Filter by selected store — 'all' shows every product
    const matchStore = activeStore === 'all' || p.storeId === activeStore;
    return matchCat && matchSearch && matchStore;
  });

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Hey {user?.name?.split(' ')[0] || 'there'}</Text>
          <Text style={styles.sub}>What are we wearing today?</Text>
        </View>
        <Pressable style={styles.cartBtn} onPress={() => navigation.navigate('Cart')}>
          <Ionicons name="bag-outline" size={22} color="#0a0a0a" />
          {cartCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{cartCount}</Text>
            </View>
          )}
        </Pressable>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <Ionicons name="search-outline" size={18} color="#9ca3af" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search drops..."
          placeholderTextColor="#9ca3af"
          value={search}
          onChangeText={setSearch}
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={18} color="#9ca3af" />
          </Pressable>
        )}
      </View>

      {/* Store filter — only shows when there are multiple shops */}
      {stores.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.cats} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
          {stores.map(store => (
            <Pressable
              key={store}
              style={[styles.cat, activeStore === store && styles.catActive]}
              onPress={() => setActiveStore(store)}
            >
              <Text style={[styles.catText, activeStore === store && styles.catTextActive]}>
                {store === 'all' ? 'All Shops' : store}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* Categories */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.cats} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
        {CATEGORIES.map(cat => (
          <Pressable
            key={cat}
            style={[styles.cat, activeCategory === cat && styles.catActive]}
            onPress={() => setActiveCategory(cat)}
          >
            <Text style={[styles.catText, activeCategory === cat && styles.catTextActive]}>{cat}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Products */}
      <FlatList
        data={filtered}
        keyExtractor={item => item.id}
        numColumns={2}
        columnWrapperStyle={{ gap: 12 }}
        contentContainerStyle={styles.grid}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="search-outline" size={40} color="#d1d5db" />
            <Text style={styles.emptyText}>No results found</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => navigation.navigate('Product', { product: item })}>
            <Image source={{ uri: item.image }} style={styles.img} />
            {item.badge && (
              <View style={styles.badgeTag}>
                <Text style={styles.badgeTagText}>{item.badge}</Text>
              </View>
            )}
            <View style={styles.info}>
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.cat2}>{item.category}</Text>
              <Text style={styles.price}>R{item.price}</Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  greeting: { fontSize: 22, fontWeight: '800', color: '#0a0a0a' },
  sub: { color: '#6b7280', marginTop: 2 },
  cartBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8, elevation: 2 },
  badge: { position: 'absolute', top: -4, right: -4, backgroundColor: '#0a0a0a', borderRadius: 10, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  searchRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', marginHorizontal: 16, marginVertical: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, gap: 8, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, elevation: 1 },
  searchInput: { flex: 1, color: '#111827', fontSize: 15 },
  cats: { marginBottom: 8 },
  cat: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: '#e5e7eb' },
  catActive: { backgroundColor: '#0a0a0a' },
  catText: { fontWeight: '700', color: '#374151' },
  catTextActive: { color: '#fff' },
  grid: { padding: 16, gap: 12, paddingBottom: 32 },
  card: { flex: 1, backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, elevation: 2 },
  img: { width: '100%', height: 180, backgroundColor: '#e5e7eb' },
  badgeTag: { position: 'absolute', top: 10, left: 10, backgroundColor: '#0a0a0a', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  badgeTagText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  info: { padding: 12, gap: 2 },
  name: { fontWeight: '700', fontSize: 14, color: '#111827' },
  cat2: { color: '#9ca3af', fontSize: 12 },
  price: { fontWeight: '800', color: '#0a0a0a', fontSize: 15, marginTop: 4 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { color: '#9ca3af', fontWeight: '600' },
});
