import React from 'react';
import { View, Text, FlatList, Image, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useFlash } from '../context/FlashContext';

export default function CartScreen() {
  const navigation = useNavigation();
  const { cart, updateCartQuantity, removeCartItem } = useFlash();

  const subtotal = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);

  if (!cart.length) {
    return (
      <View style={styles.empty}>
        <Ionicons name="bag-outline" size={56} color="#d1d5db" />
        <Text style={styles.emptyTitle}>Your cart is empty</Text>
        <Text style={styles.emptySub}>Browse drops and add something.</Text>
        <Pressable style={styles.browse} onPress={() => navigation.navigate('Home')}>
          <Text style={styles.browseText}>Browse Drops</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={cart}
        keyExtractor={i => `${i.productId}-${i.size}`}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Image source={{ uri: item.image }} style={styles.img} />
            <View style={styles.info}>
              <Text style={styles.name} numberOfLines={2}>{item.name}</Text>
              <Text style={styles.meta}>Size {item.size}</Text>
              <Text style={styles.price}>R{item.price * item.quantity}</Text>
              <View style={styles.qtyRow}>
                <Pressable style={styles.qBtn} onPress={() => updateCartQuantity(item.productId, item.size, item.quantity - 1)}>
                  <Ionicons name="remove" size={16} color="#111827" />
                </Pressable>
                <Text style={styles.qty}>{item.quantity}</Text>
                <Pressable style={styles.qBtn} onPress={() => updateCartQuantity(item.productId, item.size, item.quantity + 1)}>
                  <Ionicons name="add" size={16} color="#111827" />
                </Pressable>
              </View>
            </View>
            <Pressable style={styles.remove} onPress={() => removeCartItem(item.productId, item.size)}>
              <Ionicons name="trash-outline" size={18} color="#ef4444" />
            </Pressable>
          </View>
        )}
      />

      <View style={styles.footer}>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Subtotal ({cart.reduce((s, i) => s + i.quantity, 0)} items)</Text>
          <Text style={styles.summaryValue}>R{subtotal}</Text>
        </View>
        <Pressable style={styles.checkoutBtn} onPress={() => navigation.navigate('Checkout')}>
          <Ionicons name="flash" size={18} color="#fff" />
          <Text style={styles.checkoutText}>Proceed to Checkout</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  list: { padding: 16, gap: 12, paddingBottom: 20 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 12, flexDirection: 'row', gap: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  img: { width: 80, height: 80, borderRadius: 12, backgroundColor: '#e5e7eb' },
  info: { flex: 1, gap: 4 },
  name: { fontWeight: '700', color: '#111827', fontSize: 14 },
  meta: { color: '#9ca3af', fontSize: 12 },
  price: { fontWeight: '800', color: '#0a0a0a', fontSize: 16 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  qBtn: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#f3f4f6', alignItems: 'center', justifyContent: 'center' },
  qty: { fontWeight: '800', fontSize: 16, color: '#0a0a0a', minWidth: 24, textAlign: 'center' },
  remove: { padding: 4, alignSelf: 'flex-start' },
  footer: { backgroundColor: '#fff', padding: 20, gap: 14, borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between' },
  summaryLabel: { color: '#6b7280', fontWeight: '600' },
  summaryValue: { fontWeight: '800', fontSize: 18, color: '#0a0a0a' },
  checkoutBtn: { backgroundColor: '#0a0a0a', paddingVertical: 16, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  checkoutText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, backgroundColor: '#f7f7f7' },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: '#0a0a0a' },
  emptySub: { color: '#9ca3af' },
  browse: { backgroundColor: '#0a0a0a', paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14 },
  browseText: { color: '#fff', fontWeight: '800' },
});
