'use strict';

// PR G1 (#106), audit H7: the admin panel's "Refund" action on an order.
// Refunds a delivered, completed or cancelled card order in full (amount left
// empty) or in part, with a typed reason, through RefundService.adminRefund
// (recorded in payment_refunds, never more than what's left, no second
// refund while one is in flight, failures counted for the 3-failure alert).
// Every attempt, successful or refused, is written to admin_actions.
//
// Built like adminFeatureSwitches.js's switchAction: a custom form
// (adminComponents/RefundOrder.jsx) posts { amount, reason }; GET only shows
// the form. Kept in its own file so it can be tested without AdminJS.

const AdminAction = require('./models/AdminAction');
const RefundService = require('./services/refundService');

const REFUNDABLE_STATUSES = ['delivered', 'completed', 'cancelled'];

function refundOrderAction(component) {
  return {
    actionType: 'record',
    icon: 'RotateCcw',
    label: 'Refund',
    // Without the registered component (unit tests), AdminJS falls back to
    // a plain confirm; the handler still refuses a missing reason.
    component: component || false,
    guard: component ? undefined : 'Refund this order? You will need to give a reason.',
    isAccessible: ({ record }) => Boolean(record)
      && REFUNDABLE_STATUSES.includes(record.param('status'))
      && record.param('payment_method') === 'card',
    handler: async (request, _response, context) => {
      const { record, currentAdmin } = context;
      if (request.method !== 'post') {
        return { record: record.toJSON(currentAdmin) };
      }
      const orderId = record.id();
      const reason = String(request.payload?.reason ?? '').trim();
      const rawAmount = String(request.payload?.amount ?? '').trim();
      const amount = rawAmount === '' ? null : rawAmount;

      if (!reason) {
        return {
          record: record.toJSON(currentAdmin),
          notice: { message: 'Type a reason for the refund first.', type: 'error' },
        };
      }

      try {
        const refund = await RefundService.adminRefund(orderId, { amount, reason, adminId: currentAdmin.id });
        const kind = String(refund.reason || '').startsWith('admin_full:') ? 'full' : 'partial';
        await AdminAction.log(currentAdmin.id, 'order_refund_admin', 'orders', orderId, {
          refundId: refund.id, amount: refund.amount, kind, reason,
        });
        return {
          record: record.toJSON(currentAdmin),
          notice: {
            message: `Refund of R${parseFloat(refund.amount).toFixed(2)} (${kind}) sent to Paystack. `
              + 'It shows as completed once Paystack confirms it.',
            type: 'success',
          },
        };
      } catch (err) {
        await AdminAction.log(currentAdmin.id, 'order_refund_admin_failed', 'orders', orderId, {
          amount, reason, error: err.message,
        });
        return {
          record: record.toJSON(currentAdmin),
          notice: { message: `Refund not sent: ${err.message}`, type: 'error' },
        };
      }
    },
  };
}

module.exports = { refundOrderAction, REFUNDABLE_STATUSES };
