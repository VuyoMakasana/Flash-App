/**
 * flash-user-app/screens/AddressScreen.js
 *
 * MEDIUM-5 FIX: New screen for managing saved delivery addresses.
 *   - List all saved addresses
 *   - Add new address with full details (label, street, apartment, gate code, landmark)
 *   - Edit / delete existing addresses
 *   - Mark one address as default
 *   Connected from: ProfileScreen → "My Addresses", CheckoutScreen → address selector
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, Modal, KeyboardAvoidingView,
  Platform, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import api from '../services/api';

const LABEL_OPTIONS = ['Home', 'Work', 'Other'];

const EMPTY_FORM = {
  label:      'Home',
  street:     '',
  apartment:  '',
  suburb:     '',
  city:       '',
  gate_code:  '',
  landmark:   '',
  is_default: false,
};

export default function AddressScreen() {
  const navigation = useNavigation();
  const [addresses,  setAddresses]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm,   setShowForm]   = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [editId,     setEditId]     = useState(null);

  const loadAddresses = useCallback(async () => {
    try {
      const data = await api.user.getAddresses();
      setAddresses(data.addresses || []);
    } catch (e) {
      Alert.alert('Error', 'Could not load addresses.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAddresses(); }, [loadAddresses]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAddresses();
    setRefreshing(false);
  }, [loadAddresses]);

  const openAdd = () => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (addr) => {
    setEditId(addr.id);
    setForm({
      label:      addr.label      || 'Home',
      street:     addr.street     || '',
      apartment:  addr.apartment  || '',
      suburb:     addr.suburb     || '',
      city:       addr.city       || '',
      gate_code:  addr.gate_code  || '',
      landmark:   addr.landmark   || '',
      is_default: addr.is_default || false,
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.street.trim()) {
      Alert.alert('Required', 'Please enter a street address.');
      return;
    }
    if (!form.suburb.trim() || !form.city.trim()) {
      Alert.alert('Required', 'Please enter your suburb and city.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        label:      form.label,
        street:     form.street.trim(),
        apartment:  form.apartment.trim(),
        suburb:     form.suburb.trim(),
        city:       form.city.trim(),
        gate_code:  form.gate_code.trim(),
        landmark:   form.landmark.trim(),
        is_default: form.is_default,
        full_address: [
          form.street, form.apartment, form.suburb, form.city,
        ].filter(Boolean).join(', '),
      };

      if (editId) {
        await api.user.updateAddress(editId, payload);
      } else {
        await api.user.addAddress(payload);
      }

      setShowForm(false);
      await loadAddresses();
    } catch (e) {
      Alert.alert('Error', e.message || 'Could not save address.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (id) => {
    Alert.alert(
      'Remove Address',
      'Are you sure you want to remove this address?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.user.deleteAddress(id);
              setAddresses(prev => prev.filter(a => a.id !== id));
            } catch (e) {
              Alert.alert('Error', 'Could not remove address.');
            }
          },
        },
      ],
    );
  };

  const handleSetDefault = async (id) => {
    try {
      await api.user.updateAddress(id, { is_default: true });
      setAddresses(prev =>
        prev.map(a => ({ ...a, is_default: a.id === id })),
      );
    } catch (e) {
      Alert.alert('Error', 'Could not update default address.');
    }
  };

  const Field = ({ label, value, onChange, placeholder, multiline, keyboardType, optional }) => (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}{optional ? <Text style={styles.optional}> (optional)</Text> : null}</Text>
      <TextInput
        style={[styles.input, multiline && styles.inputMulti]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#4b5563"
        keyboardType={keyboardType || 'default'}
        multiline={multiline}
        returnKeyType={multiline ? 'default' : 'next'}
        autoCapitalize="words"
      />
    </View>
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#f59e0b" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>My Addresses</Text>
        <TouchableOpacity onPress={openAdd} style={styles.addBtn}>
          <Ionicons name="add" size={24} color="#f59e0b" />
        </TouchableOpacity>
      </View>

      {/* Address list */}
      <ScrollView
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f59e0b" />}
      >
        {addresses.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Ionicons name="location-outline" size={56} color="#374151" />
            <Text style={styles.emptyTitle}>No saved addresses</Text>
            <Text style={styles.emptyBody}>Add your home or work address so checkout is faster.</Text>
            <TouchableOpacity style={styles.addFirstBtn} onPress={openAdd}>
              <Text style={styles.addFirstBtnText}>Add Address</Text>
            </TouchableOpacity>
          </View>
        ) : (
          addresses.map(addr => (
            <View key={addr.id} style={[styles.addrCard, addr.is_default && styles.addrCardDefault]}>
              <View style={styles.addrRow}>
                <View style={styles.addrLabelWrap}>
                  <Ionicons
                    name={addr.label === 'Home' ? 'home-outline' : addr.label === 'Work' ? 'briefcase-outline' : 'location-outline'}
                    size={16}
                    color="#f59e0b"
                  />
                  <Text style={styles.addrLabel}>{addr.label}</Text>
                  {addr.is_default && (
                    <View style={styles.defaultBadge}>
                      <Text style={styles.defaultBadgeText}>Default</Text>
                    </View>
                  )}
                </View>
                <View style={styles.addrActions}>
                  <TouchableOpacity onPress={() => openEdit(addr)} style={styles.actionBtn}>
                    <Ionicons name="create-outline" size={18} color="#9ca3af" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDelete(addr.id)} style={styles.actionBtn}>
                    <Ionicons name="trash-outline" size={18} color="#9ca3af" />
                  </TouchableOpacity>
                </View>
              </View>

              <Text style={styles.addrStreet}>{addr.street}</Text>
              {addr.apartment ? <Text style={styles.addrDetail}>{addr.apartment}</Text> : null}
              <Text style={styles.addrDetail}>{[addr.suburb, addr.city].filter(Boolean).join(', ')}</Text>
              {addr.gate_code ? <Text style={styles.addrMeta}>Gate code: {addr.gate_code}</Text> : null}
              {addr.landmark  ? <Text style={styles.addrMeta}>Near: {addr.landmark}</Text> : null}

              {!addr.is_default && (
                <TouchableOpacity onPress={() => handleSetDefault(addr.id)} style={styles.setDefaultBtn}>
                  <Text style={styles.setDefaultText}>Set as default</Text>
                </TouchableOpacity>
              )}
            </View>
          ))
        )}
      </ScrollView>

      {/* Add / Edit Modal */}
      <Modal
        visible={showForm}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowForm(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowForm(false)}>
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>{editId ? 'Edit Address' : 'New Address'}</Text>
            <View style={{ width: 24 }} />
          </View>

          <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
            {/* Label picker */}
            <Text style={styles.fieldLabel}>Label</Text>
            <View style={styles.labelRow}>
              {LABEL_OPTIONS.map(l => (
                <TouchableOpacity
                  key={l}
                  style={[styles.labelChip, form.label === l && styles.labelChipActive]}
                  onPress={() => setForm(f => ({ ...f, label: l }))}
                >
                  <Text style={[styles.labelChipText, form.label === l && styles.labelChipTextActive]}>
                    {l}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Field
              label="Street address *"
              value={form.street}
              onChange={v => setForm(f => ({ ...f, street: v }))}
              placeholder="e.g. 42 Long Street"
            />
            <Field
              label="Apartment / Unit"
              value={form.apartment}
              onChange={v => setForm(f => ({ ...f, apartment: v }))}
              placeholder="e.g. Flat 3B"
              optional
            />
            <Field
              label="Suburb *"
              value={form.suburb}
              onChange={v => setForm(f => ({ ...f, suburb: v }))}
              placeholder="e.g. Gardens"
            />
            <Field
              label="City *"
              value={form.city}
              onChange={v => setForm(f => ({ ...f, city: v }))}
              placeholder="e.g. Cape Town"
            />
            <Field
              label="Gate / Access code"
              value={form.gate_code}
              onChange={v => setForm(f => ({ ...f, gate_code: v }))}
              placeholder="e.g. #1234"
              optional
            />
            <Field
              label="Landmark"
              value={form.landmark}
              onChange={v => setForm(f => ({ ...f, landmark: v }))}
              placeholder="e.g. Next to the Spar"
              optional
            />

            {/* Default toggle */}
            <TouchableOpacity
              style={styles.defaultToggle}
              onPress={() => setForm(f => ({ ...f, is_default: !f.is_default }))}
            >
              <Ionicons
                name={form.is_default ? 'checkbox' : 'square-outline'}
                size={22}
                color={form.is_default ? '#f59e0b' : '#6b7280'}
              />
              <Text style={styles.defaultToggleText}>Set as my default delivery address</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
              onPress={handleSave}
              disabled={saving}
            >
              {saving
                ? <ActivityIndicator color="#0a0a0a" />
                : <Text style={styles.saveBtnText}>{editId ? 'Save Changes' : 'Add Address'}</Text>
              }
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#0a0a0a' },
  centered:           { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0a0a' },
  header:             { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16 },
  backBtn:            { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title:              { color: '#fff', fontSize: 18, fontWeight: '700' },
  addBtn:             { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  listContent:        { padding: 16, gap: 12, flexGrow: 1 },
  emptyWrap:          { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingTop: 80 },
  emptyTitle:         { color: '#9ca3af', fontSize: 18, fontWeight: '600' },
  emptyBody:          { color: '#6b7280', fontSize: 14, textAlign: 'center', paddingHorizontal: 32 },
  addFirstBtn:        { backgroundColor: '#f59e0b', borderRadius: 12, paddingHorizontal: 28, paddingVertical: 14, marginTop: 8 },
  addFirstBtnText:    { color: '#0a0a0a', fontWeight: '700', fontSize: 15 },
  addrCard:           { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 16, gap: 6 },
  addrCardDefault:    { borderColor: '#f59e0b', borderWidth: 1 },
  addrRow:            { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  addrLabelWrap:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  addrLabel:          { color: '#f59e0b', fontWeight: '700', fontSize: 14 },
  defaultBadge:       { backgroundColor: '#f59e0b22', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  defaultBadgeText:   { color: '#f59e0b', fontSize: 11, fontWeight: '600' },
  addrActions:        { flexDirection: 'row', gap: 4 },
  actionBtn:          { padding: 6 },
  addrStreet:         { color: '#fff', fontSize: 14, fontWeight: '500' },
  addrDetail:         { color: '#9ca3af', fontSize: 13 },
  addrMeta:           { color: '#6b7280', fontSize: 12 },
  setDefaultBtn:      { marginTop: 8, alignSelf: 'flex-start' },
  setDefaultText:     { color: '#f59e0b', fontSize: 13, fontWeight: '500' },
  // Modal
  modalContainer:     { flex: 1, backgroundColor: '#0a0a0a' },
  modalHeader:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, paddingTop: 56 },
  modalTitle:         { color: '#fff', fontSize: 18, fontWeight: '700' },
  formContent:        { padding: 20, gap: 16, paddingBottom: 60 },
  field:              { gap: 8 },
  fieldLabel:         { color: '#9ca3af', fontSize: 13, fontWeight: '600' },
  optional:           { color: '#4b5563', fontWeight: '400' },
  input:              { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 14, color: '#fff', fontSize: 15, borderWidth: 1, borderColor: '#272727' },
  inputMulti:         { height: 90, textAlignVertical: 'top' },
  labelRow:           { flexDirection: 'row', gap: 10, marginBottom: 4 },
  labelChip:          { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#272727' },
  labelChipActive:    { backgroundColor: '#f59e0b22', borderColor: '#f59e0b' },
  labelChipText:      { color: '#9ca3af', fontSize: 14 },
  labelChipTextActive:{ color: '#f59e0b', fontWeight: '600' },
  defaultToggle:      { flexDirection: 'row', alignItems: 'center', gap: 10 },
  defaultToggleText:  { color: '#9ca3af', fontSize: 14 },
  saveBtn:            { backgroundColor: '#f59e0b', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 8 },
  saveBtnDisabled:    { opacity: 0.6 },
  saveBtnText:        { color: '#0a0a0a', fontWeight: '800', fontSize: 16 },
});
