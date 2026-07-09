const Address = require("../models/Address");

class AddressController {
  static async getAddresses(req, res) {
    try {
      const addresses = await Address.getByUser(req.userId);
      res.json({ addresses });
    } catch (err) {
      console.error("[Address] getAddresses error:", err.message);
      res.status(500).json({ error: "Failed to fetch addresses" });
    }
  }

  static async addAddress(req, res) {
    const { street } = req.body;
    if (!street || !String(street).trim()) {
      return res.status(400).json({ error: "street is required" });
    }
    try {
      const address = await Address.create(req.userId, req.body);
      res.status(201).json({ address });
    } catch (err) {
      console.error("[Address] addAddress error:", err.message);
      res.status(500).json({ error: "Failed to save address" });
    }
  }

  static async updateAddress(req, res) {
    const { addressId } = req.params;
    try {
      const address = await Address.update(addressId, req.userId, req.body);
      res.json({ address });
    } catch (err) {
      if (err.message === "Address not found") {
        return res.status(404).json({ error: err.message });
      }
      console.error("[Address] updateAddress error:", err.message);
      res.status(500).json({ error: "Failed to update address" });
    }
  }

  static async deleteAddress(req, res) {
    const { addressId } = req.params;
    try {
      await Address.delete(addressId, req.userId);
      res.json({ success: true });
    } catch (err) {
      if (err.message === "Address not found") {
        return res.status(404).json({ error: err.message });
      }
      console.error("[Address] deleteAddress error:", err.message);
      res.status(500).json({ error: "Failed to delete address" });
    }
  }
}

module.exports = AddressController;
