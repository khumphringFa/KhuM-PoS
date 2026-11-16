import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_FORMAT,
  validateArchive,
  archiveToLocal,
} from "../public/backup.js";
import { seal, unseal } from "../src/drive.js";
function archive(count = 1) {
  return {
    format: BACKUP_FORMAT,
    created_at: new Date().toISOString(),
    shop: { id: "s", name: "Shop" },
    products: [
      {
        id: "p",
        shop_id: "s",
        name: "Rice",
        category: "Rice",
        unit: "kg",
        expiry: "",
        stock: 500,
        price: 100,
        cost: 50,
        low_stock: 0,
      },
    ],
    sales: Array.from({ length: count }, (_, i) => ({
      id: "s" + i,
      shop_id: "s",
      created_at: new Date().toISOString(),
      payment: "Cash",
      subtotal: 100,
      discount: 0,
      total: 100,
      tendered: 100,
    })),
    lines: Array.from({ length: count }, (_, i) => ({
      sale_id: "s" + i,
      shop_id: "s",
      product_id: "p",
      name: "Rice",
      qty: 1000,
      price: 100,
      cost: 50,
    })),
  };
}
test("full archive keeps more than 500 receipts and restores without another stock deduction", () => {
  const b = archive(601),
    next = archiveToLocal(b, "local-restore-test");
  assert.equal(next.sales.length, 601);
  assert.equal(next.sales[600].lines.length, 1);
  assert.equal(next.products[0].stock, 500);
  assert.deepEqual(next.pending, []);
  assert.equal(b.shop.id, "s");
  assert.equal(next.shop.id, "local-restore-test");
});
test("restore rejects missing lines, duplicate receipts, foreign-shop items and invalid money", () => {
  for (const change of [
    (b) => (b.lines = []),
    (b) => b.sales.push({ ...b.sales[0] }),
    (b) => (b.products[0].shop_id = "other"),
    (b) => (b.sales[0].total = 1),
    (b) => (b.products[0].stock = -1),
  ]) {
    const b = archive();
    change(b);
    assert.throws(() => validateArchive(b));
  }
});
test("refresh tokens are encrypted and bound to their Google user", async () => {
  const env = { DRIVE_TOKEN_KEY: Buffer.alloc(32, 3).toString("base64") };
  const sealed = await seal(env, "owner", "private-refresh-token");
  assert.ok(!sealed.includes("private-refresh-token"));
  assert.equal(await unseal(env, "owner", sealed), "private-refresh-token");
  await assert.rejects(() => unseal(env, "other-user", sealed));
  await assert.rejects(() =>
    unseal(
      { ...env, DRIVE_TOKEN_KEY: Buffer.alloc(32, 4).toString("base64") },
      "owner",
      sealed,
    ),
  );
});
