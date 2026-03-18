import React, { useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, ScrollView, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useFlash } from '../context/FlashContext';

export default function ProductScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { product } = route.params;
  const { addToCart, cart } = useFlash();
  const [selectedSize, setSelectedSize] = useState(null);
  const [quantity, setQuantity] = useState(1);

  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);

  const handleAddToCart = () => {
    if (!selectedSize) {
      Alert.alert('Select a size', 'Please choose a size before adding to cart.');
      return;
    }
    addToCart(product, selectedSize, quantity);
    Alert.alert('Added to cart', `${product.name} (${selectedSize}) x${quantity} added.`, [
      { text: 'Keep browsing', style: 'cancel' },
      { text: 'View Cart', onPress: () => navigation.navigate('Cart') },
    ]);
  };

  return (
    <View style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Image source={{ uri: product.image }} style={styles.img} />

        {/* Back + Cart */}
        <View style={styles.topRow}>
          <Pressable style={styles.iconBtn} onPress={() => navigation.goBack()}>
            <Ionicons name="arrow-back" size={20} color="#0a0a0a" />
          </Pressable>
          <Pressable style={styles.iconBtn} onPress={() => navigation.navigate('Cart')}>
            <Ionicons name="bag-outline" size={20} color="#0a0a0a" />
            {cartCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{cartCount}</Text>
              </View>
            )}
          </Pressable>
        </View>

        <View style={styles.content}>
          {product.badge && <View style={styles.tag}><Text style={styles.tagText}>{product.badge}</Text></View>}
          <Text style={styles.name}>{product.name}</Text>
          <Text style={styles.category}>{product.category}</Text>
          <Text style={styles.price}>R{product.price}</Text>
          <Text style={styles.desc}>{product.description}</Text>

          {/* Sizes */}
          <Text style={styles.label}>Select Size</Text>
          <View style={styles.sizes}>
            {product.sizes.map(size => (
              <Pressable
                key={size}
                style={[styles.sizeBtn, selectedSize === size && styles.sizeBtnActive]}
                onPress={() => setSelectedSize(size)}
              >
                <Text style={[styles.sizeText, selectedSize === size && styles.sizeTextActive]}>{size}</Text>
              </Pressable>
            ))}
          </View>

          {/* Quantity */}
          <Text style={styles.label}>Quantity</Text>
          <View style={styles.qtyRow}>
            <Pressable style={styles.qtyBtn} onPress={() => setQuantity(q => Math.max(1, q - 1))}>
              <Ionicons name="remove" size={20} color="#111827" />
            </Pressable>
            <Text style={styles.qty}>{quantity}</Text>
            <Pressable style={styles.qtyBtn} onPress={() => setQuantity(q => q + 1)}>
              <Ionicons name="add" size={20} color="#111827" />
            </Pressable>
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <View>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.total}>R{product.price * quantity}</Text>
        </View>
        <Pressable style={styles.addBtn} onPress={handleAddToCart}>
          <Ionicons name="bag-add-outline" size={20} color="#fff" />
          <Text style={styles.addText}>Add to Cart</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  img: { width: '100%', height: 380, backgroundColor: '#e5e7eb' },
  topRow: { position: 'absolute', top: 50, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 8, elevation: 3 },
  badge: { position: 'absolute', top: -4, right: -4, backgroundColor: '#0a0a0a', borderRadius: 10, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  content: { padding: 20, gap: 10 },
  tag: { alignSelf: 'flex-start', backgroundColor: '#0a0a0a', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  tagText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  name: { fontSize: 24, fontWeight: '900', color: '#0a0a0a' },
  category: { color: '#9ca3af', fontWeight: '600' },
  price: { fontSize: 22, fontWeight: '900', color: '#0a0a0a' },
  desc: { color: '#4b5563', lineHeight: 22 },
  label: { fontWeight: '800', color: '#111827', fontSize: 16, marginTop: 8 },
  sizes: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  sizeBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#e5e7eb' },
  sizeBtnActive: { backgroundColor: '#0a0a0a', borderColor: '#0a0a0a' },
  sizeText: { fontWeight: '700', color: '#374151' },
  sizeTextActive: { color: '#fff' },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  qtyBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#f3f4f6', alignItems: 'center', justifyContent: 'center' },
  qty: { fontSize: 20, fontWeight: '800', color: '#0a0a0a', minWidth: 30, textAlign: 'center' },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  totalLabel: { color: '#9ca3af', fontWeight: '600' },
  total: { fontSize: 22, fontWeight: '900', color: '#0a0a0a' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#0a0a0a', paddingHorizontal: 28, paddingVertical: 16, borderRadius: 14 },
  addText: { color: '#fff', fontWeight: '800', fontSize: 16 },
});
