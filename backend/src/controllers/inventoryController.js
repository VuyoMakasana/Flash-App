const Inventory = require("../models/Inventory");
const FLASH_STORE_ID = "flash_closet";

class InventoryController {
  static async getProducts(req, res) {
    const { category, page = 1, limit = 20 } = req.query;
    try {
      const products = await Inventory.getProducts(category, page, limit);
      res.json({ products, storeId: FLASH_STORE_ID });
    } catch (err) {
      console.error("[Inventory] getProducts error:", err.message);
      res.status(500).json({ error: "Failed to fetch inventory" });
    }
  }

  static async getProduct(req, res) {
    const { productId } = req.params;
    try {
      const product = await Inventory.getProduct(productId);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json({ product, storeId: FLASH_STORE_ID });
    } catch (err) {
      console.error("[Inventory] getProduct error:", err.message);
      res.status(500).json({ error: "Failed to fetch product" });
    }
  }

  static async addProduct(req, res) {
    const {
      product_name,
      category,
      brand,
      price,
      cost_price,
      sizes,
      stock_by_size,
      image_url,
      description,
    } = req.body;
    if (!product_name || !price) {
      return res.status(400).json({ error: "product_name and price required" });
    }

    try {
      const product = await Inventory.addProduct({
        product_name,
        category,
        brand,
        price,
        cost_price,
        sizes,
        stock_by_size,
        image_url,
        description,
      });
      res.status(201).json({ product });
    } catch (err) {
      console.error("[Inventory] addProduct error:", err.message);
      res.status(500).json({ error: "Failed to add product" });
    }
  }

  static async updateStock(req, res) {
    const { productId } = req.params;
    const { stock_by_size } = req.body;
    try {
      const product = await Inventory.updateStock(productId, stock_by_size);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json({ product });
    } catch (err) {
      console.error("[Inventory] updateStock error:", err.message);
      res.status(500).json({ error: "Failed to update stock" });
    }
  }

  static async deleteProduct(req, res) {
    const { productId } = req.params;
    try {
      await Inventory.deleteProduct(productId);
      res.json({ success: true });
    } catch (err) {
      console.error("[Inventory] deleteProduct error:", err.message);
      res.status(500).json({ error: "Failed to remove product" });
    }
  }
}

module.exports = InventoryController;
