'use strict';

const bcrypt = require("bcryptjs");
const StoreUser = require("../models/StoreUser");
const StoreAction = require("../models/StoreAction");

// Admin Platform Phase 3 — the Store Admin Portal's Settings screen backend
// (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §6.2, DOMAIN_OWNERSHIP_AUTHORITY_
// SPECIFICATION.md §2). Owner-only by explicit design (both documents agree:
// "Owner role only... managing other store_users"), enforced by
// storeStaffRoutes.js's requireStoreRole('owner') — not re-checked here,
// same division of responsibility as every other store-scoped route tree.
// This is also the server-side enforcement point for "no role can grant
// itself a higher role than its own" (the task's own explicit ask): only an
// Owner can ever reach createStaff at all (route-gated), and an Owner
// creating another Owner is not privilege escalation — it's the top role
// creating a peer, which the RBAC table explicitly allows.
const VALID_ROLES = ["owner", "store_manager", "inventory_staff", "sales_staff", "finance", "marketing"];

class StoreStaffController {
  static async listStaff(req, res) {
    try {
      const staff = await StoreUser.listByStore(req.storeId);
      res.json({ staff });
    } catch (err) {
      console.error("[StoreStaff] listStaff error:", err.message);
      res.status(500).json({ error: "Failed to fetch staff" });
    }
  }

  static async createStaff(req, res) {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "name, email, password, and role are required" });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(", ")}` });
    }
    if (password.length < 10) {
      return res.status(400).json({ error: "Password must be at least 10 characters" });
    }
    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const staffMember = await StoreUser.create({ storeId: req.storeId, name, email, passwordHash, role });
      StoreAction.log(req.storeUserId, req.storeId, "store_staff_create", "store_users", staffMember.id, { role });
      res.status(201).json({ staff: staffMember });
    } catch (err) {
      // store_users.email has a real UNIQUE constraint — a duplicate is a
      // genuine client error, not a server fault.
      if (err.code === "23505") {
        return res.status(409).json({ error: "A staff account with that email already exists" });
      }
      console.error("[StoreStaff] createStaff error:", err.message);
      res.status(500).json({ error: "Failed to create staff account" });
    }
  }

  static async deactivateStaff(req, res) {
    const { staffId } = req.params;
    // Self-deactivation guard. A reactivate counterpart now exists, but that
    // does NOT make this guard redundant and the distinction matters: only the
    // 'owner' role can call reactivate, so an Owner who deactivates themselves
    // cannot log back in to undo it. The lockout is still unrecoverable via
    // self-service — the reason is now "only you could have reversed it", not
    // "nothing can reverse it".
    if (String(staffId) === String(req.storeUserId)) {
      return res.status(400).json({ error: "You cannot deactivate your own account" });
    }
    try {
      const deactivated = await StoreUser.deactivate(staffId, req.storeId);
      if (!deactivated) return res.status(404).json({ error: "Staff account not found" });

      StoreAction.log(req.storeUserId, req.storeId, "store_staff_deactivate", "store_users", staffId);
      res.json({ staff: deactivated });
    } catch (err) {
      console.error("[StoreStaff] deactivateStaff error:", err.message);
      res.status(500).json({ error: "Failed to deactivate staff account" });
    }
  }

  // The inverse of deactivateStaff. Without it, a staff member deactivated in
  // error could only be restored with direct database access.
  //
  // No self-reactivate guard is needed here, unlike deactivate: reaching this
  // endpoint at all requires an active session, so a caller cannot be
  // deactivated and acting simultaneously. authenticateStore re-checks
  // is_active live on every request, so a deactivated account's token stops
  // working immediately rather than at expiry.
  static async reactivateStaff(req, res) {
    const { staffId } = req.params;
    try {
      const reactivated = await StoreUser.reactivate(staffId, req.storeId);
      if (!reactivated) return res.status(404).json({ error: "Staff account not found" });

      StoreAction.log(req.storeUserId, req.storeId, "store_staff_reactivate", "store_users", staffId);
      res.json({ staff: reactivated });
    } catch (err) {
      console.error("[StoreStaff] reactivateStaff error:", err.message);
      res.status(500).json({ error: "Failed to reactivate staff account" });
    }
  }
}

module.exports = StoreStaffController;
