import React, { useState } from 'react';
import { ApiClient, useNotice } from 'adminjs';
import { Box, H3, Text, TextArea, Input, Label, Button } from '@adminjs/design-system';

// PR G1 (#106), audit H7: the "Refund" page for a delivered, completed or
// cancelled card order. Leave the amount empty for a full refund (everything
// still left of what was paid), or type an amount for a partial refund. The
// reason is required; it's stored with the refund and in admin_actions. The
// server refuses more than what's left, and a second refund while one is
// still being processed.

const RefundOrder = (props) => {
  const { record, resource, action } = props;
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const addNotice = useNotice();
  const orderNumber = record?.params?.order_number || record?.id;
  const total = record?.params?.total;

  const submit = async (event) => {
    event.preventDefault();
    if (!reason.trim()) {
      addNotice({ message: 'Type a reason first.', type: 'error' });
      return;
    }
    setBusy(true);
    try {
      const data = new FormData();
      data.append('amount', amount.trim());
      data.append('reason', reason.trim());
      const response = await new ApiClient().recordAction({
        resourceId: resource.id,
        recordId: record.id,
        actionName: action.name,
        data,
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (response.data.notice) addNotice(response.data.notice);
      if (response.data.notice?.type === 'success') {
        setAmount('');
        setReason('');
      }
    } catch (err) {
      addNotice({ message: err.message || 'Could not send the refund.', type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box as="form" onSubmit={submit} p="xl" variant="white">
      <H3>Refund order {orderNumber}</H3>
      <Text mb="lg">
        {total ? `Order total: R${parseFloat(total).toFixed(2)}. ` : ''}
        Leave the amount empty to refund everything still left of what the customer paid, or type an amount (in rand) for a partial refund. The money goes back to the customer's card through Paystack.
      </Text>
      <Label>Amount in rand (empty = full refund)</Label>
      <Input
        width="100%"
        inputMode="decimal"
        placeholder="e.g. 45.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <Box mt="lg">
        <Label required>Reason (kept with the refund and in the audit log)</Label>
        <TextArea
          width="100%"
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Box>
      <Box mt="lg">
        <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
          {busy ? 'Sending…' : (amount.trim() ? `Refund R${amount.trim()}` : 'Refund in full')}
        </Button>
      </Box>
    </Box>
  );
};

export default RefundOrder;
