// Plain-language status labels — never show a raw enum value like
// "pending_store_acceptance" verbatim (FLASH_STORE_ADMIN_DESIGN.md §4.1).
export const STATUS_LABELS = {
  created: { label: 'Created', tone: 'neutral' },
  payment_pending: { label: 'Payment Pending', tone: 'neutral' },
  paid: { label: 'Paid', tone: 'neutral' },
  scheduled_for_morning: { label: 'Scheduled for Morning', tone: 'neutral' },
  pending_store_acceptance: { label: 'New Order — Needs Action', tone: 'urgent' },
  preparing: { label: 'Preparing', tone: 'active' },
  waiting_for_driver: { label: 'Waiting for Driver', tone: 'active' },
  driver_assigned: { label: 'Driver Assigned', tone: 'active' },
  driver_arrived_store: { label: 'Driver at Store', tone: 'active' },
  picked_up: { label: 'Picked Up', tone: 'active' },
  in_transit: { label: 'On the Way', tone: 'active' },
  delivered: { label: 'Delivered', tone: 'done' },
  completed: { label: 'Completed', tone: 'done' },
  cancelled: { label: 'Cancelled', tone: 'cancelled' },
};

export function statusInfo(status) {
  return STATUS_LABELS[status] || { label: status, tone: 'neutral' };
}
