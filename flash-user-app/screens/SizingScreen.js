import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, KeyboardAvoidingView,
  Platform, Modal, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';

// Measurement fields config
const FIELDS = [
  { key: 'height_cm',   label: 'Height',    hint: 'cm',   guideKey: 'height',   placeholder: 'e.g. 175' },
  { key: 'weight_kg',   label: 'Weight',    hint: 'kg',   guideKey: 'weight',   placeholder: 'e.g. 72'  },
  { key: 'chest_cm',    label: 'Chest',     hint: 'cm',   guideKey: 'chest',    placeholder: 'e.g. 96'  },
  { key: 'waist_cm',    label: 'Waist',     hint: 'cm',   guideKey: 'waist',    placeholder: 'e.g. 82'  },
  { key: 'hips_cm',     label: 'Hips',      hint: 'cm',   guideKey: 'hips',     placeholder: 'e.g. 98'  },
  { key: 'shoulder_cm', label: 'Shoulder',  hint: 'cm',   guideKey: 'shoulder', placeholder: 'e.g. 45'  },
  { key: 'inseam_cm',   label: 'Inseam',    hint: 'cm',   guideKey: 'inseam',   placeholder: 'e.g. 78'  },
];

const EXTRA_GUIDES = ['shoe_size', 'shirt_size', 'jeans_size'];

export default function SizingScreen({ navigation }) {
  const [profile, setProfile]     = useState(null);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [guide, setGuide]         = useState(null);
  const [guideModal, setGuideModal] = useState(null); // { key, data }

  const [form, setForm] = useState({
    height_cm: '', weight_kg: '', chest_cm: '', waist_cm: '',
    hips_cm: '', shoulder_cm: '', inseam_cm: '',
    reference_brand_1: '', reference_size_1: '',
    reference_brand_2: '', reference_size_2: '',
  });

  const load = useCallback(async () => {
    try {
      const [profileRes, guideRes] = await Promise.all([
        api.sizing.getProfile(),
        api.sizing.getGuide(),
      ]);
      if (profileRes.profile) {
        const p = profileRes.profile;
        setProfile(p);
        setForm({
          height_cm:       p.height_cm   ? String(p.height_cm)   : '',
          weight_kg:       p.weight_kg   ? String(p.weight_kg)   : '',
          chest_cm:        p.chest_cm    ? String(p.chest_cm)    : '',
          waist_cm:        p.waist_cm    ? String(p.waist_cm)    : '',
          hips_cm:         p.hips_cm     ? String(p.hips_cm)     : '',
          shoulder_cm:     p.shoulder_cm ? String(p.shoulder_cm) : '',
          inseam_cm:       p.inseam_cm   ? String(p.inseam_cm)   : '',
          reference_brand_1: p.reference_brand_1 || '',
          reference_size_1:  p.reference_size_1  || '',
          reference_brand_2: p.reference_brand_2 || '',
          reference_size_2:  p.reference_size_2  || '',
        });
      }
      if (guideRes.guide) setGuide(guideRes.guide);
    } catch (e) {
      console.warn('[Sizing]', e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    const hasAny = Object.values(form).some(v => v.trim?.() !== '');
    if (!hasAny) {
      Alert.alert('No Measurements', 'Please enter at least one measurement before saving.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        height_cm:   form.height_cm   ? parseFloat(form.height_cm)   : null,
        weight_kg:   form.weight_kg   ? parseFloat(form.weight_kg)   : null,
        chest_cm:    form.chest_cm    ? parseFloat(form.chest_cm)    : null,
        waist_cm:    form.waist_cm    ? parseFloat(form.waist_cm)    : null,
        hips_cm:     form.hips_cm     ? parseFloat(form.hips_cm)     : null,
        shoulder_cm: form.shoulder_cm ? parseFloat(form.shoulder_cm) : null,
        inseam_cm:   form.inseam_cm   ? parseFloat(form.inseam_cm)   : null,
        reference_brand_1: form.reference_brand_1 || null,
        reference_size_1:  form.reference_size_1  || null,
        reference_brand_2: form.reference_brand_2 || null,
        reference_size_2:  form.reference_size_2  || null,
      };
      const res = await api.sizing.saveProfile(payload);
      setProfile(res.profile);
      Alert.alert('Saved!', 'Your measurements are saved. Flash will recommend your size on every product.');
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <View style={s.center}><ActivityIndicator size="large" color="#0a0a0a" /></View>;
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={s.container} contentContainerStyle={s.content}>

        {/* Banner */}
        <View style={s.banner}>
          <Ionicons name="body-outline" size={28} color="#fff" />
          <View style={{ flex: 1 }}>
            <Text style={s.bannerTitle}>Size Match</Text>
            <Text style={s.bannerSub}>
              Enter your measurements once. Flash recommends your exact size on every product — with a confidence score.
            </Text>
          </View>
        </View>

        {/* Measurements grid */}
        <Text style={s.sectionTitle}>Your Measurements</Text>
        <View style={s.grid}>
          {FIELDS.map(f => (
            <View key={f.key} style={s.fieldWrap}>
              <View style={s.fieldTop}>
                <Text style={s.fieldLabel}>{f.label}</Text>
                <View style={s.fieldRight}>
                  <Text style={s.fieldHint}>{f.hint}</Text>
                  {/* How-to-measure button */}
                  {guide?.[f.guideKey] && (
                    <TouchableOpacity
                      style={s.howBtn}
                      onPress={() => setGuideModal({ key: f.guideKey, data: guide[f.guideKey] })}
                    >
                      <Ionicons name="help-circle-outline" size={16} color="#3b82f6" />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
              <TextInput
                style={s.input}
                placeholder={f.placeholder}
                placeholderTextColor="#9ca3af"
                value={form[f.key]}
                onChangeText={t => setForm(p => ({ ...p, [f.key]: t }))}
                keyboardType="decimal-pad"
              />
            </View>
          ))}
        </View>

        {/* Size charts section */}
        <Text style={[s.sectionTitle, { marginTop: 24 }]}>SA Size Charts</Text>
        <Text style={s.sectionSub}>Tap any chart to see how to measure and what size you are</Text>
        <View style={s.chartsRow}>
          {EXTRA_GUIDES.map(gk => (
            guide?.[gk] ? (
              <TouchableOpacity
                key={gk}
                style={s.chartChip}
                onPress={() => setGuideModal({ key: gk, data: guide[gk] })}
              >
                <Ionicons name="resize-outline" size={14} color="#0a0a0a" />
                <Text style={s.chartChipText}>{guide[gk].label}</Text>
              </TouchableOpacity>
            ) : null
          ))}
        </View>

        {/* Reference brands */}
        <Text style={[s.sectionTitle, { marginTop: 24 }]}>Reference Brands</Text>
        <Text style={s.sectionSub}>Tell Flash which brands fit you well — this improves accuracy</Text>
        <View style={s.row}>
          <View style={[s.fieldWrap, { flex: 1 }]}>
            <Text style={s.fieldLabel}>Brand 1</Text>
            <TextInput style={s.input} placeholder="e.g. Nike" placeholderTextColor="#9ca3af"
              value={form.reference_brand_1}
              onChangeText={t => setForm(p => ({ ...p, reference_brand_1: t }))} />
          </View>
          <View style={[s.fieldWrap, { flex: 1 }]}>
            <Text style={s.fieldLabel}>Size</Text>
            <TextInput style={s.input} placeholder="e.g. M" placeholderTextColor="#9ca3af"
              value={form.reference_size_1} autoCapitalize="characters"
              onChangeText={t => setForm(p => ({ ...p, reference_size_1: t }))} />
          </View>
        </View>
        <View style={s.row}>
          <View style={[s.fieldWrap, { flex: 1 }]}>
            <Text style={s.fieldLabel}>Brand 2</Text>
            <TextInput style={s.input} placeholder="e.g. Zara" placeholderTextColor="#9ca3af"
              value={form.reference_brand_2}
              onChangeText={t => setForm(p => ({ ...p, reference_brand_2: t }))} />
          </View>
          <View style={[s.fieldWrap, { flex: 1 }]}>
            <Text style={s.fieldLabel}>Size</Text>
            <TextInput style={s.input} placeholder="e.g. L" placeholderTextColor="#9ca3af"
              value={form.reference_size_2} autoCapitalize="characters"
              onChangeText={t => setForm(p => ({ ...p, reference_size_2: t }))} />
          </View>
        </View>

        {profile && (
          <View style={s.savedRow}>
            <Ionicons name="checkmark-circle" size={14} color="#10b981" />
            <Text style={s.savedText}>
              Last saved {new Date(profile.updated_at).toLocaleDateString('en-ZA')}
            </Text>
          </View>
        )}

        <TouchableOpacity style={s.saveBtn} onPress={handleSave} disabled={saving}>
          {saving
            ? <ActivityIndicator color="#fff" size="small" />
            : <>
                <Ionicons name="checkmark" size={18} color="#fff" />
                <Text style={s.saveBtnText}>{profile ? 'Update Measurements' : 'Save Measurements'}</Text>
              </>
          }
        </TouchableOpacity>
      </ScrollView>

      {/* ── How-to-measure modal ─────────────────────────────────────────── */}
      <Modal
        visible={!!guideModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setGuideModal(null)}
      >
        {guideModal && (
          <View style={s.modal}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>How to measure: {guideModal.data.label}</Text>
              <Pressable onPress={() => setGuideModal(null)} style={s.modalClose}>
                <Ionicons name="close" size={22} color="#111827" />
              </Pressable>
            </View>
            <ScrollView style={s.modalBody} contentContainerStyle={{ gap: 16 }}>
              <View style={s.modalSection}>
                <Text style={s.modalSectionTitle}>Instructions</Text>
                <Text style={s.modalText}>{guideModal.data.instruction}</Text>
              </View>
              <View style={s.modalSection}>
                <Text style={s.modalSectionTitle}>Tip</Text>
                <Text style={s.modalText}>{guideModal.data.tip}</Text>
              </View>
              {guideModal.data.unit && (
                <View style={s.modalUnitBadge}>
                  <Text style={s.modalUnitText}>Unit: {guideModal.data.unit}</Text>
                </View>
              )}
            </ScrollView>
          </View>
        )}
      </Modal>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content:   { padding: 16, paddingBottom: 48 },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center' },
  banner:    { backgroundColor: '#0a0a0a', borderRadius: 16, padding: 16, flexDirection: 'row', gap: 14, marginBottom: 24, alignItems: 'flex-start' },
  bannerTitle: { color: '#fff', fontWeight: '800', fontSize: 15, marginBottom: 4 },
  bannerSub:   { color: '#9ca3af', fontSize: 12, lineHeight: 18 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#111827', marginBottom: 6 },
  sectionSub:   { fontSize: 12, color: '#9ca3af', marginBottom: 12, lineHeight: 17 },
  grid:      { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  fieldWrap: { width: '47%', marginBottom: 4 },
  fieldTop:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 },
  fieldRight:{ flexDirection: 'row', alignItems: 'center', gap: 4 },
  fieldLabel:{ fontSize: 12, fontWeight: '600', color: '#374151' },
  fieldHint: { fontSize: 11, color: '#9ca3af' },
  howBtn:    { padding: 2 },
  input:     { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 12, fontSize: 15, color: '#111827', backgroundColor: '#fff' },
  row:       { flexDirection: 'row', gap: 12 },
  chartsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chartChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fff', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#e5e7eb' },
  chartChipText: { fontSize: 13, fontWeight: '600', color: '#111827' },
  savedRow:  { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, marginBottom: 8 },
  savedText: { fontSize: 12, color: '#10b981' },
  saveBtn:   { backgroundColor: '#0a0a0a', borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 8 },
  saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  // Modal
  modal:       { flex: 1, backgroundColor: '#fff' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  modalTitle:  { fontSize: 16, fontWeight: '700', color: '#111827', flex: 1 },
  modalClose:  { padding: 4 },
  modalBody:   { padding: 20 },
  modalSection:{ backgroundColor: '#f9fafb', borderRadius: 14, padding: 16 },
  modalSectionTitle: { fontWeight: '700', color: '#111827', marginBottom: 8 },
  modalText:   { color: '#374151', lineHeight: 22, fontSize: 14 },
  modalUnitBadge: { backgroundColor: '#f3f4f6', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, alignSelf: 'flex-start' },
  modalUnitText:  { fontSize: 13, fontWeight: '600', color: '#374151' },
});
