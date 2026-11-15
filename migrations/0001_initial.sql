PRAGMA foreign_keys = ON;
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE login_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE devices (secret_hash TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE shops (id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL);
CREATE TABLE members (shop_id TEXT REFERENCES shops(id), user_id TEXT REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','cashier')), PRIMARY KEY(shop_id,user_id));
CREATE TABLE invites (shop_id TEXT REFERENCES shops(id), email TEXT NOT NULL, PRIMARY KEY(shop_id,email));
CREATE TABLE products (id TEXT NOT NULL, shop_id TEXT NOT NULL REFERENCES shops(id), name TEXT NOT NULL, barcode TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, unit TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0), cost INTEGER NOT NULL CHECK(cost>=0), stock INTEGER NOT NULL CHECK(stock>=0), low_stock INTEGER NOT NULL CHECK(low_stock>=0), expiry TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(shop_id,id));
CREATE UNIQUE INDEX product_barcode ON products(shop_id,barcode) WHERE barcode<>'';
CREATE TABLE sales (id TEXT NOT NULL, shop_id TEXT NOT NULL REFERENCES shops(id), user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, received_at TEXT NOT NULL, payment TEXT NOT NULL CHECK(payment IN ('Cash','Card','Mobile')), subtotal INTEGER NOT NULL CHECK(subtotal>=0), discount INTEGER NOT NULL CHECK(discount>=0 AND discount<=subtotal), total INTEGER NOT NULL CHECK(total=subtotal-discount), tendered INTEGER NOT NULL CHECK(tendered>=total), PRIMARY KEY(shop_id,id));
CREATE TABLE sale_lines (shop_id TEXT NOT NULL, sale_id TEXT NOT NULL, product_id TEXT NOT NULL, name TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty>0), price INTEGER NOT NULL CHECK(price>=0), cost INTEGER NOT NULL CHECK(cost>=0), PRIMARY KEY(shop_id,sale_id,product_id), FOREIGN KEY(shop_id,sale_id) REFERENCES sales(shop_id,id), FOREIGN KEY(shop_id,product_id) REFERENCES products(shop_id,id));
CREATE TRIGGER deduct_stock BEFORE INSERT ON sale_lines BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM products WHERE shop_id=NEW.shop_id AND id=NEW.product_id AND stock>=NEW.qty AND price=NEW.price AND cost=NEW.cost AND (expiry='' OR expiry>=date('now','+6 hours'))) THEN RAISE(ABORT,'STOCK_PRICE_OR_EXPIRY_CONFLICT') END;
 UPDATE products SET stock=stock-NEW.qty, version=version+1 WHERE shop_id=NEW.shop_id AND id=NEW.product_id;
END;
CREATE TABLE audit (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, shop_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX sales_shop_date ON sales(shop_id,received_at);
CREATE INDEX member_user ON members(user_id);
