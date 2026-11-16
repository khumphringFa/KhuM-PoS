import { integer, totals } from "./core.js";
export const BACKUP_FORMAT = "khum-cloud-backup-v1";
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
export function validateArchive(b) {
  if (
    !b ||
    b.format !== BACKUP_FORMAT ||
    typeof b.shop?.id !== "string" ||
    typeof b.shop?.name !== "string" ||
    !Array.isArray(b.products) ||
    !Array.isArray(b.sales) ||
    !Array.isArray(b.lines)
  )
    throw Error("Unsupported or incomplete cloud backup.");
  const products = new Set(),
    sales = new Map(),
    lineKeys = new Set(),
    grouped = new Map();
  for (const p of b.products) {
    if (
      typeof p.id !== "string" ||
      products.has(p.id) ||
      p.shop_id !== b.shop.id ||
      typeof p.name !== "string" ||
      typeof p.category !== "string" ||
      typeof p.unit !== "string" ||
      typeof p.expiry !== "string"
    )
      throw Error("Invalid product in backup.");
    products.add(p.id);
    for (const k of ["price", "cost", "stock", "low_stock"]) integer(p[k]);
  }
  for (const s of b.sales) {
    if (
      typeof s.id !== "string" ||
      sales.has(s.id) ||
      s.shop_id !== b.shop.id ||
      !Number.isFinite(Date.parse(s.created_at)) ||
      !["Cash", "Card", "Mobile"].includes(s.payment)
    )
      throw Error("Invalid receipt in backup.");
    for (const k of ["subtotal", "discount", "total", "tendered"])
      integer(s[k]);
    if (s.total !== s.subtotal - s.discount || s.tendered < s.total)
      throw Error("Receipt totals are inconsistent.");
    sales.set(s.id, s);
    grouped.set(s.id, []);
  }
  for (const l of b.lines) {
    const key = l.sale_id + ":" + l.product_id;
    if (
      l.shop_id !== b.shop.id ||
      !sales.has(l.sale_id) ||
      !products.has(l.product_id) ||
      lineKeys.has(key) ||
      typeof l.name !== "string"
    )
      throw Error("Invalid receipt line in backup.");
    integer(l.qty, 1);
    integer(l.price);
    integer(l.cost);
    lineKeys.add(key);
    grouped.get(l.sale_id).push(l);
  }
  for (const [id, s] of sales) {
    const lines = grouped.get(id);
    if (!lines.length || totals(lines, s.discount).total !== s.total)
      throw Error("Receipt lines are missing or inconsistent.");
  }
  return b;
}
export function archiveToLocal(b, id) {
  validateArchive(b);
  if (!/^local-restore-[\w-]+$/.test(id))
    throw Error("Invalid restore workspace.");
  const grouped = new Map(b.sales.map((s) => [s.id, []]));
  for (const l of b.lines) grouped.get(l.sale_id).push({ ...l });
  return {
    shop: {
      ...b.shop,
      id,
      name: b.shop.name + " · restored copy",
      role: "owner",
    },
    products: b.products.map((p) => ({ ...p, shop_id: id })),
    sales: b.sales.map((s) => ({
      ...s,
      shop_id: id,
      lines: grouped.get(s.id),
      local: true,
    })),
    pending: [],
    restored_from: { shop_id: b.shop.id, created_at: b.created_at },
    revision: 0,
  };
}
