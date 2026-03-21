const PLANS = {
  daily: { price: 25, days: 1, deliveries: 10, label: "Daily" },
  weekly: { price: 120, days: 7, deliveries: 60, label: "Weekly" },
  monthly: { price: 350, days: 30, deliveries: null, label: "Monthly" },
  quarterly: { price: 900, days: 90, deliveries: null, label: "Quarterly" },
};

const VALID_ORDER_STATUS_TRANSITIONS = {
  driver_assigned: ["en_route"],
  en_route: ["picked_up"],
  picked_up: ["delivered"],
  delivered: ["completed"],
};

const REQUIRED_DRIVER_DOCS = [
  "government_id",
  "drivers_license",
  "police_certified",
  "profile_photo",
  "vehicle_registration",
];

module.exports = {
  PLANS,
  VALID_ORDER_STATUS_TRANSITIONS,
  REQUIRED_DRIVER_DOCS,
};
